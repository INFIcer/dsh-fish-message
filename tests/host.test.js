import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockOneBotServer, wait, sleep } from './mock-onebot.js'

// 心跳常规是 30 秒；测试里调快，才能验证「卡住→提醒」这条链路真的走通。
process.env.FISH_MESSAGE_GUARD_TICK_MS = '40'

const QQ = '10001'
const session = 'session-host-test'

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(str) { this.body = String(str || '') },
  }
}

test('宿主入口：注册路由、状态可读、session/event 能发到 QQ', async () => {
  const server = await new MockOneBotServer().start()
  const dir = mkdtempSync(join(tmpdir(), 'fish-host-'))
  process.env.DSH_HOME = dir
  // 必须在 DSH_HOME 指向临时目录之后再加载配置模块，否则默认表情库目录会落到真实家目录。
  const { defaultImagePrompt } = await import('../lib/config.js')

  const routes = new Map()
  const listen = new Map()
  const toolDefinitions = []
  // 记忆插件是可选的：宿主只按服务名探测，不 import 对方代码。
  const memoryLibrary = { version: '0.1', images: {}, voices: {} }
  const agent = {
    session: { id: session },
    async followup(msg) { this.received = msg },
  }
  const ctx = {
    effect(cb) {
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
    on(event, fn) {
      listen.set(event, fn)
      return () => listen.delete(event)
    },
    tools: {
      register(definition) {
        toolDefinitions.push(definition)
        return () => {}
      },
    },
    get(service) {
      if (service === 'memory.library') return memoryLibrary
      if (service === 'sessions') return { list: () => [{ id: session, title: '宿主测试' }], flush: async () => {} }
      if (service === 'sessionTitle') return { get: () => ({ title: '宿主测试' }) }
      if (service === 'workspaceRegistry') return { archivedSessionIds: [] }
      if (service === 'attachments') return { admitPromptContent: async (c) => c, imageHostPath: () => '' }
      return undefined
    },
    agents: { get: (id) => (id === session || id === `session-${session}` ? agent : undefined) },
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
  }

  const host = await import('../lib/host.js?host-test')
  const app = host.apply(ctx, {
    napcatBaseUrl: server.baseUrl,
    wsUrl: server.wsUrl,
    wsEnabled: false,
    bindings: [{ qq: QQ, session: session, name: '主人', enabled: true }],
    pollIntervalMs: 200,
    reorderBufferMs: 30,
    requestTimeoutMs: 3000,
    // 宿主用例不真等发送节奏与编辑窗口。
    outboxPerMessageDelayMs: 0,
    outboxPerCharDelayMs: 0,
    inboundEditWindowMs: 0,
  })
  await wait(() => app.bridge.running, 2000)

  const statusResponse = fakeResponse()
  await routes.get('/dsh-fish-message/state')({}, statusResponse)
  const status = JSON.parse(statusResponse.body)
  assert.equal(status.ok, true)
  assert.equal(status.bindings.length, 1)
  assert.equal(status.bindings[0].qq, QQ)
  assert.equal(status.sessions[0].title, '宿主测试')
  // 「打开文件夹」按钮要用：状态里带当前表情库目录及是否存在。
  assert.equal(typeof status.stickerDir, 'string')
  assert.ok(status.stickerDir.length > 0)
  assert.equal(status.stickerDirExists, true)
  // 设置页的「图片识别提示词」要知道留空时用哪段默认；默认文案由宿主下发。
  assert.equal(status.defaults.inboundImagePrompt, defaultImagePrompt)
  assert.equal(status.config.inboundImagePrompt, '')
  // 两条提醒的默认文案由宿主下发，设置页占位文字直接用它。
  assert.match(status.defaults.guardStuckPrompt, /通过消息渠道与用户对话/)
  assert.match(status.defaults.guardQqPrompt, /没有消息发出/)
  // 暂停转发：状态里有待转发队列，默认没在暂停。
  assert.equal(typeof status.forwardFile, 'string')
  assert.equal(status.bridge.forward.paused, false)
  assert.equal(status.bridge.forward.pending, 0)
  // 防失联：默认开启，只盯启用中的绑定会话。
  assert.equal(status.guard.enabled, true)
  assert.equal(status.guard.bound, 1)
  assert.deepEqual([...status.guard.deniedTools].sort(), ['ask_user_question', 'wait_agent'])
  // 内置 ASR/TTS 已移除：不再有旧的开关字段，也没有 test-voice 路由。
  // 新的语音/识图设置走可选本地 AI，字段名见 lib/config.js。
  assert.equal('ttsEnabled' in status.config, false)
  assert.equal('transcriptionEnabled' in status.config, false)
  assert.equal(routes.has('/dsh-fish-message/test-voice'), false)

  const healthResponse = fakeResponse()
  await routes.get('/dsh-fish-message/health')({}, healthResponse)
  assert.equal(healthResponse.statusCode, 200)
  assert.equal(JSON.parse(healthResponse.body).ok, true)

  // 表情库与收图图库的工具都注册上了；图库是缓存，默认空库。
  assert.deepEqual(
    toolDefinitions.map((item) => item.name).sort(),
    ['fish_image_get', 'fish_image_note', 'fish_sticker_list', 'fish_sticker_save', 'fish_sticker_send'],
  )
  assert.equal(status.images.count, 0)
  assert.equal(status.images.keepFiles, true)
  assert.equal(status.images.maxItems, 1000)
  assert.equal(typeof status.imageDir, 'string')

  // 记忆扩展：三个开关默认关/开/开；状态接口直接下发记忆服务与本地 AI 的可用性。
  assert.equal(status.config.memoryExtension, false)
  assert.equal(status.config.memoryCompareImages, true)
  assert.equal(status.config.memoryCompareVoices, true)
  assert.deepEqual(status.memory, { service: true, localAI: false })

  // 表情库路由已经在宿主里挂上；空库返回 0 条。
  assert.equal(typeof routes.get('/dsh-fish-message/stickers'), 'function')
  assert.equal(typeof routes.get('/dsh-fish-message/open-folder'), 'function')
  assert.equal(typeof routes.get('/dsh-fish-message/images/clear'), 'function')

  const clearImages = fakeResponse()
  await routes.get('/dsh-fish-message/images/clear')({ method: 'POST', url: '/dsh-fish-message/images/clear' }, clearImages)
  const cleared = JSON.parse(clearImages.body)
  assert.equal(cleared.ok, true)
  assert.equal(cleared.removed, 0)

  // 图库主面板：收图图库列表 / 出图 / 改描述 / 打开原图的路由挂上了。
  assert.equal(typeof routes.get('/dsh-fish-message/images'), 'function')
  assert.equal(typeof routes.get('/dsh-fish-message/images/file'), 'function')
  assert.equal(typeof routes.get('/dsh-fish-message/images/note'), 'function')
  assert.equal(typeof routes.get('/dsh-fish-message/images/open'), 'function')
  // 记忆图库、声纹库的页面与路由在记忆插件里，鱼讯不再提供。
  assert.equal(routes.has('/dsh-fish-message/memory/images'), false)
  assert.equal(routes.has('/dsh-fish-message/memory/voices'), false)
  const galleryImages = fakeResponse()
  await routes.get('/dsh-fish-message/images')({ method: 'GET', url: '/dsh-fish-message/images' }, galleryImages)
  const galleryBody = JSON.parse(galleryImages.body)
  assert.equal(galleryBody.ok, true)
  assert.equal(galleryBody.total, 0)
  const stickerResponse = fakeResponse()
  await routes.get('/dsh-fish-message/stickers')({ method: 'GET', url: '/dsh-fish-message/stickers' }, stickerResponse)
  const sticker = JSON.parse(stickerResponse.body)
  assert.equal(sticker.ok, true)
  assert.equal(sticker.total, 0)
  assert.equal(sticker.stats.count, 0)

  // 这一轮由 QQ 渠道的入站触发：桥只给本轮有来源的回合出站。
  app.bridge.noteInboundSource(session, 'qq', QQ)
  const send = listen.get('session/event')
  assert.equal(typeof send, 'function')
  send({ id: session }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '块外 [MSG]宿主入口测试[/MSG] 块外' }] } },
  })
  send({ id: session }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const emitted = await wait(() => server.sent.length > 0, 2000)
  assert.equal(emitted, true)
  assert.equal(server.sent[0].message[0].data.text, '宿主入口测试')

  await app.stop()
  await sleep(20)
  await server.stop()
})

test('会话级绑定：/bindings/assign 同一会话挂多条、集合写回、解绑与参数校验', async () => {
  const server = await new MockOneBotServer().start()
  const dir = mkdtempSync(join(tmpdir(), 'fish-bind-'))
  process.env.DSH_HOME = dir

  const sessionA = 'session-bind-a'
  const sessionB = 'session-bind-b'
  const sessions = [{ id: sessionA, title: '会话 A' }, { id: sessionB, title: '会话 B' }]
  const routes = new Map()
  const ctx = {
    effect(cb) {
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
    on() { return () => {} },
    tools: { register() { return () => {} } },
    get(service) {
      if (service === 'sessions') return { list: () => sessions, flush: async () => {} }
      if (service === 'sessionTitle') {
        return { get: (s) => ({ title: (sessions.find((x) => x.id === s.id) || {}).title || '' }) }
      }
      if (service === 'workspaceRegistry') return { archivedSessionIds: [] }
      if (service === 'attachments') return { admitPromptContent: async (c) => c, imageHostPath: () => '' }
      return undefined
    },
    agents: {
      get: (id) => (id === sessionA || id === sessionB ? { session: { id }, id } : undefined),
    },
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
  }

  const host = await import('../lib/host.js?bind-assign-test')
  const app = host.apply(ctx, {
    napcatBaseUrl: server.baseUrl,
    wsUrl: server.wsUrl,
    wsEnabled: false,
    bindings: [
      { qq: '10001', session: sessionA, name: '主人', enabled: true },
      { qq: '10002', session: sessionB, name: '小号', enabled: true },
    ],
    pollIntervalMs: 200,
    reorderBufferMs: 30,
    requestTimeoutMs: 3000,
    outboxPerMessageDelayMs: 0,
    outboxPerCharDelayMs: 0,
    inboundEditWindowMs: 0,
  })
  await wait(() => app.bridge.running, 2000)

  const assign = async (body) => {
    const request = {
      method: 'POST',
      url: '/dsh-fish-message/bindings/assign',
      on(event, fn) {
        if (event === 'data') fn(JSON.stringify(body))
        if (event === 'end') fn()
      },
    }
    const response = fakeResponse()
    await routes.get('/dsh-fish-message/bindings/assign')(request, response)
    return { status: response.statusCode, body: JSON.parse(response.body) }
  }
  const sessionOf = (body, qq) => (body.bindings.find((b) => b.qq === qq) || {}).session

  // 单条调用：把 10002（原本绑 B）绑到 A。A 现在同时挂 10001 和 10002 —— 同一间会话可以多条；
  // B 空出来，渠道一条都不能少（设置页里还要能再绑）。
  let result = await assign({ sessionId: sessionA, qq: '10002' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.bindings.length, 2)
  assert.equal(sessionOf(result.body, '10002'), sessionA)
  assert.equal(sessionOf(result.body, '10001'), sessionA, '同一间会话的其它绑定不能被挤掉')
  assert.deepEqual(app.bridge.bySession.get('bind-a').map((b) => b.qq).sort(), ['10001', '10002'])
  assert.equal(app.bridge.bySession.has('bind-b'), false, 'B 已经没有渠道')
  assert.equal(app.guard.isBinding(sessionA), true)
  assert.equal(app.guard.isBinding(sessionB), false)

  // 多选集合语义：这间会话只留 10001，10002 回到未绑定（渠道保留）。
  result = await assign({ sessionId: sessionA, bindings: [{ channel: 'qq', peer: '10001' }] })
  assert.equal(result.status, 200)
  assert.equal(sessionOf(result.body, '10001'), sessionA)
  assert.equal(sessionOf(result.body, '10002'), '')
  assert.equal(app.bridge.bySession.get('bind-a').length, 1)

  // 一次写回多条：集合里有两条就挂两条。
  result = await assign({
    sessionId: sessionA,
    bindings: [{ channel: 'qq', peer: '10001' }, { channel: 'qq', peer: '10002' }],
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.bindings.filter((b) => b.session === sessionA).length, 2)
  assert.equal(app.bridge.bySession.get('bind-a').length, 2)

  // 解绑：空集合只清 session，渠道保留。
  result = await assign({ sessionId: sessionA, bindings: [] })
  assert.equal(result.status, 200)
  assert.equal(result.body.bindings.length, 2, '解绑不能删除渠道')
  assert.equal(result.body.bindings.every((b) => b.session === ''), true)
  assert.equal(app.guard.isBinding(sessionA), false)
  assert.equal(app.bridge.bySession.size, 0, '全部解绑后没有会话索引')
  assert.equal(app.bridge.byPeer.size, 2, '渠道本身还在，照常按对端收消息')

  // 落盘：重新读配置，两条未绑定会话的渠道都在。
  const disk = app.configStore.load({})
  assert.equal(disk.bindings.length, 2)
  assert.equal(disk.bindings.every((b) => b.session === ''), true)

  // 参数校验：没有会话 id、渠道不存在、通道写错、对端为空都拒绝，配置不动。
  result = await assign({ qq: '10001' })
  assert.equal(result.status, 400)
  assert.match(result.body.error, /会话/)
  result = await assign({ sessionId: sessionA, qq: '99999' })
  assert.equal(result.status, 400)
  assert.match(result.body.error, /99999/)
  result = await assign({ sessionId: sessionA, bindings: [{ channel: 'wx', peer: '10001' }] })
  assert.equal(result.status, 400)
  assert.match(result.body.error, /qq 或 wechat/)
  result = await assign({ sessionId: sessionA, bindings: [{ channel: 'qq', peer: '' }] })
  assert.equal(result.status, 400)
  assert.match(result.body.error, /不能为空/)
  assert.equal(app.configStore.load({}).bindings.every((b) => b.session === ''), true, '失败不能改配置')

  // 只接受 POST。
  const wrongMethod = fakeResponse()
  await routes.get('/dsh-fish-message/bindings/assign')({ method: 'GET', url: '/dsh-fish-message/bindings/assign' }, wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)

  await app.stop()
  await sleep(20)
  await server.stop()
})

test('防失联：绑定会话装上守卫，销毁时撤销且不重复', async () => {
  const server = await new MockOneBotServer().start()
  const dir = mkdtempSync(join(tmpdir(), 'fish-guard-'))
  process.env.DSH_HOME = dir

  const routes = new Map()
  const listen = new Map()
  const toolGuardList = []
  const promptSegments = []
  const approvalCall = []
  let abortTool = 0
  let abortPromptSegment = 0

  const agent = {
    id: session,
    session: { id: session },
    status: 'idle',
    ctx: {
      tools: {
        guard(fn) {
          toolGuardList.push(fn)
          return () => { abortTool += 1 }
        },
      },
      systemPrompt: {
        section(segment) {
          promptSegments.push(segment)
          return () => { abortPromptSegment += 1 }
        },
      },
    },
    async followup() {},
  }

  const ctx = {
    effect(cb) {
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
    on(event, fn) {
      listen.set(event, fn)
      return () => listen.delete(event)
    },
    get(service) {
      if (service === 'sessions') return { list: () => [{ id: session, title: '守卫测试' }], flush: async () => {} }
      if (service === 'sessionTitle') return { get: () => ({ title: '守卫测试' }) }
      if (service === 'workspaceRegistry') return { archivedSessionIds: [] }
      if (service === 'attachments') return { admitPromptContent: async (c) => c, imageHostPath: () => '' }
      if (service === 'approval') {
        return {
          effectivePolicy: () => 'ask',
          setPolicy(a, strategy) { approvalCall.push([a, strategy]) },
        }
      }
      return undefined
    },
    // 启动时还没有会话，等 agent/created 再装。
    agents: { get: (id) => (id === session ? agent : undefined), list: () => [] },
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
  }

  const host = await import('../lib/host.js?host-guard')
  const app = host.apply(ctx, {
    napcatBaseUrl: server.baseUrl,
    wsUrl: server.wsUrl,
    wsEnabled: false,
    bindings: [{ qq: QQ, session: session, name: '主人', enabled: true }],
    pollIntervalMs: 200,
    reorderBufferMs: 30,
    requestTimeoutMs: 3000,
    // 宿主用例不真等发送节奏与编辑窗口。
    outboxPerMessageDelayMs: 0,
    outboxPerCharDelayMs: 0,
    inboundEditWindowMs: 0,
  })
  await wait(() => app.bridge.running, 2000)

  assert.equal(toolGuardList.length, 0, '启动时没有活着的会话，先不装')
  const create = listen.get('agent/created')
  assert.equal(typeof create, 'function')
  create({ agent })
  assert.equal(toolGuardList.length, 1)
  assert.equal(promptSegments.length, 1)
  assert.deepEqual(approvalCall[0], [agent, 'never'])
  assert.equal(promptSegments[0].name, 'fish-message:guard')
  assert.equal(promptSegments[0].order, 10150)
  assert.match(promptSegments[0].text, /子代理/)
  assert.match(toolGuardList[0]({ name: 'ask_user_question' }), /不能用/)
  assert.match(toolGuardList[0]({ name: 'wait_agent' }), /wait_agent/)
  assert.match(toolGuardList[0]({ name: 'wait_agent' }), /唤醒/)
  assert.equal(toolGuardList[0]({ name: 'plugin_manager' }), undefined, '插件装卸不再拦')
  assert.equal(toolGuardList[0]({ name: 'read_file' }), undefined)

  // 长时间没进展：心跳要把提醒真正注入会话。守卫状态里存的是去掉 session- 前缀的短 id，
  // 而 DSH 的 agent id 带前缀——这里 agents.get 只认完整 id，防止再退回「提醒送不进去」。
  const injections = []
  agent.inject = (message) => { injections.push(message) }
  listen.get('agent/status')({ agent, status: 'running' })
  const monitorStatus = app.guard.getStatus('host-test')
  monitorStatus.statusSince = Date.now() - 11 * 60 * 1000
  monitorStatus.lastProgressAt = monitorStatus.statusSince
  await sleep(160)
  assert.ok(injections.length >= 1, '卡住时要把提醒注入会话')
  assert.match(injections[0].content[0].text, /通过消息渠道与用户对话/)
  assert.equal(injections[0].role, 'user')

  // 宿主正忙时注入会被拒：提醒先排队，一有空就立刻重试，而不是等下个心跳。
  agent.inject = () => { throw new Error('session append cannot reenter while another append is being published') }
  listen.get('session/event')({ id: session }, { type: 'assistant/message', data: {} })
  monitorStatus.statusSince = Date.now() - 11 * 60 * 1000
  monitorStatus.lastProgressAt = monitorStatus.statusSince
  const injectAfterBusy = []
  await sleep(120)
  agent.inject = (message) => { injectAfterBusy.push(message) }
  await sleep(900)
  assert.equal(injectAfterBusy.length, 1, '排队后重试只塞一条')

  // 出站入队不等于送达：只有真正发出去（sent）才清「发过 QQ」并重置卡住计时。
  const outboundStatus = app.guard.getStatus('host-test')
  outboundStatus.pendingTurn = true
  outboundStatus.qqSentThisTurn = false
  outboundStatus.statusSince = Date.now() - 20 * 60 * 1000
  app.serviceEvent.emit('outbound-queued', { qq: QQ, reason: 'test' })
  assert.equal(outboundStatus.pendingTurn, true, '只入队，用户还没收到，不能算发过 QQ')
  assert.equal(outboundStatus.qqSentThisTurn, false)
  assert.ok(Date.now() - outboundStatus.statusSince > 19 * 60 * 1000, '入队不算进展，卡住计时不动')
  app.serviceEvent.emit('sent', { qq: QQ })
  assert.equal(outboundStatus.pendingTurn, false, '真发出去才算送达')
  assert.equal(outboundStatus.qqSentThisTurn, true)
  assert.ok(Date.now() - outboundStatus.statusSince < 1000, '真发出去才重置卡住计时')

  // 同一个会话重复收到 created 不重复叠加。
  create({ agent })
  assert.equal(toolGuardList.length, 1)
  assert.equal(promptSegments.length, 1)

  const statusResponse = fakeResponse()
  await routes.get('/dsh-fish-message/state')({}, statusResponse)
  const status = JSON.parse(statusResponse.body)
  assert.equal(status.guard.enabled, true)
  assert.equal(status.guard.approvalAvailable, true)
  assert.equal(status.guard.approvalNever, true)
  assert.equal(status.guard.bound, 1)
  assert.deepEqual([...status.guard.deniedTools].sort(), ['ask_user_question', 'wait_agent'])

  // 会话销毁：守卫和提示段各撤一次；再收到 disposed 也不重复。
  listen.get('agent/disposed')({ agent })
  assert.equal(abortTool, 1)
  assert.equal(abortPromptSegment, 1)
  listen.get('agent/disposed')({ agent })
  assert.equal(abortTool, 1)
  assert.equal(abortPromptSegment, 1)

  // 再建一次会重新装；/save 关掉守护后要拆掉，之后新建的也不装。
  create({ agent })
  assert.equal(toolGuardList.length, 2)
  const saveRequest = {
    method: 'POST',
    url: '/dsh-fish-message/save',
    on(event, fn) {
      if (event === 'data') fn(JSON.stringify({ config: { ...status.config, guardEnabled: false } }))
      if (event === 'end') fn()
    },
  }
  const saveResponse = fakeResponse()
  await routes.get('/dsh-fish-message/save')(saveRequest, saveResponse)
  assert.equal(JSON.parse(saveResponse.body).ok, true)
  assert.equal(abortTool, 2)
  assert.equal(abortPromptSegment, 2)

  const respondAfterClose = fakeResponse()
  await routes.get('/dsh-fish-message/state')({}, respondAfterClose)
  const afterClose = JSON.parse(respondAfterClose.body)
  assert.equal(afterClose.guard.enabled, false)
  assert.equal(afterClose.guard.approvalNever, false)

  listen.get('agent/created')({ agent })
  assert.equal(toolGuardList.length, 2)

  await app.stop()
  await sleep(20)
  await server.stop()
})
