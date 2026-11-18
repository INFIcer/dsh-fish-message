// 微信通道接口：扫码登录、退出、候选对端、/state 里的那一块，以及按通道绑定与测试发送。
//
// 微信适配器由假工厂注入（host 的同名测试注入点）：这里只验接口形状与宿主行为，
// 真实 iLink 协议在 lib/transport/wechat-ilink.js 与它自己的用例里。

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockOneBotServer, wait, sleep } from './mock-onebot.js'

const QQ = '10001'
const WX = 'o9cq9xYz_1@im.wechat'

const PREFIX = '/dsh-fish-message'
const STATE = `${PREFIX}/state`
const SAVE = `${PREFIX}/save`
const ASSIGN = `${PREFIX}/bindings/assign`
const TEST_SEND = `${PREFIX}/test-send`
const WX_LOGIN = `${PREFIX}/wechat/login`
const WX_LOGOUT = `${PREFIX}/wechat/logout`
const WX_PEERS = `${PREFIX}/wechat/peers`

const zeroStatus = () => ({
  state: 'stopped',
  connected: false,
  botId: '',
  lastError: '',
  qrcodeAt: 0,
  lastOkAt: 0,
})
const zeroQrcode = () => ({ qrcode: '', imgContent: '' })

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key] = value },
    end(str) { this.body = String(str || '') },
  }
}

function fakeRequest(body, { method = 'POST', url = '/' } = {}) {
  return {
    method,
    url,
    on(event, fn) {
      if (event === 'data') fn(JSON.stringify(body === undefined ? {} : body))
      if (event === 'end') fn()
    },
  }
}

async function call(routes, path, { body, method = 'POST', url = path } = {}) {
  const response = fakeResponse()
  await routes.get(path)(fakeRequest(body, { method, url }), response)
  return { status: response.statusCode, body: JSON.parse(response.body || '{}') }
}

/** 假 iLink 适配器：只实现宿主与路由器真正用到的那几个方法。 */
function makeWechatAdapter() {
  const adapter = {
    started: 0,
    stopped: 0,
    sent: [],
    handlers: null,
    status: { state: 'waiting_scan', connected: false, botId: '', lastError: '', qrcodeAt: 1700000000000, lastOkAt: 0 },
    qr: { state: 'waiting_scan', qrcode: 'QR-1', imgContent: 'https://wx.qq.com/qr-1' },
    peers: [{ peer: WX, lastActiveAt: 1700000000123, hasContext: true }],
    async start(handlers) {
      adapter.started += 1
      adapter.handlers = handlers
      adapter.status = { ...adapter.status, state: 'waiting_scan' }
    },
    async stop() {
      adapter.stopped += 1
      adapter.status = { ...adapter.status, state: 'stopped', connected: false }
    },
    getStatus() { return { ...adapter.status, name: 'wechat-ilink', mode: 'ilink' } },
    getQrcode() { return { ...adapter.qr } },
    listRecentPeers() { return adapter.peers },
    async sendMessage(to, segments) {
      adapter.sent.push({ to, segments })
      return { ret: 0 }
    },
    async fetchHistory() { return [] },
  }
  return adapter
}

let bootCount = 0

async function boot({ wechatEnabled = false, bindings = [], sessions = [] } = {}) {
  const server = await new MockOneBotServer().start()
  const dir = mkdtempSync(join(tmpdir(), 'fish-wx-routes-'))
  process.env.DSH_HOME = dir
  const routes = new Map()
  const adapters = []
  const adapterOptions = []
  const sessionList = sessions.length
    ? sessions
    : [{ id: 'session-wx-a', title: '微信会话 A' }, { id: 'session-wx-b', title: '微信会话 B' }]

  const ctx = {
    effect(cb) {
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
    on() { return () => {} },
    tools: { register() { return () => {} } },
    get(service) {
      if (service === 'sessions') return { list: () => sessionList, flush: async () => {} }
      if (service === 'sessionTitle') {
        return { get: (s) => ({ title: (sessionList.find((x) => x.id === s.id) || {}).title || '' }) }
      }
      if (service === 'workspaceRegistry') return { archivedSessionIds: [] }
      if (service === 'attachments') return { admitPromptContent: async (c) => c, imageHostPath: () => '' }
      return undefined
    },
    agents: { get: () => undefined, list: () => [] },
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
  }

  bootCount += 1
  const host = await import(`../lib/host.js?wechat-routes-${bootCount}`)
  const app = host.apply(ctx, {
    napcatBaseUrl: server.baseUrl,
    wsUrl: server.wsUrl,
    wsEnabled: false,
    bindings,
    pollIntervalMs: 200,
    reorderBufferMs: 30,
    requestTimeoutMs: 3000,
    outboxPerMessageDelayMs: 0,
    outboxPerCharDelayMs: 0,
    inboundEditWindowMs: 0,
    wechatEnabled,
    // 注入点：造一个假适配器，顺手记下宿主传进来的构造参数。
    wechatTransport: (options) => {
      adapterOptions.push(options)
      const adapter = makeWechatAdapter()
      adapters.push(adapter)
      return adapter
    },
  })
  assert.ok(await wait(() => app.bridge.running && app.transport?.started === true, 2000), '桥与路由器要起来')

  return {
    app,
    routes,
    server,
    adapters,
    adapterOptions,
    dir,
    async stop() {
      await app.stop()
      await sleep(20)
      await server.stop()
    },
  }
}

test('微信接口：未启用时零值、候选为空、/state 里也是同一份形状', async () => {
  const env = await boot({ wechatEnabled: false })
  try {
    const login = await call(env.routes, WX_LOGIN, { method: 'GET' })
    assert.equal(login.status, 200)
    assert.deepEqual(login.body, { ok: true, enabled: false, status: zeroStatus(), qrcode: zeroQrcode() })

    const peers = await call(env.routes, WX_PEERS, { method: 'GET' })
    assert.deepEqual(peers.body, { ok: true, peers: [] })

    const state = await call(env.routes, STATE, { method: 'GET' })
    assert.deepEqual(state.body.wechat, { enabled: false, status: zeroStatus(), qrcode: zeroQrcode() })
    // 关着就不建适配器：省掉无谓的登录循环。
    assert.equal(env.adapters.length, 0)
  } finally {
    await env.stop()
  }
})

test('微信接口：扫码登录、候选对端、退出登录（含删凭证）', async () => {
  const env = await boot({ wechatEnabled: false })
  try {
    const login = await call(env.routes, WX_LOGIN)
    assert.equal(login.status, 200)
    assert.equal(login.body.ok, true)
    assert.equal(login.body.enabled, true)
    assert.equal(login.body.status.state, 'waiting_scan')
    assert.equal(login.body.status.qrcodeAt, 1700000000000)
    assert.deepEqual(login.body.qrcode, { qrcode: 'QR-1', imgContent: 'https://wx.qq.com/qr-1' })
    assert.equal(env.adapters.length, 1)
    assert.equal(env.adapters[0].started, 1)
    // 宿主自己指定会话文件位置，退出登录时才知道该删哪个。
    assert.equal(env.adapterOptions[0].sessionFile, join(env.dir, 'fish-message-ilink.json'))
    assert.equal(env.adapterOptions[0].inboxDir, join(env.dir, 'fish-message-inbox'))
    // 开关落盘：下次启动就是「已启用」，不需要再点一次登录。
    assert.equal(env.app.configStore.load({}).wechatEnabled, true)

    const peers = await call(env.routes, WX_PEERS, { method: 'GET' })
    assert.deepEqual(peers.body, { ok: true, peers: [{ peer: WX, lastActiveAt: 1700000000123 }] })

    const state = await call(env.routes, STATE, { method: 'GET' })
    assert.equal(state.body.wechat.enabled, true)
    assert.equal(state.body.wechat.status.state, 'waiting_scan')
    assert.equal(state.body.wechat.qrcode.qrcode, 'QR-1')

    // 退出登录：停适配器、摘通道、删凭证；开关保持开启。
    const sessionFile = join(env.dir, 'fish-message-ilink.json')
    writeFileSync(sessionFile, JSON.stringify({ botToken: '旧凭证' }))
    const logout = await call(env.routes, WX_LOGOUT)
    assert.equal(logout.status, 200)
    assert.equal(logout.body.enabled, true, 'wechatEnabled 不变')
    assert.deepEqual(logout.body.status, zeroStatus())
    assert.deepEqual(logout.body.qrcode, zeroQrcode())
    assert.equal(env.adapters[0].stopped, 1)
    assert.equal(existsSync(sessionFile), false, '退出登录要把凭证一起删掉')
    assert.deepEqual((await call(env.routes, WX_PEERS, { method: 'GET' })).body, { ok: true, peers: [] })
    // 再点登录：同一个开关下重新建适配器，重新扫码。
    const again = await call(env.routes, WX_LOGIN, { method: 'GET' })
    assert.equal(again.body.enabled, true)
    assert.equal(again.body.status.state, 'stopped', '没适配器时状态是零值，不会伪造登录中')
  } finally {
    await env.stop()
  }
})

test('微信接口：开关变化走重启，绑定与测试发送按通道', async () => {
  const env = await boot({
    wechatEnabled: false,
    bindings: [
      { channel: 'qq', qq: QQ, session: 'session-wx-a', name: '主人' },
      { channel: 'wechat', qq: WX, session: '', name: '微信' },
    ],
  })
  try {
    // 绑定微信对端到会话 B：会话 A 上的 QQ 渠道回到「未绑定」，渠道本身都保留。
    const assign = await call(env.routes, ASSIGN, { body: { sessionId: 'session-wx-b', channel: 'wechat', peer: WX } })
    assert.equal(assign.status, 200)
    assert.equal(assign.body.ok, true)
    assert.equal(assign.body.bindings.length, 2)
    assert.equal(assign.body.bindings.find((b) => b.channel === 'wechat').session, 'session-wx-b')
    // 只动「目标会话上的旧渠道」，别的会话的绑定不受影响（一间会话只绑一条）。
    assert.equal(assign.body.bindings.find((b) => b.channel === 'qq').session, 'session-wx-a')
    assert.match(assign.body.message, /微信/)
    assert.ok(assign.body.message.includes(WX))

    // 没有这条渠道：错误文案按通道走，不再写死「QQ」。
    const missing = await call(env.routes, ASSIGN, { body: { sessionId: 'session-wx-a', channel: 'wechat', peer: 'wxid_nope' } })
    assert.equal(missing.status, 400)
    assert.match(missing.body.error, /微信 wxid_nope/)
    // 通道写错不猜成 qq。
    const badChannel = await call(env.routes, ASSIGN, { body: { sessionId: 'session-wx-a', channel: 'wx', peer: WX } })
    assert.equal(badChannel.status, 400)
    assert.match(badChannel.body.error, /qq 或 wechat/)
    // 对端为空 = 解绑，渠道保留。
    const unbind = await call(env.routes, ASSIGN, { body: { sessionId: 'session-wx-b', channel: 'wechat', qq: '' } })
    assert.equal(unbind.status, 200)
    assert.equal(unbind.body.bindings.find((b) => b.channel === 'wechat').session, '')

    // 打开开关：/save 触发 restartBridge，路由器按新配置把微信适配器建起来。
    const before = await call(env.routes, STATE, { method: 'GET' })
    assert.equal(before.body.wechat.enabled, false)
    const saved = await call(env.routes, SAVE, { body: { config: { ...before.body.config, wechatEnabled: true } } })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.ok, true)
    assert.equal(env.adapters.length, 1)
    assert.equal(env.adapters[0].started, 1)
    assert.equal(saved.body.wechat.enabled, true)
    assert.equal(saved.body.wechat.status.state, 'waiting_scan')
    assert.equal(saved.body.wechat.qrcode.qrcode, 'QR-1')
    assert.equal(saved.body.bridge.running, true, '重启后桥照常在跑')

    // 测试发送：显式 channel 走微信适配器。
    const toWechat = await call(env.routes, TEST_SEND, { body: { channel: 'wechat', qq: WX } })
    assert.equal(toWechat.status, 200)
    assert.equal(toWechat.body.ok, true)
    assert.equal(toWechat.body.channel, 'wechat')
    assert.equal(env.adapters[0].sent.length, 1)
    assert.equal(env.adapters[0].sent[0].to, WX)
    assert.match(env.adapters[0].sent[0].segments[0].data.text, /测试/)

    // 只给通道、不给对端：按通道挑第一条启用的绑定，不能落到另一条通道上。
    const channelOnly = await call(env.routes, TEST_SEND, { body: { channel: 'wechat' } })
    assert.equal(channelOnly.status, 200)
    assert.equal(channelOnly.body.channel, 'wechat')
    assert.equal(channelOnly.body.qq, WX)
    assert.equal(env.adapters[0].sent.length, 2)

    // 缺省 channel 仍然是 qq：NapCat 那边收得到。
    const toQq = await call(env.routes, TEST_SEND, { body: { qq: QQ } })
    assert.equal(toQq.status, 200)
    assert.equal(toQq.body.channel, 'qq')
    assert.ok(await wait(() => env.server.sent.length > 0, 2000), 'QQ 通道的测试消息要发出去')

    // 关掉开关：重启后微信适配器停掉，状态回到零值。
    const off = await call(env.routes, SAVE, { body: { config: { ...saved.body.config, wechatEnabled: false } } })
    assert.equal(off.status, 200)
    assert.equal(off.body.wechat.enabled, false)
    assert.deepEqual(off.body.wechat.status, zeroStatus())
    assert.equal(env.adapters[0].stopped, 1)
    assert.equal(env.adapters.length, 1, '关掉开关不能再建一个新的')
    assert.equal(env.adapters[0].started, 1, '关掉后重启也不能把它重新 start')
  } finally {
    await env.stop()
  }
})

test('保存绑定：同一间会话的多条都保留，同对端第二条丢掉并带中文原因', async () => {
  const env = await boot({ bindings: [] })
  try {
    const before = await call(env.routes, STATE, { method: 'GET' })
    const base = before.body.config
    // 同一间会话挂 QQ + 微信 + 第二个 QQ：三条都该落盘。
    const saved = await call(env.routes, SAVE, {
      body: {
        config: {
          ...base,
          bindings: [
            { channel: 'qq', qq: QQ, session: 'session-wx-a', name: '主人' },
            { channel: 'wechat', qq: WX, session: 'session-wx-a', name: '微信' },
            { channel: 'qq', qq: '10002', session: 'session-wx-a', name: '小号' },
          ],
        },
      },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.ok, true)
    assert.deepEqual(saved.body.dropped, [])
    assert.deepEqual(env.app.configStore.load({}).bindings.map((b) => [b.channel, b.qq, b.session]), [
      ['qq', QQ, 'session-wx-a'],
      ['wechat', WX, 'session-wx-a'],
      ['qq', '10002', 'session-wx-a'],
    ])

    // 同一个对端再出现一条：只留第一条，第二条在 dropped 里说明原因。
    const dup = await call(env.routes, SAVE, {
      body: {
        config: {
          ...saved.body.config,
          bindings: [
            ...saved.body.config.bindings,
            { channel: 'qq', qq: QQ, session: 'session-wx-b' },
            { channel: 'wechat', peer: '', session: '' },
            { channel: 'wx', peer: WX, session: '' },
          ],
        },
      },
    })
    assert.equal(dup.status, 200)
    assert.deepEqual(dup.body.dropped, [
      { channel: 'qq', peer: QQ, reason: '这个对端已经有一条渠道了' },
      { channel: 'wechat', peer: '', reason: '对端没填' },
      { channel: 'wx', peer: WX, reason: '通道只能填 qq 或 wechat' },
    ])
    assert.equal(env.app.configStore.load({}).bindings.length, 3, '被丢掉的条目不会落盘')
  } finally {
    await env.stop()
  }
})

test('会话绑定接口：一次写回多条，取消勾选只解绑这一条', async () => {
  const env = await boot({
    bindings: [
      { channel: 'qq', qq: QQ, session: '', name: '主人' },
      { channel: 'wechat', qq: WX, session: '', name: '微信' },
    ],
  })
  try {
    // 多选一次提交两条：这间会话同时挂 QQ + 微信。
    const both = await call(env.routes, ASSIGN, {
      body: {
        sessionId: 'session-wx-a',
        bindings: [
          { channel: 'qq', peer: QQ },
          { channel: 'wechat', peer: WX },
        ],
      },
    })
    assert.equal(both.status, 200)
    assert.equal(both.body.ok, true)
    const sessionOf = (body, peer) => (body.bindings.find((b) => b.qq === peer) || {}).session
    assert.equal(sessionOf(both.body, QQ), 'session-wx-a')
    assert.equal(sessionOf(both.body, WX), 'session-wx-a')
    assert.match(both.body.message, /2 条渠道/)

    // 取消 QQ 的勾：只把它解绑，微信仍在这间会话。
    const one = await call(env.routes, ASSIGN, {
      body: { sessionId: 'session-wx-a', bindings: [{ channel: 'wechat', peer: WX }] },
    })
    assert.equal(one.status, 200)
    assert.equal(sessionOf(one.body, QQ), '')
    assert.equal(sessionOf(one.body, WX), 'session-wx-a')
    assert.equal(env.app.configStore.load({}).bindings.length, 2, '解绑不删渠道')

    // 渠道不存在：400，且不改配置。
    const missing = await call(env.routes, ASSIGN, {
      body: { sessionId: 'session-wx-a', bindings: [{ channel: 'qq', peer: '99999' }] },
    })
    assert.equal(missing.status, 400)
    assert.match(missing.body.error, /99999/)
    assert.equal(env.app.configStore.load({}).bindings.find((b) => b.qq === WX).session, 'session-wx-a')
  } finally {
    await env.stop()
  }
})
