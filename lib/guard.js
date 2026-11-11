/**
 * 防失联守卫：让绑定了 QQ 的会话一直能收发消息。
 *
 * 三件事：
 * 1) 挡掉一定会让人干等的工具（提问），模型会收到一句人话错误；
 * 2) 往绑定会话的提示词里加几条硬规则，长任务派子代理、要拍板就发 QQ；
 * 3) 盯着活动：长时间没进展或回合被中断，就往会话里塞提醒；连续提醒
 *    也只提醒，不再升级成给主人发 QQ。
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
/** 同一原因两次提醒之间至少隔这么久（分钟）；中断提醒短一点。 */
export const 卡住提醒间隔分钟 = 15
export const 中断提醒间隔分钟 = 10
/** 连续提醒这么多次后就不再重复注入，避免刷屏。 */
export const 最多提醒次数 = 3

/** 注入给会话的硬规则：短、能照做、不写技术细节。 */
export const 守卫规则 = [
  '这个会话绑定了 QQ，主人可能不在电脑前，你必须随时能收发消息。',
  '长任务、批量任务一律交给子代理（subagent）去做，主会话只做协调和回话。',
  '给主人的回复必须走 QQ：把要说的话写在 [QQ]…[/QQ] 里，不能只在会话里裸回复，那样主人收不到。',
  '不要使用会停下来等人回答的工具（比如 ask_user_question）。需要主人拍板时，用 [QQ]…[/QQ] 发一条消息问，然后继续做不依赖它的部分。',
  '需要重启 DSH 时，用独立的重启插件提供的 dsh_restart 工具排期；不要自己杀进程、拼 schtasks 或重装插件，那会让本会话直接失联。',
  '派完子代理就结束这一回合，不要用 wait_agent 之类的等待命令把自己卡住；子代理完成后会 send_message 唤醒你。给子代理派活时明确要求它完成后用 send_message 回报，那个回报会唤醒本会话。',
  '出错就记下来并继续，能绕开就绕开；实在进行不下去时，用 [QQ] 说明卡在哪，等主人回消息再继续。',
].join('\n')

/** 工具被挡下时模型看到的话：说清为什么、下一步怎么办。 */
export function 拒绝文案(工具名) {
  const 名 = String(工具名 || '')
  if (名 === 'ask_user_question') {
    return '本会话绑定 QQ，不能用「ask_user_question」：它会停下来等人回答，会话会失联。需要主人拍板就发 [QQ] 消息问，然后继续做不依赖它的部分。'
  }
  if (名 === 'wait_agent') {
    return '本会话绑定 QQ，不能用「wait_agent」干等：会把会话卡住、收不到 QQ 消息。派完子代理就结束这一回合，子代理完成后会 send_message 唤醒本会话；需要结果就等唤醒后再继续。'
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
  return '注意：本会话绑定 QQ，刚才的回合被中断了。请继续做完剩下的事；需要主人拍板就用 [QQ] 问，然后继续做不依赖它的部分。'
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

const 钳分钟 = (值, 兜底) => {
  const n = Number(值)
  if (!Number.isFinite(n)) return 兜底
  return Math.min(120, Math.max(1, Math.round(n)))
}

/**
 * 监控状态机。按会话记：最近一次进展、提醒次数、QQ 时间、告警。
 * 计时依赖注入的 now()，测试里直接用假时钟。
 */
export class GuardMonitor {
  constructor({ now = Date.now, getConfig = () => ({}), logger = null } = {}) {
    this.now = now
    this.getConfig = getConfig
    this.logger = logger
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

  取状态(id) {
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
        // 连续多少轮 assistant 回合没有 QQ 出站；发过 QQ 就清零。
        qq回合: 0,
        qq提醒于: 0,
      }
      this.状态表.set(id, st)
    }
    return st
  }

  无进展分钟() {
    return 钳分钟(this.getConfig?.()?.guardStuckMinutes, 10)
  }

  /** 连续几轮没 QQ 出站就提醒；1~50，默认 3。 */
  QQ回合阈值() {
    const n = Number(this.getConfig?.()?.guardQqRemindTurns)
    if (!Number.isFinite(n)) return 3
    return Math.min(50, Math.max(1, Math.round(n)))
  }

  /** 有 QQ 出站（发成功或已进队列）：所有绑到这个 QQ 的会话计数清零。 */
  记QQ出站(qq) {
    const 号 = String(qq == null ? '' : qq).replace(/[^\d]/g, '')
    if (!号) return
    for (const [id, 绑定] of this.绑定表) {
      if (String(绑定.qq) !== 号) continue
      const st = this.状态表.get(id)
      if (st) st.qq回合 = 0
    }
  }

  重置进展(st, now) {
    st.lastProgressAt = now
    st.injections = 0
    st.injectedAt = 0
    st.interruptedAt = 0
    st.lastInterruptAt = 0
    st.alert = null
  }

  /** agent/status：idle / running。 */
  跟踪状态(sessionId, status) {
    const id = 规整会话(sessionId)
    if (!this.绑定表.has(id)) return
    const st = this.取状态(id)
    const now = this.now()
    const 新 = String(status || '')
    if (新 !== 'running' && 新 !== 'idle') return
    if (新 === 'running') {
      if (st.status !== 'running') {
        st.status = 'running'
        st.statusSince = now
        // 新的一轮开始：如果之前没有在告警，就当进展重新计时。
        if (!st.alert) st.lastProgressAt = now
      }
      return
    }
    st.status = 'idle'
    st.statusSince = now
  }

  /** session/event：assistant/message 与 turn/end 决定进展还是中断。 */
  处理事件(sessionId, event) {
    const id = 规整会话(sessionId)
    if (!this.绑定表.has(id)) return []
    const st = this.取状态(id)
    const now = this.now()
    const 类型 = String(event?.type || '')
    const 数据 = event?.data || {}

    if (类型 === 'assistant/message') {
      if (数据.interrupted) {
        return this.记中断(id, st, now)
      }
      this.重置进展(st, now)
      return this.记没发QQ回合(id, st, now)
    }

    if (类型 === 'turn/end') {
      const 原因 = String(数据.reason?.kind || '')
      if (原因 && 原因 !== 'completed') return this.记中断(id, st, now)
      this.重置进展(st, now)
      return []
    }

    return []
  }

  /** 连续几轮 assistant 回合都没有 QQ 出站：满阈值就提醒一次（同一原因 15 分钟内不重复）。 */
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
    if (st.injections >= 最多提醒次数) return null
    const 间隔 = (原因 === 'interrupted' ? 中断提醒间隔分钟 : 卡住提醒间隔分钟) * 60000
    if (st.injectedAt && now - st.injectedAt < 间隔) return null
    const 绑定 = this.绑定表.get(id)
    if (!绑定) return null
    st.injections += 1
    st.injectedAt = now
    const 分钟 = 原因 === 'interrupted'
      ? (st.lastInterruptAt ? Math.round((now - st.lastInterruptAt) / 60000) : 0)
      : Math.round((now - st.lastProgressAt) / 60000)
    if (原因 === 'interrupted') st.lastInterruptAt = now
    return {
      kind: 'remind',
      sessionId: id,
      qq: 绑定.qq,
      title: 绑定.title,
      reason: 原因,
      minutes: 分钟,
      text: 原因 === 'interrupted' ? 中断提醒文案() : 长任务提醒文本(this.getConfig?.()),
    }
  }

  /** 心跳：返回需要执行的动作（只提醒，不发 QQ）。 */
  tick() {
    const now = this.now()
    const 动作们 = []
    for (const [id, st] of this.状态表) {
      const 绑定 = this.绑定表.get(id)
      if (!绑定) continue
      // 只盯正在跑的会话：空闲是在等主人说话，不该被打扰。
      if (st.status !== 'running') continue
      const 基准 = Math.max(st.statusSince, st.lastProgressAt)
      if (!基准) continue
      const 无进展 = Math.max(0, now - 基准)
      const 阈值 = this.无进展分钟() * 60000
      if (无进展 < 阈值) continue

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
        minutes: Math.max(0, Math.round((now - st.alert.since) / 60000)),
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
