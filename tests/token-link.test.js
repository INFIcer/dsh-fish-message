// 峰时转任务队列 + 余额提醒：fish.token 契约的可选接入。
//
// 两种极端都要盯住：服务在时按契约走（入队/提醒/去重/冷却），服务不在、抛错、
// 超时、入队失败时一律退回「照旧直接投递」——消息绝不能丢，这是硬要求。
// 测试里不连任何真实服务：fish.token 用假的，发送用 fakeTransport。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '../lib/bridge.js'
import { StateStore } from '../lib/storage.js'
import { Logger } from '../lib/logger.js'
import {
  ConfigStore,
  DEFAULT_CONFIG,
  normalizeConfig,
  renderPeakNotice,
  renderBalanceAlert,
  balanceAlertSwitches,
  defaultPeakNotice,
  defaultBalanceAlert,
} from '../lib/config.js'
import {
  TokenLink,
  BalanceAlertForwarder,
  stripUrgentMarker,
  tokenTimeoutMs,
} from '../lib/token-link.js'

const QQ = '10001'
const session = 'session-peak'
const sessionKey = 'peak' // Bridge 内部会话键：session- 前缀会去掉

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check, timeout = 2000, interval = 10) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (await check()) return true
    await sleep(interval)
  }
  return false
}

const tempDir = () => mkdtempSync(join(tmpdir(), 'fish-token-'))

/** 规整后只取余额提醒的两个开关，便于断言迁移与组合结果。 */
const switchesOf = (raw) => {
  const config = normalizeConfig(raw)
  return { message: config.balanceAlertMessageEnabled, sticker: config.balanceAlertStickerEnabled }
}

function makeMessage(id, text, time = Math.floor(Date.now() / 1000), qq = QQ) {
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
  constructor() {
    this.sent = []
    this.handlers = null
    this.status = { name: 'fake', connected: false, mode: 'http' }
  }
  async start(handlers) { this.handlers = handlers; handlers.onStatus(this.status) }
  async stop() {}
  async sendMessage(peer, segments) { this.sent.push({ peer: String(peer), segments }); return { message_id: 1 } }
  async fetchHistory() { return [] }
  getStatus() { return this.status }
  message(event) { this.handlers?.onEvent({ post_type: 'message', message_type: 'private', ...event }) }
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

function makeBridge({ dir = tempDir(), config = {}, token = null } = {}) {
  const store = new StateStore({ homeDir: dir })
  const logger = new Logger({ filePath: join(dir, 'test.log'), level: 'debug' })
  const transport = new fakeTransport()
  const delivery = new fakeDeliver()
  const cfg = normalizeConfig({
    napcatBaseUrl: 'http://127.0.0.1:3000',
    bindings: [{ channel: 'qq', qq: QQ, session, name: '主人', enabled: true }],
    backfillWindowHours: 24,
    reorderBufferMs: 10,
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
    voice: {},
    delivery,
    token,
    autoTimers: false,
  })
  store.setWatermark(QQ, { timestamp: 1, messageId: '' })
  return { dir, store, logger, transport, delivery, cfg, bridge }
}

/** 假的 fish.token：只实现鱼讯用到的那几个方法，形状按冻结契约。 */
function makeToken({
  peak = true,
  pricing = null,
  onEnqueue = null,
  subscribe = true,
} = {}) {
  const enqueued = []
  const listeners = []
  const service = {
    version: 1,
    getPricing(at = Date.now()) {
      if (typeof pricing === 'function') return pricing(at)
      return {
        ok: true,
        period: peak ? 'peak' : 'offpeak',
        peak,
        multiplier: peak ? 2 : 1,
        timezone: 'Asia/Hong_Kong',
        now: at,
        nextSwitchAt: 0,
        nextPeakAt: null,
        nextOffPeakAt: null,
      }
    },
    async enqueueTask(payload) {
      if (onEnqueue) return onEnqueue(payload)
      enqueued.push(payload)
      return { ok: true, task: { id: `t-${enqueued.length}`, status: 'pending', ...payload } }
    },
  }
  if (subscribe) {
    service.subscribe = (handler) => { listeners.push(handler); return () => { listeners.length = 0 } }
  }
  return { service, enqueued, listeners }
}

/** 入队失败 / 抛错 / 不响应：enqueueTask 的各种翻车方式。 */
const failingToken = (mode) => makeToken({
  onEnqueue: () => {
    if (mode === 'reject') return { ok: false, error: '队列满了' }
    if (mode === 'throw') throw new Error('服务挂了')
    return new Promise(() => {}) // 永不 resolve：只等得到超时
  },
})

async function runInbound(bridge, transport, message, waitForCondition) {
  await bridge.start({ syncNow: false })
  transport.message(message)
  const ok = await waitFor(waitForCondition)
  await bridge.stop()
  return ok
}

// ---------------- 配置：默认值、旧配置、非法值 ----------------

test('配置：fish.token 相关键默认值齐全，旧配置缺这些键也能加载', () => {
  const config = normalizeConfig({ bindings: [{ qq: QQ, session, enabled: true }] })
  assert.equal(config.peakDeferEnabled, true)
  assert.equal(config.peakNoticeTemplate, '')
  assert.equal(config.peakNoticeCooldownMinutes, 30)
  // 余额提醒是两个独立开关：文字默认开、表情默认关。
  assert.equal(config.balanceAlertMessageEnabled, true)
  assert.equal(config.balanceAlertStickerEnabled, false)
  assert.equal(config.balanceAlertTemplate, '')
  assert.equal(config.balanceAlertSticker, '')
  // 默认文案原文只在 config.js：峰时提醒与余额提醒各一段。
  assert.equal(DEFAULT_CONFIG.peakDeferEnabled, true)
  assert.equal(DEFAULT_CONFIG.balanceAlertMessageEnabled, true)
  assert.equal(DEFAULT_CONFIG.balanceAlertStickerEnabled, false)
  assert.equal(defaultPeakNotice, '当前为峰值计价时段，可留言。谷值计价时段会自动处理。可在留言开头使用【紧要】立即安排处理')
  assert.equal(defaultBalanceAlert, '当前余额 {balance} 元，余额偏低，记得充值。')

  // 旧配置文件（没有这几个键）走 ConfigStore.load：照常拿到默认值，不报错。
  const dir = tempDir()
  writeFileSync(join(dir, 'fish-message-config.json'), JSON.stringify({
    napcatBaseUrl: 'http://127.0.0.1:3000',
    bindings: [{ qq: QQ, session }],
  }))
  const loaded = new ConfigStore({ homeDir: dir }).load({})
  assert.equal(loaded.peakDeferEnabled, true)
  assert.equal(loaded.balanceAlertMessageEnabled, true)
  assert.equal(loaded.balanceAlertStickerEnabled, false)
  assert.equal(loaded.bindings.length, 1)
})

test('配置：非法值在 /save 规整时回落默认', () => {
  const config = normalizeConfig({
    peakDeferEnabled: 'maybe',
    peakNoticeTemplate: 12345,
    peakNoticeCooldownMinutes: 'abc',
    balanceAlertMessageEnabled: 'maybe',
    balanceAlertStickerEnabled: 'maybe',
    balanceAlertTemplate: 'x'.repeat(5000),
    balanceAlertSticker: '  #余额  ',
  })
  assert.equal(config.peakDeferEnabled, true)
  assert.equal(config.peakNoticeTemplate, '')
  assert.equal(config.peakNoticeCooldownMinutes, 30)
  // 非布尔按各自的默认处理：文字开、表情关。
  assert.equal(config.balanceAlertMessageEnabled, true)
  assert.equal(config.balanceAlertStickerEnabled, false)
  assert.equal(config.balanceAlertTemplate, '')
  assert.equal(config.balanceAlertSticker, '#余额')

  // 范围钳制：冷却 0 保留（= 不冷却），负数回到 0，超上限回到 1440。
  assert.equal(normalizeConfig({ peakNoticeCooldownMinutes: 0 }).peakNoticeCooldownMinutes, 0)
  assert.equal(normalizeConfig({ peakNoticeCooldownMinutes: -5 }).peakNoticeCooldownMinutes, 0)
  assert.equal(normalizeConfig({ peakNoticeCooldownMinutes: 99999 }).peakNoticeCooldownMinutes, 1440)
  // 两个开关互相独立：四种组合都能如实保存。
  assert.deepEqual(switchesOf({ balanceAlertMessageEnabled: true, balanceAlertStickerEnabled: true }), { message: true, sticker: true })
  assert.deepEqual(switchesOf({ balanceAlertMessageEnabled: true, balanceAlertStickerEnabled: false }), { message: true, sticker: false })
  assert.deepEqual(switchesOf({ balanceAlertMessageEnabled: false, balanceAlertStickerEnabled: true }), { message: false, sticker: true })
  assert.deepEqual(switchesOf({ balanceAlertMessageEnabled: false, balanceAlertStickerEnabled: false }), { message: false, sticker: false })
})

test('配置：旧 balanceAlertMode 迁移成两个开关，迁移后新键优先', () => {
  // 三种旧值各对应一组新开关。
  assert.deepEqual(switchesOf({ balanceAlertMode: 'off' }), { message: false, sticker: false })
  assert.deepEqual(switchesOf({ balanceAlertMode: 'message' }), { message: true, sticker: false })
  assert.deepEqual(switchesOf({ balanceAlertMode: 'sticker' }), { message: false, sticker: true })
  // 大小写与首尾空白照样认。
  assert.deepEqual(switchesOf({ balanceAlertMode: ' STICKER ' }), { message: false, sticker: true })
  // 旧值非法（或不认识）：落新键的默认（文字开、表情关）。
  assert.deepEqual(switchesOf({ balanceAlertMode: 'speak' }), { message: true, sticker: false })
  // 未规整的原始配置直接问开关也按迁移表走。
  assert.deepEqual(balanceAlertSwitches({ balanceAlertMode: 'sticker' }), { message: false, sticker: true })

  // 新键一旦出现，旧键不再参与（没给的那个新键落自己的默认）。
  assert.deepEqual(switchesOf({ balanceAlertMode: 'off', balanceAlertMessageEnabled: true }), { message: true, sticker: false })
  assert.deepEqual(switchesOf({ balanceAlertMode: 'sticker', balanceAlertStickerEnabled: false }), { message: true, sticker: false })
  assert.deepEqual(switchesOf({ balanceAlertMode: 'message', balanceAlertStickerEnabled: true }), { message: true, sticker: true })

  // 规整结果里不再有旧键；落盘一次后文件里也只剩新键。
  assert.equal('balanceAlertMode' in normalizeConfig({ balanceAlertMode: 'sticker' }), false)
  const dir = tempDir()
  const store = new ConfigStore({ homeDir: dir })
  writeFileSync(join(dir, 'fish-message-config.json'), JSON.stringify({ balanceAlertMode: 'sticker' }))
  const loaded = store.load({})
  assert.equal(loaded.balanceAlertMessageEnabled, false)
  assert.equal(loaded.balanceAlertStickerEnabled, true)
  store.save(loaded)
  const persisted = JSON.parse(readFileSync(join(dir, 'fish-message-config.json'), 'utf8'))
  assert.equal(persisted.balanceAlertMessageEnabled, false)
  assert.equal(persisted.balanceAlertStickerEnabled, true)
  assert.equal('balanceAlertMode' in persisted, false)
})

test('文案：峰时提醒占位符、余额两位小数', () => {
  assert.equal(renderPeakNotice(''), defaultPeakNotice)
  // 占位符填的是 fish.token 给的「下一段谷时」起止，鱼讯不自己算窗口。
  assert.equal(renderPeakNotice('谷时 {offPeakStart} 到 {offPeakEnd}', { start: '12:00', end: '14:00' }), '谷时 12:00 到 14:00')
  // 拿不到服务给的时刻：整段回退内置默认，不留「谷时 到 再处理」这样的半句。
  assert.equal(renderPeakNotice('谷时 {offPeakStart} 到 {offPeakEnd}'), defaultPeakNotice)
  assert.equal(renderBalanceAlert('', 9.6), '当前余额 9.60 元，余额偏低，记得充值。')
  assert.equal(renderBalanceAlert('余额 {balance} 元', 12), '余额 12.00 元')
  // 开关本身：没有任何相关配置时是「文字开、表情关」。
  assert.deepEqual(balanceAlertSwitches({}), { message: true, sticker: false })
})

test('【紧要】：只认开头，去掉标记后不留空消息', () => {
  assert.deepEqual(stripUrgentMarker('  【紧要】现在做  '), { urgent: true, text: '现在做' })
  assert.deepEqual(stripUrgentMarker('先说【紧要】再说'), { urgent: false, text: '先说【紧要】再说' })
  // 只剩标记：保留原文，否则整批变成空消息投不进会话。
  assert.deepEqual(stripUrgentMarker('【紧要】'), { urgent: true, text: '【紧要】' })
})

// ---------------- 需求 1：峰时转任务 ----------------

test('峰时：这一批进任务队列，不投会话；去重、水位、统计、提醒照记', async () => {
  const token = makeToken({ peak: true })
  const { bridge, transport, delivery, store } = makeBridge({ token: () => token.service })
  const ok = await runInbound(bridge, transport, makeMessage('101', '峰时留言'), () => token.enqueued.length > 0)
  assert.equal(ok, true)
  assert.equal(delivery.got.length, 0, '峰时不能投进会话')
  assert.deepEqual(token.enqueued[0], {
    prompt: '峰时留言',
    sessionKey,
    channel: 'qq',
    peer: QQ,
    source: 'fish-message',
  })
  // 消息没丢：seen / 水位 / received 照常逐条记；delivered 不算（没进会话）。
  assert.equal(store.hasSeen('101'), true)
  assert.equal(store.getWatermark(QQ).messageId, '101')
  assert.equal(store.snapshot().stats.received, 1)
  assert.equal(store.snapshot().stats.delivered, 0)
  assert.match(store.snapshot().recent.find((x) => x.direction === 'in').text, /^\[峰时转任务\] 峰时留言$/)
  // 送信渠道仍指向这条：任务稍后跑起来时回复要回到同一个渠道。
  assert.deepEqual(bridge.replyTargetFor(session), { channel: 'qq', peer: QQ })
  // 自动回一条默认提醒（走正常出站链路）。
  assert.deepEqual(transport.sent.map((x) => x.segments[0].data.text), [defaultPeakNotice])
  assert.equal(transport.sent[0].peer, QQ)
})

test('峰时：提醒文案可改、占位符用服务给的谷时起止；开关关掉照旧直接投递', async () => {
  // 2026-11-19 是工作日：12:00 进谷时（午休），14:00 回峰时。时刻由服务给，这边只格式化。
  const hkt = (hour) => Date.UTC(2026, 10, 19, hour - 8, 0)
  const token = makeToken({
    peak: true,
    pricing: () => ({
      ok: true, peak: true, period: 'peak', multiplier: 2, timezone: 'Asia/Hong_Kong',
      now: Date.now(), nextSwitchAt: hkt(12), nextPeakAt: hkt(14), nextOffPeakAt: hkt(12),
    }),
  })
  const first = makeBridge({
    token: () => token.service,
    config: { peakNoticeTemplate: '峰时先留着，{offPeakStart} 到 {offPeakEnd} 再处理' },
  })
  const ok = await runInbound(first.bridge, first.transport, makeMessage('102', '自定义提醒'), () => token.enqueued.length > 0)
  assert.equal(ok, true)
  assert.deepEqual(first.transport.sent.map((x) => x.segments[0].data.text), ['峰时先留着，12:00 到 14:00 再处理'])

  const off = makeBridge({ token: () => token.service, config: { peakDeferEnabled: false } })
  const delivered = await runInbound(off.bridge, off.transport, makeMessage('103', '开关关掉'), () => off.delivery.got.length > 0)
  assert.equal(delivered, true)
  assert.equal(off.delivery.got[0].text, '开关关掉')
  assert.equal(token.enqueued.length, 1, '开关关掉不能再入队')
  assert.equal(off.transport.sent.length, 0, '开关关掉不提醒')
})

test('峰时：【紧要】开头直接进会话并去掉标记，不提醒', async () => {
  const token = makeToken({ peak: true })
  const { bridge, transport, delivery } = makeBridge({ token: () => token.service })
  const ok = await runInbound(bridge, transport, makeMessage('201', '【紧要】现在就要'), () => delivery.got.length > 0)
  assert.equal(ok, true)
  assert.equal(delivery.got[0].text, '现在就要')
  assert.equal(token.enqueued.length, 0, '紧要消息不能进任务队列')
  assert.equal(transport.sent.length, 0, '紧要消息不提醒')
})

test('峰时：同一对端提醒按冷却只回一条；0 = 不冷却', async () => {
  const token = makeToken({ peak: true })
  const { bridge, transport, cfg } = makeBridge({ token: () => token.service })
  await bridge.start({ syncNow: false })
  transport.message(makeMessage('301', '第一条'))
  assert.equal(await waitFor(() => token.enqueued.length === 1), true)
  transport.message(makeMessage('302', '第二条'))
  assert.equal(await waitFor(() => token.enqueued.length === 2), true)
  assert.equal(token.enqueued[0].prompt, '第一条')
  assert.equal(token.enqueued[1].prompt, '第二条')
  assert.equal(transport.sent.length, 1, '冷却期内不再重复提醒，但消息照样入队')

  // 冷却设成 0：每次入队都提醒。
  cfg.peakNoticeCooldownMinutes = 0
  transport.message(makeMessage('303', '第三条'))
  assert.equal(await waitFor(() => token.enqueued.length === 3), true)
  assert.equal(await waitFor(() => transport.sent.length === 2), true)
  await bridge.stop()
})

test('服务缺失：功能不可用，照旧直接投递，不提醒', async () => {
  const missing = makeBridge({ token: () => undefined })
  assert.equal(await runInbound(missing.bridge, missing.transport, makeMessage('401', '没有服务'), () => missing.delivery.got.length > 0), true)
  assert.equal(missing.delivery.got[0].text, '没有服务')
  assert.equal(missing.transport.sent.length, 0)

  // 没有 token 参数（宿主没装 fish-token）也是老行为。
  const none = makeBridge()
  assert.equal(await runInbound(none.bridge, none.transport, makeMessage('402', '没有 token'), () => none.delivery.got.length > 0), true)
  assert.equal(none.delivery.got[0].text, '没有 token')

  // 服务明确报谷时：照样直接投递。
  const offpeak = makeToken({ peak: false })
  const low = makeBridge({ token: () => offpeak.service })
  assert.equal(await runInbound(low.bridge, low.transport, makeMessage('403', '谷时消息'), () => low.delivery.got.length > 0), true)
  assert.equal(low.delivery.got[0].text, '谷时消息')
  assert.equal(offpeak.enqueued.length, 0)
  assert.equal(low.transport.sent.length, 0)
})

test('峰谷判定只信 fish.token：查询抛错 / 形状不对时按峰时（最保守）', async () => {
  // 拿不到时段不能当成谷时：那会在峰时白跑贵任务。
  const throwing = makeToken({ pricing: () => { throw new Error('计价炸了') } })
  const boom = makeBridge({ token: () => throwing.service })
  assert.equal(await runInbound(boom.bridge, boom.transport, makeMessage('404', '计价抛错'), () => throwing.enqueued.length > 0), true)
  assert.equal(throwing.enqueued[0].prompt, '计价抛错')
  assert.equal(boom.delivery.got.length, 0)
  assert.equal(boom.transport.sent.length, 1, '当成峰时：入队并回一条提醒')

  // 返回形状不对（没有 peak 布尔值）同样按峰时处理。
  const malformed = makeToken({ pricing: () => ({ ok: true, period: 'peak' }) })
  const weird = makeBridge({ token: () => malformed.service })
  assert.equal(await runInbound(weird.bridge, weird.transport, makeMessage('405', '形状不对'), () => malformed.enqueued.length > 0), true)
  assert.equal(malformed.enqueued[0].prompt, '形状不对')
  assert.equal(weird.delivery.got.length, 0)

  // 鱼讯自己不写钟点/周末判断：时段结论完全来自服务的 getPricing。
  const link = new TokenLink({ getService: () => ({ getPricing: () => ({ peak: true }) }) })
  assert.equal(link.peakNow(), true)
  const missing = new TokenLink({ getService: () => undefined })
  assert.equal(missing.peakNow(), null)
})

test('入队失败 / 抛错 / 超时：回退成直接投递，消息不丢', async () => {
  for (const mode of ['reject', 'throw', 'timeout']) {
    const failing = failingToken(mode)
    // 超时用例把等待压到 25ms，测试不用真等 800ms。
    const token = mode === 'timeout'
      ? new TokenLink({ getService: () => failing.service, timeoutMs: 25 })
      : () => failing.service
    const { bridge, transport, delivery } = makeBridge({ token })
    const ok = await runInbound(bridge, transport, makeMessage(`50-${mode}`, `入队失败-${mode}`), () => delivery.got.length > 0)
    assert.equal(ok, true, `${mode} 时也要投进会话`)
    assert.equal(delivery.got[0].text, `入队失败-${mode}`)
    assert.equal(transport.sent.length, 0, `${mode} 时不发提醒`)
  }
})

// ---------------- 需求 2：余额提醒 ----------------

function makeBridgeStub({ target = { channel: 'qq', peer: QQ } } = {}) {
  return {
    sent: [],
    latestReplyTarget() { return target },
    async sendText(peer, text, { channel } = {}) {
      this.sent.push({ peer, text, channel })
      return { ok: true, sent: true, queued: false }
    },
  }
}

/** 收集日志的假 logger：只关心 balance alert 记了什么。 */
function makeLogger() {
  const logs = { info: [], warn: [], debug: [] }
  const push = (level) => (text) => logs[level].push(String(text))
  return { logs, info: push('info'), warn: push('warn'), debug: push('debug') }
}

test('余额提醒：只开文字 → 发一条文字到当前送信渠道，{balance} 两位小数', async () => {
  const bridge = makeBridgeStub()
  const alerts = new BalanceAlertForwarder({
    bridge,
    getConfig: () => normalizeConfig({ balanceAlertMessageEnabled: true, balanceAlertStickerEnabled: false }),
    logger: null,
  })
  const result = await alerts.handle({ type: 'balance-low', threshold: 10, balance: 9.6, at: Date.now() })
  assert.equal(result.ok, true)
  assert.equal(result.message.ok, true)
  assert.equal(result.message.text, '当前余额 9.60 元，余额偏低，记得充值。')
  assert.equal(result.sticker, undefined)
  assert.deepEqual(bridge.sent, [{ peer: QQ, text: '当前余额 9.60 元，余额偏低，记得充值。', channel: 'qq' }])

  // 自定义文案。
  const custom = makeBridgeStub()
  const customAlerts = new BalanceAlertForwarder({ bridge: custom, getConfig: () => normalizeConfig({ balanceAlertTemplate: '只剩 {balance} 了' }) })
  await customAlerts.handle({ type: 'balance-low', threshold: 5, balance: '3.4' })
  assert.equal(custom.sent[0].text, '只剩 3.40 了')
})

test('余额提醒：只开表情 → 只发表情，不额外补文字', async () => {
  const bridge = makeBridgeStub()
  const calls = []
  const alerts = new BalanceAlertForwarder({
    bridge,
    getConfig: () => normalizeConfig({ balanceAlertMessageEnabled: false, balanceAlertStickerEnabled: true, balanceAlertSticker: '#余额' }),
    sendSticker: async (target, name) => { calls.push({ target, name }); return { ok: true } },
  })
  const result = await alerts.handle({ type: 'balance-low', threshold: 10, balance: 9.6 })
  assert.equal(result.ok, true)
  assert.equal(result.message, undefined)
  assert.equal(result.sticker.ok, true)
  assert.deepEqual(calls, [{ target: { channel: 'qq', peer: QQ }, name: '#余额' }])
  assert.equal(bridge.sent.length, 0, '只开表情时不再补一条文字')
})

test('余额提醒：两个都开 → 先文字、后表情，任一失败不影响另一个', async () => {
  const events = []
  const bridge = makeBridgeStub()
  bridge.sendText = async function (peer, text, { channel } = {}) {
    events.push(['text', text])
    this.sent.push({ peer, text, channel })
    return { ok: true, sent: true, queued: false }
  }
  const alerts = new BalanceAlertForwarder({
    bridge,
    getConfig: () => normalizeConfig({ balanceAlertMessageEnabled: true, balanceAlertStickerEnabled: true, balanceAlertSticker: '#余额' }),
    sendSticker: async (target, name) => { events.push(['sticker', name]); return { ok: true } },
  })
  const result = await alerts.handle({ type: 'balance-low', threshold: 10, balance: 9.6 })
  assert.equal(result.ok, true)
  assert.deepEqual(events.map((x) => x[0]), ['text', 'sticker'], '顺序固定：先文字、后表情')
  assert.equal(result.message.ok, true)
  assert.equal(result.sticker.ok, true)

  // 文字失败不影响表情：两项都尝试过，日志各记一条。
  const logger = makeLogger()
  const failingBridge = makeBridgeStub()
  failingBridge.sendText = async () => { throw new Error('桥断了') }
  const both = new BalanceAlertForwarder({
    bridge: failingBridge,
    logger,
    getConfig: () => normalizeConfig({ balanceAlertMessageEnabled: true, balanceAlertStickerEnabled: true, balanceAlertSticker: '#余额' }),
    sendSticker: async () => ({ ok: true }),
  })
  const failedText = await both.handle({ type: 'balance-low', threshold: 11, balance: 1 })
  assert.equal(failedText.ok, true, '文字失败、表情成功：整体仍算发出去了')
  assert.equal(failedText.message.ok, false)
  assert.equal(failedText.sticker.ok, true)
  assert.match(logger.logs.warn.join('\n'), /余额提醒文字没发出去：桥断了/)
  assert.match(logger.logs.info.join('\n'), /（表情 #余额）/)

  // 表情失败不影响文字（文字先发出）：同样各记一条日志。
  const stickerFailed = makeLogger()
  const stickerBridge = makeBridgeStub()
  const mixed = new BalanceAlertForwarder({
    bridge: stickerBridge,
    logger: stickerFailed,
    getConfig: () => normalizeConfig({ balanceAlertMessageEnabled: true, balanceAlertStickerEnabled: true, balanceAlertSticker: '没有这个表情' }),
    sendSticker: async () => { throw new Error('找不到表情') },
  })
  const mixedResult = await mixed.handle({ type: 'balance-low', threshold: 12, balance: 1 })
  assert.equal(mixedResult.ok, true)
  assert.equal(mixedResult.message.ok, true)
  assert.equal(mixedResult.sticker.ok, false)
  assert.match(stickerFailed.logs.info.join('\n'), /余额提醒已发到 qq 10001：当前余额 1\.00 元/)
  assert.match(stickerFailed.logs.warn.join('\n'), /找不到表情/)
})

test('余额提醒：表情失败时文字开着只留那一条，不重复补；文字关着只记 warn 放弃', async () => {
  // 两个都开：文字先发出去，表情失败不再补第二条文字。
  const bridge = makeBridgeStub()
  const logger = makeLogger()
  const bothOn = new BalanceAlertForwarder({
    bridge,
    logger,
    getConfig: () => normalizeConfig({ balanceAlertMessageEnabled: true, balanceAlertStickerEnabled: true, balanceAlertSticker: '没有这个表情' }),
    sendSticker: async () => { throw new Error('找不到表情') },
  })
  const result = await bothOn.handle({ type: 'balance-low', threshold: 10, balance: 9.6 })
  assert.equal(result.ok, true, '文字已经发出去')
  assert.equal(result.sticker.ok, false)
  assert.equal(bridge.sent.length, 1, '只发一条文字，不重复补')
  assert.match(bridge.sent[0].text, /9\.60/)
  assert.match(logger.logs.warn.join('\n'), /找不到表情.*文字已先发出，不重复发/)

  // 只开表情：表情失败不补文字（文字关着），只记 warn。
  const stickerOnlyBridge = makeBridgeStub()
  const stickerOnlyLogger = makeLogger()
  const stickerOnly = new BalanceAlertForwarder({
    bridge: stickerOnlyBridge,
    logger: stickerOnlyLogger,
    getConfig: () => normalizeConfig({ balanceAlertMessageEnabled: false, balanceAlertStickerEnabled: true, balanceAlertSticker: '没有这个表情' }),
    sendSticker: async () => { throw new Error('找不到表情') },
  })
  const failed = await stickerOnly.handle({ type: 'balance-low', threshold: 4, balance: 2 })
  assert.equal(failed.ok, false)
  assert.equal(stickerOnlyBridge.sent.length, 0, '文字关着，不补发文字')
  assert.match(stickerOnlyLogger.logs.warn.join('\n'), /文字提醒未开启，本次放弃/)

  // 表情名字空：同样只记 warn，不发任何东西。
  const emptyLogger = makeLogger()
  const emptyBridge = makeBridgeStub()
  const empty = new BalanceAlertForwarder({
    bridge: emptyBridge,
    logger: emptyLogger,
    getConfig: () => normalizeConfig({ balanceAlertMessageEnabled: false, balanceAlertStickerEnabled: true, balanceAlertSticker: '' }),
    sendSticker: async () => { throw new Error('不该被调用') },
  })
  const emptyResult = await empty.handle({ type: 'balance-low', threshold: 6, balance: 1 })
  assert.equal(emptyResult.ok, false)
  assert.equal(emptyBridge.sent.length, 0)
  assert.match(emptyLogger.logs.warn.join('\n'), /表情名字没填/)
})

test('余额提醒：两个都关不转；同一阈值 30 分钟只转一次；没有渠道就跳过', async () => {
  // 两个新键都关、以及旧配置 off 迁移过来的都等价于关。
  for (const raw of [
    { balanceAlertMessageEnabled: false, balanceAlertStickerEnabled: false },
    { balanceAlertMode: 'off' },
  ]) {
    const offBridge = makeBridgeStub()
    const offAlerts = new BalanceAlertForwarder({ bridge: offBridge, getConfig: () => normalizeConfig(raw) })
    const offResult = await offAlerts.handle({ type: 'balance-low', threshold: 10, balance: 1 })
    assert.equal(offResult.skipped, 'off')
    assert.equal(offBridge.sent.length, 0)
  }

  let now = 1_000_000
  const bridge = makeBridgeStub()
  const alerts = new BalanceAlertForwarder({ bridge, getConfig: () => normalizeConfig({}), now: () => now })
  assert.equal((await alerts.handle({ type: 'balance-low', threshold: 10, balance: 1 })).ok, true)
  now += 5 * 60 * 1000
  const again = await alerts.handle({ type: 'balance-low', threshold: 10, balance: 1 })
  assert.equal(again.skipped, 'dedupe')
  assert.equal(bridge.sent.length, 1)
  // 不同阈值不受影响。
  assert.equal((await alerts.handle({ type: 'balance-low', threshold: 5, balance: 0.5 })).ok, true)
  assert.equal(bridge.sent.length, 2)
  // 超过 30 分钟，同一阈值可以再转。
  now += 31 * 60 * 1000
  assert.equal((await alerts.handle({ type: 'balance-low', threshold: 10, balance: 1 })).ok, true)
  assert.equal(bridge.sent.length, 3)

  // 没有送信渠道：跳过，绝不乱发到默认渠道。
  const noTarget = new BalanceAlertForwarder({ bridge: makeBridgeStub({ target: null }), getConfig: () => normalizeConfig({}) })
  assert.equal((await noTarget.handle({ type: 'balance-low', threshold: 1, balance: 1 })).skipped, 'no-target')

  // 其它事件（时段切换等）不转发。
  const other = new BalanceAlertForwarder({ bridge: makeBridgeStub(), getConfig: () => normalizeConfig({}) })
  assert.equal((await other.handle({ type: 'period-switch', period: 'peak' })).skipped, 'event')
})

// 峰谷窗口会随法定节假日 / 调休变化：鱼讯这边一条本地钟点判断都不能有，
// 一旦有人（包括以后的自己）加了 getHours 一类的代码，这里就先红。
test('峰谷判定只在 fish.token：鱼讯代码里没有本地钟点 / 星期判断', () => {
  const files = ['../lib/token-link.js', '../lib/bridge.js', '../lib/config.js']
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\.getHours\(|\.getDay\(|\.getMonth\(|\.getDate\(|\.getFullYear\(/, `${file} 里不该出现本地钟点判断`)
  }
})

// ---------------- TokenLink 的降级面 ----------------

test('TokenLink：服务缺失 / 抛错都不抛异常，订阅拿不到就返回 null', async () => {
  const throwingGetter = new TokenLink({ getService: () => { throw new Error('宿主没这个服务') } })
  assert.equal(throwingGetter.pricing(), null)
  assert.deepEqual(await throwingGetter.enqueueTask({ prompt: 'x' }), { ok: false, error: 'fish.token 没有 enqueueTask' })
  assert.equal(throwingGetter.subscribe(() => {}), null)

  const noSubscribe = new TokenLink({ getService: () => ({ getPricing: () => ({ peak: true }) }) })
  assert.equal(noSubscribe.peakNow(), true)
  assert.equal(noSubscribe.subscribe(() => {}), null)

  // 订阅正常时返回取消函数，回调抛错不会传回服务方。
  const token = makeToken()
  const link = new TokenLink({ getService: () => token.service })
  let offCalled = 0
  const off = link.subscribe(() => { throw new Error('回调炸了') })
  assert.equal(typeof off, 'function')
  token.listeners[0]({ type: 'balance-low', threshold: 1, balance: 1 })
  off()
  assert.equal(typeof tokenTimeoutMs, 'number')
  assert.equal(offCalled, 0)
})
