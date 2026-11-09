// 每个聊天的乱序缓冲队列。
//
// 为什么需要它：WebSocket 事件和 HTTP 历史补投可能交错到达，顺序不保证。
// 收到消息后先压一小会儿（默认 1.5 秒），再按「时间 → message_seq → message_id」排序处理。
// 同一 message_id 在队列里只留一份。

const 排序键 = (m) => {
  const 时间 = Number(m?.time) || 0
  const 序号 = Number(m?.message_seq) || 0
  const id = Number(m?.message_id)
  return [时间, 序号, Number.isFinite(id) ? id : 0]
}

function 比较(a, b) {
  const A = 排序键(a)
  const B = 排序键(b)
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
    let 桶 = this.pending.get(key)
    if (!桶) {
      桶 = new Map()
      this.pending.set(key, 桶)
    }
    if (桶.has(id)) return false
    桶.set(id, message)
    this.schedule(key)
    return true
  }

  has(key, id) {
    return Boolean(this.pending.get(key)?.has(String(id)))
  }

  schedule(key) {
    clearTimeout(this.timers.get(key))
    if (!this.firstAt.has(key)) this.firstAt.set(key, Date.now())
    const 已等 = Date.now() - (this.firstAt.get(key) || Date.now())
    const 等 = Math.max(0, Math.min(this.bufferMs, this.maxWaitMs - 已等))
    const 定时 = setTimeout(() => {
      this.timers.delete(key)
      void this.flush(key)
    }, 等)
    try { 定时.unref?.() } catch { /* 忽略 */ }
    this.timers.set(key, 定时)
  }

  async flush(key) {
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
    this.firstAt.delete(key)
    if (this.flushing.has(key)) return
    const 桶 = this.pending.get(key)
    if (!桶 || !桶.size) return
    this.pending.delete(key)
    const 批 = [...桶.values()].sort(比较)
    this.flushing.add(key)
    try {
      await this.onBatch?.(key, 批)
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
    for (const 桶 of this.pending.values()) n += 桶.size
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

export { 比较 as sortMessages }
