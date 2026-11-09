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
import { MockOneBotServer, 消息, 等, 睡 } from './mock-onebot.js'

const QQ = '10001'
const 会话 = 'session-integration-1'

class 假投递 {
  constructor() { this.got = [] }
  async deliver(req) { this.got.push(req); return { ok: true } }
  async attachmentPath() { return '' }
}

class 假语音 {
  async transcribeRecord() { return { text: '', speakerName: '' } }
  async fetchImage() { throw new Error('测试里不放图片') }
  async synthesize() { throw new Error('测试里不合成') }
}

function 建桥({ dir, server, wsEnabled, autoTimers = false, historyCount = 100 }) {
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'test.log'), level: 'debug' })
  const transport = new NapCatOneBotTransport({
    getConfig: () => 配置,
    logger,
  })
  const delivery = new 假投递()
  const 配置 = normalizeConfig({
    napcatBaseUrl: server.baseUrl,
    wsUrl: server.wsUrl,
    wsEnabled,
    bindings: [{ qq: QQ, session: 会话, name: '主人', enabled: true }],
    reorderBufferMs: 40,
    pollIntervalMs: 200,
    historyIntervalMs: 60000,
    historyCount,
    requestTimeoutMs: 3000,
    backfillWindowHours: 24,
  })
  store.setWatermark(QQ, { timestamp: 1, messageId: '' })
  const bridge = new Bridge({
    getConfig: () => 配置,
    transport,
    store,
    logger,
    voice: new 假语音(),
    delivery,
    autoTimers,
  })
  return { bridge, transport, delivery, store, logger }
}

test('mock OneBot：HTTP 补投按时间排序、去重、可重发文字', async () => {
  const server = await new MockOneBotServer().start()
  const 现在 = Math.floor(Date.now() / 1000)
  server.setHistory(QQ, [
    消息(3, '第三', 现在 - 10),
    消息(1, '第一', 现在 - 30),
    消息(2, '第二', 现在 - 20),
  ])
  const dir = mkdtempSync(join(tmpdir(), 'fish-int-'))
  const { bridge, delivery } = 建桥({ dir, server, wsEnabled: false })
  await bridge.start({ syncNow: false })
  await bridge.sync('integration')

  assert.deepEqual(delivery.got.map((x) => x.text), ['第一', '第二', '第三'])
  await bridge.deliverAssistantTurn(会话, '块外 [QQ]发到 QQ 的字[/QQ] 块外')
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
  const 现在 = Math.floor(Date.now() / 1000)
  const 全 = []
  for (let i = 0; i < 45; i++) 全.push(消息(1000 + i, `第 ${i + 1} 条`, 现在 - 500 + i))
  server.setHistory(QQ, 全)
  const dir = mkdtempSync(join(tmpdir(), 'fish-int-page-'))
  const { bridge, delivery } = 建桥({ dir, server, wsEnabled: false, historyCount: 10 })
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
  const { bridge, transport, delivery } = 建桥({ dir, server, wsEnabled: true })
  await bridge.start({ syncNow: false })
  const 连上 = await 等(() => transport.getStatus().connected, 3000)
  assert.equal(连上, true, 'WebSocket 应该连上')

  const 现在 = Math.floor(Date.now() / 1000)
  const 晚 = 消息(12, '晚一点', 现在 - 5)
  const 早 = 消息(11, '早一点', 现在 - 15)
  server.broadcast({ post_type: 'message', ...晚 })
  server.broadcast({ post_type: 'message', ...早 })
  await 睡(220)
  assert.deepEqual(delivery.got.map((x) => x.text), ['早一点', '晚一点'])

  server.broadcast({ post_type: 'message', ...晚 })
  await 睡(180)
  assert.equal(delivery.got.length, 2, '同一个 message_id 不能重复投')
  await bridge.stop()
  await server.stop()
})

test('mock OneBot：WS 关闭时 HTTP 轮询能收到新消息', async () => {
  const server = await new MockOneBotServer().start()
  const dir = mkdtempSync(join(tmpdir(), 'fish-int-poll-'))
  const { bridge, delivery } = 建桥({ dir, server, wsEnabled: false, autoTimers: true })
  await bridge.start({ syncNow: false })
  const 现在 = Math.floor(Date.now() / 1000)
  server.addHistory(QQ, 消息(21, '轮询收到的', 现在 - 3))
  const 到了 = await 等(() => delivery.got.length >= 1, 3000, 50)
  assert.equal(到了, true)
  assert.equal(delivery.got[0].text, '轮询收到的')
  await bridge.stop()
  await server.stop()
})

test('mock OneBot：重启后从磁盘水位继续，不重投', async () => {
  const server = await new MockOneBotServer().start()
  const 现在 = Math.floor(Date.now() / 1000)
  server.setHistory(QQ, [消息(31, '重启前', 现在 - 10)])
  const dir = mkdtempSync(join(tmpdir(), 'fish-int-restart-'))
  const 第一 = 建桥({ dir, server, wsEnabled: false })
  await 第一.bridge.start({ syncNow: false })
  await 第一.bridge.sync('first')
  assert.equal(第一.delivery.got.length, 1)
  await 第一.bridge.stop()

  server.addHistory(QQ, 消息(32, '重启后', 现在 - 2))
  const 第二 = 建桥({ dir, server, wsEnabled: false })
  await 第二.bridge.start({ syncNow: false })
  await 第二.bridge.sync('second')
  assert.deepEqual(第二.delivery.got.map((x) => x.text), ['重启后'])
  await 第二.bridge.stop()
  await server.stop()
})
