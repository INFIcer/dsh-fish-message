/**
 * 防失联守卫：让绑定了 QQ 的会话一直能收发消息。
 *
 * 三件事：
 * 1) 挡掉一定会让人干等的工具（提问、干等），模型会收到一句人话错误；
 * 2) 往绑定会话的提示词里补几条代码管不到的约定：回复落在 [QQ] 块里、要拍板发 QQ、
 *    长任务派子代理；
 * 3) 盯着活动：长时间没进展或回合被中断，就往会话里塞提醒；连续提醒
 *    也只提醒，不再往 QQ 发消息。
 *
 * 这里只放判定和文案，真正的安装/注入/发消息在 lib/host.js。
 */

import { randomUUID } from 'node:crypto'
import { 默认长任务提醒文案, 默认消息通道提醒文案 } from './config.js'

/** 会停下来等人、导致会话失联的工具：绑定会话里一律不用。 */
export const 拒用工具 = Object.freeze(['ask_user_question', 'wait_agent'])

/** 提示词段的名字与顺序（排在 persona 之后，稳定生效）。 */
export const 提示段名 = 'fish-message:guard'
export const 提示段顺序 = 10150

/** 监控心跳：每 30 秒看一次。测试里用 FISH_MESSAGE_GUARD_TICK_MS 调快。 */
export const 心跳毫秒 = (() => {
  const 值 = Number(process.env.FISH_MESSAGE_GUARD_TICK_MS)
  return Number.isFinite(值) && 值 > 0 ? Math.max(10, Math.round(值)) : 30000
})()
/**
 * 回合结束后等多久再判定「这一回合到底发没发 QQ」。
 * 桥是在 turn/end 之后才把 [QQ] 投到 QQ 的（lib/bridge.js 的 deliverAssistantTurn），
 * 出站事件一定比 turn/end 晚一点才到；判定必须等它一会儿，否则正常发过 QQ 的回合
 * 也会被判成「没发」。8 秒足够覆盖一次正常投递（含出站排队）。
 */
export const 回合判定宽限毫秒 = (() => {
  const 值 = Number(process.env.FISH_MESSAGE_GUARD_QQ_GRACE_MS)
  return Number.isFinite(值) && 值 >= 0 ? Math.round(值) : 8000
})()

/** 同一原因两次提醒之间至少隔这么久（分钟）；中断提醒短一点。 */
export const 卡住提醒间隔分钟 = 15
export const 中断提醒间隔分钟 = 10
/** 连续提醒这么多次后就不再重复注入，避免刷屏。 */
export const 最多提醒次数 = 3

/**
 * 注入给会话的提示词段：只写代码管不到的约定。
 *
 * 工具守卫已在工具层拦掉 拒用工具（提问、干等），审批策略固定为 never，
 * 桥只投递 [QQ] 块——这些由代码保证，不再写进提示词：同一条规矩只留一处出处，
 * 改一处就不会与另一处不一致。这里只补三件事：回复要落在 [QQ] 块里、
 * 要拍板就发 QQ 而不是停下、长任务派出去以免本回合长时间不回话。
 */
export const 守卫规则 = [
  '本会话通过 QQ 和用户对话：给用户的话写在 [QQ]…[/QQ] 里，块外内容默认不会发出。',
  '需要用户拍板时用 [QQ] 提问，然后先做不依赖它的部分。',
  '长任务（写代码、修 bug、批量整理）交给子代理；派完就结束本回合，子代理完成后会唤醒你。',
  '重启 DSH 用现成的重启工具，不要自己杀进程，那会让本会话失联。',
  '出错记下来、能绕开就绕开；实在做不下去，用 [QQ] 说明卡在哪。',
].join('\n')

/** 工具被挡下时模型看到的话：说清为什么、下一步怎么办。 */
export function 拒绝文案(工具名) {
  const 名 = String(工具名 || '')
  if (名 === 'ask_user_question') {
    return '本会话绑定 QQ，不能用「ask_user_question」：它会停下来等人回答，会话会失联。需要用户拍板就发 [QQ] 消息问，然后继续做不依赖它的部分。'
  }
  if (名 === 'wait_agent') {
    return '本会话绑定 QQ，不能用「wait_agent」干等：会把会话卡住、收不到 QQ 消息。派完子代理就结束这一回合，子代理完成后会唤醒本会话；需要结果就等唤醒后再继续。'
  }
  return `本会话绑定 QQ，不能用「${名}」：它可能让会话停下来或中断，导致收不到 QQ 消息。`
}

/** 构造工具守卫：返回字符串 = 拒绝，返回 undefined = 放行；绝不能抛错。 */
export function 构造工具守卫() {
  return function 工具守卫(执行) {
    try {
      const 名 = String(执行?.name || '')
      if (!名 || !拒用工具.includes(名)) return undefined
      return 拒绝文案(名)
    } catch {
      return undefined
    }
  }
}

/** 回合被中断后塞给会话的提醒。 */
export function 中断提醒文案() {
  return '注意：本会话绑定 QQ，刚才的回合被中断了。请继续做完剩下的事；需要用户拍板就用 [QQ] 问，然后继续做不依赖它的部分。'
}

/** 长任务提醒实际用的文案：设置里留空时用内置默认（原文见 lib/config.js）。 */
export function 长任务提醒文本(配置) {
  const 值 = 配置?.guardStuckPrompt
  return typeof 值 === 'string' && 值.trim() ? 值.trim() : 默认长任务提醒文案
}

/** 消息通道提醒实际用的文案：设置里留空时用内置默认（原文见 lib/config.js）。 */
export function 消息通道提醒文本(配置) {
  const 值 = 配置?.guardQqPrompt
  return typeof 值 === 'string' && 值.trim() ? 值.trim() : 默认消息通道提醒文案
}

/** 组装一条 inject 用的消息（不进 QQ，只进 DSH 会话）。 */
export function 提醒消息(文本, 原因) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(文本 || '') }],
    source: { kind: 'fish-message/guard', reason: String(原因 || '') },
  }
}

const 规整会话 = (id) => {
  const s = String(id == null ? '' : id)
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

const 钳秒 = (值, 兜底) => {
  const n = Number(值)
  if (!Number.isFinite(n)) return 兜底
  return Math.min(7200, Math.max(1, Math.round(n)))
}

/**
 * 监控状态机。按会话记：最近一次进展、提醒次数、QQ 时间、告警。
 * 计时依赖注入的 now()，测试里直接用假时钟。
 */
export class GuardMonitor {
  constructor({ now = Date.now, getConfig = () => ({}), logger = null, 宽限毫秒 = 回合判定宽限毫秒 } = {}) {
    this.now = now
    this.getConfig = getConfig
    this.logger = logger
    this.宽限毫秒 = 宽限毫秒
    /** sessionId → { qq, title }；只放 enabled 的绑定。 */
    this.绑定表 = new Map()
    /** sessionId → 监控状态。 */
    this.状态表 = new Map()
    /** 降级原因（去重后保留最近 20 条）。 */
    this.降级表 = []
  }

  /** 每次心跳前同步绑定；解绑的会话连状态一起丢掉。 */
  设绑定(bindings = [], 标题表 = new Map()) {
    const 新表 = new Map()
    for (const b of Array.isArray(bindings) ? bindings : []) {
      if (!b || b.enabled === false) continue
      const id = 规整会话(b.session)
      if (!id) continue
      const 标题 = String(标题表.get?.(id) || b.name || b.qq || id)
      新表.set(id, { qq: String(b.qq || ''), title: 标题 })
    }
    this.绑定表 = 新表
    for (const id of [...this.状态表.keys()]) {
      if (!新表.has(id)) this.状态表.delete(id)
    }
  }

  是绑定(sessionId) {
    return this.绑定表.has(规整会话(sessionId))
  }

  /** 会话销毁：把监控状态一起清掉，重建后从干净状态开始。 */
  忘记(sessionId) {
    this.状态表.delete(规整会话(sessionId))
  }

  记降级(原因) {
    const 文 = String(原因 || '').trim()
    if (!文) return
    if (this.降级表.some((x) => x.reason === 文)) return
    this.降级表.push({ reason: 文, at: this.now() })
    if (this.降级表.length > 20) this.降级表.shift()
  }

  取状态(sessionId) {
    const id = 规整会话(sessionId)
    let st = this.状态表.get(id)
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
        // 连续多少个回合（一次用户消息 → 最终回复）没有 QQ 出站；发过 QQ 就清零。
        qq回合: 0,
        qq提醒于: 0,
        // 本回合是否已经有 QQ 出站：回合开始时复位，回合结束时用它判定。
        本回合发过QQ: false,
        // 回合已经结束、还在等桥投递 [QQ]：等够宽限再由心跳定账。
        待判定回合: false,
        待判定于: 0,
        // 已经塞了一条长任务提醒、但还没进入会话：进入前不再考虑超时提醒。
        提醒待进入: false,
      }
      this.状态表.set(id, st)
    }
    return st
  }

  运行阈值毫秒() {
    return 钳秒(this.getConfig?.()?.guardStuckSeconds, 600) * 1000
  }

  /** 回合判定要等多久：默认 8 秒，构造时或环境变量可覆盖。 */
  判定宽限毫秒() {
    const n = Number(this.宽限毫秒)
    if (!Number.isFinite(n) || n < 0) return 回合判定宽限毫秒
    return Math.round(n)
  }

  /** 连续几轮没 QQ 出站就提醒；1~50，默认 3。 */
  QQ回合阈值() {
    const n = Number(this.getConfig?.()?.guardQqRemindTurns)
    if (!Number.isFinite(n)) return 3
    return Math.min(50, Math.max(1, Math.round(n)))
  }

  /**
   * 消息真正发出去（QQ 已送达）：这才算「会话能把话带出去」，
   * 长任务计时从这里重新开始，告警和已注入次数一起清掉。
   */
  记QQ出站(qq) {
    const 号 = String(qq == null ? '' : qq).replace(/[^\d]/g, '')
    if (!号) return
    // 一个 QQ 号可能绑了多个会话：每个会话都记下「本回合已经发过 QQ」。
    for (const [id, 绑定] of this.绑定表) {
      if (String(绑定.qq) !== 号) continue
      const st = this.状态表.get(id)
      if (!st) continue
      st.qq回合 = 0
      st.qq提醒于 = 0
      // 这一回合的 QQ 已经到了：还没判定的直接按「发过」算，不必再等宽限。
      st.待判定回合 = false
      st.待判定于 = 0
      st.本回合发过QQ = true
    }
  }


  /** 提醒没送进会话（宿主忙、找不到会话等）：把这一次退回去，下一个心跳重试。 */
  记注入失败(sessionId) {
    const id = 规整会话(sessionId)
    const st = this.状态表.get(id)
    if (!st) return
    st.injections = Math.max(0, st.injections - 1)
    st.injectedAt = 0
    st.提醒待进入 = false
  }

  /** 注入的提醒已经进了会话（下一轮 assistant 消息就是证据）：从这一刻重新计时。 */
  记提醒已进入(st, now) {
    st.提醒待进入 = false
    st.statusSince = now
    st.lastProgressAt = now
    st.injections = 0
    st.injectedAt = 0
    st.alert = null
  }

  重置进展(st, now) {
    st.lastProgressAt = now
    st.injections = 0
    st.injectedAt = 0
    st.interruptedAt = 0
    st.lastInterruptAt = 0
    st.提醒待进入 = false
    st.alert = null
  }

  /** agent/status：idle / running。返回需要执行的动作（可能是上一回合的延后判定）。 */
  跟踪状态(sessionId, status) {
    const id = 规整会话(sessionId)
    if (!this.绑定表.has(id)) return []
    const st = this.取状态(id)
    const now = this.now()
    const 新 = String(status || '')
    if (新 !== 'running' && 新 !== 'idle') return []
    if (新 === 'running') {
      if (st.status !== 'running') {
        // 新的一轮开始：上一回合要是还在等宽限，先按当时的状态判掉。
        // 判完就复位标记，新回合的 QQ 出站不会被算到旧回合头上。
        const 动作们 = this.判掉待判定(id, st, now)
        st.status = 'running'
        st.statusSince = now
        // 这一轮的提醒次数和告警都从头算，QQ 出站也重新算。
        st.lastProgressAt = now
        st.injections = 0
        st.injectedAt = 0
        st.提醒待进入 = false
        st.alert = null
        st.本回合发过QQ = false
        return 动作们
      }
      return []
    }
    st.status = 'idle'
    st.statusSince = now
    return []
  }

  /** session/event：turn 边界决定 QQ 回合计数，assistant/message 只管中断判定和进展。 */
  处理事件(sessionId, event) {
    const id = 规整会话(sessionId)
    if (!this.绑定表.has(id)) return []
    const st = this.取状态(id)
    const now = this.now()
    const 类型 = String(event?.type || '')
    const 数据 = event?.data || {}

    // 一个回合从 turn/start 开始，到 turn/end 结束；中间有多少个模型步（工具调用）
    // 都发 assistant/message，但它们属于同一个回合，不能各算一轮。
    if (类型 === 'turn/start') {
      // 宽限内用户就先说话了：先按当时的状态把上一个回合判掉，再开始新回合。
      // 反过来（先复位再判）会把旧回合的账丢掉，也会让新回合的出站混进旧回合。
      const 动作们 = this.判掉待判定(id, st, now)
      st.本回合发过QQ = false
      return 动作们
    }

    if (类型 === 'assistant/message') {
      if (数据.interrupted) {
        return this.记中断(id, st, now)
      }
      // 之前塞进去的提醒这会儿已经进了会话：从这一刻重新算「这一轮跑了多久」。
      if (st.提醒待进入) this.记提醒已进入(st, now)
      // 有进展只更新展示时间，不重置「运行了多久」：只要这一轮还在跑，就算没在收消息。
      st.lastProgressAt = now
      return []
    }

    if (类型 === 'turn/end') {
      const 原因 = String(数据.reason?.kind || '')
      if (原因 && 原因 !== 'completed') return this.记中断(id, st, now)
      this.重置进展(st, now)
      // 这一刻还不能定账：桥正是在 turn/end 之后才把 [QQ] 投到 QQ 的，
      // 出站事件晚一点才来。先记下「待判定」，由心跳过完宽限再算。
      // 已经有待判定的（少见：没收到 turn/start 就又结束一回合）保留原来的到期时间，不往后拖。
      if (!st.待判定回合) {
        st.待判定回合 = true
        st.待判定于 = now
      }
      return []
    }

    return []
  }

  /**
   * 待判定的回合出结果：这一回合发过 QQ 就清零，没发过才计一轮。
   * 判完一定复位「本回合发过 QQ」，保证下一个回合从干净状态开始。
   */
  判掉待判定(id, st, now) {
    if (!st.待判定回合) return []
    st.待判定回合 = false
    st.待判定于 = 0
    const 发过 = st.本回合发过QQ === true
    st.本回合发过QQ = false
    if (发过) {
      st.qq回合 = 0
      return []
    }
    return this.记没发QQ回合(id, st, now)
  }

  /** 连续几个回合都没有 QQ 出站：满阈值就提醒一次（同一原因 15 分钟内不重复）。 */
  记没发QQ回合(id, st, now) {
    st.qq回合 = (st.qq回合 || 0) + 1
    if (st.qq回合 < this.QQ回合阈值()) return []
    const 间隔 = 卡住提醒间隔分钟 * 60000
    if (st.qq提醒于 && now - st.qq提醒于 < 间隔) return []
    const 绑定 = this.绑定表.get(id)
    if (!绑定) return []
    const 轮数 = st.qq回合
    st.qq回合 = 0
    st.qq提醒于 = now
    return [{
      kind: 'remind',
      sessionId: id,
      qq: 绑定.qq,
      title: 绑定.title,
      reason: 'no-qq',
      turns: 轮数,
      text: 消息通道提醒文本(this.getConfig?.()),
    }]
  }

  记中断(id, st, now) {
    st.interruptedAt = now
    st.lastProgressAt = now
    const 动作 = this.提醒一次(id, st, now, 'interrupted')
    // 中断可能让 status 变 idle；告警保留到下次真正有进展。
    if (动作) st.alert = { since: now, reason: 'interrupted', at: now, injections: st.injections }
    return 动作 ? [动作] : []
  }

  提醒一次(id, st, now, 原因) {
    // 上一轮塞的提醒还没进会话：先不要再塞，否则只是往后排队、白白拖慢。
    if (原因 === 'stuck' && st.提醒待进入) return null
    // 卡住只塞一次：塞多了也只是排在后面，等模型跑完还要多花时间处理。
    const 上限 = 原因 === 'interrupted' ? 最多提醒次数 : 1
    if (st.injections >= 上限) return null
    const 间隔 = (原因 === 'interrupted' ? 中断提醒间隔分钟 : 卡住提醒间隔分钟) * 60000
    if (st.injectedAt && now - st.injectedAt < 间隔) return null
    const 绑定 = this.绑定表.get(id)
    if (!绑定) return null
    // 先占住这次提醒（排队期间也占着，免得心跳重复塞）；真正送不进去时才退回。
    st.injections += 1
    st.injectedAt = now
    st.提醒待进入 = true
    const 秒 = 原因 === 'interrupted'
      ? (st.lastInterruptAt ? Math.round((now - st.lastInterruptAt) / 1000) : 0)
      : Math.round((now - st.statusSince) / 1000)
    if (原因 === 'interrupted') st.lastInterruptAt = now
    return {
      kind: 'remind',
      sessionId: id,
      qq: 绑定.qq,
      title: 绑定.title,
      reason: 原因,
      seconds: 秒,
      text: 原因 === 'interrupted' ? 中断提醒文案() : 长任务提醒文本(this.getConfig?.()),
    }
  }

  /**
   * 心跳：返回需要执行的动作（只提醒，不发 QQ）。
   * 这里同时做两件事：给回合结束后的「发没发 QQ」定账，以及长任务超时提醒。
   * 两者都产出 kind: 'remind' 的动作，调用方（lib/host.js 的 执行守护动作）不用区分。
   */
  tick() {
    const now = this.now()
    const 动作们 = []
    for (const [id, st] of this.状态表) {
      const 绑定 = this.绑定表.get(id)
      if (!绑定) continue
      // 回合已经结束、等够了宽限：把这一回合判掉。回合结束了就与 running 无关，必须先判。
      let 刚提醒过通道 = false
      if (st.待判定回合 && now - (st.待判定于 || 0) >= this.判定宽限毫秒()) {
        const 判定动作们 = this.判掉待判定(id, st, now)
        if (判定动作们.length) {
          动作们.push(...判定动作们)
          刚提醒过通道 = true
        }
      }
      // 同一心跳里已经提醒过「几轮没发 QQ」：不再叠加长任务提醒，免得一次塞两条。
      if (刚提醒过通道) continue
      // 只盯正在跑的会话：空闲是在等用户说话，不该被打扰。
      if (st.status !== 'running') continue
      // 已经塞了一条、还没进会话：进入前不再考虑超时提醒。
      if (st.提醒待进入) continue
      // 按「这一轮已经跑了多久」算，不按有没有新内容：只要还在跑，QQ 那头就收不到回复。
      const 基准 = st.statusSince
      if (!基准) continue
      const 运行了 = Math.max(0, now - 基准)
      const 阈值 = this.运行阈值毫秒()
      if (运行了 < 阈值) continue

      const 提醒 = this.提醒一次(id, st, now, 'stuck')
      if (提醒) {
        动作们.push(提醒)
        st.alert = { since: 基准, reason: 'stuck', at: now, injections: st.injections }
      }
    }
    return 动作们
  }

  /** 给 /state 和设置页看的快照。 */
  快照() {
    const now = this.now()
    const alerts = []
    for (const [id, st] of this.状态表) {
      if (!st.alert) continue
      const 绑定 = this.绑定表.get(id)
      if (!绑定) continue
      alerts.push({
        sessionId: id,
        title: 绑定.title,
        qq: 绑定.qq,
        status: st.status,
        seconds: Math.max(0, Math.round((now - st.alert.since) / 1000)),
        injections: st.injections,
        reason: st.alert.reason,
        remindedAt: st.alert.at,
      })
    }
    return {
      bound: this.绑定表.size,
      alerts,
      degraded: this.降级表.map((x) => ({ ...x })),
    }
  }
}
