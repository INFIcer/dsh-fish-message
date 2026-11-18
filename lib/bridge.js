// 桥的核心：收消息 → 去重/排序 → 转文字/图片 → 递进 DSH 会话；
// DSH 会话说完一轮 → 抠 [QQ] 块 → 发回 QQ。
//
// 这个类不直接 import DSH，也不直接连 NapCat：transport / delivery / voice 都是注入的，
// 所以单测和 mock 集成测试可以完全脱离 QQ 和 DSH 跑。

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { MessageQueue, sortMessages } from './queue.js'
import { OutboundPacer } from './pacing.js'
import { extractOutboundBlocks } from './format.js'
import { Outbox, messageDigest } from './outbox.js'
import {
  DEFAULT_CHANNEL,
  channelLabel,
  isInboundMessage,
  normalizeChannel,
  normalizePeer,
  peerKey,
  peerProblem,
  splitPeerKey,
  watermarkKey,
} from './peer.js'
import { InflightQueue } from './inflight.js'
import { ForwardQueue } from './forward-queue.js'
import { inboundImagePrompt } from './config.js'
import { placeholderPathHint, isPlaceholderPath } from './path-hint.js'
import { MemoryExtension } from './memory-extension.js'

const sessionKey = (id) => {
  const s = String(id || '').trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

/**
 * 一条 assistant/message 的步标识：同一步被重复投递时要能认出来，避免重复发 QQ。
 * DSH 的消息带稳定 id；没有 id 的旧载荷退回步序号，再退回正文与图片内容。
 */
const assistantStepKey = (data, text, images) => {
  const id = data?.message?.id
  if (id) return `id:${id}`
  if (Number.isInteger(data?.step)) return `step:${data.step}`
  const imageIds = (Array.isArray(images) ? images : [])
    .map((block) => String(block?.attachment?.attachmentId || ''))
    .join(',')
  return `body:${text}\u0000${imageIds}`
}

const second = () => Math.floor(Date.now() / 1000)

const shorten = (s, n = 80) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 编辑窗口（毫秒）：0 = 关掉合并，退回逐条投递。 */
const editWindowMs = (config) => Math.max(0, Number(config?.inboundEditWindowMs) || 0)

/**
 * 把排好序的一批消息按编辑窗口切组：相邻两条的时间差 >= 窗口就另起一组。
 * 窗口是毫秒、OneBot 的 time 是秒，所以比较前要乘 1000。
 * 窗口关掉（0）时每条自成一组，和旧行为一致。
 */
export function splitInboundGroups(batch, windowMs) {
  const list = Array.isArray(batch) ? batch : []
  if (!(windowMs > 0)) return list.map((message) => [message])
  const groups = []
  let current = []
  let lastTime = 0
  for (const message of list) {
    const time = Number(message?.time) || 0
    if (current.length && time > 0 && lastTime > 0 && (time - lastTime) * 1000 >= windowMs) {
      groups.push(current)
      current = []
    }
    current.push(message)
    if (time > 0) lastTime = time
  }
  if (current.length) groups.push(current)
  return groups
}

/**
 * 合并一组入站消息：正文按时间顺序换行拼接，图片按顺序拼接。
 * 空正文不占一行（避免合并结果里出现空行）。
 */
export function mergeInboundBatch(items) {
  const texts = []
  const images = []
  for (const item of Array.isArray(items) ? items : []) {
    const body = String(item?.content?.text || '').trim()
    if (body) texts.push(body)
    for (const image of item?.content?.images || []) images.push(image)
  }
  return { text: texts.join('\n'), images }
}

/** 时长展示：保留一位小数，整数就不带 .0。 */
const formatSecond = (value) => {
  const n = Math.round((Number(value) || 0) * 10) / 10
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export class Bridge {
  constructor({
    getConfig,
    transport,
    store,
    logger,
    voice,
    delivery,
    outbox,
    inflight,
    forwardQueue = null,
    stickers = null,
    events = null,
    ai = null,
    // 入站图片图库（可选）：命中缓存就不识图，只把上次的描述递进会话。
    visionCache = null,
    // 记忆扩展（可选）：宿主传 () => ctx.get('memory.library')，没装时返回 undefined。
    // 只在入站图片/语音之后比对；服务缺失、抛错、超时都只跳过比对。
    memory = null,
    startedAt = Date.now(),
    autoTimers = true,
    // 出站节奏的等待函数可注入：测试用记录型的 sleep，不会真等。
    sleep = null,
    now = null,
  }) {
    this.getConfig = getConfig
    // 出站节奏：每条 QQ 消息与上一条之间按「固定间隔 + 字数」拉开，所有出站都经过它。
    this.pacer = new OutboundPacer({
      getConfig,
      logger,
      now: typeof now === 'function' ? now : () => Date.now(),
      sleep: typeof sleep === 'function' ? sleep : undefined,
    })
    // 可选的事件发射器：fish.message 服务把它暴露给别的插件（received/sent/outbox-flushed）。
    // 不传也能跑，所有发射都是尽力而为。
    this.events = events
    this.transport = transport
    this.store = store
    this.logger = logger
    this.voice = voice
    this.delivery = delivery
    // 表情库（可选）：入站自动入库、出站 [表情:…] 解析、发送成功 bump。
    this.stickers = stickers
    // 本地 AI（可选）：语音合成/识别、入站图片识图。null 表示没装或没启动。
    this.ai = ai
    // 图库策略层（可选）：按配置总开关决定「查缓存 / 本地识图 / 交给模型看」。
    this.visionCache = visionCache
    // 记忆扩展策略层（可选）：总开关与两个子开关在 MemoryExtension 里判，
    // 关掉时连记忆服务都不会取，避免无意义调用。
    this.memory = typeof memory === 'function'
      ? new MemoryExtension({ getService: memory, getConfig, logger })
      : null
    this.startedAt = startedAt
    this.autoTimers = autoTimers
    this.running = false
    this.syncing = false
    this.syncAgain = false
    this.historyTimer = null
    this.pollTimer = null
    this.outboxTimer = null
    this.flushPromise = null
    this.replayPromise = null
    this.flushing = false
    this.flushingForward = null
    // 暂停转发：入站照常接收，但先存进 forwardQueue，恢复后按顺序补投。
    this.pauseMiddle = Boolean(getConfig().forwardPaused)
    // 正常发送和补发共用这一条 Promise 链，保证任何时刻只有一次 QQ 发送在进行。
    this.sendChain = Promise.resolve()
    this.outbox = outbox || new Outbox({
      homeDir: store?.filePath ? dirname(store.filePath) : (process.env.DSH_HOME || process.cwd()),
      getConfig,
      logger,
      store,
    })
    // 「发送前等待」期间的待发记录：等的那一刻进程被杀，重启后按 dueAt 回放。
    // 和 Outbox 同目录、同 TTL；发送失败仍进 Outbox，这里只覆盖还没出结果的窗口。
    this.inflight = inflight || new InflightQueue({
      homeDir: this.outbox.homeDir || (store?.filePath ? dirname(store.filePath) : (process.env.DSH_HOME || process.cwd())),
      getConfig,
      logger,
      store,
      now: this.pacer.now,
    })
    // 暂停转发期间的待转发队列（持久化，重启不丢）。
    this.forwardQueue = forwardQueue || new ForwardQueue({
      homeDir: store?.filePath ? dirname(store.filePath) : (process.env.DSH_HOME || process.cwd()),
      logger,
    })
    this.status = {
      running: false,
      startedAt: startedAt,
      lastSyncAt: 0,
      lastSyncReason: '',
      lastSyncError: '',
      lastEventAt: 0,
      transport: null,
      queueSize: 0,
    }
    this.byPeer = new Map()
    this.bySession = new Map()
    this.processing = new Set()
    this.sentTurn = new Set()
    this.voiceErrorTime = new Map()
    this.currentTurn = new Map()
    this.queue = new MessageQueue({
      bufferMs: Number(getConfig().reorderBufferMs) || 0,
      editWindowMs: editWindowMs(getConfig()),
      onBatch: (peer, batch) => this.processBatch(peer, batch),
      logger,
    })
    this.rebuildIndexes()
  }

  /**
   * 事件发射的兜底封装：监听器抛错不能影响收发主流程。
   * 事件名见 docs：received / sent / outbox-flushed。
   */
  emitEvent(name, data) {
    const send = this.events
    if (!send || typeof send.emit !== 'function') return
    try {
      send.emit(String(name), { ...data, at: Date.now() })
    } catch (error) {
      this.logger?.warn?.(`发事件 ${name} 失败（不影响主流程）：${String(error?.message || error)}`)
    }
  }

  rebuildIndexes() {
    this.byPeer.clear()
    this.bySession.clear()
    for (const b of this.getConfig().bindings || []) {
      if (!b.enabled) continue
      const channel = normalizeChannel(b.channel)
      const peer = normalizePeer(channel, b.qq)
      if (!peer) continue
      // 索引键带通道：两个通道下的同一段对端字符串是两个人，不能共用一个桶。
      this.byPeer.set(peerKey(channel, peer), b)
      // session 为空是「渠道保留、未绑定会话」：仍按该对端收消息（好推进水位、避免重新绑定时补投旧消息），
      // 但绝不进 bySession —— 否则 '' 会变成一个能被任一会话命中的键。
      const key = sessionKey(b.session)
      if (key) this.bySession.set(key, b)
    }
    this.queue.configure({
      bufferMs: Number(this.getConfig().reorderBufferMs) || 0,
      editWindowMs: editWindowMs(this.getConfig()),
    })
  }

  async start({ syncNow = true } = {}) {
    if (this.running) return
    this.running = true
    // 保存设置时可能 stop → start；队列的 closed 标记要重置，否则重启后一条都收不进来。
    this.queue.closed = false
    this.status.running = true
    this.status.startedAt = Date.now()
    this.rebuildIndexes()
    this.ensureBaselines()
    this.pauseMiddle = Boolean(this.getConfig().forwardPaused)

    this.transport.start({
      onEvent: (event) => {
        try { this.onTransportEvent(event) } catch (error) {
          this.logger?.warn(`处理入站事件出错：${String(error?.message || error)}`)
        }
      },
      onStatus: (status) => this.onTransportStatus(status),
    }).catch((error) => {
      this.logger?.error(`传输层启动失败：${String(error?.message || error)}`)
      this.status.lastSyncError = String(error?.message || error)
      this.startPolling()
    })

    // WS 正在连接时也先让轮询兜底；WS 一开就会停掉。
    this.startPolling()
    this.scheduleHistory()
    this.startOutboxTimer()
    if (syncNow) {
      setTimeout(() => { void this.sync('startup') }, 300)
    }
    // 启动时先回放「发送前等待」期间留下的待发记录，再补发出站队列；晚一点点，等传输层状态就绪。
    setTimeout(() => {
      if (!this.running) return
      void this.replayInflight('startup')
        .catch((error) => this.logger?.warn(`回放待发消息出错：${String(error?.message || error)}`))
        .finally(() => {
          if (this.running) void this.flushOutbox('startup', { force: true })
        })
    }, 800)
    // 待转发队列：上次暂停时留下的消息，启动后（没在暂停）按顺序补投。
    setTimeout(() => {
      if (this.running) void this.flushForwardQueue('startup')
    }, 900)
    this.logger?.info(`桥已启动：${this.byPeer.size} 个私聊绑定，WS ${this.getConfig().wsEnabled ? '开' : '关'}，轮询 ${this.getConfig().pollIntervalMs}ms，出站积压 ${this.outbox.pending()} 条`)
  }

  async stop() {
    this.running = false
    this.status.running = false
    clearTimeout(this.historyTimer)
    clearTimeout(this.pollTimer)
    clearTimeout(this.outboxTimer)
    this.historyTimer = null
    this.pollTimer = null
    this.outboxTimer = null
    this.queue.clear()
    try { await this.transport.stop() } catch { /* 停不下来也继续收尾 */ }
    this.logger?.info('桥已停止')
  }

  /** 配置变了以后调用：重建绑定索引、调整队列窗口；连接参数变了由宿主决定是否重启。 */
  updateConfig() {
    const currentlyPaused = Boolean(this.getConfig().forwardPaused)
    const justResumed = this.pauseMiddle && !currentlyPaused
    this.pauseMiddle = currentlyPaused
    this.rebuildIndexes()
    if (justResumed) {
      this.logger?.info(`已恢复转发：待补发 ${this.forwardQueue.pending()} 条暂停期间的消息`)
      setTimeout(() => {
        if (this.running) {
          void this.flushForwardQueue('resume').catch((error) => {
            this.logger?.warn(`补发暂停期间的消息出错：${String(error?.message || error)}`)
          })
        }
      }, 0)
    }
  }

  /**
   * 给还没有水位的渠道建一个「从现在开始」的基线，避免把几年的历史一口气灌进会话。
   * at 是基准时刻（毫秒）：启动时用桥启动时间，运行中补绑渠道时用当下，免得把补绑前的消息补投进去。
   * 如果是从旧桥迁移，宿主已经先搬了旧水位，这里不会覆盖。
   */
  ensureBaselines({ at } = {}) {
    const base = Number.isFinite(at) ? Number(at) : this.startedAt
    let change = false
    for (const b of this.getConfig().bindings || []) {
      if (!b.enabled) continue
      const { channel, peer } = this.bindingTarget(b)
      if (!peer) continue
      const key = watermarkKey(channel, peer)
      if (!this.store.getWatermark(key)) {
        this.store.setWatermark(key, {
          timestamp: Math.floor(base / 1000) - 60,
          messageId: '',
        }, false)
        change = true
        this.logger?.info(`首次建立 ${channelLabel(channel)} ${peer} 的水位：从现在开始（不补投陈年历史）`)
      }
    }
    if (change) this.store.save()
  }

  /** 绑定 → {channel, peer}：配置里 channel 缺省 qq，qq 字段是对端原串。 */
  bindingTarget(binding) {
    const channel = normalizeChannel(binding?.channel)
    return { channel, peer: normalizePeer(channel, binding?.qq) }
  }

  /** 水位按通道分桶；qq 沿用裸号，老状态文件里的水位照常读到。 */
  readWatermark(channel, peer) {
    return this.store.getWatermark(watermarkKey(channel, peer))
  }

  onTransportStatus(status) {
    const before = this.status.transport
    this.status.transport = status
    if (status?.connected) {
      if (!before?.connected) {
        void this.sync('ws-connected')
        // 传输恢复在线：立刻给积压一次机会，不用等 10 秒心跳。
        void this.flushOutbox('transport-online', { force: true })
      }
    }
    if (this.running && this.transportNeedsPoll(status)) this.startPolling()
    else this.stopPolling()
  }

  /**
   * 要不要跑 HTTP 历史补拉：只服务 QQ。
   * 路由器把各通道分开报；微信的长轮询在线不能把 QQ 的断开盖成在线——否则 NapCat
   * 只用 HTTP 轮询时，一开微信就再也拉不到 QQ 的消息（fetchHistory 恒空，只能靠轮询）。
   */
  transportNeedsPoll(status = this.status.transport) {
    const qq = status?.channels?.qq
    if (qq) return !qq.connected
    return !status?.connected
  }

  /**
   * 设置页用的连接健康度：HTTP 轮询模式下 connected 一直是 false，
   * 所以不能只看 connected —— 用「最近一次 HTTP 调用成功的时间」补上。
   */
  transportSnapshot() {
    const baseId = { ...(this.status.transport || {}), ...(this.transport.getStatus?.() || {}) }
    const poll = Math.max(500, Number(this.getConfig().pollIntervalMs) || 2000)
    const window = Math.max(3 * poll, 8000)
    const lastOkAt = Number(baseId.lastOkAt) || 0
    const recentSuccess = lastOkAt > 0 && Date.now() - lastOkAt < window
    const wsOnline = Boolean(baseId.connected)
    const stopped = baseId.mode === 'stopped'
    return {
      ...baseId,
      lastOkAt,
      mode: wsOnline ? 'ws' : (stopped ? 'stopped' : 'http'),
      online: !stopped && (wsOnline || recentSuccess),
      // 各路通道的分项状态（路由器给；单个适配器时是空对象），设置页按通道显示在线/登录态。
      channels: baseId.channels || {},
    }
  }

  scheduleHistory() {
    clearTimeout(this.historyTimer)
    if (!this.running || !this.autoTimers) return
    const interval = Math.max(5000, Number(this.getConfig().historyIntervalMs) || 60000)
    this.historyTimer = setTimeout(async () => {
      try { await this.sync('history-timer') } finally { this.scheduleHistory() }
    }, interval)
    try { this.historyTimer.unref?.() } catch { /* 忽略 */ }
  }

  /** 出站队列心跳：每 10 秒（可配）检查一次，有积压就按 FIFO 补发。 */
  startOutboxTimer() {
    clearTimeout(this.outboxTimer)
    this.outboxTimer = null
    if (!this.running || !this.autoTimers) return
    const interval = Math.max(1000, Number(this.getConfig().outboxFlushIntervalMs) || 10000)
    this.outboxTimer = setTimeout(async () => {
      this.outboxTimer = null
      if (!this.running) return
      try { await this.flushOutbox('heartbeat') } catch (error) {
        this.logger?.warn(`出站队列心跳补发出错：${String(error?.message || error)}`)
      }
      // 暂停转发恢复后如果还有没投进去的，也借这个心跳重试。
      try { await this.flushForwardQueue('heartbeat') } catch (error) {
        this.logger?.warn(`待转发队列心跳补投出错：${String(error?.message || error)}`)
      } finally {
        if (this.running) this.startOutboxTimer()
      }
    }, interval)
    try { this.outboxTimer.unref?.() } catch { /* 忽略 */ }
  }

  startPolling() {
    if (!this.running || !this.autoTimers || this.pollTimer) return
    const interval = Math.max(500, Number(this.getConfig().pollIntervalMs) || 2000)
    const tick = async () => {
      this.pollTimer = null
      if (!this.running) return
      if (!this.transportNeedsPoll()) return
      try { await this.sync('http-poll') } finally {
        if (this.running && this.transportNeedsPoll()) this.startPolling()
      }
    }
    this.pollTimer = setTimeout(tick, interval)
    try { this.pollTimer.unref?.() } catch { /* 忽略 */ }
  }

  stopPolling() {
    clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  /**
   * 从历史补齐。WS 重连、启动、定时器、HTTP 轮询都会调这里。
   * 串行执行；执行中再被叫到就标记 syncAgain，结束后补跑一次。
   */
  async sync(reason = 'manual') {
    if (!this.running) return { ok: false, reason: '未启动' }
    if (this.syncing) {
      this.syncAgain = true
      return { ok: false, reason: '已有补投在进行' }
    }
    this.syncing = true
    this.status.lastSyncAt = Date.now()
    this.status.lastSyncReason = reason
    this.status.lastSyncError = ''
    let totalAdded = 0
    try {
      const config = this.getConfig()
      for (const binding of config.bindings || []) {
        if (!binding.enabled) continue
        const { channel, peer } = this.bindingTarget(binding)
        if (!peer) continue
        const key = peerKey(channel, peer)
        const label = `${channelLabel(channel)} ${peer}`
        let list = []
        try {
          list = await this.transport.fetchHistory(peer, { count: config.historyCount })
        } catch (error) {
          const str = String(error?.message || error)
          this.status.lastSyncError = str
          this.logger?.warn(`拉 ${label} 的历史失败：${str}`)
          continue
        }
        if (!Array.isArray(list)) continue
        const watermark = this.readWatermark(channel, peer)

        // 历史接口默认只给最近 count 条。若整页都还比水位新，说明离线期间可能超过一页：
        // 用最早一条的 message_id 继续向前翻，最多 10 页（默认 100 条/页 → 1000 条）。
        if (watermark?.timestamp && list.length >= Number(config.historyCount || 100)) {
          for (let page = 0; page < 10; page++) {
            const earliest = list[0]
            if (!earliest || (Number(earliest.time) || 0) <= watermark.timestamp) break
            if (list.length < Number(config.historyCount || 100)) break
            let earlier = []
            try {
              earlier = await this.transport.fetchHistory(peer, {
                count: config.historyCount,
                beforeMessageId: earliest.message_id,
              })
            } catch (error) {
              this.logger?.debug(`向前翻页失败（不影响已有页）：${String(error?.message || error)}`)
              break
            }
            const existing = new Set(list.map((m) => String(m.message_id)))
            const added = (Array.isArray(earlier) ? earlier : []).filter((m) => !existing.has(String(m.message_id)))
            if (!added.length) break
            list = [...added, ...list]
          }
        }

        const inbound = list
          .filter((m) => this.isInbound(m, channel, peer))
          .sort(sortMessages)

        // 水位之前的消息是「旧桥已经处理过 / 本插件首次安装前」的历史：
        // 静默记掉，不投、也不发「跳过 N 条」摘要，避免刚装好就被旧历史刷一脸。
        if (watermark?.timestamp) {
          let cleaned = false
          for (const m of inbound) {
            if ((Number(m.time) || 0) > 0 && (Number(m.time) || 0) < watermark.timestamp) {
              if (!this.store.hasSeen(m.message_id)) cleaned = true
              this.store.markSeen(m.message_id, false)
            }
          }
          if (cleaned) this.store.save()
        }

        const unseen = inbound.filter((m) => {
          if (this.store.hasSeen(m.message_id)) return false
          if (this.queue.has(key, m.message_id)) return false
          if (this.processing.has(String(m.message_id))) return false
          return true
        })
        if (!unseen.length) continue

        const windowSecond = Math.max(0, Number(config.backfillWindowHours) || 0) * 3600
        const now = second()
        const tooOld = []
        const newOne = []
        for (const m of unseen) {
          const time = Number(m.time) || 0
          if (windowSecond > 0 && time > 0 && now - time > windowSecond) tooOld.push(m)
          else newOne.push(m)
        }

        if (tooOld.length) {
          const earliest = Math.min(...tooOld.map((m) => Number(m.time) || now))
          const latest = Math.max(...tooOld.map((m) => Number(m.time) || 0))
          for (const m of tooOld) {
            this.store.markSeen(m.message_id, false)
            this.store.noteSkippedOld()
          }
          const prev = this.readWatermark(channel, peer)
          this.store.setWatermark(watermarkKey(channel, peer), {
            timestamp: Math.max(Number(prev?.timestamp) || 0, latest),
            messageId: tooOld[tooOld.length - 1]?.message_id,
          }, false)
          this.logger?.warn(`${label} 有 ${tooOld.length} 条离线消息超过补投窗口（${config.backfillWindowHours} 小时），只发摘要`)
          await this.deliverOfflineSummary(binding, tooOld.length, earliest, latest)
        }

        for (const m of newOne) {
          if (this.queue.enqueue(key, m)) totalAdded++
        }
        // 编辑窗口开着时不强制 flush：窗口的意义就是「再等等，主人可能还在发/撤」，
        // 同步抢先投递会把窗口截断。窗口关掉时保持旧行为，拉回来就投。
        if (newOne.length && editWindowMs(config) === 0) await this.queue.flush(key)
      }
      this.status.queueSize = this.queue.size()
      return { ok: true, added: totalAdded, reason }
    } catch (error) {
      this.status.lastSyncError = String(error?.message || error)
      this.logger?.error(`补投失败：${this.status.lastSyncError}`)
      return { ok: false, error: this.status.lastSyncError }
    } finally {
      this.syncing = false
      if (this.syncAgain) {
        this.syncAgain = false
        setTimeout(() => { void this.sync('queued') }, 0)
      }
    }
  }

  isInbound(message, channel, peer) {
    return isInboundMessage(message, channel, peer)
  }

  onTransportEvent(event) {
    if (!this.running || !event) return
    if (event.post_type === 'notice') {
      this.onRecallNotice(event)
      return
    }
    if (event.post_type !== 'message') return
    if (event.message_type && event.message_type !== 'private') return
    // 通道由适配器填；老适配器没有这个字段，按默认的 qq 处理。
    const channel = normalizeChannel(event.channel)
    const peer = normalizePeer(channel, event.user_id)
    if (!peer) return
    const key = peerKey(channel, peer)
    if (!this.byPeer.has(key)) return
    if (!this.isInbound(event, channel, peer)) return
    const message = {
      message_id: event.message_id ?? event.messageId,
      message_seq: event.message_seq ?? event.messageSeq,
      time: Number(event.time) || second(),
      user_id: event.user_id,
      sender: event.sender,
      message: event.message,
      raw_message: event.raw_message,
      source: 'ws',
    }
    if (this.queue.enqueue(key, message)) {
      this.status.lastEventAt = Date.now()
      this.status.queueSize = this.queue.size()
      this.logger?.debug(`WS 收到 ${channelLabel(channel)} ${peer} 的消息 ${message.message_id}`)
    }
  }

  /**
   * 好友撤回（OneBot notice / friend_recall）：只处理还在编辑窗口里、尚未投递的消息。
   * user_id 是对方 id，message_id 是被撤回的那条。
   * 已投递的撤不回来；正在投递的也来不及（投递已经交给 DSH 了），只记日志。
   */
  onRecallNotice(event) {
    if (event?.notice_type !== 'friend_recall') {
      // group_recall 等其它撤回不在本期范围：v1 只做私聊。
      this.logger?.debug(`收到不处理的撤回类通知：${String(event?.notice_type || event?.post_type || '未知')}`)
      return
    }
    const channel = normalizeChannel(event.channel)
    const peer = normalizePeer(channel, event.user_id)
    const id = String(event.message_id ?? '')
    if (!peer || !id) return
    const key = peerKey(channel, peer)
    const label = `${channelLabel(channel)} ${peer}`
    if (!this.byPeer.has(key)) {
      this.logger?.debug(`撤回事件来自未绑定的 ${label}，忽略`)
      return
    }
    if (this.queue.remove(key, id)) {
      this.status.queueSize = this.queue.size()
      this.logger?.info(`撤回：${label} 的消息 ${id} 还在编辑窗口里，已从待投队列删掉`)
      return
    }
    if (this.processing.has(id)) {
      this.logger?.warn(`撤回：${label} 的消息 ${id} 正在投递，已经撤不回来了`)
    } else if (this.store.hasSeen(id)) {
      this.logger?.info(`撤回：${label} 的消息 ${id} 已经投递过，忽略`)
    } else {
      this.logger?.debug(`撤回：${label} 的消息 ${id} 不在待投队列里（历史里已经没有了），忽略`)
    }
  }

  /** 队列到点后的批处理：按编辑窗口分组、每组合并成一条递进 DSH；失败就保留剩余消息，下一轮重试。 */
  async processBatch(key, batch) {
    const ids = batch.map((m) => String(m?.message_id ?? '')).filter(Boolean)
    for (const id of ids) this.processing.add(id)
    try {
      return await this._processBatch(key, batch)
    } finally {
      for (const id of ids) this.processing.delete(id)
    }
  }

  async _processBatch(key, batch) {
    // 队列键是 `${channel}:${peer}`：绑定索引、水位、去重都按它分桶，两个通道不会串。
    const { channel, peer } = splitPeerKey(key)
    const binding = this.byPeer.get(String(key))
    if (!binding) return
    const label = `${channelLabel(channel)} ${peer}`
    // 渠道在配置里但没绑会话（会话级入口选了「不绑定」）：消息没有去处。
    // 仍然标记已读、推进水位，否则下次绑定时会把这段时间的旧消息补投一遍。
    if (!sessionKey(binding.session)) {
      for (const m of batch) {
        if (!m) continue
        this.store.markSeen(m.message_id, false)
        this.advanceWatermark(channel, peer, m)
        this.store.noteReceived()
      }
      this.store.save()
      this.status.queueSize = this.queue.size()
      this.logger?.debug(`${label} 的渠道没有绑定会话，这批 ${batch.length} 条消息不转入 DSH`)
      return
    }
    const config = this.getConfig()
    const windowSecond = Math.max(0, Number(config.backfillWindowHours) || 0) * 3600
    // 编辑窗口把这一批再切成若干组：相邻消息间隔太远就是主人在另一个时间段发的，
    // 各自合并投递（离线补投时尤其重要：不能把几小时前的几条糊成一段）。
    const groups = splitInboundGroups(batch, editWindowMs(config))
    this.status.queueSize = this.queue.size()
    let prevItemNumber = 0
    let earliest = 0
    let latest = 0
    let cursor = 0

    for (const group of groups) {
      // 这一组在整批里的起点：失败重排队时从组首开始，保证顺序不乱。
      const groupStart = cursor
      cursor += group.length
      const items = []
      for (const m of group) {
        if (this.store.hasSeen(m.message_id)) continue
        const time = Number(m.time) || 0
        if (windowSecond > 0 && time > 0 && second() - time > windowSecond) {
          this.store.markSeen(m.message_id, false)
          this.store.noteSkippedOld()
          prevItemNumber++
          earliest = earliest ? Math.min(earliest, time) : time
          latest = Math.max(latest, time)
          continue
        }

        let content
        try {
          content = await this.buildInbound(binding, m)
        } catch (error) {
          const str = String(error?.message || error)
          this.logger?.error(`整理 ${label} 的消息 ${m.message_id} 失败：${str}`)
          this.store.noteError(str)
          this.requeue(key, batch.slice(groupStart))
          this.store.save()
          return
        }
        if (!content.text && !(content.images || []).length) {
          this.store.markSeen(m.message_id, false)
          this.advanceWatermark(channel, peer, m)
          continue
        }
        items.push({ message: m, content, time })
      }
      if (!items.length) continue

      const merged = mergeInboundBatch(items)
      const last = items[items.length - 1]

      // 暂停转发：消息照常解析、记统计、推进水位，但先存起来，恢复后按顺序补投。
      // 这里**按条**暂存、不合并：待转发队列按条限 4 张图，合并会把多图批次截掉；
      // 恢复后逐条补投，消息边界与图片数量都不会变。
      if (config.forwardPaused) {
        for (const item of items) {
          const into = this.forwardQueue.enqueue({
            sessionId: binding.session,
            channel,
            qq: peer,
            name: binding.name,
            messageId: item.message.message_id,
            time: item.time,
            text: item.content.text,
            images: item.content.images,
          })
          this.store.markSeen(item.message.message_id, false)
          this.advanceWatermark(channel, peer, item.message)
          this.store.noteReceived()
          this.store.recordEvent({ direction: 'in', channel, qq: peer, ok: true, text: `[暂停转发] ${item.content.text}` })
          this.logger?.info(`暂停转发中，消息已暂存（${into.pending} 条待补发）：${label} → 会话 ${sessionKey(binding.session)}`)
        }
        continue
      }

      const result = await this.delivery.deliver({
        sessionId: binding.session,
        text: merged.text,
        images: merged.images,
        channel,
        meta: {
          channel,
          qq: peer,
          name: binding.name,
          // 合并批次用最后一条的 message_id：它是这一批里最新、水位也停在那一条的消息。
          messageId: String(last.message.message_id ?? ''),
          time: last.time,
        },
      })
      if (!result?.ok) {
        const str = String(result?.error || '投递失败')
        this.store.noteError(str)
        this.store.recordEvent({ direction: 'in', channel, qq: peer, ok: false, text: merged.text, error: str })
        this.logger?.warn(`这一批（${items.length} 条）没投进 DSH（${str}），下一轮再试`)
        this.requeue(key, batch.slice(groupStart))
        this.store.save()
        return
      }

      // 去重、水位、统计、事件仍按每条消息逐条记：合并只发生在「投递」这一层。
      for (const item of items) {
        this.store.markSeen(item.message.message_id, false)
        this.advanceWatermark(channel, peer, item.message)
        this.store.noteReceived()
        this.store.noteDelivered()
        this.store.recordEvent({ direction: 'in', channel, qq: peer, ok: true, text: item.content.text })
        this.emitEvent('received', {
          channel,
          qq: peer,
          messageId: String(item.message.message_id ?? ''),
          text: item.content.text,
          ...(item.time ? { time: item.time } : {}),
        })
      }
      this.logger?.info(items.length > 1
        ? `${label} → DSH（合并 ${items.length} 条）：${shorten(merged.text, 90)}`
        : `${label} → DSH：${shorten(merged.text, 90)}`)
    }

    this.store.save()
    this.status.queueSize = this.queue.size()
    if (prevItemNumber) await this.deliverOfflineSummary(binding, prevItemNumber, earliest, latest)
  }

  requeue(key, messages) {
    // 重排队时至少再等一个编辑窗口：否则按消息时间戳算早已过期，会立刻重试、空转。
    const wait = editWindowMs(this.getConfig())
    const notBefore = wait > 0 ? Date.now() + wait : 0
    for (const m of messages) {
      if (!this.store.hasSeen(m.message_id)) this.queue.enqueue(String(key), m, { notBefore })
    }
  }

  advanceWatermark(channel, peer, message) {
    const time = Number(message.time) || second()
    const key = watermarkKey(channel, peer)
    const prev = this.store.getWatermark(key)
    this.store.setWatermark(key, {
      timestamp: Math.max(Number(prev?.timestamp) || 0, time),
      messageId: message.message_id,
    }, false)
  }

  /** 一条 QQ 消息 → 交给 DSH 的文字 + 图片附件。 */
  async buildInbound(binding, message) {
    const config = this.getConfig()
    const segmentList = Array.isArray(message.message)
      ? message.message
      : [{ type: 'text', data: { text: String(message.raw_message || '') } }]
    const bodies = []
    const images = []
    const imagePaths = []
    let imageCount = 0
    // 设置是「继承」时，问一次本地 AI 插件自己的识图开关；拿不到按「开」处理。
    const imageDescriptionOpen = (this.ai && typeof this.ai.inboundImageEnabled === 'function')
      ? await this.ai.inboundImageEnabled(config.describeInboundImages)
      : false
    // 图库总开关关掉时完全退回旧行为：每次按设置识图，不查库也不写库。
    const imageLibraryEnabled = Boolean(this.visionCache) && config.imageLibraryEnabled !== false
    // 识图提示词是鱼讯自己的设置（QQ 图片/表情包场景）；留空时用内置默认，
    // 调用时作为 prompt 覆盖参数传给本地 AI，和它自己的会话识图/工具识图互不影响。
    const imagePrompt = inboundImagePrompt(config)

    for (const segment of segmentList) {
      if (!segment || typeof segment !== 'object') continue
      const kind = String(segment.type || '')
      const d = segment.data || {}
      if (kind === 'text') {
        bodies.push(String(d.text || ''))
        continue
      }
      if (kind === 'image' || kind === 'mface') {
        const hasImage = String(d.url || d.file || d.path || d.thumb || '')
        if (kind === 'mface' && !hasImage) {
          bodies.push(`[表情：${String(d.summary || d.emoji_id || '大表情').slice(0, 20)}]`)
          continue
        }
        if (imageCount >= 4) {
          bodies.push('[图片（超过 4 张，后面的没取）]')
          continue
        }
        try {
          const image = await this.voice.fetchImage(segment, message.message_id, imageCount + 1)
          imageCount += 1
          imagePaths.push(image.path)
          // 图库开着时先按指纹查库：有描述就直接用（不附原图）；第一次见到只登记、
          // 第二次起才按设置识图补描述；图库关掉时完全走旧行为（按设置识图，不缓存）。
          // 描述只占一行文字，原图会塞 base64；所以能用描述就不用原图，
          // 想回看原图时由模型主动调 fish_image_get。
          let description = ''
          let note = ''
          if (imageLibraryEnabled) {
            const resolution = await this.visionCache.resolve({
              buffer: image.buffer,
              path: image.path,
              mime: image.mime,
              ext: image.ext,
              localVision: imageDescriptionOpen,
              prompt: imagePrompt,
            })
            description = String(resolution?.desc || '').trim()
            note = String(resolution?.note || '').trim()
          } else if (imageDescriptionOpen) {
            try {
              const imageDescription = await this.ai.describeImage(image.path, { mode: 'caption', prompt: imagePrompt })
              if (imageDescription?.ok) description = String(imageDescription.text || '').trim()
            } catch (error) {
              this.logger?.debug(`入站图片识图失败（改为直接发图）：${String(error?.message || error)}`)
            }
          }
          if (description) {
            bodies.push(`（图片：${description}${note ? `；${note}` : ''}；已存到 ${image.path}）`)
          } else {
            images.push({
              base64: image.base64,
              mime: image.mime,
              name: `qq-${message.message_id || 'x'}-${imageCount}${image.ext}`,
              path: image.path,
            })
            bodies.push(note ? `[图片]（${note}）` : '[图片]')
          }
          // 记忆扩展：与记忆图库按内容指纹比对（只算 sha256，不发图）。
          // 没装插件、服务抛错或超时都只跳过这一行，图片本身照常递。
          const memoryNote = (await this.memory?.imageNote(image.buffer)) || ''
          if (memoryNote) bodies.push(memoryNote)
          // 自动入库默认关（避免每收一张图就占一份库容量）；开了就按 sha 去重。
          if (config.autoSaveStickers && this.stickers && typeof this.stickers.save === 'function' && image.path) {
            try {
              const save = this.stickers.save(image.path, { source: 'qq-auto' })
              if (save?.created) this.logger?.info(`入站图片已自动入库：${save.entry?.file || image.path}`)
            } catch (error) {
              this.logger?.warn(`入站图片自动入库失败（不影响收消息）：${String(error?.message || error)}`)
            }
          }
        } catch (error) {
          this.logger?.warn(`下载图片失败：${String(error?.message || error)}`)
          bodies.push('[图片（下载失败）]')
        }
        continue
      }
      if (kind === 'record') {
        // 语音落盘后，装了本地 AI 且开了分析就顺带把文字、情感递进会话；
        // 没装/没开/分析失败时，仍然保持原来的「路径 + 时长」。
        try {
          const voice = await this.voice.recordToFile(segment, message.message_id)
          const path = String(voice?.wavPath || voice?.rawPath || '')
          if (!path) throw new Error('没有拿到本地语音文件路径')
          const second = Number(voice?.seconds) || 0
          let append = ''
          if (config.transcribeInbound && this.ai) {
            try {
              const analyze = await this.ai.asr(path, { language: config.asrLanguage })
              if (analyze?.ok) {
                const capabilities = []
                // 情感和背景音都只有短词，旧版插件没有这两个字段时是空串，这里自动跳过。
                if (analyze.emotion) capabilities.push(`情感：${analyze.emotion}`)
                if (analyze.background) capabilities.push(`背景：${analyze.background}`)
                if (analyze.text) capabilities.push(`转写：${analyze.text}`)
                if (capabilities.length) append = `；${capabilities.join('；')}`
              }
            } catch (error) {
              this.logger?.debug(`语音分析失败（只递路径）：${String(error?.message || error)}`)
            }
          }
          const tail = second > 0 ? `，${formatSecond(second)} 秒${append}` : append
          bodies.push(`（语音：${path}${tail}）`)
          // 记忆扩展：与声纹库按声音认人。认不出或服务不可用只记日志，正文不加噪音。
          const memoryNote = (await this.memory?.voiceNote(path)) || ''
          if (memoryNote) bodies.push(memoryNote)
        } catch (error) {
          const str = String(error?.message || error)
          this.logger?.warn(`语音落盘失败：${str}`)
          this.store.noteError(`语音落盘失败：${str}`)
          bodies.push(`[语音（保存失败：${shorten(str, 60)}）]`)
        }
        continue
      }
      if (kind === 'face') { bodies.push('[表情]'); continue }
      if (kind === 'at') { bodies.push(`@${String(d.name || d.qq || '')}`); continue }
      if (kind === 'reply') { bodies.push('[引用了一条消息]'); continue }
      if (kind === 'file') { bodies.push(`[文件：${String(d.name || d.file || '未知')}]`); continue }
      if (kind === 'json' || kind === 'xml') { bodies.push('[分享卡片]'); continue }
      if (kind === 'video') { bodies.push('[视频]'); continue }
      if (kind === 'forward') { bodies.push('[合并转发的聊天记录]'); continue }
      bodies.push(`[${kind || '未知消息'}]`)
    }

    let plainText = bodies.join('\n').trim()
    if (imageCount) {
      const paths = imagePaths.filter(Boolean)
      const note = `（收到 ${imageCount} 张图片${paths.length ? `，已存到 ${paths.join('；')}` : ''}）`
      plainText = plainText ? `${plainText}\n${note}` : note
    }
    return { text: plainText, images: images }
  }

  async deliverOfflineSummary(binding, count, earliest, latest) {
    // 未绑定会话的渠道没有去处；跳过摘要，只靠日志留痕。
    if (!sessionKey(binding?.session)) return
    const config = this.getConfig()
    const format = (t) => {
      if (!t) return ''
      try {
        return new Date(Number(t) * 1000).toLocaleString('zh-CN', { hour12: false })
      } catch {
        return ''
      }
    }
    const plainText = `（离线补投摘要）机器人离线期间有 ${count} 条消息，超过 ${config.backfillWindowHours} 小时补投窗口，已跳过。`
      + (earliest ? `\n最早：${format(earliest)}；最近：${format(latest)}` : '')
    const { channel } = this.bindingTarget(binding)
    const result = await this.delivery.deliver({
      sessionId: binding.session,
      text: plainText,
      images: [],
      channel,
      meta: { channel, qq: binding.qq, name: binding.name, offlineSummary: true },
    })
    if (!result?.ok) this.logger?.warn(`离线摘要没投进 DSH：${result?.error || '未知原因'}`)
  }

  // ---------------- 暂停转发：待转发队列的补投 ----------------

  /** 队列里只存了图片路径；投递前还原成 DSH 能接的附件块。 */
  restoreAttachment(item) {
    const out = []
    for (const image of item?.images || []) {
      const path = String(image?.path || '').trim()
      if (!path) continue
      try {
        if (!existsSync(path)) {
          this.logger?.warn(`待转发消息的图片文件不在了，只发文字：${path}`)
          continue
        }
        out.push({
          base64: readFileSync(path).toString('base64'),
          mime: String(image.mime || 'image/jpeg'),
          name: String(image.name || 'qq.jpg'),
          path: path,
        })
      } catch (error) {
        this.logger?.warn(`读待转发图片失败（只发文字）：${String(error?.message || error)}`)
      }
    }
    return out
  }

  /**
   * 补投暂停期间攒下的消息：按入队顺序逐条投，失败就留在队首下一轮再试。
   * 过期/超上限被丢弃的，恢复时按会话各提示一句「有 N 条过期未转发」。
   */
  flushForwardQueue(reason = 'heartbeat') {
    if (this.flushingForward) return this.flushingForward
    if (!this.running) {
      return Promise.resolve({ ok: false, error: '桥未启动', sent: 0, pending: this.forwardQueue.pending() })
    }
    if (this.getConfig().forwardPaused) {
      this.pauseMiddle = true
      return Promise.resolve({ ok: true, paused: true, sent: 0, pending: this.forwardQueue.pending() })
    }
    this.pauseMiddle = false
    this.flushingForward = this._flushForwardQueue(reason).finally(() => {
      this.flushingForward = null
    })
    return this.flushingForward
  }

  async _flushForwardQueue(reason) {
    const result = { ok: true, reason, sent: 0, failed: 0, pending: 0 }
    this.forwardQueue.expire()

    // 先提示被丢弃的数量（只在确实丢过时说），再按顺序补投。
    const droppedTable = this.forwardQueue.getDropStats()
    for (const [sessionId, number] of Object.entries(droppedTable)) {
      if (!Number(number)) continue
      try {
        const notify = await this.delivery.deliver({
          sessionId,
          text: `（暂停转发期间有 ${number} 条消息超过保留时间，没有补发。）`,
          images: [],
          meta: { notice: 'forward-expired' },
        })
        if (!notify?.ok) this.logger?.warn(`过期未转发提示没投进会话 ${shorten(sessionId, 12)}：${notify?.error || '未知原因'}`)
        else this.store.recordEvent({ direction: 'in', qq: '', ok: true, text: `[暂停转发] 过期未转发 ${number} 条` })
      } catch (error) {
        this.logger?.warn(`过期未转发提示投递出错：${String(error?.message || error)}`)
      }
    }

    while (this.running && !this.getConfig().forwardPaused) {
      const item = this.forwardQueue.next()
      if (!item) break
      let deliver
      try {
        const channel = normalizeChannel(item.channel)
        deliver = await this.delivery.deliver({
          sessionId: item.sessionId,
          text: item.text,
          images: this.restoreAttachment(item),
          channel,
          meta: {
            channel,
            qq: item.qq,
            name: item.name,
            messageId: item.messageId,
            time: item.time,
            resumed: true,
          },
        })
      } catch (error) {
        deliver = { ok: false, error: String(error?.message || error) }
      }
      if (!deliver?.ok) {
        const str = String(deliver?.error || '投递失败')
        result.failed += 1
        this.forwardQueue.markFailed(item.id, str)
        this.store.recordEvent({ direction: 'in', channel: item.channel, qq: item.qq, ok: false, text: `[暂停转发] ${item.text}`, error: str })
        this.logger?.warn(`暂停期间的消息没投进会话（留在队列里下一轮再试）：${channelLabel(item.channel)} ${item.qq}｜${str}`)
        break
      }
      this.forwardQueue.markSent(item.id)
      result.sent += 1
      this.store.noteDelivered()
      this.store.recordEvent({ direction: 'in', channel: item.channel, qq: item.qq, ok: true, text: `[补发] ${item.text}` })
      this.logger?.info(`补发暂停期间的消息：${channelLabel(item.channel)} ${item.qq} → 会话 ${shorten(item.sessionId, 12)}`)
      this.emitEvent('received', {
        channel: normalizeChannel(item.channel),
        qq: String(item.qq || ''),
        messageId: String(item.messageId || ''),
        text: item.text,
        ...(Number(item.time) ? { time: Number(item.time) } : {}),
        resumed: true,
      })
    }

    result.pending = this.forwardQueue.pending()
    this.store.save()
    if (result.sent || result.failed) {
      this.logger?.info(`待转发队列补投结束（${reason}）：成功 ${result.sent}，没投出去 ${result.failed}，剩余 ${result.pending}`)
    }
    if (result.failed) {
      // 失败不是致命错误：消息还在队列里，下一轮心跳会再试。
      result.ok = false
    }
    return result
  }

  // ---------------- 出站：DSH → QQ ----------------

  /** 发送串行锁：正常发送和补发排队执行，避免同一时刻两条消息抢 QQ 连接。 */
  async exclusiveSend(fn) {
    const before = this.sendChain
    let allowThrough
    this.sendChain = new Promise((resolve) => { allowThrough = resolve })
    try {
      try { await before } catch { /* 前一个任务失败不影响后面的 */ }
      return await fn()
    } finally {
      allowThrough()
    }
  }

  /** 发送入口的对端解析：按通道规整，不可用时给明确原因（不静默当成空串）。 */
  resolveTarget(qq, channel) {
    const ch = normalizeChannel(channel)
    const peer = normalizePeer(ch, qq)
    const problem = peerProblem(ch, peer)
    if (problem) throw new Error(problem)
    return { channel: ch, peer }
  }

  /**
   * 对外统一发送入口：先尝试直发，失败自动进持久化出站队列。
   * @param {object} [options]
   * @param {string} [options.channel] 通道，缺省 qq
   * @returns {Promise<{ok:boolean, sent:boolean, queued:boolean, id?:string, pending:number, error?:string}>}
   */
  async sendOutbound(qq, segments, { reason = 'outbound', channel = DEFAULT_CHANNEL } = {}) {
    const target = this.resolveTarget(qq, channel)
    const segmentList = Array.isArray(segments) ? segments.filter((x) => x && typeof x === 'object') : []
    if (!segmentList.length) throw new Error('消息段为空')
    // 补发进行中 / 已经有积压：新消息直接排到队尾，保证「旧消息 → 新消息」的先后顺序。
    // 不在这里等补发完成，接口立刻返回 queued；队列恢复后一起按 FIFO 发。
    if (this.flushing) return this.enqueue(target.peer, segmentList, reason, '补发进行中，按顺序入队', { channel: target.channel })
    if (this.outbox.pending() > 0) {
      const result = this.enqueue(target.peer, segmentList, reason, '出站队列有积压，按顺序入队', { channel: target.channel })
      this.laterResend('new-message')
      return result
    }
    return await this.exclusiveSend(() => this.sendOneItem(target.peer, segmentList, {
      reason,
      journal: true,
      channel: target.channel,
    }))
  }

  /** 两个延迟都是 0 时完全不等，也就不需要待发记录（行为与旧版一致）。 */
  pacingEnabled() {
    const config = this.getConfig() || {}
    return (Number(config.outboxPerMessageDelayMs) || 0) > 0 || (Number(config.outboxPerCharDelayMs) || 0) > 0
  }

  /** 排一个后台补发，不阻塞当前调用；没有启动 / 已有补发时什么也不做。 */
  laterResend(reason = 'queued') {
    if (!this.running) return
    setTimeout(() => {
      if (!this.running) return
      void this.flushOutbox(reason).catch((error) => {
        this.logger?.warn(`后台补发出错：${String(error?.message || error)}`)
      })
    }, 0)
  }

  /** 只入队，不尝试发送。 */
  enqueue(qq, segments, reason = '', error = '', { channel = DEFAULT_CHANNEL } = {}) {
    const ch = normalizeChannel(channel)
    const result = this.outbox.enqueue({ channel: ch, qq, segments, reason, error })
    const backlog = this.outbox.pending()
    // 进队列也算「有消息出站」：防失联的「连续没发消息」计数要立刻清零。
    this.emitEvent('outbound-queued', { channel: ch, qq: String(qq), reason, queued: true, pending: backlog })
    return {
      ok: true,
      sent: false,
      queued: true,
      id: result?.item?.id || null,
      deduped: Boolean(result?.deduped),
      persisted: result?.persisted !== false,
      pending: backlog,
    }
  }

  /**
   * 已经在发送锁里：真正尝试发一条，失败时只把还没发出去的段落入队。
   *
   * journal=true 时，在进入节奏等待前先把这条消息写进待发记录（发完立刻删）。
   * 这一步不能省：等待期间消息只在内存，进程被杀就再也没人知道它还欠着。
   * journal 由调用方决定：直发才记；补发队列本身已经持久化，再记会变成两份。
   */
  async sendOneItem(qq, segments, { reason = '', journal = false, journalRecord = null, dueAt = null, channel = DEFAULT_CHANNEL } = {}) {
    const ch = normalizeChannel(channel)
    const label = `${channelLabel(ch)} ${qq}`
    const transport = this.transport.getStatus?.() || this.status.transport || {}
    if (transport.mode === 'stopped') {
      return this.enqueue(qq, segments, reason, '传输层已停止', { channel: ch })
    }
    let record = null
    if (journal && this.pacingEnabled()) {
      record = this.inflight.add({
        channel: ch,
        qq,
        segments,
        dueAt: Number.isFinite(dueAt) ? dueAt : this.pacer.dueAtFor(segments[0]),
        reason,
      })
    }
    try {
      // journalRecord 由调用方持有（例如一轮多段的计划）：这里只帮它推进段进度，不负责删。
      await this.dispatch(qq, segments, { journalRecord: record || journalRecord, dueAt, channel: ch })
    } catch (error) {
      const str = String(error?.message || error)
      this.store.noteError(`发 QQ 失败：${str}`)
      // 一组里可能有多个段：失败前已经送达的段不再入队，避免补发时重发。
      const done = Number.isInteger(error?.sentSegments) ? Math.min(error.sentSegments, segments.length) : 0
      const remaining = done > 0 ? segments.slice(done) : segments
      const digest = messageDigest(remaining)
      let enqueueResult
      try {
        enqueueResult = this.enqueue(qq, remaining, reason, str, { channel: ch })
      } catch (enqueueError) {
        // 入队也失败：保留待发记录，下次启动还能再试；只有换进程才会丢。
        this.logger?.error(`发 ${label} 失败（${str}），写进持久化队列也失败：${String(enqueueError?.message || enqueueError)}`)
        throw new Error(`发送失败：${str}；入队失败：${String(enqueueError?.message || enqueueError)}`)
      }
      // 已经转进 Outbox：立刻删待发记录，避免同一份内容在两边各留一条。
      if (record) this.inflight.remove(record.id)
      this.store.recordEvent({
        direction: 'out',
        channel: ch,
        qq,
        ok: false,
        text: digest,
        error: `已入队：${str}`.slice(0, 200),
      })
      this.logger?.warn(`发送失败，已入队剩余 ${remaining.length}/${segments.length} 段（id=${enqueueResult.id}，积压 ${enqueueResult.pending} 条）：${label} ${messageDigest(remaining, 80)}｜${str}`)
      this.store.save()
      return { ...enqueueResult, error: str }
    }

    // 真正发出去之后再删；崩溃恰好落在这两步之间时，重启会重发这一条（至少一次投递）。
    if (record) this.inflight.remove(record.id)
    this.store.recordEvent({ direction: 'out', channel: ch, qq, ok: true, text: messageDigest(segments) })
    this.noteStickerUse(segments)
    this.logger?.info(`已发 ${label}：${messageDigest(segments, 90)}`)
    this.store.save()
    const sendResult = { ok: true, sent: true, queued: false, pending: this.outbox.pending() }
    this.emitEvent('sent', {
      channel: ch,
      qq: String(qq),
      sent: true,
      queued: false,
      reason,
      summary: messageDigest(segments, 90),
      pending: sendResult.pending,
    })
    return sendResult
  }

  /**
   * 把内部消息段变成 OneBot 请求；语音只接受已有文件，不在桥里合成。
   *
   * 每个段（= QQ 上的一个气泡）发出前与「上一条真正发出的时刻」比一次：间隔够了立刻发，
   * 不够只补等剩下的。正常回复、补发、语音、图片都走这里，所以节奏一致；
   * 等待在发送串行锁里发生，顺序不变。
   *
   * journalRecord 存在时，每次等待前把记录收敛成「从当前段开始还没发的段」：
   * 这样崩溃后只补发没发出去的部分，不会把前面已经送达的气泡重发一遍。
   * dueAt 只给重启回放用：等到这个绝对时间点，而不是再等一整段。
   */
  async dispatch(qq, segments, { journalRecord = null, dueAt = null, channel = DEFAULT_CHANNEL } = {}) {
    const ch = normalizeChannel(channel)
    const list = Array.isArray(segments) ? segments : []
    let handled = 0
    try {
      for (let i = 0; i < list.length; i++) {
        const segment = list[i]
        if (journalRecord) {
          this.inflight.update(journalRecord.id, {
            segments: list.slice(i),
            dueAt: this.pacer.dueAtFor(segment),
          })
        }
        if (i === 0 && Number.isFinite(dueAt)) await this.pacer.waitUntil(dueAt)
        else await this.pacer.wait(segment)
        const kind = String(segment?.type || '')
        const d = segment?.data || {}
        let delivered = false
        if (kind === 'text') {
          const bodyText = String(d.text || '')
          // 空文本段不占气泡，但仍算「处理过」，失败时不需要再补。
          if (bodyText.trim()) {
            await this.transport.sendMessage(qq, [{ type: 'text', data: { text: bodyText } }], { channel: ch })
            delivered = true
          }
        } else if (kind === 'image') {
          const imageSegment = await this.imageSegment(d.path || d.url || d.file)
          await this.transport.sendMessage(qq, [imageSegment], { channel: ch })
          delivered = true
        } else if (kind === 'record' || kind === 'record_file') {
          const path = String(d.path || d.file || '').trim()
          await this.sendRecordWithRetry(qq, path, '本地语音', ch)
          delivered = true
        } else if (kind === 'file') {
          await this.sendFile(qq, d.path || d.file, d.name, ch)
          delivered = true
        } else {
          // 未知类型按 OneBot 原样透传，兼容以后新增的段类型。
          await this.transport.sendMessage(qq, [segment], { channel: ch })
          delivered = true
        }
        // 间隔从「上一条真正发出」算起，所以记在发送成功之后；空文本段什么都没发，不刷新。
        if (delivered) this.pacer.markSent()
        handled += 1
      }
    } catch (error) {
      // 记下已经发出去的段数：调用方据此只入队剩余部分，避免已经到达 QQ 的气泡重发。
      // 记不上（错误对象被冻结等）就退回「整条入队」，行为与旧版一致。
      try {
        if (error && typeof error === 'object') error.sentSegments = handled
      } catch { /* 忽略：调用方会按 0 段处理 */ }
      throw error
    }
  }

  /**
   * 补发积压。默认只发「到点」的条目；force=true（启动/恢复/手动）忽略退避。
   * 失败一条就停，保持 FIFO，下一轮心跳再试。
   */
  flushOutbox(reason = 'heartbeat', { force = false } = {}) {
    if (this.flushPromise) return this.flushPromise
    if (!this.running) return Promise.resolve({ ok: false, error: '桥未启动', sent: 0, failed: 0, dropped: 0, pending: this.outbox.pending() })
    this.flushPromise = this._flushOutbox(reason, force).finally(() => {
      this.flushPromise = null
    })
    return this.flushPromise
  }

  async _flushOutbox(reason, force) {
    this.flushing = true
    const result = { ok: true, reason, sent: 0, failed: 0, dropped: 0, pending: 0 }
    try {
      while (this.running) {
        result.dropped += this.outbox.expire()
        const item = this.outbox.next({ force })
        if (!item) break
        // 旧条目没有 channel，按 qq 读；对端原串直接交给传输层，不带前缀。
        const channel = normalizeChannel(item.channel)
        const itemLabel = `${channelLabel(channel)} ${item.qq}`

        const bad = this.unrecoverableReason(item)
        if (bad) {
          result.dropped += 1
          this.outbox.drop(item.id, bad)
          this.store.noteError(bad)
          this.store.recordEvent({ direction: 'out', channel, qq: item.qq, ok: false, text: messageDigest(item.segments), error: `丢弃：${bad}`.slice(0, 200) })
          this.logger?.error(`出站消息无法补发，已丢弃：${itemLabel} id=${item.id}｜${bad}`)
          continue
        }

        try {
          // 每条单独拿锁：补发失败时立刻把锁还给正常发送。
          await this.exclusiveSend(() => this.dispatch(item.qq, item.segments, { channel }))
        } catch (error) {
          const str = String(error?.message || error)
          result.failed += 1
          const count = this.outbox.markFailed(item.id, str)
          this.store.noteError(`补发失败：${str}`)
          this.store.recordEvent({ direction: 'out', channel, qq: item.qq, ok: false, text: messageDigest(item.segments), error: `补发失败：${str}`.slice(0, 200) })
          this.logger?.warn(`补发失败（${reason}）：${itemLabel} ${messageDigest(item.segments, 60)}｜${str}`)
          if (count.dropped) {
            result.dropped += 1
            // 这条已经放弃，继续补下一条（顺序仍然是从旧到新）。
            continue
          }
          // 保序：这一条没发出去，后面的不插队；等下一轮心跳。
          break
        }

        const prev = this.outbox.markSent(item.id)
        if (!prev) continue
        result.sent += 1
        this.noteStickerUse(item.segments)
        this.emitEvent('sent', {
          channel,
          qq: String(item.qq),
          sent: true,
          queued: false,
          flushed: true,
          reason,
          summary: messageDigest(item.segments, 90),
          pending: this.outbox.pending(),
        })
        const backlog = this.outbox.pending()
        const delay = Math.max(0, Math.round((Date.now() - item.createdAt) / 1000))
        this.logger?.info(`补发成功（积压 ${backlog} 条，延迟 ${delay} 秒）：${itemLabel} ${messageDigest(item.segments, 70)}`)
        this.store.recordEvent({ direction: 'out', channel, qq: item.qq, ok: true, text: `[补发] ${messageDigest(item.segments)}` })
      }
    } finally {
      result.pending = this.outbox.pending()
      this.flushing = false
      this.store.save()
      if (result.sent || result.failed || result.dropped) {
        this.logger?.info(`出站补发结束（${reason}）：成功 ${result.sent}，失败 ${result.failed}，丢弃 ${result.dropped}，剩余 ${result.pending}`)
      }
      this.emitEvent('outbox-flushed', {
        reason,
        sent: result.sent,
        failed: result.failed,
        dropped: result.dropped,
        pending: result.pending,
      })
    }
    return result
  }

  /** 补发前能直接判死的条目（例如音频文件已经被删），不再白白重试 20 次。 */
  unrecoverableReason(item) {
    for (const segment of item?.segments || []) {
      const kind = String(segment?.type || '')
      const d = segment?.data || {}
      const path = String(d.path || d.file || '').trim()
      if (kind === 'record_text') {
        // 旧版本入队的「合成语音」条目：当时没有保存 wavPath，无法直接补发，直接判死并给明确原因。
        return '旧的 [语音]文本[/语音] 队列条目没有保存音频，不再补发；请重新发送 [语音]文本[/语音]'
      } else if (kind === 'record' || kind === 'record_file') {
        if (!path) return '语音文件路径为空'
        if (isPlaceholderPath(path)) return placeholderPathHint('语音', path)
        if (!/^https?:\/\//i.test(path) && !existsSync(path)) return `语音文件不存在：${path}`
      } else if (kind === 'image') {
        if (path && isPlaceholderPath(path)) return placeholderPathHint('图片', path)
        if (path && !/^https?:\/\//i.test(path) && !existsSync(path)) return `图片文件不存在：${path}`
      } else if (kind === 'file') {
        if (!path) return '文件路径为空'
        if (isPlaceholderPath(path)) return placeholderPathHint('', path)
        if (!existsSync(path)) return `文件不存在：${path}`
      }
    }
    return ''
  }

  outboxState() {
    return this.outbox.status()
  }

  listOutbox({ limit = 50 } = {}) {
    return { ...this.outbox.status(), items: this.outbox.list({ limit }) }
  }

  dropOutbox(id) {
    const item = this.outbox.drop(id, '接口手动丢弃')
    return { deleted: Boolean(item), id: String(id || ''), ...this.outbox.status() }
  }

  clearOutbox() {
    const itemNumber = this.outbox.clear({ reason: '接口手动清空' })
    return { cleared: itemNumber, ...this.outbox.status() }
  }

  /**
   * 启动/恢复时回放重启前「正在等节奏、还没发出去」的记录。
   * 与 flushOutbox 一样串行执行；回放先于补发，旧的待发消息不会被新消息插队。
   */
  replayInflight(reason = 'startup') {
    if (this.replayPromise) return this.replayPromise
    if (!this.running) {
      return Promise.resolve({ ok: false, error: '桥未启动', reason, sent: 0, queued: 0, failed: 0, expired: 0, pending: this.inflight.pending() })
    }
    // 整轮回放只拿一次发送锁：回放期间新消息排在后面，旧记录不会和新消息交错。
    this.replayPromise = this.exclusiveSend(() => this._replayInflight(reason)).finally(() => {
      this.replayPromise = null
    })
    return this.replayPromise
  }

  async _replayInflight(reason) {
    const result = { ok: true, reason, sent: 0, queued: 0, failed: 0, expired: 0, pending: 0 }
    try {
      result.expired += this.inflight.expire()
      for (const item of this.inflight.list({ limit: 1000 })) {
        if (!this.running) break
        try {
          // tokens = 一轮还没解析的 token；segments = 已经解析好的单条消息。
          // 最外层已经拿了发送锁，这里用 locked 版本，避免嵌套等待同一条链。
          const one = item.tokens
            ? await this.replayTurnPlan(item, { locked: true })
            : await this.replayMessage(item, { locked: true })
          result.sent += Number(one?.sent) || 0
          result.queued += Number(one?.queued) || 0
        } catch (error) {
          result.ok = false
          result.failed += 1
          const str = String(error?.message || error)
          this.store.noteError(`回放待发消息失败：${str}`)
          this.logger?.error(`回放待发消息失败（${reason}）：${channelLabel(item.channel)} ${item.qq}｜${str}`)
          // 保序：这一条没处理完，后面的不插队；记录留在文件里，下次启动再试。
          break
        }
      }
    } finally {
      result.pending = this.inflight.pending()
      this.store.save()
      if (result.sent || result.queued || result.failed || result.expired) {
        this.logger?.info(`待发消息回放结束（${reason}）：成功 ${result.sent}，转入补发队列 ${result.queued}，失败 ${result.failed}，过期 ${result.expired}，剩余 ${result.pending}`)
      }
    }
    return result
  }

  /** 回放一条已经解析好的消息：发送失败仍走 sendOneItem 的入队逻辑，然后删待发记录。 */
  async replayMessage(item, { locked = false } = {}) {
    const run = async () => {
      if (!this.running) return { ok: false, sent: false, queued: false }
      const channel = normalizeChannel(item.channel)
      // 出站队列里已有更早的积压：这条也排到队尾，不能插到旧消息前面。
      if (this.outbox.pending() > 0) {
        const queued = this.enqueue(item.qq, item.segments, '重启回放', '已有积压，按顺序入队', { channel })
        this.inflight.remove(item.id)
        return { ...queued, sent: false }
      }
      // journalRecord 让 dispatch 每发一段就把记录收敛到剩余段：回放中途再崩也只补剩下的。
      const result = await this.sendOneItem(item.qq, item.segments, {
        reason: '重启补发',
        dueAt: item.dueAt,
        journalRecord: item,
        channel,
      })
      this.inflight.remove(item.id)
      return result
    }
    return locked ? await run() : await this.exclusiveSend(run)
  }

  /**
   * 回放一轮还没解析的 token：按原顺序逐个解析、发送；每完成一个就把待发记录缩到剩余 token。
   * 记录里可能还带着「当前 token 已经解析好、但还没发完的段」：先补这些段，再继续后面的 token。
   * 解析仍在发送前一刻发生，语音合成等副作用与正常发送一致。
   */
  async replayTurnPlan(item, { locked = false } = {}) {
    const run = async () => {
      const channel = normalizeChannel(item.channel)
      const tokens = Array.isArray(item.tokens) ? item.tokens.slice() : []
      const leading = Array.isArray(item.segments) ? item.segments.slice() : []
      const problems = { missingSticker: [], voiceProblem: [], voiceErrorCode: '' }
      let backlogged = this.outbox.pending() > 0
      let sent = 0
      let queued = 0

      // 先补当前消息还没发出去的段（上次发到一半就退出了）。
      if (leading.length) {
        if (backlogged) {
          this.enqueue(item.qq, leading, '重启回放', '已有积压，按顺序入队', { channel })
          queued += 1
        } else {
          const result = await this.sendOneItem(item.qq, leading, {
            reason: '重启补发',
            dueAt: item.dueAt,
            journalRecord: item,
            channel,
          })
          if (result?.queued) {
            backlogged = true
            queued += 1
          } else {
            sent += 1
          }
        }
        if (!tokens.length) {
          this.inflight.remove(item.id)
          if (backlogged) this.laterResend('inflight-backlog')
          return { ok: true, sent, queued }
        }
        // 当前消息已经交给发送/入队：记录只剩后半轮 token；崩溃在这两步之间会重发最后一段。
        this.inflight.update(item.id, { segments: [], tokens, dueAt: 0 })
      }

      for (let i = 0; i < tokens.length; i++) {
        if (!this.running) break
        const token = tokens[i]
        let segmentList = []
        try {
          segmentList = await this.prepareOutboundToken(token, problems, { qq: item.qq })
        } catch (error) {
          this.logger?.warn(`回放待发消息时解析失败（${token?.type || '未知'}）：${String(error?.message || error)}`)
        }
        if (segmentList.length) {
          if (backlogged) {
            this.enqueue(item.qq, segmentList, `restart:${token.type}`, '重启回放：已有积压，按顺序入队', { channel })
            queued += 1
          } else {
            // 只有记录里的第一条消息按 dueAt 补等剩余时间；后面没有记录，按正常节奏等。
            if (!leading.length && i === 0) {
              this.inflight.update(item.id, {
                segments: segmentList,
                tokens: tokens.slice(i + 1),
                dueAt: item.dueAt,
              })
            } else {
              this.inflight.update(item.id, {
                segments: segmentList,
                tokens: tokens.slice(i + 1),
                dueAt: this.pacer.dueAtFor(segmentList[0]),
              })
            }
            const result = await this.sendOneItem(item.qq, segmentList, {
              reason: `restart:${token.type}`,
              dueAt: !leading.length && i === 0 ? item.dueAt : null,
              journalRecord: item,
              channel,
            })
            if (result?.queued) {
              backlogged = true
              queued += 1
            } else {
              sent += 1
            }
          }
        }
        // 发完/跳过后再清掉当前段、缩小记录；崩溃落在这两步之间时这一条会重发（至少一次投递）。
        if (i + 1 < tokens.length) {
          this.inflight.update(item.id, { segments: [], tokens: tokens.slice(i + 1), dueAt: 0 })
        } else {
          this.inflight.remove(item.id)
        }
      }
      if (problems.missingSticker.length) {
        this.store.noteError(`回放时找不到表情：${[...new Set(problems.missingSticker)].join('、')}`)
        this.logger?.warn(`回放待发消息时找不到表情：${[...new Set(problems.missingSticker)].join('、')}`)
      }
      if (problems.voiceProblem.length) {
        this.store.noteError(problems.voiceProblem[0])
        this.logger?.warn(`回放待发消息时语音没发出去：${problems.voiceProblem[0]}`)
      }
      if (backlogged) this.laterResend('inflight-backlog')
      return { ok: true, sent, queued }
    }
    return locked ? await run() : await this.exclusiveSend(run)
  }

  /**
   * DSH 会话事件：按顺序累积一轮里每个模型步的正文，turn/end 完成后发到 QQ。
   *
   * 一轮里每个模型步（包括工具调用前的步骤）提交一条 assistant/message，
   * 只记最后一条会丢掉中途说的话，所以这里逐步累积、整轮结束时统一解析。
   */
  onSessionEvent(session, event) {
    if (!this.running || !event) return
    const key = sessionKey(session?.id || session?.sessionId)
    if (!this.bySession.has(key)) return
    if (event.type === 'assistant/message') {
      const d = event.data || {}
      const previous = this.currentTurn.get(key)
      const sameTurn = Boolean(previous && previous.turn === d.turn)
      if (d.interrupted) {
        // 被取消的回合会补发一条 interrupted 的「已生成前缀」，内容可能只写了一半；
        // 桥只投递完整回合，所以整轮已累积的内容一起丢弃，不把半段话发出去。
        if (sameTurn) {
          previous.interrupted = true
          previous.segments = []
          previous.images = []
        } else {
          this.currentTurn.set(key, {
            turn: d.turn,
            segments: [],
            images: [],
            seen: new Set(),
            imageKeys: new Set(),
            interrupted: true,
          })
        }
        return
      }
      let turn = previous
      if (!sameTurn) {
        turn = { turn: d.turn, segments: [], images: [], seen: new Set(), imageKeys: new Set(), interrupted: false }
        this.currentTurn.set(key, turn)
      }
      const str = this.extractAssistantText(d.message)
      const image = this.extractAssistantImages(d.message)
      // 同一步被重复投递时只算一次，否则同一段正文会被发两遍。
      const stepKey = assistantStepKey(d, str, image)
      if (turn.seen.has(stepKey)) return
      turn.seen.add(stepKey)
      if (str) turn.segments.push(str)
      for (const block of image) {
        // 图片是内容寻址的：同一张图出现在多个模型步时 attachmentId 相同，只发一次。
        const attachmentId = String(block?.attachment?.attachmentId || '')
        if (attachmentId && turn.imageKeys.has(attachmentId)) continue
        if (attachmentId) turn.imageKeys.add(attachmentId)
        turn.images.push(block)
      }
      return
    }
    if (event.type === 'turn/end') {
      const d = event.data || {}
      const finish = Boolean(d.reason && d.reason.kind === 'completed')
      const thisTurn = this.currentTurn.get(key)
      this.currentTurn.delete(key)
      if (!finish || !thisTurn || thisTurn.turn !== d.turn) return
      if (thisTurn.interrupted) return
      const mark = `${key}:${d.turn}`
      if (this.sentTurn.has(mark)) return
      this.sentTurn.add(mark)
      if (this.sentTurn.size > 400) this.sentTurn.clear()
      if (thisTurn.segments.length || thisTurn.images.length) {
        void this.deliverAssistantTurn(key, thisTurn.segments, thisTurn.images)
      }
    }
  }

  extractAssistantText(message) {
    if (!message || !Array.isArray(message.content)) return ''
    return message.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
  }

  extractAssistantImages(message) {
    if (!message || !Array.isArray(message.content)) return []
    return message.content.filter((b) => b && b.type === 'image' && b.attachment).slice(0, 8)
  }

  /**
   * @param {string|string[]} text 一轮里各模型步的正文，按产生顺序。
   *   每步单独解析：某步只写了 [QQ] 没写 [/QQ] 时，解析规则会把该步之后的文字
   *   全算进块里；先拼接再解析就会把下一步的内部文字误发出去。
   *   每步里的多个 [QQ] 块也各自独立：一块 = 一条（组）QQ 消息，块与块不合并文字。
   */
  async deliverAssistantTurn(sessionId, text, imageBlocks = []) {
    const binding = this.bySession.get(sessionKey(sessionId))
    if (!binding) return { ok: false, error: '这间会话没有绑定消息渠道' }
    const { channel } = this.bindingTarget(binding)
    const label = `${channelLabel(channel)} ${binding.qq}`
    const config = this.getConfig()
    const segments = (Array.isArray(text) ? text : [text])
      .map((item) => String(item == null ? '' : item))
      .filter((item) => item.trim())
    const parsed = segments.map((item) => extractOutboundBlocks(item, config.onlyInsideMarkers))
    let send = parsed.some((item) => item.send)
    const qqText = parsed
      .filter((item) => item.send)
      .map((item) => item.qqText)
      .filter(Boolean)
      .join('\n')
    let reason = [...new Set(parsed.map((item) => item.reason).filter(Boolean))].join('；')
    // 只发了图片附件、没有正文时，也允许把图片发出去（图片不是 [QQ] 文本块的一部分）。
    if (!send && Array.isArray(imageBlocks) && imageBlocks.length) {
      send = true
      reason = '只有图片附件'
    }
    if (!send) {
      this.logger?.debug(`会话 ${shorten(sessionId, 12)} 这轮没有可发的消息块内容：${reason}`)
      return { ok: false, error: reason, skipped: true }
    }
    this.logger?.info(`DSH → ${label}：${shorten(qqText, 90)}${reason ? `（${reason}）` : ''}`)

    // 一个块 = 一组消息：块内 token 按出现顺序逐条发，块与块之间互不合并。
    const groups = parsed.flatMap((item) => item.blocks.map((block) => block.tokens))
    // 图片附件不属于任何 QQ 块：各自单独成组，追加在最后（跨步去重已在累积阶段做过）。
    for (const block of imageBlocks) {
      try {
        const p = await this.delivery.attachmentPath(block)
        if (p) groups.push([{ type: 'image', path: p }])
      } catch (error) {
        this.logger?.warn(`取 assistant 图片路径失败：${String(error?.message || error)}`)
      }
    }

    // [语音]文字[/语音]：本地 AI 可用就合成后当语音条发；不可用只提示一句，不影响其它内容。
    // problems 收集「整轮统一报的问题」，与单条发送失败分开：找不到表情 / 语音合成失败只跳过该 token。
    const problems = { missingSticker: [], voiceProblem: [], voiceErrorCode: '' }
    let sent = false

    // 整轮拿一把锁：这一轮的多段消息不会被补发插队。
    await this.exclusiveSend(async () => {
      // 队列里已经有积压时，这一轮也按顺序入队，避免新回复插到旧积压前面。
      let backlogged = this.outbox.pending() > 0
      const tokens = groups.flat()
      // 节奏等待期间消息只在内存：先把「这一轮还没发的 token」落一条待发记录，
      // 每发完/跳过一个就缩到后面还没发的部分。两个延迟都是 0 时不写，行为与旧版完全一致。
      let plan = null
      if (!backlogged && tokens.length && this.pacingEnabled()) {
        plan = this.inflight.add({ channel, qq: binding.qq, tokens, dueAt: 0, reason: 'turn' })
      }
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        let segmentList = []
        try {
          try {
            segmentList = await this.prepareOutboundToken(token, problems, { qq: binding.qq, sessionId })
          } catch (error) {
            this.logger?.warn(`准备出站内容失败（${token?.type || '未知'}）：${String(error?.message || error)}`)
          }
          if (!segmentList.length) continue
          if (plan) {
            // 当前 token 的段与后半轮 token 一起记：重启后先补当前消息没发的段，再继续后面的 token。
            this.inflight.update(plan.id, {
              segments: segmentList,
              tokens: tokens.slice(i + 1),
              dueAt: this.pacer.dueAtFor(segmentList[0]),
            })
          }
          // 同一轮里前面已经失败入队：后面的也按顺序入队，避免后发先至。
          const result = backlogged
            ? this.enqueue(binding.qq, segmentList, `turn:${token.type}`, '前一段已积压，按顺序入队', { channel })
            : await this.sendOneItem(binding.qq, segmentList, { reason: `turn:${token.type}`, journalRecord: plan, channel })
          if (result?.queued) backlogged = true
          if (!result?.skipped) sent = true
        } catch (error) {
          const str = String(error?.message || error)
          this.logger?.error(`发 ${label} 失败（${token.type}）：${str}`)
          this.store.noteError(str)
          this.store.recordEvent({ direction: 'out', channel, qq: binding.qq, ok: false, text: messageDigest(segmentList), error: str })
          if (token.type === 'tts' || token.type === 'ttsMoved') {
            if (!problems.voiceProblem.length) {
              problems.voiceProblem.push('本地 AI 已经合成好了，但语音没发出去，稍后再试。')
              problems.voiceErrorCode = 'tts_send_failed'
            }
          }
          if (token.type === 'voiceFile') {
            await this.reportVoiceError(binding.session, str, channel)
          }
        } finally {
          // 发完/跳过后再清掉当前段、缩小到后半轮 token；
          // 崩溃落在这两步之间时当前消息会重发（至少一次投递）。
          if (plan) {
            if (i + 1 < tokens.length) {
              this.inflight.update(plan.id, { segments: [], tokens: tokens.slice(i + 1), dueAt: 0 })
            } else {
              this.inflight.remove(plan.id)
              plan = null
            }
          }
        }
      }
      if (backlogged) this.laterResend('turn-backlog')
    })

    // 找不到表情：只记日志/统计，不往会话里塞提示（避免刷屏；调用方看返回值/日志即可）。
    if (problems.missingSticker.length) {
      const nameList = [...new Set(problems.missingSticker)].join('、')
      const str = `找不到表情：${nameList}`
      this.store.noteError(str)
      this.store.recordEvent({ direction: 'out', channel, qq: binding.qq, ok: false, text: str, error: '表情不存在' })
      this.logger?.warn(`${str}（会话 ${shorten(sessionId, 12)}）——可用 [表情:名字]、[表情:#标签] 或 [表情:id]，名字见设置页「表情包」。`)
    }

    // 语音合成失败：同一轮里其它内容照常发；整轮一个可发内容都没有时，才回一句友好提示。
    if (problems.voiceProblem.length) {
      const hint = problems.voiceProblem[0]
      this.store.noteError(hint)
      this.store.recordEvent({
        direction: 'out',
        channel,
        qq: binding.qq,
        ok: false,
        text: groups.flat().filter((t) => t.type === 'tts' || t.type === 'ttsMoved')
          .map((t) => `[语音] ${shorten(t.text, 60)}`).join('；'),
        error: problems.voiceErrorCode || 'tts_unavailable',
      })
      this.logger?.warn(`${hint}（会话 ${shorten(sessionId, 12)}）`)
      await this.reportVoiceError(binding.session, hint, channel)
      this.store.save()
      return {
        ok: sent,
        code: problems.voiceErrorCode || 'tts_unavailable',
        hint: hint,
        tts: false,
        sent: sent,
      }
    }

    this.store.save()
    return { ok: true }
  }

  /**
   * 把一个已解析的 token 变成可发送的消息段；语音合成、表情解析都在这里发生。
   * problems 收集「整轮统一报的问题」（找不到表情、语音不可用），与发送失败分开：
   * 这里失败只跳过这个 token，同轮其它内容照发。回放待发记录时复用同一段逻辑。
   * @returns {Promise<Array<object>>} 空数组 = 这个 token 没有可发内容
   */
  async prepareOutboundToken(token, problems, { qq = '', sessionId = '' } = {}) {
    if (!token || typeof token !== 'object') return []
    const config = this.getConfig()
    if (token.type === 'text') {
      const bodyText = String(token.text || '').trim()
      return bodyText ? [{ type: 'text', data: { text: bodyText } }] : []
    }
    if (token.type === 'image') {
      return token.path ? [{ type: 'image', data: { path: token.path } }] : []
    }
    if (token.type === 'sticker') {
      // 表情名字在发送时才解析：库可以随时增删，指令不用跟着改。
      const middle = this.parseSticker(token.name)
      if (!middle) {
        problems.missingSticker.push(String(token.name || ''))
        return []
      }
      return [{ type: 'image', data: { path: middle.path, stickerId: middle.id } }]
    }
    if (token.type === 'tts' || token.type === 'ttsMoved') {
      const bodyText = String(token.text || '').trim()
      if (!bodyText) return []
      let synthesize = null
      try {
        if (!this.ai) {
          synthesize = { ok: false, code: 'service_not_installed', hint: '本地 AI 插件没装或没启动，暂时发不了语音，其它功能不受影响。' }
        } else {
          synthesize = await this.ai.tts(bodyText, { voice: config.sayVoice, speed: config.saySpeed })
        }
      } catch (error) {
        synthesize = { ok: false, code: 'unknown', hint: `这次没能发语音，稍后再试。${String(error?.message || '')}`.trim() }
      }
      if (!synthesize?.ok) {
        if (!problems.voiceProblem.length) {
          problems.voiceProblem.push(String(synthesize?.hint || '暂时发不了语音，其它功能不受影响。'))
          problems.voiceErrorCode = String(synthesize?.code || 'tts_unavailable')
        }
        return []
      }
      // 长文本会被合成成多段；这里保持顺序，交给派发逐条发送。
      const voices = Array.isArray(synthesize.wavPaths) && synthesize.wavPaths.length
        ? synthesize.wavPaths
        : [synthesize.wavPath]
      return voices.map((path) => ({ type: 'record', data: { path: path } }))
    }
    if (token.type === 'voiceFile') {
      // 格式示例里的 `[语音:路径]` 不是真实文件：不发送、不入队，给出明确原因。
      if (isPlaceholderPath(token.path)) {
        const str = `${placeholderPathHint('语音', token.path)}，未发送`
        this.store.noteError(str)
        this.store.recordEvent({ direction: 'out', qq, ok: false, text: '[语音文件] 占位路径', error: str })
        this.logger?.warn(`${str}${sessionId ? `（会话 ${shorten(sessionId, 12)}）` : ''}`)
        return []
      }
      return [{ type: 'record', data: { path: token.path } }]
    }
    if (token.type === 'file') {
      if (!token.path) return []
      return [{ type: 'file', data: { path: token.path, name: basename(token.path) } }]
    }
    return []
  }

  /** 测试按钮用：发一条纯文字，失败自动入队。 */
  async sendText(qq, text, { channel = DEFAULT_CHANNEL } = {}) {
    const bodyText = String(text || '').trim()
    if (!bodyText) return { ok: true, sent: false, queued: false, pending: this.outbox.pending(), skipped: true }
    return await this.sendOutbound(qq, [{ type: 'text', data: { text: bodyText } }], { reason: 'text', channel })
  }

  /** 解析 [表情:名字]：交给表情库；找不到时记一条 warn，调用方负责报错。 */
  parseSticker(name) {
    if (!this.stickers || typeof this.stickers.resolve !== 'function') return null
    try {
      return this.stickers.resolve(name)
    } catch (error) {
      this.logger?.warn(`表情解析失败：${String(error?.hint || error?.message || error)}`)
      return null
    }
  }

  /** 发送成功后给表情库记一次使用（失败不影响消息本身）。 */
  noteStickerUse(segments) {
    if (!this.stickers || typeof this.stickers.bump !== 'function') return
    for (const segment of Array.isArray(segments) ? segments : []) {
      const id = segment?.data?.stickerId
      if (!id) continue
      try {
        this.stickers.bump(id)
      } catch (error) {
        this.logger?.warn(`表情使用计数失败（忽略）：${String(error?.message || error)}`)
      }
    }
  }

  async imageSegment(pathOrUrl) {
    const value = String(pathOrUrl || '').trim()
    if (!value) throw new Error('图片路径为空')
    if (/^https?:\/\//i.test(value)) return { type: 'image', data: { file: value, url: value } }
    if (!existsSync(value)) throw new Error(`图片不存在：${value}`)
    const max = Number(this.getConfig().maxImageMB) * 1024 * 1024
    const buf = readFileSync(value)
    if (buf.length > max) throw new Error(`图片超过 ${Math.round(max / 1048576)}MB`)
    return { type: 'image', data: { file: `base64://${buf.toString('base64')}` } }
  }

  async sendFile(qq, path, name = '', channel = DEFAULT_CHANNEL) {
    const value = String(path || '').trim()
    if (!value || !existsSync(value)) throw new Error(`文件不存在：${value}`)
    const fileName = String(name || '').trim() || basename(value)
    try {
      await this.transport.sendMessage(qq, [{ type: 'file', data: { file: value.replace(/\\/g, '/'), name: fileName } }], { channel })
    } catch (error) {
      throw new Error(`file 段发送失败（可能 NapCat 不支持或没有权限）：${String(error?.message || error)}`)
    }
  }

  /** 语音发送：本地路径 → file:/// → base64，共 3 次；失败由上层报错。 */
  async sendRecordWithRetry(qq, path, label = '语音', channel = DEFAULT_CHANNEL) {
    const value = String(path || '').trim()
    if (!value || !existsSync(value)) throw new Error(`${label}文件不存在：${value}`)
    const size = readFileSync(value).length
    const max = Number(this.getConfig().maxVoiceMB) * 1024 * 1024
    const candidate = [{ name: '本地路径', value: value.replace(/\\/g, '/') }]
    candidate.push({ name: 'file URL', value: `file:///${value.replace(/\\/g, '/').replace(/^\/+/, '')}` })
    if (size <= max) candidate.push({ name: 'base64', value: `base64://${readFileSync(value).toString('base64')}` })

    let lastError = ''
    for (let i = 0; i < candidate.length; i++) {
      try {
        await this.transport.sendMessage(qq, [{ type: 'record', data: { file: candidate[i].value } }], { channel })
        return { ok: true, way: candidate[i].name }
      } catch (error) {
        lastError = `${candidate[i].name}：${String(error?.message || error)}`
        this.logger?.warn(`语音发送失败（第 ${i + 1}/${candidate.length} 次，${candidate[i].name}）：${lastError}`)
        if (i < candidate.length - 1) await new Promise((r) => setTimeout(r, 500))
      }
    }
    throw new Error(`语音重试 ${candidate.length} 次都失败：${lastError}`)
  }

  async reportVoiceError(sessionId, errorText, channel) {
    const current = Date.now()
    const prevAt = this.voiceErrorTime.get(sessionKey(sessionId)) || 0
    if (current - prevAt < 60000) return
    this.voiceErrorTime.set(sessionKey(sessionId), current)
    try {
      // 没传通道时按这间会话的绑定反查，避免微信会话里的语音错误被标成 qq。
      const ch = channel === undefined
        ? normalizeChannel(this.bySession.get(sessionKey(sessionId))?.channel)
        : normalizeChannel(channel)
      await this.delivery.deliver({
        sessionId,
        text: `（dsh-fish-message）语音发送失败：${shorten(errorText, 200)}`,
        images: [],
        channel: ch,
        meta: { channel: ch, notice: 'voice-error' },
      })
    } catch (error) {
      this.logger?.warn(`语音错误提示也没投进会话：${String(error?.message || error)}`)
    }
  }

  // ---------------- 设置页的测试按钮 ----------------

  async testSend(qq, { channel = DEFAULT_CHANNEL } = {}) {
    // 没给对端时按通道挑第一条启用的绑定：否则「说是发微信、实际发到 QQ」只差一个入参。
    const wanted = normalizeChannel(channel)
    const binding = qq
      ? this.byPeer.get(peerKey(wanted, qq))
      : (this.getConfig().bindings || []).find((b) => b.enabled && normalizeChannel(b.channel) === wanted)
    if (!binding) throw new Error(`没有可用的${channelLabel(wanted)}绑定`)
    const target = this.bindingTarget(binding)
    const plainText = `（dsh-fish-message 测试）这条是插件发的测试消息，收到就说明 DSH → ${channelLabel(target.channel)} 通了。`
    const result = await this.sendText(target.peer, plainText, { channel: target.channel })
    return { ok: true, channel: target.channel, qq: target.peer, text: plainText, sent: result?.sent !== false, queued: Boolean(result?.queued), id: result?.id || null, pending: this.outbox.pending() }
  }

  state() {
    const snapshot = this.store.snapshot()
    return {
      ...this.status,
      running: this.running,
      queueSize: this.queue.size(),
      transport: this.transportSnapshot(),
      watermarks: snapshot.watermarks,
      stats: snapshot.stats,
      recent: snapshot.recent,
      outbox: this.outbox.status(),
      forward: { ...this.forwardQueue.status(), paused: this.pauseMiddle },
      bindings: (this.getConfig().bindings || []).map((b) => ({
        ...b,
        alive: Boolean(this.bySession.get(sessionKey(b.session))),
      })),
    }
  }
}

export { sessionKey }
