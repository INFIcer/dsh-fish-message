// 测试用的最小 iLink 服务端：登录、长轮询、发消息、上传/下载各一段。
//
// 只实现本插件用到的端点，并且把每个请求（含请求头与 body）原样留档，
// 这样「X-WECHAT-UIN 是否每请求重算」「context_token 是否沿传」都能直接断言。
// CDN 端点和业务端点开在同一个 http server 上，靠 /c2c 前缀区分。

import http from 'node:http'
import { encryptEcb } from '../lib/ilink/protocol.js'

const respond = (res, data, code = 200, headers = {}) => {
  if (res.writableEnded || res.destroyed) return
  const text = JSON.stringify(data)
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers })
    res.end(text)
  } catch { /* 客户端已经断开（长轮询超时就是这样） */ }
}

const respondBinary = (res, buffer, code = 200, headers = {}) => {
  if (res.writableEnded || res.destroyed) return
  try {
    res.writeHead(code, { 'content-type': 'application/octet-stream', ...headers })
    res.end(buffer)
  } catch { /* 同上 */ }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(Buffer.concat(chunks)))
  })
}

export class MockIlinkServer {
  constructor() {
    this.server = null
    this.port = 0
    this.qrcode = 'qrc_test_1'
    this.qrImg = 'https://weixin.qq.com/x/test-qr'
    // 最后一项会一直重复：['wait','scaned','confirmed'] 之后永远 confirmed。
    this.qrStatuses = ['wait', 'scaned', 'confirmed']
    this.botToken = 'ilinkbot_test_token'
    this.botId = 'e06c1ceea05e@im.bot'
    this.userId = 'o9cq800kum_4g8Py8Qw5G0a@im.wechat'
    this.cursor = 'cursor-0'
    this.longPollingTimeoutMs = 350
    // getupdates 的空轮询挂多久：调大 + 调小 transport 超时就能测「本地超时续轮」。
    this.holdMs = 30
    // 排队的新消息帧：{msgs?, cursor?, ret?, delayMs?}；队列空就空轮询。
    this.updates = []
    this.requests = []
    this.sent = []
    // sendmessage 的排队响应；队列空就回 {}
    this.sendResponses = []
    this.uploads = []
    this.frames = new Map()
    this.updateCount = 0
    this.holdAfterStop = false
  }

  get baseUrl() { return `http://127.0.0.1:${this.port}` }
  get cdnBaseUrl() { return `http://127.0.0.1:${this.port}/c2c` }

  async start() {
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', this.baseUrl)
      const route = url.pathname
      const body = await readBody(req)
      let json = null
      try { json = body.length ? JSON.parse(body.toString('utf8')) : null } catch { json = null }
      this.requests.push({
        method: req.method,
        route,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: { ...req.headers },
        body: json,
        bytes: body.length,
      })

      if (route === '/ilink/bot/get_bot_qrcode') {
        return respond(res, { qrcode: this.qrcode, qrcode_img_content: this.qrImg })
      }
      if (route === '/ilink/bot/get_qrcode_status') {
        const status = this.qrStatuses.length > 1 ? this.qrStatuses.shift() : (this.qrStatuses[0] || 'wait')
        if (status === 'confirmed') {
          return respond(res, {
            status,
            baseurl: this.baseUrl,
            bot_token: this.botToken,
            ilink_bot_id: this.botId,
            ilink_user_id: this.userId,
          })
        }
        return respond(res, { status })
      }
      if (route === '/ilink/bot/getupdates') {
        this.updateCount += 1
        const entry = this.updates.shift()
        if (entry) {
          if (entry.delayMs) await sleep(entry.delayMs)
          if (entry.ret !== undefined && entry.ret !== 0) {
            return respond(res, { ret: entry.ret, errcode: entry.ret, errmsg: entry.errmsg || 'session timeout' })
          }
          if (entry.cursor) this.cursor = entry.cursor
          return respond(res, {
            ret: 0,
            msgs: entry.msgs || [],
            get_updates_buf: this.cursor,
            longpolling_timeout_ms: this.longPollingTimeoutMs,
          })
        }
        if (this.holdAfterStop) return // 一直挂着，测 stop 时不回
        await sleep(this.holdMs)
        return respond(res, {
          ret: 0,
          msgs: [],
          get_updates_buf: this.cursor,
          longpolling_timeout_ms: this.longPollingTimeoutMs,
        })
      }
      if (route === '/ilink/bot/sendmessage') {
        this.sent.push(json)
        const next = this.sendResponses.shift()
        return respond(res, next || {})
      }
      if (route === '/ilink/bot/getuploadurl') {
        const filekey = String(json?.filekey || 'unknown')
        return respond(res, { upload_param: `UP_${filekey}`, thumb_upload_param: '' })
      }
      if (route === '/c2c/upload') {
        const filekey = String(url.searchParams.get('filekey') || '')
        const cipher = Buffer.from(body)
        this.uploads.push({ filekey, queryParam: url.searchParams.get('encrypted_query_param'), cipher })
        return respondBinary(res, Buffer.alloc(0), 200, { 'x-encrypted-param': `ENC_${filekey}` })
      }
      if (route === '/c2c/download') {
        const param = String(url.searchParams.get('encrypted_query_param') || '')
        const frame = this.frames.get(param)
        if (!frame) return respondBinary(res, Buffer.from('not found'), 404)
        return respondBinary(res, frame)
      }
      return respond(res, { ret: -1, errmsg: `mock 没有这个端点：${route}` }, 404)
    })
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.port = this.server.address().port
    return this
  }

  async stop() {
    this.holdAfterStop = false
    this.updates.length = 0
    await new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.closeAllConnections?.()
      this.server.close(() => resolve())
    })
    this.server = null
  }

  /** 把明文按给定 key 加密后挂到假 CDN 上，返回 inbound 消息要用的 encrypt_query_param。 */
  addFrame(buffer, key, hint = 'IMG') {
    const param = `ENC_${hint}_${this.frames.size + 1}`
    this.frames.set(param, encryptEcb(buffer, key))
    return param
  }

  /** 推一帧 getupdates 响应。 */
  pushFrame({ msgs = [], cursor = '', ret = 0, errmsg = '', delayMs = 0 } = {}) {
    this.updates.push({ msgs, cursor, ret, errmsg, delayMs })
  }

  /** 取最后一次命中该 route 的请求。 */
  lastRequest(route) {
    for (let i = this.requests.length - 1; i >= 0; i--) {
      if (this.requests[i].route === route) return this.requests[i]
    }
    return null
  }

  requestsTo(route) {
    return this.requests.filter((x) => x.route === route)
  }
}

/** 构造一条入站文本消息。 */
export function textMessage(text, {
  peer = 'o9cq800kum_4g8Py8Qw5G0a@im.wechat',
  botId = 'e06c1ceea05e@im.bot',
  token = 'CT_TEXT',
  messageId = 9812451782375,
  clientId = '',
  seq = 429,
  createTimeMs = Date.now(),
  messageType = 1,
  groupId = null,
} = {}) {
  const message = {
    seq,
    from_user_id: peer,
    to_user_id: botId,
    client_id: clientId,
    create_time_ms: createTimeMs,
    session_id: `${peer}#${botId}`,
    message_type: messageType,
    message_state: 2,
    context_token: token,
    group_id: groupId,
    item_list: [{ type: 1, text_item: { text } }],
  }
  // 显式允许调用方「不给 message_id」，用来测 id 优先级链。
  if (messageId !== undefined && messageId !== null) message.message_id = messageId
  return message
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function wait(condition, timeout = 4000, interval = 20) {
  const begin = Date.now()
  while (Date.now() - begin < timeout) {
    if (await condition()) return true
    await sleep(interval)
  }
  return false
}
