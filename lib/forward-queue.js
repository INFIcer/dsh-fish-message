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
import { readJson, writeJsonAtomic } from './fs-util.js'

export const FORWARD_QUEUE_VERSION = 1
export const FORWARD_MAX_ITEMS = 500
export const FORWARD_TTL_MS = 24 * 3600 * 1000

const 数字 = (值, 兜底 = 0) => {
  const n = Number(值)
  return Number.isFinite(n) ? n : 兜底
}

const 文本 = (值) => String(值 == null ? '' : 值)

/** 队列条目里的图片：只留可还原附件的最小信息。 */
function 规整图片(给) {
  const 出 = []
  for (const 图 of Array.isArray(给) ? 给 : []) {
    if (!图 || typeof 图 !== 'object') continue
    const path = 文本(图.path).trim()
    if (!path) continue
    出.push({
      mime: 文本(图.mime) || 'image/jpeg',
      name: 文本(图.name).slice(0, 200),
      path,
    })
  }
  return 出.slice(0, 4)
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
    this.maxItems = Math.max(1, Math.floor(数字(maxItems, FORWARD_MAX_ITEMS)))
    this.ttlMs = Math.max(1, Math.floor(数字(ttlMs, FORWARD_TTL_MS)))
    this.items = []
    // 按会话累计的丢弃数：只在恢复转发时读一次，然后清零。
    this.丢弃 = {}
    this.load()
  }

  load() {
    const 盘 = readJson(this.filePath, null)
    if (!盘 || typeof 盘 !== 'object' || !Array.isArray(盘.items)) {
      if (盘) this.logger?.warn(`待转发队列文件格式不认识，按空队列处理：${this.filePath}`)
      this.items = []
      this.丢弃 = {}
      return this.items
    }
    this.items = 盘.items
      .map((x) => this.规整条目(x))
      .filter(Boolean)
      .sort((a, b) => a.createdAt - b.createdAt)
    this.丢弃 = 盘.dropped && typeof 盘.dropped === 'object' ? { ...盘.dropped } : {}
    if (this.items.length > this.maxItems) {
      const 多 = this.items.length - this.maxItems
      for (const 条 of this.items.splice(0, 多)) this.记丢弃(条, '启动时超过上限')
      this.logger?.warn(`待转发队列超过 ${this.maxItems} 条，启动时丢掉最旧 ${多} 条`)
    }
    const 原条数 = this.items.length
    this.expire(this.now(), { persist: false, quiet: true })
    if (原条数 !== this.items.length) this.save()
    if (this.items.length) this.logger?.info(`待转发队列已加载：${this.items.length} 条（恢复转发后补发）`)
    return this.items
  }

  规整条目(原) {
    if (!原 || typeof 原 !== 'object') return null
    const sessionId = 文本(原.sessionId).trim()
    const text = 文本(原.text).trim()
    const images = 规整图片(原.images)
    if (!sessionId || (!text && !images.length)) return null
    const createdAt = 数字(原.createdAt, this.now())
    const expiresAt = 数字(原.expiresAt, createdAt + this.ttlMs)
    return {
      id: 文本(原.id) || randomUUID(),
      sessionId,
      qq: 文本(原.qq).replace(/[^\d]/g, ''),
      name: 文本(原.name).slice(0, 24),
      messageId: 文本(原.messageId),
      time: 数字(原.time, 0),
      text,
      images,
      createdAt,
      expiresAt,
      attempts: Math.max(0, Math.floor(数字(原.attempts, 0))),
      lastError: 文本(原.lastError).slice(0, 300),
    }
  }

  持久化() {
    return writeJsonAtomic(this.filePath, {
      version: FORWARD_QUEUE_VERSION,
      items: this.items,
      dropped: this.丢弃,
      updatedAt: Date.now(),
    })
  }

  save() {
    const 成功 = this.持久化()
    if (!成功) this.logger?.error(`待转发队列写盘失败：${this.filePath}`)
    return 成功
  }

  pending() {
    return this.items.length
  }

  list({ limit = 50 } = {}) {
    const n = Math.max(1, Math.min(500, Math.floor(数字(limit, 50))))
    return this.items.slice(0, n).map((x) => ({ ...x, images: x.images.map((图) => ({ ...图 })) }))
  }

  /** 记一次丢弃：按会话累计，恢复时用来提示。 */
  记丢弃(条, 原因) {
    const 会话 = 文本(条?.sessionId) || '未知会话'
    this.丢弃[会话] = (数字(this.丢弃[会话], 0) || 0) + 1
    this.logger?.warn(`待转发消息被丢弃（${原因}）：会话=${会话} qq=${条?.qq || ''} ${文本(条?.text).slice(0, 60)}`)
  }

  /**
   * 入队一条待转发消息。
   * @returns {{ok:boolean, item:object, dropped:number, persisted:boolean, pending:number}}
   */
  enqueue({
    sessionId, qq = '', name = '', messageId = '', time = 0, text = '', images = [], now = this.now(),
  } = {}) {
    const 会 = 文本(sessionId).trim()
    if (!会) throw new Error('待转发入队失败：会话为空')
    const 正文 = 文本(text).trim()
    const 图们 = 规整图片(images)
    if (!正文 && !图们.length) throw new Error('待转发入队失败：消息为空')

    this.expire(now, { persist: false, quiet: true })

    const 条 = {
      id: randomUUID(),
      sessionId: 会,
      qq: 文本(qq).replace(/[^\d]/g, ''),
      name: 文本(name).slice(0, 24),
      messageId: 文本(messageId),
      time: 数字(time, 0),
      text: 正文,
      images: 图们,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      attempts: 0,
      lastError: '',
    }
    this.items.push(条)

    let 丢 = 0
    if (this.items.length > this.maxItems) {
      丢 = this.items.length - this.maxItems
      for (const 旧 of this.items.splice(0, 丢)) this.记丢弃(旧, `超过 ${this.maxItems} 条上限`)
    }
    const persisted = this.save()
    this.logger?.info(`暂停转发：消息先存起来（积压 ${this.items.length} 条，最长保留 ${Math.round(this.ttlMs / 3600000)} 小时）`)
    return { ok: true, item: 条, dropped: 丢, persisted, pending: this.items.length }
  }

  /** 过期清理；返回清掉的条数。 */
  expire(now = this.now(), { persist = true, quiet = false } = {}) {
    const 留 = []
    let 丢 = 0
    for (const 条 of this.items) {
      if (数字(条.expiresAt, Infinity) <= now) {
        丢++
        this.记丢弃(条, `超过保留时间（${Math.round(this.ttlMs / 3600000)} 小时）`)
        if (!quiet) {
          this.logger?.warn(`待转发消息过期（保留 ${Math.round(this.ttlMs / 3600000)} 小时）：qq=${条.qq} ${文本(条.text).slice(0, 60)}`)
        }
      } else {
        留.push(条)
      }
    }
    if (丢) {
      this.items = 留
      if (persist) this.save()
    }
    return 丢
  }

  /** 队首（FIFO）；不跳过后面的。 */
  next({ now = this.now() } = {}) {
    this.expire(now, { persist: false, quiet: true })
    return this.items[0] || null
  }

  markSent(id) {
    const 键 = 文本(id)
    const 位置 = this.items.findIndex((x) => x.id === 键)
    if (位置 < 0) return null
    const [条] = this.items.splice(位置, 1)
    this.save()
    return 条
  }

  /** 补发失败：留在队首（不跳过后面的），记次数和原因，下一轮再试。 */
  markFailed(id, error = '', now = this.now()) {
    const 条 = this.items.find((x) => x.id === 文本(id))
    if (!条) return null
    条.attempts += 1
    条.lastError = 文本(error).slice(0, 300)
    // 失败本身不改 expiresAt：过期规则对「暂停中的消息」一视同仁。
    void now
    this.save()
    return 条
  }

  /**
   * 取走并清零「按会话累计的丢弃数」。
   * @returns {Record<string, number>}
   */
  取丢弃统计() {
    const 出 = { ...this.丢弃 }
    this.丢弃 = {}
    if (Object.keys(出).length) this.save()
    return 出
  }

  status(now = this.now()) {
    const 最老 = this.items.length ? Math.min(...this.items.map((x) => 数字(x.createdAt, now))) : 0
    const 丢弃总数 = Object.values(this.丢弃).reduce((和, n) => 和 + (数字(n, 0) || 0), 0)
    return {
      pending: this.items.length,
      oldestAgeSec: 最老 ? Math.max(0, Math.floor((now - 最老) / 1000)) : 0,
      maxItems: this.maxItems,
      ttlHours: Math.round((this.ttlMs / 3600000) * 10) / 10,
      droppedSinceResume: 丢弃总数,
      lastError: this.items.find((x) => x.lastError)?.lastError || '',
    }
  }
}
