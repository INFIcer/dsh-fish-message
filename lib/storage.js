// 状态持久化：每个聊天的水位、已处理 message_id、最近事件、统计。
//
// 水位必须落盘，否则插件一重启就会把最近的历史当成新消息重投一遍。
// 结构刻意保持简单，方便出问题时用记事本直接看。

import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './fs-util.js'

const 状态版本 = 1

function 空状态() {
  return {
    version: 状态版本,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    watermarks: {},
    seen: [],
    stats: {
      received: 0,
      delivered: 0,
      skippedOld: 0,
      errors: 0,
      lastError: '',
      lastErrorAt: 0,
    },
    recent: [],
  }
}

export class StateStore {
  constructor({ homeDir, fileName = 'fish-message-state.json', maxSeen = 2000, legacyStatePath = '' }) {
    this.filePath = join(homeDir, fileName)
    this.legacyStatePath = legacyStatePath || join(homeDir, 'qq-bridge-state.json')
    this.maxSeen = maxSeen
    this.state = 空状态()
    this.seen = new Set()
    this.load()
  }

  load() {
    const 盘 = readJson(this.filePath, null)
    if (盘 && typeof 盘 === 'object' && !Array.isArray(盘)) {
      this.state = {
        ...空状态(),
        ...盘,
        watermarks: 盘.watermarks && typeof 盘.watermarks === 'object' ? 盘.watermarks : {},
        stats: { ...空状态().stats, ...(盘.stats || {}) },
        recent: Array.isArray(盘.recent) ? 盘.recent.slice(-30) : [],
      }
    }
    this.seen = new Set((Array.isArray(this.state.seen) ? this.state.seen : []).map(String))
    return this.state
  }

  /**
   * 从旧桥的状态里搬水位和已转 id。
   * 旧桥文件必须保留不动，这里只读。
   * @returns {{timestamp: number, ids: number}}
   */
  migrateLegacy(qq) {
    const 旧 = readJson(this.legacyStatePath, null)
    if (!旧 || typeof 旧 !== 'object') return { timestamp: 0, ids: 0 }
    const 上次 = 旧.上次 && typeof 旧.上次 === 'object' ? 旧.上次 : {}
    const 时间 = Number(上次[`私聊:${qq}`] || 上次[`private:${qq}`] || 0)
    let 搬了 = 0
    for (const id of (Array.isArray(旧.已转) ? 旧.已转.slice(-500) : [])) {
      const 键 = String(id)
      if (!this.seen.has(键)) {
        this.seen.add(键)
        this.state.seen.push(键)
        搬了++
      }
    }
    if (时间 > 0 && !this.getWatermark(qq)) {
      this.setWatermark(qq, { timestamp: 时间, messageId: '' }, false)
    }
    if (搬了 || 时间 > 0) {
      this.state.stats.received += 0
      this.save()
    }
    return { timestamp: 时间, ids: 搬了 }
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
    const 旧 = this.state.watermarks[key] || { timestamp: 0, messageId: '' }
    const 新时间 = Math.max(Number(旧.timestamp) || 0, Number(timestamp) || 0)
    this.state.watermarks[key] = {
      timestamp: 新时间,
      messageId: messageId == null || messageId === '' ? (旧.messageId || '') : String(messageId),
      updatedAt: Date.now(),
    }
    if (save) this.save()
  }

  hasSeen(id) {
    return this.seen.has(String(id))
  }

  markSeen(id, save = false) {
    const 键 = String(id)
    if (!键 || this.seen.has(键)) return
    this.seen.add(键)
    this.state.seen.push(键)
    // 只留最近 N 个；水位会兜住更老的，不需要无限长。
    if (this.state.seen.length > this.maxSeen) {
      const 删 = this.state.seen.length - this.maxSeen
      for (const 旧 of this.state.seen.splice(0, 删)) this.seen.delete(String(旧))
    }
    if (save) this.save()
  }

  recordEvent(event) {
    const 条 = {
      at: Date.now(),
      direction: String(event.direction || ''),
      qq: String(event.qq || ''),
      ok: Boolean(event.ok),
      text: String(event.text || '').slice(0, 160),
      error: String(event.error || '').slice(0, 200),
    }
    this.state.recent.push(条)
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

  save() {
    this.state.updatedAt = Date.now()
    this.state.seen = [...this.seen].slice(-this.maxSeen)
    return writeJsonAtomic(this.filePath, this.state)
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state))
  }
}
