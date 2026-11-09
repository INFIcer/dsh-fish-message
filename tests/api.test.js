import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockOneBotServer, 消息, 等, 睡 } from './mock-onebot.js'
import { MockAiServer } from './mock-ai.js'

const QQ = '10001'
const 会话 = 'session-api-test'
const 小wav = () => Buffer.from('RIFFxxxxWAVE')

function 假响应() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(文) { this.body = String(文 || '') },
  }
}

function 建上下文() {
  const routes = new Map()
  const 监听 = new Map()
  const ctx = {
    effect(cb) {
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
    on(事件, fn) {
      监听.set(事件, fn)
      return () => 监听.delete(事件)
    },
    get(服务) {
      if (服务 === 'sessions') return { list: () => [{ id: 会话, title: 'API 测试' }], flush: async () => {} }
      if (服务 === 'sessionTitle') return { get: () => ({ title: 'API 测试' }) }
      if (服务 === 'workspaceRegistry') return { archivedSessionIds: [] }
      if (服务 === 'attachments') return { admitPromptContent: async (c) => c, imageHostPath: () => '' }
      return undefined
    },
    agents: { get: () => ({ session: { id: 会话 }, async followup() {} }) },
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
  }
  return { ctx, routes }
}

function 选路由(routes, path) {
  const pathname = String(path).split('?')[0]
  const 精确 = routes.get(pathname)
  if (精确) return 精确
  let 最长 = ''
  for (const p of routes.keys()) {
    if (pathname.startsWith(p) && p.endsWith('/') && p.length > 最长.length) 最长 = p
  }
  return 最长 ? routes.get(最长) : null
}

async function 调用(routes, path, { method = 'GET', body, headers = {}, 原始体 } = {}) {
  const handler = 选路由(routes, path)
  if (!handler) throw new Error(`没有注册路由 ${path}`)
  const 体 = 原始体 !== undefined
    ? 原始体
    : (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)))
  const req = Readable.from(体.length ? [体] : [])
  req.method = method
  req.url = path
  req.headers = {
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    'content-length': String(体.length),
    ...headers,
  }
  const res = 假响应()
  await handler(req, res)
  let json = null
  try { json = JSON.parse(res.body) } catch { /* 非 JSON 就留空 */ }
  return { status: res.statusCode, json, body: res.body }
}

let 序号 = 0
async function 启动宿主({ asrBaseUrl, ttsBaseUrl, 家 = null } = {}) {
  const dir = 家 || mkdtempSync(join(tmpdir(), 'fish-api-'))
  process.env.DSH_HOME = dir
  const { ctx, routes } = 建上下文()
  const host = await import(`../lib/host.js?api-test-${++序号}`)
  const app = host.apply(ctx, {
    napcatBaseUrl: server.baseUrl,
    wsUrl: server.wsUrl,
    wsEnabled: false,
    bindings: [{ qq: QQ, session: 会话, name: '主人', enabled: true }],
    pollIntervalMs: 600000,
    historyIntervalMs: 600000,
    reorderBufferMs: 20,
    requestTimeoutMs: 3000,
    outboxFlushIntervalMs: 600000,
    ...(asrBaseUrl !== undefined ? { asrBaseUrl } : {}),
    ...(ttsBaseUrl !== undefined ? { ttsBaseUrl } : {}),
  })
  await 等(() => app.bridge.running, 3000)
  // 等桥的启动补发（800ms）先跑完，避免它把测试刚入队的消息悄悄发掉。
  await 睡(1000)
  return { dir, app, routes }
}

let server
let ai
let 主

before(async () => {
  server = await new MockOneBotServer().start()
  ai = await new MockAiServer().start()
  主 = await 启动宿主({ asrBaseUrl: ai.baseUrl, ttsBaseUrl: ai.baseUrl })
})

after(async () => {
  try { await 主?.app?.停() } catch { /* 忽略 */ }
  await ai?.stop()
  await server?.stop()
})

test('底层 API：send-text 原样发送，不解析 [QQ] 标记', async () => {
  await 调用(主.routes, '/dsh-fish-message/api/send-text', {
    method: 'POST',
    body: { qq: QQ, text: '原样 [QQ]不解析[/QQ] \\[/QQ]' },
  }).then((r) => {
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.sent, true)
    assert.equal(r.json.queued, false)
    assert.equal(r.json.kind, 'text')
  })
  const 发出 = server.sent.at(-1)
  assert.equal(发出.user_id, Number(QQ))
  assert.deepEqual(发出.message, [{ type: 'text', data: { text: '原样 [QQ]不解析[/QQ] \\[/QQ]' } }])
})

test('底层 API：send-image 支持 JSON 路径和 multipart 上传', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-api-img-'))
  const 图 = join(dir, 'a.png')
  writeFileSync(图, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

  const 一 = await 调用(主.routes, '/dsh-fish-message/api/send-image', { method: 'POST', body: { qq: QQ, path: 图 } })
  assert.equal(一.status, 200)
  const 段 = server.sent.at(-1).message[0]
  assert.equal(段.type, 'image')
  assert.match(段.data.file, /^base64:\/\//)

  const fd = new FormData()
  fd.append('qq', QQ)
  fd.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }), 'upload.png')
  const 响应 = new Response(fd)
  const 体 = Buffer.from(await 响应.arrayBuffer())
  const 二 = await 调用(主.routes, '/dsh-fish-message/api/send-image', {
    method: 'POST',
    原始体: 体,
    headers: { 'content-type': 响应.headers.get('content-type') },
  })
  assert.equal(二.status, 200)
  assert.equal(二.json.kind, 'image')
})

test('底层 API：send-record / send-file / history 原样透传', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-api-files-'))
  const 音频 = join(dir, 'a.wav')
  const 文件 = join(dir, 'a.txt')
  writeFileSync(音频, 小wav())
  writeFileSync(文件, 'hello')

  const 录 = await 调用(主.routes, '/dsh-fish-message/api/send-record', { method: 'POST', body: { path: 音频 } })
  assert.equal(录.status, 200)
  assert.equal(server.sent.at(-1).message[0].type, 'record')

  const 文 = await 调用(主.routes, '/dsh-fish-message/api/send-file', { method: 'POST', body: { path: 文件, name: '报告.txt' } })
  assert.equal(文.status, 200)
  assert.equal(server.sent.at(-1).message[0].data.name, '报告.txt')

  server.setHistory(QQ, [消息(501, '历史一', Math.floor(Date.now() / 1000) - 10)])
  const 史 = await 调用(主.routes, `/dsh-fish-message/api/history?qq=${QQ}&count=10`)
  assert.equal(史.status, 200)
  assert.equal(史.json.ok, true)
  assert.equal(史.json.messages.length, 1)
  assert.equal(史.json.messages[0].message_id, 501)
})

test('底层 API：参数错误返回 400', async () => {
  const 空 = await 调用(主.routes, '/dsh-fish-message/api/send-text', { method: 'POST', body: { text: '   ' } })
  assert.equal(空.status, 400)
  assert.equal(空.json.error, 'bad_request')

  const 无文件 = await 调用(主.routes, '/dsh-fish-message/api/send-image', { method: 'POST', body: { path: 'C:/肯定/不存在.png' } })
  assert.equal(无文件.status, 400)
  assert.equal(无文件.json.error, 'file_not_found')

  const 错方法 = await 调用(主.routes, '/dsh-fish-message/api/send-text')
  assert.equal(错方法.status, 405)
})

test('高级 API：capabilities 字段与已启用状态', async () => {
  const r = await 调用(主.routes, '/dsh-fish-message/api/capabilities')
  assert.equal(r.status, 200)
  assert.equal(r.json.lowLevel, true)
  assert.deepEqual(Object.keys(r.json.advanced).sort(), ['synthesize', 'transcribe', 'voiceAnalyze', 'voiceReply'])
  assert.equal(r.json.advanced.transcribe, true)
  assert.equal(r.json.advanced.synthesize, true)
  assert.deepEqual(r.json.services.asr, { url: ai.baseUrl, enabled: true })
  assert.deepEqual(r.json.services.tts, { url: ai.baseUrl, enabled: true })
})

test('高级 API：transcribe 本地文件 → mock /asr，返回文字/声纹/engine/ms', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-api-asr-'))
  const 音频 = join(dir, 'a.wav')
  writeFileSync(音频, 小wav())
  const r = await 调用(主.routes, '/dsh-fish-message/api/transcribe', { method: 'POST', body: { qq: QQ, path: 音频 } })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.text, '这是 Mock ASR 转写出来的文字')
  assert.deepEqual(r.json.speaker, { name: '主人', known: true })
  assert.equal(r.json.engine, 'mock-asr')
  assert.ok(Number.isFinite(r.json.ms))
  assert.equal(ai.asrCalls > 0, true)
})

test('高级 API：transcribe 本地文件不依赖 QQ 绑定', async () => {
  const { AdvancedApi } = await import('../lib/api.js')
  const dir = mkdtempSync(join(tmpdir(), 'fish-api-nobind-'))
  const 音频 = join(dir, 'a.wav')
  writeFileSync(音频, 小wav())
  const api = new AdvancedApi({
    bridge: 主.app.bridge,
    transport: 主.app.transport,
    voice: 主.app.voice,
    getConfig: () => ({ asrBaseUrl: ai.baseUrl, ttsBaseUrl: ai.baseUrl, bindings: [], historyCount: 100 }),
  })
  const r = await api.transcribe({ path: 音频 })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.text, '这是 Mock ASR 转写出来的文字')
  assert.equal(r.body.source, 'path')
})

test('高级 API：synthesize 只合成到本地，不动 QQ', async () => {
  const 前 = server.sent.length
  const r = await 调用(主.routes, '/dsh-fish-message/api/synthesize', { method: 'POST', body: { text: '测试合成', voice: 'dafeiyu' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.ok(existsSync(r.json.path), '合成的 wav 应落盘')
  assert.equal(server.sent.length, 前, 'synthesize 不能发 QQ')
})

test('高级 API：voice-reply 成功直发；QQ 离线时入队文字，恢复后补发', async () => {
  const 成功 = await 调用(主.routes, '/dsh-fish-message/api/voice-reply', { method: 'POST', body: { text: '语音直发' } })
  assert.equal(成功.status, 200)
  assert.equal(成功.json.sent, true)
  assert.equal(server.sent.at(-1).message[0].type, 'record')

  server.failSend = true
  const 离线 = await 调用(主.routes, '/dsh-fish-message/api/voice-reply', { method: 'POST', body: { text: '离线语音' } })
  assert.equal(离线.status, 202)
  assert.equal(离线.json.queued, true)
  const 队列 = await 调用(主.routes, '/dsh-fish-message/outbox?limit=20')
  const 条 = 队列.json.items.find((x) => x.segments[0]?.data?.text === '离线语音')
  assert.ok(条, '离线语音应以 record_text 入队')
  assert.equal(条.segments[0].type, 'record_text')

  server.failSend = false
  const 补 = await 调用(主.routes, '/dsh-fish-message/outbox/flush', { method: 'POST' })
  assert.equal(补.status, 200)
  assert.equal(补.json.sent >= 1, true)
  assert.equal(补.json.pending, 0)
})

test('高级 API：voice-analyze 从 messageId 取音频并一次返回文字+声纹', async () => {
  const 现在 = Math.floor(Date.now() / 1000)
  server.setHistory(QQ, [{
    message_id: 777,
    message_seq: 777,
    time: 现在 - 3,
    user_id: Number(QQ),
    message_type: 'private',
    message: [{ type: 'record', data: { file: `base64://${小wav().toString('base64')}` } }],
    raw_message: '',
    sender: { user_id: Number(QQ), nickname: '主人' },
  }])
  const r = await 调用(主.routes, '/dsh-fish-message/api/voice-analyze', { method: 'POST', body: { qq: QQ, messageId: 777 } })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.text, '这是 Mock ASR 转写出来的文字')
  assert.deepEqual(r.json.speaker, { name: '主人', known: true })
  assert.equal(r.json.messageId, '777')
})

test('高级 API：服务不通映射成 502，并带原因', async () => {
  const 保存 = await 调用(主.routes, '/dsh-fish-message/save', {
    method: 'POST',
    body: { config: { asrBaseUrl: 'http://127.0.0.1:1' } },
  })
  assert.equal(保存.status, 200)
  const dir = mkdtempSync(join(tmpdir(), 'fish-api-502-'))
  const 音频 = join(dir, 'a.wav')
  writeFileSync(音频, 小wav())
  const r = await 调用(主.routes, '/dsh-fish-message/api/transcribe', { method: 'POST', body: { path: 音频 } })
  assert.equal(r.status, 502)
  assert.equal(r.json.error, 'advanced_api_upstream_error')
  assert.match(r.json.detail, /语音识别服务调用失败/)
  // 恢复，后面的用例继续用 mock 服务。
  await 调用(主.routes, '/dsh-fish-message/save', { method: 'POST', body: { config: { asrBaseUrl: ai.baseUrl } } })
})

test('高级 API：上游超时同样映射 502，不静默失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-api-timeout-'))
  const 音频 = join(dir, 'a.wav')
  writeFileSync(音频, 小wav())
  const 原 = 主.app.voice.transcribeFile
  主.app.voice.transcribeFile = async () => { throw new Error('请求超时（1 秒）') }
  try {
    await assert.rejects(
      主.app.advancedApi.transcribe({ path: 音频 }),
      (error) => {
        assert.equal(error.status, 502)
        assert.equal(error.body.error, 'advanced_api_upstream_error')
        assert.match(error.body.detail, /请求超时/)
        return true
      },
    )
  } finally {
    主.app.voice.transcribeFile = 原
  }
})

test('出站队列接口：GET 列表 / DELETE 单条 / 手动补发 / 清空', async () => {
  server.failSend = true
  await 调用(主.routes, '/dsh-fish-message/api/send-text', { method: 'POST', body: { text: '积压 A' } })
  await 调用(主.routes, '/dsh-fish-message/api/send-text', { method: 'POST', body: { text: '积压 B' } })

  const 列表 = await 调用(主.routes, '/dsh-fish-message/outbox?limit=10')
  assert.equal(列表.status, 200)
  assert.equal(列表.json.pending, 2)
  assert.ok(列表.json.oldestAgeSec >= 0)
  assert.equal(列表.json.items.length, 2)
  const 删 = 列表.json.items[0].id

  const 单删 = await 调用(主.routes, `/dsh-fish-message/outbox/${删}`, { method: 'DELETE' })
  assert.equal(单删.status, 200)
  assert.equal(单删.json.deleted, true)
  assert.equal(单删.json.pending, 1)

  const 再删 = await 调用(主.routes, `/dsh-fish-message/outbox/${删}`, { method: 'DELETE' })
  assert.equal(再删.status, 404)

  server.failSend = false
  const 补 = await 调用(主.routes, '/dsh-fish-message/outbox/flush', { method: 'POST' })
  assert.equal(补.status, 200)
  assert.equal(补.json.sent, 1)
  assert.equal(补.json.pending, 0)

  server.failSend = true
  await 调用(主.routes, '/dsh-fish-message/api/send-text', { method: 'POST', body: { text: '准备清空' } })
  const 清 = await 调用(主.routes, '/dsh-fish-message/outbox/clear', { method: 'POST' })
  assert.equal(清.status, 200)
  assert.equal(清.json.cleared, 1)
  assert.equal(清.json.pending, 0)
  server.failSend = false
})

test('state 暴露 outbox 统计，health 暴露积压数', async () => {
  const 状态 = await 调用(主.routes, '/dsh-fish-message/state')
  assert.equal(状态.status, 200)
  const 出站 = 状态.json.bridge.outbox
  assert.equal(typeof 出站.pending, 'number')
  assert.equal(typeof 出站.oldestAgeSec, 'number')
  assert.equal(typeof 出站.sentTotal, 'number')
  assert.equal(typeof 出站.failedTotal, 'number')
  assert.equal(typeof 出站.droppedTotal, 'number')
  assert.equal(typeof 出站.lastError, 'string')
  assert.ok(状态.json.outboxFile.endsWith('fish-message-outbox.json'))

  const 健康 = await 调用(主.routes, '/dsh-fish-message/health')
  assert.equal(健康.status, 200)
  assert.equal(typeof 健康.json.outboxPending, 'number')
})

test('高级 API：地址留空返回 501，capabilities 明确不可用', async () => {
  const 空 = await 启动宿主({ asrBaseUrl: '', ttsBaseUrl: '' })
  try {
    const 能力 = await 调用(空.routes, '/dsh-fish-message/api/capabilities')
    assert.equal(能力.status, 200)
    assert.deepEqual(能力.json.advanced, {
      transcribe: false,
      synthesize: false,
      voiceReply: false,
      voiceAnalyze: false,
    })
    assert.deepEqual(能力.json.services.asr, { url: '', enabled: false })
    assert.deepEqual(能力.json.services.tts, { url: '', enabled: false })

    const 转 = await 调用(空.routes, '/dsh-fish-message/api/transcribe', { method: 'POST', body: { path: 'C:/x.wav' } })
    assert.equal(转.status, 501)
    assert.equal(转.json.ok, false)
    assert.equal(转.json.error, 'advanced_api_disabled')
    assert.equal(转.json.missing, 'asrBaseUrl')
    assert.equal(转.json.detail, '高级 API 未启用：请在设置里填写 asr 服务地址')

    const 合 = await 调用(空.routes, '/dsh-fish-message/api/synthesize', { method: 'POST', body: { text: '你好' } })
    assert.equal(合.status, 501)
    assert.equal(合.json.missing, 'ttsBaseUrl')
    assert.equal(合.json.detail, '高级 API 未启用：请在设置里填写 tts 服务地址')

    const 析 = await 调用(空.routes, '/dsh-fish-message/api/voice-analyze', { method: 'POST', body: { messageId: 1 } })
    assert.equal(析.status, 501)
  } finally {
    await 空.app.停()
  }
})
