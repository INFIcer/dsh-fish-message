// NapCat / OneBot 11 适配器：HTTP 发消息 + WebSocket 收事件 + HTTP 历史补投。
//
// 关键取舍：
//   - WS 是首选；连不上、断了，自动走 HTTP 轮询（由 Bridge 定时调 fetchHistory）。
//   - WS 断线指数退避（1s 起，最多 30s，带抖动），不会疯狂重连。
//   - 所有 HTTP 请求都有超时，避免 NapCat 没开时把宿主卡死。

import WebSocket from 'ws'

export class OneBotError extends Error {
  constructor(action, message, data) {
    super(`${action} 失败：${message}`)
    this.name = 'OneBotError'
    this.action = action
    this.data = data
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class NapCatOneBotTransport {
  constructor({ getConfig, logger, WebSocketImpl = WebSocket }) {
    this.getConfig = getConfig
    this.logger = logger
    this.WebSocketImpl = WebSocketImpl
    this.ws = null
    this.stopped = true
    this.handlers = { onEvent: () => {}, onStatus: () => {} }
    this.reconnectTimer = null
    this.reconnectDelay = 1000
    this.status = {
      name: 'napcat-onebot',
      connected: false,
      mode: 'http',
      wsUrl: '',
      attempts: 0,
      lastError: '',
      lastEventAt: 0,
      lastOpenAt: 0,
      lastCloseAt: 0,
      // 最近一次 HTTP 调用成功的时间（毫秒）：HTTP 轮询模式下判断「在线」靠它。
      lastOkAt: 0,
    }
  }

  get name() {
    return 'napcat-onebot'
  }

  getStatus() {
    return { ...this.status }
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch }
    try {
      this.handlers.onStatus(this.getStatus())
    } catch {
      // 状态回调不能影响连接本身。
    }
  }

  async start(handlers = {}) {
    this.handlers = {
      onEvent: typeof handlers.onEvent === 'function' ? handlers.onEvent : () => {},
      onStatus: typeof handlers.onStatus === 'function' ? handlers.onStatus : () => {},
    }
    this.stopped = false
    const config = this.getConfig()
    this.status.wsUrl = config.wsUrl || ''
    clearTimeout(this.reconnectTimer)
    if (!config.wsEnabled) {
      this.setStatus({ connected: false, mode: 'http', lastError: '' })
      this.logger?.info('WebSocket 已关闭，使用 HTTP 轮询')
      return
    }
    this.connectWebSocket()
  }

  onEvent(handler) {
    this.handlers.onEvent = typeof handler === 'function' ? handler : () => {}
    return this
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      try { ws.removeAllListeners() } catch { /* 忽略 */ }
      try { ws.close(1000, '插件停止') } catch { /* 忽略 */ }
      try { ws.terminate() } catch { /* 忽略 */ }
    }
    this.setStatus({ connected: false, mode: 'stopped' })
  }

  connectWebSocket() {
    if (this.stopped) return
    const config = this.getConfig()
    const address = config.wsUrl || ''
    if (!address) {
      this.setStatus({ connected: false, mode: 'http', lastError: 'WS 地址为空，降级 HTTP 轮询' })
      return
    }
    let ws
    try {
      const header = {}
      if (config.napcatToken) header.authorization = `Bearer ${config.napcatToken}`
      ws = new this.WebSocketImpl(address, { handshakeTimeout: 5000, headers: header })
    } catch (error) {
      this.scheduleReconnect(String(error?.message || error))
      return
    }
    this.ws = ws
    this.status.attempts += 1

    ws.on('open', () => {
      if (this.stopped) return
      this.reconnectDelay = 1000
      this.setStatus({
        connected: true,
        mode: 'ws',
        lastOpenAt: Date.now(),
        lastError: '',
      })
      this.logger?.info(`WebSocket 已连接：${address}`)
    })

    ws.on('message', (data) => {
      if (this.stopped) return
      let event
      try {
        event = JSON.parse(String(data))
      } catch {
        this.logger?.debug('WebSocket 收到非 JSON 数据，已忽略')
        return
      }
      this.status.lastEventAt = Date.now()
      try {
        this.handlers.onEvent(event)
      } catch (error) {
        this.logger?.warn(`处理 WebSocket 事件出错：${String(error?.message || error)}`)
      }
    })

    ws.on('error', (error) => {
      if (this.stopped) return
      const str = String(error?.message || error)
      // 第一次失败只记一次 warn，重连过程中降到 debug，避免刷屏。
      if (this.status.mode !== 'ws') this.logger?.warn(`WebSocket 连接失败：${str}`)
      else this.logger?.debug(`WebSocket 错误：${str}`)
      this.setStatus({ connected: false, mode: 'http', lastError: str })
    })

    ws.on('close', () => {
      if (this.stopped) return
      this.ws = null
      this.setStatus({
        connected: false,
        mode: 'http',
        lastCloseAt: Date.now(),
      })
      this.scheduleReconnect('WebSocket 已断开')
    })
  }

  scheduleReconnect(reason) {
    if (this.stopped || this.reconnectTimer) return
    const wait = Math.min(30000, this.reconnectDelay) + Math.floor(Math.random() * 500)
    this.reconnectDelay = Math.min(30000, this.reconnectDelay * 2)
    this.setStatus({ lastError: reason })
    this.logger?.debug(`${reason}，${Math.round(wait / 1000)} 秒后重连 WebSocket`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.connectWebSocket()
    }, wait)
    try { this.reconnectTimer.unref?.() } catch { /* 忽略 */ }
  }

  async call(action, body = {}, { timeoutMs } = {}) {
    const config = this.getConfig()
    const timeout = Math.max(1000, Number(timeoutMs) || Number(config.requestTimeoutMs) || 15000)
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(new Error(`请求超时（${Math.round(timeout / 1000)} 秒）`)), timeout)
    try {
      const header = { 'content-type': 'application/json', 'user-agent': 'dsh-fish-message' }
      if (config.napcatToken) header.authorization = `Bearer ${config.napcatToken}`
      const response = await fetch(`${config.napcatBaseUrl}/${action}`, {
        method: 'POST',
        headers: header,
        body: JSON.stringify(body || {}),
        signal: control.signal,
      })
      const text = await response.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* 下面统一报错 */ }
      if (!response.ok) {
        throw new OneBotError(action, `HTTP ${response.status} ${text.slice(0, 200)}`, json)
      }
      if (!json || json.status !== 'ok' || (json.retcode !== 0 && json.retcode !== undefined)) {
        const note = json?.wording || json?.message || json?.msg || text.slice(0, 200) || '返回格式不认识'
        throw new OneBotError(action, note, json)
      }
      // 任何 HTTP 调用成功都算「服务还活着」：HTTP 轮询模式没有 WS open 事件可依靠。
      this.status.lastOkAt = Date.now()
      return json.data ?? null
    } catch (error) {
      if (error instanceof OneBotError) throw error
      const str = error?.name === 'AbortError' ? `请求超时（${Math.round(timeout / 1000)} 秒）` : String(error?.message || error)
      throw new OneBotError(action, str, null)
    } finally {
      clearTimeout(timer)
    }
  }

  async sendMessage(peer, segments) {
    if (!Array.isArray(segments) || !segments.length) throw new OneBotError('send_private_msg', '消息段为空')
    const qq = String(peer).replace(/[^\d]/g, '')
    if (!qq) throw new OneBotError('send_private_msg', 'QQ 号为空')
    const data = await this.call('send_private_msg', { user_id: Number(qq), message: segments })
    this.logger?.debug(`已发 QQ 私聊 ${qq}：${segments.map((x) => x.type).join('+')}`)
    return data
  }

  async fetchHistory(peer, { count = 100, beforeMessageId, beforeSeq } = {}) {
    const qq = String(peer).replace(/[^\d]/g, '')
    if (!qq) return []
    const payload = { user_id: Number(qq), count: Math.max(1, Math.min(500, Number(count) || 100)) }
    // NapCat 的 get_friend_msg_history 用 message_id 向前翻页；message_seq 在部分版本里会被忽略，保留兼容。
    if (beforeMessageId !== undefined && beforeMessageId !== null && beforeMessageId !== '') payload.message_id = beforeMessageId
    if (beforeSeq !== undefined && beforeSeq !== null && beforeSeq !== '') payload.message_seq = beforeSeq
    const data = await this.call('get_friend_msg_history', payload)
    if (Array.isArray(data)) return data
    if (Array.isArray(data?.messages)) return data.messages
    return []
  }

  /** 把 QQ 语音文件取成 wav；NapCat 的 get_record 会做 silk/amr 解码。 */
  async getRecord(file) {
    if (!file) throw new OneBotError('get_record', 'file 为空')
    return await this.call('get_record', { file, out_format: 'wav' }, { timeoutMs: 30000 })
  }

  async getLoginInfo() {
    return await this.call('get_login_info', {}, { timeoutMs: 5000 })
  }

  /** 下载任意 http(s) 地址（图片/语音兜底）。 */
  async download(url, { maxBytes = 50 * 1024 * 1024, timeoutMs = 30000 } = {}) {
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), Math.max(1000, timeoutMs))
    try {
      const response = await fetch(url, { signal: control.signal, redirect: 'follow' })
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
      const length = Number(response.headers.get('content-length') || 0)
      if (length > maxBytes) throw new Error(`文件太大：${Math.round(length / 1048576)}MB`)
      const buf = Buffer.from(await response.arrayBuffer())
      if (buf.length > maxBytes) throw new Error(`文件太大：${Math.round(buf.length / 1048576)}MB`)
      return buf
    } finally {
      clearTimeout(timer)
    }
  }
}

export { sleep }
