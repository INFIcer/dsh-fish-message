// 出站节奏：字数算法、最小间隔、发送顺序、补发也按间隔、不阻塞收消息。
//
// 时钟是注入的假时钟：sleep 会把假时钟往前拨，所以断言的是「补等了多少」，
// 不是真实经过多久，也不会真等 2 秒。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '../lib/bridge.js'
import { StateStore } from '../lib/storage.js'
import { Logger } from '../lib/logger.js'
import { normalizeConfig } from '../lib/config.js'
import { countTextUnits, countSegmentUnits, outboundIntervalMs, OutboundPacer } from '../lib/pacing.js'

const QQ = '10001'
/** 模拟「本轮回复由 QQ 渠道的入站触发」：出站只认本轮来源。 */
const QQ_SOURCE = { channel: 'qq', peer: QQ }
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
  // 假时钟：sleep 推进它，发送时刻因此是可断言的确定值。
  const clock = { t: 1_700_000_000_000 }
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
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock.t += ms
      if (sleepFn) await sleepFn(ms)
    },
  })
  store.setWatermark(QQ, { timestamp: 1, messageId: '' })
  return { dir, store, logger, transport, delivery, sleeps, clock, cfg, bridge }
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

test('间隔：固定间隔 + 字数 × 逐字间隔，四舍五入到毫秒', () => {
  assert.equal(outboundIntervalMs([{ type: 'text', data: { text: '你好' } }], { perMessageMs: 2000, perCharMs: 100 }), 2200)
  assert.equal(outboundIntervalMs([{ type: 'text', data: { text: '你好，世界！' } }], { perMessageMs: 0, perCharMs: 100 }), 440)
  assert.equal(outboundIntervalMs([{ type: 'image', data: { path: 'a.png' } }], { perMessageMs: 2000, perCharMs: 100 }), 2000)
  assert.equal(outboundIntervalMs([], { perMessageMs: 2000, perCharMs: 100 }), 2000)
  assert.equal(outboundIntervalMs([{ type: 'text', data: { text: '你好' } }], { perMessageMs: 0, perCharMs: 0 }), 0)
})

test('Pacer：没有更早的消息时直接返回，不睡', async () => {
  const clock = { t: 0 }
  const calls = []
  const pacer = new OutboundPacer({
    getConfig: () => ({ outboxPerMessageDelayMs: 100, outboxPerCharDelayMs: 50 }),
    now: () => clock.t,
    sleep: async (ms) => { calls.push(ms); clock.t += ms },
  })
  const segment = { type: 'text', data: { text: '你好' } } // 间隔 100 + 2 × 50 = 200
  assert.equal(await pacer.wait(segment), 0, '本进程还没发过，没有更早的消息可比，不等')
  assert.deepEqual(calls, [])
  assert.equal(pacer.delayFor, undefined, '旧口径 delayFor 已改名为 intervalFor')
  assert.equal(pacer.intervalFor({ type: 'text', data: { text: 'hello world' } }), 210)
})

test('Pacer：距上一条已隔够就立即发，不够只补等剩下的那一段', async () => {
  const clock = { t: 0 }
  const calls = []
  const pacer = new OutboundPacer({
    getConfig: () => ({ outboxPerMessageDelayMs: 100, outboxPerCharDelayMs: 50 }),
    now: () => clock.t,
    sleep: async (ms) => { calls.push(ms); clock.t += ms },
  })
  const segment = { type: 'text', data: { text: '你好' } } // 间隔 200

  pacer.markSent() // 时刻 0 发出去一条
  assert.equal(pacer.dueAtFor(segment), 200)
  assert.equal(await pacer.wait(segment), 200, '紧接着发下一条：等满整个间隔')
  assert.deepEqual(calls, [200])

  pacer.markSent() // 时刻 200 又发了一条
  clock.t += 80
  assert.equal(await pacer.wait(segment), 120, '已经过了 80ms，只补等剩下的 120ms')
  assert.deepEqual(calls, [200, 120])

  pacer.markSent() // 时刻 320 发了一条
  clock.t += 5000
  assert.equal(await pacer.wait(segment), 0, '隔了 5 秒，早就够间隔了，不再等')
  assert.deepEqual(calls, [200, 120])
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

test('Bridge：首条直接发，紧跟的第二条只补等间隔差的那段', async () => {
  const { bridge, transport, sleeps } = makeBridge()
  await bridge.start({ syncNow: false })
  // 你好 = 2 字 → 间隔 40；第一段话 = 4 字 → 间隔 60。
  await bridge.deliverAssistantTurn(session, '[MSG]你好[/MSG]', [], QQ_SOURCE)
  await bridge.deliverAssistantTurn(session, '[MSG]第一段话[/MSG]', [], QQ_SOURCE)

  assert.deepEqual(sleeps, [60], '首条没有更早的消息不等；第二条距上一条还不够，补等 60ms')
  assert.equal(transport.sent.length, 2)
  assert.equal(transport.sent[0].segments[0].data.text, '你好')
  assert.equal(transport.sent[1].segments[0].data.text, '第一段话')
  await bridge.stop()
})

test('Bridge：距上一条发出已超过间隔时立即发，不等整段', async () => {
  const { bridge, transport, sleeps, clock } = makeBridge()
  await bridge.start({ syncNow: false })
  await bridge.sendOutbound(QQ, [{ type: 'text', data: { text: '早' } }], { reason: 'test' })
  clock.t += 10000 // 隔了很久
  await bridge.sendOutbound(QQ, [{ type: 'text', data: { text: '很久以后的回复' } }], { reason: 'test' })
  clock.t += 5
  await bridge.sendOutbound(QQ, [{ type: 'text', data: { text: '紧接着的下一条' } }], { reason: 'test' })

  // 「很久以后的回复」隔够了直接发；「紧接着的下一条」7 字 → 间隔 90，只过了 5ms，补等 85。
  assert.deepEqual(sleeps, [85])
  assert.equal(transport.sent.length, 3)
  await bridge.stop()
})

test('Bridge：一步里多个块各自按自己的字数算间隔', async () => {
  const { bridge, transport, sleeps } = makeBridge()
  await bridge.start({ syncNow: false })
  // 你好 = 2 字 → 40；第一段话 = 4 字 → 60；短 = 1 字 → 30。
  await bridge.deliverAssistantTurn(session, '[MSG]你好[/MSG][MSG]第一段话[/MSG][MSG]短[/MSG]', [], QQ_SOURCE)
  assert.deepEqual(sleeps, [60, 30], '首块立即发，后面两块各按自己的字数补等')
  assert.deepEqual(transport.sent.map((x) => x.segments[0].data.text), ['你好', '第一段话', '短'])
  await bridge.stop()
})

test('Bridge：图片与语音文件段只按固定间隔', async () => {
  const { bridge, transport, sleeps, dir } = makeBridge()
  await bridge.start({ syncNow: false })
  const png = writePng(dir)
  const wav = writeWav(dir)

  await bridge.sendOutbound(QQ, [{ type: 'image', data: { path: png } }], { reason: 'test' })
  await bridge.sendOutbound(QQ, [{ type: 'record', data: { path: wav } }], { reason: 'test' })
  assert.deepEqual(sleeps, [20], '首条图片直接发；语音只隔固定 20ms，不按字数加')
  assert.equal(transport.sent.length, 2)
  assert.equal(transport.sent[0].segments[0].type, 'image')
  assert.equal(transport.sent[1].segments[0].type, 'record')
  await bridge.stop()
})

test('Bridge：补发队列里的消息也按间隔等（只补剩下的）', async () => {
  const { bridge, transport, sleeps, clock } = makeBridge()
  await bridge.start({ syncNow: false })
  await bridge.sendText(QQ, '先发一条')
  assert.deepEqual(sleeps, [], '首条直接发，不等')

  // 传输层已停：直接入队，不尝试发送（所以也不该等）。
  transport.status.mode = 'stopped'
  const queued = await bridge.sendText(QQ, '这条先入队')
  assert.equal(queued.queued, true)
  assert.equal(bridge.outbox.pending(), 1)
  assert.deepEqual(sleeps, [], '入队时还没发，不该等')

  transport.status.mode = 'http'
  transport.online = true
  clock.t += 15 // 距上一条已经过了 15ms
  const flushed = await bridge.flushOutbox('test', { force: true })
  assert.equal(flushed.sent, 1)
  // 「这条先入队」5 字 → 间隔 70；已经过了 15ms，只补等剩下的 55ms。
  assert.deepEqual(sleeps, [55], '补发同样按间隔补等')
  assert.equal(transport.sent.length, 2)
  assert.equal(transport.sent[1].segments[0].data.text, '这条先入队')
  await bridge.stop()
})

test('Bridge：节奏全关（0/0）时不等，照常发送', async () => {
  const { bridge, transport, sleeps } = makeBridge({
    config: { outboxPerMessageDelayMs: 0, outboxPerCharDelayMs: 0 },
  })
  await bridge.start({ syncNow: false })
  await bridge.sendText(QQ, '不等直接发')
  await bridge.sendText(QQ, '第二条也不等')
  assert.deepEqual(sleeps, [])
  assert.equal(transport.sent.length, 2)
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
  // 先发一条，让下一条有「上一条」可比（首条按新口径不等）。
  await bridge.sendOutbound(QQ, [{ type: 'text', data: { text: '热身' } }], { reason: 'test' })

  const pending = bridge.deliverAssistantTurn(session, '[MSG]慢一点发[/MSG]', [], QQ_SOURCE)
  assert.equal(await waitFor(() => seen.length === 1), true, '出站先进入等待')
  assert.equal(transport.sent.length, 1, '等待期间还没发到 QQ')

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
  assert.equal(transport.sent.length, 2, '等待结束后照常发出')
  assert.equal(transport.sent[1].segments[0].data.text, '慢一点发')
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
