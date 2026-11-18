// 通道路由器：Bridge 只认一个 transport，但同一进程里同时可能跑着 QQ 与微信两条通道。
//
// Bridge 的调用点只知道「发给谁」和「哪条通道」，不认识底下的适配器；这个类把 channel
// 显式映射到适配器，再让每个适配器保持原来的接口形状（start / stop / sendMessage /
// fetchHistory / getStatus），所以 Bridge 一行调用都不用改成多 transport。
//
// 为什么按显式 channel 路由，而不是按 peer 形态猜：
//   同一段对端字符串在两条通道下是两个人（QQ 的 "10086" 与微信的 "10086"），
//   猜错就是把消息发给别人、把水位记到别人头上。peer 形态只在调用方没给 channel 时兜底：
//   纯数字只可能是 QQ 号，其它形态去找非 qq 的通道。
//
// 聚合状态的语义（Bridge 依赖这两条）：
//   - connected = 任一通道在线；HTTP 历史补拉只看 channels.qq（Bridge.transportNeedsPoll）。
//   - mode = 只有一路活着时透出它的 mode，多路给 'multi'，全停给 'stopped'；
//     Bridge 用 mode === 'stopped' 判断「现在能不能发」。
//   - 一条通道起不来不能拖垮另一条：start() 永远不抛，失败原因记进 channels[ch].lastError。

import { PEER_CHANNELS, channelLabel } from '../peer.js'

const CHANNEL_ORDER = Object.freeze(['qq', 'wechat'])
const DIGITS = /^\d+$/

/** 宽松取值：只 trim + 小写，不做通道校验；状态里回填用。 */
const text = (value) => String(value == null ? '' : value).trim()

export class RouterTransport {
  /**
   * @param {object} options
   * @param {(channel: string) => object|null|undefined} options.resolve 返回该通道的适配器；null = 这条通道没启用
   * @param {object} [options.logger]
   */
  constructor({ resolve = null, logger = null } = {}) {
    this.resolveAdapter = typeof resolve === 'function' ? resolve : () => null
    this.logger = logger
    // channel → { transport, error }；只收已经解析到的通道，没启用的通道不占位置。
    this.registry = new Map()
    this.handlers = { onEvent: () => {}, onStatus: () => {} }
    this.started = false
  }

  get name() {
    return 'router'
  }

  /**
   * 显式通道：空值不算显式；写了但不认识直接报错，不替他猜成 qq
   * （猜错会把微信对端剥成空串，消息静默发错人）。
   */
  explicitChannel(value) {
    const raw = text(value).toLowerCase()
    if (!raw) return ''
    if (!PEER_CHANNELS.includes(raw)) {
      throw new Error(`不认识的通道：${raw}（只有 ${PEER_CHANNELS.join(' 与 ')}）`)
    }
    return raw
  }

  /** 这条通道用哪个适配器；没有就是 null（= 这条通道没启用）。 */
  transportFor(channel) {
    const ch = text(channel).toLowerCase()
    if (!ch) return null
    const entry = this.registry.get(ch)
    if (entry?.transport) return entry.transport
    return this.resolveAdapter(ch) || null
  }

  /**
   * 出站/补拉的目标通道：显式给的优先；没给时按 peer 形态兜底。
   * 兜底也找不到时返回最可能的通道，让调用方拿到「这条通道没启用」这个明确原因。
   */
  channelFor(peer, explicit) {
    const ch = this.explicitChannel(explicit)
    if (ch) return ch
    const value = text(peer)
    if (DIGITS.test(value)) return 'qq'
    for (const candidate of CHANNEL_ORDER) {
      if (candidate === 'qq') continue
      if (this.transportFor(candidate)) return candidate
    }
    return 'wechat'
  }

  async start(handlers = {}) {
    // 只覆盖真正传进来的回调：先 onEvent() 再 start() 是合法用法。
    this.handlers = {
      onEvent: typeof handlers?.onEvent === 'function' ? handlers.onEvent : this.handlers.onEvent,
      onStatus: typeof handlers?.onStatus === 'function' ? handlers.onStatus : this.handlers.onStatus,
    }
    this.started = true
    for (const channel of CHANNEL_ORDER) {
      const transport = this.transportFor(channel)
      if (!transport) continue
      await this.startOne(channel, transport)
    }
  }

  /** 单条通道启动：失败只记事，不往外抛（全部失败也不抛，Bridge 的降级逻辑照常走）。 */
  async startOne(channel, transport) {
    const entry = { transport, error: '' }
    this.registry.set(channel, entry)
    try {
      if (typeof transport.start !== 'function') throw new Error('适配器没有 start()')
      await transport.start({
        onEvent: (event) => this.deliverEvent(channel, event),
        onStatus: (status) => this.deliverStatus(status),
      })
    } catch (error) {
      const str = String(error?.message || error)
      entry.error = str
      this.logger?.warn(`启动${channelLabel(channel)}通道失败（其它通道照常）：${str}`)
    }
  }

  async stop() {
    this.started = false
    const entries = [...this.registry.entries()]
    this.registry.clear()
    for (const [channel, entry] of entries) {
      try {
        await entry.transport.stop()
      } catch (error) {
        this.logger?.warn(`停止${channelLabel(channel)}通道失败（继续停其它通道）：${String(error?.message || error)}`)
      }
    }
    this.emitStatus()
  }

  /**
   * 运行时接入一条通道（设置页扫码登录时现建微信适配器用）。
   * 路由器已经启动就直接把这条通道起起来，否则只登记，等 start() 一起起。
   */
  async attach(channel, transport) {
    const ch = this.explicitChannel(channel)
    if (!ch) throw new Error('attach() 要指明通道')
    if (!transport) {
      await this.detach(ch, { stop: false })
      return null
    }
    if (this.started) await this.startOne(ch, transport)
    else this.registry.set(ch, { transport, error: '' })
    this.emitStatus()
    return transport
  }

  /** 摘掉一条通道；默认顺手停掉它（stop: false 用于「已经停过」的场合）。 */
  async detach(channel, { stop = true } = {}) {
    const ch = text(channel).toLowerCase()
    const entry = this.registry.get(ch)
    this.registry.delete(ch)
    if (entry && stop) {
      try {
        await entry.transport.stop()
      } catch (error) {
        this.logger?.warn(`停止${channelLabel(ch)}通道失败（已经摘掉）：${String(error?.message || error)}`)
      }
    }
    if (entry) this.emitStatus()
    return Boolean(entry)
  }

  isAttached(channel) {
    return this.registry.has(text(channel).toLowerCase())
  }

  deliverEvent(channel, event) {
    if (!event || typeof event !== 'object') return
    // 适配器没填 channel 时按它自己那条通道补上；填了就以适配器为准。
    const payload = event.channel ? event : { ...event, channel }
    try {
      this.handlers.onEvent(payload)
    } catch (error) {
      this.logger?.warn(`转发${channelLabel(channel)}通道的入站事件出错：${String(error?.message || error)}`)
    }
  }

  deliverStatus(status) {
    if (status && typeof status === 'object') this.emitStatus()
  }

  emitStatus() {
    try {
      this.handlers.onStatus(this.getStatus())
    } catch (error) {
      this.logger?.debug(`聚合状态回调出错（忽略）：${String(error?.message || error)}`)
    }
  }

  /**
   * 一条通道算「停着」的两个信号：适配器自己报 stopped，或它的状态机停在 stopped。
   * 微信适配器停着时仍报 mode='ilink'（它没有 ws/http 之分），只看 mode 会把停着的微信
   * 当成活着，Bridge 就不会走「传输层已停止，先入队」这条降级路径。
   */
  channelStopped(status) {
    if (status.mode === 'stopped') return true
    return !status.connected && status.state === 'stopped'
  }

  getStatus() {
    const channels = {}
    let connected = false
    let lastOkAt = 0
    for (const channel of CHANNEL_ORDER) {
      const entry = this.registry.get(channel)
      if (!entry) continue
      let raw = {}
      try {
        raw = entry.transport.getStatus?.() || {}
      } catch (error) {
        raw = { lastError: String(error?.message || error) }
      }
      const status = {
        ...raw,
        channel,
        name: String(raw.name || entry.transport.name || channel),
        connected: Boolean(raw.connected),
        mode: String(raw.mode || 'unknown'),
        lastOkAt: Number(raw.lastOkAt) || 0,
        // 启动失败的通道自己没有状态可报，但设置页要看得见原因。
        lastError: String(raw.lastError || entry.error || ''),
      }
      channels[channel] = status
      if (status.connected) connected = true
      lastOkAt = Math.max(lastOkAt, status.lastOkAt)
    }

    // 起不来的通道不算活着：它自己的状态可能还停在初始的 'http'，
    // 但这条路上什么都没跑起来，不能让它把「只有一路活着」算成多路。
    const live = Object.values(channels)
      .filter((status) => {
        const entry = this.registry.get(status.channel)
        const startFailed = Boolean(entry?.error) && !status.connected
        return !startFailed && !this.channelStopped(status)
      })
      .map((status) => status.mode)
    let mode = 'stopped'
    if (live.length === 1) mode = live[0]
    else if (live.length > 1) mode = 'multi'

    return { name: this.name, connected, mode, lastOkAt, channels }
  }

  async sendMessage(peer, segments, options = {}) {
    const channel = this.channelFor(peer, options?.channel)
    const transport = this.transportFor(channel)
    if (!transport || typeof transport.sendMessage !== 'function') {
      throw new Error(`没有启用的${channelLabel(channel)}通道，这条消息没有发出去：先在设置页启用它再试。`)
    }
    return await transport.sendMessage(peer, segments)
  }

  async fetchHistory(peer, options = {}) {
    const channel = this.channelFor(peer, options?.channel)
    const transport = this.transportFor(channel)
    // 补拉是尽力而为：这条通道没启用就当作「没有历史可拉」，返回空数组；
    // 否则 Bridge 的轮询会为一条没启用的渠道反复刷警告。发送才必须明确报错。
    if (!transport || typeof transport.fetchHistory !== 'function') {
      this.logger?.debug(`没有启用的${channelLabel(channel)}通道，跳过它的历史补拉`)
      return []
    }
    return await transport.fetchHistory(peer, options)
  }

  /** 按通道顺序试有 download 的适配器，第一个成功即返回；全失败抛最后一个错误。 */
  async download(url, options = {}) {
    let lastError = null
    for (const channel of CHANNEL_ORDER) {
      const transport = this.transportFor(channel)
      if (!transport || typeof transport.download !== 'function') continue
      try {
        return await transport.download(url, options)
      } catch (error) {
        lastError = error
        this.logger?.debug(`${channelLabel(channel)}通道下载失败，换下一路：${String(error?.message || error)}`)
      }
    }
    if (lastError) throw lastError
    throw new Error(`没有可用的通道能下载：${text(url) || '（空地址）'}`)
  }

  /**
   * 取语音文件只转给 QQ：微信适配器永远不在 record 段里填 data.file
   * （微信语音要 SILK 编码，v1 走服务端转写的那段文字），所以 file 只可能来自 QQ。
   */
  async getRecord(file) {
    const transport = this.transportFor('qq')
    if (!transport || typeof transport.getRecord !== 'function') {
      throw new Error(`没有启用的${channelLabel('qq')}通道，取不到语音文件。`)
    }
    return await transport.getRecord(file)
  }
}
