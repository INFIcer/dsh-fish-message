// 出站节奏：把一条消息折算成「字数」，再换算成它与上一条消息之间至少隔多久，
// 让 QQ 那头看起来像在一条条打字，而不是瞬间刷屏。
//
// 判定口径是「和上一条消息真正发出的时刻比」：间隔已经够了就立刻发，不够只补等剩下的。
// 所以空闲很久之后的第一条消息不等（本来就不像刷屏），连发的几条之间才拉开间隔。
//
// 只负责算和等，不碰网络、不改发送顺序：等待发生在发送串行锁里（Bridge.dispatch），
// 所以「哪条先等完」决定「哪条先发」，顺序天然不变；入站流程完全不受影响。
//
// 字数口径（一个段 = 一个 QQ 气泡）：
//   - 中文、日文、韩文等表意文字：每个字 1；
//   - 拉丁等拼音文字：连续一串字母算 1 个词，不按字母算；
//   - 连续数字：整串算 1（「1998」不按 4 个字算）；
//   - 标点、空白、符号、emoji：0.2；
//   - 图片、文件、语音文件段：0（没有可读的正文）；
//   - 语音文本（record_text）：按其中文本算。

/** 表意文字：中文、假名、谚文。 */
const IDEOGRAPH = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const LETTER = /\p{L}/u
const WORD_CHAR = /[\p{L}\p{M}]/u
const DIGIT = /\p{Nd}/u

/**
 * 一段文本折算成多少个字。
 * @returns {number} 0 起步，最小刻度 0.2（标点每 5 个正好等于 1 个字）。
 *
 * 内部按「十分之一个字」的整数累加，最后再除：0.2 用浮点加会攒出
 * 3.4000000000000004 这种尾巴，字数口径又是要给人看的，所以不让它出现。
 */
export function countTextUnits(value) {
  const chars = [...String(value == null ? '' : value)]
  let tenths = 0
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]
    if (IDEOGRAPH.test(ch)) {
      tenths += 10
      i += 1
      continue
    }
    if (LETTER.test(ch)) {
      // 吃掉整个单词：后面的字母/组合符号都算在这一个词里。
      i += 1
      while (i < chars.length && WORD_CHAR.test(chars[i]) && !IDEOGRAPH.test(chars[i])) i += 1
      tenths += 10
      continue
    }
    if (DIGIT.test(ch)) {
      i += 1
      while (i < chars.length && DIGIT.test(chars[i])) i += 1
      tenths += 10
      continue
    }
    tenths += 2
    i += 1
  }
  return tenths / 10
}

/**
 * 一个出站消息段折算成多少个字。
 * 未知段类型按 0 算：宁可不等，也不凭猜测多等。
 */
export function countSegmentUnits(segment) {
  const kind = String(segment?.type || '')
  const d = segment?.data && typeof segment.data === 'object' ? segment.data : {}
  if (kind === 'text' || kind === 'record_text') return countTextUnits(d.text)
  if (kind === 'image' || kind === 'file' || kind === 'record' || kind === 'record_file') return 0
  return 0
}

/**
 * 一条消息与上一条之间至少隔多久：固定间隔 + 字数 × 逐字间隔。
 * @param {Array<object>|object} segments 一个段或段数组（一条 QQ 消息）
 */
export function outboundIntervalMs(segments, { perMessageMs = 0, perCharMs = 0 } = {}) {
  const list = Array.isArray(segments) ? segments : [segments]
  const units = list.reduce((sum, segment) => sum + countSegmentUnits(segment), 0)
  const interval = (Number(perMessageMs) || 0) + units * (Number(perCharMs) || 0)
  return interval > 0 ? Math.round(interval) : 0
}

/**
 * 发送节奏的执行者：按当前配置算「与上一条的最小间隔」，再跟「上一条真正发出的时刻」比。
 * sleep / now 可注入，测试里不会真等 15 秒。
 */
export class OutboundPacer {
  constructor({
    getConfig = () => ({}),
    logger = null,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    this.getConfig = getConfig
    this.logger = logger
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.sleep = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    // 上一条消息真正发出的时刻；null = 本进程还没发过，下一条不必等。
    // 进程重启后归零：停机本身已经隔开很久了，重启后的第一条也不该再等。
    this.lastSentAt = null
  }

  /** 这条消息与上一条至少隔多久（毫秒）；配置全是 0 时返回 0。 */
  intervalFor(segment) {
    const config = this.getConfig() || {}
    return outboundIntervalMs([segment], {
      perMessageMs: config.outboxPerMessageDelayMs,
      perCharMs: config.outboxPerCharDelayMs,
    })
  }

  /**
   * 这条消息最早什么时候能发（绝对时间戳）。
   * 距上一条发出已经超过间隔时返回「现在」——空闲之后的第一条因此立刻发。
   */
  dueAtFor(segment) {
    const now = this.now()
    const interval = this.intervalFor(segment)
    if (interval <= 0) return now
    if (this.lastSentAt === null) return now
    return Math.max(now, this.lastSentAt + interval)
  }

  /** 记下「这一条真的发出去了」的时刻；下一条的间隔从这里算起。 */
  markSent(at) {
    const value = Number(at)
    this.lastSentAt = Number.isFinite(value) ? value : this.now()
  }

  /**
   * 发下一条前等：只补等「间隔还差的那一段」，已经够了就立刻返回。
   * @returns {Promise<number>} 实际等待的毫秒数（没开节奏或 sleep 被注入成瞬时就是 0）
   */
  async wait(segment) {
    const delay = Math.round(this.dueAtFor(segment) - this.now())
    if (delay <= 0) return 0
    this.logger?.debug(`出站节奏：${String(segment?.type || '未知')} 段距上一条还差 ${delay}ms`)
    const startedAt = this.now()
    await this.sleep(delay)
    return Math.max(0, this.now() - startedAt)
  }

  /**
   * 等到一个绝对时间点；回放重启前留下的待发消息时用。
   * 记录里的 dueAt 是「预计该发」的时刻：进程重启时可能已经过去，也可能还剩一点，
   * 这里只补等剩余部分，不会把已经等过的时间重等一遍。
   * @returns {Promise<number>} 实际等待的毫秒数
   */
  async waitUntil(at) {
    const target = Number(at)
    if (!Number.isFinite(target)) return 0
    const delay = Math.round(target - this.now())
    if (delay <= 0) return 0
    this.logger?.debug(`待发消息回放：等到 ${new Date(target).toISOString()}（再等 ${delay}ms）`)
    const startedAt = this.now()
    await this.sleep(delay)
    return Math.max(0, this.now() - startedAt)
  }
}
