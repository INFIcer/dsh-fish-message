// fish.token 的可选接入层：峰时转任务队列、余额偏低提醒。
//
// fish-token 不是硬依赖：宿主只传一个惰性取值函数（形如 () => ctx.get('fish.token')）。
// 服务不存在 = 功能不可用：入站照旧直接投递，余额提醒什么都不做。
// 服务在但时段查不到（抛错 / 形状不对）按最保守的峰时处理——绝不自己算钟点或周末。
// 冻结契约（版本 1）：
//   api.getPricing(at?) -> { ok, period, peak, multiplier, … }   纯本地同步计算，不抛错
//   await api.enqueueTask({ prompt, sessionKey, channel, peer, source }) -> { ok, task }
//   api.subscribe(event => {}) -> off | undefined                余额低 / 时段切换
//   另有 getBalance / getStatus / listTasks / updateTask / removeTask / runTaskNow，本模块不用。
//
// 两个功能都不自己发消息：提醒走 Bridge 的发送链路（含出站队列与补发），
// 页面上的文案只来自 lib/config.js 一处。

import { balanceAlertModes, renderBalanceAlert } from './config.js'

/** 单次服务调用的等待上限：取计价是同步本地计算，只有入队要防服务不响应。 */
export const tokenTimeoutMs = 800

/** 余额提醒同一阈值的去重窗口：30 分钟内只转一次，避免刷屏。 */
export const balanceAlertDedupMs = 30 * 60 * 1000

/** 峰时标记：正文 trim 后以它开头就是「紧要」，无视峰时规则直接进会话。 */
export const urgentMarker = '【紧要】'

const toText = (value) => (value == null ? '' : String(value).trim())

/** 去掉开头的【紧要】标记；没写标记时原文不动（只认开头这一处）。 */
export function stripUrgentMarker(text) {
  const raw = String(text == null ? '' : text).trim()
  if (!raw.startsWith(urgentMarker)) return { urgent: false, text: raw }
  // 只剩标记（或者标记后面全是空白）时保留原文：否则整批会变成空消息，投不进会话。
  const rest = raw.slice(urgentMarker.length).trim()
  return { urgent: true, text: rest || raw }
}

/** 余额提醒方式：非法值按默认（message）处理，与 /save 的规整口径一致。 */
export function resolveBalanceAlertMode(value) {
  const mode = toText(value).toLowerCase()
  return balanceAlertModes.includes(mode) ? mode : 'message'
}

/** 按服务给的时区把时刻格式成 HH:MM；鱼讯只做展示，不参与峰谷计算。 */
function formatClock(at, timeZone) {
  const ms = Number(at)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'Asia/Hong_Kong',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(ms))
  } catch {
    return ''
  }
}

/**
 * 峰时提醒文案里的「下一段谷时」起止：起点取 nextOffPeakAt，终点取 nextPeakAt。
 * 时刻全部来自 fish.token 的 getPricing，鱼讯不自己判断现在是峰还是谷。
 */
export function offPeakWindowFromPricing(pricing) {
  const zone = String(pricing?.timezone || 'Asia/Hong_Kong')
  return {
    start: formatClock(pricing?.nextOffPeakAt, zone),
    end: formatClock(pricing?.nextPeakAt, zone),
  }
}

function withTimeout(promise, ms, action) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fish.token ${action}超时（${ms}ms）`)), ms)
    timer.unref?.()
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * 惰性持有 fish.token 服务。
 *
 * 服务晚加载也来得及：每次用时现取，取不到只记一次 debug（避免每条消息刷一条）。
 * 所有对外方法都不抛错：失败返回 null / { ok:false }，调用方按「功能不可用」退化。
 */
export class TokenLink {
  constructor({ getService, logger, timeoutMs = tokenTimeoutMs, now = () => Date.now() } = {}) {
    this.getService = typeof getService === 'function' ? getService : () => undefined
    this.logger = logger
    this.timeoutMs = Math.max(1, Number(timeoutMs) || tokenTimeoutMs)
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.unavailableLogged = false
  }

  /** 现取服务；缺失 / 抛错都返回 null，每进程只记一条 debug。 */
  service() {
    let service
    try {
      service = this.getService()
    } catch {
      service = null
    }
    if (!service) {
      if (!this.unavailableLogged) {
        this.unavailableLogged = true
        this.logger?.debug?.('没有检测到 fish.token 服务；峰时转任务与余额提醒不可用，收发照旧。')
      }
      return null
    }
    return service
  }

  /**
   * 当前计价时段。getPricing 是纯本地计算，直接同步调；
   * 没有服务、没有这个方法、抛错或返回形状不对都返回 null。这里只给设置页的状态行看，
   * 「现在算不算峰时」的判定走 peakNow()（拿不到时按最保守的峰时处理）。
   */
  pricing() {
    const service = this.service()
    if (!service || typeof service.getPricing !== 'function') return null
    try {
      const result = service.getPricing(this.now())
      return result && typeof result === 'object' ? result : null
    } catch (error) {
      this.logger?.debug?.(`读计价时段失败（状态行按未知处理）：${String(error?.message || error)}`)
      return null
    }
  }

  /**
   * 一次判定：现在是否峰时，连同这次拿到的计价快照（提醒文案的谷时时段要用）。
   *
   * 判定只来自 fish.token 的 getPricing，鱼讯不自己算钟点、周末或节假日
   * （窗口会随法定节假日 / 调休变化，自己算必然对不上）。
   *
   * @returns {{peak: boolean|null, pricing: object|null}}
   *   - peak=null：服务或方法不存在 = 功能不可用，调用方照旧直接投递；
   *   - peak=true：查询说峰时；查询抛错或返回形状不对（拿不到）也按最保守的峰时处理，
   *     此时 pricing 可能为空（文案占位符会回退内置默认）；
   *   - peak=false：查询明确说谷时。
   */
  pricingDecision() {
    const service = this.service()
    if (!service || typeof service.getPricing !== 'function') return { peak: null, pricing: null }
    try {
      const result = service.getPricing(this.now())
      if (!result || typeof result !== 'object' || typeof result.peak !== 'boolean') {
        this.logger?.debug?.('计价时段拿不到（返回形状不对），按峰时处理。')
        return { peak: true, pricing: null }
      }
      return { peak: result.peak === true, pricing: result }
    } catch (error) {
      // 拿不到时段不能当成谷时：那会在峰时白跑贵任务。最保守的做法是当峰时。
      this.logger?.debug?.(`读计价时段失败（按峰时处理）：${String(error?.message || error)}`)
      return { peak: true, pricing: null }
    }
  }

  /** 现在是不是峰时；语义见 pricingDecision()。 */
  peakNow() {
    return this.pricingDecision().peak
  }

  /**
   * 把一批消息收进非紧要任务队列。
   * @returns {Promise<{ok:boolean, task?:object, error?:string}>} 任何失败都带 ok:false
   */
  async enqueueTask(payload) {
    const service = this.service()
    if (!service || typeof service.enqueueTask !== 'function') {
      return { ok: false, error: 'fish.token 没有 enqueueTask' }
    }
    try {
      const result = await withTimeout(service.enqueueTask(payload), this.timeoutMs, '入队')
      if (!result || typeof result !== 'object') return { ok: false, error: '没有返回结果' }
      return result
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  /**
   * 订阅余额 / 时段事件。
   * @returns {Function|null} 取消函数；没有 subscribe 或订阅失败返回 null
   */
  subscribe(handler) {
    const service = this.service()
    if (!service || typeof service.subscribe !== 'function') {
      this.logger?.debug?.('fish.token 没有 subscribe；余额提醒订阅跳过。')
      return null
    }
    try {
      const off = service.subscribe((event) => {
        try {
          handler(event)
        } catch (error) {
          this.logger?.warn?.(`处理 fish.token 事件失败（不影响收发）：${String(error?.message || error)}`)
        }
      })
      return typeof off === 'function' ? off : null
    } catch (error) {
      this.logger?.warn?.(`订阅 fish.token 事件失败（不影响收发）：${String(error?.message || error)}`)
      return null
    }
  }
}

/**
 * 余额偏低 → 往当前粘性送信渠道回一条提醒。
 *
 * 目标取状态文件 replyTargets 里最近更新的那一间会话的渠道：没有渠道就跳过，
 * 绝不退回默认渠道（那等于发给一个没在对话的人）。
 * 文字走 Bridge.sendText（直发失败自动进 Outbox 补发）；表情走注入的 sendSticker，
 * 宿主传的就是 fish_sticker_send 那条路（StickerStore.resolve + Bridge.sendOutbound）。
 */
export class BalanceAlertForwarder {
  constructor({
    bridge,
    getConfig,
    logger,
    sendSticker = null,
    now = () => Date.now(),
    dedupMs = balanceAlertDedupMs,
  } = {}) {
    this.bridge = bridge
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({})
    this.logger = logger
    this.sendSticker = typeof sendSticker === 'function' ? sendSticker : null
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.dedupMs = Math.max(0, Number(dedupMs) || 0)
    // 阈值 → 上次转发时刻：同一阈值在窗口内只转一次。
    this.seen = new Map()
  }

  /** 当前送信渠道（最近一次投递成功的那条）。 */
  target() {
    if (!this.bridge || typeof this.bridge.latestReplyTarget !== 'function') return null
    return this.bridge.latestReplyTarget()
  }

  /**
   * 处理一条 fish.token 事件。只认 balance-low；其它事件忽略。
   * @returns {Promise<{ok:boolean, mode?:string, skipped?:string, text?:string, error?:string}>}
   */
  async handle(event) {
    if (!event || event.type !== 'balance-low') return { ok: false, skipped: 'event' }
    const config = this.getConfig() || {}
    const mode = resolveBalanceAlertMode(config.balanceAlertMode)
    if (mode === 'off') return { ok: false, skipped: 'off' }
    const threshold = Number(event.threshold)
    const key = Number.isFinite(threshold) ? String(threshold) : toText(event.threshold)
    const now = this.now()
    const prev = Number(this.seen.get(key)) || 0
    if (this.dedupMs > 0 && prev && now - prev < this.dedupMs) {
      this.logger?.debug?.(`余额提醒（阈值 ${key}）刚转过，同一窗口内不再转。`)
      return { ok: false, skipped: 'dedupe' }
    }
    const target = this.target()
    if (!target || !target.peer) {
      this.logger?.debug?.('余额提醒没有送信渠道（还没人发过消息），跳过。')
      return { ok: false, skipped: 'no-target' }
    }
    this.seen.set(key, now)

    const balance = Number(event.balance)
    if (mode === 'sticker') {
      const name = toText(config.balanceAlertSticker)
      if (name && this.sendSticker) {
        try {
          const result = await this.sendSticker({ ...target }, name)
          if (result?.ok !== false) {
            this.logger?.info?.(`余额提醒已发到 ${target.channel} ${target.peer}（表情 ${name}）`)
            return { ok: true, mode: 'sticker' }
          }
          this.logger?.warn?.(`余额提醒表情没发出去（改发文字）：${toText(result?.error) || '未知原因'}`)
        } catch (error) {
          this.logger?.warn?.(`余额提醒表情没发出去（改发文字）：${String(error?.hint || error?.message || error)}`)
        }
      }
    }

    const text = renderBalanceAlert(config.balanceAlertTemplate, balance)
    if (!this.bridge || typeof this.bridge.sendText !== 'function') {
      return { ok: false, skipped: 'no-bridge', text }
    }
    try {
      const result = await this.bridge.sendText(target.peer, text, { channel: target.channel })
      this.logger?.info?.(`余额提醒已发到 ${target.channel} ${target.peer}：${text}${result?.queued ? '（已入队）' : ''}`)
      return { ok: true, mode: 'message', text, queued: Boolean(result?.queued) }
    } catch (error) {
      const message = String(error?.message || error)
      this.logger?.warn?.(`余额提醒没发出去：${message}`)
      return { ok: false, mode: 'message', text, error: message }
    }
  }
}
