/**
 * 防失联守卫：让绑定了消息渠道的会话一直能收发消息。
 *
 * 三件事：
 * 1) 挡掉一定会让人干等的工具（提问、干等），模型会收到一句人话错误；
 * 2) 往绑定会话的提示词里补几条代码管不到的约定：回复落在 [MSG] 块里、要拍板发消息、
 *    长任务派子代理；
 * 3) 盯着活动：长时间没进展或回合被中断，就往会话里塞提醒；连续提醒
 *    也只提醒，不再往外发消息。
 *
 * 这里只放判定和文案，真正的安装/注入/发消息在 lib/host.js。
 */

import { randomUUID } from 'node:crypto'
import { defaultLongTaskReminder, defaultChannelReminder } from './config.js'

/** 会停下来等人、导致会话失联的工具：绑定会话里一律不用。 */
export const refuseTool = Object.freeze(['ask_user_question', 'wait_agent'])

/** 提示词段的名字与顺序（排在 persona 之后，稳定生效）。 */
export const promptSegmentName = 'fish-message:guard'
export const promptSegmentOrder = 10150

/** 监控心跳：每 30 秒看一次。测试里用 FISH_MESSAGE_GUARD_TICK_MS 调快。 */
export const heartbeatMs = (() => {
  const value = Number(process.env.FISH_MESSAGE_GUARD_TICK_MS)
  return Number.isFinite(value) && value > 0 ? Math.max(10, Math.round(value)) : 30000
})()
/**
 * 回合结束后等多久再判定「这一回合到底发没发消息」。
 * 桥是在 turn/end 之后才把 [MSG] 里的内容投到聊天软件的（lib/bridge.js 的 deliverAssistantTurn），
 * 出站事件一定比 turn/end 晚一点才到；判定必须等它一会儿，否则正常发过消息的回合
 * 也会被判成「没发」。8 秒足够覆盖一次正常投递（含出站排队）。
 */
export const turnGraceMs = (() => {
  const value = Number(process.env.FISH_MESSAGE_GUARD_QQ_GRACE_MS)
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 8000
})()

/** 同一原因两次提醒之间至少隔这么久（分钟）；中断提醒短一点。 */
export const stuckReminderIntervalMinutes = 15
export const interruptReminderIntervalMinutes = 10
/** 连续提醒这么多次后就不再重复注入，避免刷屏。 */
export const maxReminderCount = 3

/**
 * 注入给会话的提示词段：只写代码管不到的约定。
 *
 * 工具守卫已在工具层拦掉 拒用工具（提问、干等），审批策略固定为 never，
 * 桥只投递 [MSG] 块——这些由代码保证，不再写进提示词：同一条规矩只留一处出处，
 * 改一处就不会与另一处不一致。这里只补三件事：回复要落在 [MSG] 块里、
 * 要拍板就发消息而不是停下、长任务派出去以免本回合长时间不回话。
 */
export const guardRules = [
  '本会话通过聊天软件和用户对话：给用户的话写在 [MSG]…[/MSG] 里，块外内容默认不会发出。',
  '需要用户拍板时用 [MSG] 提问，然后先做不依赖它的部分。',
  '长任务（写代码、修 bug、批量整理）交给子代理；派完就结束本回合，子代理完成后会唤醒你。',
  '出错记下来、能绕开就绕开；实在做不下去，用 [MSG] 说明卡在哪。',
].join('\n')

/** 工具被挡下时模型看到的话：说清为什么、下一步怎么办。 */
export function rejectCopy(toolName) {
  const name = String(toolName || '')
  if (name === 'ask_user_question') {
    return '本会话绑定了聊天软件，不能用「ask_user_question」：它会停下来等人回答，会话会失联。需要用户拍板就发 [MSG] 消息问，然后继续做不依赖它的部分。'
  }
  if (name === 'wait_agent') {
    return '本会话绑定了聊天软件，不能用「wait_agent」干等：会把会话卡住、收不到消息。派完子代理就结束这一回合，子代理完成后会唤醒本会话；需要结果就等唤醒后再继续。'
  }
  return `本会话绑定了聊天软件，不能用「${name}」：它可能让会话停下来或中断，导致收不到消息。`
}

/** 构造工具守卫：返回字符串 = 拒绝，返回 undefined = 放行；绝不能抛错。 */
export function constructToolGuard() {
  return function toolGuard(execute) {
    try {
      const name = String(execute?.name || '')
      if (!name || !refuseTool.includes(name)) return undefined
      return rejectCopy(name)
    } catch {
      return undefined
    }
  }
}

/** 回合被中断后塞给会话的提醒。 */
export function interruptReminderCopy() {
  return '注意：本会话绑定了聊天软件，刚才的回合被中断了。请继续做完剩下的事；需要用户拍板就用 [MSG] 问，然后继续做不依赖它的部分。'
}

/** 长任务提醒实际用的文案：设置里留空时用内置默认（原文见 lib/config.js）。 */
export function longTaskReminderText(config) {
  const value = config?.guardStuckPrompt
  return typeof value === 'string' && value.trim() ? value.trim() : defaultLongTaskReminder
}

/** 消息通道提醒实际用的文案：设置里留空时用内置默认（原文见 lib/config.js）。 */
export function channelReminderText(config) {
  const value = config?.guardQqPrompt
  return typeof value === 'string' && value.trim() ? value.trim() : defaultChannelReminder
}

/** 组装一条 inject 用的消息（不进渠道，只进 DSH 会话）。 */
export function reminderMessage(text, reason) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text || '') }],
    source: { kind: 'fish-message/guard', reason: String(reason || '') },
  }
}

const normalizeSession = (id) => {
  const s = String(id == null ? '' : id)
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

const clampSeconds = (value, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(7200, Math.max(1, Math.round(n)))
}

/**
 * 监控状态机。按会话记：最近一次进展、提醒次数、消息出站时间、告警。
 * 计时依赖注入的 now()，测试里直接用假时钟。
 */
export class GuardMonitor {
  constructor({ now = Date.now, getConfig = () => ({}), logger = null, graceMs = turnGraceMs } = {}) {
    this.now = now
    this.getConfig = getConfig
    this.logger = logger
    this.graceMs = graceMs
    /** sessionId → { qq, title }；只放 enabled 的绑定。 */
    this.bindingMap = new Map()
    /** sessionId → 监控状态。 */
    this.statusMap = new Map()
    /** 降级原因（去重后保留最近 20 条）。 */
    this.degradedMap = []
  }

  /** 每次心跳前同步绑定；解绑的会话连状态一起丢掉。 */
  setBindings(bindings = [], titleTable = new Map()) {
    const nextTable = new Map()
    for (const b of Array.isArray(bindings) ? bindings : []) {
      if (!b || b.enabled === false) continue
      const id = normalizeSession(b.session)
      if (!id) continue
      const title = String(titleTable.get?.(id) || b.name || b.qq || id)
      nextTable.set(id, { qq: String(b.qq || ''), title: title })
    }
    this.bindingMap = nextTable
    for (const id of [...this.statusMap.keys()]) {
      if (!nextTable.has(id)) this.statusMap.delete(id)
    }
  }

  isBinding(sessionId) {
    return this.bindingMap.has(normalizeSession(sessionId))
  }

  /** 会话销毁：把监控状态一起清掉，重建后从干净状态开始。 */
  forget(sessionId) {
    this.statusMap.delete(normalizeSession(sessionId))
  }

  noteDegraded(reason) {
    const str = String(reason || '').trim()
    if (!str) return
    if (this.degradedMap.some((x) => x.reason === str)) return
    this.degradedMap.push({ reason: str, at: this.now() })
    if (this.degradedMap.length > 20) this.degradedMap.shift()
  }

  getStatus(sessionId) {
    const id = normalizeSession(sessionId)
    let st = this.statusMap.get(id)
    if (!st) {
      const now = this.now()
      st = {
        status: 'idle',
        statusSince: now,
        lastProgressAt: now,
        injections: 0,
        injectedAt: 0,
        interruptedAt: 0,
        lastInterruptAt: 0,
        alert: null,
        // 连续多少个回合（一次用户消息 → 最终回复）没有消息出站；发过消息就清零。
        qqTurn: 0,
        qqRemindAt: 0,
        // 本回合是否已经有消息出站：回合开始时复位，回合结束时用它判定。
        qqSentThisTurn: false,
        // 回合已经结束、还在等桥投递 [MSG]：等够宽限再由心跳定账。
        pendingTurn: false,
        pendingJudgeAt: 0,
        // 已经塞了一条长任务提醒、但还没进入会话：进入前不再考虑超时提醒。
        remindOnEnter: false,
      }
      this.statusMap.set(id, st)
    }
    return st
  }

  runningThresholdMs() {
    return clampSeconds(this.getConfig?.()?.guardStuckSeconds, 600) * 1000
  }

  /** 回合判定要等多久：默认 8 秒，构造时或环境变量可覆盖。 */
  judgementGraceMs() {
    const n = Number(this.graceMs)
    if (!Number.isFinite(n) || n < 0) return turnGraceMs
    return Math.round(n)
  }

  /** 连续几轮没消息出站就提醒；1~50，默认 3。 */
  qqTurnThreshold() {
    const n = Number(this.getConfig?.()?.guardQqRemindTurns)
    if (!Number.isFinite(n)) return 3
    return Math.min(50, Math.max(1, Math.round(n)))
  }

  /**
   * 消息真正发出去（渠道已送达）：这才算「会话能把话带出去」，
   * 长任务计时从这里重新开始，告警和已注入次数一起清掉。
   */
  noteQqOutbound(qq) {
    const num = String(qq == null ? '' : qq).replace(/[^\d]/g, '')
    if (!num) return
    // 每个绑定会话都记下「本回合已经发过消息」。
    const now = this.now()
    for (const [id, binding] of this.bindingMap) {
      if (String(binding.qq) !== num) continue
      const st = this.statusMap.get(id)
      if (!st) continue
      st.qqTurn = 0
      st.qqRemindAt = 0
      // 这一回合的消息已经到了：还没判定的直接按「发过」算，不必再等宽限。
      st.pendingTurn = false
      st.pendingJudgeAt = 0
      st.qqSentThisTurn = true
      // 消息真到了用户手里，说明会话还能把话带出去：卡住计时、告警和已注入次数一起清掉。
      st.statusSince = now
      st.lastProgressAt = now
      st.injections = 0
      st.injectedAt = 0
      st.alert = null
    }
  }


  /** 提醒没送进会话（宿主忙、找不到会话等）：把这一次退回去，下一个心跳重试。 */
  countInjectFailure(sessionId) {
    const id = normalizeSession(sessionId)
    const st = this.statusMap.get(id)
    if (!st) return
    st.injections = Math.max(0, st.injections - 1)
    st.injectedAt = 0
    st.remindOnEnter = false
  }

  /** 注入的提醒已经进了会话（下一轮 assistant 消息就是证据）：从这一刻重新计时。 */
  noteReminderEntered(st, now) {
    st.remindOnEnter = false
    st.statusSince = now
    st.lastProgressAt = now
    st.injections = 0
    st.injectedAt = 0
    st.alert = null
  }

  resetProgress(st, now) {
    st.lastProgressAt = now
    st.injections = 0
    st.injectedAt = 0
    st.interruptedAt = 0
    st.lastInterruptAt = 0
    st.remindOnEnter = false
    st.alert = null
  }

  /** agent/status：idle / running。返回需要执行的动作（可能是上一回合的延后判定）。 */
  trackStatus(sessionId, status) {
    const id = normalizeSession(sessionId)
    if (!this.bindingMap.has(id)) return []
    const st = this.getStatus(id)
    const now = this.now()
    const next = String(status || '')
    if (next !== 'running' && next !== 'idle') return []
    if (next === 'running') {
      if (st.status !== 'running') {
        // 新的一轮开始：上一回合要是还在等宽限，先按当时的状态判掉。
        // 判完就复位标记，新回合的消息出站不会被算到旧回合头上。
        const actions = this.resolvePendingTurn(id, st, now)
        st.status = 'running'
        st.statusSince = now
        // 这一轮的提醒次数和告警都从头算，消息出站也重新算。
        st.lastProgressAt = now
        st.injections = 0
        st.injectedAt = 0
        st.remindOnEnter = false
        st.alert = null
        st.qqSentThisTurn = false
        return actions
      }
      return []
    }
    st.status = 'idle'
    st.statusSince = now
    return []
  }

  /** session/event：turn 边界决定消息回合计数，assistant/message 只管中断判定和进展。 */
  handleEvent(sessionId, event) {
    const id = normalizeSession(sessionId)
    if (!this.bindingMap.has(id)) return []
    const st = this.getStatus(id)
    const now = this.now()
    const kind = String(event?.type || '')
    const data = event?.data || {}

    // 一个回合从 turn/start 开始，到 turn/end 结束；中间有多少个模型步（工具调用）
    // 都发 assistant/message，但它们属于同一个回合，不能各算一轮。
    if (kind === 'turn/start') {
      // 宽限内用户就先说话了：先按当时的状态把上一个回合判掉，再开始新回合。
      // 反过来（先复位再判）会把旧回合的账丢掉，也会让新回合的出站混进旧回合。
      const actions = this.resolvePendingTurn(id, st, now)
      st.qqSentThisTurn = false
      return actions
    }

    if (kind === 'assistant/message') {
      if (data.interrupted) {
        return this.countInterrupt(id, st, now)
      }
      // 之前塞进去的提醒这会儿已经进了会话：从这一刻重新算「这一轮跑了多久」。
      if (st.remindOnEnter) this.noteReminderEntered(st, now)
      // 新的模型输出/工具调用就是真进展：卡住计时从这里重新开始。
      // 只要还在持续产出，就不算卡住；真正卡住是长时间没有任何新输出。
      st.lastProgressAt = now
      st.statusSince = now
      if (st.alert?.reason === 'stuck') st.alert = null
      return []
    }

    if (kind === 'turn/end') {
      const reason = String(data.reason?.kind || '')
      if (reason && reason !== 'completed') return this.countInterrupt(id, st, now)
      this.resetProgress(st, now)
      // 这一刻还不能定账：桥正是在 turn/end 之后才把 [MSG] 里的内容投出去的，
      // 出站事件晚一点才来。先记下「待判定」，由心跳过完宽限再算。
      // 已经有待判定的（少见：没收到 turn/start 就又结束一回合）保留原来的到期时间，不往后拖。
      if (!st.pendingTurn) {
        st.pendingTurn = true
        st.pendingJudgeAt = now
      }
      return []
    }

    return []
  }

  /**
   * 待判定的回合出结果：这一回合发过消息就清零，没发过才计一轮。
   * 判完一定复位「本回合发过消息」，保证下一个回合从干净状态开始。
   */
  resolvePendingTurn(id, st, now) {
    if (!st.pendingTurn) return []
    st.pendingTurn = false
    st.pendingJudgeAt = 0
    const sent = st.qqSentThisTurn === true
    st.qqSentThisTurn = false
    if (sent) {
      st.qqTurn = 0
      return []
    }
    return this.noteNoQqTurn(id, st, now)
  }

  /** 连续几个回合都没有消息出站：满阈值就提醒一次（同一原因 15 分钟内不重复）。 */
  noteNoQqTurn(id, st, now) {
    st.qqTurn = (st.qqTurn || 0) + 1
    if (st.qqTurn < this.qqTurnThreshold()) return []
    const interval = stuckReminderIntervalMinutes * 60000
    if (st.qqRemindAt && now - st.qqRemindAt < interval) return []
    const binding = this.bindingMap.get(id)
    if (!binding) return []
    const turns = st.qqTurn
    st.qqTurn = 0
    st.qqRemindAt = now
    return [{
      kind: 'remind',
      sessionId: id,
      qq: binding.qq,
      title: binding.title,
      reason: 'no-qq',
      turns: turns,
      text: channelReminderText(this.getConfig?.()),
    }]
  }

  countInterrupt(id, st, now) {
    st.interruptedAt = now
    st.lastProgressAt = now
    const action = this.remindOnce(id, st, now, 'interrupted')
    // 中断可能让 status 变 idle；告警保留到下次真正有进展。
    if (action) st.alert = { since: now, reason: 'interrupted', at: now, injections: st.injections }
    return action ? [action] : []
  }

  remindOnce(id, st, now, reason) {
    // 上一轮塞的提醒还没进会话：先不要再塞，否则只是往后排队、白白拖慢。
    if (reason === 'stuck' && st.remindOnEnter) return null
    // 卡住只塞一次：塞多了也只是排在后面，等模型跑完还要多花时间处理。
    const limit = reason === 'interrupted' ? maxReminderCount : 1
    if (st.injections >= limit) return null
    const interval = (reason === 'interrupted' ? interruptReminderIntervalMinutes : stuckReminderIntervalMinutes) * 60000
    if (st.injectedAt && now - st.injectedAt < interval) return null
    const binding = this.bindingMap.get(id)
    if (!binding) return null
    // 先占住这次提醒（排队期间也占着，免得心跳重复塞）；真正送不进去时才退回。
    st.injections += 1
    st.injectedAt = now
    st.remindOnEnter = true
    const second = reason === 'interrupted'
      ? (st.lastInterruptAt ? Math.round((now - st.lastInterruptAt) / 1000) : 0)
      : Math.round((now - st.statusSince) / 1000)
    if (reason === 'interrupted') st.lastInterruptAt = now
    return {
      kind: 'remind',
      sessionId: id,
      qq: binding.qq,
      title: binding.title,
      reason: reason,
      seconds: second,
      text: reason === 'interrupted' ? interruptReminderCopy() : longTaskReminderText(this.getConfig?.()),
    }
  }

  /**
   * 心跳：返回需要执行的动作（只提醒，不发消息）。
   * 这里同时做两件事：给回合结束后的「发没发消息」定账，以及长任务超时提醒。
   * 两者都产出 kind: 'remind' 的动作，调用方（lib/host.js 的 执行守护动作）不用区分。
   */
  tick() {
    const now = this.now()
    const actions = []
    for (const [id, st] of this.statusMap) {
      const binding = this.bindingMap.get(id)
      if (!binding) continue
      // 回合已经结束、等够了宽限：把这一回合判掉。回合结束了就与 running 无关，必须先判。
      let justRemindedChannel = false
      if (st.pendingTurn && now - (st.pendingJudgeAt || 0) >= this.judgementGraceMs()) {
        const judgeActions = this.resolvePendingTurn(id, st, now)
        if (judgeActions.length) {
          actions.push(...judgeActions)
          justRemindedChannel = true
        }
      }
      // 同一心跳里已经提醒过「几轮没发消息」：不再叠加长任务提醒，免得一次塞两条。
      if (justRemindedChannel) continue
      // 只盯正在跑的会话：空闲是在等用户说话，不该被打扰。
      if (st.status !== 'running') continue
      // 已经塞了一条、还没进会话：进入前不再考虑超时提醒。
      if (st.remindOnEnter) continue
      // 按「距离上一次真进展多久」算：新的模型输出/工具调用会重置 statusSince，
      // 所以长时间没有任何新输出才算卡住，持续干活不会定期误报。
      const baseline = st.statusSince
      if (!baseline) continue
      const ranFor = Math.max(0, now - baseline)
      const threshold = this.runningThresholdMs()
      if (ranFor < threshold) continue

      const reminder = this.remindOnce(id, st, now, 'stuck')
      if (reminder) {
        actions.push(reminder)
        st.alert = { since: baseline, reason: 'stuck', at: now, injections: st.injections }
      }
    }
    return actions
  }

  /** 给 /state 和设置页看的快照。 */
  snapshot() {
    const now = this.now()
    const alerts = []
    for (const [id, st] of this.statusMap) {
      if (!st.alert) continue
      const binding = this.bindingMap.get(id)
      if (!binding) continue
      alerts.push({
        sessionId: id,
        title: binding.title,
        qq: binding.qq,
        status: st.status,
        seconds: Math.max(0, Math.round((now - st.alert.since) / 1000)),
        injections: st.injections,
        reason: st.alert.reason,
        remindedAt: st.alert.at,
      })
    }
    return {
      bound: this.bindingMap.size,
      alerts,
      degraded: this.degradedMap.map((x) => ({ ...x })),
    }
  }
}
