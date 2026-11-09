// 出站合并窗口 + 发送级去重：用假传输/假投递直接驱动 Bridge 的 session/event 链路，
// 不连 QQ、不连 DSH、不碰网络。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '../lib/bridge.js'
import { StateStore } from '../lib/storage.js'
import { Logger } from '../lib/logger.js'
import { normalizeConfig } from '../lib/config.js'
import { 切段, 合并文本 } from '../lib/merge.js'

const 睡 = (ms) => new Promise((r) => setTimeout(r, ms))
const 临时目录 = () => mkdtempSync(join(tmpdir(), 'fish-merge-test-'))
const QQ = '10001'
const 会话 = 'session-merge-test'

class 假传输 {
  constructor() {
    this.sent = []
    this.handlers = null
    this.status = { name: 'fake', connected: false, mode: 'http' }
  }
  async start(handlers) { this.handlers = handlers }
  async stop() {}
  async sendMessage(peer, segments) { this.sent.push({ peer: String(peer), segments }); return { message_id: 1 } }
  async fetchHistory() { return [] }
  getStatus() { return this.status }
}

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

function 建桥({ dir = 临时目录(), config = {} } = {}) {
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'test.log'), level: 'debug' })
  const transport = new 假传输()
  const delivery = new 假投递()
  const 配置 = normalizeConfig({
    napcatBaseUrl: 'http://127.0.0.1:3000',
    bindings: [{ qq: QQ, session: 会话, name: '主人', enabled: true }],
    backfillWindowHours: 24,
    reorderBufferMs: 20,
    mergeWindowMs: 300,
    ...config,
  })
  const bridge = new Bridge({
    getConfig: () => 配置,
    transport,
    store,
    logger,
    voice: new 假语音(),
    delivery,
    autoTimers: false,
  })
  // 合并计时器不归 autoTimers 管（它是出站主流程），但这里把假传输的状态置为在线，
  // 免得发一条因为「传输层已停止」走补发队列。
  return { bridge, transport, delivery, logger, 配置, store }
}

/** 模拟 DSH 的「一条 assistant 正文 + turn/end」成对事件。 */
function 一轮(bridge, turn, 文本) {
  bridge.onSessionEvent({ id: 会话 }, {
    type: 'assistant/message',
    data: { turn, message: { content: [{ type: 'text', text: 文本 }] } },
  })
  bridge.onSessionEvent({ id: 会话 }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

test('合并文本：后半段不重复拼接，段落去重且保持首次出现顺序', () => {
  const 全文 = '一\n\n二\n\n三'
  assert.deepEqual(合并文本(全文, '二\n\n三'), { text: 全文, 段数: 3, 跳过: 2 })
  assert.deepEqual(合并文本('二\n\n三', 全文), { text: 全文, 段数: 3, 跳过: 2 })
  assert.deepEqual(合并文本('一', '二'), { text: '一\n\n二', 段数: 2, 跳过: 0 })
  // 没有空行时按单换行切段。
  assert.deepEqual(切段('甲\n乙\n丙'), ['甲', '乙', '丙'])
})

test('同一 turn 触发两次 turn/end（完整 + 后半段）→ 只发 1 条完整文本', async () => {
  const { bridge, transport } = 建桥()
  await bridge.start({ syncNow: false })
  const 全文 = '这个交互更好：先说结论。\n\n这样就不用在录音前预设模式了。\n\n已经写进待办，P1 骨架不冲突。'

  一轮(bridge, 1, `[QQ]${全文}[/QQ]`)
  一轮(bridge, 2, '[QQ]这样就不用在录音前预设模式了。\n\n已经写进待办，P1 骨架不冲突。[/QQ]')
  await 睡(450)

  assert.equal(transport.sent.length, 1, '同一轮的两次 turn/end 只能合成一条')
  assert.equal(transport.sent[0].segments[0].data.text, 全文)
  await bridge.stop()
})

test('3 个连续 turn/end（段1 / 段2 / 段3）→ 合并成 1 条三段', async () => {
  const { bridge, transport } = 建桥()
  await bridge.start({ syncNow: false })
  一轮(bridge, 1, '[QQ]段1')
  一轮(bridge, 2, '段2')
  一轮(bridge, 3, '段3[/QQ]')
  await 睡(450)

  assert.equal(transport.sent.length, 1, '窗口内的三轮要合并成一条')
  assert.equal(transport.sent[0].segments[0].data.text, '段1\n\n段2\n\n段3')
  await bridge.stop()
})

test('重复完全相同文本两轮 → 第二轮被发送指纹去重跳过', async () => {
  const { bridge, transport, logger } = 建桥()
  await bridge.start({ syncNow: false })
  一轮(bridge, 1, '[QQ]同一段回复[/QQ]')
  await 睡(450)
  assert.equal(transport.sent.length, 1)

  一轮(bridge, 2, '[QQ]同一段回复[/QQ]')
  await 睡(450)
  assert.equal(transport.sent.length, 1, '60 秒内完全相同的文本不能再发')
  assert.match(logger.lines.join('\n'), /跳过重复发送/)
  await bridge.stop()
})

test('合并后 [QQ] 标记仍正确解析（含转义字面量）', async () => {
  const { bridge, transport } = 建桥()
  await bridge.start({ syncNow: false })
  一轮(bridge, 1, '不发的前言。\n\n[QQ]第一段，字面量 \\[\\/QQ] 结束[/QQ]')
  一轮(bridge, 2, '[QQ]第二段[/QQ]')
  await 睡(450)

  assert.equal(transport.sent.length, 1)
  assert.equal(transport.sent[0].segments[0].data.text, '第一段，字面量 [/QQ] 结束\n第二段')
  await bridge.stop()
})

test('合并窗口内新内容到达会重置计时器', async () => {
  const { bridge, transport } = 建桥({ config: { mergeWindowMs: 600 } })
  await bridge.start({ syncNow: false })

  一轮(bridge, 1, '[QQ]第一段')
  await 睡(400)
  assert.equal(transport.sent.length, 0, '窗口还没到，不能提前发')

  一轮(bridge, 2, '第二段[/QQ]')
  await 睡(350) // 距第一条 750ms：如果没重置，600ms 时就该发了
  assert.equal(transport.sent.length, 0, '新内容到达后计时器应重置')

  await 睡(450) // 距第二条 ≈800ms，已超过重置后的 600ms 窗口
  assert.equal(transport.sent.length, 1)
  assert.equal(transport.sent[0].segments[0].data.text, '第一段\n\n第二段')
  await bridge.stop()
})

test('mergeWindowMs 配置生效（窗口不同，发送时机不同）', async () => {
  const 快 = 建桥({ config: { mergeWindowMs: 300 } })
  await 快.bridge.start({ syncNow: false })
  一轮(快.bridge, 1, '[QQ]快窗口[/QQ]')
  await 睡(450)
  assert.equal(快.transport.sent.length, 1, '300ms 窗口应在 450ms 内发出')

  const 慢 = 建桥({ config: { mergeWindowMs: 1000 } })
  await 慢.bridge.start({ syncNow: false })
  一轮(慢.bridge, 1, '[QQ]慢窗口[/QQ]')
  await 睡(450)
  assert.equal(慢.transport.sent.length, 0, '1000ms 窗口不能被 450ms 提前触发')
  await 睡(700)
  assert.equal(慢.transport.sent.length, 1, '窗口到点后应该发出')

  await 快.bridge.stop()
  await 慢.bridge.stop()
})

test('配置：mergeWindowMs 默认 1200，范围钳在 300~5000', () => {
  assert.equal(normalizeConfig({}).mergeWindowMs, 1200)
  assert.equal(normalizeConfig({ mergeWindowMs: 100 }).mergeWindowMs, 300)
  assert.equal(normalizeConfig({ mergeWindowMs: 9999 }).mergeWindowMs, 5000)
})
