// 持久化出站队列：DSH 要发到 IM 的消息，在发送失败/机器人离线时先落盘，恢复后按顺序补发。
//
// 设计口径（跟 README / ARCHITECTURE 的「出站队列」一致）：
//   1. 文件是 <DSH 家目录>/fish-message-outbox.json，原子写；结构 { version, items: [...] }；
//   2. 最多 1000 条，超过丢最旧并记日志；
//   3. fingerprint = sha256(channel:peer + 规范化 segments)，短时间内相同 fingerprint 只留一条；
//   4. TTL 默认 24 小时；单条最多 20 次尝试；失败退避 min(5s * 1.8^attempts, 300s)；
//   5. 语音文本入队存文字（record_text），补发时重新合成；录音文件存路径，路径失效直接丢弃并报错。
//
// 这个类只碰磁盘和计数，不碰网络；真正的发送在 Bridge 里，便于单测。

import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { quarantineFile, readJsonWithBackup, writeJsonAtomic } from './fs-util.js'
import { DEFAULT_CHANNEL, normalizeChannel, normalizePeer, peerProblem } from './peer.js'

export const OUTBOX_VERSION = 1
export const OUTBOX_MAX_ITEMS = 1000
export const OUTBOX_MAX_ATTEMPTS = 20
export const OUTBOX_BASE_BACKOFF_MS = 5000
export const OUTBOX_MAX_BACKOFF_MS = 300000
export const DEFAULT_TTL_HOURS = 24
export const DEFAULT_DEDUP_MINUTES = 10

const toNumber = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const text = (value) => String(value == null ? '' : value)

/** 稳定 JSON：对象键排序，保证同一语义的 fingerprint 一致。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const key = Object.keys(value).sort()
  return `{${key.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/**
 * 把一条内部消息段规范成指纹里的一段。
 *
 * 语音刻意区分「文本」和「文件」：
 *   - record_text = 文案，补发时重新 TTS，绝不把音频字节写进队列；
 *   - record      = 已有音频文件路径，补发时校验路径。
 */
export function normalizeSegment(segment) {
  const kind = text(segment?.type)
  const d = segment?.data && typeof segment.data === 'object' ? segment.data : {}
  switch (kind) {
    case 'text':
      return `text:${text(d.text)}`
    case 'image':
      return `image:${text(d.path || d.url || d.file)}`
    case 'record_text':
      return `record_text:${text(d.text)}:${text(d.voice)}`
    case 'record':
    case 'record_file':
      return `record:${text(d.path || d.file)}`
    case 'file':
      return `file:${text(d.path || d.file)}:${text(d.name)}`
    default:
      return `${kind || 'unknown'}:${stableStringify(d)}`
  }
}

/**
 * 相同通道 + 相同对端 + 相同内容 → 相同 fingerprint。
 * channel 参与哈希：两个通道下同名 peer 的同样内容也是两条消息，不能互相去重。
 */
export function calcFingerprint(qq, segments, channel = DEFAULT_CHANNEL) {
  const ch = normalizeChannel(channel)
  const segmentList = Array.isArray(segments) ? segments : []
  const bodyText = `${ch}:${normalizePeer(ch, qq)}\n${segmentList.map(normalizeSegment).join('\n')}`
  return createHash('sha256').update(bodyText, 'utf8').digest('hex')
}

/** 一条消息给日志/状态页看的短摘要。 */
export function messageDigest(segments, max = 120) {
  const segmentList = Array.isArray(segments) ? segments : []
  const part = []
  for (const segment of segmentList) {
    const kind = text(segment?.type)
    const d = segment?.data || {}
    if (kind === 'text') part.push(text(d.text))
    else if (kind === 'record_text') part.push(`[语音] ${text(d.text)}`)
    else if (kind === 'record' || kind === 'record_file') part.push(`[语音文件] ${text(d.path || d.file)}`)
    else if (kind === 'image') part.push(`[图片] ${text(d.path || d.url || d.file)}`)
    else if (kind === 'file') part.push(`[文件] ${text(d.name || d.path || d.file)}`)
    else part.push(`[${kind || '未知'}]`)
  }
  const str = part.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  return str.length > max ? `${str.slice(0, max)}…` : str
}

/** 失败后的退避毫秒数：5s * 1.8^attempts，封顶 300s。 */
export function backoffMs(attempts) {
  const n = Math.max(1, Math.floor(toNumber(attempts, 1)))
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
    this.maxItems = Math.max(1, Math.floor(toNumber(maxItems, OUTBOX_MAX_ITEMS)))
    this.ttlMsOverride = toNumber(ttlMs, 0)
    this.dedupMsOverride = toNumber(dedupMs, -1)
    this.items = []
    this.count = { sent: 0, failed: 0, dropped: 0, lastError: '' }
    this.readCountsFromState()
    this.load()
  }

  /** 配置里的 TTL（小时）→ 毫秒；构造参数优先，方便测试用很短的 TTL。 */
  ttlMs() {
    if (this.ttlMsOverride > 0) return this.ttlMsOverride
    const hour = toNumber(this.getConfig()?.outboxTtlHours, DEFAULT_TTL_HOURS)
    return Math.max(1, hour) * 3600 * 1000
  }

  /** 配置里的去重窗口（分钟）→ 毫秒。 */
  dedupMs() {
    if (this.dedupMsOverride >= 0) return this.dedupMsOverride
    const minute = toNumber(this.getConfig()?.outboxDedupMinutes, DEFAULT_DEDUP_MINUTES)
    return Math.max(0, minute) * 60 * 1000
  }

  readCountsFromState() {
    const stats = this.store?.snapshot?.()?.stats
    if (!stats) return
    this.count.sent = toNumber(stats.outboxSent, 0)
    this.count.failed = toNumber(stats.outboxFailed, 0)
    this.count.dropped = toNumber(stats.outboxDropped, 0)
    this.count.lastError = text(stats.outboxLastError)
  }

  countEvent(name, error = '') {
    if (name === 'sent') this.count.sent += 1
    if (name === 'failed') {
      this.count.failed += 1
      this.count.lastError = text(error).slice(0, 300)
    }
    if (name === 'dropped') this.count.dropped += 1
    try {
      if (this.store && typeof this.store['noteOutbox' + name[0].toUpperCase() + name.slice(1)] === 'function') {
        this.store[`noteOutbox${name[0].toUpperCase()}${name.slice(1)}`](error)
        this.store.save?.()
      }
    } catch {
      // 计数写不进状态文件不影响队列本身。
    }
  }

  load() {
    const disk = readJsonWithBackup(this.filePath, null, { logger: this.logger, label: '出站队列文件' })
    if (!disk || typeof disk !== 'object' || !Array.isArray(disk.items)) {
      // 解析失败已由 readJsonWithBackup 留档；结构不对的在这里留档，避免下次保存覆盖掉原文件。
      if (disk) quarantineFile(this.filePath, { logger: this.logger, label: '出站队列文件', reason: '结构不认识' })
      this.items = []
      return this.items
    }
    const now = this.now()
    const originalCount = disk.items.length
    this.items = disk.items
      .map((x) => this.normalizeEntry(x, now))
      .filter(Boolean)
      .sort((a, b) => a.createdAt - b.createdAt)
    if (this.items.length > this.maxItems) {
      const excess = this.items.length - this.maxItems
      const dropped = this.items.splice(0, excess)
      for (const x of dropped) this.countEvent('dropped')
      this.logger?.warn(`出站队列超过 ${this.maxItems} 条，启动时丢掉最旧 ${excess} 条`)
    }
    const expireNumber = this.expire(now, { persist: false, quiet: true })
    if (originalCount !== this.items.length || expireNumber) {
      this.save()
      this.logger?.info(`出站队列已加载：${this.items.length} 条待补发（启动时清理 ${originalCount - this.items.length} 条无效/过期）`)
    } else {
      this.logger?.debug(`出站队列已加载：${this.items.length} 条待补发`)
    }
    return this.items
  }

  normalizeEntry(original, now) {
    if (!original || typeof original !== 'object') return null
    // 老条目没有 channel，按 qq 读；qq 字段一直是对端原串。
    const channel = normalizeChannel(original.channel)
    const qq = normalizePeer(channel, original.qq || original.peer)
    const segments = Array.isArray(original.segments) ? original.segments.filter((x) => x && typeof x === 'object') : []
    if (!qq || !segments.length) return null
    const createdAt = toNumber(original.createdAt, now)
    const expiresAt = toNumber(original.expiresAt, createdAt + this.ttlMs())
    return {
      id: text(original.id) || randomUUID(),
      channel,
      qq,
      segments,
      createdAt,
      attempts: Math.max(0, Math.floor(toNumber(original.attempts, 0))),
      nextAttemptAt: toNumber(original.nextAttemptAt, createdAt),
      expiresAt,
      reason: text(original.reason).slice(0, 200),
      fingerprint: text(original.fingerprint) || calcFingerprint(qq, segments, channel),
    }
  }

  persist() {
    return writeJsonAtomic(this.filePath, { version: OUTBOX_VERSION, items: this.items })
  }

  save() {
    const success = this.persist()
    if (!success) this.logger?.error(`出站队列写盘失败：${this.filePath}`)
    return success
  }

  pending() {
    return this.items.length
  }

  list({ limit = 50 } = {}) {
    const n = Math.max(1, Math.min(1000, Math.floor(toNumber(limit, 50))))
    return this.items.slice(0, n).map((x) => ({ ...x, segments: x.segments.map((s) => ({ ...s, data: { ...(s.data || {}) } })) }))
  }

  /**
   * 入队。
   * @returns {{ok: boolean, item?: object, deduped?: boolean, persisted?: boolean, dropped?: number}}
   */
  enqueue({ channel = DEFAULT_CHANNEL, qq, segments, reason = '', error = '', now = this.now(), ttlMs, dedupMs } = {}) {
    const ch = normalizeChannel(channel)
    const num = normalizePeer(ch, qq)
    const segmentList = Array.isArray(segments) ? segments.filter((x) => x && typeof x === 'object') : []
    if (!num) throw new Error(`入队失败：${peerProblem(ch, num)}`)
    if (!segmentList.length) throw new Error('入队失败：消息段为空')

    this.expire(now, { persist: false, quiet: true })

    const fingerprint = calcFingerprint(num, segmentList, ch)
    const window = dedupMs === undefined ? this.dedupMs() : Math.max(0, toNumber(dedupMs, 0))
    if (window > 0) {
      for (let i = this.items.length - 1; i >= 0; i--) {
        const item = this.items[i]
        if (item.fingerprint === fingerprint && now - item.createdAt <= window) {
          this.logger?.info(`出站队列已有同一条消息（id=${item.id}，积压 ${this.items.length} 条），不重复入队`)
          return { ok: true, item: item, deduped: true, persisted: true, dropped: 0 }
        }
      }
    }

    const alive = ttlMs === undefined ? this.ttlMs() : Math.max(1, toNumber(ttlMs, this.ttlMs()))
    const item = {
      id: randomUUID(),
      channel: ch,
      qq: num,
      segments: segmentList,
      createdAt: now,
      attempts: 0,
      nextAttemptAt: now,
      expiresAt: now + alive,
      reason: text(reason).slice(0, 200),
      fingerprint,
    }
    this.items.push(item)

    let dropCount = 0
    if (this.items.length > this.maxItems) {
      dropCount = this.items.length - this.maxItems
      const dropped = this.items.splice(0, dropCount)
      for (const x of dropped) {
        this.countEvent('dropped')
        this.logger?.warn(`出站队列已满（${this.maxItems} 条），丢弃最旧一条：peer=${x.channel}:${x.qq} id=${x.id} ${messageDigest(x.segments, 60)}`)
      }
    }
    const persisted = this.save()
    this.logger?.info(`已加入出站队列：peer=${ch}:${num} 原因=${item.reason || '发送失败'} 积压 ${this.items.length} 条 ${error ? `（${text(error).slice(0, 120)}）` : ''}`)
    return { ok: true, item: item, deduped: false, persisted, dropped: dropCount }
  }

  byId(id) {
    const key = text(id)
    return this.items.find((x) => x.id === key) || null
  }

  /** 删除单条（手动丢弃/不可恢复），计入 droppedTotal。 */
  drop(id, reason = '手动丢弃', { now = this.now(), quiet = false } = {}) {
    const key = text(id)
    const position = this.items.findIndex((x) => x.id === key)
    if (position < 0) return null
    const [item] = this.items.splice(position, 1)
    this.countEvent('dropped')
    if (!quiet) {
      this.logger?.warn(`出站消息被丢弃（${reason}）：peer=${item.channel}:${item.qq} id=${item.id} 创建于 ${new Date(item.createdAt).toISOString()} ${messageDigest(item.segments, 60)}`)
      this.save()
    }
    return item
  }

  /** 清空整个队列；返回清掉的条数。 */
  clear({ reason = '手动清空' } = {}) {
    const itemNumber = this.items.length
    if (!itemNumber) return 0
    for (const item of this.items) {
      this.countEvent('dropped')
      this.logger?.warn(`出站消息被丢弃（${reason}）：peer=${item.channel}:${item.qq} id=${item.id} ${messageDigest(item.segments, 60)}`)
    }
    this.items = []
    this.save()
    return itemNumber
  }

  /** 过期清理；返回清掉的条数。 */
  expire(now = this.now(), { persist = true, quiet = false } = {}) {
    const keep = []
    let dropCount = 0
    for (const item of this.items) {
      if (toNumber(item.expiresAt, Infinity) <= now) {
        dropCount++
        this.countEvent('dropped')
        if (!quiet) {
          this.logger?.warn(`出站消息过期（TTL ${Math.round(this.ttlMs() / 3600000)} 小时）：peer=${item.channel}:${item.qq} id=${item.id} ${messageDigest(item.segments, 60)}`)
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

  /** 队列里第一条可补发的消息；不跳过后面的，保证 FIFO。 */
  next({ now = this.now(), force = false } = {}) {
    this.expire(now, { persist: false, quiet: true })
    const first = this.items[0]
    if (!first) return null
    if (!force && toNumber(first.nextAttemptAt, 0) > now) return null
    return first
  }

  markSent(id) {
    const key = text(id)
    const position = this.items.findIndex((x) => x.id === key)
    if (position < 0) return null
    const [item] = this.items.splice(position, 1)
    this.count.sent += 1
    try {
      this.store?.noteOutboxSent?.()
      this.store?.save?.()
    } catch { /* 计数失败不影响队列 */ }
    this.save()
    return item
  }

  /**
   * 记一次发送失败。
   * @returns {{item: object|null, dropped: boolean, delayMs: number, attempts: number}}
   */
  markFailed(id, error = '', now = this.now()) {
    const item = this.byId(id)
    if (!item) return { item: null, dropped: false, delayMs: 0, attempts: 0 }
    item.attempts += 1
    this.countEvent('failed', error)
    const str = text(error).slice(0, 300)
    if (item.attempts >= OUTBOX_MAX_ATTEMPTS) {
      this.items = this.items.filter((x) => x.id !== item.id)
      this.countEvent('dropped')
      this.save()
      this.logger?.error(`出站消息尝试 ${item.attempts} 次仍失败，已放弃：peer=${item.channel}:${item.qq} id=${item.id} ${messageDigest(item.segments, 60)}｜${str}`)
      return { item: item, dropped: true, delayMs: 0, attempts: item.attempts }
    }
    const delay = backoffMs(item.attempts)
    item.nextAttemptAt = now + delay
    this.save()
    this.logger?.warn(`出站补发失败（第 ${item.attempts}/${OUTBOX_MAX_ATTEMPTS} 次，${Math.round(delay / 1000)} 秒后再试）：peer=${item.channel}:${item.qq} ${messageDigest(item.segments, 60)}｜${str}`)
    return { item: item, dropped: false, delayMs: delay, attempts: item.attempts }
  }

  status(now = this.now()) {
    const oldest = this.items.length
      ? Math.min(...this.items.map((x) => toNumber(x.createdAt, now)))
      : 0
    return {
      pending: this.items.length,
      oldestAgeSec: oldest ? Math.max(0, Math.floor((now - oldest) / 1000)) : 0,
      sentTotal: this.count.sent,
      failedTotal: this.count.failed,
      droppedTotal: this.count.dropped,
      lastError: this.count.lastError,
    }
  }
}

export { stableStringify }
