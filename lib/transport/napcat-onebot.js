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

const 睡眠 = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
    const 配置 = this.getConfig()
    this.status.wsUrl = 配置.wsUrl || ''
    clearTimeout(this.reconnectTimer)
    if (!配置.wsEnabled) {
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
    const 配置 = this.getConfig()
    const 地址 = 配置.wsUrl || ''
    if (!地址) {
      this.setStatus({ connected: false, mode: 'http', lastError: 'WS 地址为空，降级 HTTP 轮询' })
      return
    }
    let ws
    try {
      const 头 = {}
      if (配置.napcatToken) 头.authorization = `Bearer ${配置.napcatToken}`
      ws = new this.WebSocketImpl(地址, { handshakeTimeout: 5000, headers: 头 })
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
      this.logger?.info(`WebSocket 已连接：${地址}`)
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
      const 文 = String(error?.message || error)
      // 第一次失败只记一次 warn，重连过程中降到 debug，避免刷屏。
      if (this.status.mode !== 'ws') this.logger?.warn(`WebSocket 连接失败：${文}`)
      else this.logger?.debug(`WebSocket 错误：${文}`)
      this.setStatus({ connected: false, mode: 'http', lastError: 文 })
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

  scheduleReconnect(原因) {
    if (this.stopped || this.reconnectTimer) return
    const 等待 = Math.min(30000, this.reconnectDelay) + Math.floor(Math.random() * 500)
    this.reconnectDelay = Math.min(30000, this.reconnectDelay * 2)
    this.setStatus({ lastError: 原因 })
    this.logger?.debug(`${原因}，${Math.round(等待 / 1000)} 秒后重连 WebSocket`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.connectWebSocket()
    }, 等待)
    try { this.reconnectTimer.unref?.() } catch { /* 忽略 */ }
  }

  async call(action, body = {}, { timeoutMs } = {}) {
    const 配置 = this.getConfig()
    const 超时 = Math.max(1000, Number(timeoutMs) || Number(配置.requestTimeoutMs) || 15000)
    const 控 = new AbortController()
    const 定时 = setTimeout(() => 控.abort(new Error(`请求超时（${Math.round(超时 / 1000)} 秒）`)), 超时)
    try {
      const 头 = { 'content-type': 'application/json', 'user-agent': 'dsh-fish-message' }
      if (配置.napcatToken) 头.authorization = `Bearer ${配置.napcatToken}`
      const 响应 = await fetch(`${配置.napcatBaseUrl}/${action}`, {
        method: 'POST',
        headers: 头,
        body: JSON.stringify(body || {}),
        signal: 控.signal,
      })
      const 文本 = await 响应.text()
      let json = null
      try { json = JSON.parse(文本) } catch { /* 下面统一报错 */ }
      if (!响应.ok) {
        throw new OneBotError(action, `HTTP ${响应.status} ${文本.slice(0, 200)}`, json)
      }
      if (!json || json.status !== 'ok' || (json.retcode !== 0 && json.retcode !== undefined)) {
        const 说明 = json?.wording || json?.message || json?.msg || 文本.slice(0, 200) || '返回格式不认识'
        throw new OneBotError(action, 说明, json)
      }
      return json.data ?? null
    } catch (error) {
      if (error instanceof OneBotError) throw error
      const 文 = error?.name === 'AbortError' ? `请求超时（${Math.round(超时 / 1000)} 秒）` : String(error?.message || error)
      throw new OneBotError(action, 文, null)
    } finally {
      clearTimeout(定时)
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
    const 体 = { user_id: Number(qq), count: Math.max(1, Math.min(500, Number(count) || 100)) }
    // NapCat 的 get_friend_msg_history 用 message_id 向前翻页；message_seq 在部分版本里会被忽略，保留兼容。
    if (beforeMessageId !== undefined && beforeMessageId !== null && beforeMessageId !== '') 体.message_id = beforeMessageId
    if (beforeSeq !== undefined && beforeSeq !== null && beforeSeq !== '') 体.message_seq = beforeSeq
    const data = await this.call('get_friend_msg_history', 体)
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
    const 控 = new AbortController()
    const 定时 = setTimeout(() => 控.abort(), Math.max(1000, timeoutMs))
    try {
      const 响应 = await fetch(url, { signal: 控.signal, redirect: 'follow' })
      if (!响应.ok) throw new Error(`下载失败：HTTP ${响应.status}`)
      const 长度 = Number(响应.headers.get('content-length') || 0)
      if (长度 > maxBytes) throw new Error(`文件太大：${Math.round(长度 / 1048576)}MB`)
      const buf = Buffer.from(await 响应.arrayBuffer())
      if (buf.length > maxBytes) throw new Error(`文件太大：${Math.round(buf.length / 1048576)}MB`)
      return buf
    } finally {
      clearTimeout(定时)
    }
  }
}

export { 睡眠 }
