// fish.message 服务：转发、参数校验、错误传播、注册/卸载。
//
// 全部离线：Bridge / Transport / VoiceService 都是 mock，不连 QQ、不连本地 AI。

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  createFishMessageApi,
  FishMessageError,
  registerMessageService,
  serviceVersion,
} from '../lib/service.js'
import { Bridge } from '../lib/bridge.js'

const QQ = '10001'

function buildConfig() {
  return {
    bindings: [{ qq: QQ, session: 'session-abc', name: '主人', enabled: true }],
    napcatToken: 'secret-token',
    reorderBufferMs: 0,
    maxImageMB: 10,
    maxVoiceMB: 20,
  }
}

function fakeBridge() {
  const call = []
  return {
    call,
    running: true,
    outbox: { pending: () => 2 },
    async sendText(qq, text) {
      call.push(['sendText', qq, text])
      return { ok: true, sent: true, queued: false, pending: 0 }
    },
    async sendOutbound(qq, segments, options) {
      call.push(['sendOutbound', qq, segments, options])
      return { ok: true, sent: false, queued: true, id: 'q-1', pending: 1 }
    },
  }
}

function fakeTransport(history = []) {
  return {
    call: [],
    async fetchHistory(qq, params) {
      this.call.push([qq, params])
      if (this.throwError) throw new Error(this.throwError)
      return history
    },
  }
}

function makeApi(extra = {}) {
  const config = buildConfig()
  const bridge = extra.bridge || fakeBridge()
  const transport = extra.transport || fakeTransport()
  const event = new EventEmitter()
  const api = createFishMessageApi({
    bridge: bridge,
    transport: transport,
    voice: extra.voice || { async recordToFile() { return { wavPath: join(tmpdir(), 'a.wav') } } },
    getConfig: () => config,
    events: event,
  })
  return { api, bridge, transport, config, event }
}

function makeTempFile(name, content = 'x') {
  const dir = mkdtempSync(join(tmpdir(), 'fish-msg-svc-'))
  const file = join(dir, name)
  writeFileSync(file, content)
  return file
}

test('apiVersion 与 capabilities 与契约一致', () => {
  const { api } = makeApi()
  assert.equal(serviceVersion, '0.1')
  assert.equal(api.apiVersion, '0.1')
  assert.deepEqual(api.capabilities(), {
    sendText: true,
    sendImage: true,
    sendRecord: true,
    sendRecordFile: true,
    sendFile: true,
    fetchHistory: true,
    stickers: true,
    images: true,
    transcribe: { text: false },
  })
  // 每次都是新对象，调用方改不坏内部状态。
  const one = api.capabilities()
  one.sendText = false
  assert.equal(api.capabilities().sendText, true)
})

test('sendText 转发 Bridge，并裁掉首尾空白', async () => {
  const { api, bridge } = makeApi()
  const result = await api.sendText(QQ, '  你好  ')
  assert.deepEqual(bridge.call[0], ['sendText', QQ, '你好'])
  assert.equal(result.ok, true)
  assert.equal(result.sent, true)
  assert.equal(result.queued, false)
  assert.equal(result.pending, 0)
})

test('sendText 空文字 / 非法 QQ 给结构化错误', async () => {
  const { api } = makeApi()
  await assert.rejects(() => api.sendText(QQ, '   '), (error) => {
    assert.ok(error instanceof FishMessageError)
    assert.equal(error.code, 'fish_message_bad_request')
    assert.match(error.hint, /文字不能为空/)
    return true
  })
  await assert.rejects(() => api.sendText('abc', 'hi'), (error) => {
    assert.equal(error.code, 'fish_message_bad_request')
    return true
  })
})

test('sendImage / sendRecord / sendFile 校验路径并走 sendOutbound', async () => {
  const { api, bridge } = makeApi()
  const image = makeTempFile('a.png')
  const audio = makeTempFile('a.wav')
  const str = makeTempFile('report.txt')

  const imageResult = await api.sendImage(QQ, image)
  assert.equal(imageResult.queued, true)
  assert.equal(imageResult.id, 'q-1')
  assert.deepEqual(bridge.call[0][2], [{ type: 'image', data: { path: image } }])

  await api.sendRecord(QQ, audio)
  assert.deepEqual(bridge.call[1][2], [{ type: 'record', data: { path: audio } }])

  // sendRecordFile 是 sendRecord 的等价别名：同一路径校验、同一 record 段。
  await api.sendRecordFile(QQ, audio)
  assert.deepEqual(bridge.call[2][2], [{ type: 'record', data: { path: audio } }])

  await api.sendFile(QQ, str)
  assert.deepEqual(bridge.call[3][2], [{ type: 'file', data: { path: str, name: basename(str) } }])

  await assert.rejects(() => api.sendImage(QQ, join(tmpdir(), '不存在.png')), (error) => {
    assert.equal(error.code, 'fish_message_bad_request')
    assert.match(error.hint, /找不到图片/)
    return true
  })
  await assert.rejects(() => api.sendImage(QQ, 'relative.png'), (error) => {
    assert.equal(error.code, 'fish_message_bad_request')
    assert.match(error.hint, /绝对路径/)
    return true
  })
})

test('sendOutbound 抛错 → fish_message_send_failed，保留 detail', async () => {
  const bridge = fakeBridge()
  bridge.sendOutbound = async () => { throw new Error('NapCat 断线') }
  const { api } = makeApi({ bridge: bridge })
  const str = makeTempFile('a.txt')
  await assert.rejects(() => api.sendFile(QQ, str), (error) => {
    assert.equal(error.code, 'fish_message_send_failed')
    assert.match(error.hint, /NapCat 断线/)
    assert.match(error.detail, /NapCat 断线/)
    return true
  })
})

test('fetchHistory：参数规整、条数截断、错误映射', async () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ message_id: String(i), user_id: QQ }))
  const transport = fakeTransport(history)
  const { api } = makeApi({ transport: transport })

  const list = await api.fetchHistory(QQ, { count: 5 })
  assert.equal(list.length, 5)
  assert.deepEqual(transport.call[0], [QQ, { count: 5 }])

  await api.fetchHistory(QQ, { count: 9999, beforeMessageId: 'm-1' })
  assert.deepEqual(transport.call[1], [QQ, { count: 100, beforeMessageId: 'm-1' }])

  transport.throwError = '连接被拒绝'
  await assert.rejects(() => api.fetchHistory(QQ), (error) => {
    assert.equal(error.code, 'fish_message_upstream_error')
    assert.match(error.hint, /连接被拒绝/)
    return true
  })
})

test('latestVoice：取最近一条语音并落盘', async () => {
  const history = [
    { message_id: '1', user_id: QQ, time: 100, message: [{ type: 'text', data: { text: '早' } }] },
    { message_id: '2', user_id: QQ, time: 200, message: [{ type: 'record', data: { file: 'x.amr' } }] },
    { message_id: '3', user_id: QQ, time: 300, message: [{ type: 'record', data: { file: 'y.amr' } }] },
  ]
  const call = []
  const voice = {
    async recordToFile(segment, id) {
      call.push([segment, id])
      return { wavPath: 'C:\\tmp\\voice-3.wav', rawPath: 'C:\\tmp\\voice-3.amr' }
    },
  }
  const { api } = makeApi({ transport: fakeTransport(history), voice })
  const result = await api.latestVoice(QQ)
  assert.equal(result.ok, true)
  assert.equal(result.messageId, '3')
  assert.equal(result.filePath, 'C:\\tmp\\voice-3.wav')
  assert.equal(result.rawPath, 'C:\\tmp\\voice-3.amr')
  assert.equal(result.time, 300)
  assert.equal(call[0][1], '3')
})

test('latestVoice：没有语音 / 指定 id 不存在 / 下载失败', async () => {
  const noVoice = makeApi({ transport: fakeTransport([{ message_id: '1', user_id: QQ, message: [] }]) })
  await assert.rejects(() => noVoice.api.latestVoice(QQ), (error) => {
    assert.equal(error.code, 'fish_message_no_voice')
    assert.match(error.hint, /没有语音/)
    return true
  })

  const hasVoice = makeApi({
    transport: fakeTransport([{ message_id: '2', user_id: QQ, message: [{ type: 'record', data: {} }] }]),
  })
  await assert.rejects(() => hasVoice.api.latestVoice(QQ, { messageId: '404' }), (error) => {
    assert.equal(error.code, 'fish_message_message_not_found')
    return true
  })

  const downloadFailure = makeApi({
    transport: fakeTransport([{ message_id: '2', user_id: QQ, message: [{ type: 'record', data: {} }] }]),
    voice: { async recordToFile() { throw new Error('get_record 失败') } },
  })
  await assert.rejects(() => downloadFailure.api.latestVoice(QQ), (error) => {
    assert.equal(error.code, 'fish_message_voice_download_failed')
    assert.match(error.hint, /下载/)
    return true
  })
})

test('bindings / getConfig 只读且脱敏；health 不触发网络', () => {
  const { api } = makeApi()
  assert.deepEqual(api.bindings(), [{ qq: QQ, session: 'session-abc', name: '主人' }])
  const config = api.getConfig()
  assert.equal(config.napcatToken, '***已设置***')
  assert.equal(config.bindings.length, 1)
  assert.equal(api.health().ok, true)
  assert.equal(api.health().pending, 2)
})

test('events 是调用方注入的同一个 EventEmitter', () => {
  const { api, event } = makeApi()
  assert.equal(api.events, event)
})

test('注册消息服务：注册、可卸载、没有 provide 时安静跳过', async () => {
  const provide = new Map()
  const cleanup = []
  const ctx = {
    effect(cb, tags) {
      cleanup.push(tags)
      const back = cb()
      return typeof back === 'function' ? back : () => {}
    },
    provide(name, value) {
      provide.set(name, value)
      return () => provide.delete(name)
    },
  }
  const api = { apiVersion: '0.1' }
  const stop = registerMessageService(ctx, api)
  assert.equal(provide.get('fish.message'), api)
  assert.deepEqual(cleanup, ['fish-message: 提供 fish.message 服务'])
  stop()
  assert.equal(provide.has('fish.message'), false)

  // 老宿主没有 provide：不抛异常，返回一个空 disposer。
  const empty = registerMessageService({}, api)
  assert.equal(typeof empty, 'function')
  empty()
})

test('Bridge 发 sent / outbox-flushed 事件（服务依赖这两个事件）', async () => {
  const event = new EventEmitter()
  const received = []
  event.on('sent', (e) => received.push(['sent', e]))
  event.on('outbox-flushed', (e) => received.push(['outbox-flushed', e]))

  const memory = new Map()
  const store = {
    getWatermark: () => undefined,
    setWatermark() {},
    hasSeen: () => false,
    markSeen() {},
    noteError() {},
    noteReceived() {},
    noteDelivered() {},
    recordEvent() {},
    save() {},
    snapshot: () => ({ watermarks: {}, stats: {}, recent: [] }),
  }
  const outbound = {
    expire: () => 0,
    next: () => null,
    pending: () => 0,
    markSent: () => true,
  }
  const transport = {
    getStatus: () => ({ mode: 'http', connected: false }),
    async sendMessage(qq, segments) { memory.set(qq, segments) },
    async fetchHistory() { return [] },
  }
  const bridge = new Bridge({
    getConfig: () => buildConfig(),
    transport: transport,
    store,
    logger: null,
    voice: {},
    delivery: {},
    outbox: outbound,
    events: event,
    autoTimers: false,
  })
  bridge.running = true

  const result = await bridge.sendText(QQ, '你好')
  assert.equal(result.sent, true)
  assert.equal(received[0][0], 'sent')
  assert.equal(received[0][1].qq, QQ)

  await bridge.flushOutbox('test', { force: true })
  const tail = received[received.length - 1]
  assert.equal(tail[0], 'outbox-flushed')
  assert.equal(tail[1].sent, 0)
  assert.equal(tail[1].pending, 0)
})
