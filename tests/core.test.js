import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Bridge } from '../lib/bridge.js'
import { VoiceService } from '../lib/voice.js'
import { StateStore } from '../lib/storage.js'
import { ForwardQueue } from '../lib/forward-queue.js'
import { ConfigStore, 已移除的语音字段, normalizeConfig, deriveWsUrl, migrateLegacyConfig, publicConfig, 默认识图提示词, 默认长任务提醒文案, 默认消息通道提醒文案 } from '../lib/config.js'
import {
  GuardMonitor, 构造工具守卫, 守卫规则, 拒用工具, 长任务提醒文本, 消息通道提醒文本, 回合判定宽限毫秒,
} from '../lib/guard.js'
import { AiService } from '../lib/ai.js'
import { Logger } from '../lib/logger.js'

const 睡 = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待条件成立（测试里的 setTimeout 补投是异步的）。 */
async function 等(条件, 毫秒 = 1000, 间隔 = 20) {
  const 止 = Date.now() + 毫秒
  while (Date.now() < 止) {
    if (await 条件()) return true
    await 睡(间隔)
  }
  return false
}

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
  async fetchImage() { throw new Error('测试里不放图片') }
}

/** 假本地 AI 服务：只实现鱼讯会调的那几个方法，形状按 fish.service 的公开契约。 */
class 假服务 {
  constructor({
    ttsOk = true, asrText = '', describeText = '', speaker = null,
    emotion = '', events = null, caps = {}, visionPrefs,
  } = {}) {
    this.ttsOk = ttsOk
    this.asrText = asrText
    this.describeText = describeText
    this.speaker = speaker
    this.emotion = emotion
    this.events = events
    this.visionPrefs结果 = visionPrefs
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
    return { ok: true, items: [{ wavPath: this.输出, voice: opts?.voice, ms: 10 }] }
  }
  async asr(path, opts) {
    this.calls.asr.push({ path, opts })
    // 旧版插件没有 emotion / events：不传就不会出现在返回里，用来验证降级。
    const 项 = { text: this.asrText, language: opts?.language }
    if (this.speaker) 项.speaker = this.speaker
    if (this.emotion) 项.emotion = this.emotion
    if (Array.isArray(this.events)) 项.events = this.events
    return { ok: true, items: [项] }
  }
  async visionPrefs() {
    this.calls.prefs += 1
    return this.visionPrefs结果
  }
  async visionDescribe(path, opts) {
    this.calls.vision.push({ path, opts })
    return { ok: true, items: [{ path, text: this.describeText }] }
  }
}

function 建AI(服务, logger) {
  return new AiService({ getService: () => 服务, getConfig: () => ({}), logger })
}

/** 造一个最小可解析的 wav（16k 单声道 16bit），用于读时长。 */
function 造wav(秒 = 1) {
  const 采样率 = 16000
  const 数据长 = Math.round(采样率 * 秒) * 2
  const buf = Buffer.alloc(44 + 数据长)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + 数据长, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(采样率, 24)
  buf.writeUInt32LE(采样率 * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(数据长, 40)
  return buf
}

function 建桥({ dir = 临时目录(), 历史 = {}, config = {}, ai = null, forwardQueue = null } = {}) {
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
    forwardQueue,
    ai,
    autoTimers: false,
  })
  store.setWatermark(QQ, { timestamp: 1, messageId: '' })
  return { dir, store, logger, transport, delivery, voice, 配置, bridge }
}

/** 入站解析用的最小桥：只关心 voice、配置和可选的本地 AI。 */
function 建入站桥({ dir, 服务 = null, voice, config = {} }) {
  const logger = new Logger({ filePath: join(dir, 'test.log'), level: 'debug' })
  const 配置 = normalizeConfig({
    bindings: [{ qq: QQ, session: 会话, name: '主人', enabled: true }],
    reorderBufferMs: 0,
    ...config,
  })
  return new Bridge({
    getConfig: () => 配置,
    transport: new 假传输(),
    store: new StateStore({ homeDir: dir }),
    logger,
    voice,
    delivery: new 假投递(),
    ai: 服务 ? 建AI(服务, logger) : null,
    autoTimers: false,
  })
}

function 建语音桥(dir, 服务) {
  const 原始 = join(dir, 'from-qq.wav')
  writeFileSync(原始, 造wav(2))
  const transport = new 假传输()
  transport.getRecord = async () => ({ file: 原始 })
  const logger = new Logger({ filePath: join(dir, 'test.log'), level: 'debug' })
  const voice = new VoiceService({
    getConfig: () => normalizeConfig({ maxVoiceMB: 20 }),
    logger,
    transport,
    inboxDir: join(dir, 'inbox'),
  })
  return 建入站桥({ dir, 服务, voice })
}

function 建图片桥(dir, 服务, config = {}) {
  const 图 = join(dir, 'qq.png')
  writeFileSync(图, 'fake-png')
  const voice = {
    async fetchImage() {
      return { buffer: Buffer.from('fake-png'), base64: 'ZmFrZQ==', mime: 'image/png', path: 图, ext: '.png' }
    },
  }
  return { bridge: 建入站桥({ dir, 服务, voice, config }), 图 }
}

const 图片消息 = (id) => ({ message_id: id, message: [{ type: 'image', data: { file: 'a.png' } }] })

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

test('状态：旧的「语音文件不存在：路径」读回时改成占位符说明', () => {
  const dir = 临时目录()
  writeFileSync(join(dir, 'fish-message-state.json'), JSON.stringify({
    version: 1,
    stats: { lastError: '语音文件不存在：路径', outboxLastError: '语音文件不存在：路径' },
  }), 'utf8')
  const s = new StateStore({ homeDir: dir })
  const 快照 = s.snapshot()
  assert.match(快照.stats.lastError, /占位符/)
  assert.ok(快照.stats.lastError.includes('「路径」'))
  assert.match(快照.stats.outboxLastError, /占位符/)
  assert.doesNotMatch(快照.stats.lastError, /^语音文件不存在：路径$/)
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

// ---------------- 可选本地 AI：语音/识图能力与降级 ----------------

test('入站语音：只落盘并递「语音：路径」，不联网、不转写', async () => {
  const dir = 临时目录()
  const 原始 = join(dir, 'from-qq.wav')
  writeFileSync(原始, 造wav(2))

  class 语音传输 extends 假传输 {
    constructor(本地文件) { super(); this.本地文件 = 本地文件; this.getRecord次数 = 0; this.下载次数 = 0 }
    async getRecord() { this.getRecord次数++; return { file: this.本地文件 } }
    async download() { this.下载次数++; throw new Error('不应该下载') }
  }

  const transport = new 语音传输(原始)
  const logger = new Logger({ filePath: join(dir, 'test.log'), level: 'debug' })
  const voice = new VoiceService({
    getConfig: () => normalizeConfig({ maxVoiceMB: 20 }),
    logger,
    transport,
    inboxDir: join(dir, 'inbox'),
  })
  const 配置 = normalizeConfig({
    bindings: [{ qq: QQ, session: 会话, name: '主人', enabled: true }],
    reorderBufferMs: 0,
  })
  const bridge = new Bridge({
    getConfig: () => 配置,
    transport,
    store: new StateStore({ homeDir: dir }),
    logger,
    voice,
    delivery: new 假投递(),
    autoTimers: false,
  })

  // 只要调用了 fetch 就算联网；这条链路必须一次都不调。
  let 网络调用 = 0
  const 原fetch = globalThis.fetch
  globalThis.fetch = async () => { 网络调用++; throw new Error('解耦后入站语音不该联网') }
  try {
    const 内容 = await bridge.buildInbound(
      { qq: QQ, name: '主人' },
      { message_id: 'm-voice-1', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
    )
    assert.equal(网络调用, 0, '入站语音不能调 ASR / to_wav 等网络接口')
    assert.equal(transport.getRecord次数, 1, '只问 get_record 要 wav')
    assert.equal(transport.下载次数, 0)
    assert.match(内容.text, /（语音：.+\.wav，2 秒）/)
    assert.ok(!内容.text.includes('转写'), '不能再出现转写文字')
    assert.ok(!内容.text.includes('声纹'), '不能再带声纹')
  } finally {
    globalThis.fetch = 原fetch
  }
})

test('出站 [语音]文本[/语音]：没装本地 AI 时只提示，不发任何消息', async () => {
  const { bridge, transport } = 建桥()
  const 结果 = await bridge.deliverAssistantTurn(会话, '[QQ][语音]晚安，主人[/语音][/QQ]')
  assert.equal(transport.sent.length, 0, '不能合成、也不能发任何消息')
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'service_not_installed')
  assert.equal(结果.tts, false)
  assert.match(结果.hint, /本地 AI 插件没装或没启动/)
  assert.match(结果.hint, /其它功能不受影响/)
})

test('出站 [语音]文本[/语音] 与文字混排：文字照发，语音只提示', async () => {
  const { bridge, transport, delivery } = 建桥()
  const 结果 = await bridge.deliverAssistantTurn(会话, '[QQ]先听这个 [语音]晚安[/语音][/QQ]')
  assert.equal(transport.sent.length, 1)
  assert.deepEqual(transport.sent[0].segments, [{ type: 'text', data: { text: '先听这个' } }])
  assert.equal(结果.code, 'service_not_installed')
  assert.equal(delivery.got.length, 1, '语音失败要在会话里留一句提示，不能只写日志')
  assert.match(delivery.got[0].text, /本地 AI 插件没装或没启动/)
})

test('出站 [语音]文本[/语音]：本地 AI 正常时按配置音色/语速合成并发送 wavPath', async () => {
  const dir = 临时目录()
  const 音频 = join(dir, 'tts.wav')
  writeFileSync(音频, 造wav(0.2))
  const 服务 = new 假服务()
  服务.输出 = 音频
  const { bridge, transport } = 建桥({ dir, ai: 建AI(服务) })
  const 结果 = await bridge.deliverAssistantTurn(会话, '[QQ][语音]晚安，主人[/语音][/QQ]')
  assert.equal(结果.ok, true)
  assert.equal(transport.sent.length, 1)
  assert.equal(transport.sent[0].segments[0].type, 'record')
  assert.equal(transport.sent[0].segments[0].data.file, 音频.replace(/\\/g, '/'))
  assert.deepEqual(服务.calls.tts, [{ text: '晚安，主人', opts: { voice: 'dafeiyu', speed: 1 } }])
})

test('出站语音：服务在但 tts 能力关时降级提示，不抛错', async () => {
  const 服务 = new 假服务({ ttsOk: false, caps: { tts: { available: false, reason: 'model_missing' } } })
  const { bridge, transport } = 建桥({ ai: 建AI(服务) })
  const 结果 = await bridge.deliverAssistantTurn(会话, '[QQ][语音]晚安[/语音][/QQ]')
  assert.equal(transport.sent.length, 0)
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'model_missing')
  assert.match(结果.hint, /模型还没准备好/)
})

test('入站语音：本地 AI 正常时把声纹和转写写进同一行路径消息', async () => {
  const dir = 临时目录()
  const 服务 = new 假服务({ asrText: '今晚早点睡', speaker: { name: '主人', score: 0.93, known: true } })
  const bridge = 建语音桥(dir, 服务)
  const 内容 = await bridge.buildInbound(
    { qq: QQ, name: '主人' },
    { message_id: 'm-voice-2', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
  )
  assert.match(内容.text, /^（语音：.+\.wav，2 秒；说话人：主人；转写：今晚早点睡）$/)
  assert.deepEqual(服务.calls.asr, [{ path: 内容.text.match(/（语音：(.+?)，/)[1], opts: { language: 'auto' } }])
})

test('入站语音：没有声纹时只附转写', async () => {
  const dir = 临时目录()
  const 服务 = new 假服务({ asrText: '晚安' })
  const bridge = 建语音桥(dir, 服务)
  const 内容 = await bridge.buildInbound(
    { qq: QQ, name: '主人' },
    { message_id: 'm-voice-3', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
  )
  assert.match(内容.text, /，2 秒；转写：晚安）$/)
  assert.doesNotMatch(内容.text, /说话人/)
})

test('入站语音：情感和背景音写在同一行，转写仍在最后', async () => {
  const dir = 临时目录()
  const 服务 = new 假服务({
    asrText: '你终于回来了',
    speaker: { name: '主人', score: 0.93, known: true },
    emotion: 'HAPPY',
    events: ['Speech', '[Laughter]'],
  })
  const bridge = 建语音桥(dir, 服务)
  const 内容 = await bridge.buildInbound(
    { qq: QQ, name: '主人' },
    { message_id: 'm-voice-4', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
  )
  assert.match(内容.text, /^（语音：.+\.wav，2 秒；说话人：主人；情感：开心；背景：笑声；转写：你终于回来了）$/)
})

test('入站语音：无声纹、事件只有 Speech 时只写情感和转写', async () => {
  const dir = 临时目录()
  const 服务 = new 假服务({ asrText: '晚安', emotion: 'NEUTRAL', events: ['Speech'] })
  const bridge = 建语音桥(dir, 服务)
  const 内容 = await bridge.buildInbound(
    { qq: QQ, name: '主人' },
    { message_id: 'm-voice-5', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
  )
  assert.match(内容.text, /^（语音：.+\.wav，2 秒；情感：中性；转写：晚安）$/)
  assert.doesNotMatch(内容.text, /说话人|背景|undefined|null/)
})

test('入站语音：未知情绪、events 为空时退回只有转写的样子', async () => {
  const dir = 临时目录()
  const 服务 = new 假服务({ asrText: '晚安', emotion: 'BORED', events: [] })
  const bridge = 建语音桥(dir, 服务)
  const 内容 = await bridge.buildInbound(
    { qq: QQ, name: '主人' },
    { message_id: 'm-voice-6', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
  )
  assert.match(内容.text, /，2 秒；转写：晚安）$/)
  assert.doesNotMatch(内容.text, /情感|背景|undefined|null/)
})

test('入站语音：多个事件只挑一个背景音；speaker.known=false 仍按名字写说话人', async () => {
  const dir = 临时目录()
  const 服务 = new 假服务({
    speaker: { name: '主人', score: 0.4, known: false },
    emotion: 'FEARFUL',
    events: ['Music', '[Applause]', '[Laughter]'],
  })
  const bridge = 建语音桥(dir, 服务)
  const 内容 = await bridge.buildInbound(
    { qq: QQ, name: '主人' },
    { message_id: 'm-voice-7', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
  )
  assert.match(内容.text, /，2 秒；说话人：主人；情感：害怕；背景：笑声）$/)
})

test('入站语音：旧版服务没 emotion/events 时消息保持原样，不出现 undefined/null', async () => {
  const dir = 临时目录()
  const 服务 = new 假服务({ asrText: '晚安', speaker: { name: '主人', score: 0.9, known: true } })
  const bridge = 建语音桥(dir, 服务)
  const 内容 = await bridge.buildInbound(
    { qq: QQ, name: '主人' },
    { message_id: 'm-voice-8', message: [{ type: 'record', data: { file: 'voice.silk' } }] },
  )
  assert.match(内容.text, /^（语音：.+\.wav，2 秒；说话人：主人；转写：晚安）$/)
  assert.doesNotMatch(内容.text, /情感|背景|undefined|null/)
})

test('入站图片：开关开且识图可用时，用描述 + 路径代替 base64 图片', async () => {
  const dir = 临时目录()
  const 服务 = new 假服务({ describeText: '一只橘猫趴在键盘上' })
  const { bridge, 图 } = 建图片桥(dir, 服务, { describeInboundImages: 'on' })
  const 内容 = await bridge.buildInbound({ qq: QQ, name: '主人' }, 图片消息('m-img-1'))
  assert.equal(内容.images.length, 0, '识图后不再塞 base64 图片进会话')
  assert.match(内容.text, /（图片：一只橘猫趴在键盘上；已存到 .+qq\.png）/)
  assert.match(内容.text, /收到 1 张图片/)
  assert.deepEqual(服务.calls.vision, [{ path: 图, opts: { mode: 'caption', prompt: 默认识图提示词 } }])
})

test('入站图片：自定义识图提示词作为 prompt 传给本地 AI', async () => {
  const dir = 临时目录()
  const 服务 = new 假服务({ describeText: '一只猫' })
  const { bridge, 图 } = 建图片桥(dir, 服务, {
    describeInboundImages: 'on',
    inboundImagePrompt: '看看这张表情包是什么梗',
  })
  await bridge.buildInbound({ qq: QQ, name: '主人' }, 图片消息('m-img-prompt'))
  assert.deepEqual(服务.calls.vision, [{
    path: 图,
    opts: { mode: 'caption', prompt: '看看这张表情包是什么梗' },
  }])
})

test('入站图片：提示词留空时用内置默认，识图失败仍退回图片附件', async () => {
  const dir = 临时目录()
  const 服务 = new 假服务({ describeText: '一只猫' })
  const { bridge } = 建图片桥(dir, 服务, { describeInboundImages: 'on' })
  const 内容 = await bridge.buildInbound({ qq: QQ, name: '主人' }, 图片消息('m-img-prompt-default'))
  assert.equal(服务.calls.vision[0].opts.prompt, 默认识图提示词, '留空时用内置默认')
  assert.equal(内容.images.length, 0)

  // 提示词是自定义的也一样：识图不可用时只影响文字，不改变降级路径。
  const 坏目录 = 临时目录()
  const 坏服务 = new 假服务()
  坏服务.visionDescribe = async (path, opts) => {
    坏服务.calls.vision.push({ path, opts })
    return { ok: false, code: 'busy', hint: '本地 AI 正忙' }
  }
  const { bridge: 坏桥 } = 建图片桥(坏目录, 坏服务, {
    describeInboundImages: 'on',
    inboundImagePrompt: '自定义提示',
  })
  const 坏内容 = await 坏桥.buildInbound({ qq: QQ, name: '主人' }, 图片消息('m-img-prompt-fail'))
  assert.equal(坏服务.calls.vision[0].opts.prompt, '自定义提示')
  assert.equal(坏内容.images.length, 1)
  assert.match(坏内容.text, /\[图片\]/)
})

test('入站图片：开关关时保持原样，图片附件和路径都在', async () => {
  const dir = 临时目录()
  const 服务 = new 假服务({ describeText: '不应该被调用' })
  const { bridge } = 建图片桥(dir, 服务, { describeInboundImages: 'off' })
  const 内容 = await bridge.buildInbound({ qq: QQ, name: '主人' }, 图片消息('m-img-2'))
  assert.equal(内容.images.length, 1)
  assert.equal(内容.images[0].base64, 'ZmFrZQ==')
  assert.match(内容.text, /\[图片\]/)
  assert.equal(服务.calls.vision.length, 0)
  assert.equal(服务.calls.prefs, 0, '强制关时不必问插件偏好')
})

test('入站图片：继承时跟随本地 AI 插件的识图开关', async () => {
  const 关目录 = 临时目录()
  const 关服务 = new 假服务({ describeText: '不该出现', visionPrefs: { localDescribe: false } })
  const 关桥 = 建图片桥(关目录, 关服务).bridge
  const 关内容 = await 关桥.buildInbound({ qq: QQ, name: '主人' }, 图片消息('m-img-3'))
  assert.equal(关服务.calls.prefs, 1)
  assert.equal(关服务.calls.vision.length, 0)
  assert.equal(关内容.images.length, 1, '插件关着识图时图片照常递附件')

  const 开目录 = 临时目录()
  const 开服务 = new 假服务({ describeText: '一只猫', visionPrefs: { localDescribe: true } })
  const 开内容 = await 建图片桥(开目录, 开服务).bridge.buildInbound({ qq: QQ, name: '主人' }, 图片消息('m-img-4'))
  assert.equal(开服务.calls.vision.length, 1)
  assert.match(开内容.text, /（图片：一只猫；已存到 /)
})

test('入站图片：on/off 覆盖插件开关；拿不到偏好时继承按开', async () => {
  const 一目录 = 临时目录()
  const 一服务 = new 假服务({ describeText: '一只猫', visionPrefs: { localDescribe: false } })
  await 建图片桥(一目录, 一服务, { describeInboundImages: 'on' }).bridge
    .buildInbound({ qq: QQ, name: '主人' }, 图片消息('m-img-5'))
  assert.equal(一服务.calls.vision.length, 1, '选「开」时不看插件偏好')

  const 二目录 = 临时目录()
  const 二服务 = new 假服务({ describeText: '一只猫', visionPrefs: { localDescribe: true } })
  await 建图片桥(二目录, 二服务, { describeInboundImages: 'off' }).bridge
    .buildInbound({ qq: QQ, name: '主人' }, 图片消息('m-img-6'))
  assert.equal(二服务.calls.vision.length, 0, '选「关」时不看插件偏好')

  // 插件还没有 visionPrefs（本轮契约刚加）：当 unknown，按「开」处理。
  const 三目录 = 临时目录()
  const 三服务 = new 假服务({ describeText: '一只猫' })
  const 三内容 = await 建图片桥(三目录, 三服务).bridge.buildInbound({ qq: QQ, name: '主人' }, 图片消息('m-img-7'))
  assert.equal(三服务.calls.prefs, 1)
  assert.equal(三服务.calls.vision.length, 1)
  assert.match(三内容.text, /（图片：一只猫/)
})

test('入站图片：识图失败时退回图片附件，不丢图', async () => {
  const dir = 临时目录()
  const 服务 = new 假服务({ visionPrefs: { localDescribe: true } })
  服务.visionDescribe = async () => ({ ok: false, code: 'busy', hint: '本地 AI 正忙' })
  const { bridge } = 建图片桥(dir, 服务)
  const 内容 = await bridge.buildInbound({ qq: QQ, name: '主人' }, 图片消息('m-img-8'))
  assert.equal(内容.images.length, 1)
  assert.match(内容.text, /\[图片\]/)
})

test('入站图片：没有本地 AI 插件时按原样递图', async () => {
  const dir = 临时目录()
  const { bridge } = 建图片桥(dir, null)
  const 内容 = await bridge.buildInbound({ qq: QQ, name: '主人' }, 图片消息('m-img-9'))
  assert.equal(内容.images.length, 1)
  assert.match(内容.text, /\[图片\]/)
})

test('出站 [语音:路径]：照常发已有音频文件，不合成', async () => {
  const dir = 临时目录()
  const 音频 = join(dir, 'a.wav')
  writeFileSync(音频, 造wav(0.2))
  const { bridge, transport } = 建桥({ dir })
  const 结果 = await bridge.deliverAssistantTurn(会话, `[QQ][语音:${音频}][/QQ]`)
  assert.equal(结果.ok, true)
  assert.equal(transport.sent.length, 1)
  assert.equal(transport.sent[0].segments[0].type, 'record')
  assert.equal(transport.sent[0].segments[0].data.file, 音频.replace(/\\/g, '/'))
})

test('旧配置：布尔识图开关迁移成三态（true→on，false→off，缺失→inherit）', () => {
  const 读 = (内容) => {
    const dir = 临时目录()
    writeFileSync(join(dir, 'fish-message-config.json'), JSON.stringify(内容), 'utf8')
    return new ConfigStore({ homeDir: dir }).load({})
  }
  assert.equal(读({ describeInboundImages: true }).describeInboundImages, 'on')
  assert.equal(读({ describeInboundImages: false }).describeInboundImages, 'off')
  assert.equal(读({}).describeInboundImages, 'inherit')
  // 已经是三态的配置原样读回
  assert.equal(读({ describeInboundImages: 'off' }).describeInboundImages, 'off')

  // 新增的识图提示词：旧配置缺字段 → 补空串（用内置默认）；非法值也回退默认。
  assert.equal(读({}).inboundImagePrompt, '')
  assert.equal(读({ inboundImagePrompt: 123 }).inboundImagePrompt, '')
  assert.equal(读({ inboundImagePrompt: '长'.repeat(4001) }).inboundImagePrompt, '')
  assert.equal(读({ inboundImagePrompt: '  自定义提示  ' }).inboundImagePrompt, '自定义提示')
})

test('旧配置：残留的 ASR/TTS 字段被静默忽略并从落盘文件清理', () => {
  const dir = 临时目录()
  const 文件 = join(dir, 'fish-message-config.json')
  writeFileSync(文件, JSON.stringify({
    napcatBaseUrl: 'http://127.0.0.1:3000',
    bindings: [{ qq: QQ, session: 会话, name: '主人', enabled: true }],
    transcriptionEnabled: false,
    asrBaseUrl: 'http://127.0.0.1:9999',
    asrCommand: 'python asr.py "{file}"',
    asrTimeoutMs: 1,
    ttsEnabled: false,
    ttsBaseUrl: 'http://127.0.0.1:9999',
    ttsVoice: '旧音色',
    ttsTimeoutMs: 1,
  }), 'utf8')

  const 配置 = new ConfigStore({ homeDir: dir }).load({})
  for (const 键 of 已移除的语音字段) assert.equal(键 in 配置, false, `内存配置不应再有 ${键}`)
  assert.equal(配置.napcatBaseUrl, 'http://127.0.0.1:3000')
  assert.equal(配置.bindings.length, 1)

  // 加载时静默清理：文件还在，但旧键没了，其它设置原样保留。
  const 盘 = JSON.parse(readFileSync(文件, 'utf8'))
  for (const 键 of 已移除的语音字段) assert.equal(键 in 盘, false, `落盘配置不应再有 ${键}`)
  assert.equal(盘.bindings[0].qq, QQ)

  // 外部命令等旧键即使通过插件配置传进来，也只是被忽略，不报错。
  const 再读 = new ConfigStore({ homeDir: 临时目录() }).load({ ttsVoice: 'x', asrCommand: 'y' })
  assert.equal('ttsVoice' in 再读, false)
  assert.equal('asrCommand' in 再读, false)
})

// ---------------- 暂停转发：待转发队列 ----------------

test('暂停转发：消息照常接收并记统计，但一条都不投进会话', async () => {
  const 现在 = Math.floor(Date.now() / 1000)
  const { dir, bridge, delivery, transport, 配置, store } = 建桥()
  配置.forwardPaused = true
  bridge.updateConfig()
  await bridge.start({ syncNow: false })
  for (const [i, 文] of ['暂停一', '暂停二', '暂停三'].entries()) {
    transport.emit({ post_type: 'message', message_type: 'private', ...建消息(60 + i, 文, 现在 - 10 + i) })
  }
  await 睡(120)

  assert.equal(delivery.got.length, 0, '暂停期间不能投进 DSH 会话')
  const 态 = bridge.state()
  assert.equal(态.forward.paused, true)
  assert.equal(态.forward.pending, 3)
  assert.equal(态.stats.received, 3, '统计照常记「已收到」')
  assert.equal(态.stats.delivered, 0, '暂停期间不算「已转达」')
  assert.ok(store.getWatermark(QQ).timestamp >= 现在 - 10, '水位照常推进，不会重复收')
  assert.equal(new ForwardQueue({ homeDir: dir }).pending(), 3, '待转发队列要落盘')
  await bridge.stop()
})

test('恢复转发：暂停期间的 3 条按原顺序补发，不重复', async () => {
  const 现在 = Math.floor(Date.now() / 1000)
  const { bridge, delivery, transport, 配置 } = 建桥()
  配置.forwardPaused = true
  bridge.updateConfig()
  await bridge.start({ syncNow: false })
  for (const [i, 文] of ['第一', '第二', '第三'].entries()) {
    transport.emit({ post_type: 'message', message_type: 'private', ...建消息(70 + i, 文, 现在 - 10 + i) })
  }
  await 睡(120)
  assert.equal(delivery.got.length, 0)

  配置.forwardPaused = false
  bridge.updateConfig()
  assert.equal(await 等(() => delivery.got.length === 3), true, '恢复后应自动补发')
  assert.deepEqual(delivery.got.map((x) => x.text), ['第一', '第二', '第三'])
  assert.equal(bridge.state().forward.pending, 0)
  assert.equal(bridge.state().stats.delivered, 3)

  // 再补一次不会重复
  await bridge.flushForwardQueue('again')
  await 睡(30)
  assert.equal(delivery.got.length, 3, '补发过的消息不能再来一次')
  await bridge.stop()
})

test('暂停时重启：待转发队列从磁盘读回，恢复后照常补发', async () => {
  const 现在 = Math.floor(Date.now() / 1000)
  const dir = 临时目录()
  const 第一 = 建桥({ dir, config: { forwardPaused: true } })
  await 第一.bridge.start({ syncNow: false })
  for (const [i, 文] of ['重启一', '重启二', '重启三'].entries()) {
    第一.transport.emit({ post_type: 'message', message_type: 'private', ...建消息(80 + i, 文, 现在 - 10 + i) })
  }
  await 睡(120)
  assert.equal(第一.bridge.state().forward.pending, 3)
  assert.equal(第一.delivery.got.length, 0)
  await 第一.bridge.stop()

  // 新实例用同一个目录（同一个状态文件），暂停标记还在。
  const 第二 = 建桥({ dir, config: { forwardPaused: true } })
  assert.equal(第二.bridge.state().forward.pending, 3, '重启后待转发队列还在')
  await 第二.bridge.start({ syncNow: false })
  assert.equal(第二.delivery.got.length, 0, '还在暂停，不补发')

  第二.配置.forwardPaused = false
  第二.bridge.updateConfig()
  assert.equal(await 等(() => 第二.delivery.got.length === 3), true)
  assert.deepEqual(第二.delivery.got.map((x) => x.text), ['重启一', '重启二', '重启三'])
  await 第二.bridge.stop()
})

test('待转发消息过期：恢复时不补发，只提示一句数量', async () => {
  const 现在 = Math.floor(Date.now() / 1000)
  const dir = 临时目录()
  const forwardQueue = new ForwardQueue({ homeDir: dir, ttlMs: 30 })
  const { bridge, delivery, transport, 配置 } = 建桥({ dir, forwardQueue })
  配置.forwardPaused = true
  bridge.updateConfig()
  await bridge.start({ syncNow: false })
  for (const [i, 文] of ['过期一', '过期二', '过期三'].entries()) {
    transport.emit({ post_type: 'message', message_type: 'private', ...建消息(90 + i, 文, 现在 - 10 + i) })
  }
  await 睡(150)

  配置.forwardPaused = false
  bridge.updateConfig()
  assert.equal(await 等(() => delivery.got.length >= 1), true)
  await 睡(60)
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

  const dir = 临时目录()
  const 保存 = new ConfigStore({ homeDir: dir }).save({ forwardPaused: true, bindings: [] })
  assert.equal(保存.forwardPaused, true)
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

  const dir = 临时目录()
  const 保存 = new ConfigStore({ homeDir: dir }).save({
    guardEnabled: false, guardStuckSeconds: 1500, guardQqFallback: true, bindings: [],
  })
  assert.equal(保存.guardEnabled, false)
  assert.equal(保存.guardStuckSeconds, 1500)
  assert.equal('guardQqFallback' in 保存, false, '旧字段不会写回')
  const 读回 = new ConfigStore({ homeDir: dir }).load({})
  assert.equal(读回.guardEnabled, false)
  assert.equal('guardQqFallback' in 读回, false)
  assert.equal(publicConfig({ guardEnabled: false }).guardEnabled, false)
})

/** 防失联测试用：可控时钟 + 一个绑定会话。 */
function 建监控(配置 = { guardStuckSeconds: 600 }) {
  const 钟 = { 现在: 1_000_000 }
  const 监控 = new GuardMonitor({ now: () => 钟.现在, getConfig: () => 配置 })
  // 标题表按会话 id（去掉 session- 前缀）索引，和 GuardMonitor 内部一致。
  监控.设绑定([{ qq: QQ, session: 会话, name: '主人', enabled: true }], new Map([['test-0001', '测试会话']]))
  return { 钟, 监控, 配置 }
}

/** 过完回合判定的宽限，再跳一次心跳：把延后的「发没发 QQ」判定推到出结果。 */
function 过宽限(钟, 监控) {
  钟.现在 += 回合判定宽限毫秒 + 1
  return 监控.tick()
}

/**
 * 走一个完整回合：turn/start → 若干工具步（每个模型步一条 assistant/message）→ turn/end，
 * 再走完宽限，把心跳给出的判定结果一起返回。
 * 发QQ 为真时在回合中间模拟一次 QQ 出站。
 */
function 走一回合(钟, 监控, turn, { 工具步 = 1, 发QQ = false } = {}) {
  监控.处理事件(会话, { type: 'turn/start', data: { turn } })
  for (let i = 0; i < 工具步; i += 1) {
    监控.处理事件(会话, { type: 'assistant/message', data: { turn, step: i + 1 } })
  }
  if (发QQ) 监控.记QQ出站(QQ)
  const 动作们 = 监控.处理事件(会话, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  return [...动作们, ...过宽限(钟, 监控)]
}

test('防失联监控：超时只塞一次，之后不再打扰', () => {
  const { 钟, 监控 } = 建监控()
  监控.跟踪状态(会话, 'running')
  assert.equal(监控.是绑定(会话), true, '原样会话 id 能认出来')
  assert.equal(监控.是绑定('test-0001'), true, '去掉 session- 前缀也能认出来')

  // 9 分钟：还没到阈值。
  钟.现在 += 9 * 60000
  assert.deepEqual(监控.tick(), [])

  // 11 分钟：第一条提醒（也是这一轮唯一的一条）。
  钟.现在 += 2 * 60000
  const 第一次 = 监控.tick()
  assert.equal(第一次.length, 1)
  assert.equal(第一次[0].kind, 'remind')
  assert.equal(第一次[0].text, 默认长任务提醒文案, '默认长任务提醒文案原文')

  // 之后不管多久都不再塞：塞进去也只是排队，等模型跑完还要多花时间处理。
  钟.现在 += 9 * 60000
  assert.deepEqual(监控.tick(), [])
  钟.现在 += 30 * 60000
  assert.deepEqual(监控.tick(), [])
  钟.现在 += 60 * 60000
  assert.deepEqual(监控.tick(), [])

  const 快照 = 监控.快照()
  assert.equal(快照.bound, 1)
  assert.equal(快照.alerts.length, 1)
  assert.equal(快照.alerts[0].title, '测试会话')
  assert.equal(快照.alerts[0].injections, 1)
})

test('防失联监控：提醒进入会话后才重新计时，和 QQ 出站无关', () => {
  const { 钟, 监控 } = 建监控()
  监控.跟踪状态(会话, 'running')
  钟.现在 += 11 * 60000
  assert.equal(监控.tick().length, 1)

  // 提醒还排在会话外面：不管过多久、QQ 发没发出去，都别再塞、也别重置。
  监控.记QQ出站(QQ)
  钟.现在 += 30 * 60000
  assert.deepEqual(监控.tick(), [])

  // 下一条 assistant 消息说明提醒已经进了会话：从这一刻重新计时。
  监控.处理事件(会话, { type: 'assistant/message', data: { turn: 1 } })
  assert.equal(监控.快照().alerts.length, 0)
  钟.现在 += 11 * 60000
  const 再提醒 = 监控.tick()
  assert.equal(再提醒.length, 1)
  assert.equal(再提醒[0].kind, 'remind')
  assert.equal(监控.快照().alerts[0].injections, 1)
})

test('防失联监控：按运行时长算，中途有进展也不重新计时', () => {
  const { 钟, 监控 } = 建监控()
  监控.跟踪状态(会话, 'running')

  // 9 分钟时模型还在输出：这算进展，但不算「会话能收到消息」，计时不重置。
  钟.现在 += 9 * 60000
  监控.处理事件(会话, { type: 'assistant/message', data: { turn: 1 } })
  assert.deepEqual(监控.tick(), [])

  // 再过 2 分钟（开跑 11 分钟）：照样提醒——这一轮还在跑，QQ 那边一直收不到回复。
  钟.现在 += 2 * 60000
  const 第一次 = 监控.tick()
  assert.equal(第一次.length, 1)
  assert.equal(第一次[0].kind, 'remind')
  assert.equal(第一次[0].seconds, 660)
  assert.equal(第一次[0].text, 默认长任务提醒文案, '默认长任务提醒文案原文')
})

test('防失联监控：提醒没送进去就退回，下个心跳重试', () => {
  const { 钟, 监控 } = 建监控()
  监控.跟踪状态(会话, 'running')
  钟.现在 += 11 * 60000
  assert.equal(监控.tick().length, 1)

  // 宿主正忙、注入被拒：这一次不算数，下一个心跳还能再塞。
  监控.记注入失败(会话)
  钟.现在 += 60000
  const 重试 = 监控.tick()
  assert.equal(重试.length, 1)
  assert.equal(重试[0].kind, 'remind')
})

test('防失联监控：一轮结束后进入新一轮才重新计时', () => {
  const { 钟, 监控 } = 建监控()
  监控.跟踪状态(会话, 'running')
  钟.现在 += 11 * 60000
  assert.equal(监控.tick().length, 1)

  // 这一轮里已经塞过一条：之后不再有任何动作。
  钟.现在 += 60 * 60000
  assert.deepEqual(监控.tick(), [])
  assert.equal(监控.快照().alerts[0].injections, 1)

  // 这一轮结束、下一轮开始：重新计数。
  监控.处理事件(会话, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  监控.跟踪状态(会话, 'idle')
  监控.跟踪状态(会话, 'running')
  钟.现在 += 11 * 60000
  const 再提醒 = 监控.tick()
  assert.equal(再提醒.length, 1)
  assert.equal(再提醒[0].kind, 'remind')
  assert.equal(监控.快照().alerts[0].injections, 1)
})

test('防失联监控：回合结束后清掉告警', () => {
  const { 钟, 监控 } = 建监控()
  监控.跟踪状态(会话, 'running')
  钟.现在 += 30 * 60000
  assert.equal(监控.tick().filter((a) => a.kind === 'remind').length, 1)
  assert.equal(监控.快照().alerts.length, 1)

  // 这一轮正常结束：告警清掉。
  监控.处理事件(会话, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(监控.快照().alerts.length, 0)
})

test('防失联监控：会话空闲时不打扰', () => {
  const { 钟, 监控 } = 建监控()
  监控.跟踪状态(会话, 'idle')
  钟.现在 += 120 * 60000
  assert.deepEqual(监控.tick(), [], '空闲是在等用户说话，不算卡住')
  assert.equal(监控.快照().alerts.length, 0)
})

test('防失联监控：回合被中断立即提醒，短时间内不重复', () => {
  const { 钟, 监控 } = 建监控()
  监控.跟踪状态(会话, 'running')
  const 第一次 = 监控.处理事件(会话, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
  assert.equal(第一次.length, 1)
  assert.equal(第一次[0].reason, 'interrupted')
  assert.match(第一次[0].text, /被中断/)

  // 5 分钟后又中断一次：不该再提醒。
  钟.现在 += 5 * 60000
  assert.deepEqual(监控.处理事件(会话, { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } }), [])

  // 正常结束：算恢复。
  监控.处理事件(会话, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  assert.equal(监控.快照().alerts.length, 0)
})

test('防失联监控：只盯启用的绑定会话', () => {
  const { 钟, 监控 } = 建监控()
  监控.跟踪状态('session-别的会话', 'running')
  钟.现在 += 60 * 60000
  assert.deepEqual(监控.tick(), [])
  assert.equal(监控.快照().bound, 1)
  assert.equal(监控.快照().alerts.length, 0, '没绑定的会话不进监控')

  // 关掉绑定后，状态跟着清掉。
  监控.设绑定([{ qq: QQ, session: 会话, name: '主人', enabled: false }], new Map([[会话, '测试会话']]))
  assert.equal(监控.是绑定(会话), false)
  assert.equal(监控.快照().bound, 0)
})

test('防失联工具守卫：挡住会等人的工具（提问/干等），不挡插件装卸', () => {
  const 守卫 = 构造工具守卫()
  for (const 名 of 拒用工具) {
    const 结果 = 守卫({ name: 名 })
    assert.equal(typeof 结果, 'string')
    assert.match(结果, /不能用/)
    assert.match(结果, /QQ/)
  }
  assert.match(守卫({ name: 'ask_user_question' }), /ask_user_question/)
  assert.match(守卫({ name: 'wait_agent' }), /wait_agent/)
  assert.match(守卫({ name: 'wait_agent' }), /唤醒/)
  assert.equal(守卫({ name: 'plugin_manager' }), undefined, '插件装卸不再拦')
  assert.equal(守卫({ name: 'web_search' }), undefined)
  assert.equal(守卫(null), undefined)
  assert.equal(守卫({}), undefined)
  // 提示词只留代码管不到的约定：回复走 [QQ] 块、拍板发 QQ、长任务派子代理。
  assert.match(守卫规则, /子代理/)
  assert.match(守卫规则, /\[QQ\]/)
  assert.match(守卫规则, /用户/)
  assert.doesNotMatch(守卫规则, /主人/, '用通用称呼，不带个人设定')
  assert.ok(守卫规则.split('\n').length <= 5, '短提示：最多 5 句')
  // 下面这些由机制保证，提示词里不再重复（同一条规矩只留一处出处）：
  // 拒用工具 → 工具守卫；审批 → 策略 never；[QQ] 出站 → 桥只投递块内内容。
  assert.doesNotMatch(守卫规则, /ask_user_question|wait_agent/)
  assert.doesNotMatch(守卫规则, /send_message/)
  assert.doesNotMatch(守卫规则, /卸载\/重装|dsh_restart/, '重启工具由独立插件提供，不一定存在')
})

test('防失联：按回合计数，一个回合里 5 个 assistant/message 只算 1 轮', () => {
  const { 钟, 监控 } = 建监控({ guardStuckSeconds: 600, guardQqRemindTurns: 3 })

  // 一个回合里 5 个模型步（工具调用）都发 assistant/message，但最后没发 QQ：只计 1 轮。
  assert.deepEqual(走一回合(钟, 监控, 1, { 工具步: 5 }), [])
  // 第 2 个回合：仍不到阈值。按模型步算的话这里已经该提醒一次了。
  assert.deepEqual(走一回合(钟, 监控, 2, { 工具步: 5 }), [])

  // 第 3 个回合：满 3 轮才提醒，轮数是回合数，不是模型步数。
  const 提醒们 = 走一回合(钟, 监控, 3, { 工具步: 5 })
  assert.equal(提醒们.length, 1)
  assert.equal(提醒们[0].kind, 'remind')
  assert.equal(提醒们[0].reason, 'no-qq')
  assert.equal(提醒们[0].turns, 3, '三个回合，而不是十五个模型步')
  assert.equal(提醒们[0].text, 默认消息通道提醒文案, '默认消息通道提醒文案原文')
})

test('防失联：回合里发过 QQ 就清零，不提醒', () => {
  const { 钟, 监控 } = 建监控({ guardStuckSeconds: 600, guardQqRemindTurns: 3 })
  assert.deepEqual(走一回合(钟, 监控, 1), [])
  assert.deepEqual(走一回合(钟, 监控, 2), [])

  // 第 3 个回合发过 QQ：不算「没发 QQ」的回合，计数清零。
  assert.deepEqual(走一回合(钟, 监控, 3, { 工具步: 5, 发QQ: true }), [])

  // 之后从头攒：还要 3 个没发 QQ 的回合才提醒。
  assert.deepEqual(走一回合(钟, 监控, 4), [])
  assert.deepEqual(走一回合(钟, 监控, 5), [])
  const 提醒们 = 走一回合(钟, 监控, 6)
  assert.equal(提醒们.length, 1)
  assert.equal(提醒们[0].reason, 'no-qq')
  assert.equal(提醒们[0].turns, 3, '发过 QQ 的那一轮不计入')
})

test('防失联：新回合开始（agent/status 进入 running）也复位本回合 QQ 标记', () => {
  const { 钟, 监控 } = 建监控({ guardStuckSeconds: 600, guardQqRemindTurns: 2 })
  监控.跟踪状态(会话, 'running')
  // 上一回合末发过 QQ：标记为真。
  监控.记QQ出站(QQ)
  监控.跟踪状态(会话, 'idle')
  // 新回合开始：即使没有 turn/start 事件，标记也要复位，这一回合没发 QQ 就算 1 轮。
  监控.跟踪状态(会话, 'running')
  assert.deepEqual(走一回合(钟, 监控, 1), [])
  const 提醒们 = 走一回合(钟, 监控, 2)
  assert.equal(提醒们.length, 1)
  assert.equal(提醒们[0].turns, 2)
})

test('防失联：没发 QQ 的提醒 15 分钟内不重复', () => {
  const { 钟, 监控 } = 建监控({ guardStuckSeconds: 600, guardQqRemindTurns: 3 })
  for (let turn = 1; turn <= 3; turn += 1) {
    const 结果 = 走一回合(钟, 监控, turn)
    if (turn === 3) {
      assert.equal(结果.length, 1)
      assert.equal(结果[0].reason, 'no-qq')
    }
  }

  // 提醒注入后会作为一条 user 消息开启新回合；这段时间里再攒满也不重复提醒。
  for (let turn = 4; turn <= 6; turn += 1) {
    assert.deepEqual(走一回合(钟, 监控, turn), [])
  }

  // 过了 15 分钟才允许再提醒。
  钟.现在 += 16 * 60000
  const 再提醒 = 走一回合(钟, 监控, 7)
  assert.equal(再提醒.length, 1)
  assert.equal(再提醒[0].reason, 'no-qq')
  assert.ok(再提醒[0].turns >= 3)
})

test('防失联：turn/end 之后才发 QQ（桥的投递晚一步）不算这一回合没发', () => {
  const { 钟, 监控 } = 建监控({ guardStuckSeconds: 600, guardQqRemindTurns: 2 })
  监控.处理事件(会话, { type: 'turn/start', data: { turn: 1 } })
  监控.处理事件(会话, { type: 'assistant/message', data: { turn: 1, step: 1 } })
  assert.deepEqual(
    监控.处理事件(会话, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
    [],
    'turn/end 那一刻不判定，只记下待判定',
  )
  // 桥正是在 turn/end 之后才把 [QQ] 投出去的：1 秒后出站事件才到。
  钟.现在 += 1000
  监控.记QQ出站(QQ)
  assert.deepEqual(过宽限(钟, 监控), [], '出站已经记账，宽限过后不该提醒')
  const st = 监控.取状态(会话)
  assert.equal(st.qq回合, 0, '这一回合算发过 QQ，不计数')
  assert.equal(st.待判定回合, false, '出站到了就消掉待判定，不必再等宽限')
  assert.equal(st.本回合发过QQ, true, '出站记在「本回合」上，由下一个 turn/start 复位')
})

test('防失联：turn/end 后一直没出站，宽限过了才计一轮', () => {
  const { 钟, 监控 } = 建监控({ guardStuckSeconds: 600, guardQqRemindTurns: 3 })
  监控.处理事件(会话, { type: 'turn/start', data: { turn: 1 } })
  监控.处理事件(会话, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  // 宽限还没到：不判定、不计数。
  assert.deepEqual(监控.tick(), [])
  assert.equal(监控.取状态(会话).qq回合, 0)

  assert.deepEqual(过宽限(钟, 监控), [], '1 轮还没到 3 轮的阈值')
  assert.equal(监控.取状态(会话).qq回合, 1, '宽限过后按「没发 QQ」计 1 轮')

  // 同一个回合不会被重复计：再跳心跳也不涨。
  钟.现在 += 回合判定宽限毫秒
  assert.deepEqual(监控.tick(), [])
  assert.equal(监控.取状态(会话).qq回合, 1)
})

test('防失联：连续 3 个正常发 QQ 的回合，永不误提醒', () => {
  // 阈值调到 1：只要误判一次就会立刻提醒，这样「没误报」才有说服力。
  const { 钟, 监控 } = 建监控({ guardStuckSeconds: 600, guardQqRemindTurns: 1 })
  for (let turn = 1; turn <= 3; turn += 1) {
    监控.处理事件(会话, { type: 'turn/start', data: { turn } })
    监控.处理事件(会话, { type: 'assistant/message', data: { turn, step: 1 } })
    assert.deepEqual(监控.处理事件(会话, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }), [])
    // 桥在 turn/end 之后才投递 [QQ]：1 秒后出站。
    钟.现在 += 1000
    监控.记QQ出站(QQ)
    assert.deepEqual(过宽限(钟, 监控), [], `第 ${turn} 个正常回合不该提醒`)
    assert.equal(监控.取状态(会话).qq回合, 0, `第 ${turn} 个正常回合不该计数`)
  }
  // 再跑两个也一样：误计数不会攒起来。
  for (let turn = 4; turn <= 5; turn += 1) {
    监控.处理事件(会话, { type: 'turn/start', data: { turn } })
    监控.处理事件(会话, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    钟.现在 += 1000
    监控.记QQ出站(QQ)
    assert.deepEqual(过宽限(钟, 监控), [])
  }
})

test('防失联：宽限内来新回合，旧回合按当时状态判掉，不串味', () => {
  const { 钟, 监控 } = 建监控({ guardStuckSeconds: 600, guardQqRemindTurns: 3 })
  const st = () => 监控.取状态(会话)

  // 第 1 回合没发 QQ，turn/end 后 1 秒用户就说话了（宽限还没走完）。
  监控.处理事件(会话, { type: 'turn/start', data: { turn: 1 } })
  监控.处理事件(会话, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  钟.现在 += 1000
  assert.deepEqual(监控.处理事件(会话, { type: 'turn/start', data: { turn: 2 } }), [])
  assert.equal(st().qq回合, 1, '旧回合按「没发 QQ」当场判掉')
  assert.equal(st().待判定回合, false, '旧回合的待判定已经消掉')

  // 新回合发了 QQ：出站说明通道是通的，计数清零；旧回合的待判定不会拖到这时候才判。
  钟.现在 += 500
  监控.记QQ出站(QQ)
  监控.处理事件(会话, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.deepEqual(过宽限(钟, 监控), [])
  assert.equal(st().qq回合, 0, '发过 QQ 的回合清零')
  assert.equal(st().本回合发过QQ, false, '新回合的出站不会挂在旧回合上')
  assert.equal(st().待判定回合, false)

  // 反过来：旧回合发过 QQ，宽限内来新回合 → 按「发过」判掉，不会误计一轮。
  监控.处理事件(会话, { type: 'turn/start', data: { turn: 3 } })
  监控.记QQ出站(QQ)
  监控.处理事件(会话, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  钟.现在 += 1000
  监控.处理事件(会话, { type: 'turn/start', data: { turn: 4 } })
  assert.equal(st().qq回合, 0, '发过 QQ 的旧回合不计数')
  assert.deepEqual(过宽限(钟, 监控), [])
})

test('防失联：提醒注入开出的新回合不会连着再提醒', () => {
  const { 钟, 监控 } = 建监控({ guardStuckSeconds: 600, guardQqRemindTurns: 1 })
  const 第一次 = 走一回合(钟, 监控, 1)
  assert.equal(第一次.length, 1)
  assert.equal(第一次[0].reason, 'no-qq', '第一个回合该提醒一次')

  // 提醒会作为一条 user 消息开新回合：没发 QQ 照旧计一轮，但 15 分钟内不再注入。
  for (let turn = 2; turn <= 4; turn += 1) {
    assert.deepEqual(走一回合(钟, 监控, turn), [], `第 ${turn} 个回合不再注入`)
  }
})

test('防失联：没发 QQ 提醒轮数可配置，钳制 1~50 且能保存读回', () => {
  assert.equal(normalizeConfig({}).guardQqRemindTurns, 3)
  assert.equal(normalizeConfig({ guardQqRemindTurns: 0 }).guardQqRemindTurns, 1)
  assert.equal(normalizeConfig({ guardQqRemindTurns: 99 }).guardQqRemindTurns, 50)
  assert.equal(normalizeConfig({ guardQqRemindTurns: '5' }).guardQqRemindTurns, 5)

  const 目录 = 临时目录()
  const 存 = new ConfigStore({ homeDir: 目录 })
  assert.ok(存.save({ ...normalizeConfig({}), guardQqRemindTurns: 5 }))
  assert.equal(存.load().guardQqRemindTurns, 5)
})

test('防失联：两条提醒默认用内置文案，自定义文案原样生效', () => {
  // 默认：设置里留空 → 内置原文。
  const 默认 = 建监控({ guardStuckSeconds: 600, guardQqRemindTurns: 3 })
  默认.监控.跟踪状态(会话, 'running')
  默认.钟.现在 += 11 * 60000
  assert.equal(默认.监控.tick()[0].text, 默认长任务提醒文案)
  const 默认通道 = 建监控({ guardStuckSeconds: 600, guardQqRemindTurns: 3 })
  走一回合(默认通道.钟, 默认通道.监控, 1)
  走一回合(默认通道.钟, 默认通道.监控, 2)
  assert.equal(走一回合(默认通道.钟, 默认通道.监控, 3)[0].text, 默认消息通道提醒文案)

  // 自定义：首尾空格去掉后用自定义文案。
  const 自定义 = 建监控({
    guardStuckSeconds: 600,
    guardQqRemindTurns: 3,
    guardStuckPrompt: '  自定义长任务提醒  ',
    guardQqPrompt: '自定义消息通道提醒',
  })
  自定义.监控.跟踪状态(会话, 'running')
  自定义.钟.现在 += 11 * 60000
  assert.equal(自定义.监控.tick()[0].text, '自定义长任务提醒')
  走一回合(自定义.钟, 自定义.监控, 1)
  走一回合(自定义.钟, 自定义.监控, 2)
  assert.equal(走一回合(自定义.钟, 自定义.监控, 3)[0].text, '自定义消息通道提醒')

  // 工具函数本身：空串/空格回落默认。
  assert.equal(长任务提醒文本({}), 默认长任务提醒文案)
  assert.equal(长任务提醒文本({ guardStuckPrompt: '   ' }), 默认长任务提醒文案)
  assert.equal(长任务提醒文本({ guardStuckPrompt: '自定' }), '自定')
  assert.equal(消息通道提醒文本({ guardQqPrompt: '' }), 默认消息通道提醒文案)
  assert.equal(消息通道提醒文本({ guardQqPrompt: '通道' }), '通道')
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

  const 目录 = 临时目录()
  const 存 = new ConfigStore({ homeDir: 目录 })
  assert.ok(存.save({ ...normalizeConfig({}), guardStuckPrompt: '保存长任务', guardQqPrompt: '保存通道' }))
  const 读回 = 存.load()
  assert.equal(读回.guardStuckPrompt, '保存长任务')
  assert.equal(读回.guardQqPrompt, '保存通道')
})
