// 入站编辑窗口与撤回：Bridge 层的端到端用例。
//
// 计时基准是消息自带的 time（秒），所以用例统一用 futureStamp() 生成「未来整秒」：
// 「消息时间戳 + 窗口」落在测试能等到的几百毫秒内，不会因为跨秒而随机。
// 离线补投的用例用已经过去的整秒，验证「旧消息的窗口早已过期，拉回来立刻投」。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge, splitInboundGroups, mergeInboundBatch } from '../lib/bridge.js'
import { StateStore } from '../lib/storage.js'
import { Logger } from '../lib/logger.js'
import { normalizeConfig } from '../lib/config.js'

const QQ = '10001'
const session = 'session-edit-window'
const WINDOW = 300

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check, timeout = 2500, interval = 20) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (check()) return true
    await sleep(interval)
  }
  return false
}

/** 未来整秒：消息时间戳 + 窗口落在 [现在+0.3s, 现在+1.3s]，测试等得到也不跨秒随机。 */
const futureStamp = () => Math.floor(Date.now() / 1000) + 1

function makeMessage(id, text, time, qq = QQ) {
  return {
    message_id: id,
    message_seq: Number(id),
    time,
    user_id: Number(qq),
    message_type: 'private',
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: Number(qq), nickname: '主人' },
  }
}

class fakeTransport {
  constructor(history = {}) {
    this.history = history
    this.sent = []
    this.handlers = null
    this.status = { name: 'fake', connected: false, mode: 'http' }
  }
  async start(handlers) { this.handlers = handlers; handlers.onStatus(this.status) }
  async stop() {}
  async sendMessage(peer, segments) { this.sent.push({ peer: String(peer), segments }); return { message_id: 1 } }
  async fetchHistory(peer) { return this.history[String(peer)] || [] }
  getStatus() { return this.status }
  emit(event) { this.handlers?.onEvent(event) }
  message(message) { this.emit({ post_type: 'message', message_type: 'private', ...message }) }
  recall(qq, id) { this.emit({ post_type: 'notice', notice_type: 'friend_recall', user_id: Number(qq), message_id: id }) }
  notice(event) { this.emit({ post_type: 'notice', ...event }) }
}

class fakeDeliver {
  constructor() { this.got = []; this.attempts = 0; this.fail = false }
  async deliver(req) {
    this.attempts += 1
    if (this.fail) return { ok: false, error: '会话没开' }
    this.got.push(req)
    return { ok: true }
  }
  async attachmentPath() { return '' }
}

class fakeVoice {
  constructor(dir) { this.dir = dir; this.count = 0 }
  async fetchImage() {
    this.count += 1
    const path = join(this.dir, `img-${this.count}.png`)
    const buffer = Buffer.from('fake-png')
    return { buffer, base64: buffer.toString('base64'), mime: 'image/png', path, ext: '.png' }
  }
}

function makeBridge({ dir = mkdtempSync(join(tmpdir(), 'fish-edit-')), history = {}, config = {} } = {}) {
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'test.log'), level: 'debug' })
  const transport = new fakeTransport(history)
  const delivery = new fakeDeliver()
  const voice = new fakeVoice(dir)
  const cfg = normalizeConfig({
    napcatBaseUrl: 'http://127.0.0.1:3000',
    bindings: [{ qq: QQ, session, name: '主人', enabled: true }],
    backfillWindowHours: 24,
    reorderBufferMs: 10,
    historyCount: 100,
    inboundEditWindowMs: WINDOW,
    outboxPerMessageDelayMs: 0,
    outboxPerCharDelayMs: 0,
    ...config,
  })
  const bridge = new Bridge({
    getConfig: () => cfg, transport, store, logger, voice, delivery, autoTimers: false,
  })
  store.setWatermark(QQ, { timestamp: 1, messageId: '' })
  return { dir, store, logger, transport, delivery, voice, cfg, bridge }
}

test('编辑窗口：窗口内的两条合并成一条，文本按时间顺序换行拼接', async () => {
  const { bridge, transport, delivery, store } = makeBridge()
  await bridge.start({ syncNow: false })
  const stamp = futureStamp()
  // 故意先发「后一条」，验证同一批内按时间/序号排序。
  transport.message(makeMessage(2, '第二句', stamp))
  transport.message(makeMessage(1, '第一句', stamp))

  assert.equal(await waitFor(() => delivery.got.length > 0), true, '窗口到点后要投递')
  assert.equal(delivery.got.length, 1, '两条合成一条')
  assert.equal(delivery.got[0].text, '第一句\n第二句')
  assert.equal(delivery.got[0].meta.messageId, '2', '合并批次用最后一条的 message_id')
  assert.equal(delivery.got[0].meta.qq, QQ)

  // 去重 / 水位 / 统计 / 事件仍逐条记。
  assert.equal(store.hasSeen(1) && store.hasSeen(2), true)
  assert.equal(store.getWatermark(QQ).messageId, '2')
  assert.equal(store.snapshot().stats.received, 2)
  assert.equal(store.snapshot().stats.delivered, 2)
  assert.equal(store.snapshot().recent.filter((x) => x.direction === 'in').length, 2)
  await bridge.stop()
})

test('编辑窗口：只收到一条时原样投递，不加多余换行', async () => {
  const { bridge, transport, delivery } = makeBridge()
  await bridge.start({ syncNow: false })
  transport.message(makeMessage(3, '单独一条', futureStamp()))
  assert.equal(await waitFor(() => delivery.got.length > 0), true)
  assert.equal(delivery.got[0].text, '单独一条')
  await bridge.stop()
})

test('撤回：A→撤回A→窗口结束，不投递空批次，也不进 seen/水位', async () => {
  const { bridge, transport, delivery, store } = makeBridge()
  await bridge.start({ syncNow: false })
  transport.message(makeMessage(11, '这句要撤回', futureStamp()))
  transport.recall(QQ, 11)

  await waitFor(() => false, 700)
  assert.equal(delivery.got.length, 0, '撤回后队列空了，不能投空批次')
  assert.equal(store.hasSeen(11), false, '被撤回的消息没投递，不能进 seen')
  assert.equal(store.getWatermark(QQ).timestamp, 1, '水位不能因为一条撤回的消息前移')
  await bridge.stop()
})

test('撤回：A→B→撤回A→窗口结束，只投 B', async () => {
  const { bridge, transport, delivery, store } = makeBridge()
  await bridge.start({ syncNow: false })
  const stamp = futureStamp()
  transport.message(makeMessage(21, 'A 要撤回', stamp))
  transport.message(makeMessage(22, 'B 留下', stamp))
  transport.recall(QQ, 21)

  assert.equal(await waitFor(() => delivery.got.length > 0), true)
  assert.equal(delivery.got.length, 1)
  assert.equal(delivery.got[0].text, 'B 留下')
  assert.equal(delivery.got[0].meta.messageId, '22')
  assert.equal(store.hasSeen(21), false)
  assert.equal(store.hasSeen(22), true)
  await bridge.stop()
})

test('撤回：已经投递的消息撤不回来，只记日志、不影响后面的消息', async () => {
  const { bridge, transport, delivery } = makeBridge()
  await bridge.start({ syncNow: false })
  transport.message(makeMessage(31, '第一条', futureStamp()))
  assert.equal(await waitFor(() => delivery.got.length === 1), true)

  transport.recall(QQ, 31)
  transport.message(makeMessage(32, '第二条', futureStamp()))
  assert.equal(await waitFor(() => delivery.got.length === 2), true)
  assert.deepEqual(delivery.got.map((x) => x.text), ['第一条', '第二条'])
  await bridge.stop()
})

test('撤回：未绑定的 peer 与 group_recall 都忽略，后续消息照常投', async () => {
  const { bridge, transport, delivery, store } = makeBridge()
  await bridge.start({ syncNow: false })
  transport.recall('99999', 111)
  transport.notice({ notice_type: 'group_recall', group_id: 123, user_id: 1, message_id: 112 })
  transport.message(makeMessage(113, '撤回通知之后的正常消息', futureStamp()))

  assert.equal(await waitFor(() => delivery.got.length > 0), true)
  assert.equal(delivery.got.length, 1)
  assert.equal(delivery.got[0].text, '撤回通知之后的正常消息')
  assert.equal(store.hasSeen(112), false)
  await bridge.stop()
})

test('合并投递失败：整组重新排队，恢复后只投一次、两条都在', async () => {
  const { bridge, transport, delivery, store } = makeBridge()
  await bridge.start({ syncNow: false })
  const stamp = futureStamp()
  delivery.fail = true
  transport.message(makeMessage(51, '第一段', stamp))
  transport.message(makeMessage(52, '第二段', stamp))

  assert.equal(await waitFor(() => delivery.attempts >= 1), true, '应该尝试投递')
  assert.equal(delivery.got.length, 0)
  assert.equal(bridge.queue.size(), 2, '失败后两条都要回到队列')
  assert.equal(store.hasSeen(51), false, '没投进去就不能算已处理')

  delivery.fail = false
  assert.equal(await waitFor(() => delivery.got.length > 0, 4000), true, '下一轮要重试成功')
  assert.equal(delivery.got.length, 1)
  assert.equal(delivery.got[0].text, '第一段\n第二段')
  assert.equal(bridge.queue.size(), 0, '重试成功后队列要清空')
  assert.equal(store.hasSeen(51) && store.hasSeen(52), true)
  await bridge.stop()
})

test('暂停转发：按条暂存，恢复后按原顺序逐条补投（不因合并丢图）', async () => {
  const { bridge, transport, delivery, cfg } = makeBridge({ config: { forwardPaused: true } })
  await bridge.start({ syncNow: false })
  const stamp = futureStamp()
  transport.message(makeMessage(61, '暂停一', stamp))
  transport.message(makeMessage(62, '暂停二', stamp))

  assert.equal(await waitFor(() => bridge.forwardQueue.pending() === 2), true, '按条暂存')
  assert.equal(delivery.got.length, 0)
  assert.equal(bridge.forwardQueue.next().text, '暂停一')

  cfg.forwardPaused = false
  await bridge.flushForwardQueue('test')
  assert.deepEqual(delivery.got.map((x) => x.text), ['暂停一', '暂停二'])
  await bridge.stop()
})

test('编辑窗口：多条图片按顺序合并进同一条消息', async () => {
  const { bridge, transport, delivery, dir } = makeBridge()
  await bridge.start({ syncNow: false })
  const stamp = futureStamp()
  const imageMessage = (id) => ({
    message_id: id,
    message_seq: id,
    time: stamp,
    user_id: Number(QQ),
    message_type: 'private',
    message: [{ type: 'image', data: { url: `http://example.com/${id}.png` } }],
    raw_message: '',
  })
  transport.message(imageMessage(71))
  transport.message(imageMessage(72))

  assert.equal(await waitFor(() => delivery.got.length > 0), true)
  assert.equal(delivery.got.length, 1)
  assert.equal(delivery.got[0].images.length, 2, '两张图都在这条消息里')
  assert.match(delivery.got[0].images[0].name, /71/, '按到达/时间顺序')
  assert.match(delivery.got[0].images[1].name, /72/)
  assert.ok(delivery.got[0].images[0].path.startsWith(dir))
  await bridge.stop()
})

test('离线补投：历史按消息时间分组，时间差 >= 窗口的分开投，不丢消息', async () => {
  const base = futureStamp() - 200
  const history = {
    [QQ]: [
      makeMessage(81, '第一批一', base),
      makeMessage(82, '第一批二', base),
      makeMessage(83, '第二批一', base + 30),
      makeMessage(84, '第二批二', base + 30),
    ],
  }
  const { bridge, delivery, store } = makeBridge({ history })
  await bridge.start({ syncNow: false })
  await bridge.sync('test')

  assert.equal(await waitFor(() => delivery.got.length >= 2, 3000), true, '旧消息的窗口早已过期，应很快投递')
  assert.equal(delivery.got.length, 2)
  assert.deepEqual(delivery.got.map((x) => x.text), ['第一批一\n第一批二', '第二批一\n第二批二'])
  assert.equal(delivery.got[1].meta.messageId, '84')
  assert.equal(store.hasSeen(81) && store.hasSeen(84), true)
  assert.equal(store.getWatermark(QQ).timestamp, base + 30)
  await bridge.stop()
})

test('离线补投：A 被撤回（历史里没有），B 在自己的窗口内继续等，到点才投', async () => {
  const stamp = futureStamp()
  const history = { [QQ]: [makeMessage(92, 'B 还在窗口内', stamp)] }
  const { bridge, delivery } = makeBridge({ history })
  await bridge.start({ syncNow: false })
  await bridge.sync('reconnect')

  assert.equal(delivery.got.length, 0, '同步不能抢在编辑窗口前面投')
  assert.equal(await waitFor(() => delivery.got.length > 0, 3000), true, 'B 的窗口到点后要投')
  assert.equal(delivery.got.length, 1)
  assert.equal(delivery.got[0].text, 'B 还在窗口内')
  await bridge.stop()
})

test('编辑窗口 0：完全退回逐条投递（同一秒的两条也分开）', async () => {
  const { bridge, transport, delivery } = makeBridge({ config: { inboundEditWindowMs: 0 } })
  await bridge.start({ syncNow: false })
  const stamp = futureStamp()
  transport.message(makeMessage(101, '第一条', stamp))
  transport.message(makeMessage(102, '第二条', stamp))

  assert.equal(await waitFor(() => delivery.got.length >= 2), true)
  assert.deepEqual(delivery.got.map((x) => x.text), ['第一条', '第二条'])
  await bridge.stop()
})

test('分组纯函数：时间差 < 窗口同组，>= 窗口另起一组；窗口 0 时逐条', () => {
  const batch = [
    { message_id: 1, time: 100 },
    { message_id: 2, time: 100 },
    { message_id: 3, time: 115 },
    { message_id: 4, time: 115 },
    { message_id: 5, time: 131 },
  ]
  assert.deepEqual(
    splitInboundGroups(batch, 15000).map((group) => group.map((m) => m.message_id)),
    [[1, 2], [3, 4], [5]],
  )
  assert.equal(splitInboundGroups(batch, 0).length, 5, '窗口 0 = 逐条')
  assert.equal(splitInboundGroups([{ message_id: 1, time: 100 }, { message_id: 2, time: 101 }], 1000).length, 2,
    '时间差恰好等于窗口也要拆开')
  assert.deepEqual(splitInboundGroups([], 15000), [])

  const merged = mergeInboundBatch([
    { content: { text: '第一段', images: [] } },
    { content: { text: '', images: [{ base64: 'a' }] } },
    { content: { text: '第二段', images: [{ base64: 'b' }] } },
  ])
  assert.deepEqual(merged, { text: '第一段\n第二段', images: [{ base64: 'a' }, { base64: 'b' }] })
})
