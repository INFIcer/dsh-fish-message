import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Bridge } from '../lib/bridge.js'
import { VoiceService } from '../lib/voice.js'
import { StateStore } from '../lib/storage.js'
import { ForwardQueue } from '../lib/forward-queue.js'
import { ConfigStore, removedVoiceFields, normalizeConfig, deriveWsUrl, migrateLegacyConfig, publicConfig, defaultImagePrompt, defaultLongTaskReminder, defaultChannelReminder } from '../lib/config.js'
import {
  GuardMonitor, constructToolGuard, guardRules, refuseTool, longTaskReminderText, channelReminderText, turnGraceMs,
} from '../lib/guard.js'
import { AiService } from '../lib/ai.js'
import { Logger } from '../lib/logger.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待条件成立（测试里的 setTimeout 补投是异步的）。 */
async function wait(condition, ms = 1000, interval = 20) {
  const stop = Date.now() + ms
  while (Date.now() < stop) {
    if (await condition()) return true
    await sleep(interval)
  }
  return false
}

const tempDir = () => mkdtempSync(join(tmpdir(), 'fish-message-test-'))
const QQ = '10001'
/** 模拟「本轮回复由 QQ 渠道的入站触发」：出站只认本轮来源。 */
const QQ_SOURCE = { channel: 'qq', peer: QQ }
const session = 'session-test-0001'

function makeMessage(id, text, time, qq = QQ) {
  return {
    message_id: id,
    message_seq: Number(id),
    time: time,
    user_id: Number(qq),
    message_type: 'private',
    message: [{ type: 'text', data: { text: text } }],
    raw_message: text,
    sender: { user_id: Number(qq), nickname: '主人' },
  }
}

class fakeTransport {
  constructor(history = {}) {
    this.history = history
    this.sent = []
    this.handlers = null
    this.name = 'fake'
    this.status = { name: 'fake', connected: false, mode: 'http' }
  }
  async start(handlers) { this.handlers = handlers; handlers.onStatus(this.status) }
  async stop() {}
  async sendMessage(peer, segments) { this.sent.push({ peer: String(peer), segments }); return { message_id: 1 } }
  async fetchHistory(peer) { return this.history[String(peer)] || [] }
  getStatus() { return this.status }
  emit(event) { this.handlers?.onEvent(event) }
}

class fakeDeliver {
  constructor() { this.got = []; this.fail = false }
  async deliver(req) {
    if (this.fail) return { ok: false, error: '会话没开' }
    this.got.push(req)
    return { ok: true }
  }
  async attachmentPath() { return '' }
}

class fakeVoice {
  async fetchImage() { throw new Error('测试里不放图片') }
}

/** 假本地 AI 服务：只实现鱼讯会调的那几个方法，形状按 fish.service 的公开契约。 */
class fakeService {
  constructor({
    ttsOk = true, asrText = '', describeText = '',
    emotion = '', events = null, caps = {}, visionPrefs,
  } = {}) {
    this.ttsOk = ttsOk
    this.asrText = asrText
    this.describeText = describeText
    this.emotion = emotion
    this.events = events
    this.visionPrefsResult = visionPrefs
    this.calls = { tts: [], asr: [], vision: [], prefs: 0 }
    this.voices = [{ name: 'dafeiyu' }, { name: 'test_voice' }]
    this.capabilities = {
      tts: { available: ttsOk, ready: ttsOk },
      asr: { available: true, ready: true },
      vision: { available: true, ready: true },
      ...caps,
    }
  }
  async tts(text, opts) {
    this.calls.tts.push({ text, opts })
    if (!this.ttsOk) return { ok: false, code: 'service_down', hint: '服务没开' }
    return { ok: true, items: [{ wavPath: this.output, voice: opts?.voice, ms: 10 }] }
  }
  async asr(path, opts) {
    this.calls.asr.push({ path, opts })
    // 旧版插件没有 emotion / events：不传就不会出现在返回里，用来验证降级。
    const item = { text: this.asrText, language: opts?.language }
    if (this.emotion) item.emotion = this.emotion
    if (Array.isArray(this.events)) item.events = this.events
    return { ok: true, items: [item] }
  }
  async visionPrefs() {
    this.calls.prefs += 1
    return this.visionPrefsResult
  }
  async visionDescribe(path, opts) {
    this.calls.vision.push({ path, opts })
    return { ok: true, items: [{ path, text: this.describeText }] }
  }
}

function buildAi(service, logger) {
  return new AiService({ getService: () => service, getConfig: () => ({}), logger })
}

/** 造一个最小可解析的 wav（16k 单声道 16bit），用于读时长。 */
function makeWav(seconds = 1) {
  const sampleRate = 16000
  const dataLength = Math.round(sampleRate * seconds) * 2
  const buf = Buffer.alloc(44 + dataLength)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataLength, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataLength, 40)
  return buf
}

function makeBridge({ dir = tempDir(), history = {}, config = {}, ai = null, forwardQueue = null } = {}) {
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'test.log'), level: 'debug' })
  const transport = new fakeTransport(history)
  const delivery = new fakeDeliver()
  const voice = new fakeVoice()
  const cfg = normalizeConfig({
    napcatBaseUrl: 'http://127.0.0.1:3000',
    bindings: [{ qq: QQ, session: session, name: '主人', enabled: true }],
    backfillWindowHours: 24,
    reorderBufferMs: 20,
    historyCount: 100,
    // 这些用例盯的是队列/去重/补投本身：关掉编辑窗口与出站节奏，行为与旧版一致。
    inboundEditWindowMs: 0,
    outboxPerMessageDelayMs: 0,
    outboxPerCharDelayMs: 0,
    ...config,
  })
  const bridge = new Bridge({
    getConfig: () => cfg,
    transport,
    store,
    logger,
    voice,
    delivery,
    forwardQueue,
    ai,
    autoTimers: false,
  })
  store.setWatermark(QQ, { timestamp: 1, messageId: '' })
  return { dir, store, logger, transport, delivery, voice, cfg, bridge }
}

/** 入站解析用的最小桥：只关心 voice、配置和可选的本地 AI。 */
function buildInboundBridge({ dir, service = null, voice, config = {} }) {
  const logger = new Logger({ filePath: join(dir, 'test.log'), level: 'debug' })
  const cfg = normalizeConfig({
    bindings: [{ qq: QQ, session: session, name: '主人', enabled: true }],
    reorderBufferMs: 0,
    inboundEditWindowMs: 0,
    ...config,
  })
  return new Bridge({
    getConfig: () => cfg,
    transport: new fakeTransport(),
    store: new StateStore({ homeDir: dir }),
    logger,
    voice,
    delivery: new fakeDeliver(),
    ai: service ? buildAi(service, logger) : null,
    autoTimers: false,
  })
}

function buildVoiceBridge(dir, service) {
  const raw = join(dir, 'from-qq.wav')
  writeFileSync(raw, makeWav(2))
  const transport = new fakeTransport()
  transport.getRecord = async () => ({ file: raw })
  const logger = new Logger({ filePath: join(dir, 'test.log'), level: 'debug' })
  const voice = new VoiceService({
    getConfig: () => normalizeConfig({ maxVoiceMB: 20 }),
    logger,
    transport,
    inboxDir: join(dir, 'inbox'),
  })
  return buildInboundBridge({ dir, service, voice })
}

function makeImageBridge(dir, service, config = {}) {
  const image = join(dir, 'qq.png')
  writeFileSync(image, 'fake-png')
  const voice = {
    async fetchImage() {
      return { buffer: Buffer.from('fake-png'), base64: 'ZmFrZQ==', mime: 'image/png', path: image, ext: '.png' }
    },
  }
  return { bridge: buildInboundBridge({ dir, service, voice, config }), image }
}

const imageMessage = (id) => ({ message_id: id, message: [{ type: 'image', data: { file: 'a.png' } }] })

test('补投：乱序到达按时间升序，同一 message_id 只投一次', async () => {
  const now = Math.floor(Date.now() / 1000)
  const { bridge, delivery, transport } = makeBridge({
    history: {
      [QQ]: [
        makeMessage('3', '第三', now - 10),
        makeMessage('1', '第一', now - 30),
        makeMessage('2', '第二', now - 20),
        makeMessage('2', '第二', now - 20),
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
  const now = Math.floor(Date.now() / 1000)
  const dir = tempDir()
  const history = { [QQ]: [makeMessage('10', '只投一次', now - 10)] }
  const first = makeBridge({ dir, history })
  await first.bridge.start({ syncNow: false })
  await first.bridge.sync('test')
  assert.equal(first.delivery.got.length, 1)
  const watermark = first.store.getWatermark(QQ)
  assert.ok(watermark.timestamp >= now - 10)
  await first.bridge.stop()

  const secondApp = makeBridge({ dir, history })
  await secondApp.bridge.start({ syncNow: false })
  await secondApp.bridge.sync('test')
  assert.equal(secondApp.delivery.got.length, 0, '新实例应该从磁盘水位接着走')
  await secondApp.bridge.stop()
})

test('未绑定会话的渠道：不进 bySession，消息不投递，但水位照样推进', async () => {
  const now = Math.floor(Date.now() / 1000)
  const { bridge, delivery, store } = makeBridge({
    history: { '10002': [makeMessage('u1', '未绑定时的消息', now - 10, '10002')] },
    config: {
      bindings: [
        { qq: QQ, session: session, name: '主人', enabled: true },
        { qq: '10002', session: '', name: '小号', enabled: true },
      ],
    },
  })
  await bridge.start({ syncNow: false })
  assert.equal(bridge.bySession.has(''), false, "空 session 不能占据 bySession 的 '' 键")
  assert.equal(bridge.bySession.size, 1)
  assert.equal(bridge.byPeer.size, 2, '渠道本身仍然按 QQ 收消息')

  await bridge.sync('test')
  assert.equal(delivery.got.length, 0, '没有会话就不投递')
  assert.equal(store.hasSeen('u1'), true, '消息仍标记已读，重新绑定时不补投')
  const watermark = store.getWatermark('10002')
  assert.ok(watermark && watermark.timestamp >= now - 10, '水位照常推进')

  await bridge.sync('again')
  assert.equal(delivery.got.length, 0, '第二次同步也不能补投')
  await bridge.stop()
})

test('超过补投窗口：只投一条摘要，消息本身不投', async () => {
  const now = Math.floor(Date.now() / 1000)
  const { bridge, delivery } = makeBridge({
    history: { [QQ]: [makeMessage('20', '很久以前', now - 48 * 3600)] },
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
  const now = Math.floor(Date.now() / 1000)
  const { bridge, delivery, transport } = makeBridge()
  await bridge.start({ syncNow: false })
  transport.emit({ post_type: 'message', message_type: 'private', ...makeMessage('31', '晚', now - 10) })
  transport.emit({ post_type: 'message', message_type: 'private', ...makeMessage('29', '早', now - 30) })
  transport.emit({ post_type: 'message', message_type: 'private', ...makeMessage('30', '中', now - 20) })
  await sleep(120)
  assert.deepEqual(delivery.got.map((x) => x.text), ['早', '中', '晚'])
  await bridge.stop()
})

test('保存设置后 stop → start：队列能重新接收', async () => {
  const now = Math.floor(Date.now() / 1000)
  const { bridge, delivery, transport } = makeBridge()
  await bridge.start({ syncNow: false })
  await bridge.stop()
  await bridge.start({ syncNow: false })
  transport.emit({ post_type: 'message', message_type: 'private', ...makeMessage(41, '重启后还能收', now - 5) })
  await sleep(100)
  assert.deepEqual(delivery.got.map((x) => x.text), ['重启后还能收'])
  await bridge.stop()
})

test('出站：只发 [MSG] 块内，块外不发', async () => {
  const { bridge, transport } = makeBridge()
  await bridge.start({ syncNow: false })
  await bridge.deliverAssistantTurn(session, '这段只留本地。 [MSG]你好，手机[/MSG] 这段也不发。', [], QQ_SOURCE)
  assert.equal(transport.sent.length, 1)
  assert.deepEqual(transport.sent[0].segments, [{ type: 'text', data: { text: '你好，手机' } }])
  await bridge.stop()
})

test('出站：关掉「只发标记内」时整条发但剥标记', async () => {
  const { bridge, transport } = makeBridge({ config: { onlyInsideMarkers: false } })
  await bridge.start({ syncNow: false })
  await bridge.deliverAssistantTurn(session, '前 [MSG]中[/MSG] 后', [], QQ_SOURCE)
  assert.equal(transport.sent.length, 1)
  assert.equal(transport.sent[0].segments[0].data.text, '前 中 后')
  await bridge.stop()
})

/** 造一条 DSH 的 assistant/message：一轮一个模型步一条。 */
function assistantStep(turn, step, content, id = `message-${turn}-${step}`) {
  return { type: 'assistant/message', data: { turn, step, message: { id, content } } }
}

const turnEnd = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })

test('出站：一轮两个模型步，中途步的 [MSG] 也发出去且顺序在前', async () => {
  const { bridge, transport } = makeBridge()
  await bridge.start({ syncNow: false })
  bridge.noteInboundSource(session, 'qq', QQ)
  bridge.onSessionEvent({ id: session }, assistantStep(1, 1, [{ type: 'text', text: '先去查 [MSG]第一步的结论[/MSG] 然后继续' }]))
  bridge.onSessionEvent({ id: session }, assistantStep(1, 2, [{ type: 'text', text: '收尾完成，这一步没有要发的' }]))
  bridge.onSessionEvent({ id: session }, turnEnd(1))
  assert.equal(await wait(() => transport.sent.length === 1), true)
  assert.deepEqual(transport.sent[0].segments, [{ type: 'text', data: { text: '第一步的结论' } }])
  await bridge.stop()
})

test('出站：一轮多个模型步各有一段 [MSG] 时按顺序全发', async () => {
  const { bridge, transport } = makeBridge()
  await bridge.start({ syncNow: false })
  bridge.noteInboundSource(session, 'qq', QQ)
  bridge.onSessionEvent({ id: session }, assistantStep(1, 1, [{ type: 'text', text: '[MSG]第一段[/MSG]' }]))
  bridge.onSessionEvent({ id: session }, assistantStep(1, 2, [{ type: 'text', text: '[MSG]第二段[/MSG]' }]))
  bridge.onSessionEvent({ id: session }, assistantStep(1, 3, [{ type: 'text', text: '[MSG]第三段[/MSG]' }]))
  bridge.onSessionEvent({ id: session }, turnEnd(1))
  assert.equal(await wait(() => transport.sent.length === 3), true)
  assert.deepEqual(
    transport.sent.map((x) => x.segments[0].data.text),
    ['第一段', '第二段', '第三段'],
  )
  await bridge.stop()
})

test('出站：一步里写三个 [MSG] 块 → 三条独立消息，顺序与块序一致', async () => {
  const { bridge, transport } = makeBridge()
  await bridge.start({ syncNow: false })
  bridge.noteInboundSource(session, 'qq', QQ)
  bridge.onSessionEvent({ id: session }, assistantStep(1, 1, [{ type: 'text', text: '[MSG]第一块[/MSG][MSG]第二块[/MSG][MSG]第三块[/MSG]' }]))
  bridge.onSessionEvent({ id: session }, turnEnd(1))
  assert.equal(await wait(() => transport.sent.length === 3), true)
  assert.deepEqual(
    transport.sent.map((x) => x.segments[0].data.text),
    ['第一块', '第二块', '第三块'],
  )
  await bridge.stop()
})

test('出站：块外文字不发、空块忽略，只发非空块', async () => {
  const { bridge, transport } = makeBridge()
  await bridge.start({ syncNow: false })
  bridge.noteInboundSource(session, 'qq', QQ)
  bridge.onSessionEvent({ id: session }, assistantStep(1, 1, [{ type: 'text', text: '草稿 [MSG]第一块[/MSG] [MSG]   [/MSG] 中间 [MSG]第二块[/MSG] 尾巴' }]))
  bridge.onSessionEvent({ id: session }, turnEnd(1))
  assert.equal(await wait(() => transport.sent.length === 2), true)
  await sleep(60)
  assert.deepEqual(transport.sent.map((x) => x.segments[0].data.text), ['第一块', '第二块'])
  await bridge.stop()
})

test('出站：块内文字与 [图片] 按出现顺序发，下一块另起消息', async () => {
  const dir = tempDir()
  const image = join(dir, 'block.png')
  writeFileSync(image, 'fake-png')
  const { bridge, transport } = makeBridge({ dir })
  await bridge.start({ syncNow: false })
  await bridge.deliverAssistantTurn(session, `[MSG]看图 [图片:${image}] 好看[/MSG][MSG]第二块[/MSG]`, [], QQ_SOURCE)
  assert.equal(transport.sent.length, 4)
  assert.deepEqual(transport.sent.map((x) => x.segments[0].type), ['text', 'image', 'text', 'text'])
  assert.equal(transport.sent[0].segments[0].data.text, '看图')
  assert.equal(transport.sent[2].segments[0].data.text, '好看')
  assert.equal(transport.sent[3].segments[0].data.text, '第二块')
  await bridge.stop()
})

test('出站：同一条 assistant/message 重复投递只发一遍', async () => {
  const { bridge, transport } = makeBridge()
  await bridge.start({ syncNow: false })
  bridge.noteInboundSource(session, 'qq', QQ)
  const event = assistantStep(1, 1, [{ type: 'text', text: '[MSG]只发这一遍[/MSG]' }])
  bridge.onSessionEvent({ id: session }, event)
  bridge.onSessionEvent({ id: session }, event)
  bridge.onSessionEvent({ id: session }, turnEnd(1))
  assert.equal(await wait(() => transport.sent.length === 1), true)
  await sleep(60)
  assert.equal(transport.sent.length, 1)
  await bridge.stop()
})

test('出站：某步只写了 [MSG] 没写 [/MSG]，不会把下一步的内部文字粘进来', async () => {
  const { bridge, transport } = makeBridge()
  await bridge.start({ syncNow: false })
  bridge.noteInboundSource(session, 'qq', QQ)
  bridge.onSessionEvent({ id: session }, assistantStep(1, 1, [{ type: 'text', text: '[MSG]只发这句' }]))
  bridge.onSessionEvent({ id: session }, assistantStep(1, 2, [{ type: 'text', text: '这段是内部草稿，不外发' }]))
  bridge.onSessionEvent({ id: session }, turnEnd(1))
  assert.equal(await wait(() => transport.sent.length === 1), true)
  assert.deepEqual(transport.sent[0].segments, [{ type: 'text', data: { text: '只发这句' } }])
  await bridge.stop()
})

test('出站：回合被中断时，已累积的 [MSG] 不发送', async () => {
  const { bridge, transport } = makeBridge()
  await bridge.start({ syncNow: false })
  bridge.onSessionEvent({ id: session }, assistantStep(1, 1, [{ type: 'text', text: '[MSG]写到一半的话[/MSG]' }]))
  bridge.onSessionEvent({ id: session }, {
    type: 'assistant/message',
    data: { turn: 1, step: 2, interrupted: true, message: { id: 'message-1-2', content: [{ type: 'text', text: '半句话' }] } },
  })
  bridge.onSessionEvent({ id: session }, turnEnd(1))
  await sleep(80)
  assert.equal(transport.sent.length, 0)
  await bridge.stop()
})

test('出站：同一张图跨模型步只发一次', async () => {
  const dir = tempDir()
  const image = join(dir, 'a.png')
  writeFileSync(image, 'fake-png')
  const { bridge, transport, delivery } = makeBridge({ dir })
  delivery.attachmentPath = async () => image
  await bridge.start({ syncNow: false })
  bridge.noteInboundSource(session, 'qq', QQ)
  const imageBlock = { type: 'image', attachment: { attachmentId: 'sha-image-a', mediaType: 'image/png', bytes: 9, width: 1, height: 1 } }
  bridge.onSessionEvent({ id: session }, assistantStep(1, 1, [imageBlock]))
  bridge.onSessionEvent({ id: session }, assistantStep(1, 2, [{ type: 'text', text: '[MSG]看图[/MSG]' }, imageBlock]))
  bridge.onSessionEvent({ id: session }, turnEnd(1))
  assert.equal(await wait(() => transport.sent.length === 2), true)
  await sleep(60)
  assert.equal(transport.sent.length, 2, '文字一条、图片一条，图片不重复')
  assert.equal(transport.sent[0].segments[0].data.text, '看图')
  assert.equal(transport.sent[1].segments[0].type, 'image')
  await bridge.stop()
})

test('语音发送：失败后自动重试，第三次成功', async () => {
  const dir = tempDir()
  const audio = join(dir, 'a.wav')
  writeFileSync(audio, Buffer.from('RIFFxxxxWAVE'))
  const { bridge, transport } = makeBridge({ dir })
  await bridge.start({ syncNow: false })
  let times = 0
  const original = transport.sendMessage.bind(transport)
  transport.sendMessage = async (peer, segments) => {
    times++
    if (times < 3) throw new Error('模拟失败')
    return original(peer, segments)
  }
  const r = await bridge.sendRecordWithRetry(QQ, audio, '测试语音')
  assert.equal(times, 3)
  assert.equal(r.ok, true)
  await bridge.stop()
})

test('状态：已处理 id 持久化并有限长度', () => {
  const dir = tempDir()
  const s = new StateStore({ homeDir: dir })
  for (let i = 0; i < 5; i++) s.markSeen(`id-${i}`)
  s.save()
  const s2 = new StateStore({ homeDir: dir })
  assert.equal(s2.hasSeen('id-0'), true)
  assert.equal(s2.hasSeen('id-4'), true)
  assert.equal(s2.snapshot().seen.length, 5)
})

test('状态：旧的「语音文件不存在：路径」读回时改成占位符说明', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'fish-message-state.json'), JSON.stringify({
    version: 1,
    stats: { lastError: '语音文件不存在：路径', outboxLastError: '语音文件不存在：路径' },
  }), 'utf8')
  const s = new StateStore({ homeDir: dir })
  const snapshot = s.snapshot()
  assert.match(snapshot.stats.lastError, /占位符/)
  assert.ok(snapshot.stats.lastError.includes('「路径」'))
  assert.match(snapshot.stats.outboxLastError, /占位符/)
  assert.doesNotMatch(snapshot.stats.lastError, /^语音文件不存在：路径$/)
})

test('旧桥状态迁移：只读旧文件，搬水位和已转 id', () => {
  const dir = tempDir()
  const prev = join(dir, 'qq-bridge-state.json')
  writeFileSync(prev, JSON.stringify({ 上次: { [`私聊:${QQ}`]: 1700000000 }, 已转: [111, 222] }), 'utf8')
  const s = new StateStore({ homeDir: dir, legacyStatePath: prev })
  const r = s.migrateLegacy(QQ)
  assert.equal(r.timestamp, 1700000000)
  assert.equal(r.ids, 2)
  assert.equal(s.getWatermark(QQ).timestamp, 1700000000)
  assert.equal(s.hasSeen('111'), true)
  assert.ok(existsSync(prev), '旧桥文件必须保留')
})

test('配置：派生 WS 地址、旧桥字段迁移、范围钳制', () => {
  assert.equal(deriveWsUrl('http://127.0.0.1:3000/'), 'ws://127.0.0.1:3000')
  const prev = migrateLegacyConfig({
    NapCat: 'http://127.0.0.1:3000',
    绑定: [{ 类型: '私聊', 号码: '1696117435', 会话: 'session-a', 称呼: '主人' }],
    只发标记内: true,
    补投窗口分: 10,
  })
  assert.equal(prev.bindings.length, 1)
  assert.equal(prev.bindings[0].qq, '1696117435')
  assert.equal(prev.backfillWindowHours, 24, '迁移时至少给 24 小时')
  const clamp = normalizeConfig({ pollIntervalMs: 10, historyCount: 9999, logLevel: '怪' })
  assert.equal(clamp.pollIntervalMs, 500)
  assert.equal(clamp.historyCount, 500)
  assert.equal(clamp.logLevel, 'info')
})

test('配置：渠道可以不绑定会话，同对端去重、同会话可多条', () => {
  const cfg = normalizeConfig({
    bindings: [
      { qq: '10001', session: '', name: '主人' },
      { qq: '10001', session: 'session-a' },
      { qq: '10002', session: 'session-a' },
      { qq: '10003', session: '' },
      { qq: '10004', session: 'session-b' },
      { qq: '10005', session: 'session-b' },
      { qq: '', session: '' },
    ],
  })
  // 同一对端重复只留第一条；同一间会话挂多条是正常用法，不再按会话去重。
  assert.deepEqual(cfg.bindings.map((b) => [b.qq, b.session, b.enabled]), [
    ['10001', '', true],
    ['10002', 'session-a', true],
    ['10003', '', true],
    ['10004', 'session-b', true],
    ['10005', 'session-b', true],
  ])

  // 保存后读回：空 session 的渠道保留，不会被当成坏配置丢掉。
  const dir = tempDir()
  const saved = new ConfigStore({ homeDir: dir }).save({ bindings: [{ qq: QQ, session: '', name: '主人', enabled: true }] })
  assert.equal(saved.bindings.length, 1)
  assert.equal(saved.bindings[0].session, '')
  const read = new ConfigStore({ homeDir: dir }).load({})
  assert.equal(read.bindings.length, 1)
  assert.equal(read.bindings[0].session, '')
  assert.equal(publicConfig(read).bindings[0].session, '')
})

// ---------------- 可选本地 AI：语音/识图能力与降级 ----------------

test('入站语音：只落盘并递「语音：路径」，不联网、不转写', async () => {
  const dir = tempDir()
  const raw = join(dir, 'from-qq.wav')
  writeFileSync(raw, makeWav(2))

  class voiceTransport extends fakeTransport {
    constructor(localFile) { super(); this.localFile = localFile; this.getRecordCount = 0; this.downloadCount = 0 }
    async getRecord() { this.getRecordCount++; return { file: this.localFile } }
    async download() { this.downloadCount++; throw new Error('不应该下载') }
  }

  const transport = new voiceTransport(raw)
  const logger = new Logger({ filePath: join(dir, 'test.log'), level: 'debug' })
  const voice = new VoiceService({
    getConfig: () => normalizeConfig({ maxVoiceMB: 20 }),
    logger,
    transport,
    inboxDir: join(dir, 'inbox'),
  })
  const cfg = normalizeConfig({
    bindings: [{ qq: QQ, session: session, name: '主人', enabled: true }],
    reorderBufferMs: 0,
  })
  const bridge = new Bridge({
    getConfig: () => cfg,
    transport,
    store: new StateStore({ homeDir: dir }),
    logger,
    voice,
    delivery: new fakeDeliver(),
    autoTimers: false,
  })

  // 只要调用了 fetch 就算联网；这条链路必须一次都不调。
  let networkCall = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { networkCall++; throw new Error('解耦后入站语音不该联网') }
  try {
    const content = await bridge.buildInbound(
      { qq: QQ, name: '主人' },
      { message_id: 'm-voice-1', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
    )
    assert.equal(networkCall, 0, '入站语音不能调 ASR / to_wav 等网络接口')
    assert.equal(transport.getRecordCount, 1, '只问 get_record 要 wav')
    assert.equal(transport.downloadCount, 0)
    assert.match(content.text, /（语音：.+\.wav，2 秒）/)
    assert.ok(!content.text.includes('转写'), '不能再出现转写文字')
    assert.ok(!content.text.includes('说话人'), '不能出现依赖服务端身份的说话人')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('出站 [语音]文本[/语音]：没装本地 AI 时只提示，不发任何消息', async () => {
  const { bridge, transport } = makeBridge()
  const result = await bridge.deliverAssistantTurn(session, '[MSG][语音]晚安，主人[/语音][/MSG]', [], QQ_SOURCE)
  assert.equal(transport.sent.length, 0, '不能合成、也不能发任何消息')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'service_not_installed')
  assert.equal(result.tts, false)
  assert.match(result.hint, /本地 AI 插件没装或没启动/)
  assert.match(result.hint, /其它功能不受影响/)
})

test('出站 [语音]文本[/语音] 与文字混排：文字照发，语音只提示', async () => {
  const { bridge, transport, delivery } = makeBridge()
  const result = await bridge.deliverAssistantTurn(session, '[MSG]先听这个 [语音]晚安[/语音][/MSG]', [], QQ_SOURCE)
  assert.equal(transport.sent.length, 1)
  assert.deepEqual(transport.sent[0].segments, [{ type: 'text', data: { text: '先听这个' } }])
  assert.equal(result.code, 'service_not_installed')
  assert.equal(delivery.got.length, 1, '语音失败要在会话里留一句提示，不能只写日志')
  assert.match(delivery.got[0].text, /本地 AI 插件没装或没启动/)
})

test('出站 [语音]文本[/语音]：本地 AI 正常时按配置音色/语速合成并发送 wavPath', async () => {
  const dir = tempDir()
  const audio = join(dir, 'tts.wav')
  writeFileSync(audio, makeWav(0.2))
  const service = new fakeService()
  service.output = audio
  const { bridge, transport } = makeBridge({ dir, ai: buildAi(service) })
  const result = await bridge.deliverAssistantTurn(session, '[MSG][语音]晚安，主人[/语音][/MSG]', [], QQ_SOURCE)
  assert.equal(result.ok, true)
  assert.equal(transport.sent.length, 1)
  assert.equal(transport.sent[0].segments[0].type, 'record')
  assert.equal(transport.sent[0].segments[0].data.file, audio.replace(/\\/g, '/'))
  assert.deepEqual(service.calls.tts, [{ text: '晚安，主人', opts: { voice: 'dafeiyu', speed: 1 } }])
})

test('出站 [语音]文本[/语音]：长文本合成多段后按顺序发多条语音', async () => {
  const dir = tempDir()
  const audios = ['tts-1.wav', 'tts-2.wav'].map((name) => join(dir, name))
  for (const path of audios) writeFileSync(path, makeWav(0.2))
  const service = new fakeService()
  let count = 0
  service.tts = async (text, opts) => {
    service.calls.tts.push({ text, opts })
    return { ok: true, items: [{ wavPath: audios[count++], voice: opts?.voice }] }
  }
  const sentence = '一'.repeat(98) + '。'
  const { bridge, transport } = makeBridge({ dir, ai: buildAi(service) })
  const result = await bridge.deliverAssistantTurn(session, '[MSG][语音]' + sentence.repeat(3) + '[/语音][/MSG]', [], QQ_SOURCE)
  assert.equal(result.ok, true)
  assert.equal(service.calls.tts.length, 2)
  assert.equal(transport.sent.length, 2, '两段语音应各发一条，且保持顺序')
  assert.equal(transport.sent[0].segments[0].data.file, audios[0].replace(/\\/g, '/'))
  assert.equal(transport.sent[1].segments[0].data.file, audios[1].replace(/\\/g, '/'))
  assert.equal(service.calls.tts.map((invoke) => invoke.text).join(''), sentence.repeat(3))
})

test('出站语音：服务在但 tts 能力关时降级提示，不抛错', async () => {
  const service = new fakeService({ ttsOk: false, caps: { tts: { available: false, reason: 'model_missing' } } })
  const { bridge, transport } = makeBridge({ ai: buildAi(service) })
  const result = await bridge.deliverAssistantTurn(session, '[MSG][语音]晚安[/语音][/MSG]', [], QQ_SOURCE)
  assert.equal(transport.sent.length, 0)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'model_missing')
  assert.match(result.hint, /模型还没准备好/)
})

test('入站语音：本地 AI 正常时把转写写进同一行路径消息', async () => {
  const dir = tempDir()
  const service = new fakeService({ asrText: '今晚早点睡' })
  const bridge = buildVoiceBridge(dir, service)
  const content = await bridge.buildInbound(
    { qq: QQ, name: '主人' },
    { message_id: 'm-voice-2', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
  )
  assert.match(content.text, /^（语音：.+\.wav，2 秒；转写：今晚早点睡）$/)
  assert.deepEqual(service.calls.asr, [{ path: content.text.match(/（语音：(.+?)，/)[1], opts: { language: 'auto' } }])
})

test('入站语音：转写为空时只留路径和时长', async () => {
  const dir = tempDir()
  const service = new fakeService({ asrText: '' })
  const bridge = buildVoiceBridge(dir, service)
  const content = await bridge.buildInbound(
    { qq: QQ, name: '主人' },
    { message_id: 'm-voice-3', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
  )
  assert.match(content.text, /^（语音：.+\.wav，2 秒）$/)
})

test('入站语音：情感和背景音写在同一行，转写仍在最后', async () => {
  const dir = tempDir()
  const service = new fakeService({
    asrText: '你终于回来了',
    emotion: 'HAPPY',
    events: ['Speech', '[Laughter]'],
  })
  const bridge = buildVoiceBridge(dir, service)
  const content = await bridge.buildInbound(
    { qq: QQ, name: '主人' },
    { message_id: 'm-voice-4', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
  )
  assert.match(content.text, /^（语音：.+\.wav，2 秒；情感：开心；背景：笑声；转写：你终于回来了）$/)
})

test('入站语音：事件只有 Speech 时只写情感和转写', async () => {
  const dir = tempDir()
  const service = new fakeService({ asrText: '晚安', emotion: 'NEUTRAL', events: ['Speech'] })
  const bridge = buildVoiceBridge(dir, service)
  const content = await bridge.buildInbound(
    { qq: QQ, name: '主人' },
    { message_id: 'm-voice-5', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
  )
  assert.match(content.text, /^（语音：.+\.wav，2 秒；情感：中性；转写：晚安）$/)
  assert.doesNotMatch(content.text, /背景|undefined|null/)
})

test('入站语音：未知情绪、events 为空时退回只有转写的样子', async () => {
  const dir = tempDir()
  const service = new fakeService({ asrText: '晚安', emotion: 'BORED', events: [] })
  const bridge = buildVoiceBridge(dir, service)
  const content = await bridge.buildInbound(
    { qq: QQ, name: '主人' },
    { message_id: 'm-voice-6', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
  )
  assert.match(content.text, /，2 秒；转写：晚安）$/)
  assert.doesNotMatch(content.text, /情感|背景|undefined|null/)
})

test('入站语音：多个事件只挑一个背景音', async () => {
  const dir = tempDir()
  const service = new fakeService({
    emotion: 'FEARFUL',
    events: ['Music', '[Applause]', '[Laughter]'],
  })
  const bridge = buildVoiceBridge(dir, service)
  const content = await bridge.buildInbound(
    { qq: QQ, name: '主人' },
    { message_id: 'm-voice-7', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
  )
  assert.match(content.text, /，2 秒；情感：害怕；背景：笑声）$/)
})

test('入站语音：旧版服务没 emotion/events 时消息保持原样，不出现 undefined/null', async () => {
  const dir = tempDir()
  const service = new fakeService({ asrText: '晚安' })
  const bridge = buildVoiceBridge(dir, service)
  const content = await bridge.buildInbound(
    { qq: QQ, name: '主人' },
    { message_id: 'm-voice-8', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
  )
  assert.match(content.text, /^（语音：.+\.wav，2 秒；转写：晚安）$/)
  assert.doesNotMatch(content.text, /情感|背景|undefined|null/)
})

test('入站图片：开关开且识图可用时，用描述 + 路径代替 base64 图片', async () => {
  const dir = tempDir()
  const service = new fakeService({ describeText: '一只橘猫趴在键盘上' })
  const { bridge, image } = makeImageBridge(dir, service, { describeInboundImages: 'on' })
  const content = await bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-img-1'))
  assert.equal(content.images.length, 0, '识图后不再塞 base64 图片进会话')
  assert.match(content.text, /（图片：一只橘猫趴在键盘上；已存到 .+qq\.png）/)
  assert.match(content.text, /收到 1 张图片/)
  assert.deepEqual(service.calls.vision, [{ path: image, opts: { mode: 'caption', prompt: defaultImagePrompt } }])
})

test('入站图片：自定义识图提示词作为 prompt 传给本地 AI', async () => {
  const dir = tempDir()
  const service = new fakeService({ describeText: '一只猫' })
  const { bridge, image } = makeImageBridge(dir, service, {
    describeInboundImages: 'on',
    inboundImagePrompt: '看看这张表情包是什么梗',
  })
  await bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-img-prompt'))
  assert.deepEqual(service.calls.vision, [{
    path: image,
    opts: { mode: 'caption', prompt: '看看这张表情包是什么梗' },
  }])
})

test('入站图片：提示词留空时用内置默认，识图失败仍退回图片附件', async () => {
  const dir = tempDir()
  const service = new fakeService({ describeText: '一只猫' })
  const { bridge } = makeImageBridge(dir, service, { describeInboundImages: 'on' })
  const content = await bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-img-prompt-default'))
  assert.equal(service.calls.vision[0].opts.prompt, defaultImagePrompt, '留空时用内置默认')
  assert.equal(content.images.length, 0)

  // 提示词是自定义的也一样：识图不可用时只影响文字，不改变降级路径。
  const badDir = tempDir()
  const badService = new fakeService()
  badService.visionDescribe = async (path, opts) => {
    badService.calls.vision.push({ path, opts })
    return { ok: false, code: 'busy', hint: '本地 AI 正忙' }
  }
  const { bridge: badBridge } = makeImageBridge(badDir, badService, {
    describeInboundImages: 'on',
    inboundImagePrompt: '自定义提示',
  })
  const badContent = await badBridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-img-prompt-fail'))
  assert.equal(badService.calls.vision[0].opts.prompt, '自定义提示')
  assert.equal(badContent.images.length, 1)
  assert.match(badContent.text, /\[图片\]/)
})

test('入站图片：开关关时保持原样，图片附件和路径都在', async () => {
  const dir = tempDir()
  const service = new fakeService({ describeText: '不应该被调用' })
  const { bridge } = makeImageBridge(dir, service, { describeInboundImages: 'off' })
  const content = await bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-img-2'))
  assert.equal(content.images.length, 1)
  assert.equal(content.images[0].base64, 'ZmFrZQ==')
  assert.match(content.text, /\[图片\]/)
  assert.equal(service.calls.vision.length, 0)
  assert.equal(service.calls.prefs, 0, '强制关时不必问插件偏好')
})

test('入站图片：继承时跟随本地 AI 插件的识图开关', async () => {
  const closeDir = tempDir()
  const closeService = new fakeService({ describeText: '不该出现', visionPrefs: { localDescribe: false } })
  const closeBridge = makeImageBridge(closeDir, closeService).bridge
  const closeContent = await closeBridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-img-3'))
  assert.equal(closeService.calls.prefs, 1)
  assert.equal(closeService.calls.vision.length, 0)
  assert.equal(closeContent.images.length, 1, '插件关着识图时图片照常递附件')

  const openDir = tempDir()
  const openService = new fakeService({ describeText: '一只猫', visionPrefs: { localDescribe: true } })
  const openContent = await makeImageBridge(openDir, openService).bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-img-4'))
  assert.equal(openService.calls.vision.length, 1)
  assert.match(openContent.text, /（图片：一只猫；已存到 /)
})

test('入站图片：on/off 覆盖插件开关；拿不到偏好时继承按开', async () => {
  const oneDir = tempDir()
  const firstService = new fakeService({ describeText: '一只猫', visionPrefs: { localDescribe: false } })
  await makeImageBridge(oneDir, firstService, { describeInboundImages: 'on' }).bridge
    .buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-img-5'))
  assert.equal(firstService.calls.vision.length, 1, '选「开」时不看插件偏好')

  const twoDir = tempDir()
  const secondService = new fakeService({ describeText: '一只猫', visionPrefs: { localDescribe: true } })
  await makeImageBridge(twoDir, secondService, { describeInboundImages: 'off' }).bridge
    .buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-img-6'))
  assert.equal(secondService.calls.vision.length, 0, '选「关」时不看插件偏好')

  // 插件还没有 visionPrefs（本轮契约刚加）：当 unknown，按「开」处理。
  const threeDir = tempDir()
  const thirdService = new fakeService({ describeText: '一只猫' })
  const threeContent = await makeImageBridge(threeDir, thirdService).bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-img-7'))
  assert.equal(thirdService.calls.prefs, 1)
  assert.equal(thirdService.calls.vision.length, 1)
  assert.match(threeContent.text, /（图片：一只猫/)
})

test('入站图片：识图失败时退回图片附件，不丢图', async () => {
  const dir = tempDir()
  const service = new fakeService({ visionPrefs: { localDescribe: true } })
  service.visionDescribe = async () => ({ ok: false, code: 'busy', hint: '本地 AI 正忙' })
  const { bridge } = makeImageBridge(dir, service)
  const content = await bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-img-8'))
  assert.equal(content.images.length, 1)
  assert.match(content.text, /\[图片\]/)
})

test('入站图片：没有本地 AI 插件时按原样递图', async () => {
  const dir = tempDir()
  const { bridge } = makeImageBridge(dir, null)
  const content = await bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-img-9'))
  assert.equal(content.images.length, 1)
  assert.match(content.text, /\[图片\]/)
})

test('出站 [语音:路径]：照常发已有音频文件，不合成', async () => {
  const dir = tempDir()
  const audio = join(dir, 'a.wav')
  writeFileSync(audio, makeWav(0.2))
  const { bridge, transport } = makeBridge({ dir })
  const result = await bridge.deliverAssistantTurn(session, `[MSG][语音:${audio}][/MSG]`, [], QQ_SOURCE)
  assert.equal(result.ok, true)
  assert.equal(transport.sent.length, 1)
  assert.equal(transport.sent[0].segments[0].type, 'record')
  assert.equal(transport.sent[0].segments[0].data.file, audio.replace(/\\/g, '/'))
})

test('旧配置：布尔识图开关迁移成三态（true→on，false→off，缺失→inherit）', () => {
  const read = (content) => {
    const dir = tempDir()
    writeFileSync(join(dir, 'fish-message-config.json'), JSON.stringify(content), 'utf8')
    return new ConfigStore({ homeDir: dir }).load({})
  }
  assert.equal(read({ describeInboundImages: true }).describeInboundImages, 'on')
  assert.equal(read({ describeInboundImages: false }).describeInboundImages, 'off')
  assert.equal(read({}).describeInboundImages, 'inherit')
  // 已经是三态的配置原样读回
  assert.equal(read({ describeInboundImages: 'off' }).describeInboundImages, 'off')

  // 新增的识图提示词：旧配置缺字段 → 补空串（用内置默认）；非法值也回退默认。
  assert.equal(read({}).inboundImagePrompt, '')
  assert.equal(read({ inboundImagePrompt: 123 }).inboundImagePrompt, '')
  assert.equal(read({ inboundImagePrompt: '长'.repeat(4001) }).inboundImagePrompt, '')
  assert.equal(read({ inboundImagePrompt: '  自定义提示  ' }).inboundImagePrompt, '自定义提示')
})

test('旧配置：残留的 ASR/TTS 字段被静默忽略并从落盘文件清理', () => {
  const dir = tempDir()
  const file = join(dir, 'fish-message-config.json')
  writeFileSync(file, JSON.stringify({
    napcatBaseUrl: 'http://127.0.0.1:3000',
    bindings: [{ qq: QQ, session: session, name: '主人', enabled: true }],
    transcriptionEnabled: false,
    asrBaseUrl: 'http://127.0.0.1:9999',
    asrCommand: 'python asr.py "{file}"',
    asrTimeoutMs: 1,
    ttsEnabled: false,
    ttsBaseUrl: 'http://127.0.0.1:9999',
    ttsVoice: '旧音色',
    ttsTimeoutMs: 1,
  }), 'utf8')

  const cfg = new ConfigStore({ homeDir: dir }).load({})
  for (const key of removedVoiceFields) assert.equal(key in cfg, false, `内存配置不应再有 ${key}`)
  assert.equal(cfg.napcatBaseUrl, 'http://127.0.0.1:3000')
  assert.equal(cfg.bindings.length, 1)

  // 加载时静默清理：文件还在，但旧键没了，其它设置原样保留。
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  for (const key of removedVoiceFields) assert.equal(key in disk, false, `落盘配置不应再有 ${key}`)
  assert.equal(disk.bindings[0].qq, QQ)

  // 外部命令等旧键即使通过插件配置传进来，也只是被忽略，不报错。
  const readAgain = new ConfigStore({ homeDir: tempDir() }).load({ ttsVoice: 'x', asrCommand: 'y' })
  assert.equal('ttsVoice' in readAgain, false)
  assert.equal('asrCommand' in readAgain, false)
})

// ---------------- 暂停转发：待转发队列 ----------------

test('暂停转发：消息照常接收并记统计，但一条都不投进会话', async () => {
  const now = Math.floor(Date.now() / 1000)
  const { dir, bridge, delivery, transport, cfg, store } = makeBridge()
  cfg.forwardPaused = true
  bridge.updateConfig()
  await bridge.start({ syncNow: false })
  for (const [i, str] of ['暂停一', '暂停二', '暂停三'].entries()) {
    transport.emit({ post_type: 'message', message_type: 'private', ...makeMessage(60 + i, str, now - 10 + i) })
  }
  await sleep(120)

  assert.equal(delivery.got.length, 0, '暂停期间不能投进 DSH 会话')
  const state = bridge.state()
  assert.equal(state.forward.paused, true)
  assert.equal(state.forward.pending, 3)
  assert.equal(state.stats.received, 3, '统计照常记「已收到」')
  assert.equal(state.stats.delivered, 0, '暂停期间不算「已转达」')
  assert.ok(store.getWatermark(QQ).timestamp >= now - 10, '水位照常推进，不会重复收')
  assert.equal(new ForwardQueue({ homeDir: dir }).pending(), 3, '待转发队列要落盘')
  await bridge.stop()
})

test('恢复转发：暂停期间的 3 条按原顺序补发，不重复', async () => {
  const now = Math.floor(Date.now() / 1000)
  const { bridge, delivery, transport, cfg } = makeBridge()
  cfg.forwardPaused = true
  bridge.updateConfig()
  await bridge.start({ syncNow: false })
  for (const [i, str] of ['第一', '第二', '第三'].entries()) {
    transport.emit({ post_type: 'message', message_type: 'private', ...makeMessage(70 + i, str, now - 10 + i) })
  }
  await sleep(120)
  assert.equal(delivery.got.length, 0)

  cfg.forwardPaused = false
  bridge.updateConfig()
  assert.equal(await wait(() => delivery.got.length === 3), true, '恢复后应自动补发')
  assert.deepEqual(delivery.got.map((x) => x.text), ['第一', '第二', '第三'])
  assert.equal(bridge.state().forward.pending, 0)
  assert.equal(bridge.state().stats.delivered, 3)

  // 再补一次不会重复
  await bridge.flushForwardQueue('again')
  await sleep(30)
  assert.equal(delivery.got.length, 3, '补发过的消息不能再来一次')
  await bridge.stop()
})

test('暂停时重启：待转发队列从磁盘读回，恢复后照常补发', async () => {
  const now = Math.floor(Date.now() / 1000)
  const dir = tempDir()
  const first = makeBridge({ dir, config: { forwardPaused: true } })
  await first.bridge.start({ syncNow: false })
  for (const [i, str] of ['重启一', '重启二', '重启三'].entries()) {
    first.transport.emit({ post_type: 'message', message_type: 'private', ...makeMessage(80 + i, str, now - 10 + i) })
  }
  await sleep(120)
  assert.equal(first.bridge.state().forward.pending, 3)
  assert.equal(first.delivery.got.length, 0)
  await first.bridge.stop()

  // 新实例用同一个目录（同一个状态文件），暂停标记还在。
  const secondApp = makeBridge({ dir, config: { forwardPaused: true } })
  assert.equal(secondApp.bridge.state().forward.pending, 3, '重启后待转发队列还在')
  await secondApp.bridge.start({ syncNow: false })
  assert.equal(secondApp.delivery.got.length, 0, '还在暂停，不补发')

  secondApp.cfg.forwardPaused = false
  secondApp.bridge.updateConfig()
  assert.equal(await wait(() => secondApp.delivery.got.length === 3), true)
  assert.deepEqual(secondApp.delivery.got.map((x) => x.text), ['重启一', '重启二', '重启三'])
  await secondApp.bridge.stop()
})

test('待转发消息过期：恢复时不补发，只提示一句数量', async () => {
  const now = Math.floor(Date.now() / 1000)
  const dir = tempDir()
  const forwardQueue = new ForwardQueue({ homeDir: dir, ttlMs: 30 })
  const { bridge, delivery, transport, cfg } = makeBridge({ dir, forwardQueue })
  cfg.forwardPaused = true
  bridge.updateConfig()
  await bridge.start({ syncNow: false })
  for (const [i, str] of ['过期一', '过期二', '过期三'].entries()) {
    transport.emit({ post_type: 'message', message_type: 'private', ...makeMessage(90 + i, str, now - 10 + i) })
  }
  await sleep(150)

  cfg.forwardPaused = false
  bridge.updateConfig()
  assert.equal(await wait(() => delivery.got.length >= 1), true)
  await sleep(60)
  assert.equal(delivery.got.length, 1, '过期消息不补发，只发一条提示')
  assert.match(delivery.got[0].text, /3 条/)
  assert.match(delivery.got[0].text, /过期|保留时间/)
  assert.equal(bridge.state().forward.pending, 0)
  assert.equal(bridge.state().stats.delivered, 0, '过期丢弃的不算已转达')
  await bridge.stop()
})

test('暂停转发：配置默认关，保存后能读回', () => {
  assert.equal(normalizeConfig({}).forwardPaused, false)
  assert.equal(normalizeConfig({ forwardPaused: true }).forwardPaused, true)
  assert.equal(normalizeConfig({ forwardPaused: 'true' }).forwardPaused, true)
  assert.equal(normalizeConfig({ forwardPaused: 0 }).forwardPaused, false)

  const dir = tempDir()
  const save = new ConfigStore({ homeDir: dir }).save({ forwardPaused: true, bindings: [] })
  assert.equal(save.forwardPaused, true)
  assert.equal(new ConfigStore({ homeDir: dir }).load({}).forwardPaused, true)
  assert.equal(publicConfig({ forwardPaused: true }).forwardPaused, true)
})

test('防失联：配置默认开启，时长钳制，保存后能读回', () => {
  assert.equal(normalizeConfig({}).guardEnabled, true)
  assert.equal(normalizeConfig({ guardEnabled: false }).guardEnabled, false)
  assert.equal('guardQqFallback' in normalizeConfig({}), false, 'QQ 兜底已移除')
  assert.equal(normalizeConfig({}).guardStuckSeconds, 600)
  assert.equal(normalizeConfig({ guardStuckSeconds: 30 }).guardStuckSeconds, 30)
  assert.equal(normalizeConfig({ guardStuckSeconds: 0 }).guardStuckSeconds, 1, '太小钳到 1 秒')
  assert.equal(normalizeConfig({ guardStuckSeconds: 99999 }).guardStuckSeconds, 7200, '太大钳到 7200 秒')
  assert.equal(normalizeConfig({ guardStuckMinutes: 5 }).guardStuckSeconds, 300, '旧配置的分钟换算成秒')
  assert.equal('guardStuckMinutes' in normalizeConfig({ guardStuckMinutes: 5 }), false, '不再写回分钟字段')

  const dir = tempDir()
  const save = new ConfigStore({ homeDir: dir }).save({
    guardEnabled: false, guardStuckSeconds: 1500, guardQqFallback: true, bindings: [],
  })
  assert.equal(save.guardEnabled, false)
  assert.equal(save.guardStuckSeconds, 1500)
  assert.equal('guardQqFallback' in save, false, '旧字段不会写回')
  const readRespond = new ConfigStore({ homeDir: dir }).load({})
  assert.equal(readRespond.guardEnabled, false)
  assert.equal('guardQqFallback' in readRespond, false)
  assert.equal(publicConfig({ guardEnabled: false }).guardEnabled, false)
})

/** 防失联测试用：可控时钟 + 一个绑定会话。 */
function makeMonitor(cfg = { guardStuckSeconds: 600 }) {
  const clock = { now: 1_000_000 }
  const monitor = new GuardMonitor({ now: () => clock.now, getConfig: () => cfg })
  // 标题表按会话 id（去掉 session- 前缀）索引，和 GuardMonitor 内部一致。
  monitor.setBindings([{ qq: QQ, session: session, name: '主人', enabled: true }], new Map([['test-0001', '测试会话']]))
  return { clock, monitor, cfg }
}

/** 过完回合判定的宽限，再跳一次心跳：把延后的「发没发 QQ」判定推到出结果。 */
function pastGrace(clock, monitor) {
  clock.now += turnGraceMs + 1
  return monitor.tick()
}

/**
 * 走一个完整回合：turn/start → 若干工具步（每个模型步一条 assistant/message）→ turn/end，
 * 再走完宽限，把心跳给出的判定结果一起返回。
 * 发QQ 为真时在回合中间模拟一次 QQ 出站。
 */
function runOneTurn(clock, monitor, turn, { toolSteps = 1, sendQq = false } = {}) {
  monitor.handleEvent(session, { type: 'turn/start', data: { turn } })
  for (let i = 0; i < toolSteps; i += 1) {
    monitor.handleEvent(session, { type: 'assistant/message', data: { turn, step: i + 1 } })
  }
  if (sendQq) monitor.noteQqOutbound(QQ)
  const actions = monitor.handleEvent(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  return [...actions, ...pastGrace(clock, monitor)]
}

test('防失联监控：超时只塞一次，之后不再打扰', () => {
  const { clock, monitor } = makeMonitor()
  monitor.trackStatus(session, 'running')
  assert.equal(monitor.isBinding(session), true, '原样会话 id 能认出来')
  assert.equal(monitor.isBinding('test-0001'), true, '去掉 session- 前缀也能认出来')

  // 9 分钟：还没到阈值。
  clock.now += 9 * 60000
  assert.deepEqual(monitor.tick(), [])

  // 11 分钟：第一条提醒（也是这一轮唯一的一条）。
  clock.now += 2 * 60000
  const firstRun = monitor.tick()
  assert.equal(firstRun.length, 1)
  assert.equal(firstRun[0].kind, 'remind')
  assert.equal(firstRun[0].text, defaultLongTaskReminder, '默认长任务提醒文案原文')

  // 之后不管多久都不再塞：塞进去也只是排队，等模型跑完还要多花时间处理。
  clock.now += 9 * 60000
  assert.deepEqual(monitor.tick(), [])
  clock.now += 30 * 60000
  assert.deepEqual(monitor.tick(), [])
  clock.now += 60 * 60000
  assert.deepEqual(monitor.tick(), [])

  const snapshot = monitor.snapshot()
  assert.equal(snapshot.bound, 1)
  assert.equal(snapshot.alerts.length, 1)
  assert.equal(snapshot.alerts[0].title, '测试会话')
  assert.equal(snapshot.alerts[0].injections, 1)
})

test('防失联监控：提醒进入会话后才重新计时，QQ 出站不能代替', () => {
  const { clock, monitor } = makeMonitor()
  monitor.trackStatus(session, 'running')
  clock.now += 11 * 60000
  assert.equal(monitor.tick().length, 1)

  // 发 QQ 会清掉告警计时，但提醒本体还没进会话：仍不会再塞一条。
  monitor.noteQqOutbound(QQ)
  clock.now += 30 * 60000
  assert.deepEqual(monitor.tick(), [])

  // 下一条 assistant 消息说明提醒已经进了会话：从这一刻重新计时。
  monitor.handleEvent(session, { type: 'assistant/message', data: { turn: 1 } })
  assert.equal(monitor.snapshot().alerts.length, 0)
  clock.now += 11 * 60000
  const remindAgain = monitor.tick()
  assert.equal(remindAgain.length, 1)
  assert.equal(remindAgain[0].kind, 'remind')
  assert.equal(monitor.snapshot().alerts[0].injections, 1)
})

test('防失联监控：持续有模型输出算进展，不会每 15 分钟误报', () => {
  const { clock, monitor } = makeMonitor()
  monitor.trackStatus(session, 'running')

  // 每 9 分钟一次新的模型输出/工具调用：一直在干活，跨过 15、30 分钟都不提醒。
  for (const step of [9, 18, 27, 36]) {
    clock.now += 9 * 60000
    monitor.handleEvent(session, { type: 'assistant/message', data: { turn: 1, step: step } })
    assert.deepEqual(monitor.tick(), [])
  }

  // 最后一次输出之后 11 分钟没有任何新输出：这才是卡住。
  clock.now += 11 * 60000
  const firstRun = monitor.tick()
  assert.equal(firstRun.length, 1)
  assert.equal(firstRun[0].kind, 'remind')
  assert.equal(firstRun[0].seconds, 660, '从最后一次进展算起')
  assert.equal(firstRun[0].text, defaultLongTaskReminder, '默认长任务提醒文案原文')
})

test('防失联监控：真发出去的 QQ 算进展，卡住计时重置', () => {
  const { clock, monitor } = makeMonitor()
  monitor.trackStatus(session, 'running')
  clock.now += 9 * 60000
  assert.deepEqual(monitor.tick(), [])

  // QQ 真到了用户手里：会话还能把话带出去，计时从这一刻重新开始。
  monitor.noteQqOutbound(QQ)
  clock.now += 2 * 60000
  assert.deepEqual(monitor.tick(), [], '从发 QQ 重新算，还没到 10 分钟')

  clock.now += 9 * 60000
  const reminder = monitor.tick()
  assert.equal(reminder.length, 1)
  assert.equal(reminder[0].seconds, 660, '从发 QQ 那一刻算起')
})

test('防失联监控：提醒没送进去就退回，下个心跳重试', () => {
  const { clock, monitor } = makeMonitor()
  monitor.trackStatus(session, 'running')
  clock.now += 11 * 60000
  assert.equal(monitor.tick().length, 1)

  // 宿主正忙、注入被拒：这一次不算数，下一个心跳还能再塞。
  monitor.countInjectFailure(session)
  clock.now += 60000
  const retry = monitor.tick()
  assert.equal(retry.length, 1)
  assert.equal(retry[0].kind, 'remind')
})

test('防失联监控：一轮结束后进入新一轮才重新计时', () => {
  const { clock, monitor } = makeMonitor()
  monitor.trackStatus(session, 'running')
  clock.now += 11 * 60000
  assert.equal(monitor.tick().length, 1)

  // 这一轮里已经塞过一条：之后不再有任何动作。
  clock.now += 60 * 60000
  assert.deepEqual(monitor.tick(), [])
  assert.equal(monitor.snapshot().alerts[0].injections, 1)

  // 这一轮结束、下一轮开始：重新计数。
  monitor.handleEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  monitor.trackStatus(session, 'idle')
  monitor.trackStatus(session, 'running')
  clock.now += 11 * 60000
  const remindAgain = monitor.tick()
  assert.equal(remindAgain.length, 1)
  assert.equal(remindAgain[0].kind, 'remind')
  assert.equal(monitor.snapshot().alerts[0].injections, 1)
})

test('防失联监控：回合结束后清掉告警', () => {
  const { clock, monitor } = makeMonitor()
  monitor.trackStatus(session, 'running')
  clock.now += 30 * 60000
  assert.equal(monitor.tick().filter((a) => a.kind === 'remind').length, 1)
  assert.equal(monitor.snapshot().alerts.length, 1)

  // 这一轮正常结束：告警清掉。
  monitor.handleEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(monitor.snapshot().alerts.length, 0)
})

test('防失联监控：会话空闲时不打扰', () => {
  const { clock, monitor } = makeMonitor()
  monitor.trackStatus(session, 'idle')
  clock.now += 120 * 60000
  assert.deepEqual(monitor.tick(), [], '空闲是在等用户说话，不算卡住')
  assert.equal(monitor.snapshot().alerts.length, 0)
})

test('防失联监控：回合被中断立即提醒，短时间内不重复', () => {
  const { clock, monitor } = makeMonitor()
  monitor.trackStatus(session, 'running')
  const firstRun = monitor.handleEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
  assert.equal(firstRun.length, 1)
  assert.equal(firstRun[0].reason, 'interrupted')
  assert.match(firstRun[0].text, /被中断/)

  // 5 分钟后又中断一次：不该再提醒。
  clock.now += 5 * 60000
  assert.deepEqual(monitor.handleEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } }), [])

  // 正常结束：算恢复。
  monitor.handleEvent(session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  assert.equal(monitor.snapshot().alerts.length, 0)
})

test('防失联监控：只盯启用的绑定会话', () => {
  const { clock, monitor } = makeMonitor()
  monitor.trackStatus('session-别的会话', 'running')
  clock.now += 60 * 60000
  assert.deepEqual(monitor.tick(), [])
  assert.equal(monitor.snapshot().bound, 1)
  assert.equal(monitor.snapshot().alerts.length, 0, '没绑定的会话不进监控')

  // 关掉绑定后，状态跟着清掉。
  monitor.setBindings([{ qq: QQ, session: session, name: '主人', enabled: false }], new Map([[session, '测试会话']]))
  assert.equal(monitor.isBinding(session), false)
  assert.equal(monitor.snapshot().bound, 0)
})

test('防失联监控：未绑定会话的渠道不占监控名额', () => {
  const clock = { now: 1_000_000 }
  const monitor = new GuardMonitor({ now: () => clock.now, getConfig: () => ({ guardStuckSeconds: 600 }) })
  monitor.setBindings([
    { qq: QQ, session: session, name: '主人', enabled: true },
    { qq: '10002', session: '', name: '小号', enabled: true },
  ], new Map([['test-0001', '测试会话']]))
  assert.equal(monitor.snapshot().bound, 1, '只有绑定了会话的渠道进监控')
  assert.equal(monitor.isBinding(''), false)
  assert.equal(monitor.isBinding(session), true)
  assert.deepEqual(monitor.snapshot().alerts, [])
})

test('防失联工具守卫：挡住会等人的工具（提问/干等），不挡插件装卸', () => {
  const guard = constructToolGuard()
  for (const name of refuseTool) {
    const result = guard({ name: name })
    assert.equal(typeof result, 'string')
    assert.match(result, /不能用/)
    assert.match(result, /聊天软件|渠道/)
  }
  assert.match(guard({ name: 'ask_user_question' }), /ask_user_question/)
  assert.match(guard({ name: 'wait_agent' }), /wait_agent/)
  assert.match(guard({ name: 'wait_agent' }), /唤醒/)
  assert.equal(guard({ name: 'plugin_manager' }), undefined, '插件装卸不再拦')
  assert.equal(guard({ name: 'web_search' }), undefined)
  assert.equal(guard(null), undefined)
  assert.equal(guard({}), undefined)
  // 提示词只留代码管不到的约定：回复走 [MSG] 块、拍板发 QQ、长任务派子代理。
  assert.match(guardRules, /子代理/)
  assert.match(guardRules, /\[MSG\][\s\S]*\[\/MSG\]/)
  assert.doesNotMatch(guardRules, /QQ/, '提示词里不再出现 QQ 这个说法')
  assert.match(guardRules, /用户/)
  assert.doesNotMatch(guardRules, /主人/, '用通用称呼，不带个人设定')
  assert.ok(guardRules.split('\n').length <= 4, '短提示：最多 4 句')
  // 下面这些由机制保证，提示词里不再重复（同一条规矩只留一处出处）：
  // 拒用工具 → 工具守卫；审批 → 策略 never；[MSG] 出站 → 桥只投递块内内容。
  assert.doesNotMatch(guardRules, /ask_user_question|wait_agent/)
  assert.doesNotMatch(guardRules, /send_message/)
  assert.doesNotMatch(guardRules, /重启|dsh_restart|杀进程|进程/, '重启/杀进程是独立插件的职责，鱼讯的提示词不越界')
})

test('防失联：按回合计数，一个回合里 5 个 assistant/message 只算 1 轮', () => {
  const { clock, monitor } = makeMonitor({ guardStuckSeconds: 600, guardQqRemindTurns: 3 })

  // 一个回合里 5 个模型步（工具调用）都发 assistant/message，但最后没发 QQ：只计 1 轮。
  assert.deepEqual(runOneTurn(clock, monitor, 1, { toolSteps: 5 }), [])
  // 第 2 个回合：仍不到阈值。按模型步算的话这里已经该提醒一次了。
  assert.deepEqual(runOneTurn(clock, monitor, 2, { toolSteps: 5 }), [])

  // 第 3 个回合：满 3 轮才提醒，轮数是回合数，不是模型步数。
  const reminders = runOneTurn(clock, monitor, 3, { toolSteps: 5 })
  assert.equal(reminders.length, 1)
  assert.equal(reminders[0].kind, 'remind')
  assert.equal(reminders[0].reason, 'no-qq')
  assert.equal(reminders[0].turns, 3, '三个回合，而不是十五个模型步')
  assert.equal(reminders[0].text, defaultChannelReminder, '默认消息通道提醒文案原文')
})

test('防失联：回合里发过 QQ 就清零，不提醒', () => {
  const { clock, monitor } = makeMonitor({ guardStuckSeconds: 600, guardQqRemindTurns: 3 })
  assert.deepEqual(runOneTurn(clock, monitor, 1), [])
  assert.deepEqual(runOneTurn(clock, monitor, 2), [])

  // 第 3 个回合发过 QQ：不算「没发 QQ」的回合，计数清零。
  assert.deepEqual(runOneTurn(clock, monitor, 3, { toolSteps: 5, sendQq: true }), [])

  // 之后从头攒：还要 3 个没发 QQ 的回合才提醒。
  assert.deepEqual(runOneTurn(clock, monitor, 4), [])
  assert.deepEqual(runOneTurn(clock, monitor, 5), [])
  const reminders = runOneTurn(clock, monitor, 6)
  assert.equal(reminders.length, 1)
  assert.equal(reminders[0].reason, 'no-qq')
  assert.equal(reminders[0].turns, 3, '发过 QQ 的那一轮不计入')
})

test('防失联：新回合开始（agent/status 进入 running）也复位本回合 QQ 标记', () => {
  const { clock, monitor } = makeMonitor({ guardStuckSeconds: 600, guardQqRemindTurns: 2 })
  monitor.trackStatus(session, 'running')
  // 上一回合末发过 QQ：标记为真。
  monitor.noteQqOutbound(QQ)
  monitor.trackStatus(session, 'idle')
  // 新回合开始：即使没有 turn/start 事件，标记也要复位，这一回合没发 QQ 就算 1 轮。
  monitor.trackStatus(session, 'running')
  assert.deepEqual(runOneTurn(clock, monitor, 1), [])
  const reminders = runOneTurn(clock, monitor, 2)
  assert.equal(reminders.length, 1)
  assert.equal(reminders[0].turns, 2)
})

test('防失联：没发 QQ 的提醒 15 分钟内不重复', () => {
  const { clock, monitor } = makeMonitor({ guardStuckSeconds: 600, guardQqRemindTurns: 3 })
  for (let turn = 1; turn <= 3; turn += 1) {
    const result = runOneTurn(clock, monitor, turn)
    if (turn === 3) {
      assert.equal(result.length, 1)
      assert.equal(result[0].reason, 'no-qq')
    }
  }

  // 提醒注入后会作为一条 user 消息开启新回合；这段时间里再攒满也不重复提醒。
  for (let turn = 4; turn <= 6; turn += 1) {
    assert.deepEqual(runOneTurn(clock, monitor, turn), [])
  }

  // 过了 15 分钟才允许再提醒。
  clock.now += 16 * 60000
  const remindAgain = runOneTurn(clock, monitor, 7)
  assert.equal(remindAgain.length, 1)
  assert.equal(remindAgain[0].reason, 'no-qq')
  assert.ok(remindAgain[0].turns >= 3)
})

test('防失联：turn/end 之后才发 QQ（桥的投递晚一步）不算这一回合没发', () => {
  const { clock, monitor } = makeMonitor({ guardStuckSeconds: 600, guardQqRemindTurns: 2 })
  monitor.handleEvent(session, { type: 'turn/start', data: { turn: 1 } })
  monitor.handleEvent(session, { type: 'assistant/message', data: { turn: 1, step: 1 } })
  assert.deepEqual(
    monitor.handleEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
    [],
    'turn/end 那一刻不判定，只记下待判定',
  )
  // 桥正是在 turn/end 之后才把 [MSG] 投出去的：1 秒后出站事件才到。
  clock.now += 1000
  monitor.noteQqOutbound(QQ)
  assert.deepEqual(pastGrace(clock, monitor), [], '出站已经记账，宽限过后不该提醒')
  const st = monitor.getStatus(session)
  assert.equal(st.qqTurn, 0, '这一回合算发过 QQ，不计数')
  assert.equal(st.pendingTurn, false, '出站到了就消掉待判定，不必再等宽限')
  assert.equal(st.qqSentThisTurn, true, '出站记在「本回合」上，由下一个 turn/start 复位')
})

test('防失联：turn/end 后一直没出站，宽限过了才计一轮', () => {
  const { clock, monitor } = makeMonitor({ guardStuckSeconds: 600, guardQqRemindTurns: 3 })
  monitor.handleEvent(session, { type: 'turn/start', data: { turn: 1 } })
  monitor.handleEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  // 宽限还没到：不判定、不计数。
  assert.deepEqual(monitor.tick(), [])
  assert.equal(monitor.getStatus(session).qqTurn, 0)

  assert.deepEqual(pastGrace(clock, monitor), [], '1 轮还没到 3 轮的阈值')
  assert.equal(monitor.getStatus(session).qqTurn, 1, '宽限过后按「没发 QQ」计 1 轮')

  // 同一个回合不会被重复计：再跳心跳也不涨。
  clock.now += turnGraceMs
  assert.deepEqual(monitor.tick(), [])
  assert.equal(monitor.getStatus(session).qqTurn, 1)
})

test('防失联：连续 3 个正常发 QQ 的回合，永不误提醒', () => {
  // 阈值调到 1：只要误判一次就会立刻提醒，这样「没误报」才有说服力。
  const { clock, monitor } = makeMonitor({ guardStuckSeconds: 600, guardQqRemindTurns: 1 })
  for (let turn = 1; turn <= 3; turn += 1) {
    monitor.handleEvent(session, { type: 'turn/start', data: { turn } })
    monitor.handleEvent(session, { type: 'assistant/message', data: { turn, step: 1 } })
    assert.deepEqual(monitor.handleEvent(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }), [])
    // 桥在 turn/end 之后才投递 [MSG]：1 秒后出站。
    clock.now += 1000
    monitor.noteQqOutbound(QQ)
    assert.deepEqual(pastGrace(clock, monitor), [], `第 ${turn} 个正常回合不该提醒`)
    assert.equal(monitor.getStatus(session).qqTurn, 0, `第 ${turn} 个正常回合不该计数`)
  }
  // 再跑两个也一样：误计数不会攒起来。
  for (let turn = 4; turn <= 5; turn += 1) {
    monitor.handleEvent(session, { type: 'turn/start', data: { turn } })
    monitor.handleEvent(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    clock.now += 1000
    monitor.noteQqOutbound(QQ)
    assert.deepEqual(pastGrace(clock, monitor), [])
  }
})

test('防失联：宽限内来新回合，旧回合按当时状态判掉，不串味', () => {
  const { clock, monitor } = makeMonitor({ guardStuckSeconds: 600, guardQqRemindTurns: 3 })
  const st = () => monitor.getStatus(session)

  // 第 1 回合没发 QQ，turn/end 后 1 秒用户就说话了（宽限还没走完）。
  monitor.handleEvent(session, { type: 'turn/start', data: { turn: 1 } })
  monitor.handleEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  clock.now += 1000
  assert.deepEqual(monitor.handleEvent(session, { type: 'turn/start', data: { turn: 2 } }), [])
  assert.equal(st().qqTurn, 1, '旧回合按「没发 QQ」当场判掉')
  assert.equal(st().pendingTurn, false, '旧回合的待判定已经消掉')

  // 新回合发了 QQ：出站说明通道是通的，计数清零；旧回合的待判定不会拖到这时候才判。
  clock.now += 500
  monitor.noteQqOutbound(QQ)
  monitor.handleEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.deepEqual(pastGrace(clock, monitor), [])
  assert.equal(st().qqTurn, 0, '发过 QQ 的回合清零')
  assert.equal(st().qqSentThisTurn, false, '新回合的出站不会挂在旧回合上')
  assert.equal(st().pendingTurn, false)

  // 反过来：旧回合发过 QQ，宽限内来新回合 → 按「发过」判掉，不会误计一轮。
  monitor.handleEvent(session, { type: 'turn/start', data: { turn: 3 } })
  monitor.noteQqOutbound(QQ)
  monitor.handleEvent(session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  clock.now += 1000
  monitor.handleEvent(session, { type: 'turn/start', data: { turn: 4 } })
  assert.equal(st().qqTurn, 0, '发过 QQ 的旧回合不计数')
  assert.deepEqual(pastGrace(clock, monitor), [])
})

test('防失联：提醒注入开出的新回合不会连着再提醒', () => {
  const { clock, monitor } = makeMonitor({ guardStuckSeconds: 600, guardQqRemindTurns: 1 })
  const firstRun = runOneTurn(clock, monitor, 1)
  assert.equal(firstRun.length, 1)
  assert.equal(firstRun[0].reason, 'no-qq', '第一个回合该提醒一次')

  // 提醒会作为一条 user 消息开新回合：没发 QQ 照旧计一轮，但 15 分钟内不再注入。
  for (let turn = 2; turn <= 4; turn += 1) {
    assert.deepEqual(runOneTurn(clock, monitor, turn), [], `第 ${turn} 个回合不再注入`)
  }
})

test('防失联：没发 QQ 提醒轮数可配置，钳制 1~50 且能保存读回', () => {
  assert.equal(normalizeConfig({}).guardQqRemindTurns, 3)
  assert.equal(normalizeConfig({ guardQqRemindTurns: 0 }).guardQqRemindTurns, 1)
  assert.equal(normalizeConfig({ guardQqRemindTurns: 99 }).guardQqRemindTurns, 50)
  assert.equal(normalizeConfig({ guardQqRemindTurns: '5' }).guardQqRemindTurns, 5)

  const dir = tempDir()
  const store = new ConfigStore({ homeDir: dir })
  assert.ok(store.save({ ...normalizeConfig({}), guardQqRemindTurns: 5 }))
  assert.equal(store.load().guardQqRemindTurns, 5)
})

test('防失联：两条提醒默认用内置文案，自定义文案原样生效', () => {
  // 默认：设置里留空 → 内置原文。
  const theDefault = makeMonitor({ guardStuckSeconds: 600, guardQqRemindTurns: 3 })
  theDefault.monitor.trackStatus(session, 'running')
  theDefault.clock.now += 11 * 60000
  assert.equal(theDefault.monitor.tick()[0].text, defaultLongTaskReminder)
  const defaultChannel = makeMonitor({ guardStuckSeconds: 600, guardQqRemindTurns: 3 })
  runOneTurn(defaultChannel.clock, defaultChannel.monitor, 1)
  runOneTurn(defaultChannel.clock, defaultChannel.monitor, 2)
  assert.equal(runOneTurn(defaultChannel.clock, defaultChannel.monitor, 3)[0].text, defaultChannelReminder)

  // 自定义：首尾空格去掉后用自定义文案。
  const custom = makeMonitor({
    guardStuckSeconds: 600,
    guardQqRemindTurns: 3,
    guardStuckPrompt: '  自定义长任务提醒  ',
    guardQqPrompt: '自定义消息通道提醒',
  })
  custom.monitor.trackStatus(session, 'running')
  custom.clock.now += 11 * 60000
  assert.equal(custom.monitor.tick()[0].text, '自定义长任务提醒')
  runOneTurn(custom.clock, custom.monitor, 1)
  runOneTurn(custom.clock, custom.monitor, 2)
  assert.equal(runOneTurn(custom.clock, custom.monitor, 3)[0].text, '自定义消息通道提醒')

  // 工具函数本身：空串/空格回落默认。
  assert.equal(longTaskReminderText({}), defaultLongTaskReminder)
  assert.equal(longTaskReminderText({ guardStuckPrompt: '   ' }), defaultLongTaskReminder)
  assert.equal(longTaskReminderText({ guardStuckPrompt: '自定' }), '自定')
  assert.equal(channelReminderText({ guardQqPrompt: '' }), defaultChannelReminder)
  assert.equal(channelReminderText({ guardQqPrompt: '通道' }), '通道')
})

test('防失联：两条提醒提示词可配置，空串/非字符串/超长回落空', () => {
  assert.equal(normalizeConfig({}).guardStuckPrompt, '')
  assert.equal(normalizeConfig({}).guardQqPrompt, '')
  assert.equal(normalizeConfig({ guardStuckPrompt: '  自定义长任务  ' }).guardStuckPrompt, '自定义长任务')
  assert.equal(normalizeConfig({ guardQqPrompt: '\n自定义通道\n' }).guardQqPrompt, '自定义通道')
  assert.equal(normalizeConfig({ guardStuckPrompt: '   ' }).guardStuckPrompt, '')
  assert.equal(normalizeConfig({ guardQqPrompt: 123 }).guardQqPrompt, '')
  assert.equal(normalizeConfig({ guardStuckPrompt: 'x'.repeat(4001) }).guardStuckPrompt, '')
  assert.equal(normalizeConfig({ guardQqPrompt: 'x'.repeat(4000) }).guardQqPrompt, 'x'.repeat(4000))

  const dir = tempDir()
  const store = new ConfigStore({ homeDir: dir })
  assert.ok(store.save({ ...normalizeConfig({}), guardStuckPrompt: '保存长任务', guardQqPrompt: '保存通道' }))
  const readRespond = store.load()
  assert.equal(readRespond.guardStuckPrompt, '保存长任务')
  assert.equal(readRespond.guardQqPrompt, '保存通道')
})

test('持久化：待转发队列/状态/配置损坏时先留档，再按空值继续', () => {
  const dir = tempDir()
  const logger = new Logger({ filePath: join(dir, 'bad.log'), level: 'debug' })
  const corrupt = (name) => writeFileSync(join(dir, name), '{坏掉的 JSON', 'utf8')
  corrupt('fish-message-forward-queue.json')
  corrupt('fish-message-state.json')
  corrupt('fish-message-config.json')

  const forward = new ForwardQueue({ homeDir: dir, logger })
  assert.equal(forward.pending(), 0)
  const status = new StateStore({ homeDir: dir, logger })
  assert.equal(status.snapshot().stats.received, 0)
  const cfg = new ConfigStore({ homeDir: dir, logger }).load({})
  assert.equal(cfg.guardEnabled, true, '配置坏了回默认值')

  const files = readdirSync(dir)
  for (const name of ['fish-message-forward-queue.json', 'fish-message-state.json', 'fish-message-config.json']) {
    assert.equal(files.filter((n) => n.startsWith(`${name}.bad-`)).length, 1, `${name} 应留档`)
  }
  assert.match(logger.recent().join('\n'), /留档/)
})
