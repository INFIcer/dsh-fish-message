import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockOneBotServer, 等, 睡 } from './mock-onebot.js'

const QQ = '10001'
const 会话 = 'session-host-test'

function 假响应() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(文) { this.body = String(文 || '') },
  }
}

test('宿主入口：注册路由、状态可读、session/event 能发到 QQ', async () => {
  const server = await new MockOneBotServer().start()
  const dir = mkdtempSync(join(tmpdir(), 'fish-host-'))
  process.env.DSH_HOME = dir
  // 必须在 DSH_HOME 指向临时目录之后再加载配置模块，否则默认表情库目录会落到真实家目录。
  const { 默认识图提示词 } = await import('../lib/config.js')

  const routes = new Map()
  const 监听 = new Map()
  const agent = {
    session: { id: 会话 },
    async followup(msg) { this.收到 = msg },
  }
  const ctx = {
    effect(cb) {
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
    on(事件, fn) {
      监听.set(事件, fn)
      return () => 监听.delete(事件)
    },
    get(服务) {
      if (服务 === 'sessions') return { list: () => [{ id: 会话, title: '宿主测试' }], flush: async () => {} }
      if (服务 === 'sessionTitle') return { get: () => ({ title: '宿主测试' }) }
      if (服务 === 'workspaceRegistry') return { archivedSessionIds: [] }
      if (服务 === 'attachments') return { admitPromptContent: async (c) => c, imageHostPath: () => '' }
      return undefined
    },
    agents: { get: (id) => (id === 会话 || id === `session-${会话}` ? agent : undefined) },
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
    bindings: [{ qq: QQ, session: 会话, name: '主人', enabled: true }],
    pollIntervalMs: 200,
    reorderBufferMs: 30,
    requestTimeoutMs: 3000,
  })
  await 等(() => app.bridge.running, 2000)

  const 状态响应 = 假响应()
  await routes.get('/dsh-fish-message/state')({}, 状态响应)
  const 状态 = JSON.parse(状态响应.body)
  assert.equal(状态.ok, true)
  assert.equal(状态.bindings.length, 1)
  assert.equal(状态.bindings[0].qq, QQ)
  assert.equal(状态.sessions[0].title, '宿主测试')
  // 「打开文件夹」按钮要用：状态里带当前表情库目录及是否存在。
  assert.equal(typeof 状态.stickerDir, 'string')
  assert.ok(状态.stickerDir.length > 0)
  assert.equal(状态.stickerDirExists, true)
  // 设置页的「图片识别提示词」要知道留空时用哪段默认；默认文案由宿主下发。
  assert.equal(状态.defaults.inboundImagePrompt, 默认识图提示词)
  assert.equal(状态.config.inboundImagePrompt, '')
  // 暂停转发：状态里有待转发队列，默认没在暂停。
  assert.equal(typeof 状态.forwardFile, 'string')
  assert.equal(状态.bridge.forward.paused, false)
  assert.equal(状态.bridge.forward.pending, 0)
  // 防失联：默认开启，只盯启用中的绑定会话。
  assert.equal(状态.guard.enabled, true)
  assert.equal(状态.guard.bound, 1)
  assert.deepEqual([...状态.guard.deniedTools].sort(), ['ask_user_question', 'plugin_manager'])
  // 内置 ASR/TTS 已移除：不再有旧的开关字段，也没有 test-voice 路由。
  // 新的语音/识图设置走可选本地 AI，字段名见 lib/config.js。
  assert.equal('ttsEnabled' in 状态.config, false)
  assert.equal('transcriptionEnabled' in 状态.config, false)
  assert.equal(routes.has('/dsh-fish-message/test-voice'), false)

  const 健康响应 = 假响应()
  await routes.get('/dsh-fish-message/health')({}, 健康响应)
  assert.equal(健康响应.statusCode, 200)
  assert.equal(JSON.parse(健康响应.body).ok, true)

  // 表情库路由已经在宿主里挂上；空库返回 0 条。
  assert.equal(typeof routes.get('/dsh-fish-message/stickers'), 'function')
  assert.equal(typeof routes.get('/dsh-fish-message/open-folder'), 'function')
  const 表情响应 = 假响应()
  await routes.get('/dsh-fish-message/stickers')({ method: 'GET', url: '/dsh-fish-message/stickers' }, 表情响应)
  const 表情 = JSON.parse(表情响应.body)
  assert.equal(表情.ok, true)
  assert.equal(表情.total, 0)
  assert.equal(表情.stats.count, 0)

  const 发 = 监听.get('session/event')
  assert.equal(typeof 发, 'function')
  发({ id: 会话 }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '块外 [QQ]宿主入口测试[/QQ] 块外' }] } },
  })
  发({ id: 会话 }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const 发出 = await 等(() => server.sent.length > 0, 2000)
  assert.equal(发出, true)
  assert.equal(server.sent[0].message[0].data.text, '宿主入口测试')

  await app.停()
  await 睡(20)
  await server.stop()
})

test('防失联：绑定会话装上守卫，销毁时撤销且不重复', async () => {
  const server = await new MockOneBotServer().start()
  const dir = mkdtempSync(join(tmpdir(), 'fish-guard-'))
  process.env.DSH_HOME = dir

  const routes = new Map()
  const 监听 = new Map()
  const 工具守卫们 = []
  const 提示段们 = []
  const 审批调用 = []
  let 撤工具 = 0
  let 撤提示段 = 0

  const agent = {
    id: 会话,
    session: { id: 会话 },
    status: 'idle',
    ctx: {
      tools: {
        guard(fn) {
          工具守卫们.push(fn)
          return () => { 撤工具 += 1 }
        },
      },
      systemPrompt: {
        section(段) {
          提示段们.push(段)
          return () => { 撤提示段 += 1 }
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
    on(事件, fn) {
      监听.set(事件, fn)
      return () => 监听.delete(事件)
    },
    get(服务) {
      if (服务 === 'sessions') return { list: () => [{ id: 会话, title: '守卫测试' }], flush: async () => {} }
      if (服务 === 'sessionTitle') return { get: () => ({ title: '守卫测试' }) }
      if (服务 === 'workspaceRegistry') return { archivedSessionIds: [] }
      if (服务 === 'attachments') return { admitPromptContent: async (c) => c, imageHostPath: () => '' }
      if (服务 === 'approval') {
        return {
          effectivePolicy: () => 'ask',
          setPolicy(a, 策略) { 审批调用.push([a, 策略]) },
        }
      }
      return undefined
    },
    // 启动时还没有会话，等 agent/created 再装。
    agents: { get: (id) => (id === 会话 ? agent : undefined), list: () => [] },
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
    bindings: [{ qq: QQ, session: 会话, name: '主人', enabled: true }],
    pollIntervalMs: 200,
    reorderBufferMs: 30,
    requestTimeoutMs: 3000,
  })
  await 等(() => app.bridge.running, 2000)

  assert.equal(工具守卫们.length, 0, '启动时没有活着的会话，先不装')
  const 创建 = 监听.get('agent/created')
  assert.equal(typeof 创建, 'function')
  创建({ agent })
  assert.equal(工具守卫们.length, 1)
  assert.equal(提示段们.length, 1)
  assert.deepEqual(审批调用[0], [agent, 'never'])
  assert.equal(提示段们[0].name, 'fish-message:guard')
  assert.equal(提示段们[0].order, 10150)
  assert.match(提示段们[0].text, /子代理/)
  assert.match(工具守卫们[0]({ name: 'ask_user_question' }), /不能用/)
  assert.match(工具守卫们[0]({ name: 'plugin_manager' }), /不能用/)
  assert.equal(工具守卫们[0]({ name: 'read_file' }), undefined)

  // 同一个会话重复收到 created 不重复叠加。
  创建({ agent })
  assert.equal(工具守卫们.length, 1)
  assert.equal(提示段们.length, 1)

  const 状态响应 = 假响应()
  await routes.get('/dsh-fish-message/state')({}, 状态响应)
  const 状态 = JSON.parse(状态响应.body)
  assert.equal(状态.guard.enabled, true)
  assert.equal(状态.guard.approvalAvailable, true)
  assert.equal(状态.guard.approvalNever, true)
  assert.equal(状态.guard.bound, 1)
  assert.deepEqual([...状态.guard.deniedTools].sort(), ['ask_user_question', 'plugin_manager'])

  // 会话销毁：守卫和提示段各撤一次；再收到 disposed 也不重复。
  监听.get('agent/disposed')({ agent })
  assert.equal(撤工具, 1)
  assert.equal(撤提示段, 1)
  监听.get('agent/disposed')({ agent })
  assert.equal(撤工具, 1)
  assert.equal(撤提示段, 1)

  // 再建一次会重新装；/save 关掉守护后要拆掉，之后新建的也不装。
  创建({ agent })
  assert.equal(工具守卫们.length, 2)
  const 保存请求 = {
    method: 'POST',
    url: '/dsh-fish-message/save',
    on(事件, fn) {
      if (事件 === 'data') fn(JSON.stringify({ config: { ...状态.config, guardEnabled: false } }))
      if (事件 === 'end') fn()
    },
  }
  const 保存响应 = 假响应()
  await routes.get('/dsh-fish-message/save')(保存请求, 保存响应)
  assert.equal(JSON.parse(保存响应.body).ok, true)
  assert.equal(撤工具, 2)
  assert.equal(撤提示段, 2)

  const 关后响应 = 假响应()
  await routes.get('/dsh-fish-message/state')({}, 关后响应)
  const 关后 = JSON.parse(关后响应.body)
  assert.equal(关后.guard.enabled, false)
  assert.equal(关后.guard.approvalNever, false)

  监听.get('agent/created')({ agent })
  assert.equal(工具守卫们.length, 2)

  await app.停()
  await 睡(20)
  await server.stop()
})

test('重启工具：宿主注册 dsh_restart，schedule/cancel 落盘且状态可读', async () => {
  const server = await new MockOneBotServer().start()
  const dir = mkdtempSync(join(tmpdir(), 'fish-restart-'))
  process.env.DSH_HOME = dir

  const routes = new Map()
  const 监听 = new Map()
  const 工具们 = []
  const 撤销 = []

  const ctx = {
    effect(cb) {
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
    on(事件, fn) {
      监听.set(事件, fn)
      return () => 监听.delete(事件)
    },
    get(服务) {
      if (服务 === 'sessions') return { list: () => [{ id: 会话, title: '重启测试' }], flush: async () => {} }
      if (服务 === 'sessionTitle') return { get: () => ({ title: '重启测试' }) }
      if (服务 === 'workspaceRegistry') return { archivedSessionIds: [] }
      if (服务 === 'attachments') return { admitPromptContent: async (c) => c, imageHostPath: () => '' }
      return undefined
    },
    agents: { get: () => undefined, list: () => [] },
    tools: {
      register(定义) {
        工具们.push(定义)
        return () => { 撤销.push(定义.name) }
      },
    },
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
  }

  const host = await import('../lib/host.js?host-restart')
  const app = host.apply(ctx, {
    napcatBaseUrl: server.baseUrl,
    wsUrl: server.wsUrl,
    wsEnabled: false,
    bindings: [{ qq: QQ, session: 会话, name: '主人', enabled: true }],
    pollIntervalMs: 200,
    reorderBufferMs: 30,
    requestTimeoutMs: 3000,
  })
  await 等(() => app.bridge.running, 2000)

  const 工具 = 工具们.find((t) => t.name === 'dsh_restart')
  assert.ok(工具, '宿主启动后应注册 dsh_restart')
  assert.match(工具.description, /等所有会话空闲/)
  assert.deepEqual(工具.parameters.properties.action.enum, ['schedule', 'cancel', 'status'])

  const 状态响应 = 假响应()
  await routes.get('/dsh-fish-message/state')({}, 状态响应)
  const 状态 = JSON.parse(状态响应.body)
  assert.equal(typeof 状态.restart, 'object')
  assert.equal(状态.restart.scheduled, false)
  assert.equal(typeof 状态.restart.dueAt, 'number')
  assert.equal(状态.restart.callerSession, '')

  // 通过工具安排一次重启：调用者会话要落盘，状态里看得到。
  const 安排 = await 工具.execute({ action: 'schedule', delaySeconds: 10, wakeText: '（测试）', reason: '测试安排' }, { agent: { id: 会话 } })
  assert.equal(安排.ok, true)
  assert.equal(安排.callerSession, 会话)
  assert.equal(安排.remainingSeconds, 10)
  assert.ok(安排.dueAt > Date.now())

  const 安排响应 = 假响应()
  await routes.get('/dsh-fish-message/state')({}, 安排响应)
  const 安排后 = JSON.parse(安排响应.body)
  assert.equal(安排后.restart.scheduled, true)
  assert.equal(安排后.restart.callerSession, 会话)
  assert.equal(安排后.restart.reason, '测试安排')

  // 取消后再看：安排没了。
  const 取消 = await 工具.execute({ action: 'cancel' }, {})
  assert.equal(取消.ok, true)
  assert.equal(取消.cancelled, true)
  const 取消响应 = 假响应()
  await routes.get('/dsh-fish-message/state')({}, 取消响应)
  assert.equal(JSON.parse(取消响应.body).restart.scheduled, false)

  await app.停()
  assert.ok(撤销.includes('dsh_restart'), '停用插件时应撤销 dsh_restart')
  await 睡(20)
  await server.stop()
})
