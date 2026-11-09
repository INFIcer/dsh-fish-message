import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Outbox, 计算指纹, 消息摘要, 退避毫秒 } from '../lib/outbox.js'
import { Bridge } from '../lib/bridge.js'
import { StateStore } from '../lib/storage.js'
import { Logger } from '../lib/logger.js'
import { normalizeConfig } from '../lib/config.js'

const QQ = '10001'
const 会话 = 'session-outbox-test'

function 临时目录() {
  return mkdtempSync(join(tmpdir(), 'fish-outbox-'))
}

function 建队列({ dir = 临时目录(), config = {}, maxItems, ttlMs, dedupMs, now } = {}) {
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'outbox.log'), level: 'debug' })
  const 配置 = normalizeConfig({ outboxTtlHours: 24, outboxDedupMinutes: 10, ...config })
  const 队列 = new Outbox({
    homeDir: dir,
    getConfig: () => 配置,
    logger,
    store,
    maxItems,
    ttlMs,
    dedupMs,
    ...(now ? { now } : {}),
  })
  return { dir, store, logger, 配置, 队列 }
}

const 文本段 = (文本) => [{ type: 'text', data: { text: 文本 } }]

test('出站队列：落盘结构、重启后恢复、字段完整', () => {
  const dir = 临时目录()
  let 时间 = 1_800_000_000_000
  const 第一 = 建队列({ dir, now: () => 时间 })
  第一.队列.enqueue({ qq: QQ, segments: 文本段('离线时发的'), reason: '模拟断网' })
  assert.equal(第一.队列.pending(), 1)

  const 盘 = JSON.parse(readFileSync(join(dir, 'fish-message-outbox.json'), 'utf8'))
  assert.equal(盘.version, 1)
  assert.equal(盘.items.length, 1)
  for (const 键 of ['id', 'qq', 'segments', 'createdAt', 'attempts', 'nextAttemptAt', 'expiresAt', 'reason', 'fingerprint']) {
    assert.ok(键 in 盘.items[0], `条目缺少字段 ${键}`)
  }
  assert.equal(盘.items[0].qq, QQ)
  assert.equal(盘.items[0].attempts, 0)

  const 第二 = 建队列({ dir, now: () => 时间 })
  assert.equal(第二.队列.pending(), 1)
  assert.deepEqual(第二.队列.list()[0].segments, 文本段('离线时发的'))
})

test('出站队列：相同 fingerprint 在去重窗口内只留一条，窗口过了可以再入队', () => {
  let 时间 = 1_800_000_000_000
  const { 队列 } = 建队列({ now: () => 时间 })
  const a = 队列.enqueue({ qq: QQ, segments: 文本段('重复的消息') })
  const b = 队列.enqueue({ qq: QQ, segments: 文本段('重复的消息') })
  assert.equal(a.deduped, false)
  assert.equal(b.deduped, true)
  assert.equal(队列.pending(), 1)
  assert.equal(a.item.fingerprint, b.item.fingerprint)

  队列.enqueue({ qq: QQ, segments: 文本段('另一条') })
  assert.equal(队列.pending(), 2)

  时间 += 11 * 60 * 1000
  队列.enqueue({ qq: QQ, segments: 文本段('重复的消息') })
  assert.equal(队列.pending(), 3, '超过 10 分钟，同样内容可以再次入队')
})

test('出站队列：fingerprint 与 data 键顺序无关，QQ 不同则不同', () => {
  const a = 计算指纹(QQ, [{ type: 'image', data: { path: 'C:/a.png', name: 'a' } }])
  const b = 计算指纹(QQ, [{ type: 'image', data: { name: 'a', path: 'C:/a.png' } }])
  assert.equal(a, b)
  assert.notEqual(a, 计算指纹('10002', [{ type: 'image', data: { path: 'C:/a.png', name: 'a' } }]))
  assert.match(消息摘要([{ type: 'record_text', data: { text: '晚安' } }]), /\[语音\] 晚安/)
})

test('出站队列：超过 maxItems 丢最旧并计数', () => {
  let 时间 = 1_800_000_000_000
  const { 队列 } = 建队列({ maxItems: 3, now: () => 时间 })
  for (let i = 0; i < 4; i++) {
    时间 += 1000
    队列.enqueue({ qq: QQ, segments: 文本段(`第 ${i} 条`) })
  }
  assert.equal(队列.pending(), 3)
  assert.equal(队列.list()[0].segments[0].data.text, '第 1 条', '最旧的「第 0 条」应被丢掉')
  assert.equal(队列.status().droppedTotal, 1)
})

test('出站队列：TTL 过期丢弃，计入 droppedTotal', () => {
  let 时间 = 1_800_000_000_000
  const { 队列 } = 建队列({ ttlMs: 1000, now: () => 时间 })
  队列.enqueue({ qq: QQ, segments: 文本段('会过期') })
  assert.equal(队列.pending(), 1)
  时间 += 1200
  const 丢 = 队列.expire()
  assert.equal(丢, 1)
  assert.equal(队列.pending(), 0)
  assert.equal(队列.status().droppedTotal, 1)
})

test('出站队列：退避公式 5s * 1.8^attempts 封顶 300s，20 次后放弃', () => {
  assert.equal(退避毫秒(1), 9000)
  assert.equal(退避毫秒(2), 16200)
  assert.equal(退避毫秒(10), 300000)

  let 时间 = 1_800_000_000_000
  const { 队列 } = 建队列({ now: () => 时间 })
  const { item } = 队列.enqueue({ qq: QQ, segments: 文本段('一直失败') })
  const 一 = 队列.markFailed(item.id, '模拟失败', 时间)
  assert.equal(一.delayMs, 9000)
  assert.equal(队列.list()[0].nextAttemptAt, 时间 + 9000)
  assert.equal(队列.status().failedTotal, 1)

  for (let i = 2; i <= 20; i++) {
    const r = 队列.markFailed(item.id, `第 ${i} 次失败`, 时间)
    if (i < 20) assert.equal(r.dropped, false)
    else {
      assert.equal(r.dropped, true)
      assert.equal(r.attempts, 20)
    }
  }
  assert.equal(队列.pending(), 0)
  assert.equal(队列.status().droppedTotal, 1)
})

// ---------------- Bridge 集成：离线入队 → 恢复补发 ----------------

class 假传输 {
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

class 假投递 {
  async deliver() { return { ok: true } }
  async attachmentPath() { return '' }
}

class 假语音 {
  async fetchImage() { throw new Error('测试不下载图片') }
}

function 建桥({ dir = 临时目录(), config = {} } = {}) {
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'bridge.log'), level: 'debug' })
  const transport = new 假传输()
  const voice = new 假语音()
  const 配置 = normalizeConfig({
    bindings: [{ qq: QQ, session: 会话, name: '主人', enabled: true }],
    outboxTtlHours: 24,
    outboxDedupMinutes: 10,
    ...config,
  })
  const outbox = new Outbox({ homeDir: dir, getConfig: () => 配置, logger, store })
  const bridge = new Bridge({
    getConfig: () => 配置,
    transport,
    store,
    logger,
    voice,
    delivery: new 假投递(),
    outbox,
    autoTimers: false,
  })
  store.setWatermark(QQ, { timestamp: 1, messageId: '' })
  return { dir, store, logger, transport, voice, 配置, outbox, bridge }
}

test('Bridge：离线发送入队，恢复后按顺序补发且不重复', async () => {
  const { bridge, transport, outbox } = 建桥()
  await bridge.start({ syncNow: false })

  const 一 = await bridge.sendText(QQ, '第一条')
  const 二 = await bridge.sendText(QQ, '第二条')
  assert.equal(一.queued, true)
  assert.equal(二.queued, true)
  assert.equal(outbox.pending(), 2)
  assert.equal(transport.sent.length, 0)

  transport.fail = false
  const 结果 = await bridge.flushOutbox('test-recovery', { force: true })
  assert.equal(结果.sent, 2)
  assert.equal(结果.failed, 0)
  assert.equal(outbox.pending(), 0)
  assert.deepEqual(transport.sent.map((x) => x.segments[0].data.text), ['第一条', '第二条'])
  assert.equal(outbox.status().sentTotal, 2)

  // 同样的内容再发一次：已经补发成功、队列里没有，应该正常再发，不误判成「重复」。
  await bridge.sendText(QQ, '第一条')
  assert.equal(transport.sent.length, 3)
  await bridge.stop()
})

test('Bridge：同一条消息在离线时重复调用 sendText，队列里只有一条', async () => {
  const { bridge, transport, outbox } = 建桥()
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
  const { bridge, transport, outbox } = 建桥()
  await bridge.start({ syncNow: false })
  await bridge.sendText(QQ, '积压里的旧消息')
  assert.equal(outbox.pending(), 1)

  // 传输恢复了，但积压还没补发；这时发新消息必须排到队尾。
  transport.fail = false
  const 新 = await bridge.sendText(QQ, '新消息')
  assert.equal(新.queued, true)
  assert.equal(transport.sent.length, 0, '有积压时新消息不能先发出去')
  assert.equal(outbox.pending(), 2)

  await bridge.flushOutbox('order', { force: true })
  assert.deepEqual(transport.sent.map((x) => x.segments[0].data.text), ['积压里的旧消息', '新消息'])
  await bridge.stop()
})

test('Bridge：[语音]文本[/语音] 不再合成，也不进补发队列', async () => {
  const { bridge, transport, outbox } = 建桥()
  await bridge.start({ syncNow: false })
  const 结果 = await bridge.deliverAssistantTurn(会话, '块外 [QQ][语音]晚安，主人[/语音][/QQ] 块外')
  assert.equal(结果.code, 'tts_moved_to_ops')
  assert.equal(outbox.pending(), 0, '没有合成结果，也没有可补发的语音文本')
  assert.equal(transport.sent.length, 0)
  await bridge.stop()
})

test('Bridge：音频文件失效的积压条目直接丢弃并记错，不重试 20 次', async () => {
  const { bridge, outbox, store } = 建桥()
  await bridge.start({ syncNow: false })
  const 文件 = join(bridge.outbox.homeDir, '不存在.wav')
  assert.equal(existsSync(文件), false)
  const r = outbox.enqueue({
    qq: QQ,
    segments: [{ type: 'record', data: { path: 文件 } }],
    reason: '测试失效路径',
  })
  const 结果 = await bridge.flushOutbox('test-missing', { force: true })
  assert.equal(结果.dropped, 1)
  assert.equal(结果.failed, 0)
  assert.equal(outbox.pending(), 0)
  assert.equal(outbox.status().droppedTotal, 1)
  const 错误 = store.snapshot().stats.lastError
  assert.match(错误, /语音文件不存在/)
  assert.ok(错误.includes('不存在.wav'), `错误里应带真实文件路径，实际是：${错误}`)
  assert.ok(r.item.id)
  await bridge.stop()
})

test('Bridge：示例占位符 [语音:路径] 不发、不入队，提示明确说明是占位符', async () => {
  const { bridge, transport, outbox, store } = 建桥()
  await bridge.start({ syncNow: false })

  const 结果 = await bridge.deliverAssistantTurn(会话, '[QQ][语音:路径][/QQ]')
  assert.equal(结果.ok, true)
  assert.equal(outbox.pending(), 0, '占位符不能进补发队列')
  assert.equal(transport.sent.length, 0, '占位符不能真的发出去')

  const 错误 = store.snapshot().stats.lastError
  assert.match(错误, /占位符/)
  assert.ok(错误.includes('「路径」'), `提示里应保留原始占位值，实际是：${错误}`)
  assert.doesNotMatch(错误, /^语音文件不存在：路径$/, '不能再显示成像变量名一样的错误')
  await bridge.stop()
})

test('Bridge：旧的占位语音积压条目被丢弃时，错误文案也说明是占位符', async () => {
  const { bridge, outbox, store } = 建桥()
  await bridge.start({ syncNow: false })
  outbox.enqueue({
    qq: QQ,
    segments: [{ type: 'record', data: { path: '路径' } }],
    reason: '旧版本留下的示例',
  })

  const 结果 = await bridge.flushOutbox('test-placeholder', { force: true })
  assert.equal(结果.dropped, 1)
  const 错误 = store.snapshot().stats.lastError
  assert.match(错误, /占位符/)
  assert.ok(错误.includes('「路径」'))
  await bridge.stop()
})

test('Bridge：出站队列落盘后换一个 Bridge 实例还能补发', async () => {
  const dir = 临时目录()
  const 第一 = 建桥({ dir })
  await 第一.bridge.start({ syncNow: false })
  await 第一.bridge.sendText(QQ, '重启后补发')
  assert.equal(第一.outbox.pending(), 1)
  await 第一.bridge.stop()

  const 第二 = 建桥({ dir })
  assert.equal(第二.outbox.pending(), 1, '新 Bridge 应从磁盘加载积压')
  第二.transport.fail = false
  await 第二.bridge.start({ syncNow: false })
  const 结果 = await 第二.bridge.flushOutbox('restart', { force: true })
  assert.equal(结果.sent, 1)
  assert.equal(第二.transport.sent[0].segments[0].data.text, '重启后补发')
  await 第二.bridge.stop()
})
