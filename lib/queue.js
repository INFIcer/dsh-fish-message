// 每个聊天的乱序缓冲队列。
//
// 为什么需要它：WebSocket 事件和 HTTP 历史补投可能交错到达，顺序不保证。
// 收到消息后先压一小会儿（默认 1.5 秒），再按「时间 → message_seq → message_id」排序处理。
// 同一 message_id 在队列里只留一份。

const sortKey = (m) => {
  const time = Number(m?.time) || 0
  const seq = Number(m?.message_seq) || 0
  const id = Number(m?.message_id)
  return [time, seq, Number.isFinite(id) ? id : 0]
}

function compare(a, b) {
  const A = sortKey(a)
  const B = sortKey(b)
  for (let i = 0; i < A.length; i++) {
    if (A[i] !== B[i]) return A[i] - B[i]
  }
  return String(a?.message_id ?? '').localeCompare(String(b?.message_id ?? ''))
}

export class MessageQueue {
  constructor({ bufferMs = 1500, maxWaitMs = 6000, onBatch, logger }) {
    this.bufferMs = Math.max(0, Number(bufferMs) || 0)
    this.maxWaitMs = Math.max(this.bufferMs, Number(maxWaitMs) || 6000)
    this.onBatch = onBatch
    this.logger = logger
    this.pending = new Map()
    this.timers = new Map()
    this.firstAt = new Map()
    this.flushing = new Set()
    this.closed = false
  }

  setBuffer(ms) {
    this.bufferMs = Math.max(0, Number(ms) || 0)
    this.maxWaitMs = Math.max(this.bufferMs, this.maxWaitMs)
  }

  /** @returns {boolean} true = 新加入；false = 队列里已有同一个 id */
  enqueue(key, message) {
    if (this.closed) return false
    const id = String(message?.message_id ?? '')
    if (!id) return false
    let bucket = this.pending.get(key)
    if (!bucket) {
      bucket = new Map()
      this.pending.set(key, bucket)
    }
    if (bucket.has(id)) return false
    bucket.set(id, message)
    this.schedule(key)
    return true
  }

  has(key, id) {
    return Boolean(this.pending.get(key)?.has(String(id)))
  }

  schedule(key) {
    clearTimeout(this.timers.get(key))
    if (!this.firstAt.has(key)) this.firstAt.set(key, Date.now())
    const waited = Date.now() - (this.firstAt.get(key) || Date.now())
    const wait = Math.max(0, Math.min(this.bufferMs, this.maxWaitMs - waited))
    const timer = setTimeout(() => {
      this.timers.delete(key)
      void this.flush(key)
    }, wait)
    try { timer.unref?.() } catch { /* 忽略 */ }
    this.timers.set(key, timer)
  }

  async flush(key) {
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
    this.firstAt.delete(key)
    if (this.flushing.has(key)) return
    const bucket = this.pending.get(key)
    if (!bucket || !bucket.size) return
    this.pending.delete(key)
    const batch = [...bucket.values()].sort(compare)
    this.flushing.add(key)
    try {
      await this.onBatch?.(key, batch)
    } catch (error) {
      this.logger?.error(`处理 ${key} 的消息批次失败：${String(error?.message || error)}`)
    } finally {
      this.flushing.delete(key)
    }
  }

  async flushAll() {
    const keys = [...this.pending.keys()]
    for (const key of keys) await this.flush(key)
  }

  size() {
    let n = 0
    for (const bucket of this.pending.values()) n += bucket.size
    return n
  }

  clear() {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.pending.clear()
    this.firstAt.clear()
    this.closed = true
  }
}

export { compare as sortMessages }
