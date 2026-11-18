// 出站待发态（inflight）：消息在「发送前的节奏等待」期间只存在于内存，进程这时被杀就丢了。
// 所以进入等待前先写这里，发送成功后立刻删；发送失败转给 Outbox（带退避/去重/TTL），
// 这里不再保留同一条，避免同一份内容双份重发。
//
// 与 Outbox 的分工：
//   - Outbox 负责「已经确定发不出去、等以后补发」的积压，按 FIFO + 退避；
//   - Inflight 只覆盖「正在发、还没有结果」的短窗口，通常 0~1 条，重启后按 seq 回放。
//
// 两种记录形状：
//   { segments: [...] }  已经解析好的消息段（sendOutbound 直发、多段消息）
//   { tokens: [...] }    一轮还没解析的 [MSG] 块/指令 token，回放时再解析
// tokens 记录让「一轮多段」在重启后仍能按原顺序补齐；解析仍发生在发送前一刻，
// 所以正常发送不会因为记录而提前合成语音、也不会改变等待时机。
//
// 回放遵守 dueAt：记录的是「这条消息预计什么时候该发」，重启时只补等剩余部分，
// 不把已经等过的时间再等一遍。超过 TTL 的记录按 Outbox 同样的口径丢弃并计数。

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { quarantineFile, readJsonWithBackup, writeJsonAtomic } from './fs-util.js'
import { DEFAULT_TTL_HOURS, messageDigest } from './outbox.js'
import { DEFAULT_CHANNEL, normalizeChannel, normalizePeer, peerProblem } from './peer.js'

export const INFLIGHT_VERSION = 1
export const INFLIGHT_MAX_ITEMS = 100

const toNumber = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const text = (value) => String(value == null ? '' : value)

/** tokens 记录的日志摘要：只给类型和文字，不展开内部结构。 */
function tokensDigest(tokens, max = 120) {
  const list = Array.isArray(tokens) ? tokens : []
  const part = list.map((token) => {
    const kind = text(token?.type || '未知')
    if (kind === 'text') return text(token?.text)
    if (kind === 'image') return `[图片] ${text(token?.path)}`
    if (kind === 'file') return `[文件] ${text(token?.path)}`
    if (kind === 'voiceFile') return `[语音文件] ${text(token?.path)}`
    if (kind === 'tts' || kind === 'ttsMoved') return `[语音] ${text(token?.text)}`
    if (kind === 'sticker') return `[表情] ${text(token?.name)}`
    return `[${kind}]`
  })
  const str = part.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  return str.length > max ? `${str.slice(0, max)}…` : str
}

export class InflightQueue {
  constructor({
    homeDir,
    fileName = 'fish-message-inflight.json',
    getConfig = () => ({}),
    logger,
    store,
    now = () => Date.now(),
    maxItems = INFLIGHT_MAX_ITEMS,
    ttlMs,
  } = {}) {
    this.homeDir = homeDir
    this.filePath = join(homeDir, fileName)
    this.getConfig = getConfig
    this.logger = logger
    this.store = store
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.maxItems = Math.max(1, Math.floor(toNumber(maxItems, INFLIGHT_MAX_ITEMS)))
    this.ttlMsOverride = toNumber(ttlMs, 0)
    this.items = []
    this.nextSeq = 1
    this.load()
  }

  /** 与出站队列共用同一个 TTL 设置（默认 24 小时），方便一起解释过期口径。 */
  ttlMs() {
    if (this.ttlMsOverride > 0) return this.ttlMsOverride
    const hour = toNumber(this.getConfig()?.outboxTtlHours, DEFAULT_TTL_HOURS)
    return Math.max(1, hour) * 3600 * 1000
  }

  load() {
    const disk = readJsonWithBackup(this.filePath, null, { logger: this.logger, label: '待发消息文件' })
    if (!disk || typeof disk !== 'object' || !Array.isArray(disk.items)) {
      // 解析失败已由 readJsonWithBackup 留档；结构不对的也留档，别让下一次保存覆盖证据。
      if (disk) quarantineFile(this.filePath, { logger: this.logger, label: '待发消息文件', reason: '结构不认识' })
      this.items = []
      return this.items
    }
    const now = this.now()
    const originalCount = disk.items.length
    this.items = disk.items
      .map((x) => this.normalizeEntry(x, now))
      .filter(Boolean)
      .sort((a, b) => (a.seq - b.seq) || (a.createdAt - b.createdAt))
    if (this.items.length > this.maxItems) {
      const excess = this.items.length - this.maxItems
      const dropped = this.items.splice(0, excess)
      for (const item of dropped) this.countDropped(item, '超过待发记录上限')
    }
    const maxSeq = this.items.reduce((max, item) => Math.max(max, item.seq), 0)
    this.nextSeq = maxSeq + 1
    const expired = this.expire(now, { persist: false, quiet: true })
    if (originalCount !== this.items.length || expired) {
      this.save()
      this.logger?.info(`待发消息已加载：${this.items.length} 条待回放（启动时清理 ${originalCount - this.items.length} 条无效/过期）`)
    } else if (this.items.length) {
      this.logger?.info(`待发消息已加载：${this.items.length} 条待回放`)
    }
    return this.items
  }

  normalizeEntry(original, now) {
    if (!original || typeof original !== 'object') return null
    // 老记录没有 channel，按 qq 读；qq 字段一直是对端原串。
    const channel = normalizeChannel(original.channel)
    const qq = normalizePeer(channel, original.qq || original.peer)
    if (!qq) return null
    const segments = Array.isArray(original.segments)
      ? original.segments.filter((x) => x && typeof x === 'object')
      : []
    const tokens = Array.isArray(original.tokens)
      ? original.tokens.filter((x) => x && typeof x === 'object')
      : []
    // 一条记录可以同时有「当前这条消息还没发的段」和「后面还没解析的 token」：
    // 一轮多段时，当前 token 的段进度和后半轮 token 要一起跨重启保留。两种都空就没有意义。
    if (!segments.length && !tokens.length) return null
    const createdAt = toNumber(original.createdAt, now)
    const expiresAt = toNumber(original.expiresAt, createdAt + this.ttlMs())
    return {
      id: text(original.id) || randomUUID(),
      channel,
      qq,
      ...(segments.length ? { segments } : {}),
      ...(tokens.length ? { tokens } : {}),
      createdAt,
      dueAt: toNumber(original.dueAt, createdAt),
      expiresAt,
      seq: Math.max(0, Math.floor(toNumber(original.seq, 0))),
      reason: text(original.reason).slice(0, 200),
    }
  }

  persist() {
    return writeJsonAtomic(this.filePath, { version: INFLIGHT_VERSION, items: this.items })
  }

  save() {
    const success = this.persist()
    if (!success) this.logger?.error(`待发记录写盘失败：${this.filePath}`)
    return success
  }

  pending() {
    return this.items.length
  }

  list({ limit = 100 } = {}) {
    const n = Math.max(1, Math.min(1000, Math.floor(toNumber(limit, 100))))
    return this.items.slice(0, n).map((item) => ({
      ...item,
      ...(item.segments ? { segments: item.segments.map((s) => ({ ...s, data: { ...(s.data || {}) } })) } : {}),
      ...(item.tokens ? { tokens: item.tokens.map((t) => ({ ...t })) } : {}),
    }))
  }

  byId(id) {
    const key = text(id)
    return this.items.find((item) => item.id === key) || null
  }

  /**
   * 进入节奏等待前落一条待发记录。
   * @returns {object|null} 记录本体；写盘失败也返回（内存里仍可继续更新/删除），只是换进程会丢。
   */
  add({ channel = DEFAULT_CHANNEL, qq, segments, tokens, dueAt, ttlMs, reason = '' } = {}) {
    const ch = normalizeChannel(channel)
    const num = normalizePeer(ch, qq)
    // 对端不认识就报错：待发记录是「已经在内存里等着发」的消息，静默丢掉等于丢消息。
    if (!num) throw new Error('待发记录失败：' + peerProblem(ch, num))
    const segmentList = Array.isArray(segments) ? segments.filter((x) => x && typeof x === 'object') : []
    const tokenList = Array.isArray(tokens) ? tokens.filter((x) => x && typeof x === 'object') : []
    if (!segmentList.length && !tokenList.length) return null

    const now = this.now()
    this.expire(now, { persist: false, quiet: true })
    const alive = ttlMs === undefined ? this.ttlMs() : Math.max(1, toNumber(ttlMs, this.ttlMs()))
    const item = {
      id: randomUUID(),
      channel: ch,
      qq: num,
      ...(segmentList.length ? { segments: segmentList } : {}),
      ...(tokenList.length ? { tokens: tokenList } : {}),
      createdAt: now,
      dueAt: Math.max(0, toNumber(dueAt, now)),
      expiresAt: now + alive,
      seq: this.nextSeq++,
      reason: text(reason).slice(0, 200),
    }
    this.items.push(item)
    let dropped = 0
    if (this.items.length > this.maxItems) {
      dropped = this.items.length - this.maxItems
      const oldest = this.items.splice(0, dropped)
      for (const x of oldest) this.countDropped(x, '超过待发记录上限')
    }
    const persisted = this.save()
    this.logger?.info(`已记录待发消息：peer=${ch}:${num} ${segmentList.length ? messageDigest(segmentList, 80) : tokensDigest(tokenList, 80)}（${persisted ? '已落盘' : '落盘失败'}）`)
    return { ...item, persisted, dropped }
  }

  /** 发送前逐段/逐个 token 收敛记录：只保留还没发出去的部分，并更新预计发送时间。 */
  update(id, patch = {}) {
    const item = this.byId(id)
    if (!item) return null
    // segments 与 tokens 可以同时存在：前者是当前消息还没发的段，后者是后面还没解析的 token。
    // 传空数组等于清掉这一部分，传 undefined 才是保持不动。
    if (patch.segments !== undefined) {
      const list = Array.isArray(patch.segments) ? patch.segments.filter((x) => x && typeof x === 'object') : []
      if (list.length) item.segments = list
      else delete item.segments
    }
    if (patch.tokens !== undefined) {
      const list = Array.isArray(patch.tokens) ? patch.tokens.filter((x) => x && typeof x === 'object') : []
      if (list.length) item.tokens = list
      else delete item.tokens
    }
    if (patch.dueAt !== undefined) item.dueAt = Math.max(0, toNumber(patch.dueAt, item.dueAt))
    if (patch.expiresAt !== undefined) item.expiresAt = toNumber(patch.expiresAt, item.expiresAt)
    if (patch.reason !== undefined) item.reason = text(patch.reason).slice(0, 200)
    this.save()
    return item
  }

  /** 发送成功（或已经转交 Outbox）后立刻删除。 */
  remove(id) {
    const key = text(id)
    const position = this.items.findIndex((item) => item.id === key)
    if (position < 0) return null
    const [item] = this.items.splice(position, 1)
    this.save()
    return item
  }

  /** 过期清理；返回清掉的条数。口径与 Outbox 一致：TTL 到期丢弃并计数。 */
  expire(now = this.now(), { persist = true, quiet = false } = {}) {
    const keep = []
    let dropCount = 0
    for (const item of this.items) {
      if (toNumber(item.expiresAt, Infinity) <= now) {
        dropCount++
        this.countDropped(item, `超过 TTL（${Math.round(this.ttlMs() / 3600000)} 小时）`, { quiet })
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

  countDropped(item, reason, { quiet = false } = {}) {
    try {
      this.store?.noteOutboxDropped?.()
      this.store?.save?.()
    } catch { /* 计数失败不影响待发记录本身 */ }
    if (!quiet) {
      this.logger?.warn(`待发消息被丢弃（${reason}）：peer=${item?.channel}:${item?.qq} id=${item?.id} ${item?.segments ? messageDigest(item.segments, 60) : tokensDigest(item?.tokens, 60)}`)
    }
  }

  status() {
    return {
      pending: this.items.length,
      oldestAgeSec: this.items.length
        ? Math.max(0, Math.floor((this.now() - Math.min(...this.items.map((x) => toNumber(x.createdAt, this.now())))) / 1000))
        : 0,
    }
  }
}

export { tokensDigest }
