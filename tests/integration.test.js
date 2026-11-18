import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '../lib/bridge.js'
import { StateStore } from '../lib/storage.js'
import { Logger } from '../lib/logger.js'
import { normalizeConfig } from '../lib/config.js'
import { NapCatOneBotTransport } from '../lib/transport/napcat-onebot.js'
import { MockOneBotServer, message, wait, sleep } from './mock-onebot.js'

const QQ = '10001'
/** 模拟「本轮回复由 QQ 渠道的入站触发」：出站只认本轮来源。 */
const QQ_SOURCE = { channel: 'qq', peer: QQ }
const session = 'session-integration-1'

class fakeDeliver {
  constructor() { this.got = [] }
  async deliver(req) { this.got.push(req); return { ok: true } }
  async attachmentPath() { return '' }
}

class fakeVoice {
  async transcribeRecord() { return { text: '' } }
  async fetchImage() { throw new Error('测试里不放图片') }
  async synthesize() { throw new Error('测试里不合成') }
}

function makeBridge({ dir, server, wsEnabled, autoTimers = false, historyCount = 100 }) {
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'test.log'), level: 'debug' })
  const transport = new NapCatOneBotTransport({
    getConfig: () => config,
    logger,
  })
  const delivery = new fakeDeliver()
  const config = normalizeConfig({
    napcatBaseUrl: server.baseUrl,
    wsUrl: server.wsUrl,
    wsEnabled,
    bindings: [{ qq: QQ, session: session, name: '主人', enabled: true }],
    reorderBufferMs: 40,
    pollIntervalMs: 200,
    historyIntervalMs: 60000,
    historyCount,
    requestTimeoutMs: 3000,
    backfillWindowHours: 24,
    // 集成用例逐条断言投递与补发，关掉编辑窗口与出站节奏。
    inboundEditWindowMs: 0,
    outboxPerMessageDelayMs: 0,
    outboxPerCharDelayMs: 0,
  })
  store.setWatermark(QQ, { timestamp: 1, messageId: '' })
  const bridge = new Bridge({
    getConfig: () => config,
    transport,
    store,
    logger,
    voice: new fakeVoice(),
    delivery,
    autoTimers,
  })
  return { bridge, transport, delivery, store, logger }
}

test('mock OneBot：HTTP 补投按时间排序、去重、可重发文字', async () => {
  const server = await new MockOneBotServer().start()
  const now = Math.floor(Date.now() / 1000)
  server.setHistory(QQ, [
    message(3, '第三', now - 10),
    message(1, '第一', now - 30),
    message(2, '第二', now - 20),
  ])
  const dir = mkdtempSync(join(tmpdir(), 'fish-int-'))
  const { bridge, delivery } = makeBridge({ dir, server, wsEnabled: false })
  await bridge.start({ syncNow: false })
  await bridge.sync('integration')

  assert.deepEqual(delivery.got.map((x) => x.text), ['第一', '第二', '第三'])
  // HTTP 轮询模式下 connected 一直是 false；最近一次 HTTP 调用成功也算在线。
  const connect = bridge.state().transport
  assert.equal(connect.online, true)
  assert.equal(connect.mode, 'http')
  assert.ok(connect.lastOkAt > 0)
  await bridge.deliverAssistantTurn(session, '块外 [MSG]发到 QQ 的字[/MSG] 块外', [], QQ_SOURCE)
  assert.equal(server.sent.length, 1)
  assert.deepEqual(server.sent[0].message, [{ type: 'text', data: { text: '发到 QQ 的字' } }])
  assert.equal(String(server.sent[0].user_id), QQ)

  // 再同步一次不会重投
  await bridge.sync('again')
  assert.equal(delivery.got.length, 3)
  await bridge.stop()
  await server.stop()
})

test('mock OneBot：离线消息超过一页时用 message_id 向前翻页补齐', async () => {
  const server = await new MockOneBotServer().start()
  const now = Math.floor(Date.now() / 1000)
  const all = []
  for (let i = 0; i < 45; i++) all.push(message(1000 + i, `第 ${i + 1} 条`, now - 500 + i))
  server.setHistory(QQ, all)
  const dir = mkdtempSync(join(tmpdir(), 'fish-int-page-'))
  const { bridge, delivery } = makeBridge({ dir, server, wsEnabled: false, historyCount: 10 })
  await bridge.start({ syncNow: false })
  await bridge.sync('paging')
  assert.equal(delivery.got.length, 45)
  assert.equal(delivery.got[0].text, '第 1 条')
  assert.equal(delivery.got[44].text, '第 45 条')
  await bridge.stop()
  await server.stop()
})

test('mock OneBot：WebSocket 收消息，重复 id 不重投', async () => {
  const server = await new MockOneBotServer().start()
  const dir = mkdtempSync(join(tmpdir(), 'fish-int-ws-'))
  const { bridge, transport, delivery } = makeBridge({ dir, server, wsEnabled: true })
  await bridge.start({ syncNow: false })
  const connected = await wait(() => transport.getStatus().connected, 3000)
  assert.equal(connected, true, 'WebSocket 应该连上')
  assert.equal(bridge.state().transport.online, true)
  assert.equal(bridge.state().transport.mode, 'ws')

  const now = Math.floor(Date.now() / 1000)
  const late = message(12, '晚一点', now - 5)
  const early = message(11, '早一点', now - 15)
  server.broadcast({ post_type: 'message', ...late })
  server.broadcast({ post_type: 'message', ...early })
  await sleep(220)
  assert.deepEqual(delivery.got.map((x) => x.text), ['早一点', '晚一点'])

  server.broadcast({ post_type: 'message', ...late })
  await sleep(180)
  assert.equal(delivery.got.length, 2, '同一个 message_id 不能重复投')
  await bridge.stop()
  await server.stop()
})

test('mock OneBot：WS 关闭时 HTTP 轮询能收到新消息', async () => {
  const server = await new MockOneBotServer().start()
  const dir = mkdtempSync(join(tmpdir(), 'fish-int-poll-'))
  const { bridge, delivery } = makeBridge({ dir, server, wsEnabled: false, autoTimers: true })
  await bridge.start({ syncNow: false })
  const now = Math.floor(Date.now() / 1000)
  server.addHistory(QQ, message(21, '轮询收到的', now - 3))
  const arrived = await wait(() => delivery.got.length >= 1, 3000, 50)
  assert.equal(arrived, true)
  assert.equal(delivery.got[0].text, '轮询收到的')
  await bridge.stop()
  await server.stop()
})

test('mock OneBot：重启后从磁盘水位继续，不重投', async () => {
  const server = await new MockOneBotServer().start()
  const now = Math.floor(Date.now() / 1000)
  server.setHistory(QQ, [message(31, '重启前', now - 10)])
  const dir = mkdtempSync(join(tmpdir(), 'fish-int-restart-'))
  const first = makeBridge({ dir, server, wsEnabled: false })
  await first.bridge.start({ syncNow: false })
  await first.bridge.sync('first')
  assert.equal(first.delivery.got.length, 1)
  await first.bridge.stop()

  server.addHistory(QQ, message(32, '重启后', now - 2))
  const second = makeBridge({ dir, server, wsEnabled: false })
  await second.bridge.start({ syncNow: false })
  await second.bridge.sync('second')
  assert.deepEqual(second.delivery.got.map((x) => x.text), ['重启后'])
  await second.bridge.stop()
  await server.stop()
})

test('连接健康：HTTP 调不通时显示离线，不能只看 connected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-int-offline-'))
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'test.log'), level: 'debug' })
  const config = normalizeConfig({
    napcatBaseUrl: 'http://127.0.0.1:1',
    wsEnabled: false,
    bindings: [{ qq: QQ, session: session, name: '主人', enabled: true }],
    requestTimeoutMs: 3000,
    reorderBufferMs: 0,
  })
  const transport = new NapCatOneBotTransport({ getConfig: () => config, logger })
  const bridge = new Bridge({
    getConfig: () => config,
    transport,
    store,
    logger,
    voice: new fakeVoice(),
    delivery: new fakeDeliver(),
    autoTimers: false,
  })
  await bridge.start({ syncNow: false })
  await bridge.sync('offline')
  const connect = bridge.state().transport
  assert.equal(connect.online, false)
  assert.equal(connect.mode, 'http')
  assert.equal(connect.lastOkAt, 0)
  await bridge.stop()
})
