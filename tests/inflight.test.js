// 待发记录（inflight）：发送前等待期间重启不丢消息。
//
// 场景都用临时家目录 + 两个 Bridge 实例模拟：第一个在节奏等待里被「弃置」，第二个从磁盘回放。
// 等待函数可注入，测试不会真等。

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '../lib/bridge.js'
import { StateStore } from '../lib/storage.js'
import { Logger } from '../lib/logger.js'
import { normalizeConfig } from '../lib/config.js'
import { InflightQueue } from '../lib/inflight.js'

const QQ = '10001'
const session = 'session-inflight'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, timeout = 2000, interval = 10) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (check()) return true
    await sleep(interval)
  }
  return false
}

const tempDir = () => mkdtempSync(join(tmpdir(), 'fish-inflight-'))

class fakeTransport {
  constructor() {
    this.sent = []
    this.fail = false
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

class fakeDelivery {
  async deliver() { return { ok: true } }
  async attachmentPath() { return '' }
}

/** 一个 Bridge + 临时家目录；默认 sleep 是瞬时的，需要卡住时自己传。 */
function makeBridge({ dir = tempDir(), config = {}, sleep: sleepFn, ai = null } = {}) {
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'inflight.log'), level: 'debug' })
  const transport = new fakeTransport()
  const cfg = normalizeConfig({
    bindings: [{ qq: QQ, session, name: '主人', enabled: true }],
    reorderBufferMs: 0,
    inboundEditWindowMs: 0,
    outboxPerMessageDelayMs: 20,
    outboxPerCharDelayMs: 10,
    ...config,
  })
  const bridge = new Bridge({
    getConfig: () => cfg,
    transport,
    store,
    logger,
    voice: { async fetchImage() { throw new Error('测试不下载图片') } },
    delivery: new fakeDelivery(),
    ai,
    autoTimers: false,
    sleep: sleepFn || (async () => {}),
  })
  store.setWatermark(QQ, { timestamp: 1, messageId: '' })
  return { dir, store, logger, transport, cfg, bridge }
}

const inflightDisk = (dir) => {
  const file = join(dir, 'fish-message-inflight.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

test('待发记录：一个段正在等待节奏时重启，新实例补发一次', async () => {
  const dir = tempDir()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const first = makeBridge({ dir, sleep: async () => { await gate } })
  await first.bridge.start({ syncNow: false })

  const pending = first.bridge.deliverAssistantTurn(session, '[QQ]等待中被重启[/QQ]')
  assert.equal(await waitFor(() => first.bridge.inflight.pending() === 1), true, '进入等待前应先落盘')
  assert.equal(first.transport.sent.length, 0, '等待期间还没发出去')
  const disk = inflightDisk(dir)
  assert.equal(disk.items.length, 1)
  assert.equal(disk.items[0].segments[0].data.text, '等待中被重启', '记录里是当前这条还没发出去的消息段')

  // 「崩溃」：弃置第一个实例，不释放等待，直接换一个从磁盘加载。
  await first.bridge.stop()
  const second = makeBridge({ dir })
  await second.bridge.start({ syncNow: false })
  const replay = await second.bridge.replayInflight('test')
  assert.equal(replay.sent, 1)
  assert.deepEqual(second.transport.sent.map((x) => x.segments[0].data.text), ['等待中被重启'])
  assert.equal(second.bridge.inflight.pending(), 0, '发成功后记录要删掉')

  release()
  await pending.catch(() => {})
  await second.bridge.stop()
})

test('待发记录：Bridge 启动后会自动回放，不需要手动调用', async () => {
  const dir = tempDir()
  const seed = new InflightQueue({
    homeDir: dir,
    getConfig: () => normalizeConfig({}),
    logger: new Logger({ filePath: join(dir, 'seed.log') }),
  })
  seed.add({ qq: QQ, segments: [{ type: 'text', data: { text: '启动时自动补发' } }], dueAt: 0 })

  const second = makeBridge({ dir })
  await second.bridge.start({ syncNow: false })
  assert.equal(
    await waitFor(() => second.transport.sent.length === 1, 2000),
    true,
    'start() 内部会触发回放',
  )
  assert.equal(second.transport.sent[0].segments[0].data.text, '启动时自动补发')
  await second.bridge.stop()
})

test('待发记录：已经发送成功并删掉记录，重启后不再发', async () => {
  const dir = tempDir()
  const first = makeBridge({ dir })
  await first.bridge.start({ syncNow: false })
  await first.bridge.deliverAssistantTurn(session, '[QQ]已经发出去了[/QQ]')
  assert.equal(first.transport.sent.length, 1)
  assert.equal(first.bridge.inflight.pending(), 0, '正常发送后不留记录')
  await first.bridge.stop()

  const second = makeBridge({ dir })
  await second.bridge.start({ syncNow: false })
  const replay = await second.bridge.replayInflight('test')
  assert.equal(replay.sent, 0)
  assert.equal(second.transport.sent.length, 0, '重启后不能重发已成功的消息')
  await second.bridge.stop()
})

test('待发记录：一轮多段在等待中崩溃，重启后按原顺序补发且不重复', async () => {
  const dir = tempDir()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const first = makeBridge({ dir, sleep: async () => { await gate } })
  await first.bridge.start({ syncNow: false })

  const pending = first.bridge.deliverAssistantTurn(session, '[QQ]块一[/QQ][QQ]块二[/QQ][QQ]块三[/QQ]')
  assert.equal(await waitFor(() => first.bridge.inflight.pending() === 1), true)
  const record = first.bridge.inflight.list()[0]
  assert.equal(record.segments[0].data.text, '块一', '当前块已经解析好，单独记在 segments 里')
  assert.deepEqual(record.tokens.map((t) => t.text), ['块二', '块三'], '后半轮 token 也都要在记录里')
  await first.bridge.stop()

  const second = makeBridge({ dir })
  await second.bridge.start({ syncNow: false })
  const replay = await second.bridge.replayInflight('test')
  assert.equal(replay.sent, 3)
  assert.deepEqual(
    second.transport.sent.map((x) => x.segments[0].data.text),
    ['块一', '块二', '块三'],
    '重启后按原顺序补齐，块与块不重复',
  )
  assert.equal(second.bridge.inflight.pending(), 0)

  release()
  await pending.catch(() => {})
  await second.bridge.stop()
})

test('待发记录：一条消息多段时只补发还没发出去的段', async () => {
  const dir = tempDir()
  let release
  let calls = 0
  const gate = new Promise((resolve) => { release = resolve })
  const first = makeBridge({
    dir,
    sleep: async () => {
      calls += 1
      if (calls === 2) await gate
    },
  })
  await first.bridge.start({ syncNow: false })

  const pending = first.bridge.sendOutbound(QQ, [
    { type: 'text', data: { text: '第一段' } },
    { type: 'text', data: { text: '第二段' } },
    { type: 'text', data: { text: '第三段' } },
  ], { reason: 'test-multi' })
  assert.equal(
    await waitFor(() => first.transport.sent.length === 1 && first.bridge.inflight.pending() === 1),
    true,
    '第一段已发、第二段在等待',
  )
  const record = first.bridge.inflight.list()[0]
  assert.deepEqual(record.segments.map((x) => x.data.text), ['第二段', '第三段'], '记录只保留还没发出的段')
  await first.bridge.stop()

  const second = makeBridge({ dir })
  await second.bridge.start({ syncNow: false })
  const replay = await second.bridge.replayInflight('test')
  assert.equal(replay.sent, 1)
  assert.deepEqual(second.transport.sent.map((x) => x.segments[0].data.text), ['第二段', '第三段'], '重启不重发第一段')

  release()
  await pending.catch(() => {})
  await second.bridge.stop()
})

test('待发记录：语音合成多段时，只补发还没发出的语音条', async () => {
  const dir = tempDir()
  const audios = ['tts-1.wav', 'tts-2.wav'].map((name) => join(dir, name))
  for (const path of audios) writeFileSync(path, 'fake-wav')
  let release
  let calls = 0
  const gate = new Promise((resolve) => { release = resolve })
  const first = makeBridge({
    dir,
    ai: { async tts() { return { ok: true, wavPaths: audios } } },
    sleep: async () => {
      calls += 1
      if (calls === 2) await gate
    },
  })
  await first.bridge.start({ syncNow: false })
  const pending = first.bridge.deliverAssistantTurn(session, '[QQ][语音]晚安[/语音][/QQ]')
  assert.equal(
    await waitFor(() => first.transport.sent.length === 1 && first.bridge.inflight.pending() === 1),
    true,
    '第一条语音已发、第二条在等待',
  )
  const record = first.bridge.inflight.list()[0]
  assert.equal(record.segments.length, 1, '记录只保留还没发出的语音条')
  assert.equal(record.segments[0].data.path, audios[1], '记录里是原始本地路径')
  await first.bridge.stop()

  const second = makeBridge({ dir })
  await second.bridge.start({ syncNow: false })
  await second.bridge.replayInflight('test')
  assert.equal(second.transport.sent.length, 1, '重启后只补第二条语音')
  assert.equal(second.transport.sent[0].segments[0].data.file, audios[1].replace(/\\/g, '/'))

  release()
  await pending.catch(() => {})
  await second.bridge.stop()
})

test('待发记录：两个延迟都设 0 时不新增持久化动作，行为与旧版一致', async () => {
  const dir = tempDir()
  const first = makeBridge({ dir, config: { outboxPerMessageDelayMs: 0, outboxPerCharDelayMs: 0 } })
  await first.bridge.start({ syncNow: false })
  await first.bridge.deliverAssistantTurn(session, '[QQ]立即发送[/QQ]')
  assert.equal(first.transport.sent.length, 1)
  assert.equal(existsSync(join(dir, 'fish-message-inflight.json')), false, '不等就不写待发记录')
  await first.bridge.stop()

  const second = makeBridge({ dir, config: { outboxPerMessageDelayMs: 0, outboxPerCharDelayMs: 0 } })
  await second.bridge.start({ syncNow: false })
  const replay = await second.bridge.replayInflight('test')
  assert.equal(replay.sent, 0)
  assert.equal(second.transport.sent.length, 0)
  await second.bridge.stop()
})

test('待发记录：发送失败只进 outbox 一次，不在两边各留一份', async () => {
  const dir = tempDir()
  const first = makeBridge({ dir })
  first.transport.fail = true
  await first.bridge.start({ syncNow: false })

  const result = await first.bridge.sendOutbound(QQ, [{ type: 'text', data: { text: '发不出去' } }], { reason: 'test-fail' })
  assert.equal(result.queued, true)
  assert.equal(first.bridge.outbox.pending(), 1, '失败进 outbox')
  assert.equal(first.bridge.inflight.pending(), 0, '失败后待发记录要删掉')
  const disk = inflightDisk(dir)
  assert.ok(!disk || disk.items.length === 0, '待发文件里不能还留着这条')
  const outboxDisk = JSON.parse(readFileSync(join(dir, 'fish-message-outbox.json'), 'utf8'))
  assert.equal(outboxDisk.items.length, 1)
  assert.equal(outboxDisk.items[0].segments[0].data.text, '发不出去')
  await first.bridge.stop()
})

test('待发记录：超过 TTL 按现有出站队列口径过期丢弃', () => {
  const dir = tempDir()
  let time = 1_800_000_000_000
  const store = new StateStore({ homeDir: dir })
  const queue = new InflightQueue({
    homeDir: dir,
    getConfig: () => normalizeConfig({ outboxTtlHours: 24 }),
    logger: new Logger({ filePath: join(dir, 'ttl.log') }),
    store,
    now: () => time,
    ttlMs: 1000,
  })
  queue.add({ qq: QQ, segments: [{ type: 'text', data: { text: '会过期' } }] })
  assert.equal(queue.pending(), 1)
  time += 1200
  assert.equal(queue.expire(), 1)
  assert.equal(queue.pending(), 0)
  assert.equal(store.snapshot().stats.outboxDropped, 1)
})
