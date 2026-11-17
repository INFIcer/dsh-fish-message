// 出站节奏：字数算法、等待时长、发送顺序、补发也延迟、不阻塞收消息。
//
// 等待用注入的 sleep 记录，不会真等 2 秒/条。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '../lib/bridge.js'
import { StateStore } from '../lib/storage.js'
import { Logger } from '../lib/logger.js'
import { normalizeConfig } from '../lib/config.js'
import { countTextUnits, countSegmentUnits, outboundDelayMs, OutboundPacer } from '../lib/pacing.js'

const QQ = '10001'
const session = 'session-pacing'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(check, timeout = 2000, interval = 10) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (check()) return true
    await sleep(interval)
  }
  return false
}

class fakeTransport {
  constructor() {
    this.sent = []
    this.handlers = null
    this.online = true
    this.status = { name: 'fake', connected: false, mode: 'http' }
  }
  async start(handlers) { this.handlers = handlers; handlers.onStatus(this.status) }
  async stop() {}
  async sendMessage(peer, segments) {
    if (!this.online) throw new Error('模拟离线')
    this.sent.push({ peer: String(peer), segments })
    return { message_id: this.sent.length }
  }
  async fetchHistory() { return [] }
  getStatus() { return this.status }
  emit(event) { this.handlers?.onEvent(event) }
}

class fakeDelivery {
  constructor() { this.got = [] }
  async deliver(req) { this.got.push(req); return { ok: true } }
  async attachmentPath() { return '' }
}

function makeBridge({ dir = mkdtempSync(join(tmpdir(), 'fish-pacing-')), config = {}, sleep: sleepFn } = {}) {
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'test.log'), level: 'debug' })
  const transport = new fakeTransport()
  const delivery = new fakeDelivery()
  const sleeps = []
  const cfg = normalizeConfig({
    bindings: [{ qq: QQ, session, name: '主人', enabled: true }],
    reorderBufferMs: 10,
    inboundEditWindowMs: 0,
    // 用较小的值方便断言：固定 20ms + 每字 10ms。
    outboxPerMessageDelayMs: 20,
    outboxPerCharDelayMs: 10,
    ...config,
  })
  const bridge = new Bridge({
    getConfig: () => cfg,
    transport,
    store,
    logger,
    voice: { async fetchImage() { throw new Error('测试不放图片') } },
    delivery,
    autoTimers: false,
    sleep: sleepFn || (async (ms) => { sleeps.push(ms) }),
  })
  store.setWatermark(QQ, { timestamp: 1, messageId: '' })
  return { dir, store, logger, transport, delivery, sleeps, cfg, bridge }
}

const writePng = (dir) => {
  const path = join(dir, 'pic.png')
  writeFileSync(path, 'fake-png')
  return path
}

const writeWav = (dir) => {
  const path = join(dir, 'voice.wav')
  writeFileSync(path, 'fake-wav')
  return path
}

// ---------------- 字数算法 ----------------

test('字数：中文每个字算 1', () => {
  assert.equal(countTextUnits('你好'), 2)
  assert.equal(countTextUnits('晚安，做个好梦'), 6.2) // 6 个汉字 + 1 个逗号（0.2）
})

test('字数：英文一个单词算 1，不按字母算', () => {
  assert.equal(countTextUnits('hello'), 1)
  assert.equal(countTextUnits('hello world'), 2.2) // 两个词 + 1 个空格
  assert.equal(countTextUnits('I love DSH'), 3.4)
})

test('字数：标点、空格、符号各算 0.2', () => {
  assert.equal(countTextUnits('，'), 0.2)
  assert.equal(countTextUnits(' '), 0.2)
  assert.equal(countTextUnits('！？'), 0.4)
  assert.equal(countTextUnits('你好，世界！'), 4.4)
})

test('字数：连续数字串算 1', () => {
  assert.equal(countTextUnits('1998'), 1)
  assert.equal(countTextUnits('2026 年'), 2.2) // 数字串 1 + 空格 0.2 + 「年」1
})

test('字数：中英混排按各自口径累加', () => {
  // 你(1)好(1) 空格(0.2) world(1) 空格(0.2) 2026(1) !(0.2)
  assert.equal(countTextUnits('你好 world 2026!'), 4.6)
})

test('字数：emoji 与其它符号按 0.2 算，空值算 0', () => {
  assert.equal(countTextUnits('😀'), 0.2)
  assert.equal(countTextUnits(''), 0)
  assert.equal(countTextUnits(null), 0)
})

test('字数：图片、文件、语音文件段不算字；语音文本按文本算', () => {
  assert.equal(countSegmentUnits({ type: 'image', data: { path: 'a.png' } }), 0)
  assert.equal(countSegmentUnits({ type: 'file', data: { path: 'a.pdf' } }), 0)
  assert.equal(countSegmentUnits({ type: 'record', data: { path: 'a.wav' } }), 0)
  assert.equal(countSegmentUnits({ type: 'record_file', data: { path: 'a.wav' } }), 0)
  assert.equal(countSegmentUnits({ type: 'record_text', data: { text: '晚安' } }), 2)
  assert.equal(countSegmentUnits({ type: 'text', data: { text: 'hello' } }), 1)
  assert.equal(countSegmentUnits({ type: 'weird' }), 0)
})

test('延迟：固定延迟 + 字数 × 逐字延迟，四舍五入到毫秒', () => {
  assert.equal(outboundDelayMs([{ type: 'text', data: { text: '你好' } }], { perMessageMs: 2000, perCharMs: 100 }), 2200)
  assert.equal(outboundDelayMs([{ type: 'text', data: { text: '你好，世界！' } }], { perMessageMs: 0, perCharMs: 100 }), 440)
  assert.equal(outboundDelayMs([{ type: 'image', data: { path: 'a.png' } }], { perMessageMs: 2000, perCharMs: 100 }), 2000)
  assert.equal(outboundDelayMs([], { perMessageMs: 2000, perCharMs: 100 }), 2000)
  assert.equal(outboundDelayMs([{ type: 'text', data: { text: '你好' } }], { perMessageMs: 0, perCharMs: 0 }), 0)
})

test('Pacer：按注入的时钟与 sleep 等待，返回实际等待时长', async () => {
  const clock = { t: 0 }
  const calls = []
  const pacer = new OutboundPacer({
    getConfig: () => ({ outboxPerMessageDelayMs: 100, outboxPerCharDelayMs: 50 }),
    now: () => clock.t,
    sleep: async (ms) => { calls.push(ms); clock.t += ms },
  })
  const waited = await pacer.wait({ type: 'text', data: { text: '你好' } })
  assert.deepEqual(calls, [200])
  assert.equal(waited, 200)
  assert.equal(pacer.delayFor({ type: 'text', data: { text: 'hello world' } }), 210)
})

test('Pacer：配置为 0 时不等', async () => {
  let slept = 0
  const pacer = new OutboundPacer({
    getConfig: () => ({ outboxPerMessageDelayMs: 0, outboxPerCharDelayMs: 0 }),
    sleep: async () => { slept += 1 },
  })
  assert.equal(await pacer.wait({ type: 'text', data: { text: '你好' } }), 0)
  assert.equal(slept, 0)
})

// ---------------- Bridge 行为 ----------------

test('Bridge：正常回复按字数逐条等待，发送顺序不变', async () => {
  const { bridge, transport, sleeps } = makeBridge()
  await bridge.start({ syncNow: false })
  // 两轮分别发：你好 = 2 字 → 20 + 20；第一段话 = 4 字 → 20 + 40。
  await bridge.deliverAssistantTurn(session, '[QQ]你好[/QQ]')
  await bridge.deliverAssistantTurn(session, '[QQ]第一段话[/QQ]')

  assert.deepEqual(sleeps, [40, 60])
  assert.equal(transport.sent.length, 2)
  assert.equal(transport.sent[0].segments[0].data.text, '你好')
  assert.equal(transport.sent[1].segments[0].data.text, '第一段话')
  await bridge.stop()
})

test('Bridge：图片与语音文件段只等固定延迟，不等字数', async () => {
  const { bridge, transport, sleeps, dir } = makeBridge()
  await bridge.start({ syncNow: false })
  const png = writePng(dir)
  const wav = writeWav(dir)

  await bridge.sendOutbound(QQ, [{ type: 'image', data: { path: png } }], { reason: 'test' })
  await bridge.sendOutbound(QQ, [{ type: 'record', data: { path: wav } }], { reason: 'test' })
  assert.deepEqual(sleeps, [20, 20])
  assert.equal(transport.sent.length, 2)
  assert.equal(transport.sent[0].segments[0].type, 'image')
  assert.equal(transport.sent[1].segments[0].type, 'record')
  await bridge.stop()
})

test('Bridge：补发队列里的消息也要等节奏', async () => {
  const { bridge, transport, sleeps } = makeBridge()
  await bridge.start({ syncNow: false })
  // 传输层已停：直接入队，不尝试发送（所以也不该等）。
  transport.status.mode = 'stopped'
  const queued = await bridge.sendText(QQ, '这条先入队')
  assert.equal(queued.queued, true)
  assert.equal(bridge.outbox.pending(), 1)
  assert.deepEqual(sleeps, [], '入队时还没发，不该等')

  transport.status.mode = 'http'
  transport.online = true
  const flushed = await bridge.flushOutbox('test', { force: true })
  assert.equal(flushed.sent, 1)
  assert.deepEqual(sleeps, [20 + 5 * 10], '补发同样按「固定 + 字数」等')
  assert.equal(transport.sent.length, 1)
  assert.equal(transport.sent[0].segments[0].data.text, '这条先入队')
  await bridge.stop()
})

test('Bridge：节奏全关（0/0）时不等，照常发送', async () => {
  const { bridge, transport, sleeps } = makeBridge({
    config: { outboxPerMessageDelayMs: 0, outboxPerCharDelayMs: 0 },
  })
  await bridge.start({ syncNow: false })
  await bridge.sendText(QQ, '不等直接发')
  assert.deepEqual(sleeps, [])
  assert.equal(transport.sent.length, 1)
  await bridge.stop()
})

test('Bridge：出站等待期间照常收消息，不阻塞入站', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const seen = []
  const { bridge, transport, delivery } = makeBridge({
    sleep: async (ms) => { seen.push(ms); await gate },
  })
  await bridge.start({ syncNow: false })

  const pending = bridge.deliverAssistantTurn(session, '[QQ]慢一点发[/QQ]')
  assert.equal(await waitFor(() => seen.length === 1), true, '出站先进入等待')
  assert.equal(transport.sent.length, 0, '等待期间还没发到 QQ')

  transport.emit({
    post_type: 'message',
    message_type: 'private',
    message_id: 901,
    message_seq: 901,
    time: Math.floor(Date.now() / 1000),
    user_id: Number(QQ),
    message: [{ type: 'text', data: { text: '出站等待时收到的消息' } }],
    raw_message: '出站等待时收到的消息',
  })
  assert.equal(await waitFor(() => delivery.got.length === 1), true, '入站不受出站等待影响')
  assert.equal(delivery.got[0].text, '出站等待时收到的消息')

  release()
  await pending
  assert.equal(transport.sent.length, 1, '等待结束后照常发出')
  assert.equal(transport.sent[0].segments[0].data.text, '慢一点发')
  await bridge.stop()
})

test('配置：出站节奏与编辑窗口的默认值、钳制范围', () => {
  const defaults = normalizeConfig({})
  assert.equal(defaults.inboundEditWindowMs, 15000)
  assert.equal(defaults.outboxPerMessageDelayMs, 2000)
  assert.equal(defaults.outboxPerCharDelayMs, 100)

  assert.equal(normalizeConfig({ inboundEditWindowMs: -1 }).inboundEditWindowMs, 0)
  assert.equal(normalizeConfig({ inboundEditWindowMs: 999999 }).inboundEditWindowMs, 120000)
  assert.equal(normalizeConfig({ outboxPerMessageDelayMs: -1 }).outboxPerMessageDelayMs, 0)
  assert.equal(normalizeConfig({ outboxPerMessageDelayMs: 999999 }).outboxPerMessageDelayMs, 60000)
  assert.equal(normalizeConfig({ outboxPerCharDelayMs: -1 }).outboxPerCharDelayMs, 0)
  assert.equal(normalizeConfig({ outboxPerCharDelayMs: 99999 }).outboxPerCharDelayMs, 5000)
})
