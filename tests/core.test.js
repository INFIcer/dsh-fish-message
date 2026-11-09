import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Bridge } from '../lib/bridge.js'
import { StateStore } from '../lib/storage.js'
import { normalizeConfig, deriveWsUrl, migrateLegacyConfig } from '../lib/config.js'
import { Logger } from '../lib/logger.js'

const 睡 = (ms) => new Promise((r) => setTimeout(r, ms))
const 临时目录 = () => mkdtempSync(join(tmpdir(), 'fish-message-test-'))
const QQ = '10001'
const 会话 = 'session-test-0001'

function 建消息(id, 文本, 时间, qq = QQ) {
  return {
    message_id: id,
    message_seq: Number(id),
    time: 时间,
    user_id: Number(qq),
    message_type: 'private',
    message: [{ type: 'text', data: { text: 文本 } }],
    raw_message: 文本,
    sender: { user_id: Number(qq), nickname: '主人' },
  }
}

class 假传输 {
  constructor(历史 = {}) {
    this.历史 = 历史
    this.sent = []
    this.handlers = null
    this.name = 'fake'
    this.status = { name: 'fake', connected: false, mode: 'http' }
  }
  async start(handlers) { this.handlers = handlers; handlers.onStatus(this.status) }
  async stop() {}
  async sendMessage(peer, segments) { this.sent.push({ peer: String(peer), segments }); return { message_id: 1 } }
  async fetchHistory(peer) { return this.历史[String(peer)] || [] }
  getStatus() { return this.status }
  emit(event) { this.handlers?.onEvent(event) }
}

class 假投递 {
  constructor() { this.got = []; this.fail = false }
  async deliver(req) {
    if (this.fail) return { ok: false, error: '会话没开' }
    this.got.push(req)
    return { ok: true }
  }
  async attachmentPath() { return '' }
}

class 假语音 {
  constructor() { this.transcribed = [] }
  async transcribeRecord(segment, id) { return { text: segment?.data?.text || '', speakerName: '主人' } }
  async fetchImage() { throw new Error('测试里不放图片') }
  async synthesize() { throw new Error('测试里不合成') }
}

function 建桥({ dir = 临时目录(), 历史 = {}, config = {} } = {}) {
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'test.log'), level: 'debug' })
  const transport = new 假传输(历史)
  const delivery = new 假投递()
  const voice = new 假语音()
  const 配置 = normalizeConfig({
    napcatBaseUrl: 'http://127.0.0.1:3000',
    bindings: [{ qq: QQ, session: 会话, name: '主人', enabled: true }],
    backfillWindowHours: 24,
    reorderBufferMs: 20,
    historyCount: 100,
    ...config,
  })
  const bridge = new Bridge({
    getConfig: () => 配置,
    transport,
    store,
    logger,
    voice,
    delivery,
    autoTimers: false,
  })
  store.setWatermark(QQ, { timestamp: 1, messageId: '' })
  return { dir, store, logger, transport, delivery, voice, 配置, bridge }
}

test('补投：乱序到达按时间升序，同一 message_id 只投一次', async () => {
  const 现在 = Math.floor(Date.now() / 1000)
  const { bridge, delivery, transport } = 建桥({
    历史: {
      [QQ]: [
        建消息('3', '第三', 现在 - 10),
        建消息('1', '第一', 现在 - 30),
        建消息('2', '第二', 现在 - 20),
        建消息('2', '第二', 现在 - 20),
      ],
    },
  })
  await bridge.start({ syncNow: false })
  await bridge.sync('test')
  assert.deepEqual(delivery.got.map((x) => x.text), ['第一', '第二', '第三'])
  assert.equal(transport.sent.length, 0)

  await bridge.sync('again')
  assert.equal(delivery.got.length, 3, '第二次同步不能重投')
  await bridge.stop()
})

test('水位落盘：重建 Bridge 后不重投', async () => {
  const 现在 = Math.floor(Date.now() / 1000)
  const dir = 临时目录()
  const 历史 = { [QQ]: [建消息('10', '只投一次', 现在 - 10)] }
  const 第一 = 建桥({ dir, 历史 })
  await 第一.bridge.start({ syncNow: false })
  await 第一.bridge.sync('test')
  assert.equal(第一.delivery.got.length, 1)
  const 水位 = 第一.store.getWatermark(QQ)
  assert.ok(水位.timestamp >= 现在 - 10)
  await 第一.bridge.stop()

  const 第二 = 建桥({ dir, 历史 })
  await 第二.bridge.start({ syncNow: false })
  await 第二.bridge.sync('test')
  assert.equal(第二.delivery.got.length, 0, '新实例应该从磁盘水位接着走')
  await 第二.bridge.stop()
})

test('超过补投窗口：只投一条摘要，消息本身不投', async () => {
  const 现在 = Math.floor(Date.now() / 1000)
  const { bridge, delivery } = 建桥({
    历史: { [QQ]: [建消息('20', '很久以前', 现在 - 48 * 3600)] },
    config: { backfillWindowHours: 24 },
  })
  await bridge.start({ syncNow: false })
  await bridge.sync('test')
  assert.equal(delivery.got.length, 1)
  assert.match(delivery.got[0].text, /离线补投摘要/)
  assert.match(delivery.got[0].text, /1 条/)
  await bridge.stop()
})

test('WS 事件：缓冲后按时间排序', async () => {
  const 现在 = Math.floor(Date.now() / 1000)
  const { bridge, delivery, transport } = 建桥()
  await bridge.start({ syncNow: false })
  transport.emit({ post_type: 'message', message_type: 'private', ...建消息('31', '晚', 现在 - 10) })
  transport.emit({ post_type: 'message', message_type: 'private', ...建消息('29', '早', 现在 - 30) })
  transport.emit({ post_type: 'message', message_type: 'private', ...建消息('30', '中', 现在 - 20) })
  await 睡(120)
  assert.deepEqual(delivery.got.map((x) => x.text), ['早', '中', '晚'])
  await bridge.stop()
})

test('保存设置后 stop → start：队列能重新接收', async () => {
  const 现在 = Math.floor(Date.now() / 1000)
  const { bridge, delivery, transport } = 建桥()
  await bridge.start({ syncNow: false })
  await bridge.stop()
  await bridge.start({ syncNow: false })
  transport.emit({ post_type: 'message', message_type: 'private', ...建消息(41, '重启后还能收', 现在 - 5) })
  await 睡(100)
  assert.deepEqual(delivery.got.map((x) => x.text), ['重启后还能收'])
  await bridge.stop()
})

test('出站：只发 [QQ] 块内，块外不发', async () => {
  const { bridge, transport } = 建桥()
  await bridge.start({ syncNow: false })
  await bridge.deliverAssistantTurn(会话, '这段只留本地。 [QQ]你好，手机[/QQ] 这段也不发。')
  assert.equal(transport.sent.length, 1)
  assert.deepEqual(transport.sent[0].segments, [{ type: 'text', data: { text: '你好，手机' } }])
  await bridge.stop()
})

test('出站：关掉「只发标记内」时整条发但剥标记', async () => {
  const { bridge, transport } = 建桥({ config: { onlyInsideMarkers: false } })
  await bridge.start({ syncNow: false })
  await bridge.deliverAssistantTurn(会话, '前 [QQ]中[/QQ] 后')
  assert.equal(transport.sent.length, 1)
  assert.equal(transport.sent[0].segments[0].data.text, '前 中 后')
  await bridge.stop()
})

test('语音发送：失败后自动重试，第三次成功', async () => {
  const dir = 临时目录()
  const 音频 = join(dir, 'a.wav')
  writeFileSync(音频, Buffer.from('RIFFxxxxWAVE'))
  const { bridge, transport } = 建桥({ dir })
  await bridge.start({ syncNow: false })
  let 次数 = 0
  const 原 = transport.sendMessage.bind(transport)
  transport.sendMessage = async (peer, segments) => {
    次数++
    if (次数 < 3) throw new Error('模拟失败')
    return 原(peer, segments)
  }
  const r = await bridge.sendRecordWithRetry(QQ, 音频, '测试语音')
  assert.equal(次数, 3)
  assert.equal(r.ok, true)
  await bridge.stop()
})

test('状态：已处理 id 持久化并有限长度', () => {
  const dir = 临时目录()
  const s = new StateStore({ homeDir: dir })
  for (let i = 0; i < 5; i++) s.markSeen(`id-${i}`)
  s.save()
  const s2 = new StateStore({ homeDir: dir })
  assert.equal(s2.hasSeen('id-0'), true)
  assert.equal(s2.hasSeen('id-4'), true)
  assert.equal(s2.snapshot().seen.length, 5)
})

test('旧桥状态迁移：只读旧文件，搬水位和已转 id', () => {
  const dir = 临时目录()
  const 旧 = join(dir, 'qq-bridge-state.json')
  writeFileSync(旧, JSON.stringify({ 上次: { [`私聊:${QQ}`]: 1700000000 }, 已转: [111, 222] }), 'utf8')
  const s = new StateStore({ homeDir: dir, legacyStatePath: 旧 })
  const r = s.migrateLegacy(QQ)
  assert.equal(r.timestamp, 1700000000)
  assert.equal(r.ids, 2)
  assert.equal(s.getWatermark(QQ).timestamp, 1700000000)
  assert.equal(s.hasSeen('111'), true)
  assert.ok(existsSync(旧), '旧桥文件必须保留')
})

test('配置：派生 WS 地址、旧桥字段迁移、范围钳制', () => {
  assert.equal(deriveWsUrl('http://127.0.0.1:3000/'), 'ws://127.0.0.1:3000')
  const 旧 = migrateLegacyConfig({
    NapCat: 'http://127.0.0.1:3000',
    绑定: [{ 类型: '私聊', 号码: '1696117435', 会话: 'session-a', 称呼: '主人' }],
    只发标记内: true,
    补投窗口分: 10,
  })
  assert.equal(旧.bindings.length, 1)
  assert.equal(旧.bindings[0].qq, '1696117435')
  assert.equal(旧.backfillWindowHours, 24, '迁移时至少给 24 小时')
  const 钳 = normalizeConfig({ pollIntervalMs: 10, historyCount: 9999, logLevel: '怪' })
  assert.equal(钳.pollIntervalMs, 500)
  assert.equal(钳.historyCount, 500)
  assert.equal(钳.logLevel, 'info')
})
