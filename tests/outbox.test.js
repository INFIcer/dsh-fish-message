import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Outbox, calcFingerprint, messageDigest, backoffMs } from '../lib/outbox.js'
import { Bridge } from '../lib/bridge.js'
import { StateStore } from '../lib/storage.js'
import { Logger } from '../lib/logger.js'
import { normalizeConfig } from '../lib/config.js'

const QQ = '10001'
const session = 'session-outbox-test'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'fish-outbox-'))
}

function makeQueue({ dir = tempDir(), config = {}, maxItems, ttlMs, dedupMs, now } = {}) {
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'outbox.log'), level: 'debug' })
  const cfg = normalizeConfig({ outboxTtlHours: 24, outboxDedupMinutes: 10, ...config })
  const queue = new Outbox({
    homeDir: dir,
    getConfig: () => cfg,
    logger,
    store,
    maxItems,
    ttlMs,
    dedupMs,
    ...(now ? { now } : {}),
  })
  return { dir, store, logger, cfg, queue }
}

const textSegment = (text) => [{ type: 'text', data: { text: text } }]

test('出站队列：落盘结构、重启后恢复、字段完整', () => {
  const dir = tempDir()
  let time = 1_800_000_000_000
  const first = makeQueue({ dir, now: () => time })
  first.queue.enqueue({ qq: QQ, segments: textSegment('离线时发的'), reason: '模拟断网' })
  assert.equal(first.queue.pending(), 1)

  const disk = JSON.parse(readFileSync(join(dir, 'fish-message-outbox.json'), 'utf8'))
  assert.equal(disk.version, 1)
  assert.equal(disk.items.length, 1)
  for (const key of ['id', 'qq', 'segments', 'createdAt', 'attempts', 'nextAttemptAt', 'expiresAt', 'reason', 'fingerprint']) {
    assert.ok(key in disk.items[0], `条目缺少字段 ${key}`)
  }
  assert.equal(disk.items[0].qq, QQ)
  assert.equal(disk.items[0].attempts, 0)

  const second = makeQueue({ dir, now: () => time })
  assert.equal(second.queue.pending(), 1)
  assert.deepEqual(second.queue.list()[0].segments, textSegment('离线时发的'))
})

test('出站队列：相同 fingerprint 在去重窗口内只留一条，窗口过了可以再入队', () => {
  let time = 1_800_000_000_000
  const { queue } = makeQueue({ now: () => time })
  const a = queue.enqueue({ qq: QQ, segments: textSegment('重复的消息') })
  const b = queue.enqueue({ qq: QQ, segments: textSegment('重复的消息') })
  assert.equal(a.deduped, false)
  assert.equal(b.deduped, true)
  assert.equal(queue.pending(), 1)
  assert.equal(a.item.fingerprint, b.item.fingerprint)

  queue.enqueue({ qq: QQ, segments: textSegment('另一条') })
  assert.equal(queue.pending(), 2)

  time += 11 * 60 * 1000
  queue.enqueue({ qq: QQ, segments: textSegment('重复的消息') })
  assert.equal(queue.pending(), 3, '超过 10 分钟，同样内容可以再次入队')
})

test('出站队列：fingerprint 与 data 键顺序无关，QQ 不同则不同', () => {
  const a = calcFingerprint(QQ, [{ type: 'image', data: { path: 'C:/a.png', name: 'a' } }])
  const b = calcFingerprint(QQ, [{ type: 'image', data: { name: 'a', path: 'C:/a.png' } }])
  assert.equal(a, b)
  assert.notEqual(a, calcFingerprint('10002', [{ type: 'image', data: { path: 'C:/a.png', name: 'a' } }]))
  assert.match(messageDigest([{ type: 'record_text', data: { text: '晚安' } }]), /\[语音\] 晚安/)
})

test('出站队列：超过 maxItems 丢最旧并计数', () => {
  let time = 1_800_000_000_000
  const { queue } = makeQueue({ maxItems: 3, now: () => time })
  for (let i = 0; i < 4; i++) {
    time += 1000
    queue.enqueue({ qq: QQ, segments: textSegment(`第 ${i} 条`) })
  }
  assert.equal(queue.pending(), 3)
  assert.equal(queue.list()[0].segments[0].data.text, '第 1 条', '最旧的「第 0 条」应被丢掉')
  assert.equal(queue.status().droppedTotal, 1)
})

test('出站队列：TTL 过期丢弃，计入 droppedTotal', () => {
  let time = 1_800_000_000_000
  const { queue } = makeQueue({ ttlMs: 1000, now: () => time })
  queue.enqueue({ qq: QQ, segments: textSegment('会过期') })
  assert.equal(queue.pending(), 1)
  time += 1200
  const dropCount = queue.expire()
  assert.equal(dropCount, 1)
  assert.equal(queue.pending(), 0)
  assert.equal(queue.status().droppedTotal, 1)
})

test('出站队列：退避公式 5s * 1.8^attempts 封顶 300s，20 次后放弃', () => {
  assert.equal(backoffMs(1), 9000)
  assert.equal(backoffMs(2), 16200)
  assert.equal(backoffMs(10), 300000)

  let time = 1_800_000_000_000
  const { queue } = makeQueue({ now: () => time })
  const { item } = queue.enqueue({ qq: QQ, segments: textSegment('一直失败') })
  const one = queue.markFailed(item.id, '模拟失败', time)
  assert.equal(one.delayMs, 9000)
  assert.equal(queue.list()[0].nextAttemptAt, time + 9000)
  assert.equal(queue.status().failedTotal, 1)

  for (let i = 2; i <= 20; i++) {
    const r = queue.markFailed(item.id, `第 ${i} 次失败`, time)
    if (i < 20) assert.equal(r.dropped, false)
    else {
      assert.equal(r.dropped, true)
      assert.equal(r.attempts, 20)
    }
  }
  assert.equal(queue.pending(), 0)
  assert.equal(queue.status().droppedTotal, 1)
})

// ---------------- Bridge 集成：离线入队 → 恢复补发 ----------------

class fakeTransport {
  constructor() {
    this.sent = []
    this.fail = true
    this.handlers = null
    this.status = { name: 'fake', connected: false, mode: 'http' }
  }
  async start(handlers) { this.handlers = handlers; handlers.onStatus(this.status) }
  async stop() {}
  async sendMessage(peer, segments) {
    if (this.fail) throw new Error('模拟 QQ 离线')
    this.sent.push({ peer: String(peer), segments })
    return { message_id: this.sent.length }
  }
  async fetchHistory() { return [] }
  getStatus() { return this.status }
}

class fakeDeliver {
  async deliver() { return { ok: true } }
  async attachmentPath() { return '' }
}

class fakeVoice {
  async fetchImage() { throw new Error('测试不下载图片') }
}

function makeBridge({ dir = tempDir(), config = {} } = {}) {
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'bridge.log'), level: 'debug' })
  const transport = new fakeTransport()
  const voice = new fakeVoice()
  const cfg = normalizeConfig({
    bindings: [{ qq: QQ, session: session, name: '主人', enabled: true }],
    outboxTtlHours: 24,
    outboxDedupMinutes: 10,
    // 测试不真等发送节奏。
    outboxPerMessageDelayMs: 0,
    outboxPerCharDelayMs: 0,
    ...config,
  })
  const outbox = new Outbox({ homeDir: dir, getConfig: () => cfg, logger, store })
  const bridge = new Bridge({
    getConfig: () => cfg,
    transport,
    store,
    logger,
    voice,
    delivery: new fakeDeliver(),
    outbox,
    autoTimers: false,
  })
  store.setWatermark(QQ, { timestamp: 1, messageId: '' })
  return { dir, store, logger, transport, voice, cfg, outbox, bridge }
}

test('Bridge：离线发送入队，恢复后按顺序补发且不重复', async () => {
  const { bridge, transport, outbox } = makeBridge()
  await bridge.start({ syncNow: false })

  const one = await bridge.sendText(QQ, '第一条')
  const two = await bridge.sendText(QQ, '第二条')
  assert.equal(one.queued, true)
  assert.equal(two.queued, true)
  assert.equal(outbox.pending(), 2)
  assert.equal(transport.sent.length, 0)

  transport.fail = false
  const result = await bridge.flushOutbox('test-recovery', { force: true })
  assert.equal(result.sent, 2)
  assert.equal(result.failed, 0)
  assert.equal(outbox.pending(), 0)
  assert.deepEqual(transport.sent.map((x) => x.segments[0].data.text), ['第一条', '第二条'])
  assert.equal(outbox.status().sentTotal, 2)

  // 同样的内容再发一次：已经补发成功、队列里没有，应该正常再发，不误判成「重复」。
  await bridge.sendText(QQ, '第一条')
  assert.equal(transport.sent.length, 3)
  await bridge.stop()
})

test('Bridge：同一条消息在离线时重复调用 sendText，队列里只有一条', async () => {
  const { bridge, transport, outbox } = makeBridge()
  await bridge.start({ syncNow: false })
  await bridge.sendText(QQ, '别丢')
  await bridge.sendText(QQ, '别丢')
  assert.equal(outbox.pending(), 1)
  transport.fail = false
  await bridge.flushOutbox('test', { force: true })
  assert.equal(transport.sent.length, 1)
  assert.equal(transport.sent[0].segments[0].data.text, '别丢')
  await bridge.stop()
})

test('Bridge：恢复在线但还没补发时，新消息也排队，不插到积压前面', async () => {
  const { bridge, transport, outbox } = makeBridge()
  await bridge.start({ syncNow: false })
  await bridge.sendText(QQ, '积压里的旧消息')
  assert.equal(outbox.pending(), 1)

  // 传输恢复了，但积压还没补发；这时发新消息必须排到队尾。
  transport.fail = false
  const next = await bridge.sendText(QQ, '新消息')
  assert.equal(next.queued, true)
  assert.equal(transport.sent.length, 0, '有积压时新消息不能先发出去')
  assert.equal(outbox.pending(), 2)

  await bridge.flushOutbox('order', { force: true })
  assert.deepEqual(transport.sent.map((x) => x.segments[0].data.text), ['积压里的旧消息', '新消息'])
  await bridge.stop()
})

test('Bridge：没装本地 AI 时 [语音]文本[/语音] 只提示，不进补发队列', async () => {
  const { bridge, transport, outbox } = makeBridge()
  await bridge.start({ syncNow: false })
  const result = await bridge.deliverAssistantTurn(session, '块外 [QQ][语音]晚安，主人[/语音][/QQ] 块外')
  assert.equal(result.code, 'service_not_installed')
  assert.match(result.hint, /本地 AI 插件没装或没启动/)
  assert.equal(outbox.pending(), 0, '没有合成结果，也没有可补发的语音文本')
  assert.equal(transport.sent.length, 0)
  await bridge.stop()
})

test('Bridge：音频文件失效的积压条目直接丢弃并记错，不重试 20 次', async () => {
  const { bridge, outbox, store } = makeBridge()
  await bridge.start({ syncNow: false })
  const file = join(bridge.outbox.homeDir, '不存在.wav')
  assert.equal(existsSync(file), false)
  const r = outbox.enqueue({
    qq: QQ,
    segments: [{ type: 'record', data: { path: file } }],
    reason: '测试失效路径',
  })
  const result = await bridge.flushOutbox('test-missing', { force: true })
  assert.equal(result.dropped, 1)
  assert.equal(result.failed, 0)
  assert.equal(outbox.pending(), 0)
  assert.equal(outbox.status().droppedTotal, 1)
  const error = store.snapshot().stats.lastError
  assert.match(error, /语音文件不存在/)
  assert.ok(error.includes('不存在.wav'), `错误里应带真实文件路径，实际是：${error}`)
  assert.ok(r.item.id)
  await bridge.stop()
})

test('Bridge：示例占位符 [语音:路径] 不发、不入队，提示明确说明是占位符', async () => {
  const { bridge, transport, outbox, store } = makeBridge()
  await bridge.start({ syncNow: false })

  const result = await bridge.deliverAssistantTurn(session, '[QQ][语音:路径][/QQ]')
  assert.equal(result.ok, true)
  assert.equal(outbox.pending(), 0, '占位符不能进补发队列')
  assert.equal(transport.sent.length, 0, '占位符不能真的发出去')

  const error = store.snapshot().stats.lastError
  assert.match(error, /占位符/)
  assert.ok(error.includes('「路径」'), `提示里应保留原始占位值，实际是：${error}`)
  assert.doesNotMatch(error, /^语音文件不存在：路径$/, '不能再显示成像变量名一样的错误')
  await bridge.stop()
})

test('Bridge：旧的占位语音积压条目被丢弃时，错误文案也说明是占位符', async () => {
  const { bridge, outbox, store } = makeBridge()
  await bridge.start({ syncNow: false })
  outbox.enqueue({
    qq: QQ,
    segments: [{ type: 'record', data: { path: '路径' } }],
    reason: '旧版本留下的示例',
  })

  const result = await bridge.flushOutbox('test-placeholder', { force: true })
  assert.equal(result.dropped, 1)
  const error = store.snapshot().stats.lastError
  assert.match(error, /占位符/)
  assert.ok(error.includes('「路径」'))
  await bridge.stop()
})

test('出站队列：文件坏了先留档再按空队列继续，不静默覆盖', () => {
  const dir = tempDir()
  const file = join(dir, 'fish-message-outbox.json')
  writeFileSync(file, '{ 这不是 JSON', 'utf8')
  const logger = new Logger({ filePath: join(dir, 'outbox.log'), level: 'debug' })
  const queue = new Outbox({ homeDir: dir, getConfig: () => normalizeConfig({}), logger })

  assert.equal(queue.pending(), 0)
  assert.equal(existsSync(file), false)
  assert.equal(readdirSync(dir).filter((n) => n.startsWith('fish-message-outbox.json.bad-')).length, 1, '原文件改名留档')
  assert.match(logger.recent().join('\n'), /留档/)
})

test('出站队列：结构不对的文件也留档，不当空文件直接覆盖', () => {
  const dir = tempDir()
  const file = join(dir, 'fish-message-outbox.json')
  writeFileSync(file, JSON.stringify({ version: 1, items: '不是数组' }), 'utf8')
  const queue = new Outbox({ homeDir: dir, getConfig: () => normalizeConfig({}), logger: new Logger({ filePath: join(dir, 'outbox.log') }) })

  assert.equal(queue.pending(), 0)
  assert.equal(readdirSync(dir).filter((n) => n.startsWith('fish-message-outbox.json.bad-')).length, 1)
})

test('Bridge：出站队列落盘后换一个 Bridge 实例还能补发', async () => {
  const dir = tempDir()
  const first = makeBridge({ dir })
  await first.bridge.start({ syncNow: false })
  await first.bridge.sendText(QQ, '重启后补发')
  assert.equal(first.outbox.pending(), 1)
  await first.bridge.stop()

  const second = makeBridge({ dir })
  assert.equal(second.outbox.pending(), 1, '新 Bridge 应从磁盘加载积压')
  second.transport.fail = false
  await second.bridge.start({ syncNow: false })
  const result = await second.bridge.flushOutbox('restart', { force: true })
  assert.equal(result.sent, 1)
  assert.equal(second.transport.sent[0].segments[0].data.text, '重启后补发')
  await second.bridge.stop()
})
