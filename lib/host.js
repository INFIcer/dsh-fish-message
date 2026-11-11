// dsh-fish-message · 宿主入口
//
// 这个文件只做四件事：
//   1. 读配置、状态、日志，组装 transport / voice / delivery / bridge；
//   2. 挂 DSH 的 session/event 监听（出站）和 webServer 路由（设置页 / 诊断）；
//   3. 提供 /dsh-fish-message/state、/health、/save、/test-send；
//   4. 把生命周期挂到 ctx.effect 上，插件卸载时干净停掉。
//
// 所有真正的逻辑都在 lib/ 里，宿主层保持薄，方便单测。

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigStore, buildConfigSchema, publicConfig, 默认识图提示词, 默认长任务提醒文案, 默认消息通道提醒文案 } from './config.js'
import { GuardMonitor, 构造工具守卫, 提醒消息, 守卫规则, 提示段名, 提示段顺序, 心跳毫秒, 拒用工具 } from './guard.js'
import { Logger } from './logger.js'
import { StateStore } from './storage.js'
import { Outbox } from './outbox.js'
import { ForwardQueue } from './forward-queue.js'
import { NapCatOneBotTransport } from './transport/napcat-onebot.js'
import { VoiceService } from './voice.js'
import { Delivery } from './delivery.js'
import { Bridge } from './bridge.js'
import { StickerStore } from './stickers.js'
import { AiService } from './ai.js'
import { makeStickerRouteHandlers } from './sticker-routes.js'
import { makeOpenFolderHandler } from './open-folder.js'
import { registerStickerTools } from './tools.js'
import { createFishMessageApi, 注册消息服务 } from './service.js'

const 包根 = join(dirname(fileURLToPath(import.meta.url)), '..')
const 家目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 路由前缀 = '/dsh-fish-message'

export const name = 'fish-message'
export const inject = ['agents', 'sessions', 'sessionTitle', 'webServer', 'workspaceRegistry', 'attachments', 'tools']

const 版本 = (() => {
  try {
    return String(JSON.parse(readFileSync(join(包根, 'package.json'), 'utf8')).version || '0.1.0')
  } catch {
    return '0.1.0'
  }
})()

// schemastery 是可选依赖：拿不到时 Config 为 undefined，插件照常加载（配置仍走 json）。
let schemastery = null
try {
  schemastery = (await import('@deepseek-ai/schemastery')).default
} catch {
  // 不打印错误：这是正常的降级路径。
}
export const Config = schemastery ? buildConfigSchema(schemastery) : undefined

const 会话键 = (id) => {
  const s = String(id == null ? '' : id).trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

function 读体(req) {
  return new Promise((resolve) => {
    let 文 = ''
    let 超 = false
    req.on('data', (块) => {
      if (超) return
      文 += 块
      if (文.length > 2 * 1024 * 1024) {
        超 = true
        resolve({})
      }
    })
    req.on('end', () => {
      if (超) return
      try { resolve(JSON.parse(文 || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function 查询(req) {
  try {
    return new URL(String(req?.url || '/'), 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function 要方法(req, res, 方法) {
  const 来 = String(req?.method || 'GET').toUpperCase()
  if (来 === 方法) return true
  回(res, 405, { ok: false, error: 'method_not_allowed', detail: `这个接口只支持 ${方法}` })
  return false
}

function 回(res, code, data) {
  try {
    res.statusCode = code
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.end?.(JSON.stringify(data))
  } catch {
    // 客户端已经断开就算了。
  }
}

function 安全文本(v, 最大 = 300) {
  return String(v == null ? '' : v).slice(0, 最大)
}

export function apply(ctx, pluginConfig) {
  mkdirSync(家目录, { recursive: true })

  const 配置文件 = join(家目录, 'fish-message-config.json')
  const 状态文件 = join(家目录, 'fish-message-state.json')
  const 日志文件 = join(家目录, 'fish-message.log')
  const 出站文件 = join(家目录, 'fish-message-outbox.json')
  const 转发队列文件 = join(家目录, 'fish-message-forward-queue.json')
  const 收件箱 = join(家目录, 'fish-message-inbox')
  const 旧配置 = join(家目录, 'qq-bridge-config.json')
  const 旧状态 = join(家目录, 'qq-bridge-state.json')

  const configStore = new ConfigStore({ homeDir: 家目录, legacyPath: 旧配置 })
  let config = configStore.load(pluginConfig)
  const logger = new Logger({ filePath: 日志文件, level: config.logLevel })
  const store = new StateStore({ homeDir: 家目录, legacyStatePath: 旧状态 })
  const outbox = new Outbox({ homeDir: 家目录, getConfig: () => config, logger, store })
  // 暂停转发期间的待转发队列：独立文件，重启不丢。
  const forwardQueue = new ForwardQueue({ homeDir: 家目录, logger })
  // 表情库：目录来自配置；设置页改目录时走 切换目录，不用重启。
  const stickers = new StickerStore({
    dir: config.stickerDir,
    inboxDir: 收件箱,
    getConfig: () => config,
    logger,
  })

  // 如果是从旧桥切过来：把旧桥的「看到哪儿了」和已转 id 搬过来。
  // 旧文件只读，不删不改，方便回滚。
  for (const b of config.bindings) {
    try {
      const 迁移 = store.migrateLegacy(b.qq)
      if (迁移.timestamp || 迁移.ids) {
        logger.info(`从旧桥搬到 ${b.qq} 的水位：${迁移.timestamp || '无'}，已转 id ${迁移.ids} 个`)
      }
    } catch (error) {
      logger.warn(`搬旧桥状态失败（不影响启动）：${安全文本(error?.message || error)}`)
    }
  }

  const transport = new NapCatOneBotTransport({ getConfig: () => config, logger })
  const voice = new VoiceService({ getConfig: () => config, logger, transport, inboxDir: 收件箱 })
  const delivery = new Delivery({ ctx, logger })
  // 可选能力：不 inject、不 requires，用到时才 ctx.get('fish.service')；没有就是 null。
  const ai = new AiService({ getService: () => ctx.get('fish.service'), getConfig: () => config, logger })
  // 一个发射器同时给 Bridge（内部事件）和 fish.message 服务（对外事件）用。
  const 服务事件 = new EventEmitter()
  const bridge = new Bridge({ getConfig: () => config, transport, store, logger, voice, delivery, outbox, forwardQueue, stickers, events: 服务事件, ai })

  // ---------------- 防失联守卫 ----------------
  // 三层：挡掉会等人的工具、注入硬规则、卡住时提醒（必要时 QQ 兜底）。
  // 宿主版本可能缺服务，所有安装都先探测能力；失败只降级，绝不影响收发。
  const 守卫 = new GuardMonitor({ getConfig: () => config, logger })
  /** agent → { 撤: Function[], 原审批: string }；同一个 agent 只装一次。 */
  const 已装守卫 = new Map()
  let 审批可用 = false

  function 取服务(名) {
    try {
      const 服务 = ctx.get?.(名)
      if (服务 !== undefined && 服务 !== null) return 服务
    } catch { /* 没有这个服务 */ }
    try { return ctx[名] } catch { return undefined }
  }

  /** 绑定会话 → 会话标题（给提醒和 QQ 简报用）。 */
  function 标题表() {
    const 表 = new Map()
    try {
      for (const s of 会话清单()) 表.set(会话键(s.id), s.title)
    } catch { /* 没有清单就用绑定里的称呼 */ }
    return 表
  }

  function 找agent(sessionId) {
    try {
      const 原 = String(sessionId == null ? '' : sessionId).trim()
      if (!原) return undefined
      const 服务 = 取服务('agents')
      if (!服务 || typeof 服务.get !== 'function') return undefined
      // 守卫状态里存的是去掉 session- 前缀的短 id，绑定里的写法也不统一；
      // 两种写法都试一遍（DSH 的 agent id 是带前缀的完整会话 id）。
      const 候选 = [原]
      if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
      else 候选.push(`session-${原}`)
      for (const id of 候选) {
        try {
          const agent = 服务.get(id)
          if (agent) return agent
        } catch { /* 换下一个写法 */ }
      }
      return undefined
    } catch {
      return undefined
    }
  }

  function 安装守卫(agent) {
    try {
      if (!config.guardEnabled || !agent || typeof agent !== 'object') return
      const id = String(agent.id || agent.session?.id || '')
      if (!id || !守卫.是绑定(id)) return
      if (已装守卫.has(agent)) return
      const 记录 = { 撤: [], 原审批: '' }
      已装守卫.set(agent, 记录)

      // 1) 工具守卫：只挡会停下来等人、或会中断会话的工具，其余照常。
      try {
        const 工具 = agent.ctx?.tools
        if (!工具 || typeof 工具.guard !== 'function') {
          守卫.记降级('宿主没有按会话限制工具的能力：提问类工具仍可能出现')
        } else {
          const 撤 = 工具.guard(构造工具守卫())
          if (typeof 撤 === 'function') 记录.撤.push(撤)
          else 守卫.记降级('工具守卫没有返回撤销句柄')
        }
      } catch (error) {
        守卫.记降级(`工具守卫安装失败：${安全文本(error?.message || error)}`)
      }

      // 2) 提示词硬规则：只对这个会话生效，会话销毁时自动撤销。
      try {
        const 提示词 = agent.ctx?.systemPrompt
        if (!提示词 || typeof 提示词.section !== 'function') {
          守卫.记降级('宿主没有按会话注入提示词的能力')
        } else {
          const 撤 = 提示词.section({ name: 提示段名, order: 提示段顺序, text: 守卫规则 })
          if (typeof 撤 === 'function') 记录.撤.push(撤)
        }
      } catch (error) {
        守卫.记降级(`提示词注入失败：${安全文本(error?.message || error)}`)
      }

      // 3) 审批自动拒绝：没人看屏幕时，审批弹窗等于让会话停住。
      try {
        const 审批 = 取服务('approval')
        if (!审批 || typeof 审批.setPolicy !== 'function') {
          守卫.记降级('宿主没有审批策略接口：审批弹窗可能让会话停住')
        } else {
          审批可用 = true
          try {
            const 旧 = 审批.effectivePolicy?.(agent.session)
            if (typeof 旧 === 'string' && 旧) 记录.原审批 = 旧
          } catch { /* 读不到旧策略就算了 */ }
          审批.setPolicy(agent, 'never')
        }
      } catch (error) {
        守卫.记降级(`审批策略设置失败：${安全文本(error?.message || error)}`)
      }

      logger.info(`防失联：已守住会话 ${安全文本(id, 40)}`)
    } catch (error) {
      守卫.记降级(`防失联安装失败：${安全文本(error?.message || error)}`)
      try { 已装守卫.delete(agent) } catch { /* 忽略 */ }
    }
  }

  function 拆除守卫(agent) {
    const 记录 = 已装守卫.get(agent)
    if (!记录) return
    已装守卫.delete(agent)
    for (const 撤 of 记录.撤.splice(0)) {
      try { 撤() } catch { /* 会话已经销毁，撤不掉也不影响 */ }
    }
    if (记录.原审批) {
      try {
        const 审批 = 取服务('approval')
        if (审批 && typeof 审批.setPolicy === 'function') 审批.setPolicy(agent, 记录.原审批)
      } catch { /* 会话没了就恢复不了，忽略 */ }
    }
  }

  /** 配置或绑定变了之后重算：该拆的拆、该补的补。 */
  function 重设守卫() {
    try {
      守卫.设绑定(config.bindings, 标题表())
      for (const agent of [...已装守卫.keys()]) {
        const id = String(agent?.id || agent?.session?.id || '')
        if (!config.guardEnabled || !id || !守卫.是绑定(id)) 拆除守卫(agent)
      }
      if (!config.guardEnabled) return
      const 服务 = 取服务('agents')
      const 列表 = 服务 && typeof 服务.list === 'function' ? 服务.list() : []
      for (const agent of 列表 || []) 安装守卫(agent)
    } catch (error) {
      守卫.记降级(`重设防失联守卫失败：${安全文本(error?.message || error)}`)
    }
  }

  function 注入提醒(动作) {
    const agent = 找agent(动作.sessionId)
    if (!agent) {
      守卫.记降级('找不到活着的会话，提醒没能送进去')
      return
    }
    const 消息 = 提醒消息(动作.text, 动作.reason)
    try {
      // inject：只进上下文、不额外唤醒；会话正跑着时，下一个被接纳的步骤就能读到。
      if (typeof agent.inject === 'function') agent.inject(消息)
      else if (typeof agent.followup === 'function') agent.followup(消息)
      else {
        守卫.记降级('会话不支持注入提醒，提醒没能送进去')
        return
      }
    } catch (error) {
      守卫.记降级(`提醒注入失败：${安全文本(error?.message || error)}`)
      return
    }
    const 原因 = 动作.reason === 'interrupted'
      ? '刚才被中断'
      : 动作.reason === 'no-qq' ? '几轮没发 QQ' : '长时间没进展'
    logger.info(`防失联：已提醒会话 ${安全文本(动作.title, 40)}（${原因}）`)
  }

  function 执行守护动作(动作们) {
    for (const 动作 of Array.isArray(动作们) ? 动作们 : []) {
      try {
        if (动作.kind === 'remind') 注入提醒(动作)
      } catch (error) {
        logger.warn(`执行防失联动作失败：${安全文本(error?.message || error)}`)
      }
    }
  }

  // 插件可能比会话晚加载：先按当前绑定/会话补装一次。
  守卫.设绑定(config.bindings, 标题表())
  重设守卫()

  // 心跳：每 30 秒看一次有没有会话卡住。
  const 停守卫心跳 = ctx.effect(() => {
    const 滴 = setInterval(() => {
      try {
        if (!config.guardEnabled) return
        守卫.设绑定(config.bindings, 标题表())
        执行守护动作(守卫.tick())
      } catch (error) {
        logger.warn(`防失联心跳出错：${安全文本(error?.message || error)}`)
      }
    }, 心跳毫秒)
    滴.unref?.()
    return () => { try { clearInterval(滴) } catch { /* 忽略 */ } }
  }, 'fish-message: 防失联心跳')

  // 会话刚创建/销毁时增删守卫；状态和事件用来判断有没有进展。
  const 停守卫事件 = ctx.effect(() => {
    const 撤们 = []
    const 挂 = (事件, fn) => {
      try {
        const 撤 = ctx.on?.(事件, fn)
        if (typeof 撤 === 'function') 撤们.push(撤)
      } catch { /* 宿主没有事件总线就降级 */ }
    }
    挂('agent/created', (载荷) => {
      try {
        const agent = 载荷?.agent || 载荷
        守卫.设绑定(config.bindings, 标题表())
        安装守卫(agent)
      } catch (error) { 守卫.记降级(`新会话装守卫失败：${安全文本(error?.message || error)}`) }
    })
    挂('agent/status', (载荷) => {
      try {
        const agent = 载荷?.agent || 载荷
        const id = String(agent?.id || agent?.session?.id || '')
        const 状态 = 载荷?.status || agent?.status || ''
        if (id && 状态) 守卫.跟踪状态(id, 状态)
      } catch { /* 忽略 */ }
    })
    挂('agent/disposed', (载荷) => {
      try {
        const agent = 载荷?.agent || 载荷
        const id = String(agent?.id || agent?.session?.id || '')
        拆除守卫(agent)
        if (id) 守卫.忘记(id)
      } catch { /* 忽略 */ }
    })
    return () => { for (const 撤 of 撤们) { try { 撤() } catch { /* 忽略 */ } } }
  }, 'fish-message: 防失联事件')

  // 真正发出去（sent）才重置长任务计时；只进了出站队列的，只清「连续没发 QQ」。
  const 摘出站 = ctx.effect(() => {
    const 挂 = (事件, 处理) => {
      try {
        const 摘 = 服务事件.on(事件, (数据) => {
          try { 处理(数据?.qq) } catch { /* 忽略 */ }
        })
        return typeof 摘 === 'function' ? 摘 : () => {}
      } catch {
        return () => {}
      }
    }
    const 摘们 = [挂('sent', (qq) => 守卫.记QQ出站(qq)), 挂('outbound-queued', (qq) => 守卫.记QQ入队(qq))]
    return () => {
      for (const 撤 of 摘们) {
        try { 撤() } catch { /* 忽略 */ }
      }
    }
  }, 'fish-message: 出站记账')


  // 对外 Cordis 服务：ctx.get('fish.message')。薄门面，全部复用上面这些实例。
  const 消息服务 = createFishMessageApi({
    bridge,
    transport,
    voice,
    stickers,
    getConfig: () => config,
    events: 服务事件,
    logger,
  })

  logger.info(`dsh-fish-message v${版本} 正在启动｜配置：${配置文件}｜绑定 ${config.bindings.length} 条`)

  // 注册 fish.message；卸载时由 ctx.effect 自动注销（服务消失后 ops 会摘掉对应工具）。
  const 停服务 = 注册消息服务(ctx, 消息服务, logger)
  // 表情工具：fish_sticker_list / fish_sticker_send；宿主没有 ctx.tools 时安静跳过。
  const 停工具 = ctx.effect(
    () => registerStickerTools(ctx, { api: 消息服务, logger, getConfig: () => config }),
    'fish-message: 注册表情工具',
  )

  // 生命周期：启动桥；卸载时停 WS / 定时器。
  const 生命 = ctx.effect(() => {
    void bridge.start().catch((error) => logger.error(`桥启动失败：${安全文本(error?.message || error)}`))
    return () => { void bridge.stop() }
  }, 'fish-message: 启停 QQ 私聊桥')

  // 出站 + 防失联：同一个 session/event 监听里同时做回复转发和卡住判定。
  const 摘监听 = ctx.effect(() => {
    const 摘 = ctx.on('session/event', (session, event) => {
      try {
        bridge.onSessionEvent(session, event)
      } catch (error) {
        logger.warn(`处理会话事件出错：${安全文本(error?.message || error)}`)
      }
      try {
        const id = String(session?.id || session?.sessionId || '')
        if (id && config.guardEnabled) {
          守卫.设绑定(config.bindings, 标题表())
          执行守护动作(守卫.处理事件(id, event))
        }
      } catch (error) {
        logger.warn(`防失联判定出错：${安全文本(error?.message || error)}`)
      }
    })
    return () => {
      try { if (typeof 摘 === 'function') 摘() } catch { /* 忽略 */ }
    }
  }, 'fish-message: 盯绑定会话的回复')

  /** 现在活着的会话（设置页挑绑定用）。 */
  function 会话清单() {
    const 出 = []
    try {
      const 服务 = ctx.get('sessions')
      const 标题服务 = ctx.get('sessionTitle')
      const 登记 = ctx.get('workspaceRegistry')
      const 归档 = new Set(((登记 && 登记.archivedSessionIds) || []).map(String))
      const 列表 = 服务 && typeof 服务.list === 'function' ? 服务.list() : []
      for (const s of 列表 || []) {
        const id = String(s?.id || s?.sessionId || '')
        if (!id || 归档.has(id) || 归档.has(会话键(id))) continue
        let 标题 = ''
        try {
          const 快照 = 标题服务 && typeof 标题服务.get === 'function' ? 标题服务.get(s) : undefined
          标题 = 快照 && 快照.title ? String(快照.title) : ''
        } catch { /* 没标题就空着 */ }
        出.push({ id, title: 标题 || `…${id.slice(-8)}` })
      }
    } catch (error) {
      logger.debug(`读会话清单失败：${安全文本(error?.message || error)}`)
    }
    return 出
  }

  function 状态() {
    const 清单 = 会话清单()
    const 标题表 = new Map(清单.map((x) => [会话键(x.id), x.title]))
    const b = bridge.state()
    return {
      ok: true,
      version: 版本,
      configFile: 配置文件,
      stateFile: 状态文件,
      outboxFile: 出站文件,
      forwardFile: 转发队列文件,
      logFile: 日志文件,
      inboxDir: 收件箱,
      config: publicConfig(config),
      // 设置页要显示「留空时用哪段默认」；默认文案只放在 config.js 一处。
      defaults: {
        inboundImagePrompt: 默认识图提示词,
        guardStuckPrompt: 默认长任务提醒文案,
        guardQqPrompt: 默认消息通道提醒文案,
      },
      ai: ai.status(),
      // 防失联：设置页显示在盯几个会话、有没有降级、哪些会话正在被提醒。
      guard: {
        enabled: Boolean(config.guardEnabled),
        approvalAvailable: 审批可用,
        approvalNever: Boolean(config.guardEnabled && 审批可用),
        deniedTools: [...拒用工具],
        ...守卫.快照(),
      },
      bridge: b,
      transport: b.transport,
      bindings: (config.bindings || []).map((x) => ({
        ...x,
        会话标题: 标题表.get(会话键(x.session)) || '',
        活着: 清单.some((y) => 会话键(y.id) === 会话键(x.session)),
      })),
      sessions: 清单,
      stickers: stickers.stats(),
      stickerDir: stickers.dir,
      stickerDirExists: existsSync(stickers.dir),
      logs: logger.recent(200),
      ts: Date.now(),
    }
  }

  async function 重启桥() {
    await bridge.stop()
    await bridge.start()
  }

  const 路线 = (路径, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: 路径,
    handler: async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        logger.error(`路由 ${路径} 出错：${安全文本(error?.message || error, 500)}`)
        回(res, 500, { ok: false, error: 安全文本(error?.message || error, 500) })
      }
    },
  }), `fish-message: ${路径}`)

  // 前缀路由：DELETE /outbox/{id} 这种带路径参数的接口用。
  const 前缀路线 = (路径, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: 路径,
    handler: async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        logger.error(`路由 ${路径}* 出错：${安全文本(error?.message || error, 500)}`)
        回(res, 500, { ok: false, error: 安全文本(error?.message || error, 500) })
      }
    },
  }), `fish-message: ${路径}*`)

  路线(`${路由前缀}/state`, async (_req, res) => {
    回(res, 200, 状态())
  })

  // 设置页的发送音色下拉：服务不可用时返回空列表 + 一句提示，前端退回文本输入。
  路线(`${路由前缀}/ai/voices`, async (_req, res) => {
    const 结果 = await ai.listVoices()
    回(res, 200, 结果?.ok ? { ok: true, voices: 结果.voices } : { ok: false, voices: [], hint: 结果?.hint || '' })
  })

  路线(`${路由前缀}/health`, async (_req, res) => {
    const 桥 = bridge.state()
    const 在 = Boolean(桥?.running)
    回(res, 在 ? 200 : 503, {
      ok: 在,
      version: 版本,
      transport: 桥?.transport || null,
      bindings: (config.bindings || []).length,
      queueSize: 桥?.queueSize || 0,
      outboxPending: 桥?.outbox?.pending || 0,
      lastSyncAt: 桥?.lastSyncAt || 0,
      lastError: 桥?.lastSyncError || 桥?.stats?.lastError || '',
    })
  })

  路线(`${路由前缀}/save`, async (req, res) => {
    const 来 = await 读体(req)
    const 补丁 = 来 && typeof 来.config === 'object' ? 来.config : 来
    const 旧 = config
    const 合并 = { ...config, ...(补丁 && typeof 补丁 === 'object' ? 补丁 : {}) }
    // 设置页显示的是打码后的令牌；原样提交回来时保留旧令牌。
    if (合并.napcatToken === '***已设置***') 合并.napcatToken = 旧.napcatToken

    const 保存 = configStore.save(合并)
    if (!保存) {
      回(res, 500, { ok: false, error: `写不进配置文件：${配置文件}` })
      return
    }
    const 连接变了 = 保存.napcatBaseUrl !== 旧.napcatBaseUrl
      || 保存.wsUrl !== 旧.wsUrl
      || 保存.napcatToken !== 旧.napcatToken
      || 保存.wsEnabled !== 旧.wsEnabled
      || 保存.pollIntervalMs !== 旧.pollIntervalMs
    config = 保存
    logger.setLevel(config.logLevel)
    if (config.stickerDir !== 旧.stickerDir) {
      try {
        stickers.切换目录(config.stickerDir)
        logger.info(`表情库目录已切换：${stickers.dir}`)
      } catch (error) {
        logger.error(`切换表情库目录失败：${安全文本(error?.message || error)}`)
      }
    }
    logger.info(`设置已保存：绑定 ${config.bindings.length} 条｜只发标记内 ${config.onlyInsideMarkers ? '开' : '关'}｜补投窗口 ${config.backfillWindowHours} 小时`)
    if (连接变了) {
      logger.info('连接参数变了，正在重启传输层…')
      await 重启桥()
    } else {
      bridge.updateConfig()
    }
    // 防失联开关或绑定变了：按新配置补装/拆除。
    重设守卫()
    回(res, 200, { ok: true, message: '保存好了', ...状态() })
  })

  路线(`${路由前缀}/test-send`, async (req, res) => {
    const 来 = await 读体(req)
    try {
      const 结果 = await bridge.testSend(来.qq)
      回(res, 200, { ok: true, ...结果 })
    } catch (error) {
      回(res, 400, { ok: false, error: 安全文本(error?.message || error, 500) })
    }
  })

  路线(`${路由前缀}/logs`, async (_req, res) => {
    回(res, 200, { ok: true, logs: logger.recent(200) })
  })

  // ---------------- 表情库接口 ----------------
  // 全部由 lib/sticker-routes.js 生成，这里只负责挂到 webServer。
  for (const [路径, 处理] of Object.entries(makeStickerRouteHandlers({
    stickers,
    bridge,
    getConfig: () => config,
    logger,
    inboxDir: 收件箱,
    路由前缀,
  }))) {
    路线(路径, 处理)
  }

  // ---------------- 打开文件夹 ----------------
  // 只允许打开插件自己的目录；绝对路径、存在性、越界与大小写校验都在 lib/open-folder.js。
  路线(`${路由前缀}/open-folder`, makeOpenFolderHandler({
    允许目录们: () => [
      stickers.dir,
      收件箱,
      dirname(出站文件),
      join(家目录, 'fish-message-cache'),
    ],
    logger,
  }))

  // ---------------- 出站队列接口 ----------------

  路线(`${路由前缀}/outbox`, async (req, res) => {
    if (!要方法(req, res, 'GET')) return
    const 限制 = Number(查询(req).get('limit')) || 50
    回(res, 200, { ok: true, ...bridge.listOutbox({ limit: 限制 }) })
  })

  路线(`${路由前缀}/outbox/flush`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    const 结果 = await bridge.flushOutbox('manual', { force: true })
    回(res, 结果.ok ? 200 : 503, 结果)
  })

  路线(`${路由前缀}/outbox/clear`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    回(res, 200, { ok: true, ...bridge.clearOutbox() })
  })

  前缀路线(`${路由前缀}/outbox/`, async (req, res) => {
    if (!要方法(req, res, 'DELETE')) return
    let 标识 = ''
    try {
      标识 = decodeURIComponent(new URL(String(req.url || '/'), 'http://127.0.0.1').pathname.slice(`${路由前缀}/outbox/`.length))
    } catch {
      标识 = ''
    }
    if (!标识 || 标识.includes('/')) {
      回(res, 404, { ok: false, error: 'not_found', detail: '没有这个出站队列条目' })
      return
    }
    const 结果 = bridge.dropOutbox(标识)
    if (!结果.deleted) {
      回(res, 404, { ok: false, error: 'not_found', detail: `出站队列里没有 ${标识}` })
      return
    }
    回(res, 200, { ok: true, ...结果 })
  })

  // 启动完成后把状态打进日志，方便没有设置页时也能从文件排查。
  setTimeout(() => {
    try {
      const 状 = bridge.state()
      logger.info(`连接状态：${状.transport?.mode || '未知'}｜在线 ${状.transport?.online ? '是' : '否'}｜收件队列 ${状.queueSize}｜出站积压 ${状.outbox?.pending || 0}｜待转发 ${状.forward?.pending || 0}${状.forward?.paused ? '（已暂停）' : ''}`)
    } catch { /* 忽略 */ }
  }, 1500)

  return { bridge, outbox, forwardQueue, logger, configStore, store, transport, voice, delivery, stickers, ai, guard: 守卫, message: 消息服务, 服务事件, 停: async () => {
    try { 生命?.() } catch { /* 忽略 */ }
    try { 摘监听?.() } catch { /* 忽略 */ }
    try { 停守卫心跳?.() } catch { /* 忽略 */ }
    try { 停守卫事件?.() } catch { /* 忽略 */ }
    for (const agent of [...已装守卫.keys()]) 拆除守卫(agent)
    try { 停工具?.() } catch { /* 忽略 */ }
    try { 摘出站?.() } catch { /* 忽略 */ }
    try { if (typeof 停服务 === 'function') 停服务() } catch { /* 忽略 */ }
    try { 服务事件.removeAllListeners() } catch { /* 忽略 */ }
    await bridge.stop()
  } }
}

export { 版本 as version, 路由前缀 }
