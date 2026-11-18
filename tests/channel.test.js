// 通道维度（qq / wechat）的地基：对端键、绑定、出站/待发落盘、桥与投递。
//
// 全部离线：传输层、投递、语音都是假对象；只验通道分桶与兼容性。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '../lib/bridge.js'
import { Delivery } from '../lib/delivery.js'
import { InflightQueue } from '../lib/inflight.js'
import { Logger } from '../lib/logger.js'
import { Outbox } from '../lib/outbox.js'
import { StateStore } from '../lib/storage.js'
import { createFishMessageApi } from '../lib/service.js'
import { normalizeBindings, normalizeConfig } from '../lib/config.js'
import {
  DEFAULT_CHANNEL,
  isInboundMessage,
  normalizeChannel,
  normalizePeer,
  parseChannel,
  peerKey,
  peerProblem,
  samePeer,
  splitPeerKey,
  watermarkKey,
} from '../lib/peer.js'

const QQ = '10001'
const WX = 'o9cq9xYz_1@im.wechat'
const WXID = 'wxid_abc_123'
const session = 'session-channel-test'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tempDir = () => mkdtempSync(join(tmpdir(), 'fish-channel-'))
const textSegment = (text) => [{ type: 'text', data: { text } }]

async function waitFor(check, timeout = 2000, interval = 10) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (check()) return true
    await sleep(interval)
  }
  return false
}

// ---------------- 对端模块 ----------------

test('通道：缺省 qq，认不出的值不冒充别的通道', () => {
  assert.equal(DEFAULT_CHANNEL, 'qq')
  assert.equal(normalizeChannel(undefined), 'qq')
  assert.equal(normalizeChannel(''), 'qq')
  assert.equal(normalizeChannel('WeChat'), 'wechat')
  assert.equal(parseChannel(undefined), 'qq')
  assert.equal(parseChannel('wx'), null, '明确写错通道时不能让调用方猜')
})

test('对端规整：qq 仍剥非数字，微信保留字母、@ 与下划线', () => {
  assert.equal(normalizePeer('qq', ' 10001 '), '10001')
  assert.equal(normalizePeer('qq', '10001abc'), '10001')
  assert.equal(normalizePeer('wechat', `  ${WX}  `), WX)
  assert.equal(normalizePeer('wechat', WXID), WXID)
})

test('对端校验：微信给明确原因，qq 保持老口径', () => {
  assert.equal(peerProblem('qq', '10001'), '')
  assert.match(peerProblem('qq', ''), /QQ 渠道的对端不能为空/)
  assert.match(peerProblem('wechat', ''), /微信对端不能为空/)
  assert.match(peerProblem('wechat', 'wx id'), /可见 ASCII/)
  assert.match(peerProblem('wechat', 'a'.repeat(129)), /太长/)
  assert.equal(peerProblem('wechat', 'a'.repeat(128)), '')
})

test('对端键：带通道前缀，同名 peer 在两个通道下不相等', () => {
  assert.equal(peerKey('qq', '10086'), 'qq:10086')
  assert.equal(peerKey('wechat', '10086'), 'wechat:10086')
  assert.notEqual(peerKey('qq', '10086'), peerKey('wechat', '10086'))
  assert.deepEqual(splitPeerKey('wechat:' + WX), { channel: 'wechat', peer: WX })
  // 老数据里的裸键按默认通道读。
  assert.deepEqual(splitPeerKey('10001'), { channel: 'qq', peer: '10001' })
})

test('水位键：微信带前缀，qq 沿用裸号以兼容老状态文件', () => {
  assert.equal(watermarkKey('qq', '10001'), '10001')
  assert.equal(watermarkKey('wechat', WX), 'wechat:' + WX)
  assert.notEqual(watermarkKey('qq', '10086'), watermarkKey('wechat', '10086'))
})

test('samePeer：空串不再等于空串；入站过滤按通道比较', () => {
  assert.equal(samePeer('qq', '', ''), false, "老实现的 '' === '' 会放行任何 id")
  assert.equal(samePeer('qq', '10001a', '10001'), true)
  assert.equal(samePeer('wechat', WX, WX), true)
  assert.equal(samePeer('wechat', WX, WXID), false)
  assert.equal(isInboundMessage({ message_type: 'group', user_id: QQ }, 'qq', QQ), false)
  assert.equal(isInboundMessage({ message_type: 'private', user_id: QQ }, 'qq', QQ), true)
  assert.equal(isInboundMessage({ message_type: 'private', user_id: QQ, self_id: QQ }, 'qq', QQ), false)
})

// ---------------- 绑定配置 ----------------

test('配置：微信对端带 @ . 下划线时绑定不被丢弃', () => {
  const cfg = normalizeConfig({
    bindings: [{ channel: 'wechat', peer: WX, session: 'session-wx', name: '微信' }],
  })
  assert.equal(cfg.bindings.length, 1)
  assert.equal(cfg.bindings[0].channel, 'wechat')
  assert.equal(cfg.bindings[0].qq, WX, 'qq 字段继续作为对端值的存储键')
  assert.equal(cfg.bindings[0].session, 'session-wx')
})

test('配置：老配置（无 channel）行为不变，非法行与写错通道的行不猜', () => {
  const cfg = normalizeConfig({
    bindings: [
      { qq: '10001', session: 'session-qq' },
      { qq: '1000 2abc', session: 'session-old' },
      { channel: 'wechat', qq: WXID, session: 'session-wx' },
      { channel: 'wechat', qq: 'bad id', session: 'session-bad' },
      { channel: 'wx', qq: WX, session: 'session-typo' },
    ],
  })
  assert.deepEqual(cfg.bindings.map((b) => [b.channel, b.qq, b.session]), [
    ['qq', '10001', 'session-qq'],
    ['qq', '10002', 'session-old'],
    ['wechat', WXID, 'session-wx'],
  ])
})

test('配置：同通道重复去重，跨通道同名 peer 都保留', () => {
  const cfg = normalizeConfig({
    bindings: [
      { qq: '10086', session: 'session-a' },
      { qq: '10086', session: 'session-b' },
      { channel: 'wechat', qq: '10086', session: 'session-c' },
    ],
  })
  assert.deepEqual(cfg.bindings.map((b) => [b.channel, b.qq, b.session]), [
    ['qq', '10086', 'session-a'],
    ['wechat', '10086', 'session-c'],
  ])
})

test('配置：同一间会话挂多条绑定都保留，同对端第二条丢掉并说明原因', () => {
  const dropped = []
  const kept = normalizeBindings([
    { channel: 'qq', qq: '10001', session: 'session-same' },
    { channel: 'wechat', peer: WX, session: 'session-same' },
    { channel: 'qq', qq: '10002', session: 'session-same' },
    { qq: '10001', session: 'session-other' },
  ], dropped)
  assert.deepEqual(kept.map((b) => [b.channel, b.qq, b.session]), [
    ['qq', '10001', 'session-same'],
    ['wechat', WX, 'session-same'],
    ['qq', '10002', 'session-same'],
  ])
  assert.deepEqual(dropped, [{ channel: 'qq', peer: '10001', reason: '这个对端已经有一条渠道了' }])
})

test('配置：规整绑定的丢弃原因都能直接展示（对端没填 / 通道写错 / 格式不对）', () => {
  const dropped = []
  normalizeBindings([
    { channel: 'wechat', peer: '', session: '' },
    { channel: 'wx', peer: WX, session: '' },
    { channel: 'wechat', peer: 'bad id', session: '' },
    { channel: 'qq', peer: 'abc', session: '' },
  ], dropped)
  assert.deepEqual(dropped.map((item) => [item.channel, item.peer, item.reason]), [
    ['wechat', '', '对端没填'],
    ['wx', WX, '通道只能填 qq 或 wechat'],
    ['wechat', 'bad id', '对端格式不对：微信对端只能是不含空格的可见 ASCII 字符（形如 o9cq...@im.wechat 或 wxid_xxx）'],
    ['qq', 'abc', '对端格式不对：QQ 渠道号只能是数字'],
  ])
})

// ---------------- 出站 / 待发持久化 ----------------

test('出站队列：微信 peer 原串入队并落盘，重启后仍可读', () => {
  const dir = tempDir()
  const first = new Outbox({ homeDir: dir, getConfig: () => normalizeConfig({}) })
  first.enqueue({ channel: 'wechat', qq: WX, segments: textSegment('微信离线消息') })
  const disk = JSON.parse(readFileSync(join(dir, 'fish-message-outbox.json'), 'utf8'))
  assert.equal(disk.items[0].channel, 'wechat')
  assert.equal(disk.items[0].qq, WX, '对端不能再被剥成空串')

  const second = new Outbox({ homeDir: dir, getConfig: () => normalizeConfig({}) })
  assert.equal(second.pending(), 1)
  assert.equal(second.list()[0].channel, 'wechat')
  assert.equal(second.list()[0].qq, WX)
})

test('出站队列：两个通道同名 peer 互不去重', () => {
  const dir = tempDir()
  const queue = new Outbox({ homeDir: dir, getConfig: () => normalizeConfig({}) })
  const a = queue.enqueue({ channel: 'qq', qq: '10086', segments: textSegment('同一句') })
  const b = queue.enqueue({ channel: 'wechat', qq: '10086', segments: textSegment('同一句') })
  assert.equal(a.deduped, false)
  assert.equal(b.deduped, false)
  assert.notEqual(a.item.fingerprint, b.item.fingerprint)
  assert.equal(queue.pending(), 2)
  // 同通道内的去重照旧。
  assert.equal(queue.enqueue({ channel: 'qq', qq: '10086', segments: textSegment('同一句') }).deduped, true)
})

test('出站队列：老格式（无 channel）按 qq 读入', () => {
  const dir = tempDir()
  const now = Date.now()
  writeFileSync(join(dir, 'fish-message-outbox.json'), JSON.stringify({
    version: 1,
    items: [{
      id: 'legacy-1',
      qq: QQ,
      segments: textSegment('老队列里的消息'),
      createdAt: now - 1000,
      attempts: 0,
      nextAttemptAt: now - 1000,
      expiresAt: now + 3600000,
      reason: '旧版本',
    }],
  }), 'utf8')
  const queue = new Outbox({ homeDir: dir, getConfig: () => normalizeConfig({}) })
  assert.equal(queue.pending(), 1)
  const item = queue.list()[0]
  assert.equal(item.channel, 'qq')
  assert.equal(item.qq, QQ)
  assert.equal(item.id, 'legacy-1')
})

test('待发记录：微信记录落盘带通道，老格式（无 channel）按 qq 读入', () => {
  const dir = tempDir()
  const queue = new InflightQueue({ homeDir: dir, getConfig: () => normalizeConfig({}) })
  queue.add({ channel: 'wechat', qq: WX, segments: textSegment('微信待发') })
  const disk = JSON.parse(readFileSync(join(dir, 'fish-message-inflight.json'), 'utf8'))
  assert.equal(disk.items[0].channel, 'wechat')
  assert.equal(disk.items[0].qq, WX)

  const legacyDir = tempDir()
  const now = Date.now()
  writeFileSync(join(legacyDir, 'fish-message-inflight.json'), JSON.stringify({
    version: 1,
    items: [{
      id: 'legacy-inflight',
      qq: QQ,
      segments: textSegment('老待发记录'),
      createdAt: now - 1000,
      dueAt: 0,
      expiresAt: now + 3600000,
      seq: 1,
      reason: '旧版本',
    }],
  }), 'utf8')
  const legacy = new InflightQueue({ homeDir: legacyDir, getConfig: () => normalizeConfig({}) })
  assert.equal(legacy.pending(), 1)
  assert.equal(legacy.list()[0].channel, 'qq')
  assert.equal(legacy.list()[0].qq, QQ)
})

// ---------------- 投递来源 ----------------

test('投递：source.kind / platform 按通道区分', async () => {
  const calls = []
  const agent = { session: {}, async followup(payload) { calls.push(payload) } }
  const delivery = new Delivery({
    ctx: {
      agents: { get: () => agent },
      sessions: { async flush() {} },
    },
    logger: null,
  })
  assert.equal((await delivery.deliver({ sessionId: 'session-a', text: '你好' })).ok, true)
  assert.equal(calls[0].source.kind, 'qq', '缺省按 qq')
  assert.equal(calls[0].source.platform, 'qq')

  assert.equal((await delivery.deliver({ sessionId: 'session-a', text: '你好', channel: 'wechat' })).ok, true)
  assert.equal(calls[1].source.kind, 'wechat')
  assert.equal(calls[1].source.platform, 'wechat')
})

// ---------------- fish.message 门面 ----------------

function makeApi() {
  const calls = []
  const bridge = {
    outbox: { pending: () => 0 },
    async sendText(peer, text, options) {
      calls.push(['sendText', peer, text, options])
      return { ok: true, sent: true, queued: false, pending: 0 }
    },
    async sendOutbound(peer, segments, options) {
      calls.push(['sendOutbound', peer, segments, options])
      return { ok: true, sent: true, queued: false, pending: 0 }
    },
  }
  const api = createFishMessageApi({
    bridge,
    transport: { async fetchHistory() { return [] } },
    getConfig: () => normalizeConfig({}),
    voice: { async recordToFile() { return { wavPath: join(tempDir(), 'a.wav') } } },
  })
  return { api, calls }
}

test('fish.message：channel 缺省 qq，微信对端原样传给桥', async () => {
  const { api, calls } = makeApi()
  await api.sendText(QQ, '给 QQ 的')
  await api.sendText(WX, '给微信的', { channel: 'wechat' })
  assert.deepEqual(calls[0], ['sendText', QQ, '给 QQ 的', { channel: 'qq' }])
  assert.deepEqual(calls[1], ['sendText', WX, '给微信的', { channel: 'wechat' }])
})

test('fish.message：错误提示按通道区分，不写死纯数字 QQ', async () => {
  const { api } = makeApi()
  await assert.rejects(() => api.sendText('', 'hi'), (error) => {
    assert.equal(error.code, 'fish_message_bad_request')
    assert.match(error.hint, /QQ 渠道的对端不能为空/)
    return true
  })
  await assert.rejects(() => api.sendText('bad peer', 'hi', { channel: 'wechat' }), (error) => {
    assert.equal(error.code, 'fish_message_bad_request')
    assert.match(error.hint, /微信对端/)
    assert.doesNotMatch(error.hint, /纯数字/)
    return true
  })
  await assert.rejects(() => api.sendText(WX, 'hi', { channel: 'wx' }), (error) => {
    assert.equal(error.code, 'fish_message_bad_request')
    assert.match(error.hint, /channel 只能是 qq 或 wechat/)
    return true
  })
})

// ---------------- Bridge 集成 ----------------

class fakeTransport {
  constructor() {
    this.sent = []
    this.handlers = null
    this.status = { name: 'fake', connected: false, mode: 'http' }
  }
  async start(handlers) { this.handlers = handlers; handlers.onStatus(this.status) }
  async stop() {}
  async sendMessage(peer, segments) {
    this.sent.push({ peer: String(peer), segments })
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

function makeBridge({ dir = tempDir(), bindings, config = {} } = {}) {
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'channel.log'), level: 'debug' })
  const transport = new fakeTransport()
  const delivery = new fakeDeliver()
  const cfg = normalizeConfig({
    bindings,
    reorderBufferMs: 0,
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

test('Bridge：微信 peer 能入站、能投递，回复只带原串不带前缀', async () => {
  const { bridge, transport, delivery, store } = makeBridge({
    bindings: [{ channel: 'wechat', qq: WX, session: 'session-wx', name: '微信' }],
  })
  await bridge.start({ syncNow: false })
  const now = Math.floor(Date.now() / 1000)
  transport.emit(inboundEvent({ channel: 'wechat', peer: WX, id: 'wx-1', text: '从微信来', time: now - 1 }))
  assert.equal(await waitFor(() => delivery.got.length === 1), true, '微信消息要能投递')
  assert.equal(delivery.got[0].sessionId, 'session-wx')
  assert.equal(delivery.got[0].channel, 'wechat')
  assert.equal(delivery.got[0].meta.qq, WX)
  assert.equal(delivery.got[0].text, '从微信来')

  // 水位按通道分桶：微信不会写到 QQ 的那一格。
  assert.ok(store.getWatermark('wechat:' + WX), '水位要带通道')
  assert.equal(store.getWatermark(WX), null)

  const reply = await bridge.deliverAssistantTurn('session-wx', '[MSG]收到[/MSG]', [], { channel: 'wechat', peer: WX })
  assert.equal(reply.ok, true)
  assert.equal(transport.sent.length, 1)
  assert.equal(transport.sent[0].peer, WX, '交给传输层的只有对端原串')
  assert.equal(transport.sent[0].segments[0].data.text, '收到')
  await bridge.stop()
})

test('Bridge：两个通道同名 peer 各自投递、水位分开、出站不互相去重', async () => {
  const { bridge, transport, delivery, store } = makeBridge({
    bindings: [
      { channel: 'qq', qq: '10086', session: 'session-qq' },
      { channel: 'wechat', qq: '10086', session: 'session-wx' },
    ],
  })
  await bridge.start({ syncNow: false })
  assert.equal(bridge.byPeer.size, 2, '同名 peer 在两个通道下是两条绑定')

  const now = Math.floor(Date.now() / 1000)
  transport.emit(inboundEvent({ peer: '10086', id: 'qq-1', text: 'QQ 那边的话', time: now - 2 }))
  transport.emit(inboundEvent({ channel: 'wechat', peer: '10086', id: 'wx-1', text: '微信那边的话', time: now - 1 }))
  assert.equal(await waitFor(() => delivery.got.length === 2), true)
  const bySession = Object.fromEntries(delivery.got.map((x) => [x.sessionId, x]))
  assert.equal(bySession['session-qq'].text, 'QQ 那边的话')
  assert.equal(bySession['session-qq'].meta.qq, '10086')
  assert.equal(bySession['session-wx'].text, '微信那边的话')
  assert.equal(bySession['session-wx'].channel, 'wechat')

  assert.ok(store.getWatermark('10086'), 'qq 的水位在裸号那一格')
  assert.ok(store.getWatermark('wechat:10086'), '微信的水位在带前缀那一格')
  assert.equal(store.getWatermark('10086').messageId, 'qq-1')
  assert.equal(store.getWatermark('wechat:10086').messageId, 'wx-1')

  // 出站：同样内容分别发到两个通道，不能被 fingerprint 合成一条。
  await bridge.sendOutbound('10086', textSegment('同一句'), { channel: 'qq' })
  await bridge.sendOutbound('10086', textSegment('同一句'), { channel: 'wechat' })
  assert.deepEqual(transport.sent.map((x) => x.peer), ['10086', '10086'], '传输层只收对端原串')
  await bridge.stop()
})

test('Bridge：同一会话挂 QQ + 微信两条绑定，各轮回复回到本轮来的那条', async () => {
  const multiSession = 'session-multi'
  const { bridge, transport, delivery } = makeBridge({
    bindings: [
      { channel: 'qq', qq: QQ, session: multiSession, name: '主人' },
      { channel: 'wechat', qq: WX, session: multiSession, name: '微信' },
    ],
  })
  // 记下真正交给传输层的通道：fakeTransport 不解析 options，这里包一层。
  const sent = []
  const originalSend = transport.sendMessage.bind(transport)
  transport.sendMessage = async (peer, segments, options = {}) => {
    sent.push({ channel: options.channel, peer: String(peer) })
    return originalSend(peer, segments, options)
  }
  await bridge.start({ syncNow: false })
  const now = Math.floor(Date.now() / 1000)

  // 第一轮：QQ 来消息 → 本轮回复发给 QQ。
  transport.emit(inboundEvent({ peer: QQ, id: 'multi-qq-1', text: 'QQ 这边说话', time: now - 2 }))
  assert.equal(await waitFor(() => delivery.got.length === 1), true)
  bridge.onSessionEvent({ id: multiSession }, assistantStep(1, '[MSG]回给 QQ[/MSG]', 'm-1'))
  bridge.onSessionEvent({ id: multiSession }, turnEnd(1))
  assert.equal(await waitFor(() => sent.length === 1), true)
  assert.deepEqual(sent[0], { channel: 'qq', peer: QQ })

  // 第二轮：微信来消息 → 本轮回复发给微信，而不是 QQ。
  transport.emit(inboundEvent({ channel: 'wechat', peer: WX, id: 'multi-wx-1', text: '微信这边说话', time: now - 1 }))
  assert.equal(await waitFor(() => delivery.got.length === 2), true)
  bridge.onSessionEvent({ id: multiSession }, assistantStep(2, '[MSG]回给微信[/MSG]', 'm-2'))
  bridge.onSessionEvent({ id: multiSession }, turnEnd(2))
  assert.equal(await waitFor(() => sent.length === 2), true)
  assert.deepEqual(sent[1], { channel: 'wechat', peer: WX })
  await bridge.stop()
})

test('Bridge：没有入站来源的回合（网页端输入）整轮不发，也不进 Outbox', async () => {
  const { bridge, transport } = makeBridge({
    bindings: [
      { channel: 'qq', qq: QQ, session, name: '主人' },
      { channel: 'wechat', qq: WX, session, name: '微信' },
    ],
  })
  await bridge.start({ syncNow: false })
  bridge.onSessionEvent({ id: session }, assistantStep(1, '[MSG]网页端这一轮[/MSG]'))
  bridge.onSessionEvent({ id: session }, turnEnd(1))
  await sleep(80)
  assert.equal(transport.sent.length, 0, '没有渠道来源就一条都不发')
  assert.equal(bridge.outbox.pending(), 0, '也不进待发队列')
  await bridge.stop()
})

test('Bridge：上一轮的渠道来源不会被网页端输入的下一轮复用', async () => {
  const { bridge, transport, delivery } = makeBridge({ bindings: [{ qq: QQ, session, name: '主人' }] })
  await bridge.start({ syncNow: false })
  const now = Math.floor(Date.now() / 1000)
  transport.emit(inboundEvent({ peer: QQ, id: 'only-1', text: '渠道来的话', time: now - 1 }))
  assert.equal(await waitFor(() => delivery.got.length === 1), true)

  bridge.onSessionEvent({ id: session }, assistantStep(1, '[MSG]回渠道[/MSG]', 't1'))
  bridge.onSessionEvent({ id: session }, turnEnd(1))
  assert.equal(await waitFor(() => transport.sent.length === 1), true)

  // 第二轮是网页端输入：没有新的入站来源，不能拿上一轮的来源凑。
  bridge.onSessionEvent({ id: session }, assistantStep(2, '[MSG]不该发出去[/MSG]', 't2'))
  bridge.onSessionEvent({ id: session }, turnEnd(2))
  await sleep(80)
  assert.equal(transport.sent.length, 1, '第二轮一条都不发')
  assert.equal(bridge.outbox.pending(), 0)
  await bridge.stop()
})

test('Bridge：显式指定通道的发送（fish.message / 测试发送）不受本轮来源影响', async () => {
  const { bridge, transport } = makeBridge({
    bindings: [{ channel: 'wechat', qq: WX, session, name: '微信' }],
  })
  await bridge.start({ syncNow: false })
  await bridge.sendOutbound(WX, textSegment('显式发微信'), { channel: 'wechat' })
  assert.equal(transport.sent.length, 1)
  assert.equal(transport.sent[0].peer, WX)
  await bridge.stop()
})

test('Bridge：老格式的待发/出站数据照常补发（无 channel 按 qq）', async () => {
  const dir = tempDir()
  const now = Date.now()
  writeFileSync(join(dir, 'fish-message-inflight.json'), JSON.stringify({
    version: 1,
    items: [{
      id: 'legacy-inflight',
      qq: QQ,
      segments: textSegment('重启前没发出去'),
      createdAt: now - 1000,
      dueAt: 0,
      expiresAt: now + 3600000,
      seq: 1,
      reason: '旧版本',
    }],
  }), 'utf8')
  writeFileSync(join(dir, 'fish-message-outbox.json'), JSON.stringify({
    version: 1,
    items: [{
      id: 'legacy-outbox',
      qq: QQ,
      segments: textSegment('老积压'),
      createdAt: now - 1000,
      attempts: 0,
      nextAttemptAt: now - 1000,
      expiresAt: now + 3600000,
      reason: '旧版本',
    }],
  }), 'utf8')

  const { bridge, transport } = makeBridge({ dir, bindings: [{ qq: QQ, session }] })
  await bridge.start({ syncNow: false })
  assert.equal(bridge.inflight.pending(), 1, '老待发记录要读得进来')
  assert.equal(bridge.outbox.pending(), 1, '老出站积压要读得进来')
  // 先补出站积压，再回放待发记录：反过来时待发记录会按顺序转进 outbox。
  const flushed = await bridge.flushOutbox('test-legacy', { force: true })
  assert.equal(flushed.sent, 1)
  const replay = await bridge.replayInflight('test-legacy')
  assert.equal(replay.sent, 1)
  assert.deepEqual(transport.sent.map((x) => x.peer), [QQ, QQ])
  await bridge.stop()
})

test('Bridge：老配置（无 channel）的 QQ 收发与水位键都不变', async () => {
  const { bridge, transport, delivery, store } = makeBridge({ bindings: [{ qq: QQ, session }] })
  await bridge.start({ syncNow: false })
  const now = Math.floor(Date.now() / 1000)
  transport.emit(inboundEvent({ peer: QQ, id: 'qq-1', text: '老配置来的消息', time: now - 1 }))
  assert.equal(await waitFor(() => delivery.got.length === 1), true)
  assert.equal(delivery.got[0].channel, 'qq')
  assert.equal(delivery.got[0].meta.qq, QQ)

  assert.ok(store.getWatermark(QQ), 'qq 仍写裸号水位，老状态文件通用')
  assert.equal(store.getWatermark('qq:' + QQ), null)

  await bridge.sendText(QQ, '老配置的回复')
  assert.equal(transport.sent[0].peer, QQ)
  await bridge.stop()
})
