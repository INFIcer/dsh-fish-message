// 暂停转发期间的待转发队列：入站消息照常解析、记统计、推进水位，
// 但先存在这里，等恢复转发后按原来的顺序逐条投进 DSH 会话。
//
// 设计口径：
//   1. 文件是 <DSH 家目录>/fish-message-forward-queue.json，原子写；
//   2. 最多 500 条，超过丢最旧；单条保留 24 小时，过期丢并计数；
//   3. 图片只存本机路径和类型，不把 base64 写进队列文件；
//   4. 丢弃数按会话累计，恢复时提示「有 N 条过期未转发」后清零。
//
// 这个类只碰磁盘和计数，不碰 DSH 会话；真正的投递在 Bridge 里。

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { quarantineFile, readJsonWithBackup, writeJsonAtomic } from './fs-util.js'
import { DEFAULT_CHANNEL, normalizeChannel, normalizePeer } from './peer.js'

export const FORWARD_QUEUE_VERSION = 1
export const FORWARD_MAX_ITEMS = 500
export const FORWARD_TTL_MS = 24 * 3600 * 1000

const toNumber = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const text = (value) => String(value == null ? '' : value)

/** 队列条目里的图片：只留可还原附件的最小信息。 */
function normalizePicture(raw) {
  const out = []
  for (const image of Array.isArray(raw) ? raw : []) {
    if (!image || typeof image !== 'object') continue
    const path = text(image.path).trim()
    if (!path) continue
    out.push({
      mime: text(image.mime) || 'image/jpeg',
      name: text(image.name).slice(0, 200),
      path,
    })
  }
  return out.slice(0, 4)
}

export class ForwardQueue {
  constructor({
    homeDir,
    fileName = 'fish-message-forward-queue.json',
    logger,
    now = () => Date.now(),
    maxItems = FORWARD_MAX_ITEMS,
    ttlMs = FORWARD_TTL_MS,
  } = {}) {
    this.filePath = join(homeDir, fileName)
    this.logger = logger
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.maxItems = Math.max(1, Math.floor(toNumber(maxItems, FORWARD_MAX_ITEMS)))
    this.ttlMs = Math.max(1, Math.floor(toNumber(ttlMs, FORWARD_TTL_MS)))
    this.items = []
    // 按会话累计的丢弃数：只在恢复转发时读一次，然后清零。
    this.dropped = {}
    this.load()
  }

  load() {
    const disk = readJsonWithBackup(this.filePath, null, { logger: this.logger, label: '待转发队列文件' })
    if (!disk || typeof disk !== 'object' || !Array.isArray(disk.items)) {
      // 解析失败已由 readJsonWithBackup 留档；结构不对的在这里留档，避免下次保存覆盖掉原文件。
      if (disk) quarantineFile(this.filePath, { logger: this.logger, label: '待转发队列文件', reason: '结构不认识' })
      this.items = []
      this.dropped = {}
      return this.items
    }
    this.items = disk.items
      .map((x) => this.normalizeEntry(x))
      .filter(Boolean)
      .sort((a, b) => a.createdAt - b.createdAt)
    this.dropped = disk.dropped && typeof disk.dropped === 'object' ? { ...disk.dropped } : {}
    if (this.items.length > this.maxItems) {
      const excess = this.items.length - this.maxItems
      for (const item of this.items.splice(0, excess)) this.noteDropped(item, '启动时超过上限')
      this.logger?.warn(`待转发队列超过 ${this.maxItems} 条，启动时丢掉最旧 ${excess} 条`)
    }
    const originalCount = this.items.length
    this.expire(this.now(), { persist: false, quiet: true })
    if (originalCount !== this.items.length) this.save()
    if (this.items.length) this.logger?.info(`待转发队列已加载：${this.items.length} 条（恢复转发后补发）`)
    return this.items
  }

  normalizeEntry(original) {
    if (!original || typeof original !== 'object') return null
    const sessionId = text(original.sessionId).trim()
    const bodyText = text(original.text).trim()
    const images = normalizePicture(original.images)
    if (!sessionId || (!bodyText && !images.length)) return null
    const createdAt = toNumber(original.createdAt, this.now())
    const expiresAt = toNumber(original.expiresAt, createdAt + this.ttlMs)
    // 老条目没有 channel，按 qq 读；qq 字段一直是对端原串。
    const channel = normalizeChannel(original.channel)
    return {
      id: text(original.id) || randomUUID(),
      sessionId,
      channel,
      qq: normalizePeer(channel, original.qq),
      name: text(original.name).slice(0, 24),
      messageId: text(original.messageId),
      time: toNumber(original.time, 0),
      text: bodyText,
      images,
      createdAt,
      expiresAt,
      attempts: Math.max(0, Math.floor(toNumber(original.attempts, 0))),
      lastError: text(original.lastError).slice(0, 300),
    }
  }

  persist() {
    return writeJsonAtomic(this.filePath, {
      version: FORWARD_QUEUE_VERSION,
      items: this.items,
      dropped: this.dropped,
      updatedAt: Date.now(),
    })
  }

  save() {
    const success = this.persist()
    if (!success) this.logger?.error(`待转发队列写盘失败：${this.filePath}`)
    return success
  }

  pending() {
    return this.items.length
  }

  list({ limit = 50 } = {}) {
    const n = Math.max(1, Math.min(500, Math.floor(toNumber(limit, 50))))
    return this.items.slice(0, n).map((x) => ({ ...x, images: x.images.map((image) => ({ ...image })) }))
  }

  /** 记一次丢弃：按会话累计，恢复时用来提示。 */
  noteDropped(item, reason) {
    const session = text(item?.sessionId) || '未知会话'
    this.dropped[session] = (toNumber(this.dropped[session], 0) || 0) + 1
    this.logger?.warn(`待转发消息被丢弃（${reason}）：会话=${session} qq=${item?.qq || ''} ${text(item?.text).slice(0, 60)}`)
  }

  /**
   * 入队一条待转发消息。
   * @returns {{ok:boolean, item:object, dropped:number, persisted:boolean, pending:number}}
   */
  enqueue({
    sessionId, channel = DEFAULT_CHANNEL, qq = '', name = '', messageId = '', time = 0, text: body = '', images = [], now = this.now(),
  } = {}) {
    const targetSession = text(sessionId).trim()
    if (!targetSession) throw new Error('待转发入队失败：会话为空')
    const bodyText = text(body).trim()
    const imageList = normalizePicture(images)
    if (!bodyText && !imageList.length) throw new Error('待转发入队失败：消息为空')

    this.expire(now, { persist: false, quiet: true })

    const ch = normalizeChannel(channel)
    const item = {
      id: randomUUID(),
      sessionId: targetSession,
      channel: ch,
      qq: normalizePeer(ch, qq),
      name: text(name).slice(0, 24),
      messageId: text(messageId),
      time: toNumber(time, 0),
      text: bodyText,
      images: imageList,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      attempts: 0,
      lastError: '',
    }
    this.items.push(item)

    let dropCount = 0
    if (this.items.length > this.maxItems) {
      dropCount = this.items.length - this.maxItems
      for (const prev of this.items.splice(0, dropCount)) this.noteDropped(prev, `超过 ${this.maxItems} 条上限`)
    }
    const persisted = this.save()
    this.logger?.info(`暂停转发：消息先存起来（积压 ${this.items.length} 条，最长保留 ${Math.round(this.ttlMs / 3600000)} 小时）`)
    return { ok: true, item: item, dropped: dropCount, persisted, pending: this.items.length }
  }

  /** 过期清理；返回清掉的条数。 */
  expire(now = this.now(), { persist = true, quiet = false } = {}) {
    const keep = []
    let dropCount = 0
    for (const item of this.items) {
      if (toNumber(item.expiresAt, Infinity) <= now) {
        dropCount++
        this.noteDropped(item, `超过保留时间（${Math.round(this.ttlMs / 3600000)} 小时）`)
        if (!quiet) {
          this.logger?.warn(`待转发消息过期（保留 ${Math.round(this.ttlMs / 3600000)} 小时）：qq=${item.qq} ${text(item.text).slice(0, 60)}`)
        }
      } else {
        keep.push(item)
      }
    }
    if (dropCount) {
      this.items = keep
      if (persist) this.save()
    }
    return dropCount
  }

  /** 队首（FIFO）；不跳过后面的。 */
  next({ now = this.now() } = {}) {
    this.expire(now, { persist: false, quiet: true })
    return this.items[0] || null
  }

  markSent(id) {
    const key = text(id)
    const position = this.items.findIndex((x) => x.id === key)
    if (position < 0) return null
    const [item] = this.items.splice(position, 1)
    this.save()
    return item
  }

  /** 补发失败：留在队首（不跳过后面的），记次数和原因，下一轮再试。 */
  markFailed(id, error = '', now = this.now()) {
    const item = this.items.find((x) => x.id === text(id))
    if (!item) return null
    item.attempts += 1
    item.lastError = text(error).slice(0, 300)
    // 失败本身不改 expiresAt：过期规则对「暂停中的消息」一视同仁。
    void now
    this.save()
    return item
  }

  /**
   * 取走并清零「按会话累计的丢弃数」。
   * @returns {Record<string, number>}
   */
  getDropStats() {
    const out = { ...this.dropped }
    this.dropped = {}
    if (Object.keys(out).length) this.save()
    return out
  }

  status(now = this.now()) {
    const oldest = this.items.length ? Math.min(...this.items.map((x) => toNumber(x.createdAt, now))) : 0
    const droppedTotal = Object.values(this.dropped).reduce((and, n) => and + (toNumber(n, 0) || 0), 0)
    return {
      pending: this.items.length,
      oldestAgeSec: oldest ? Math.max(0, Math.floor((now - oldest) / 1000)) : 0,
      maxItems: this.maxItems,
      ttlHours: Math.round((this.ttlMs / 3600000) * 10) / 10,
      droppedSinceResume: droppedTotal,
      lastError: this.items.find((x) => x.lastError)?.lastError || '',
    }
  }
}
