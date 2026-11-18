// 送信渠道是粘性的：只有「渠道消息投递成功」和「用户直接发言」会改变它。
//
// 全部走真实的 bridge.onSessionEvent：入站事件从传输层进来（走 processBatch），
// 出站由 assistant/message + turn/end 触发；断言只看传输层实际收到了什么。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '../lib/bridge.js'
import { StateStore } from '../lib/storage.js'
import { Logger } from '../lib/logger.js'
import { normalizeConfig } from '../lib/config.js'

const QQ = '10001'
const WX = 'o9cq9xYz_1@im.wechat'
const session = 'session-reply-target'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tempDir = () => mkdtempSync(join(tmpdir(), 'fish-reply-target-'))

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
    this.status = { name: 'fake', connected: false, mode: 'http' }
  }
  async start(handlers) { this.handlers = handlers; handlers.onStatus(this.status) }
  async stop() {}
  async sendMessage(peer, segments, options = {}) {
    this.sent.push({ channel: options.channel || 'qq', peer: String(peer), segments })
    return { message_id: this.sent.length }
  }
  async fetchHistory() { return [] }
  getStatus() { return this.status }
  emit(event) { this.handlers?.onEvent(event) }
}

class fakeDeliver {
  constructor() { this.got = [] }
  async deliver(req) { this.got.push(req); return { ok: true } }
  async attachmentPath() { return '' }
}

function makeBridge({ dir = tempDir(), bindings } = {}) {
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'reply-target.log'), level: 'debug' })
  const transport = new fakeTransport()
  const delivery = new fakeDeliver()
  const cfg = normalizeConfig({
    bindings: bindings || [
      { channel: 'qq', qq: QQ, session, name: '主人' },
      { channel: 'wechat', qq: WX, session, name: '微信' },
    ],
    reorderBufferMs: 0,
    inboundEditWindowMs: 0,
    outboxPerMessageDelayMs: 0,
    outboxPerCharDelayMs: 0,
  })
  const bridge = new Bridge({
    getConfig: () => cfg,
    transport,
    store,
    logger,
    voice: { async fetchImage() { throw new Error('测试不下载图片') } },
    delivery,
    autoTimers: false,
  })
  return { dir, store, logger, transport, delivery, cfg, bridge }
}

/** 一轮里一个模型步的 assistant 正文。 */
const assistantStep = (turn, text, id = 'step-' + turn) => ({
  type: 'assistant/message',
  data: { turn, step: 1, message: { id, content: [{ type: 'text', text }] } },
})
const turnEnd = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
/** DSH 的 user/message：source.kind 区分「谁把这条消息送进会话的」。 */
const userMessage = (kind) => ({ type: 'user/message', data: { source: { kind } } })

const inboundEvent = ({ channel, peer, id, text, time }) => ({
  post_type: 'message',
  message_type: 'private',
  ...(channel ? { channel } : {}),
  message_id: id,
  message_seq: Number(id) || 0,
  time,
  user_id: peer,
  message: [{ type: 'text', data: { text } }],
  raw_message: text,
  sender: { user_id: peer, nickname: '主人' },
})

/** 走一整轮：assistant 发一句话，然后 turn/end。 */
function runTurn(bridge, turn, text = `[MSG]第 ${turn} 轮[/MSG]`) {
  bridge.onSessionEvent({ id: session }, assistantStep(turn, text))
  bridge.onSessionEvent({ id: session }, turnEnd(turn))
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

test('粘性渠道：QQ 入站 → 回 QQ；重启通知（schedule）不改变它；微信入站 → 回微信', async () => {
  const { bridge, transport, delivery } = makeBridge()
  await bridge.start({ syncNow: false })

  // QQ 私聊来一条：这间会话的送信渠道变成 QQ。
  transport.emit(inboundEvent({ peer: QQ, id: 'qq-1', text: '从 QQ 来', time: nowSeconds() - 3 }))
  assert.equal(await waitFor(() => delivery.got.length === 1), true)
  runTurn(bridge, 1)
  assert.equal(await waitFor(() => transport.sent.length === 1), true)
  assert.equal(transport.sent[0].channel, 'qq')
  assert.equal(transport.sent[0].peer, QQ)
  assert.equal(transport.sent[0].segments[0].data.text, '第 1 轮')

  // 随后只来一条重启通知（source.kind = schedule）：不是渠道消息，渠道保持不变。
  bridge.onSessionEvent({ id: session }, userMessage('schedule'))
  assert.deepEqual(bridge.replyTargetFor(session), { channel: 'qq', peer: QQ })
  runTurn(bridge, 2)
  assert.equal(await waitFor(() => transport.sent.length === 2), true)
  assert.equal(transport.sent[1].channel, 'qq')
  assert.equal(transport.sent[1].peer, QQ, '重启通知之后仍然回 QQ')

  // 微信私聊来一条：渠道改成微信，下一轮回微信。
  transport.emit(inboundEvent({ channel: 'wechat', peer: WX, id: 'wx-1', text: '从微信来', time: nowSeconds() - 1 }))
  assert.equal(await waitFor(() => delivery.got.length === 2), true)
  assert.deepEqual(bridge.replyTargetFor(session), { channel: 'wechat', peer: WX })
  runTurn(bridge, 3)
  assert.equal(await waitFor(() => transport.sent.length === 3), true)
  assert.equal(transport.sent[2].channel, 'wechat')
  assert.equal(transport.sent[2].peer, WX)

  await bridge.stop()
})

test('粘性渠道：其它注入类 user/message 都不改变渠道', async () => {
  const { bridge, transport, delivery } = makeBridge()
  await bridge.start({ syncNow: false })
  transport.emit(inboundEvent({ peer: QQ, id: 'qq-1', text: '从 QQ 来', time: nowSeconds() - 5 }))
  assert.equal(await waitFor(() => delivery.got.length === 1), true)

  for (const kind of [
    'agent-message', 'subagent-settled', 'runtime-context', 'compact-checkpoint',
    'cordis-host-runner', 'session-reference', 'plan-mode', 'goal', 'webhook',
    'skill-invocation', 'ptc-mode', 'user-question-reply', 'retry', 'action-cards',
    'model', 'tool', 'system-prompt',
  ]) {
    bridge.onSessionEvent({ id: session }, userMessage(kind))
    assert.deepEqual(bridge.replyTargetFor(session), { channel: 'qq', peer: QQ }, `${kind} 不该改变渠道`)
  }

  runTurn(bridge, 1)
  assert.equal(await waitFor(() => transport.sent.length === 1), true)
  assert.equal(transport.sent[0].channel, 'qq')
  await bridge.stop()
})

test('直接发言：清空送信渠道，之后整轮不发、不进 Outbox', async () => {
  const { bridge, transport, delivery } = makeBridge()
  await bridge.start({ syncNow: false })
  transport.emit(inboundEvent({ peer: QQ, id: 'qq-1', text: '从 QQ 来', time: nowSeconds() - 3 }))
  assert.equal(await waitFor(() => delivery.got.length === 1), true)
  runTurn(bridge, 1)
  assert.equal(await waitFor(() => transport.sent.length === 1), true)

  // 用户在 Web GUI 里直接发言（source.kind = 'user'）：渠道作废。
  bridge.onSessionEvent({ id: session }, userMessage('user'))
  assert.equal(bridge.replyTargetFor(session), null)

  // 这一轮与后续几轮都不发，也不进待发队列。
  for (const turn of [2, 3]) {
    runTurn(bridge, turn)
    await sleep(40)
  }
  assert.equal(transport.sent.length, 1, '清空后一条都不发')
  assert.equal(bridge.outbox.pending(), 0, '也不进待发队列')
  await bridge.stop()
})

test('直接发言后再来 QQ 入站 → 又回 QQ', async () => {
  const { bridge, transport, delivery } = makeBridge()
  await bridge.start({ syncNow: false })
  transport.emit(inboundEvent({ peer: QQ, id: 'qq-1', text: '从 QQ 来', time: nowSeconds() - 5 }))
  assert.equal(await waitFor(() => delivery.got.length === 1), true)
  bridge.onSessionEvent({ id: session }, userMessage('user'))
  assert.equal(bridge.replyTargetFor(session), null)

  transport.emit(inboundEvent({ peer: QQ, id: 'qq-2', text: '又从 QQ 来', time: nowSeconds() - 1 }))
  assert.equal(await waitFor(() => delivery.got.length === 2), true)
  runTurn(bridge, 1)
  assert.equal(await waitFor(() => transport.sent.length === 1), true)
  assert.equal(transport.sent[0].channel, 'qq')
  assert.equal(transport.sent[0].peer, QQ)
  await bridge.stop()
})

test('回合快照：一轮生成中另一条渠道进来，这一轮仍回旧渠道', async () => {
  const { bridge, transport, delivery } = makeBridge()
  await bridge.start({ syncNow: false })
  transport.emit(inboundEvent({ peer: QQ, id: 'qq-1', text: '从 QQ 来', time: nowSeconds() - 5 }))
  assert.equal(await waitFor(() => delivery.got.length === 1), true)

  // 第 1 轮已经开始（快照 = QQ），生成期间微信来消息把渠道改掉。
  bridge.onSessionEvent({ id: session }, assistantStep(1, '[MSG]第 1 轮[/MSG]'))
  transport.emit(inboundEvent({ channel: 'wechat', peer: WX, id: 'wx-1', text: '微信插进来', time: nowSeconds() - 1 }))
  assert.equal(await waitFor(() => delivery.got.length === 2), true)
  assert.deepEqual(bridge.replyTargetFor(session), { channel: 'wechat', peer: WX })
  bridge.onSessionEvent({ id: session }, turnEnd(1))
  assert.equal(await waitFor(() => transport.sent.length === 1), true)
  assert.equal(transport.sent[0].channel, 'qq', '第 1 轮按开始时的快照回 QQ')

  // 下一轮按新渠道回微信。
  runTurn(bridge, 2)
  assert.equal(await waitFor(() => transport.sent.length === 2), true)
  assert.equal(transport.sent[1].channel, 'wechat')
  await bridge.stop()
})

test('落盘：新建 Bridge + StateStore 读同一份状态，粘性渠道还在（跨重启）', async () => {
  const dir = tempDir()
  const first = makeBridge({ dir })
  await first.bridge.start({ syncNow: false })
  first.transport.emit(inboundEvent({ peer: QQ, id: 'qq-1', text: '从 QQ 来', time: nowSeconds() - 3 }))
  assert.equal(await waitFor(() => first.delivery.got.length === 1), true)
  await first.bridge.stop()

  // 状态文件里真的有这一节：重启后不必再等一条渠道消息（键是去掉 session- 前缀的会话键）。
  const saved = JSON.parse(readFileSync(join(dir, 'fish-message-state.json'), 'utf8'))
  assert.deepEqual(
    { channel: saved.replyTargets['reply-target'].channel, peer: saved.replyTargets['reply-target'].peer },
    { channel: 'qq', peer: QQ },
  )

  const second = makeBridge({ dir })
  assert.deepEqual(second.bridge.replyTargetFor(session), { channel: 'qq', peer: QQ })
  await second.bridge.start({ syncNow: false })
  runTurn(second.bridge, 1)
  assert.equal(await waitFor(() => second.transport.sent.length === 1), true)
  assert.equal(second.transport.sent[0].channel, 'qq')
  assert.equal(second.transport.sent[0].peer, QQ)
  await second.bridge.stop()
})

test('绑定被删：渠道对不上任何绑定就跳过发送，不广播也不退回默认渠道', async () => {
  const { bridge, transport, delivery, cfg } = makeBridge({ bindings: [{ channel: 'qq', qq: QQ, session, name: '主人' }] })
  await bridge.start({ syncNow: false })
  transport.emit(inboundEvent({ peer: QQ, id: 'qq-1', text: '从 QQ 来', time: nowSeconds() - 3 }))
  assert.equal(await waitFor(() => delivery.got.length === 1), true)

  cfg.bindings = []
  bridge.updateConfig()
  runTurn(bridge, 1)
  await sleep(80)
  assert.equal(transport.sent.length, 0)
  assert.equal(bridge.outbox.pending(), 0)
  await bridge.stop()
})

test('状态文件：没有 replyTargets 的老文件照常读；最多 200 条按 at 淘汰最旧', () => {
  const dir = tempDir()
  // 老版本状态文件没有这一节：加载不报错，也没有渠道。
  writeFileSync(join(dir, 'fish-message-state.json'), JSON.stringify({
    version: 1, watermarks: {}, seen: [], stats: {}, recent: [],
  }), 'utf8')
  const legacy = new StateStore({ homeDir: dir })
  assert.equal(legacy.getReplyTarget(session), null)
  legacy.setReplyTarget(session, { channel: 'qq', peer: QQ })
  assert.deepEqual(legacy.getReplyTarget(session).peer, QQ)
  assert.equal(legacy.state.replyTargets[session].channel, 'qq')

  // 读盘时整规整：超过 200 条只留 at 最新的 200 条。
  const crowded = { version: 1, watermarks: {}, seen: [], stats: {}, recent: [], replyTargets: {} }
  for (let i = 0; i < 205; i++) {
    crowded.replyTargets[`s-${i}`] = { channel: 'qq', peer: `1000${i}`, at: i }
  }
  const dir2 = tempDir()
  writeFileSync(join(dir2, 'fish-message-state.json'), JSON.stringify(crowded), 'utf8')
  const loaded = new StateStore({ homeDir: dir2 })
  const table = loaded.snapshot().replyTargets
  assert.equal(Object.keys(table).length, 200)
  assert.equal(table['s-0'], undefined, '最旧的被淘汰')
  assert.equal(table['s-4'], undefined)
  assert.ok(table['s-204'], '最新的还在')

  // 运行中写入也会限制条数，不让状态文件无限长。
  const live = new StateStore({ homeDir: tempDir() })
  for (let i = 0; i < 205; i++) live.setReplyTarget(`live-${i}`, { channel: 'qq', peer: `2000${i}` })
  assert.equal(Object.keys(live.snapshot().replyTargets).length, 200)
  assert.ok(live.getReplyTarget('live-204'), '刚写的不会被淘汰')
})
