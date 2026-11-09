// 桥的核心：收消息 → 去重/排序 → 转文字/图片 → 递进 DSH 会话；
// DSH 会话说完一轮 → 抠 [QQ] 块 → 发回 QQ。
//
// 这个类不直接 import DSH，也不直接连 NapCat：transport / delivery / voice 都是注入的，
// 所以单测和 mock 集成测试可以完全脱离 QQ 和 DSH 跑。

import { existsSync, readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MessageQueue, sortMessages } from './queue.js'
import { extractOutbound } from './format.js'

const 会话键 = (id) => {
  const s = String(id || '').trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

const 秒 = () => Math.floor(Date.now() / 1000)

const 拍短 = (s, n = 80) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

const 同号 = (a, b) => String(a ?? '').replace(/[^\d]/g, '') === String(b ?? '').replace(/[^\d]/g, '')

export class Bridge {
  constructor({
    getConfig,
    transport,
    store,
    logger,
    voice,
    delivery,
    startedAt = Date.now(),
    autoTimers = true,
  }) {
    this.getConfig = getConfig
    this.transport = transport
    this.store = store
    this.logger = logger
    this.voice = voice
    this.delivery = delivery
    this.startedAt = startedAt
    this.autoTimers = autoTimers
    this.running = false
    this.syncing = false
    this.syncAgain = false
    this.historyTimer = null
    this.pollTimer = null
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
    this.处理中 = new Set()
    this.发送过轮 = new Set()
    this.语音报错时间 = new Map()
    this.当前轮 = new Map()
    this.queue = new MessageQueue({
      bufferMs: Number(getConfig().reorderBufferMs) || 0,
      onBatch: (peer, batch) => this.processBatch(peer, batch),
      logger,
    })
    this.rebuildIndexes()
  }

  rebuildIndexes() {
    this.byPeer.clear()
    this.bySession.clear()
    for (const b of this.getConfig().bindings || []) {
      if (!b.enabled) continue
      this.byPeer.set(String(b.qq), b)
      this.bySession.set(会话键(b.session), b)
    }
    this.queue.setBuffer(Number(this.getConfig().reorderBufferMs) || 0)
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
    if (syncNow) {
      setTimeout(() => { void this.sync('startup') }, 300)
    }
    this.logger?.info(`桥已启动：${this.byPeer.size} 个私聊绑定，WS ${this.getConfig().wsEnabled ? '开' : '关'}，轮询 ${this.getConfig().pollIntervalMs}ms`)
  }

  async stop() {
    this.running = false
    this.status.running = false
    clearTimeout(this.historyTimer)
    clearTimeout(this.pollTimer)
    this.historyTimer = null
    this.pollTimer = null
    this.queue.clear()
    try { await this.transport.stop() } catch { /* 停不下来也继续收尾 */ }
    this.logger?.info('桥已停止')
  }

  /** 配置变了以后调用：重建绑定索引、调整队列窗口；连接参数变了由宿主决定是否重启。 */
  updateConfig() {
    this.rebuildIndexes()
  }

  ensureBaselines() {
    let 改 = false
    for (const b of this.getConfig().bindings || []) {
      if (!b.enabled) continue
      if (!this.store.getWatermark(b.qq)) {
        // 第一次跑：从「现在 - 60 秒」开始，避免把几年的历史一口气灌进会话。
        // 如果是从旧桥迁移，宿主已经先搬了旧水位，这里不会覆盖。
        this.store.setWatermark(b.qq, {
          timestamp: Math.floor(this.startedAt / 1000) - 60,
          messageId: '',
        }, false)
        改 = true
        this.logger?.info(`首次建立 ${b.qq} 的水位：从现在开始（不补投陈年历史）`)
      }
    }
    if (改) this.store.save()
  }

  onTransportStatus(status) {
    const 前 = this.status.transport
    this.status.transport = status
    if (status?.connected) {
      this.stopPolling()
      if (!前?.connected) void this.sync('ws-connected')
    } else if (this.running) {
      this.startPolling()
    }
  }

  scheduleHistory() {
    clearTimeout(this.historyTimer)
    if (!this.running || !this.autoTimers) return
    const 间隔 = Math.max(5000, Number(this.getConfig().historyIntervalMs) || 60000)
    this.historyTimer = setTimeout(async () => {
      try { await this.sync('history-timer') } finally { this.scheduleHistory() }
    }, 间隔)
    try { this.historyTimer.unref?.() } catch { /* 忽略 */ }
  }

  startPolling() {
    if (!this.running || !this.autoTimers || this.pollTimer) return
    const 间隔 = Math.max(500, Number(this.getConfig().pollIntervalMs) || 2000)
    const tick = async () => {
      this.pollTimer = null
      if (!this.running) return
      if (this.status.transport?.connected) return
      try { await this.sync('http-poll') } finally {
        if (this.running && !this.status.transport?.connected) this.startPolling()
      }
    }
    this.pollTimer = setTimeout(tick, 间隔)
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
    let 总新增 = 0
    try {
      const 配置 = this.getConfig()
      for (const binding of 配置.bindings || []) {
        if (!binding.enabled) continue
        const qq = String(binding.qq)
        let 列表 = []
        try {
          列表 = await this.transport.fetchHistory(qq, { count: 配置.historyCount })
        } catch (error) {
          const 文 = String(error?.message || error)
          this.status.lastSyncError = 文
          this.logger?.warn(`拉 ${qq} 的历史失败：${文}`)
          continue
        }
        if (!Array.isArray(列表)) continue
        const 水位 = this.store.getWatermark(qq)

        // 历史接口默认只给最近 count 条。若整页都还比水位新，说明离线期间可能超过一页：
        // 用最早一条的 message_id 继续向前翻，最多 10 页（默认 100 条/页 → 1000 条）。
        if (水位?.timestamp && 列表.length >= Number(配置.historyCount || 100)) {
          for (let 页 = 0; 页 < 10; 页++) {
            const 最早 = 列表[0]
            if (!最早 || (Number(最早.time) || 0) <= 水位.timestamp) break
            if (列表.length < Number(配置.historyCount || 100)) break
            let 更早 = []
            try {
              更早 = await this.transport.fetchHistory(qq, {
                count: 配置.historyCount,
                beforeMessageId: 最早.message_id,
              })
            } catch (error) {
              this.logger?.debug(`向前翻页失败（不影响已有页）：${String(error?.message || error)}`)
              break
            }
            const 已有 = new Set(列表.map((m) => String(m.message_id)))
            const 新增 = (Array.isArray(更早) ? 更早 : []).filter((m) => !已有.has(String(m.message_id)))
            if (!新增.length) break
            列表 = [...新增, ...列表]
          }
        }

        const 入站 = 列表
          .filter((m) => this.isInbound(m, qq))
          .sort(sortMessages)

        // 水位之前的消息是「旧桥已经处理过 / 本插件首次安装前」的历史：
        // 静默记掉，不投、也不发「跳过 N 条」摘要，避免刚装好就被旧历史刷一脸。
        if (水位?.timestamp) {
          let 清过 = false
          for (const m of 入站) {
            if ((Number(m.time) || 0) > 0 && (Number(m.time) || 0) < 水位.timestamp) {
              if (!this.store.hasSeen(m.message_id)) 清过 = true
              this.store.markSeen(m.message_id, false)
            }
          }
          if (清过) this.store.save()
        }

        const 未见 = 入站.filter((m) => {
          if (this.store.hasSeen(m.message_id)) return false
          if (this.queue.has(qq, m.message_id)) return false
          if (this.处理中.has(String(m.message_id))) return false
          return true
        })
        if (!未见.length) continue

        const 窗口秒 = Math.max(0, Number(配置.backfillWindowHours) || 0) * 3600
        const 现在 = 秒()
        const 太旧 = []
        const 新的 = []
        for (const m of 未见) {
          const 时间 = Number(m.time) || 0
          if (窗口秒 > 0 && 时间 > 0 && 现在 - 时间 > 窗口秒) 太旧.push(m)
          else 新的.push(m)
        }

        if (太旧.length) {
          const 最早 = Math.min(...太旧.map((m) => Number(m.time) || 现在))
          const 最晚 = Math.max(...太旧.map((m) => Number(m.time) || 0))
          for (const m of 太旧) {
            this.store.markSeen(m.message_id, false)
            this.store.noteSkippedOld()
          }
          const 水位 = this.store.getWatermark(qq)
          this.store.setWatermark(qq, {
            timestamp: Math.max(Number(水位?.timestamp) || 0, 最晚),
            messageId: 太旧[太旧.length - 1]?.message_id,
          }, false)
          this.logger?.warn(`${qq} 有 ${太旧.length} 条离线消息超过补投窗口（${配置.backfillWindowHours} 小时），只发摘要`)
          await this.deliverOfflineSummary(binding, 太旧.length, 最早, 最晚)
        }

        for (const m of 新的) {
          if (this.queue.enqueue(qq, m)) 总新增++
        }
        if (新的.length) await this.queue.flush(qq)
      }
      this.status.queueSize = this.queue.size()
      return { ok: true, added: 总新增, reason }
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

  isInbound(message, qq) {
    if (!message || typeof message !== 'object') return false
    if (message.message_type && message.message_type !== 'private') return false
    if (!同号(message.user_id, qq)) return false
    if (message.self_id && 同号(message.self_id, message.user_id)) return false
    return true
  }

  onTransportEvent(event) {
    if (!this.running || !event || event.post_type !== 'message') return
    if (event.message_type && event.message_type !== 'private') return
    const qq = String(event.user_id ?? '')
    const binding = this.byPeer.get(qq)
    if (!binding) return
    if (!this.isInbound(event, qq)) return
    const 消息 = {
      message_id: event.message_id ?? event.messageId,
      message_seq: event.message_seq ?? event.messageSeq,
      time: Number(event.time) || 秒(),
      user_id: event.user_id,
      sender: event.sender,
      message: event.message,
      raw_message: event.raw_message,
      来源: 'ws',
    }
    if (this.queue.enqueue(qq, 消息)) {
      this.status.lastEventAt = Date.now()
      this.status.queueSize = this.queue.size()
      this.logger?.debug(`WS 收到 ${qq} 的消息 ${消息.message_id}`)
    }
  }

  /** 队列到点后的批处理：按顺序递进 DSH；失败就保留剩余消息，下一轮重试。 */
  async processBatch(peer, batch) {
    const ids = batch.map((m) => String(m?.message_id ?? '')).filter(Boolean)
    for (const id of ids) this.处理中.add(id)
    try {
      return await this._processBatch(peer, batch)
    } finally {
      for (const id of ids) this.处理中.delete(id)
    }
  }

  async _processBatch(peer, batch) {
    const binding = this.byPeer.get(String(peer))
    if (!binding) return
    const 配置 = this.getConfig()
    this.status.queueSize = this.queue.size()
    let 旧条数 = 0
    let 最早 = 0
    let 最晚 = 0

    for (let i = 0; i < batch.length; i++) {
      const m = batch[i]
      if (this.store.hasSeen(m.message_id)) continue
      const 时间 = Number(m.time) || 0
      const 窗口秒 = Math.max(0, Number(配置.backfillWindowHours) || 0) * 3600
      if (窗口秒 > 0 && 时间 > 0 && 秒() - 时间 > 窗口秒) {
        this.store.markSeen(m.message_id, false)
        this.store.noteSkippedOld()
        旧条数++
        最早 = 最早 ? Math.min(最早, 时间) : 时间
        最晚 = Math.max(最晚, 时间)
        continue
      }

      let 内容
      try {
        内容 = await this.buildInbound(binding, m)
      } catch (error) {
        const 文 = String(error?.message || error)
        this.logger?.error(`整理 ${peer} 的消息 ${m.message_id} 失败：${文}`)
        this.store.noteError(文)
        this.requeue(peer, batch.slice(i))
        this.store.save()
        return
      }
      if (!内容.text && !(内容.images || []).length) {
        this.store.markSeen(m.message_id, false)
        this.advanceWatermark(peer, m)
        continue
      }

      const 结果 = await this.delivery.deliver({
        sessionId: binding.session,
        text: 内容.text,
        images: 内容.images,
        meta: {
          qq: String(peer),
          name: binding.name,
          messageId: String(m.message_id),
          time: 时间,
        },
      })
      if (!结果?.ok) {
        const 文 = String(结果?.error || '投递失败')
        this.store.noteError(文)
        this.store.recordEvent({ direction: 'in', qq: peer, ok: false, text: 内容.text, error: 文 })
        this.logger?.warn(`消息 ${m.message_id} 没投进 DSH（${文}），下一轮再试`)
        this.requeue(peer, batch.slice(i))
        this.store.save()
        return
      }

      this.store.markSeen(m.message_id, false)
      this.advanceWatermark(peer, m)
      this.store.noteReceived()
      this.store.noteDelivered()
      this.store.recordEvent({ direction: 'in', qq: peer, ok: true, text: 内容.text })
      this.logger?.info(`QQ ${peer} → DSH：${拍短(内容.text, 90)}`)
    }

    this.store.save()
    this.status.queueSize = this.queue.size()
    if (旧条数) await this.deliverOfflineSummary(binding, 旧条数, 最早, 最晚)
  }

  requeue(peer, messages) {
    for (const m of messages) {
      if (!this.store.hasSeen(m.message_id)) this.queue.enqueue(String(peer), m)
    }
  }

  advanceWatermark(peer, message) {
    const 时间 = Number(message.time) || 秒()
    const 旧 = this.store.getWatermark(peer)
    this.store.setWatermark(peer, {
      timestamp: Math.max(Number(旧?.timestamp) || 0, 时间),
      messageId: message.message_id,
    }, false)
  }

  /** 一条 QQ 消息 → 交给 DSH 的文字 + 图片附件。 */
  async buildInbound(binding, message) {
    const 配置 = this.getConfig()
    const 段们 = Array.isArray(message.message)
      ? message.message
      : [{ type: 'text', data: { text: String(message.raw_message || '') } }]
    const 文们 = []
    const 图们 = []

    for (const 段 of 段们) {
      if (!段 || typeof 段 !== 'object') continue
      const 型 = String(段.type || '')
      const d = 段.data || {}
      if (型 === 'text') {
        文们.push(String(d.text || ''))
        continue
      }
      if (型 === 'image' || 型 === 'mface') {
        const 有图 = String(d.url || d.file || d.path || d.thumb || '')
        if (型 === 'mface' && !有图) {
          文们.push(`[表情：${String(d.summary || d.emoji_id || '大表情').slice(0, 20)}]`)
          continue
        }
        if (图们.length >= 4) {
          文们.push('[图片（超过 4 张，后面的没取）]')
          continue
        }
        try {
          const 图 = await this.voice.fetchImage(段, message.message_id, 图们.length + 1)
          图们.push({
            base64: 图.base64,
            mime: 图.mime,
            name: `qq-${message.message_id || 'x'}-${图们.length + 1}${图.ext}`,
            path: 图.path,
          })
          文们.push('[图片]')
        } catch (error) {
          this.logger?.warn(`下载图片失败：${String(error?.message || error)}`)
          文们.push('[图片（下载失败）]')
        }
        continue
      }
      if (型 === 'record') {
        if (!配置.transcriptionEnabled) {
          文们.push('[语音]')
          continue
        }
        try {
          const 转 = await this.voice.transcribeRecord(段, message.message_id, binding.name)
          if (转?.text) {
            const 声纹 = 转.speakerName ? `｜声纹：${转.speakerName}` : ''
            文们.push(`（语音${声纹}）${转.text}`)
          } else {
            文们.push('[语音（没转写出来）]')
          }
        } catch (error) {
          const 文 = String(error?.message || error)
          this.logger?.warn(`语音转写失败：${文}`)
          this.store.noteError(`语音转写失败：${文}`)
          文们.push(`[语音（转写失败：${拍短(文, 60)}）]`)
        }
        continue
      }
      if (型 === 'face') { 文们.push('[表情]'); continue }
      if (型 === 'at') { 文们.push(`@${String(d.name || d.qq || '')}`); continue }
      if (型 === 'reply') { 文们.push('[引用了一条消息]'); continue }
      if (型 === 'file') { 文们.push(`[文件：${String(d.name || d.file || '未知')}]`); continue }
      if (型 === 'json' || 型 === 'xml') { 文们.push('[分享卡片]'); continue }
      if (型 === 'video') { 文们.push('[视频]'); continue }
      if (型 === 'forward') { 文们.push('[合并转发的聊天记录]'); continue }
      文们.push(`[${型 || '未知消息'}]`)
    }

    let 文字 = 文们.join('\n').trim()
    if (图们.length) {
      const 路径们 = 图们.map((x) => x.path).filter(Boolean)
      const 说明 = `（收到 ${图们.length} 张图片${路径们.length ? `，已存到 ${路径们.join('；')}` : ''}）`
      文字 = 文字 ? `${文字}\n${说明}` : 说明
    }
    return { text: 文字, images: 图们 }
  }

  async deliverOfflineSummary(binding, count, 最早, 最晚) {
    const 配置 = this.getConfig()
    const 格式 = (t) => {
      if (!t) return ''
      try {
        return new Date(Number(t) * 1000).toLocaleString('zh-CN', { hour12: false })
      } catch {
        return ''
      }
    }
    const 文字 = `（离线补投摘要）机器人离线期间有 ${count} 条消息，超过 ${配置.backfillWindowHours} 小时补投窗口，已跳过。`
      + (最早 ? `\n最早：${格式(最早)}；最近：${格式(最晚)}` : '')
    const 结果 = await this.delivery.deliver({
      sessionId: binding.session,
      text: 文字,
      images: [],
      meta: { qq: binding.qq, name: binding.name, offlineSummary: true },
    })
    if (!结果?.ok) this.logger?.warn(`离线摘要没投进 DSH：${结果?.error || '未知原因'}`)
  }

  // ---------------- 出站：DSH → QQ ----------------

  /** DSH 会话事件：记一轮的 assistant 正文，turn/end 完成后发到 QQ。 */
  onSessionEvent(session, event) {
    if (!this.running || !event) return
    const 键 = 会话键(session?.id || session?.sessionId)
    if (!this.bySession.has(键)) return
    if (event.type === 'assistant/message') {
      const d = event.data || {}
      if (d.interrupted) {
        this.当前轮.set(键, { turn: d.turn, text: '', images: [] })
        return
      }
      const 文 = this.extractAssistantText(d.message)
      const 图 = this.extractAssistantImages(d.message)
      const 上一 = this.当前轮.get(键)
      if (上一 && 上一.turn === d.turn) {
        if (文) 上一.text = 文
        if (图.length) 上一.images = 图
      } else {
        this.当前轮.set(键, { turn: d.turn, text: 文, images: 图 })
      }
      return
    }
    if (event.type === 'turn/end') {
      const d = event.data || {}
      const 完成 = Boolean(d.reason && d.reason.kind === 'completed')
      const 本轮 = this.当前轮.get(键)
      this.当前轮.delete(键)
      if (!完成 || !本轮 || 本轮.turn !== d.turn) return
      const 标 = `${键}:${d.turn}`
      if (this.发送过轮.has(标)) return
      this.发送过轮.add(标)
      if (this.发送过轮.size > 400) this.发送过轮.clear()
      if (本轮.text || (本轮.images || []).length) {
        void this.deliverAssistantTurn(键, 本轮.text, 本轮.images)
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

  async deliverAssistantTurn(sessionId, text, imageBlocks = []) {
    const binding = this.bySession.get(会话键(sessionId))
    if (!binding) return { ok: false, error: '这间会话没有绑定 QQ' }
    const 配置 = this.getConfig()
    let 解析 = extractOutbound(text, 配置.onlyInsideMarkers)
    // 只发了图片附件、没有正文时，也允许把图片发出去（图片不是 [QQ] 文本块的一部分）。
    if (!解析.send && Array.isArray(imageBlocks) && imageBlocks.length) {
      解析 = { send: true, reason: '只有图片附件', qqText: '', tokens: [] }
    }
    if (!解析.send) {
      this.logger?.debug(`会话 ${拍短(sessionId, 12)} 这轮没有可发的 QQ 内容：${解析.reason}`)
      return { ok: false, error: 解析.reason, skipped: true }
    }
    this.logger?.info(`DSH → QQ ${binding.qq}：${拍短(解析.qqText, 90)}${解析.reason ? `（${解析.reason}）` : ''}`)

    const tokens = [...解析.tokens]
    for (const 块 of imageBlocks) {
      try {
        const p = await this.delivery.attachmentPath(块)
        if (p) tokens.push({ type: 'image', path: p })
      } catch (error) {
        this.logger?.warn(`取 assistant 图片路径失败：${String(error?.message || error)}`)
      }
    }

    for (const token of tokens) {
      try {
        if (token.type === 'text') {
          await this.sendText(binding.qq, token.text)
        } else if (token.type === 'image') {
          const 段 = await this.imageSegment(token.path)
          await this.transport.sendMessage(binding.qq, [段])
          this.store.recordEvent({ direction: 'out', qq: binding.qq, ok: true, text: `[图片] ${basename(token.path)}` })
          this.logger?.info(`已发图片到 QQ ${binding.qq}`)
        } else if (token.type === 'voice') {
          const 路径 = await this.voice.synthesize(token.text)
          await this.sendRecordWithRetry(binding.qq, 路径, 'TTS 语音')
          this.store.recordEvent({ direction: 'out', qq: binding.qq, ok: true, text: `[语音] ${token.text}` })
          this.logger?.info(`已发语音到 QQ ${binding.qq}：${拍短(token.text, 40)}`)
        } else if (token.type === 'voiceFile') {
          await this.sendRecordWithRetry(binding.qq, token.path, '本地语音')
          this.store.recordEvent({ direction: 'out', qq: binding.qq, ok: true, text: `[语音] ${basename(token.path)}` })
          this.logger?.info(`已发本地语音到 QQ ${binding.qq}：${basename(token.path)}`)
        } else if (token.type === 'file') {
          await this.sendFile(binding.qq, token.path)
          this.store.recordEvent({ direction: 'out', qq: binding.qq, ok: true, text: `[文件] ${basename(token.path)}` })
          this.logger?.info(`已发文件到 QQ ${binding.qq}：${basename(token.path)}`)
        }
      } catch (error) {
        const 文 = String(error?.message || error)
        this.logger?.error(`发 QQ 失败（${token.type}）：${文}`)
        this.store.noteError(文)
        this.store.recordEvent({ direction: 'out', qq: binding.qq, ok: false, text: token.text || token.path, error: 文 })
        if (token.type === 'voice' || token.type === 'voiceFile') {
          await this.reportVoiceError(binding.session, 文)
        }
      }
    }
    this.store.save()
    return { ok: true }
  }

  async sendText(qq, text) {
    const 正文 = String(text || '').trim()
    if (!正文) return
    await this.transport.sendMessage(qq, [{ type: 'text', data: { text: 正文 } }])
    this.store.recordEvent({ direction: 'out', qq, ok: true, text: 正文 })
    this.logger?.info(`已发文字到 QQ ${qq}：${拍短(正文, 70)}`)
    this.store.save()
  }

  async imageSegment(pathOrUrl) {
    const 值 = String(pathOrUrl || '').trim()
    if (!值) throw new Error('图片路径为空')
    if (/^https?:\/\//i.test(值)) return { type: 'image', data: { file: 值, url: 值 } }
    if (!existsSync(值)) throw new Error(`图片不存在：${值}`)
    const 最大 = Number(this.getConfig().maxImageMB) * 1024 * 1024
    const buf = readFileSync(值)
    if (buf.length > 最大) throw new Error(`图片超过 ${Math.round(最大 / 1048576)}MB`)
    return { type: 'image', data: { file: `base64://${buf.toString('base64')}` } }
  }

  async sendFile(qq, path) {
    const 值 = String(path || '').trim()
    if (!值 || !existsSync(值)) throw new Error(`文件不存在：${值}`)
    try {
      await this.transport.sendMessage(qq, [{ type: 'file', data: { file: 值.replace(/\\/g, '/'), name: basename(值) } }])
    } catch (error) {
      throw new Error(`file 段发送失败（可能 NapCat 不支持或没有权限）：${String(error?.message || error)}`)
    }
  }

  /** 语音发送：本地路径 → file:/// → base64，共 3 次；失败由上层报错。 */
  async sendRecordWithRetry(qq, path, label = '语音') {
    const 值 = String(path || '').trim()
    if (!值 || !existsSync(值)) throw new Error(`${label}文件不存在：${值}`)
    const 大小 = readFileSync(值).length
    const 最大 = Number(this.getConfig().maxVoiceMB) * 1024 * 1024
    const 候选 = [{ 名: '本地路径', 值: 值.replace(/\\/g, '/') }]
    候选.push({ 名: 'file URL', 值: `file:///${值.replace(/\\/g, '/').replace(/^\/+/, '')}` })
    if (大小 <= 最大) 候选.push({ 名: 'base64', 值: `base64://${readFileSync(值).toString('base64')}` })

    let 最后 = ''
    for (let i = 0; i < 候选.length; i++) {
      try {
        await this.transport.sendMessage(qq, [{ type: 'record', data: { file: 候选[i].值 } }])
        return { ok: true, 方式: 候选[i].名 }
      } catch (error) {
        最后 = `${候选[i].名}：${String(error?.message || error)}`
        this.logger?.warn(`语音发送失败（第 ${i + 1}/${候选.length} 次，${候选[i].名}）：${最后}`)
        if (i < 候选.length - 1) await new Promise((r) => setTimeout(r, 500))
      }
    }
    throw new Error(`语音重试 ${候选.length} 次都失败：${最后}`)
  }

  async reportVoiceError(sessionId, errorText) {
    const 现 = Date.now()
    const 上次 = this.语音报错时间.get(会话键(sessionId)) || 0
    if (现 - 上次 < 60000) return
    this.语音报错时间.set(会话键(sessionId), 现)
    try {
      await this.delivery.deliver({
        sessionId,
        text: `（dsh-fish-message）语音发送失败：${拍短(errorText, 200)}`,
        images: [],
        meta: { notice: 'voice-error' },
      })
    } catch (error) {
      this.logger?.warn(`语音错误提示也没投进会话：${String(error?.message || error)}`)
    }
  }

  // ---------------- 设置页的测试按钮 ----------------

  async testSend(qq) {
    const binding = qq
      ? this.byPeer.get(String(qq))
      : (this.getConfig().bindings || []).find((b) => b.enabled)
    if (!binding) throw new Error('没有可用的绑定')
    const 文字 = '（dsh-fish-message 测试）这条是插件发的测试消息，收到就说明 DSH → QQ 通了。'
    await this.sendText(binding.qq, 文字)
    return { ok: true, qq: binding.qq, text: 文字 }
  }

  async testVoice(qq) {
    const binding = qq
      ? this.byPeer.get(String(qq))
      : (this.getConfig().bindings || []).find((b) => b.enabled)
    if (!binding) throw new Error('没有可用的绑定')
    const 文字 = '这是一条来自 dsh-fish-message 的测试语音。'
    const 路径 = await this.voice.synthesize(文字)
    const 发送 = await this.sendRecordWithRetry(binding.qq, 路径, '测试语音')
    return { ok: true, qq: binding.qq, text: 文字, path: 路径, method: 发送.方式 }
  }

  state() {
    return {
      ...this.status,
      running: this.running,
      queueSize: this.queue.size(),
      transport: this.status.transport || this.transport.getStatus?.() || null,
      watermarks: this.store.snapshot().watermarks,
      stats: this.store.snapshot().stats,
      recent: this.store.snapshot().recent,
      bindings: (this.getConfig().bindings || []).map((b) => ({
        ...b,
        alive: Boolean(this.bySession.get(会话键(b.session))),
      })),
    }
  }
}

export { 会话键, 同号 }
