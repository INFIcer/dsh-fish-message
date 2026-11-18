// 状态持久化：每个聊天的水位、已处理 message_id、最近事件、统计、送信渠道。
//
// 水位必须落盘，否则插件一重启就会把最近的历史当成新消息重投一遍。
// 送信渠道（replyTargets）也要落盘：它跨回合生效，重启后还要按上一次的渠道回话。
// 结构刻意保持简单，方便出问题时用记事本直接看。

import { join } from 'node:path'
import { quarantineFile, readJson, readJsonWithBackup, writeJsonAtomic } from './fs-util.js'
import { placeholderPathHint, isPlaceholderPath } from './path-hint.js'

const statusVersion = 1
/** 送信渠道最多记这么多间会话，按 at 淘汰最旧：状态文件不能随会话数无限长。 */
const maxReplyTargets = 200

/**
 * 读盘时整规整送信渠道：只认 {[会话键]: {channel, peer, at}}。
 * 老状态文件没有这一节、或内容被改坏，都退回空表，不影响其它状态。
 */
function normalizeReplyTargets(raw) {
  const table = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return table
  for (const [key, value] of Object.entries(raw)) {
    if (!key || !value || typeof value !== 'object') continue
    const channel = String(value.channel || '').trim()
    const peer = String(value.peer || '').trim()
    if (!channel || !peer) continue
    table[String(key)] = { channel, peer, at: Number(value.at) || 0 }
  }
  return trimReplyTargets(table)
}

/** 只留最近 maxReplyTargets 间会话，按 at 淘汰最旧。 */
function trimReplyTargets(table) {
  const keys = Object.keys(table)
  if (keys.length <= maxReplyTargets) return table
  keys.sort((a, b) => (Number(table[a]?.at) || 0) - (Number(table[b]?.at) || 0))
  for (const key of keys.slice(0, keys.length - maxReplyTargets)) delete table[key]
  return table
}

/**
 * 旧版本把示例里的 `[语音:路径]` 当真实文件，落成「语音文件不存在：路径」。
 * 读旧状态时改成可读原因，避免设置页一直显示一句像变量名的历史错误。
 */
function fixLegacyPathError(str) {
  const original = String(str == null ? '' : str)
  const m = /^语音文件不存在[：:]\s*(.+)$/.exec(original)
  if (!m) return original
  const value = m[1].trim()
  return isPlaceholderPath(value) ? placeholderPathHint('语音', value) : original
}

function emptyState() {
  return {
    version: statusVersion,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    watermarks: {},
    seen: [],
    // 送信渠道：会话键 → {channel, peer, at}；见 Bridge.setReplyTarget。
    replyTargets: {},
    stats: {
      received: 0,
      delivered: 0,
      skippedOld: 0,
      errors: 0,
      lastError: '',
      lastErrorAt: 0,
      // 出站队列计数：补发成功 / 补发失败尝试 / 丢弃（TTL、满 1000、手动、路径失效）。
      outboxSent: 0,
      outboxFailed: 0,
      outboxDropped: 0,
      outboxLastError: '',
    },
    recent: [],
  }
}

export class StateStore {
  constructor({ homeDir, fileName = 'fish-message-state.json', maxSeen = 2000, legacyStatePath = '', logger = null }) {
    this.filePath = join(homeDir, fileName)
    this.legacyStatePath = legacyStatePath || join(homeDir, 'qq-bridge-state.json')
    this.maxSeen = maxSeen
    this.logger = logger
    this.state = emptyState()
    this.seen = new Set()
    this.load()
  }

  load() {
    const disk = readJsonWithBackup(this.filePath, null, { logger: this.logger, label: '状态文件' })
    if (disk && typeof disk === 'object' && !Array.isArray(disk)) {
      this.state = {
        ...emptyState(),
        ...disk,
        watermarks: disk.watermarks && typeof disk.watermarks === 'object' ? disk.watermarks : {},
        replyTargets: normalizeReplyTargets(disk.replyTargets),
        stats: { ...emptyState().stats, ...(disk.stats || {}) },
        recent: Array.isArray(disk.recent) ? disk.recent.slice(-30) : [],
      }
    } else if (disk) {
      // 能解析但不是对象：同样留档，水位丢了下一次启动会重投，至少原文件还在。
      quarantineFile(this.filePath, { logger: this.logger, label: '状态文件', reason: '结构不认识' })
    }
    this.state.stats.lastError = fixLegacyPathError(this.state.stats.lastError)
    this.state.stats.outboxLastError = fixLegacyPathError(this.state.stats.outboxLastError)
    this.seen = new Set((Array.isArray(this.state.seen) ? this.state.seen : []).map(String))
    return this.state
  }

  /**
   * 从旧桥的状态里搬水位和已转 id。
   * 旧桥文件必须保留不动，这里只读。
   * @returns {{timestamp: number, ids: number}}
   */
  migrateLegacy(qq) {
    const prev = readJson(this.legacyStatePath, null)
    if (!prev || typeof prev !== 'object') return { timestamp: 0, ids: 0 }
    const lastTime = prev.上次 && typeof prev.上次 === 'object' ? prev.上次 : {}
    const time = Number(lastTime[`私聊:${qq}`] || lastTime[`private:${qq}`] || 0)
    let moved = 0
    for (const id of (Array.isArray(prev.已转) ? prev.已转.slice(-500) : [])) {
      const key = String(id)
      if (!this.seen.has(key)) {
        this.seen.add(key)
        this.state.seen.push(key)
        moved++
      }
    }
    if (time > 0 && !this.getWatermark(qq)) {
      this.setWatermark(qq, { timestamp: time, messageId: '' }, false)
    }
    if (moved || time > 0) {
      this.state.stats.received += 0
      this.save()
    }
    return { timestamp: time, ids: moved }
  }

  getWatermark(qq) {
    const w = this.state.watermarks[String(qq)]
    if (!w) return null
    return {
      timestamp: Number(w.timestamp) || 0,
      messageId: w.messageId == null ? '' : String(w.messageId),
      updatedAt: Number(w.updatedAt) || 0,
    }
  }

  setWatermark(qq, { timestamp, messageId }, save = true) {
    const key = String(qq)
    const prev = this.state.watermarks[key] || { timestamp: 0, messageId: '' }
    const newTime = Math.max(Number(prev.timestamp) || 0, Number(timestamp) || 0)
    this.state.watermarks[key] = {
      timestamp: newTime,
      messageId: messageId == null || messageId === '' ? (prev.messageId || '') : String(messageId),
      updatedAt: Date.now(),
    }
    if (save) this.save()
  }

  /** 这间会话当前的送信渠道；没有就是 null（从没收到过渠道消息，或被用户直接发言清空）。 */
  getReplyTarget(sessionKey) {
    const value = this.state.replyTargets[String(sessionKey)]
    if (!value || typeof value !== 'object') return null
    const channel = String(value.channel || '')
    const peer = String(value.peer || '')
    if (!channel || !peer) return null
    return { channel, peer, at: Number(value.at) || 0 }
  }

  /** 收到渠道消息：把送信渠道改到这条渠道。立刻落盘，重启后还要接着用。 */
  setReplyTarget(sessionKey, { channel, peer }, save = true) {
    const key = String(sessionKey)
    const ch = String(channel || '')
    const target = String(peer || '')
    if (!key || !ch || !target) return
    if (!this.state.replyTargets || typeof this.state.replyTargets !== 'object') this.state.replyTargets = {}
    this.state.replyTargets[key] = { channel: ch, peer: target, at: Date.now() }
    trimReplyTargets(this.state.replyTargets)
    if (save) this.save()
  }

  /** 用户直接发言：清空这间会话的送信渠道；返回是否确实清掉了一条。 */
  clearReplyTarget(sessionKey, save = true) {
    const key = String(sessionKey)
    const table = this.state.replyTargets
    if (!table || !table[key]) return false
    delete table[key]
    if (save) this.save()
    return true
  }

  hasSeen(id) {
    return this.seen.has(String(id))
  }

  markSeen(id, save = false) {
    const key = String(id)
    if (!key || this.seen.has(key)) return
    this.seen.add(key)
    this.state.seen.push(key)
    // 只留最近 N 个；水位会兜住更老的，不需要无限长。
    if (this.state.seen.length > this.maxSeen) {
      const theDelete = this.state.seen.length - this.maxSeen
      for (const prev of this.state.seen.splice(0, theDelete)) this.seen.delete(String(prev))
    }
    if (save) this.save()
  }

  recordEvent(event) {
    const item = {
      at: Date.now(),
      direction: String(event.direction || ''),
      // 通道与对端分开存：qq 字段仍是对端原串，老状态文件没有 channel 时按空串读。
      channel: String(event.channel || ''),
      qq: String(event.qq || ''),
      ok: Boolean(event.ok),
      text: String(event.text || '').slice(0, 160),
      error: String(event.error || '').slice(0, 200),
    }
    this.state.recent.push(item)
    if (this.state.recent.length > 30) this.state.recent.splice(0, this.state.recent.length - 30)
  }

  noteReceived() { this.state.stats.received += 1 }
  noteDelivered() { this.state.stats.delivered += 1 }
  noteSkippedOld() { this.state.stats.skippedOld += 1 }

  noteError(message) {
    this.state.stats.errors += 1
    this.state.stats.lastError = String(message || '').slice(0, 300)
    this.state.stats.lastErrorAt = Date.now()
  }

  noteOutboxSent() {
    this.state.stats.outboxSent = (Number(this.state.stats.outboxSent) || 0) + 1
  }

  noteOutboxFailed(message) {
    this.state.stats.outboxFailed = (Number(this.state.stats.outboxFailed) || 0) + 1
    if (message) this.state.stats.outboxLastError = String(message).slice(0, 300)
  }

  noteOutboxDropped() {
    this.state.stats.outboxDropped = (Number(this.state.stats.outboxDropped) || 0) + 1
  }

  save() {
    this.state.updatedAt = Date.now()
    this.state.seen = [...this.seen].slice(-this.maxSeen)
    return writeJsonAtomic(this.filePath, this.state)
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state))
  }
}
