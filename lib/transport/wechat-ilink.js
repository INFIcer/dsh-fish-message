// 微信 iLink（ClawBot）适配器：扫码登录 + getupdates 长轮询 + sendmessage。
//
// 与 NapCat 适配器的差别全在协议层，Bridge 不用改：
//   - 没有 WS，也没有 webhook。消息靠自己发起的长轮询「拉」回来，
//     所以对外报「在线」= 长轮询在跑（Bridge 据此停掉 HTTP 补拉）。
//   - 发消息必须带最近一次入站消息里的 context_token（会话锚点）。
//     协议里没有「打开会话」的接口，没有锚点就是发不出去，只能明确抛错。
//   - 没有历史接口：fetchHistory 恒返回 []，掉线期间的消息靠游标续拉，不靠补拉。
//
// 入站一律规整成 OneBot 11 的私聊消息事件（post_type/message_type/user_id/message[]），
// 另带一个 channel:'wechat' 标记：多通道的 Bridge 按它选绑定、分水位桶；
// 单通道的老 Bridge 不读这个键，也不受影响。

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { ensureDir, readJson, writeJsonAtomic } from '../fs-util.js'
import { IlinkClient, IlinkError } from '../ilink/client.js'
import {
  ILINK_BASE_URL,
  ILINK_CDN_BASE_URL,
  aesKeyForImage,
  decryptEcb,
  encodeAesKeyForSend,
  encryptEcb,
  messageIdOf,
} from '../ilink/protocol.js'
import { imageCategory, guessExtFromMime } from '../voice.js'

/** 服务端 hold 约 35 秒；拿到 longpolling_timeout_ms 后以它为准。 */
const DEFAULT_POLL_TIMEOUT_MS = 35000
/** 扫码状态轮询间隔：太密没意义，太疏扫码确认后要多等。 */
const DEFAULT_LOGIN_POLL_MS = 2000
/** 登录/收消息出错后的退避起点。 */
const DEFAULT_ERROR_RETRY_MS = 3000
/** 去重窗口：只挡同一次运行里的重复帧，跨重启靠 Bridge 落盘的 hasSeen。 */
const SEEN_MAX = 2000

const sleep = (ms, signal) => new Promise((resolve) => {
  const finish = () => {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', finish)
    resolve()
  }
  const timer = setTimeout(finish, Math.max(0, Number(ms) || 0))
  if (signal) {
    if (signal.aborted) finish()
    else signal.addEventListener('abort', finish, { once: true })
  }
})

export class WechatIlinkTransport {
  constructor({
    getConfig = () => ({}),
    logger = null,
    homeDir = '',
    inboxDir = '',
    sessionFile = '',
    baseUrl = '',
    cdnBaseUrl = '',
    // 测试/排障用：把各段等待时间调小，不影响生产默认值。
    timings = {},
  } = {}) {
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({})
    this.logger = logger
    const home = homeDir || process.env.DSH_HOME || join(homedir(), '.dsh')
    // 收件箱目录规则与 lib/host.js 一致：<家目录>/fish-message-inbox。
    this.inboxDir = inboxDir || join(home, 'fish-message-inbox')
    this.sessionFile = sessionFile || join(home, 'fish-message-ilink.json')
    this.timings = {
      pollTimeoutMs: Math.max(200, Number(timings.pollTimeoutMs) || DEFAULT_POLL_TIMEOUT_MS),
      loginPollIntervalMs: Math.max(1, Number(timings.loginPollIntervalMs) || DEFAULT_LOGIN_POLL_MS),
      errorRetryMs: Math.max(1, Number(timings.errorRetryMs) || DEFAULT_ERROR_RETRY_MS),
    }

    this.running = false
    this.runAbort = null
    this.pollPromise = null
    this.loginPromise = null
    this.pollTimeoutMs = this.timings.pollTimeoutMs
    // message id → 时间戳；容量到上限就丢最旧的（Map 保持插入顺序）。
    this.seen = new Map()

    this.session = {
      botToken: '',
      botId: '',
      userId: '',
      baseUrl: String(baseUrl || ''),
      cursor: '',
      peers: {},
    }
    const config = this.getConfig() || {}
    this.client = new IlinkClient({
      baseUrl: baseUrl || ILINK_BASE_URL,
      cdnBaseUrl: cdnBaseUrl || ILINK_CDN_BASE_URL,
      requestTimeoutMs: Number(config.requestTimeoutMs) || 15000,
      logger: this.logger,
    })

    this.login = { state: 'stopped', qrcode: '', imgContent: '', at: 0, error: '' }
    this.status = {
      name: 'wechat-ilink',
      connected: false,
      mode: 'ilink',
      lastOkAt: 0,
      state: 'stopped',
      botId: '',
      lastEventAt: 0,
      lastError: '',
    }
    this.handlers = { onEvent: () => {}, onStatus: () => {} }
  }

  get name() {
    return 'wechat-ilink'
  }

  getStatus() {
    return {
      ...this.status,
      name: this.name,
      connected: Boolean(this.status.connected),
      // stopped 是 Bridge 认的「传输层已停」标记；运行中报自己的通道名。
      mode: this.login.state === 'stopped' ? 'stopped' : 'ilink',
      lastOkAt: Number(this.status.lastOkAt) || 0,
      state: this.login.state,
      botId: this.session.botId,
      qrcodeAt: this.login.at,
      lastError: this.status.lastError || this.login.error || '',
    }
  }

  /**
   * 二维码内容，原样交给上层（qrcode_img_content 是载荷 URL，渲染不在本层做）。
   * 同时带出登录状态机当前处于哪一步。
   */
  getQrcode() {
    return {
      state: this.login.state,
      qrcode: this.login.qrcode,
      imgContent: this.login.imgContent,
      at: this.login.at,
      error: this.login.error,
    }
  }

  setStatus(patch) {
    const before = this.status
    this.status = { ...before, ...patch }
    // connected / state / lastError 才是 Bridge 和设置页真正读的字段；
    // 只改 lastOkAt、lastEventAt 时不回调，避免每次长轮询都刷一遍状态。
    const changed = before.connected !== this.status.connected
      || before.state !== this.status.state
      || before.lastError !== this.status.lastError
    if (!changed) return
    try {
      this.handlers.onStatus(this.getStatus())
    } catch (error) {
      this.logger?.debug(`状态回调出错（忽略）：${String(error?.message || error)}`)
    }
  }

  setLogin(patch) {
    this.login = { ...this.login, ...patch }
    const error = this.login.state === 'error'
      ? this.login.error
      : (this.login.state === 'confirmed' ? '' : this.status.lastError)
    this.setStatus({ state: this.login.state, lastError: error })
  }

  async start(handlers = {}) {
    if (this.running) return
    // 只覆盖真正传进来的回调：先 onEvent() 再 start() 是合法用法，不能把已注册的丢掉。
    this.handlers = {
      onEvent: typeof handlers.onEvent === 'function' ? handlers.onEvent : this.handlers.onEvent,
      onStatus: typeof handlers.onStatus === 'function' ? handlers.onStatus : this.handlers.onStatus,
    }
    this.running = true
    this.runAbort = new AbortController()
    this.loadSession()
    if (this.session.botToken) {
      // 上次的凭证还在：直接续长轮询，游标也从盘上接着用。
      this.login = { state: 'confirmed', qrcode: '', imgContent: '', at: Date.now(), error: '' }
      this.setStatus({ connected: true, state: 'confirmed', botId: this.session.botId, lastError: '' })
      this.logger?.info(`iLink 用上次的凭证启动长轮询（${this.session.botId || '未知 bot'}）`)
      this.startPolling()
      return
    }
    this.startLogin()
  }

  onEvent(handler) {
    this.handlers.onEvent = typeof handler === 'function' ? handler : () => {}
    return this
  }

  async stop() {
    this.running = false
    try { this.runAbort?.abort() } catch { /* 已经中止过 */ }
    this.runAbort = null
    // 两个循环都靠 abort 立刻退出；这里不等它们，stop 不允许被网络卡住。
    this.pollPromise = null
    this.loginPromise = null
    this.login = { ...this.login, state: 'stopped' }
    this.setStatus({ connected: false, state: 'stopped', lastError: '' })
    this.saveSession()
  }

  /** 主动丢弃凭证、重新扫码（设置页「重新登录」用）。 */
  async restartLogin() {
    this.session.botToken = ''
    this.session.botId = ''
    this.session.userId = ''
    this.session.cursor = ''
    this.session.peers = {}
    this.client.token = ''
    this.saveSession()
    this.setStatus({ connected: false, state: 'connecting', lastError: '' })
    this.startLogin()
    return this.getQrcode()
  }

  // ---------------- 登录状态机：connecting / waiting_scan / scaned / confirmed / expired / stopped / error ----------------

  startLogin() {
    if (!this.running || this.loginPromise) return
    this.loginPromise = this.loginLoop().finally(() => { this.loginPromise = null })
  }

  async loginLoop() {
    const signal = this.runAbort?.signal
    this.setLogin({ state: 'connecting', error: '' })
    while (this.running && !this.session.botToken) {
      let qr = null
      try {
        qr = await this.client.getQrcode(signal)
      } catch (error) {
        if (!this.running) return
        this.setLogin({ state: 'error', error: String(error?.message || error) })
        this.logger?.warn(`取 iLink 登录二维码失败：${this.login.error}`)
        await sleep(this.timings.errorRetryMs, signal)
        continue
      }
      if (!qr.qrcode) {
        this.setLogin({ state: 'error', error: 'get_bot_qrcode 没有返回 qrcode' })
        await sleep(this.timings.errorRetryMs, signal)
        continue
      }
      this.setLogin({
        state: 'waiting_scan',
        qrcode: qr.qrcode,
        imgContent: qr.imgContent,
        at: Date.now(),
        error: '',
      })
      this.logger?.info('iLink 等待扫码登录（二维码内容见 getQrcode()）')
      const outcome = await this.waitForScan(qr.qrcode)
      if (outcome === 'confirmed' || outcome === 'stopped') return
      // expired：换一张码重来，登录状态机不退出。
    }
  }

  async waitForScan(qrcode) {
    const signal = this.runAbort?.signal
    while (this.running) {
      let status = null
      try {
        status = await this.client.getQrcodeStatus(qrcode, signal)
      } catch (error) {
        if (!this.running) return 'stopped'
        this.setLogin({ state: 'error', error: String(error?.message || error) })
        this.logger?.debug(`轮询 iLink 扫码状态出错：${this.login.error}`)
        await sleep(this.timings.errorRetryMs, signal)
        continue
      }
      if (status.state === 'confirmed') {
        this.onConfirmed(status)
        return 'confirmed'
      }
      if (status.state === 'expired') {
        this.setLogin({ state: 'expired' })
        this.logger?.info('iLink 二维码已过期，换一张')
        return 'expired'
      }
      // 上一次轮询真失败过（断网、服务端 5xx）：这次读到了状态就说明链路回来了。
      // 不回退的话界面会一直停在「登录失败」，而二维码其实还有效。
      if (this.login.state === 'error') {
        // 先清 lastError：setLogin 对非 confirmed 状态会沿用 status.lastError。
        this.setStatus({ lastError: '' })
        this.setLogin({ state: 'waiting_scan', error: '' })
        this.logger?.info('iLink 扫码状态恢复正常，继续等扫码')
      }
      if (status.state === 'scaned' && this.login.state !== 'scaned') {
        this.setLogin({ state: 'scaned' })
        this.logger?.info('iLink 二维码已扫，等待手机端确认')
      }
      // wait（含服务端把客户端超时当 wait 的情况）：继续轮。
      await sleep(this.timings.loginPollIntervalMs, signal)
    }
    return 'stopped'
  }

  onConfirmed(status) {
    this.session.botToken = String(status.botToken || '')
    this.session.botId = String(status.botId || '')
    this.session.userId = String(status.userId || '')
    // 新登录等于新会话：旧游标不可用（从空串重开），旧 context_token 也不再可靠。
    this.session.cursor = ''
    this.session.peers = {}
    if (/^https?:\/\//i.test(status.baseUrl)) {
      this.session.baseUrl = status.baseUrl
      this.client.baseUrl = status.baseUrl.replace(/\/+$/, '')
    }
    this.client.token = this.session.botToken
    this.saveSession()
    this.login = { ...this.login, state: 'confirmed', at: Date.now(), error: '' }
    this.setStatus({ connected: true, state: 'confirmed', botId: this.session.botId, lastError: '' })
    this.logger?.info(`iLink 登录成功：${this.session.botId}（授权用户 ${this.session.userId}）`)
    this.startPolling()
  }

  // ---------------- 收消息：长轮询 ----------------

  startPolling() {
    if (!this.running || this.pollPromise || !this.session.botToken) return
    this.pollPromise = this.pollLoop().finally(() => { this.pollPromise = null })
  }

  async pollLoop() {
    const signal = this.runAbort?.signal
    let failures = 0
    while (this.running && this.session.botToken) {
      let result = null
      try {
        result = await this.client.getUpdates(this.session.cursor, {
          timeoutMs: this.pollTimeoutMs,
          signal,
        })
      } catch (error) {
        if (!this.running || error?.aborted) return
        if (Number(error?.ret) === -14 || Number(error?.errcode) === -14) {
          this.handleExpired(error)
          return
        }
        // 普通失败：2s 起指数退避，30s 封顶；游标不动，下一轮从同一位置重来。
        failures += 1
        const wait = Math.min(30000, 2000 * failures)
        this.setStatus({ connected: false, lastError: String(error?.message || error) })
        this.logger?.warn(`iLink 收消息失败（第 ${failures} 次，${Math.round(wait / 1000)} 秒后重试）：${this.status.lastError}`)
        await sleep(wait, signal)
        continue
      }
      if (!this.running) return
      failures = 0
      if (result.timeout) continue // 本地超时 = 这一轮没有新消息，立刻续下一轮
      this.status.lastOkAt = Date.now()
      if (Number(result.longpollingTimeoutMs) > 0) this.pollTimeoutMs = Number(result.longpollingTimeoutMs)
      if (result.cursor) {
        // 游标是不透明 blob：拿到就原样落盘，进程重启后接着用。
        this.session.cursor = result.cursor
        this.saveSession()
      }
      if (!this.status.connected) {
        this.setStatus({ connected: true, state: 'confirmed', botId: this.session.botId, lastError: '' })
      }
      for (const message of result.msgs) {
        if (!this.running) return
        // 顺序处理：图片要下载落盘，先入先出才能保证会话里的顺序与时间一致。
        await this.handleInbound(message)
      }
    }
  }

  handleExpired(error) {
    this.logger?.warn(`iLink 登录态失效（${error?.message || 'ret=-14'}）：清凭证与游标，重新扫码`)
    this.session.botToken = ''
    this.session.botId = ''
    this.session.userId = ''
    this.session.cursor = ''
    this.session.peers = {}
    this.client.token = ''
    this.saveSession()
    this.login = { state: 'connecting', qrcode: '', imgContent: '', at: 0, error: '' }
    this.setStatus({ connected: false, state: 'connecting', lastError: 'ret=-14 登录态失效，需要重新扫码' })
    this.startLogin()
  }

  hasSeen(id) {
    return this.seen.has(String(id))
  }

  markSeen(id) {
    this.seen.set(String(id), Date.now())
    while (this.seen.size > SEEN_MAX) {
      const oldest = this.seen.keys().next().value
      this.seen.delete(oldest)
    }
  }

  rememberPeer(peer, contextToken) {
    const prev = this.session.peers[peer] || {}
    this.session.peers[peer] = {
      // 入站没带 token 时保留上一次的：锚点宁可旧，也不要因为一条空 token 消息丢掉。
      contextToken: String(contextToken || prev.contextToken || ''),
      lastActiveAt: Date.now(),
    }
    this.saveSession()
  }

  async handleInbound(message) {
    if (!message || typeof message !== 'object') return
    // message_type 2 = BOT：自己发出去的回流不能再当主人消息转进会话。
    if (Number(message.message_type) === 2) return
    // v1 只做单聊：官方 chatTypes 也只有 direct，带 group_id 的一律跳过。
    if (message.group_id) return
    const peer = String(message.from_user_id || '')
    if (!peer) return
    if (this.session.botId && peer === this.session.botId) return
    const id = messageIdOf(message)
    if (!id) {
      this.logger?.debug('iLink 消息没有可用 id（message_id/client_id/seq 全空），跳过')
      return
    }
    // 帧的形态先记一行：撤回、编辑都靠这几个字段判别，真机出问题时不用再猜。
    this.logger?.debug(
      `iLink 帧：id=${id} seq=${message.seq ?? 0} state=${message.message_state ?? ''} `
      + `update=${message.update_time_ms || 0} delete=${message.delete_time_ms || 0}`,
    )
    // 撤回：iLink 没有独立的撤回事件类型，只有 delete_time_ms（同一条消息被重推一次）。
    // 必须先于 seen 判断——原消息早就 marks 过 seen，走后面就永远到不了这里。
    const deletedMs = Number(message.delete_time_ms)
    if (Number.isFinite(deletedMs) && deletedMs > 0) {
      const timeMs = Number(message.create_time_ms)
      try {
        this.handlers.onEvent({
          post_type: 'notice',
          notice_type: 'friend_recall',
          channel: 'wechat',
          user_id: peer,
          message_id: id,
          time: Number.isFinite(timeMs) && timeMs > 0 ? Math.floor(timeMs / 1000) : Math.floor(Date.now() / 1000),
        })
      } catch (error) {
        this.logger?.warn(`处理 iLink 撤回事件出错：${String(error?.message || error)}`)
      }
      this.status.lastEventAt = Date.now()
      this.logger?.info(`微信撤回：${peer} 撤回了消息 ${id}`)
      return
    }
    if (this.hasSeen(id)) {
      this.logger?.debug(`iLink 重复帧已去重：${id}`)
      return
    }
    this.markSeen(id)
    // 锚点先落盘：即便这条消息的内容整理失败，之后也还能回复它。
    this.rememberPeer(peer, String(message.context_token || ''))
    let event = null
    try {
      event = await this.buildEvent(message, peer, id)
    } catch (error) {
      this.logger?.warn(`整理 iLink 消息 ${id} 失败：${String(error?.message || error)}`)
      return
    }
    this.status.lastEventAt = Date.now()
    try {
      this.handlers.onEvent(event)
    } catch (error) {
      this.logger?.warn(`处理 iLink 入站事件出错：${String(error?.message || error)}`)
    }
  }

  /** 一条 iLink 消息 → OneBot 11 私聊事件。字段只填 Bridge 真正读的那些。 */
  async buildEvent(message, peer, id) {
    const segments = []
    const texts = []
    for (const item of Array.isArray(message.item_list) ? message.item_list : []) {
      const mapped = await this.itemToSegments(item)
      segments.push(...mapped.segments)
      texts.push(...mapped.texts)
    }
    if (!segments.length) {
      // 内容一个都认不出来时也要给一句话：Bridge 会把「没文字也没图」的消息直接丢掉。
      const fallback = '[微信消息：没有可识别的内容]'
      segments.push({ type: 'text', data: { text: fallback } })
      texts.push(fallback)
    }
    const createdMs = Number(message.create_time_ms)
    const time = Number.isFinite(createdMs) && createdMs > 0
      ? Math.floor(createdMs / 1000)
      : Math.floor(Date.now() / 1000)
    return {
      post_type: 'message',
      message_type: 'private',
      channel: 'wechat',
      user_id: peer,
      message_id: id,
      message_seq: message.seq,
      time,
      message: segments,
      raw_message: texts.join('\n'),
      sender: { user_id: peer },
      // 不设 self_id：Bridge 的 sameNumber 会把带 @ 的 iLink id 一律抹成空串，
      // 一旦填了 self_id，同一会话里两个 id 会「相等」，整条消息会被当自己发的丢掉。
    }
  }

  async itemToSegments(item) {
    const out = { segments: [], texts: [] }
    const type = Number(item?.type) || 0
    const refTitle = String(item?.ref_msg?.title || '').trim()
    if (refTitle) out.texts.push(`[引用：${refTitle.slice(0, 40)}]`)
    if (type === 1) {
      const text = String(item?.text_item?.text || '')
      if (text) {
        out.segments.push({ type: 'text', data: { text } })
        out.texts.push(text)
      }
      return out
    }
    if (type === 2) {
      try {
        const path = await this.downloadImage(item.image_item || {})
        // 给 file + path 两个键：VoiceService.fetchImage 认本机路径（existsSync），不认 http。
        out.segments.push({ type: 'image', data: { file: path, path } })
        out.texts.push('[图片]')
      } catch (error) {
        this.logger?.warn(`下载 iLink 图片失败：${String(error?.message || error)}`)
        out.segments.push({ type: 'text', data: { text: '[图片（下载失败）]' } })
        out.texts.push('[图片（下载失败）]')
      }
      return out
    }
    if (type === 3) {
      // 微信语音主流是 SILK，v1 不做解码：服务端已把文字转好放在 voice_item.text。
      const text = String(item?.voice_item?.text || '').trim()
      const seconds = Math.max(0, Math.round((Number(item?.voice_item?.playtime) || 0) / 1000))
      const shown = text
        ? `（语音：${text}）`
        : `[语音消息${seconds > 0 ? `：约 ${seconds} 秒` : ''}，v1 不解码 SILK，服务端也没有给转写]`
      out.segments.push({ type: 'text', data: { text: shown } })
      out.texts.push(shown)
      return out
    }
    if (type === 4) {
      const file = item?.file_item || {}
      const name = String(file.file_name || '').trim() || '未命名文件'
      // 入站文件只带名字与大小：Bridge 只把它渲染成一行文字，落盘没有去处也不该占盘。
      out.segments.push({ type: 'file', data: { file: name, name, size: Number(file.len) || 0 } })
      out.texts.push(`[文件：${name}]`)
      return out
    }
    if (type === 5) {
      out.segments.push({ type: 'video', data: {} })
      out.texts.push('[视频]')
      return out
    }
    // 11/12 是第三方实现见过的 tool-call 帧，其余是未知类型：都给一句占位，别吞消息。
    const shown = `[微信消息类型 ${type || '未知'}：v1 未支持]`
    out.segments.push({ type: 'text', data: { text: shown } })
    out.texts.push(shown)
    return out
  }

  // ---------------- 媒体 ----------------

  async downloadImage(imageItem) {
    const media = imageItem?.media || imageItem?.thumb_media || null
    const param = String(media?.encrypt_query_param || '')
    if (!param) throw new Error('图片没有 encrypt_query_param')
    const key = aesKeyForImage(imageItem)
    const cipher = await this.client.downloadCipher({ encryptedParam: param, signal: this.runAbort?.signal })
    // 少数实现给的是明文；有 key 才解密。
    const buffer = key ? decryptEcb(cipher, key) : cipher
    const max = Math.max(1, Number(this.getConfig()?.maxImageMB) || 10) * 1024 * 1024
    if (buffer.length > max) throw new Error(`图片超过 ${Math.round(max / 1048576)}MB`)
    return this.saveInboxImage(buffer)
  }

  /**
   * 入站图片落盘沿用收件箱既有命名 qq-image-<sha16>.<ext>。
   *
   * StickerStore 的过期清理与「最近图片」都只认这个前缀（见 lib/stickers.js 的
   * cleanupExpireCache / 最近图片正则）；换成 wechat-* 会让这些文件既不进最近图片，
   * 也永远不会被清理。
   */
  saveInboxImage(buffer) {
    const mime = imageCategory(buffer)
    const ext = guessExtFromMime(mime, '.jpg')
    const sha = createHash('sha256').update(buffer).digest('hex').slice(0, 16)
    ensureDir(this.inboxDir)
    const path = join(this.inboxDir, `qq-image-${sha}${ext}`)
    if (!existsSync(path)) writeFileSync(path, buffer)
    return path
  }

  // ---------------- 发消息 ----------------

  /**
   * 一次调用只发一个气泡：多段合成同一条 sendmessage 的 item_list。
   * 失败一律 throw（Outbox 靠 resolve/reject 记账），并保证异常带 ret。
   */
  async sendMessage(peer, segments) {
    const to = String(peer ?? '').trim()
    if (!to) throw new IlinkError('sendmessage', 'peer 为空')
    const anchor = this.session.peers[to]
    if (!anchor || !anchor.contextToken) {
      throw new IlinkError(
        'sendmessage',
        `还没有收到过 ${to} 的消息，没有 context_token 锚点；iLink 没有主动开会话的接口`,
      )
    }
    const list = Array.isArray(segments) ? segments : []
    const itemList = []
    for (const segment of list) {
      const type = String(segment?.type || '')
      const data = segment?.data || {}
      if (type === 'text') {
        const text = String(data.text ?? '')
        // 空文本段不占气泡：Bridge 偶尔会给空段，发出去会变成一条空消息。
        if (!text.trim()) continue
        itemList.push({ type: 1, text_item: { text } })
        continue
      }
      if (type === 'image') {
        itemList.push(await this.buildImageItem(to, data))
        continue
      }
      if (type === 'file') {
        itemList.push(await this.buildFileItem(to, data))
        continue
      }
      if (type === 'record' || type === 'record_file') {
        // 微信语音要 SILK 编码，v1 不做；明确抛错，让 Outbox 按失败记账而不是静默丢。
        throw new IlinkError('sendmessage', 'v1 不支持发送语音（微信语音需要 SILK 编码）')
      }
      throw new IlinkError('sendmessage', `不支持的段类型：${type || '未知'}`)
    }
    if (!itemList.length) throw new IlinkError('sendmessage', '消息段为空')
    // client_id 全局唯一，服务端用它做幂等；同一条内容重发必须换新 id。
    const clientId = `fish-message:${Date.now()}-${randomBytes(4).toString('hex')}`
    await this.client.sendMessage({
      toUserId: to,
      contextToken: anchor.contextToken,
      clientId,
      itemList,
      signal: this.runAbort?.signal,
    })
    this.status.lastOkAt = Date.now()
    this.logger?.debug(`已发微信单聊 ${to}：${list.map((x) => x.type).join('+')}`)
    return { message_id: clientId, ret: 0 }
  }

  async buildImageItem(to, data) {
    const buffer = await this.readMediaBuffer(data, '图片')
    const max = Math.max(1, Number(this.getConfig()?.maxImageMB) || 10) * 1024 * 1024
    if (buffer.length > max) throw new IlinkError('sendmessage', `图片超过 ${Math.round(max / 1048576)}MB`)
    const uploaded = await this.uploadMedia(to, buffer, 1)
    return {
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: uploaded.param,
          aes_key: encodeAesKeyForSend(uploaded.key),
          encrypt_type: 1,
        },
        // 中图/主图的密文大小；官方发图片时就填这个。
        mid_size: uploaded.cipherSize,
      },
    }
  }

  async buildFileItem(to, data) {
    const path = String(data.path || data.file || '').trim()
    if (!path || !existsSync(path)) throw new IlinkError('sendmessage', `文件不存在：${path}`)
    const buffer = readFileSync(path)
    const name = String(data.name || '').trim() || basename(path)
    const uploaded = await this.uploadMedia(to, buffer, 3)
    return {
      type: 4,
      file_item: {
        media: {
          encrypt_query_param: uploaded.param,
          aes_key: encodeAesKeyForSend(uploaded.key),
          encrypt_type: 1,
        },
        file_name: name,
        md5: uploaded.md5,
        // 协议里 len 是字符串，且是明文大小。
        len: String(buffer.length),
      },
    }
  }

  /** getuploadurl → AES-128-ECB 加密 → CDN 上传，拿到 encrypt_query_param。 */
  async uploadMedia(to, buffer, mediaType) {
    const key = randomBytes(16)
    const cipher = encryptEcb(buffer, key)
    const filekey = randomBytes(16).toString('hex')
    const md5 = createHash('md5').update(buffer).digest('hex')
    const uploadParam = await this.client.getUploadUrl({
      filekey,
      mediaType,
      toUserId: to,
      rawSize: buffer.length,
      rawMd5: md5,
      // 必须与本地密文长度一致，否则 CDN 会拒。
      cipherSize: cipher.length,
      aesKeyHex: key.toString('hex'),
      signal: this.runAbort?.signal,
    })
    const param = await this.client.uploadCipher({
      cipher,
      uploadParam,
      filekey,
      signal: this.runAbort?.signal,
    })
    return { param, key, md5, cipherSize: cipher.length }
  }

  /**
   * 出站媒体来源三种：base64://（Bridge 把本机图片转成了 base64）、
   * http(s) 直链、本机绝对路径。与 VoiceService 的读法保持一致。
   */
  async readMediaBuffer(data, label = '文件') {
    const file = String(data?.file || '').trim()
    const url = String(data?.url || '').trim()
    if (file.startsWith('base64://')) return Buffer.from(file.slice('base64://'.length), 'base64')
    const httpUrl = /^https?:\/\//i.test(file) ? file : (/^https?:\/\//i.test(url) ? url : '')
    if (httpUrl) return await this.download(httpUrl, { maxBytes: 50 * 1024 * 1024 })
    const local = String(data?.path || '').trim()
    if (file && existsSync(file)) return readFileSync(file)
    if (local && existsSync(local)) return readFileSync(local)
    throw new IlinkError('sendmessage', `${label}读不出来：${file || url || '（空）'}`)
  }

  /** 下载任意 http(s) 地址（出站图片直链、VoiceService 兜底用）。 */
  async download(url, { maxBytes = 50 * 1024 * 1024, timeoutMs = 30000 } = {}) {
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), Math.max(1000, Number(timeoutMs) || 30000))
    try {
      const response = await fetch(url, { signal: control.signal, redirect: 'follow' })
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
      const length = Number(response.headers.get('content-length') || 0)
      if (length > maxBytes) throw new Error(`文件太大：${Math.round(length / 1048576)}MB`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > maxBytes) throw new Error(`文件太大：${Math.round(buffer.length / 1048576)}MB`)
      return buffer
    } finally {
      clearTimeout(timer)
    }
  }

  // ---------------- 历史 / 最近联系人 ----------------

  /**
   * iLink 没有历史消息接口：只有一个不透明游标 get_updates_buf。
   * 掉线期间的消息由服务端在游标之后重投（at-least-once），不靠补拉；
   * 所以这里恒返回空数组，Bridge 拿到 [] 会静默跳过。
   * 恒返回 [] 还有一层意义：Bridge 不会把「窗口关闭」误判成「掉线要补历史」。
   */
  async fetchHistory(_peer, _options = {}) {
    return []
  }

  /** 收到过消息的 peer（peer id + 最近活跃时间），给设置页做绑定用。 */
  listRecentPeers({ limit = 50 } = {}) {
    const max = Math.max(1, Math.min(500, Number(limit) || 50))
    return Object.entries(this.session.peers || {})
      .map(([peer, item]) => ({
        peer,
        lastActiveAt: Number(item?.lastActiveAt) || 0,
        hasContext: Boolean(item?.contextToken),
      }))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, max)
  }

  // ---------------- 落盘：凭证 / 游标 / 会话锚点 ----------------

  loadSession() {
    const raw = readJson(this.sessionFile, null)
    const peers = {}
    const source = raw?.peers && typeof raw.peers === 'object' ? raw.peers : {}
    for (const [peer, item] of Object.entries(source)) {
      if (!peer) continue
      peers[peer] = {
        contextToken: String(item?.contextToken || ''),
        lastActiveAt: Number(item?.lastActiveAt) || 0,
      }
    }
    this.session = {
      botToken: String(raw?.botToken || ''),
      botId: String(raw?.botId || ''),
      userId: String(raw?.userId || ''),
      // 登录返回的 baseurl 优先于构造参数：部署方可能换了域名。
      baseUrl: String(raw?.baseUrl || this.session.baseUrl || ''),
      cursor: String(raw?.cursor || ''),
      peers,
    }
    if (/^https?:\/\//i.test(this.session.baseUrl)) {
      this.client.baseUrl = this.session.baseUrl.replace(/\/+$/, '')
    }
    if (this.session.botToken) this.client.token = this.session.botToken
  }

  saveSession() {
    const ok = writeJsonAtomic(this.sessionFile, {
      version: 1,
      ...this.session,
      savedAt: new Date().toISOString(),
    })
    if (!ok) this.logger?.warn(`iLink 登录态写不进 ${this.sessionFile}，重启后可能要重新扫码`)
  }
}
