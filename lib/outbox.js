// 持久化出站队列：DSH 要发到 QQ 的消息，在发送失败/机器人离线时先落盘，恢复后按顺序补发。
//
// 设计口径（跟 docs/API.md「出站队列语义」一致）：
//   1. 文件是 <DSH 家目录>/fish-message-outbox.json，原子写；结构 { version, items: [...] }；
//   2. 最多 1000 条，超过丢最旧并记日志；
//   3. fingerprint = sha256(qq + 规范化 segments)，短时间内相同 fingerprint 只留一条；
//   4. TTL 默认 24 小时；单条最多 20 次尝试；失败退避 min(5s * 1.8^attempts, 300s)；
//   5. 语音文本入队存文字（record_text），补发时重新合成；录音文件存路径，路径失效直接丢弃并报错。
//
// 这个类只碰磁盘和计数，不碰网络；真正的发送在 Bridge 里，便于单测。

import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './fs-util.js'

export const OUTBOX_VERSION = 1
export const OUTBOX_MAX_ITEMS = 1000
export const OUTBOX_MAX_ATTEMPTS = 20
export const OUTBOX_BASE_BACKOFF_MS = 5000
export const OUTBOX_MAX_BACKOFF_MS = 300000
export const DEFAULT_TTL_HOURS = 24
export const DEFAULT_DEDUP_MINUTES = 10

const 数字 = (值, 兜底 = 0) => {
  const n = Number(值)
  return Number.isFinite(n) ? n : 兜底
}

const 文本 = (值) => String(值 == null ? '' : 值)

/** 只留数字的 QQ 号。 */
export function 规整QQ(qq) {
  return 文本(qq).replace(/[^\d]/g, '')
}

/** 稳定 JSON：对象键排序，保证同一语义的 fingerprint 一致。 */
function 稳定序列化(值) {
  if (值 === null || typeof 值 !== 'object') return JSON.stringify(值)
  if (Array.isArray(值)) return `[${值.map(稳定序列化).join(',')}]`
  const 键 = Object.keys(值).sort()
  return `{${键.map((k) => `${JSON.stringify(k)}:${稳定序列化(值[k])}`).join(',')}}`
}

/**
 * 把一条内部消息段规范成指纹里的一段。
 *
 * 语音刻意区分「文本」和「文件」：
 *   - record_text = 文案，补发时重新 TTS，绝不把音频字节写进队列；
 *   - record      = 已有音频文件路径，补发时校验路径。
 */
export function 规范化段(段) {
  const 型 = 文本(段?.type)
  const d = 段?.data && typeof 段.data === 'object' ? 段.data : {}
  switch (型) {
    case 'text':
      return `text:${文本(d.text)}`
    case 'image':
      return `image:${文本(d.path || d.url || d.file)}`
    case 'record_text':
      return `record_text:${文本(d.text)}:${文本(d.voice)}`
    case 'record':
    case 'record_file':
      return `record:${文本(d.path || d.file)}`
    case 'file':
      return `file:${文本(d.path || d.file)}:${文本(d.name)}`
    default:
      return `${型 || 'unknown'}:${稳定序列化(d)}`
  }
}

/** 相同 QQ + 相同内容 → 相同 fingerprint。 */
export function 计算指纹(qq, segments) {
  const 段们 = Array.isArray(segments) ? segments : []
  const 正文 = `${规整QQ(qq)}\n${段们.map(规范化段).join('\n')}`
  return createHash('sha256').update(正文, 'utf8').digest('hex')
}

/** 一条消息给日志/状态页看的短摘要。 */
export function 消息摘要(segments, 最大 = 120) {
  const 段们 = Array.isArray(segments) ? segments : []
  const 部分 = []
  for (const 段 of 段们) {
    const 型 = 文本(段?.type)
    const d = 段?.data || {}
    if (型 === 'text') 部分.push(文本(d.text))
    else if (型 === 'record_text') 部分.push(`[语音] ${文本(d.text)}`)
    else if (型 === 'record' || 型 === 'record_file') 部分.push(`[语音文件] ${文本(d.path || d.file)}`)
    else if (型 === 'image') 部分.push(`[图片] ${文本(d.path || d.url || d.file)}`)
    else if (型 === 'file') 部分.push(`[文件] ${文本(d.name || d.path || d.file)}`)
    else 部分.push(`[${型 || '未知'}]`)
  }
  const 文 = 部分.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  return 文.length > 最大 ? `${文.slice(0, 最大)}…` : 文
}

/** 失败后的退避毫秒数：5s * 1.8^attempts，封顶 300s。 */
export function 退避毫秒(attempts) {
  const n = Math.max(1, Math.floor(数字(attempts, 1)))
  return Math.min(OUTBOX_MAX_BACKOFF_MS, Math.round(OUTBOX_BASE_BACKOFF_MS * Math.pow(1.8, n)))
}

export class Outbox {
  constructor({
    homeDir,
    fileName = 'fish-message-outbox.json',
    getConfig = () => ({}),
    logger,
    store,
    now = () => Date.now(),
    maxItems = OUTBOX_MAX_ITEMS,
    ttlMs,
    dedupMs,
  } = {}) {
    this.homeDir = homeDir
    this.filePath = join(homeDir, fileName)
    this.getConfig = getConfig
    this.logger = logger
    this.store = store
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.maxItems = Math.max(1, Math.floor(数字(maxItems, OUTBOX_MAX_ITEMS)))
    this.ttlMsOverride = 数字(ttlMs, 0)
    this.dedupMsOverride = 数字(dedupMs, -1)
    this.items = []
    this.计数 = { sent: 0, failed: 0, dropped: 0, lastError: '' }
    this.从状态读计数()
    this.load()
  }

  /** 配置里的 TTL（小时）→ 毫秒；构造参数优先，方便测试用很短的 TTL。 */
  ttlMs() {
    if (this.ttlMsOverride > 0) return this.ttlMsOverride
    const 时 = 数字(this.getConfig()?.outboxTtlHours, DEFAULT_TTL_HOURS)
    return Math.max(1, 时) * 3600 * 1000
  }

  /** 配置里的去重窗口（分钟）→ 毫秒。 */
  dedupMs() {
    if (this.dedupMsOverride >= 0) return this.dedupMsOverride
    const 分 = 数字(this.getConfig()?.outboxDedupMinutes, DEFAULT_DEDUP_MINUTES)
    return Math.max(0, 分) * 60 * 1000
  }

  从状态读计数() {
    const 统计 = this.store?.snapshot?.()?.stats
    if (!统计) return
    this.计数.sent = 数字(统计.outboxSent, 0)
    this.计数.failed = 数字(统计.outboxFailed, 0)
    this.计数.dropped = 数字(统计.outboxDropped, 0)
    this.计数.lastError = 文本(统计.outboxLastError)
  }

  记计数(名, 错误 = '') {
    if (名 === 'sent') this.计数.sent += 1
    if (名 === 'failed') {
      this.计数.failed += 1
      this.计数.lastError = 文本(错误).slice(0, 300)
    }
    if (名 === 'dropped') this.计数.dropped += 1
    try {
      if (this.store && typeof this.store['noteOutbox' + 名[0].toUpperCase() + 名.slice(1)] === 'function') {
        this.store[`noteOutbox${名[0].toUpperCase()}${名.slice(1)}`](错误)
        this.store.save?.()
      }
    } catch {
      // 计数写不进状态文件不影响队列本身。
    }
  }

  load() {
    const 盘 = readJson(this.filePath, null)
    if (!盘 || typeof 盘 !== 'object' || !Array.isArray(盘.items)) {
      if (盘) this.logger?.warn(`出站队列文件格式不认识，按空队列处理：${this.filePath}`)
      this.items = []
      return this.items
    }
    const 现在 = this.now()
    const 原条数 = 盘.items.length
    this.items = 盘.items
      .map((x) => this.规整条目(x, 现在))
      .filter(Boolean)
      .sort((a, b) => a.createdAt - b.createdAt)
    if (this.items.length > this.maxItems) {
      const 多 = this.items.length - this.maxItems
      const 丢的 = this.items.splice(0, 多)
      for (const x of 丢的) this.记计数('dropped')
      this.logger?.warn(`出站队列超过 ${this.maxItems} 条，启动时丢掉最旧 ${多} 条`)
    }
    const 过期数 = this.expire(现在, { persist: false, quiet: true })
    if (原条数 !== this.items.length || 过期数) {
      this.save()
      this.logger?.info(`出站队列已加载：${this.items.length} 条待补发（启动时清理 ${原条数 - this.items.length} 条无效/过期）`)
    } else {
      this.logger?.debug(`出站队列已加载：${this.items.length} 条待补发`)
    }
    return this.items
  }

  规整条目(原, 现在) {
    if (!原 || typeof 原 !== 'object') return null
    const qq = 规整QQ(原.qq)
    const segments = Array.isArray(原.segments) ? 原.segments.filter((x) => x && typeof x === 'object') : []
    if (!qq || !segments.length) return null
    const createdAt = 数字(原.createdAt, 现在)
    const expiresAt = 数字(原.expiresAt, createdAt + this.ttlMs())
    return {
      id: 文本(原.id) || randomUUID(),
      qq,
      segments,
      createdAt,
      attempts: Math.max(0, Math.floor(数字(原.attempts, 0))),
      nextAttemptAt: 数字(原.nextAttemptAt, createdAt),
      expiresAt,
      reason: 文本(原.reason).slice(0, 200),
      fingerprint: 文本(原.fingerprint) || 计算指纹(qq, segments),
    }
  }

  持久化() {
    return writeJsonAtomic(this.filePath, { version: OUTBOX_VERSION, items: this.items })
  }

  save() {
    const 成功 = this.持久化()
    if (!成功) this.logger?.error(`出站队列写盘失败：${this.filePath}`)
    return 成功
  }

  pending() {
    return this.items.length
  }

  list({ limit = 50 } = {}) {
    const n = Math.max(1, Math.min(1000, Math.floor(数字(limit, 50))))
    return this.items.slice(0, n).map((x) => ({ ...x, segments: x.segments.map((s) => ({ ...s, data: { ...(s.data || {}) } })) }))
  }

  /**
   * 入队。
   * @returns {{ok: boolean, item?: object, deduped?: boolean, persisted?: boolean, dropped?: number}}
   */
  enqueue({ qq, segments, reason = '', error = '', now = this.now(), ttlMs, dedupMs } = {}) {
    const 号 = 规整QQ(qq)
    const 段们 = Array.isArray(segments) ? segments.filter((x) => x && typeof x === 'object') : []
    if (!号) throw new Error('入队失败：QQ 号为空')
    if (!段们.length) throw new Error('入队失败：消息段为空')

    this.expire(now, { persist: false, quiet: true })

    const fingerprint = 计算指纹(号, 段们)
    const 窗口 = dedupMs === undefined ? this.dedupMs() : Math.max(0, 数字(dedupMs, 0))
    if (窗口 > 0) {
      for (let i = this.items.length - 1; i >= 0; i--) {
        const 条 = this.items[i]
        if (条.fingerprint === fingerprint && now - 条.createdAt <= 窗口) {
          this.logger?.info(`出站队列已有同一条消息（id=${条.id}，积压 ${this.items.length} 条），不重复入队`)
          return { ok: true, item: 条, deduped: true, persisted: true, dropped: 0 }
        }
      }
    }

    const 存活 = ttlMs === undefined ? this.ttlMs() : Math.max(1, 数字(ttlMs, this.ttlMs()))
    const 条 = {
      id: randomUUID(),
      qq: 号,
      segments: 段们,
      createdAt: now,
      attempts: 0,
      nextAttemptAt: now,
      expiresAt: now + 存活,
      reason: 文本(reason).slice(0, 200),
      fingerprint,
    }
    this.items.push(条)

    let 丢 = 0
    if (this.items.length > this.maxItems) {
      丢 = this.items.length - this.maxItems
      const 丢的 = this.items.splice(0, 丢)
      for (const x of 丢的) {
        this.记计数('dropped')
        this.logger?.warn(`出站队列已满（${this.maxItems} 条），丢弃最旧一条：qq=${x.qq} id=${x.id} ${消息摘要(x.segments, 60)}`)
      }
    }
    const persisted = this.save()
    this.logger?.info(`已加入出站队列：qq=${号} 原因=${条.reason || '发送失败'} 积压 ${this.items.length} 条 ${error ? `（${文本(error).slice(0, 120)}）` : ''}`)
    return { ok: true, item: 条, deduped: false, persisted, dropped: 丢 }
  }

  按id(id) {
    const 键 = 文本(id)
    return this.items.find((x) => x.id === 键) || null
  }

  /** 删除单条（手动丢弃/不可恢复），计入 droppedTotal。 */
  drop(id, reason = '手动丢弃', { now = this.now(), quiet = false } = {}) {
    const 键 = 文本(id)
    const 位置 = this.items.findIndex((x) => x.id === 键)
    if (位置 < 0) return null
    const [条] = this.items.splice(位置, 1)
    this.记计数('dropped')
    if (!quiet) {
      this.logger?.warn(`出站消息被丢弃（${reason}）：qq=${条.qq} id=${条.id} 创建于 ${new Date(条.createdAt).toISOString()} ${消息摘要(条.segments, 60)}`)
      this.save()
    }
    return 条
  }

  /** 清空整个队列；返回清掉的条数。 */
  clear({ reason = '手动清空' } = {}) {
    const 条数 = this.items.length
    if (!条数) return 0
    for (const 条 of this.items) {
      this.记计数('dropped')
      this.logger?.warn(`出站消息被丢弃（${reason}）：qq=${条.qq} id=${条.id} ${消息摘要(条.segments, 60)}`)
    }
    this.items = []
    this.save()
    return 条数
  }

  /** 过期清理；返回清掉的条数。 */
  expire(now = this.now(), { persist = true, quiet = false } = {}) {
    const 留 = []
    let 丢 = 0
    for (const 条 of this.items) {
      if (数字(条.expiresAt, Infinity) <= now) {
        丢++
        this.记计数('dropped')
        if (!quiet) {
          this.logger?.warn(`出站消息过期（TTL ${Math.round(this.ttlMs() / 3600000)} 小时）：qq=${条.qq} id=${条.id} ${消息摘要(条.segments, 60)}`)
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

  /** 队列里第一条可补发的消息；不跳过后面的，保证 FIFO。 */
  next({ now = this.now(), force = false } = {}) {
    this.expire(now, { persist: false, quiet: true })
    const 首 = this.items[0]
    if (!首) return null
    if (!force && 数字(首.nextAttemptAt, 0) > now) return null
    return 首
  }

  markSent(id) {
    const 键 = 文本(id)
    const 位置 = this.items.findIndex((x) => x.id === 键)
    if (位置 < 0) return null
    const [条] = this.items.splice(位置, 1)
    this.计数.sent += 1
    try {
      this.store?.noteOutboxSent?.()
      this.store?.save?.()
    } catch { /* 计数失败不影响队列 */ }
    this.save()
    return 条
  }

  /**
   * 记一次发送失败。
   * @returns {{item: object|null, dropped: boolean, delayMs: number, attempts: number}}
   */
  markFailed(id, error = '', now = this.now()) {
    const 条 = this.按id(id)
    if (!条) return { item: null, dropped: false, delayMs: 0, attempts: 0 }
    条.attempts += 1
    this.记计数('failed', error)
    const 文 = 文本(error).slice(0, 300)
    if (条.attempts >= OUTBOX_MAX_ATTEMPTS) {
      this.items = this.items.filter((x) => x.id !== 条.id)
      this.记计数('dropped')
      this.save()
      this.logger?.error(`出站消息尝试 ${条.attempts} 次仍失败，已放弃：qq=${条.qq} id=${条.id} ${消息摘要(条.segments, 60)}｜${文}`)
      return { item: 条, dropped: true, delayMs: 0, attempts: 条.attempts }
    }
    const 延迟 = 退避毫秒(条.attempts)
    条.nextAttemptAt = now + 延迟
    this.save()
    this.logger?.warn(`出站补发失败（第 ${条.attempts}/${OUTBOX_MAX_ATTEMPTS} 次，${Math.round(延迟 / 1000)} 秒后再试）：qq=${条.qq} ${消息摘要(条.segments, 60)}｜${文}`)
    return { item: 条, dropped: false, delayMs: 延迟, attempts: 条.attempts }
  }

  status(now = this.now()) {
    const 最老 = this.items.length
      ? Math.min(...this.items.map((x) => 数字(x.createdAt, now)))
      : 0
    return {
      pending: this.items.length,
      oldestAgeSec: 最老 ? Math.max(0, Math.floor((now - 最老) / 1000)) : 0,
      sentTotal: this.计数.sent,
      failedTotal: this.计数.failed,
      droppedTotal: this.计数.dropped,
      lastError: this.计数.lastError,
    }
  }
}

export { 稳定序列化 }
