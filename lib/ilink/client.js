// iLink Bot HTTP 客户端：只负责发请求、解析响应、把服务端错误翻译成带 ret 的异常。
//
// 不决定重试节奏（那是 transport 的事），不碰文件，也不缓存任何状态：
// baseUrl / token 由 transport 在登录成功后覆写，所以同一个实例能跨「重扫码」继续用。
//
// 长轮询的本地超时单独标成 timeout=true：那不是协议错误，是「这一轮没有新消息」，
// 上层应当立刻续下一轮而不是退避。

import {
  ILINK_BASE_URL,
  ILINK_CDN_BASE_URL,
  baseInfo,
  businessHeaders,
  loginHeaders,
} from './protocol.js'

export class IlinkError extends Error {
  /**
   * @param {string} api 端点名，例如 sendmessage
   * @param {string} message 给人看的说明
   * @param {{ret?: number, errcode?: number, status?: number, body?: object}} [meta]
   */
  constructor(api, message, { ret, errcode, status, body } = {}) {
    super(`${api} 失败：${message}`)
    this.name = 'IlinkError'
    this.api = api
    this.ret = ret
    this.errcode = errcode
    this.status = status
    this.body = body
  }
}

/** ret=-2 在协议里同时表示窗口关闭 / 单条超长 / 限额用尽，三者不可区分。 */
const RET_WINDOW_CLOSED = -2
const RET_SESSION_EXPIRED = -14

export class IlinkClient {
  constructor({
    baseUrl = ILINK_BASE_URL,
    cdnBaseUrl = ILINK_CDN_BASE_URL,
    token = '',
    requestTimeoutMs = 15000,
    mediaTimeoutMs = 60000,
    logger = null,
  } = {}) {
    this.baseUrl = String(baseUrl || ILINK_BASE_URL).replace(/\/+$/, '')
    this.cdnBaseUrl = String(cdnBaseUrl || ILINK_CDN_BASE_URL).replace(/\/+$/, '')
    this.token = String(token || '')
    this.requestTimeoutMs = Math.max(1000, Number(requestTimeoutMs) || 15000)
    this.mediaTimeoutMs = Math.max(1000, Number(mediaTimeoutMs) || 60000)
    this.logger = logger
  }

  /**
   * 给一次请求套上本地超时与上层取消。
   *
   * 两者必须分开：超时对长轮询等于「没有新消息」，可以立刻续下一轮；
   * 上层取消（stop）要原样抛回去，让循环直接退出，不能退避重试。
   */
  async withTimeout(api, timeoutMs, signal, run) {
    const control = new AbortController()
    let timedOut = false
    const timeout = Math.max(200, Number(timeoutMs) || this.requestTimeoutMs)
    const timer = setTimeout(() => { timedOut = true; try { control.abort() } catch { /* 忽略 */ } }, timeout)
    const onAbort = () => { try { control.abort() } catch { /* 忽略 */ } }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      return await run(control.signal)
    } catch (error) {
      if (signal?.aborted) {
        const aborted = new IlinkError(api, '已被上层中止')
        aborted.aborted = true
        throw aborted
      }
      if (timedOut || error?.name === 'AbortError') {
        const err = new IlinkError(api, `本地超时（${Math.round(timeout / 1000)} 秒）`)
        err.timeout = true
        throw err
      }
      if (error instanceof IlinkError) throw error
      throw new IlinkError(api, String(error?.message || error))
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }

  /** 把 HTTP 响应读成业务 JSON，并统一判失败（ret / errcode 非 0 都算失败）。 */
  async readJson(api, response) {
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    let json = null
    try { json = JSON.parse(text) } catch { /* 下面统一报错 */ }
    if (!response.ok) {
      throw new IlinkError(api, `HTTP ${response.status} ${text.slice(0, 200) || '（空响应）'}`, {
        status: response.status,
        body: json,
      })
    }
    if (!json || typeof json !== 'object') {
      throw new IlinkError(api, `返回不是 JSON：${text.slice(0, 120) || '（空响应）'}`, { status: response.status })
    }
    if (json.ret !== undefined && json.ret !== null && Number(json.ret) !== 0) throw this.retError(api, json)
    if (json.errcode !== undefined && json.errcode !== null && Number(json.errcode) !== 0) throw this.retError(api, json)
    return json
  }

  retError(api, json) {
    const ret = Number(json.ret ?? json.errcode)
    const detail = String(json.errmsg || json.message || '').slice(0, 200)
    if (ret === RET_SESSION_EXPIRED) {
      return new IlinkError(api, `ret=-14 登录态失效，需要重新扫码${detail ? `（${detail}）` : ''}`, {
        ret, errcode: json.errcode, body: json,
      })
    }
    if (ret === RET_WINDOW_CLOSED) {
      return new IlinkError(
        api,
        `ret=-2：会话窗口已关闭、单条超长或限额用尽，协议不区分这三者${detail ? `（服务端说 ${detail}）` : ''}`,
        { ret, errcode: json.errcode, body: json },
      )
    }
    return new IlinkError(api, `ret=${ret}${detail ? `：${detail}` : ''}`, {
      ret, errcode: json.errcode, body: json,
    })
  }

  async postJson(api, payload, signal) {
    const response = await fetch(`${this.baseUrl}/ilink/bot/${api}`, {
      method: 'POST',
      headers: businessHeaders(this.token),
      body: JSON.stringify(payload),
      signal,
    })
    return await this.readJson(api, response)
  }

  async getJson(api, query, headers, signal) {
    const search = new URLSearchParams(query).toString()
    const response = await fetch(`${this.baseUrl}/ilink/bot/${api}${search ? `?${search}` : ''}`, {
      method: 'GET',
      headers,
      signal,
    })
    return await this.readJson(api, response)
  }

  /** 取登录二维码：qrcode 是轮询令牌，qrcodeImgContent 是二维码载荷（渲染交给上层）。 */
  async getQrcode(signal) {
    const json = await this.withTimeout('get_bot_qrcode', this.requestTimeoutMs, signal, (s) => {
      return this.getJson('get_bot_qrcode', { bot_type: 3 }, loginHeaders(), s)
    })
    return {
      qrcode: String(json.qrcode || ''),
      imgContent: String(json.qrcode_img_content || ''),
    }
  }

  /** 查一次扫码状态：wait / scaned / confirmed / expired。 */
  async getQrcodeStatus(qrcode, signal) {
    const json = await this.withTimeout('get_qrcode_status', this.requestTimeoutMs, signal, (s) => {
      return this.getJson('get_qrcode_status', { qrcode: String(qrcode || '') }, loginHeaders(), s)
    })
    return {
      state: String(json.status || 'wait'),
      botToken: String(json.bot_token || ''),
      botId: String(json.ilink_bot_id || ''),
      userId: String(json.ilink_user_id || ''),
      baseUrl: String(json.baseurl || ''),
    }
  }

  /**
   * 长轮询收消息。
   *
   * 本地超时返回 { timeout: true }，让上层当成「这一轮没有新消息」立刻续轮；
   * ret=-14 会抛带 ret 的 IlinkError，让上层清凭证重扫码。
   */
  async getUpdates(cursor, { timeoutMs = 35000, signal } = {}) {
    try {
      const json = await this.withTimeout('getupdates', timeoutMs, signal, (s) => {
        return this.postJson('getupdates', {
          get_updates_buf: String(cursor || ''),
          base_info: baseInfo(),
        }, s)
      })
      const list = Array.isArray(json.msgs) ? json.msgs : []
      return {
        timeout: false,
        ret: Number(json.ret) || 0,
        msgs: list,
        // 不透明游标：原样保存、原样回传，绝不解码改。
        cursor: typeof json.get_updates_buf === 'string' ? json.get_updates_buf : '',
        longpollingTimeoutMs: Number(json.longpolling_timeout_ms) || 0,
      }
    } catch (error) {
      if (error?.timeout) return { timeout: true, ret: 0, msgs: [], cursor: '', longpollingTimeoutMs: 0 }
      throw error
    }
  }

  /** 发一条消息（item_list 里放几段就是几个内容，但只占一个气泡）。 */
  async sendMessage({ toUserId, contextToken, clientId, itemList, signal }) {
    const json = await this.withTimeout('sendmessage', this.requestTimeoutMs, signal, (s) => {
      return this.postJson('sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: String(toUserId || ''),
          message_type: 2,
          message_state: 2,
          context_token: String(contextToken || ''),
          client_id: String(clientId || ''),
          item_list: Array.isArray(itemList) ? itemList : [],
        },
        base_info: baseInfo(),
      }, s)
    })
    return json
  }

  /** 申请上传参数；返回 upload_param。aeskey 必须是 32 位 hex（不是 base64）。 */
  async getUploadUrl({ filekey, mediaType, toUserId, rawSize, rawMd5, cipherSize, aesKeyHex, signal }) {
    const json = await this.withTimeout('getuploadurl', this.requestTimeoutMs, signal, (s) => {
      return this.postJson('getuploadurl', {
        filekey: String(filekey || ''),
        media_type: Number(mediaType) || 1,
        to_user_id: String(toUserId || ''),
        rawsize: Number(rawSize) || 0,
        rawfilemd5: String(rawMd5 || ''),
        filesize: Number(cipherSize) || 0,
        aeskey: String(aesKeyHex || ''),
        // 官方实现默认不传缩略图，缩略图那套参数一起省略兼容性最好。
        no_need_thumb: true,
        base_info: baseInfo(),
      }, s)
    })
    const uploadParam = String(json.upload_param || '')
    if (!uploadParam) throw new IlinkError('getuploadurl', '返回里没有 upload_param', { body: json })
    return uploadParam
  }

  /** 把 AES 密文传到 CDN，返回响应头 x-encrypted-param（即 encrypt_query_param）。 */
  async uploadCipher({ cipher, uploadParam, filekey, signal }) {
    const query = new URLSearchParams({
      encrypted_query_param: String(uploadParam || ''),
      filekey: String(filekey || ''),
    }).toString()
    return await this.withTimeout('cdn/upload', this.mediaTimeoutMs, signal, async (s) => {
      const response = await fetch(`${this.cdnBaseUrl}/upload?${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: cipher,
        signal: s,
      })
      if (!response.ok) {
        const detail = response.headers.get('x-error-message') || ''
        throw new IlinkError('cdn/upload', `HTTP ${response.status}${detail ? ` ${detail}` : ''}`, { status: response.status })
      }
      const param = response.headers.get('x-encrypted-param') || ''
      if (!param) throw new IlinkError('cdn/upload', '响应头里没有 x-encrypted-param', { status: response.status })
      return param
    })
  }

  /** 下载 CDN 密文（解密由调用方做：它才知道用哪种 aes_key 编码）。 */
  async downloadCipher({ encryptedParam, signal }) {
    const query = new URLSearchParams({ encrypted_query_param: String(encryptedParam || '') }).toString()
    return await this.withTimeout('cdn/download', this.mediaTimeoutMs, signal, async (s) => {
      const response = await fetch(`${this.cdnBaseUrl}/download?${query}`, { method: 'GET', signal: s })
      if (!response.ok) {
        const detail = response.headers.get('x-error-message') || ''
        throw new IlinkError('cdn/download', `HTTP ${response.status}${detail ? ` ${detail}` : ''}`, { status: response.status })
      }
      return Buffer.from(await response.arrayBuffer())
    })
  }
}
