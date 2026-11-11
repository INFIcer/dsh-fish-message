/**
 * 重启 DSH：只安排，等所有会话空闲才真的动手。
 *
 * 为什么不在工具里直接重启：重启会掐断正在干活的会话。所以这个模块只做三件事：
 * 1) schedule 记下「什么时候、谁叫的、唤醒时说什么」，状态落盘，重启后还能接着等；
 * 2) 到点先扫一遍所有活着的会话，有 running 就每 15 秒复查，一直等到全部空闲；
 * 3) 空闲后调用宿主机上现成的 dsh-restart.ps1 -Scheduled（清 cookie、写唤醒、WMI 拉起）。
 *
 * 真正的拉起用 WMI，避免脚本作为 DSH 子进程被一起带走。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './fs-util.js'
import { 造工具, 输出Schema } from './tools.js'

export const 状态文件名 = 'fish-message-restart.json'
export const 默认延迟秒 = 60
export const 最小延迟秒 = 10
export const 最大延迟秒 = 3600
export const 默认最长等待分钟 = 120
export const 最长等待分钟上限 = 1440
export const 空闲复查毫秒 = 15000
export const 默认唤醒文本 = '（大肥鱼）DSH 已重启好'
/** 交给脚本之后再留几秒，让工具结果和日志先落盘。 */
export const 重启延迟秒 = 3

function 安全文本(v, 最大 = 300) {
  return String(v == null ? '' : v).slice(0, 最大)
}

/** 把一串参数清洗成可以放进 PowerShell 双引号里的值。 */
function 清洗(s) {
  return String(s == null ? '' : s).replace(/["\r\n]/g, ' ').trim()
}

/** PowerShell 单引号字符串。 */
function PS单引号(s) {
  return `'${String(s == null ? '' : s).replace(/'/g, "''")}'`
}

function 要整数(值, 兜底, 最小, 最大, 字段) {
  if (值 === undefined || 值 === null || 值 === '') return 兜底
  const n = Number(值)
  if (!Number.isInteger(n) || n < 最小 || n > 最大) {
    throw Object.assign(new Error(`${字段}=${值}`), {
      code: 'bad_request',
      hint: `参数不对：${字段} 必须是 ${最小}~${最大} 的整数。`,
    })
  }
  return n
}

/** Agent 是否还在干活（空闲/维护都算空闲）。 */
export function 是运行中(agent) {
  const 状态 = String(agent?.status || agent?.loop?.status || '')
  return 状态 === 'running'
}

/** 唤醒文本 = 默认一句 + 调用方自己的补充。 */
export function 组合唤醒文本(额外 = '') {
  const 补 = 安全文本(额外, 120).trim()
  return 补 ? `${默认唤醒文本} ${补}` : 默认唤醒文本
}

/**
 * 默认的拉起方式：用 WMI 起一个独立进程跑 dsh-restart.ps1 -Scheduled。
 * 脚本自己会清 cookie、写唤醒事件、拉起 DSH 并做 TCP 探活。
 */
export function 默认拉起重启({ scriptPath, callerSession, wakeText, delaySeconds = 重启延迟秒 } = {}) {
  const 脚本 = scriptPath || join(process.env.DSH_HOME || join(homedir(), '.dsh'), '_restart', 'dsh-restart.ps1')
  if (!existsSync(脚本)) {
    return Promise.reject(Object.assign(new Error(`找不到重启脚本：${脚本}`), {
      code: 'no_script',
      hint: '找不到 DSH 的重启脚本，这次没有重启。',
    }))
  }
  const 系统 = process.env.SystemRoot || 'C:\\Windows'
  const 电源 = join(系统, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const 参数 = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', `"${脚本}"`,
    '-Scheduled',
    '-DelaySeconds', String(Number(delaySeconds) || 重启延迟秒),
    '-WakeAfterSeconds', '45',
    '-WakeText', `"${清洗(wakeText)}"`,
  ]
  const 会话 = 清洗(callerSession)
  if (会话) 参数.push('-SessionId', `"${会话}"`)
  // WMI 的 CommandLine 是整串；路径带空格所以要自己加引号。
  const 命令行 = `"${电源}" ${参数.join(' ')}`
  const 命令 = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${PS单引号(命令行)} } | Out-Null`
  return new Promise((resolve, reject) => {
    let 子
    try {
      子 = spawn(电源, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 命令], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      })
    } catch (error) {
      reject(error)
      return
    }
    子.once('error', reject)
    子.once('spawn', () => {
      try { 子.unref() } catch { /* 忽略 */ }
      resolve({ ok: true })
    })
  })
}

/**
 * 重启安排：落盘一份状态，host 重启后能接着等。
 *
 * autoTimers=false 时完全靠调用方手动触发（单测用）；timers 可注入假定时器。
 */
export class RestartController {
  constructor({
    homeDir,
    getConfig,
    getAgents,
    sendQQ,
    spawnRestart,
    logger,
    now = () => Date.now(),
    timers = null,
    autoTimers = true,
  } = {}) {
    this.homeDir = homeDir || process.env.DSH_HOME || join(homedir(), '.dsh')
    this.filePath = join(this.homeDir, 状态文件名)
    this.getConfig = getConfig || (() => ({}))
    this.getAgents = getAgents || (() => [])
    this.sendQQ = sendQQ || (() => {})
    this.spawnRestart = spawnRestart || 默认拉起重启
    this.logger = logger
    this.now = now
    this.timers = timers || {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (id) => clearTimeout(id),
    }
    this.autoTimers = autoTimers !== false
    this.定时 = null
    /** @type {{dueAt:number,callerSession:string,callerQQ:string,wakeText:string,reason:string,maxWaitMinutes:number,createdAt:number}|null} */
    this.安排 = null
    this.等待中 = false
    this.已触发 = false
    this.触发于 = 0
    this.最近记录 = ''
    this.load()
  }

  load() {
    const 盘 = readJson(this.filePath, null)
    if (!盘 || typeof 盘 !== 'object') return
    const 安排 = 盘.安排
    if (安排 && Number(安排.dueAt) > 0) {
      this.安排 = {
        dueAt: Number(安排.dueAt),
        callerSession: String(安排.callerSession || ''),
        callerQQ: String(安排.callerQQ || ''),
        wakeText: String(安排.wakeText || ''),
        reason: String(安排.reason || ''),
        maxWaitMinutes: Number(安排.maxWaitMinutes) || 默认最长等待分钟,
        createdAt: Number(安排.createdAt) || 0,
      }
      this.等待中 = Boolean(盘.等待中)
    }
    this.已触发 = Boolean(盘.已触发)
    this.触发于 = Number(盘.触发于) || 0
    this.最近记录 = String(盘.最近记录 || '')
  }

  save() {
    try {
      return writeJsonAtomic(this.filePath, {
        version: 1,
        安排: this.安排,
        等待中: this.等待中,
        已触发: this.已触发,
        触发于: this.触发于,
        最近记录: this.最近记录,
        updatedAt: this.now(),
      })
    } catch {
      return false
    }
  }

  /** 给设置页 / 工具看的快照。 */
  状态() {
    const 现在 = this.now()
    const 有 = Boolean(this.安排)
    const 剩余 = 有 && !this.等待中 ? Math.max(0, Math.ceil((this.安排.dueAt - 现在) / 1000)) : 0
    return {
      scheduled: 有,
      dueAt: 有 ? this.安排.dueAt : 0,
      callerSession: 有 ? this.安排.callerSession : '',
      waitingForIdle: 有 ? this.等待中 : false,
      remainingSeconds: 剩余,
      reason: 有 ? this.安排.reason : '',
      wakeText: 有 ? this.安排.wakeText : '',
      maxWaitMinutes: 有 ? this.安排.maxWaitMinutes : 0,
      firedAt: this.触发于 || 0,
      lastEvent: this.最近记录,
    }
  }

  清定时() {
    if (this.定时 == null) return
    try { this.timers.clear(this.定时) } catch { /* 忽略 */ }
    this.定时 = null
  }

  排到点(毫秒) {
    this.清定时()
    if (!this.autoTimers) return
    this.定时 = this.timers.set(() => {
      this.定时 = null
      this.到期()
    }, Math.max(0, 毫秒))
  }

  排复查() {
    this.清定时()
    if (!this.autoTimers) return
    this.定时 = this.timers.set(() => {
      this.定时 = null
      this.到期()
    }, 空闲复查毫秒)
  }

  /** 安排一次重启（不会立刻执行）。 */
  schedule({ delaySeconds, wakeText, reason, maxWaitMinutes, callerSession, callerQQ } = {}) {
    const 延迟 = 要整数(delaySeconds, 默认延迟秒, 最小延迟秒, 最大延迟秒, 'delaySeconds')
    const 等待 = 要整数(maxWaitMinutes, 默认最长等待分钟, 1, 最长等待分钟上限, 'maxWaitMinutes')
    const 现在 = this.now()
    this.清定时()
    this.安排 = {
      dueAt: 现在 + 延迟 * 1000,
      callerSession: 安全文本(callerSession, 80),
      callerQQ: 安全文本(callerQQ, 20).replace(/[^\d]/g, ''),
      wakeText: 安全文本(wakeText, 120),
      reason: 安全文本(reason, 300),
      maxWaitMinutes: 等待,
      createdAt: 现在,
    }
    this.等待中 = false
    this.已触发 = false
    this.触发于 = 0
    this.最近记录 = `已安排：${延迟} 秒后开始等空闲`
    this.save()
    this.排到点(延迟 * 1000)
    this.logger?.info?.(`已安排重启：${延迟} 秒后开始等所有会话空闲（调用会话 ${this.安排.callerSession || '未知'}）`)
    return this.状态()
  }

  /** 取消：到点没执行的、正在等空闲的，都一起取消。 */
  cancel() {
    const 有 = Boolean(this.安排)
    this.清定时()
    this.安排 = null
    this.等待中 = false
    this.最近记录 = 有 ? '已取消重启安排' : '没有可取消的安排'
    this.save()
    if (有) this.logger?.info?.('已取消重启安排')
    return { ...this.状态(), cancelled: 有 }
  }

  /** host 启动时恢复：没到点就继续等；已经到点就接着等空闲。 */
  恢复() {
    if (!this.安排) return this.状态()
    const 现在 = this.now()
    if (this.安排.dueAt > 现在) {
      this.排到点(this.安排.dueAt - 现在)
      return this.状态()
    }
    this.等待中 = true
    this.save()
    if (现在 >= this.安排.dueAt + this.安排.maxWaitMinutes * 60000) {
      this.放弃('等太久没空闲')
      return this.状态()
    }
    this.排复查()
    this.logger?.info?.('重启安排已到点，正在等所有会话空闲')
    return this.状态()
  }

  /** 到点/复查：有会话在跑就等，全空闲才真的重启。 */
  到期() {
    if (!this.安排) return []
    const 现在 = this.now()
    if (现在 >= this.安排.dueAt + this.安排.maxWaitMinutes * 60000) return this.放弃('等太久没空闲')
    const 忙 = this.运行中的会话()
    if (忙.length) {
      if (!this.等待中) this.logger?.info?.(`到点但还有 ${忙.length} 个会话在跑，等空闲再重启`)
      this.等待中 = true
      this.最近记录 = `等待空闲：还有 ${忙.length} 个会话在跑`
      this.save()
      this.排复查()
      return []
    }
    return this.执行()
  }

  运行中的会话() {
    try {
      const 列表 = typeof this.getAgents === 'function' ? this.getAgents() : this.getAgents
      const 数组 = Array.isArray(列表) ? 列表 : (typeof 列表?.list === 'function' ? 列表.list() : [])
      return (数组 || []).filter(是运行中)
    } catch {
      return []
    }
  }

  执行() {
    const 安排 = this.安排
    if (!安排) return []
    this.安排 = null
    this.等待中 = false
    this.已触发 = true
    this.触发于 = this.now()
    this.最近记录 = '到点且全部空闲，已开始重启'
    this.save()
    const 唤醒文本 = 组合唤醒文本(安排.wakeText)
    this.logger?.info?.('到点且全部空闲，正在重启 DSH…')
    const 参数 = {
      scriptPath: join(this.homeDir, '_restart', 'dsh-restart.ps1'),
      callerSession: 安排.callerSession,
      wakeText: 唤醒文本,
      delaySeconds: 重启延迟秒,
      logger: this.logger,
    }
    try {
      const 结果 = this.spawnRestart(参数)
      if (结果 && typeof 结果.then === 'function') {
        结果.catch((error) => this.重启失败(安排, error))
      }
    } catch (error) {
      this.重启失败(安排, error)
    }
    return [{ kind: 'restart', ...this.状态() }]
  }

  重启失败(安排, error) {
    this.已触发 = false
    this.触发于 = 0
    this.最近记录 = `重启命令没发出去：${安全文本(error?.message || error, 160)}`
    this.save()
    this.logger?.warn?.(`重启命令没发出去：${安全文本(error?.message || error, 160)}`)
    if (安排?.callerQQ) {
      this.发送QQ(安排.callerQQ, '（大肥鱼）重启没启动成功，DSH 还在跑。要再试一次就说一声。')
    }
  }

  放弃(原因) {
    const 安排 = this.安排
    this.安排 = null
    this.等待中 = false
    this.最近记录 = `已放弃：${原因}`
    this.save()
    this.logger?.warn?.(`重启安排已放弃：${原因}`)
    if (安排?.callerQQ) {
      this.发送QQ(安排.callerQQ, '（大肥鱼）等太久没空闲，没重启 DSH。需要的话再安排一次。')
    }
    return [{ kind: 'giveup', reason: 原因 }]
  }

  发送QQ(qq, text) {
    try {
      const 结果 = this.sendQQ?.(String(qq || ''), String(text || ''))
      if (结果 && typeof 结果.catch === 'function') 结果.catch(() => {})
    } catch { /* 发不出去就只留日志 */ }
  }

  /** 卸载插件时只停定时器；安排留在盘上，下次宿主启动还能接着等。 */
  stop() {
    this.清定时()
  }
}

/** 调用者：优先 exec.agent，其次宿主 bindings 兜底。 */
export function 解析调用者(exec, getConfig) {
  const agent = exec?.agent
  const 会话 = String(agent?.id || agent?.session?.id || exec?.sessionId || '').trim()
  let 绑定 = []
  try {
    绑定 = (getConfig?.()?.bindings || []).filter((b) => b && b.enabled !== false && b.qq)
  } catch { /* 没有配置就算了 */ }
  const 规整 = (s) => String(s == null ? '' : s).trim().replace(/^session-/, '')
  const 命中 = 会话 ? 绑定.find((b) => 规整(b.session) === 规整(会话)) : undefined
  return {
    session: 会话,
    qq: String(命中?.qq || 绑定[0]?.qq || ''),
  }
}

/** 造 dsh_restart 工具定义（不注册，方便单测）。 */
export function buildRestartTool({ controller, logger, getConfig } = {}) {
  return 造工具({
    name: 'dsh_restart',
    description: '重启 DSH（只安排，不会立刻重启）：到点后先等所有会话空闲，再执行重启；执行时会清掉登录 cookie（重启后要重新登录），完成后唤醒发起调用的会话。需要重启 DSH 时只用这个工具，不要自己拼 schtasks 或结束进程。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['schedule', 'cancel', 'status'],
          description: 'schedule=安排一次重启；cancel=取消现在的安排；status=查看当前安排。',
        },
        delaySeconds: {
          type: 'integer',
          description: '多久之后开始尝试重启，默认 60，范围 10~3600（秒）。',
        },
        wakeText: {
          type: 'string',
          description: '重启完成后唤醒会话时额外带的一句话（可选）。',
        },
        reason: {
          type: 'string',
          description: '为什么重启（可选，只做记录）。',
        },
        maxWaitMinutes: {
          type: 'integer',
          description: '最多等多久空闲，默认 120，范围 1~1440（分钟）；超过就放弃并 QQ 告知。',
        },
      },
      required: ['action'],
    },
    output: 输出Schema({
      scheduled: { type: 'boolean', description: '现在有没有待执行的重启安排' },
      dueAt: { type: 'number', description: '计划开始等空闲的时间（毫秒时间戳）' },
      callerSession: { type: 'string', description: '发起安排的会话 id' },
      waitingForIdle: { type: 'boolean', description: '是否已经到点、正在等会话空闲' },
      remainingSeconds: { type: 'number', description: '距离到点还有多少秒（到点后为 0）' },
      reason: { type: 'string', description: '安排时记下的原因' },
      wakeText: { type: 'string', description: '重启完成后唤醒会话时带的话' },
      maxWaitMinutes: { type: 'number', description: '最多等多久空闲（分钟）' },
      firedAt: { type: 'number', description: '最近一次真正开始重启的时间（毫秒时间戳）' },
      lastEvent: { type: 'string', description: '最近一条安排/等待/取消说明' },
      cancelled: { type: 'boolean', description: 'cancel 时是否真的取消了安排' },
    }),
    execute: async (args, exec) => {
      const 动作 = String(args?.action || '').trim().toLowerCase()
      if (!['schedule', 'cancel', 'status'].includes(动作)) {
        throw Object.assign(new Error(`action=${args?.action}`), {
          code: 'bad_request',
          hint: '参数不对：action 只能是 schedule、cancel 或 status。',
        })
      }
      if (!controller || typeof controller.状态 !== 'function') {
        return { ok: false, code: 'unavailable', hint: '重启安排没准备好，这次没有安排重启。' }
      }
      if (动作 === 'status') {
        const 状态 = controller.状态()
        return { ok: true, ...状态, hint: 状态.scheduled ? '有一个重启安排在等。' : '现在没有重启安排。' }
      }
      if (动作 === 'cancel') {
        const 结果 = controller.cancel()
        return { ok: true, ...结果, hint: 结果.cancelled ? '已取消重启安排。' : '现在没有重启安排。' }
      }
      const 调用者 = 解析调用者(exec, getConfig)
      const 结果 = controller.schedule({
        delaySeconds: args?.delaySeconds,
        wakeText: args?.wakeText,
        reason: args?.reason,
        maxWaitMinutes: args?.maxWaitMinutes,
        callerSession: 调用者.session,
        callerQQ: 调用者.qq,
      })
      return {
        ok: true,
        ...结果,
        hint: `已安排：${结果.remainingSeconds} 秒后开始等所有会话空闲，全部空闲后重启。`,
      }
    },
    logger,
  })
}

/** 注册到宿主；返回 disposer。宿主没有 ctx.tools 时安静跳过。 */
export function registerRestartTool(ctx, { controller, logger, getConfig } = {}) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    logger?.warn?.('宿主没有 ctx.tools，跳过重启工具注册')
    return () => {}
  }
  try {
    const 撤 = ctx.tools.register(buildRestartTool({ controller, logger, getConfig }))
    return () => {
      try { if (typeof 撤 === 'function') 撤() } catch { /* 已卸载 */ }
    }
  } catch (error) {
    logger?.error?.(`工具 dsh_restart 注册失败：${error?.message || error}`)
    return () => {}
  }
}
