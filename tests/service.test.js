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
  注册消息服务,
  服务版本,
} from '../lib/service.js'
import { Bridge } from '../lib/bridge.js'

const QQ = '10001'

function 建配置() {
  return {
    bindings: [{ qq: QQ, session: 'session-abc', name: '主人', enabled: true }],
    napcatToken: 'secret-token',
    reorderBufferMs: 0,
    maxImageMB: 10,
    maxVoiceMB: 20,
  }
}

function 假桥() {
  const 调用 = []
  return {
    调用,
    running: true,
    outbox: { pending: () => 2 },
    async sendText(qq, text) {
      调用.push(['sendText', qq, text])
      return { ok: true, sent: true, queued: false, pending: 0 }
    },
    async sendOutbound(qq, 段们, 选项) {
      调用.push(['sendOutbound', qq, 段们, 选项])
      return { ok: true, sent: false, queued: true, id: 'q-1', pending: 1 }
    },
  }
}

function 假传输(历史 = []) {
  return {
    调用: [],
    async fetchHistory(qq, 参数) {
      this.调用.push([qq, 参数])
      if (this.抛错) throw new Error(this.抛错)
      return 历史
    },
  }
}

function 造api(额外 = {}) {
  const 配置 = 建配置()
  const 桥 = 额外.bridge || 假桥()
  const 传输 = 额外.transport || 假传输()
  const 事件 = new EventEmitter()
  const api = createFishMessageApi({
    bridge: 桥,
    transport: 传输,
    voice: 额外.voice || { async recordToFile() { return { wavPath: join(tmpdir(), 'a.wav') } } },
    getConfig: () => 配置,
    events: 事件,
  })
  return { api, 桥, 传输, 配置, 事件 }
}

function 造临时文件(名, 内容 = 'x') {
  const 目录 = mkdtempSync(join(tmpdir(), 'fish-msg-svc-'))
  const 文件 = join(目录, 名)
  writeFileSync(文件, 内容)
  return 文件
}

test('apiVersion 与 capabilities 与契约一致', () => {
  const { api } = 造api()
  assert.equal(服务版本, '0.1')
  assert.equal(api.apiVersion, '0.1')
  assert.deepEqual(api.capabilities(), {
    sendText: true,
    sendImage: true,
    sendRecord: true,
    sendFile: true,
    fetchHistory: true,
    transcribe: { text: false, speaker: false },
  })
  // 每次都是新对象，调用方改不坏内部状态。
  const 一 = api.capabilities()
  一.sendText = false
  assert.equal(api.capabilities().sendText, true)
})

test('sendText 转发 Bridge，并裁掉首尾空白', async () => {
  const { api, 桥 } = 造api()
  const 结果 = await api.sendText(QQ, '  你好  ')
  assert.deepEqual(桥.调用[0], ['sendText', QQ, '你好'])
  assert.equal(结果.ok, true)
  assert.equal(结果.sent, true)
  assert.equal(结果.queued, false)
  assert.equal(结果.pending, 0)
})

test('sendText 空文字 / 非法 QQ 给结构化错误', async () => {
  const { api } = 造api()
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
  const { api, 桥 } = 造api()
  const 图 = 造临时文件('a.png')
  const 音 = 造临时文件('a.wav')
  const 文 = 造临时文件('report.txt')

  const 图结果 = await api.sendImage(QQ, 图)
  assert.equal(图结果.queued, true)
  assert.equal(图结果.id, 'q-1')
  assert.deepEqual(桥.调用[0][2], [{ type: 'image', data: { path: 图 } }])

  await api.sendRecord(QQ, 音)
  assert.deepEqual(桥.调用[1][2], [{ type: 'record', data: { path: 音 } }])

  await api.sendFile(QQ, 文)
  assert.deepEqual(桥.调用[2][2], [{ type: 'file', data: { path: 文, name: basename(文) } }])

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
  const 桥 = 假桥()
  桥.sendOutbound = async () => { throw new Error('NapCat 断线') }
  const { api } = 造api({ bridge: 桥 })
  const 文 = 造临时文件('a.txt')
  await assert.rejects(() => api.sendFile(QQ, 文), (error) => {
    assert.equal(error.code, 'fish_message_send_failed')
    assert.match(error.hint, /NapCat 断线/)
    assert.match(error.detail, /NapCat 断线/)
    return true
  })
})

test('fetchHistory：参数规整、条数截断、错误映射', async () => {
  const 历史 = Array.from({ length: 30 }, (_, i) => ({ message_id: String(i), user_id: QQ }))
  const 传输 = 假传输(历史)
  const { api } = 造api({ transport: 传输 })

  const 列表 = await api.fetchHistory(QQ, { count: 5 })
  assert.equal(列表.length, 5)
  assert.deepEqual(传输.调用[0], [QQ, { count: 5 }])

  await api.fetchHistory(QQ, { count: 9999, beforeMessageId: 'm-1' })
  assert.deepEqual(传输.调用[1], [QQ, { count: 100, beforeMessageId: 'm-1' }])

  传输.抛错 = '连接被拒绝'
  await assert.rejects(() => api.fetchHistory(QQ), (error) => {
    assert.equal(error.code, 'fish_message_upstream_error')
    assert.match(error.hint, /连接被拒绝/)
    return true
  })
})

test('latestVoice：取最近一条语音并落盘', async () => {
  const 历史 = [
    { message_id: '1', user_id: QQ, time: 100, message: [{ type: 'text', data: { text: '早' } }] },
    { message_id: '2', user_id: QQ, time: 200, message: [{ type: 'record', data: { file: 'x.amr' } }] },
    { message_id: '3', user_id: QQ, time: 300, message: [{ type: 'record', data: { file: 'y.amr' } }] },
  ]
  const 调用 = []
  const voice = {
    async recordToFile(段, id) {
      调用.push([段, id])
      return { wavPath: 'C:\\tmp\\voice-3.wav', rawPath: 'C:\\tmp\\voice-3.amr' }
    },
  }
  const { api } = 造api({ transport: 假传输(历史), voice })
  const 结果 = await api.latestVoice(QQ)
  assert.equal(结果.ok, true)
  assert.equal(结果.messageId, '3')
  assert.equal(结果.filePath, 'C:\\tmp\\voice-3.wav')
  assert.equal(结果.rawPath, 'C:\\tmp\\voice-3.amr')
  assert.equal(结果.time, 300)
  assert.equal(调用[0][1], '3')
})

test('latestVoice：没有语音 / 指定 id 不存在 / 下载失败', async () => {
  const 无语音 = 造api({ transport: 假传输([{ message_id: '1', user_id: QQ, message: [] }]) })
  await assert.rejects(() => 无语音.api.latestVoice(QQ), (error) => {
    assert.equal(error.code, 'fish_message_no_voice')
    assert.match(error.hint, /没有语音/)
    return true
  })

  const 有语音 = 造api({
    transport: 假传输([{ message_id: '2', user_id: QQ, message: [{ type: 'record', data: {} }] }]),
  })
  await assert.rejects(() => 有语音.api.latestVoice(QQ, { messageId: '404' }), (error) => {
    assert.equal(error.code, 'fish_message_message_not_found')
    return true
  })

  const 下载失败 = 造api({
    transport: 假传输([{ message_id: '2', user_id: QQ, message: [{ type: 'record', data: {} }] }]),
    voice: { async recordToFile() { throw new Error('get_record 失败') } },
  })
  await assert.rejects(() => 下载失败.api.latestVoice(QQ), (error) => {
    assert.equal(error.code, 'fish_message_voice_download_failed')
    assert.match(error.hint, /下载/)
    return true
  })
})

test('bindings / getConfig 只读且脱敏；health 不触发网络', () => {
  const { api } = 造api()
  assert.deepEqual(api.bindings(), [{ qq: QQ, session: 'session-abc', name: '主人' }])
  const 配置 = api.getConfig()
  assert.equal(配置.napcatToken, '***已设置***')
  assert.equal(配置.bindings.length, 1)
  assert.equal(api.health().ok, true)
  assert.equal(api.health().pending, 2)
})

test('events 是调用方注入的同一个 EventEmitter', () => {
  const { api, 事件 } = 造api()
  assert.equal(api.events, 事件)
})

test('注册消息服务：注册、可卸载、没有 provide 时安静跳过', async () => {
  const 提供 = new Map()
  const 清理 = []
  const ctx = {
    effect(cb, 标签) {
      清理.push(标签)
      const 退 = cb()
      return typeof 退 === 'function' ? 退 : () => {}
    },
    provide(名, 值) {
      提供.set(名, 值)
      return () => 提供.delete(名)
    },
  }
  const api = { apiVersion: '0.1' }
  const 停 = 注册消息服务(ctx, api)
  assert.equal(提供.get('fish.message'), api)
  assert.deepEqual(清理, ['fish-message: 提供 fish.message 服务'])
  停()
  assert.equal(提供.has('fish.message'), false)

  // 老宿主没有 provide：不抛异常，返回一个空 disposer。
  const 空 = 注册消息服务({}, api)
  assert.equal(typeof 空, 'function')
  空()
})

test('Bridge 发 sent / outbox-flushed 事件（服务依赖这两个事件）', async () => {
  const 事件 = new EventEmitter()
  const 收到 = []
  事件.on('sent', (e) => 收到.push(['sent', e]))
  事件.on('outbox-flushed', (e) => 收到.push(['outbox-flushed', e]))

  const 内存 = new Map()
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
  const 出站 = {
    expire: () => 0,
    next: () => null,
    pending: () => 0,
    markSent: () => true,
  }
  const 传输 = {
    getStatus: () => ({ mode: 'http', connected: false }),
    async sendMessage(qq, 段们) { 内存.set(qq, 段们) },
    async fetchHistory() { return [] },
  }
  const bridge = new Bridge({
    getConfig: () => 建配置(),
    transport: 传输,
    store,
    logger: null,
    voice: {},
    delivery: {},
    outbox: 出站,
    events: 事件,
    autoTimers: false,
  })
  bridge.running = true

  const 结果 = await bridge.sendText(QQ, '你好')
  assert.equal(结果.sent, true)
  assert.equal(收到[0][0], 'sent')
  assert.equal(收到[0][1].qq, QQ)

  await bridge.flushOutbox('test', { force: true })
  const 尾 = 收到[收到.length - 1]
  assert.equal(尾[0], 'outbox-flushed')
  assert.equal(尾[1].sent, 0)
  assert.equal(尾[1].pending, 0)
})
