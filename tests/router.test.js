// 通道路由器：显式 channel 分发、缺省兜底、单通道失败不拖垮、状态聚合。
//
// 全部离线：适配器都是假对象，只验路由与聚合口径，不碰网络。

import test from 'node:test'
import assert from 'node:assert/strict'
import { RouterTransport } from '../lib/transport/router.js'

const QQ = '10001'
const WX = 'o9cq9xYz_1@im.wechat'
const textSegment = (text) => [{ type: 'text', data: { text } }]

function fakeTransport(name, options = {}) {
  const state = {
    sent: [],
    fetched: [],
    downloaded: [],
    records: [],
    started: 0,
    stopped: 0,
    handlers: null,
    status: {
      name,
      connected: Boolean(options.connected),
      mode: options.mode || 'http',
      lastOkAt: Number(options.lastOkAt) || 0,
      lastError: '',
      ...(options.state ? { state: options.state } : {}),
    },
  }
  const transport = {
    name,
    get sent() { return state.sent },
    get fetched() { return state.fetched },
    get downloaded() { return state.downloaded },
    get records() { return state.records },
    get started() { return state.started },
    get stopped() { return state.stopped },
    get handlers() { return state.handlers },
    patch(patch) { state.status = { ...state.status, ...patch } },
    async start(handlers) {
      state.started += 1
      state.handlers = handlers
      if (options.startError) throw new Error(options.startError)
    },
    async stop() {
      state.stopped += 1
      state.status = { ...state.status, connected: false }
      if (options.stopError) throw new Error(options.stopError)
    },
    getStatus() { return { ...state.status } },
    async sendMessage(peer, segments) {
      state.sent.push({ peer, segments })
      return { ret: 0, peer }
    },
    async fetchHistory(peer, opts = {}) {
      state.fetched.push({ peer, opts })
      return options.history || []
    },
    async download(url) {
      state.downloaded.push(url)
      if (options.downloadError) throw new Error(options.downloadError)
      return Buffer.from(name)
    },
  }
  if (options.getRecord) {
    transport.getRecord = async (file) => {
      state.records.push(file)
      return { file: `${name}:${file}` }
    }
  }
  return transport
}

test('路由器：显式 channel 分发，缺省按 peer 形态兜底', async () => {
  const qq = fakeTransport('napcat-onebot')
  const wx = fakeTransport('wechat-ilink', { mode: 'ilink', connected: true })
  const router = new RouterTransport({ resolve: (ch) => (ch === 'qq' ? qq : ch === 'wechat' ? wx : null) })
  await router.start({})
  assert.equal(router.name, 'router')

  await router.sendMessage(QQ, textSegment('给 QQ'), { channel: 'qq' })
  await router.sendMessage(WX, textSegment('给微信'), { channel: 'wechat' })
  // 没给 channel：纯数字只可能是 QQ，其它形态去找非 qq 的通道。
  await router.sendMessage('10002', textSegment('纯数字'))
  await router.sendMessage(WX, textSegment('非数字'))

  assert.deepEqual(qq.sent.map((item) => item.peer), [QQ, '10002'])
  assert.deepEqual(wx.sent.map((item) => item.peer), [WX, WX])
  assert.equal(qq.sent[0].segments[0].data.text, '给 QQ')
})

test('路由器：没有对应通道时明确报错，不静默成功', async () => {
  const qq = fakeTransport('napcat-onebot')
  const router = new RouterTransport({ resolve: (ch) => (ch === 'qq' ? qq : null) })
  await router.start({})

  await assert.rejects(() => router.sendMessage(WX, textSegment('x'), { channel: 'wechat' }), /微信通道/)
  await assert.rejects(() => router.sendMessage(WX, textSegment('x')), /微信通道/)
  await assert.rejects(() => router.sendMessage(QQ, textSegment('x'), { channel: 'wx' }), /不认识的通道/)
  assert.equal(qq.sent.length, 0)
})

test('路由器：历史补拉按通道走，通道没启用时返回空数组', async () => {
  const qq = fakeTransport('napcat-onebot', { history: [{ message_id: 'q1' }] })
  const wx = fakeTransport('wechat-ilink', { mode: 'ilink' })
  const router = new RouterTransport({ resolve: (ch) => (ch === 'qq' ? qq : wx) })
  await router.start({})

  assert.deepEqual(await router.fetchHistory(QQ, { count: 10 }), [{ message_id: 'q1' }])
  assert.deepEqual(qq.fetched[0].opts, { count: 10 })
  assert.deepEqual(await router.fetchHistory(WX, { channel: 'wechat' }), [])

  // 渠道没启用：补拉不报错，只当「没有历史」，否则轮询会反复刷警告。
  const onlyQq = new RouterTransport({ resolve: (ch) => (ch === 'qq' ? qq : null) })
  await onlyQq.start({})
  assert.deepEqual(await onlyQq.fetchHistory(WX), [])
})

test('路由器：一条通道起不来不拖垮另一条，两条都失败也不抛', async () => {
  const badQq = fakeTransport('napcat-onebot', { startError: 'NapCat 没开' })
  const goodWx = fakeTransport('wechat-ilink', { mode: 'ilink', connected: true })
  const router = new RouterTransport({ resolve: (ch) => (ch === 'qq' ? badQq : goodWx) })
  await router.start({})

  assert.equal(goodWx.started, 1)
  const status = router.getStatus()
  assert.equal(status.connected, true)
  assert.match(status.channels.qq.lastError, /NapCat 没开/)
  assert.equal(status.channels.wechat.connected, true)
  assert.equal(status.mode, 'ilink', '只有一路活着时用它的 mode')

  const allBad = new RouterTransport({ resolve: () => fakeTransport('x', { startError: '全挂' }) })
  await allBad.start({})
  assert.equal(allBad.getStatus().connected, false)
})

test('路由器：mode 只在单路时透出，多路给 multi，全停给 stopped', async () => {
  const qq = fakeTransport('napcat-onebot', { mode: 'ws', connected: true })
  const wx = fakeTransport('wechat-ilink', { mode: 'ilink', connected: true })
  const both = new RouterTransport({ resolve: (ch) => (ch === 'qq' ? qq : wx) })
  await both.start({})
  assert.equal(both.getStatus().mode, 'multi')

  const onlyQq = new RouterTransport({ resolve: (ch) => (ch === 'qq' ? fakeTransport('napcat-onebot', { mode: 'http' }) : null) })
  await onlyQq.start({})
  assert.equal(onlyQq.getStatus().mode, 'http')

  // 微信停着时仍报 mode='ilink'，只能靠状态机认出「停着」。
  const stoppedWx = fakeTransport('wechat-ilink', { mode: 'ilink', state: 'stopped' })
  const stopped = new RouterTransport({ resolve: (ch) => (ch === 'wechat' ? stoppedWx : null) })
  await stopped.start({})
  assert.equal(stopped.getStatus().mode, 'stopped')
  assert.equal(stopped.getStatus().connected, false)

  const deadQq = fakeTransport('napcat-onebot', { mode: 'stopped' })
  const dead = new RouterTransport({ resolve: () => deadQq })
  await dead.start({})
  assert.equal(dead.getStatus().mode, 'stopped')
})

test('路由器：stop 停掉所有通道，某一个失败不影响其它', async () => {
  const qq = fakeTransport('napcat-onebot', { stopError: '停不下来' })
  const wx = fakeTransport('wechat-ilink', { mode: 'ilink' })
  const router = new RouterTransport({ resolve: (ch) => (ch === 'qq' ? qq : wx) })
  await router.start({})

  await router.stop()
  assert.equal(qq.stopped, 1)
  assert.equal(wx.stopped, 1)
  assert.equal(router.getStatus().mode, 'stopped')
  assert.deepEqual(router.getStatus().channels, {})
})

test('路由器：download 依次尝试，getRecord 只转给 QQ', async () => {
  const qq = fakeTransport('napcat-onebot', { getRecord: true, downloadError: 'QQ 这边下载失败' })
  const wx = fakeTransport('wechat-ilink', { mode: 'ilink', getRecord: true })
  const router = new RouterTransport({ resolve: (ch) => (ch === 'qq' ? qq : wx) })
  await router.start({})

  const buffer = await router.download('https://example.com/a.jpg')
  assert.equal(buffer.toString(), 'wechat-ilink', 'QQ 失败后换微信')
  assert.deepEqual(qq.downloaded, ['https://example.com/a.jpg'])

  // 微信适配器永远不在 record 段里填 data.file，所以取语音只认 QQ。
  const record = await router.getRecord('voice.amr')
  assert.equal(record.file, 'napcat-onebot:voice.amr')
  assert.deepEqual(wx.records, [])

  const allFail = new RouterTransport({ resolve: () => fakeTransport('wechat-ilink', { downloadError: '都一样失败' }) })
  await allFail.start({})
  await assert.rejects(() => allFail.download('https://example.com/b.jpg'), /都一样失败/)
})

test('路由器：运行时接入与摘掉通道（扫码登录时现建适配器）', async () => {
  const qq = fakeTransport('napcat-onebot')
  const wx = fakeTransport('wechat-ilink', { mode: 'ilink', connected: true })
  let withWechat = false
  const router = new RouterTransport({ resolve: (ch) => (ch === 'qq' ? qq : withWechat ? wx : null) })
  await router.start({})
  assert.deepEqual(Object.keys(router.getStatus().channels), ['qq'])

  withWechat = true
  await router.attach('wechat', wx)
  assert.equal(wx.started, 1, '已经启动的路由器要顺手把新通道起起来')
  assert.deepEqual(Object.keys(router.getStatus().channels).sort(), ['qq', 'wechat'])
  await router.sendMessage(WX, textSegment('新通道'), { channel: 'wechat' })
  assert.equal(wx.sent.length, 1)

  withWechat = false
  await router.detach('wechat')
  assert.equal(wx.stopped, 1)
  assert.deepEqual(Object.keys(router.getStatus().channels), ['qq'])
  await assert.rejects(() => router.sendMessage(WX, textSegment('x'), { channel: 'wechat' }), /微信通道/)
})

test('路由器：入站事件补上通道标记，状态回调聚合成一路', async () => {
  const events = []
  const statuses = []
  const qq = fakeTransport('napcat-onebot', { mode: 'ws', connected: true })
  const wx = fakeTransport('wechat-ilink', { mode: 'ilink' })
  const router = new RouterTransport({ resolve: (ch) => (ch === 'qq' ? qq : wx) })
  await router.start({ onEvent: (event) => events.push(event), onStatus: (status) => statuses.push(status) })

  qq.handlers.onEvent({ post_type: 'message', message_type: 'private', user_id: QQ })
  assert.equal(events[0].channel, 'qq', '适配器没填 channel 时按它自己那条通道补上')

  wx.handlers.onEvent({ post_type: 'message', message_type: 'private', channel: 'wechat', user_id: WX })
  assert.equal(events[1].channel, 'wechat')

  wx.patch({ connected: true })
  wx.handlers.onStatus({ connected: true })
  const last = statuses[statuses.length - 1]
  assert.equal(last.name, 'router')
  assert.equal(last.connected, true)
  assert.equal(last.channels.wechat.connected, true)
})
