// 每个聊天的入站缓冲队列。
//
// 它同时负责两件事：
//
// 1. 乱序缓冲：WebSocket 事件和 HTTP 历史补投可能交错到达，顺序不保证。
//    同一批消息要按「时间 → message_seq → message_id」排序后再交给上层。
//
// 2. 编辑窗口：主人连发几条、或者发完又撤回时，太早投递就会把半截内容送进会话。
//    所以从「最后一条消息」开始静默 editWindowMs 后才 flush；期间每来一条新消息
//    就重新计时。窗口开着时没有最长等待上限——上限式的强制 flush 会把窗口截断。
//
// 计时基准是消息自带的发送时间戳（OneBot 的 time，秒），不是「拉到这条消息的时刻」：
// 离线补拉的历史可能已经很旧，按拉到时刻算会把早该过期的消息当成新消息压住窗口。
// 时间戳缺失（0）时才退回到达时刻。
//
// 静默期取 max(编辑窗口, 乱序缓冲)：编辑窗口为 0 时完全退回旧行为
// （等 bufferMs，最长等 maxWaitMs，防止有人一直发导致永远不 flush）。
//
// 同一 message_id 在队列里只留一份；撤回时用 remove() 直接从待投里删掉，
// 删空就清定时器、不触发 onBatch——被撤回的消息从未投递，也不该进水位。

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
  constructor({
    bufferMs = 1500,
    maxWaitMs = 6000,
    editWindowMs = 0,
    onBatch,
    logger,
    now = () => Date.now(),
    timers = null,
  } = {}) {
    this.bufferMs = Math.max(0, Number(bufferMs) || 0)
    this.editWindowMs = Math.max(0, Number(editWindowMs) || 0)
    // 编辑窗口开着时不要最长等待上限（否则 15 秒窗口会被 6 秒上限截断）。
    this.maxWaitMs = this.editWindowMs > 0 ? 0 : Math.max(this.bufferMs, Number(maxWaitMs) || 6000)
    this.onBatch = onBatch
    this.logger = logger
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.timers = timers && typeof timers.setTimeout === 'function'
      ? timers
      : { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) }
    this.pending = new Map()
    this.timersByKey = new Map()
    this.firstAt = new Map()
    // 每个聊天当前批次的计时基准（毫秒）：最后一条消息的发送时间戳，缺时间戳时是到达时刻。
    this.baseAt = new Map()
    this.flushing = new Set()
    this.closed = false
  }

  /** 配置热更新：缓冲、编辑窗口一起换，窗口开关会同步切换最长等待策略。 */
  configure({ bufferMs, editWindowMs, maxWaitMs } = {}) {
    if (bufferMs !== undefined) this.bufferMs = Math.max(0, Number(bufferMs) || 0)
    if (editWindowMs !== undefined) this.editWindowMs = Math.max(0, Number(editWindowMs) || 0)
    this.maxWaitMs = this.editWindowMs > 0
      ? 0
      : Math.max(this.bufferMs, Number(maxWaitMs) || 6000)
  }

  /** 静默期：最后一条消息之后等这么久再 flush。 */
  quietMs() {
    return this.editWindowMs > 0 ? Math.max(this.editWindowMs, this.bufferMs) : this.bufferMs
  }

  /**
   * @param {{notBefore?: number}} options notBefore = 最早何时可以 flush（毫秒时间戳）。
   *   投递失败重排队时用：按消息时间戳算的话窗口早就过期了，会立刻重试、变成空转，
   *   所以重排队时至少再等一个窗口。
   * @returns {boolean} true = 新加入；false = 队列里已有同一个 id
   */
  enqueue(key, message, { notBefore = 0 } = {}) {
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
    this.schedule(key, message, notBefore)
    return true
  }

  has(key, id) {
    return Boolean(this.pending.get(key)?.has(String(id)))
  }

  /**
   * 撤回：把还没投递的消息从队列里删掉。
   * @returns {boolean} true = 队列里确实有这条并已删除
   */
  remove(key, id) {
    const name = String(key)
    const bucket = this.pending.get(name)
    if (!bucket || !bucket.delete(String(id))) return false
    if (bucket.size) return true
    // 删空了：清掉定时器，不触发 onBatch。
    this.pending.delete(name)
    this.timers.clearTimeout(this.timersByKey.get(name))
    this.timersByKey.delete(name)
    this.firstAt.delete(name)
    this.baseAt.delete(name)
    return true
  }

  schedule(key, message = null, notBefore = 0) {
    this.timers.clearTimeout(this.timersByKey.get(key))
    const at = this.now()
    if (!this.firstAt.has(key)) this.firstAt.set(key, at)
    let wait = this.quietMs()
    if (this.editWindowMs > 0) {
      // 基准只往前走：乱序到达的旧消息不能把窗口往后拉。
      const sentAt = Number(message?.time) > 0 ? Number(message.time) * 1000 : 0
      const base = Math.max(this.baseAt.get(key) || 0, sentAt) || at
      this.baseAt.set(key, base)
      wait = Math.max(0, base + this.quietMs() - at)
    }
    // notBefore 只把时间往后推，不能提前 flush。
    if (Number(notBefore) > at) wait = Math.max(wait, Number(notBefore) - at)
    if (this.maxWaitMs > 0) {
      const waited = at - (this.firstAt.get(key) || at)
      wait = Math.max(0, Math.min(wait, this.maxWaitMs - waited))
    }
    const timer = this.timers.setTimeout(() => {
      this.timersByKey.delete(key)
      void this.flush(key)
    }, wait)
    try { timer.unref?.() } catch { /* 注入的假定时器没有 unref */ }
    this.timersByKey.set(key, timer)
  }

  async flush(key) {
    this.timers.clearTimeout(this.timersByKey.get(key))
    this.timersByKey.delete(key)
    this.firstAt.delete(key)
    this.baseAt.delete(key)
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
    for (const t of this.timersByKey.values()) this.timers.clearTimeout(t)
    this.timersByKey.clear()
    this.pending.clear()
    this.firstAt.clear()
    this.baseAt.clear()
    this.closed = true
  }
}

export { compare as sortMessages }
