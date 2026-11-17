// dsh-fish-message · 宿主入口
//
// 这个文件只做四件事：
//   1. 读配置、状态、日志，组装 transport / voice / delivery / bridge；
//   2. 挂 DSH 的 session/event 监听（出站）和 webServer 路由（设置页 / 诊断）；
//   3. 提供 /dsh-fish-message/state、/health、/save、/bindings/assign、/test-send；
//   4. 把生命周期挂到 ctx.effect 上，插件卸载时干净停掉。
//
// 所有真正的逻辑都在 lib/ 里，宿主层保持薄，方便单测。

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigStore, buildConfigSchema, publicConfig, defaultImagePrompt, defaultLongTaskReminder, defaultChannelReminder } from './config.js'
import { GuardMonitor, constructToolGuard, reminderMessage, guardRules, promptSegmentName, promptSegmentOrder, heartbeatMs, refuseTool } from './guard.js'
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
import { ImageLibrary, defaultDirName as imageLibraryDirName } from './image-library.js'
import { VisionCache } from './vision-cache.js'
import { registerImageTools } from './image-tools.js'
import { makeStickerRouteHandlers } from './sticker-routes.js'
import { makeGalleryRouteHandlers } from './gallery-routes.js'
import { makeOpenFolderHandler } from './open-folder.js'
import { registerStickerTools } from './tools.js'
import { createFishMessageApi, registerMessageService } from './service.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const homeDir = process.env.DSH_HOME || join(homedir(), '.dsh')
const routePrefix = '/dsh-fish-message'

export const name = 'fish-message'
export const inject = ['agents', 'sessions', 'sessionTitle', 'webServer', 'workspaceRegistry', 'attachments', 'tools']

const version = (() => {
  try {
    return String(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version || '0.1.0')
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

const sessionKey = (id) => {
  const s = String(id == null ? '' : id).trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

function readPayload(req) {
  return new Promise((resolve) => {
    let body = ''
    let exceeded = false
    req.on('data', (chunk) => {
      if (exceeded) return
      body += chunk
      if (body.length > 2 * 1024 * 1024) {
        exceeded = true
        resolve({})
      }
    })
    req.on('end', () => {
      if (exceeded) return
      try { resolve(JSON.parse(body || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function query(req) {
  try {
    return new URL(String(req?.url || '/'), 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function requireMethod(req, res, method) {
  const incoming = String(req?.method || 'GET').toUpperCase()
  if (incoming === method) return true
  respond(res, 405, { ok: false, error: 'method_not_allowed', detail: `这个接口只支持 ${method}` })
  return false
}

function respond(res, code, data) {
  try {
    res.statusCode = code
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.end?.(JSON.stringify(data))
  } catch {
    // 客户端已经断开就算了。
  }
}

function safeText(v, max = 300) {
  return String(v == null ? '' : v).slice(0, max)
}

export function apply(ctx, pluginConfig) {
  mkdirSync(homeDir, { recursive: true })

  const configFile = join(homeDir, 'fish-message-config.json')
  const stateFile = join(homeDir, 'fish-message-state.json')
  const logFile = join(homeDir, 'fish-message.log')
  const outboxFile = join(homeDir, 'fish-message-outbox.json')
  const forwardQueueFile = join(homeDir, 'fish-message-forward-queue.json')
  const inbox = join(homeDir, 'fish-message-inbox')
  const legacyConfig = join(homeDir, 'qq-bridge-config.json')
  const legacyState = join(homeDir, 'qq-bridge-state.json')

  // 先按 info 建日志，配置读坏时也能记下留档路径；读到配置后再按配置调级别。
  const logger = new Logger({ filePath: logFile, level: 'info' })
  const configStore = new ConfigStore({ homeDir: homeDir, legacyPath: legacyConfig, logger })
  let config = configStore.load(pluginConfig)
  logger.setLevel(config.logLevel)
  const store = new StateStore({ homeDir: homeDir, legacyStatePath: legacyState, logger })
  const outbox = new Outbox({ homeDir: homeDir, getConfig: () => config, logger, store })
  // 暂停转发期间的待转发队列：独立文件，重启不丢。
  const forwardQueue = new ForwardQueue({ homeDir: homeDir, logger })
  // 表情库：目录来自配置；设置页改目录时走 切换目录，不用重启。
  const stickers = new StickerStore({
    dir: config.stickerDir,
    inboxDir: inbox,
    getConfig: () => config,
    logger,
  })

  // 如果是从旧桥切过来：把旧桥的「看到哪儿了」和已转 id 搬过来。
  // 旧文件只读，不删不改，方便回滚。
  for (const b of config.bindings) {
    try {
      const migrate = store.migrateLegacy(b.qq)
      if (migrate.timestamp || migrate.ids) {
        logger.info(`从旧桥搬到 ${b.qq} 的水位：${migrate.timestamp || '无'}，已转 id ${migrate.ids} 个`)
      }
    } catch (error) {
      logger.warn(`搬旧桥状态失败（不影响启动）：${safeText(error?.message || error)}`)
    }
  }

  const transport = new NapCatOneBotTransport({ getConfig: () => config, logger })
  const voice = new VoiceService({ getConfig: () => config, logger, transport, inboxDir: inbox })
  const delivery = new Delivery({ ctx, logger })
  // 可选能力：不 inject、不 requires，用到时才 ctx.get('fish.service')；没有就是 null。
  const ai = new AiService({ getService: () => ctx.get('fish.service'), getConfig: () => config, logger })
  // 记忆扩展：记忆插件通过 Cordis 服务 memory.library 提供图库 / 声纹库。
  // 这里不 import 对方代码，只按服务名惰性取值；插件晚加载也能在下次消息时取到。
  // 没装时取值函数返回 undefined（抛错也吞掉），不影响收发。
  let memoryMissingWarned = false
  function memoryService() {
    try {
      return ctx.get?.('memory.library') ?? undefined
    } catch {
      return undefined
    }
  }
  /** 给 Bridge 的取值函数：第一次探测失败只 warn 一次，避免每条消息刷日志。 */
  function memoryForBridge() {
    const service = memoryService()
    if (!service && !memoryMissingWarned) {
      memoryMissingWarned = true
      logger.warn('没有检测到记忆服务（memory.library），记忆扩展已跳过；装好记忆插件并重启后再试。')
    }
    return service
  }
  // 启动时探一次，只用于日志；设置页的状态每次 /state 现探，不另开轮询。
  if (memoryService()) logger.info('记忆服务已连接：记忆扩展可比对图片与声纹（开关见设置页）')
  else logger.debug('没有检测到记忆服务（memory.library）；记忆扩展不可用，其它功能照常')
  // 收图图库：按 sha256 缓存「原图 + 识别描述」，默认目录 <家目录>/fish-message-images。
  // 与表情库互不相干：图库是缓存语义（允许淘汰），表情库是收藏语义（绝不静默删）。
  const imageLibrary = new ImageLibrary({
    dir: join(homeDir, imageLibraryDirName),
    maxItems: config.imageLibraryMaxItems,
    maxMB: config.imageLibraryMaxMB,
    keepFiles: config.imageLibraryKeepFiles,
    logger,
  })
  // stickers 只作为「缺描述时的兜底来源」：表情库里存过的图可能带着描述，借来省一次识图。
  const visionCache = new VisionCache({ library: imageLibrary, ai, stickers, getConfig: () => config, logger })
  // 一个发射器同时给 Bridge（内部事件）和 fish.message 服务（对外事件）用。
  const serviceEvent = new EventEmitter()
  const bridge = new Bridge({ getConfig: () => config, transport, store, logger, voice, delivery, outbox, forwardQueue, stickers, events: serviceEvent, ai, visionCache, memory: memoryForBridge })

  // ---------------- 防失联守卫 ----------------
  // 三层：挡掉会等人的工具、注入硬规则、卡住时提醒（必要时 QQ 兜底）。
  // 宿主版本可能缺服务，所有安装都先探测能力；失败只降级，绝不影响收发。
  const guard = new GuardMonitor({ getConfig: () => config, logger })
  /** agent → { 撤: Function[], 原审批: string }；同一个 agent 只装一次。 */
  const installedGuards = new Map()
  let approvalAvailable = false

  function getService(name) {
    try {
      const service = ctx.get?.(name)
      if (service !== undefined && service !== null) return service
    } catch { /* 没有这个服务 */ }
    try { return ctx[name] } catch { return undefined }
  }

  /** 绑定会话 → 会话标题（给提醒和 QQ 简报用）。 */
  function titleTable() {
    const table = new Map()
    try {
      for (const s of sessionList()) table.set(sessionKey(s.id), s.title)
    } catch { /* 没有清单就用绑定里的称呼 */ }
    return table
  }

  function findAgent(sessionId) {
    try {
      const original = String(sessionId == null ? '' : sessionId).trim()
      if (!original) return undefined
      const service = getService('agents')
      if (!service || typeof service.get !== 'function') return undefined
      // 守卫状态里存的是去掉 session- 前缀的短 id，绑定里的写法也不统一；
      // 两种写法都试一遍（DSH 的 agent id 是带前缀的完整会话 id）。
      const candidate = [original]
      if (original.startsWith('session-')) candidate.push(original.slice('session-'.length))
      else candidate.push(`session-${original}`)
      for (const id of candidate) {
        try {
          const agent = service.get(id)
          if (agent) return agent
        } catch { /* 换下一个写法 */ }
      }
      return undefined
    } catch {
      return undefined
    }
  }

  function installGuard(agent) {
    try {
      if (!config.guardEnabled || !agent || typeof agent !== 'object') return
      const id = String(agent.id || agent.session?.id || '')
      if (!id || !guard.isBinding(id)) return
      if (installedGuards.has(agent)) return
      const record = { abort: [], originalApproval: '' }
      installedGuards.set(agent, record)

      // 1) 工具守卫：只挡会停下来等人、或会中断会话的工具，其余照常。
      try {
        const tool = agent.ctx?.tools
        if (!tool || typeof tool.guard !== 'function') {
          guard.noteDegraded('宿主没有按会话限制工具的能力：提问类工具仍可能出现')
        } else {
          const abort = tool.guard(constructToolGuard())
          if (typeof abort === 'function') record.abort.push(abort)
          else guard.noteDegraded('工具守卫没有返回撤销句柄')
        }
      } catch (error) {
        guard.noteDegraded(`工具守卫安装失败：${safeText(error?.message || error)}`)
      }

      // 2) 提示词硬规则：只对这个会话生效，会话销毁时自动撤销。
      try {
        const prompt = agent.ctx?.systemPrompt
        if (!prompt || typeof prompt.section !== 'function') {
          guard.noteDegraded('宿主没有按会话注入提示词的能力')
        } else {
          const abort = prompt.section({ name: promptSegmentName, order: promptSegmentOrder, text: guardRules })
          if (typeof abort === 'function') record.abort.push(abort)
        }
      } catch (error) {
        guard.noteDegraded(`提示词注入失败：${safeText(error?.message || error)}`)
      }

      // 3) 审批自动拒绝：没人看屏幕时，审批弹窗等于让会话停住。
      try {
        const approval = getService('approval')
        if (!approval || typeof approval.setPolicy !== 'function') {
          guard.noteDegraded('宿主没有审批策略接口：审批弹窗可能让会话停住')
        } else {
          approvalAvailable = true
          try {
            const prev = approval.effectivePolicy?.(agent.session)
            if (typeof prev === 'string' && prev) record.originalApproval = prev
          } catch { /* 读不到旧策略就算了 */ }
          approval.setPolicy(agent, 'never')
        }
      } catch (error) {
        guard.noteDegraded(`审批策略设置失败：${safeText(error?.message || error)}`)
      }

      logger.info(`防失联：已守住会话 ${safeText(id, 40)}`)
    } catch (error) {
      guard.noteDegraded(`防失联安装失败：${safeText(error?.message || error)}`)
      try { installedGuards.delete(agent) } catch { /* 忽略 */ }
    }
  }

  function removeGuard(agent) {
    const record = installedGuards.get(agent)
    if (!record) return
    installedGuards.delete(agent)
    for (const abort of record.abort.splice(0)) {
      try { abort() } catch { /* 会话已经销毁，撤不掉也不影响 */ }
    }
    if (record.originalApproval) {
      try {
        const approval = getService('approval')
        if (approval && typeof approval.setPolicy === 'function') approval.setPolicy(agent, record.originalApproval)
      } catch { /* 会话没了就恢复不了，忽略 */ }
    }
  }

  /** 配置或绑定变了之后重算：该拆的拆、该补的补。 */
  function resetGuard() {
    try {
      guard.setBindings(config.bindings, titleTable())
      for (const agent of [...installedGuards.keys()]) {
        const id = String(agent?.id || agent?.session?.id || '')
        if (!config.guardEnabled || !id || !guard.isBinding(id)) removeGuard(agent)
      }
      if (!config.guardEnabled) return
      const service = getService('agents')
      const list = service && typeof service.list === 'function' ? service.list() : []
      for (const agent of list || []) installGuard(agent)
    } catch (error) {
      guard.noteDegraded(`重设防失联守卫失败：${safeText(error?.message || error)}`)
    }
  }

  // 提醒先进这里排队，再由定时器在宿主空闲的瞬间塞进会话。
  // 直接在某次 append 的回调里塞会被宿主拒绝（session append cannot reenter），
  // 所以统一挪到 setTimeout 里，失败就很快重试，而不是等到下个心跳。
  const pendingInjection = []
  let injectionTimer = null
  const maxInjectRetryMs = 30000
  const injectRetryIntervalMs = 200

  function injectReminder(action) {
    const agent = findAgent(action.sessionId)
    if (!agent) {
      guard.countInjectFailure(action.sessionId)
      guard.noteDegraded('找不到活着的会话，提醒没能送进去')
      return false
    }
    const message = reminderMessage(action.text, action.reason)
    try {
      // inject：只进上下文、不额外唤醒；会话正跑着时，下一个被接纳的步骤就能读到。
      if (typeof agent.inject === 'function') agent.inject(message)
      else if (typeof agent.followup === 'function') agent.followup(message)
      else {
        guard.countInjectFailure(action.sessionId)
        guard.noteDegraded('会话不支持注入提醒，提醒没能送进去')
        return false
      }
    } catch (error) {
      // 宿主正忙不是这条提醒的错：先留着预订，排队重试；真送不进去才退回。
      return { error: safeText(error?.message || error) }
    }
    const reason = action.reason === 'interrupted'
      ? '刚才被中断'
      : action.reason === 'no-qq' ? '几轮没发 QQ' : '长时间没进展'
    logger.info(`防失联：已提醒会话 ${safeText(action.title, 40)}（${reason}）`)
    return true
  }

  function scheduleFlushInjection() {
    if (injectionTimer) return
    injectionTimer = setTimeout(() => { injectionTimer = null; flushInjection() }, 0)
    injectionTimer.unref?.()
  }

  function flushInjection() {
    const now = Date.now()
    for (let i = pendingInjection.length - 1; i >= 0; i -= 1) {
      const item = pendingInjection[i]
      const result = injectReminder(item.action)
      if (result === true) { pendingInjection.splice(i, 1); continue }
      if (result === false) { pendingInjection.splice(i, 1); continue }
      if (now - item.begin >= maxInjectRetryMs) {
        pendingInjection.splice(i, 1)
        guard.countInjectFailure(item.action.sessionId)
        guard.noteDegraded(`提醒注入失败：${result?.error || '会话一直忙'}`)
      }
    }
    if (pendingInjection.length > 0) {
      const next = setTimeout(() => { injectionTimer = null; flushInjection() }, injectRetryIntervalMs)
      next.unref?.()
      injectionTimer = next
    }
  }

  function queueInjection(action) {
    if (pendingInjection.some((item) => item.action.sessionId === action.sessionId && item.action.reason === action.reason)) {
      guard.countInjectFailure(action.sessionId)
      return
    }
    pendingInjection.push({ action, begin: Date.now() })
    scheduleFlushInjection()
  }

  function runGuardAction(actions) {
    for (const action of Array.isArray(actions) ? actions : []) {
      try {
        if (action.kind === 'remind') queueInjection(action)
      } catch (error) {
        logger.warn(`执行防失联动作失败：${safeText(error?.message || error)}`)
      }
    }
  }

  // 插件可能比会话晚加载：先按当前绑定/会话补装一次。
  guard.setBindings(config.bindings, titleTable())
  resetGuard()

  // 心跳：每 30 秒看一次有没有会话卡住。
  const stopGuardHeartbeat = ctx.effect(() => {
    const tick = setInterval(() => {
      try {
        if (!config.guardEnabled) return
        guard.setBindings(config.bindings, titleTable())
        runGuardAction(guard.tick())
      } catch (error) {
        logger.warn(`防失联心跳出错：${safeText(error?.message || error)}`)
      }
    }, heartbeatMs)
    tick.unref?.()
    return () => { try { clearInterval(tick) } catch { /* 忽略 */ } }
  }, 'fish-message: 防失联心跳')

  // 会话刚创建/销毁时增删守卫；状态和事件用来判断有没有进展。
  const stopGuardEvents = ctx.effect(() => {
    const aborters = []
    const hook = (event, fn) => {
      try {
        const abort = ctx.on?.(event, fn)
        if (typeof abort === 'function') aborters.push(abort)
      } catch { /* 宿主没有事件总线就降级 */ }
    }
    hook('agent/created', (payload) => {
      try {
        const agent = payload?.agent || payload
        guard.setBindings(config.bindings, titleTable())
        installGuard(agent)
      } catch (error) { guard.noteDegraded(`新会话装守卫失败：${safeText(error?.message || error)}`) }
    })
    hook('agent/status', (payload) => {
      try {
        const agent = payload?.agent || payload
        const id = String(agent?.id || agent?.session?.id || '')
        const status = payload?.status || agent?.status || ''
        // 新回合开始时守卫可能要把上一回合的延后判定补上，所以要接着执行返回的动作。
        if (id && status) runGuardAction(guard.trackStatus(id, status))
      } catch { /* 忽略 */ }
    })
    hook('agent/disposed', (payload) => {
      try {
        const agent = payload?.agent || payload
        const id = String(agent?.id || agent?.session?.id || '')
        removeGuard(agent)
        if (id) guard.forget(id)
      } catch { /* 忽略 */ }
    })
    return () => { for (const abort of aborters) { try { abort() } catch { /* 忽略 */ } } }
  }, 'fish-message: 防失联事件')

  // 只有真正发出去（sent）才算 QQ 送达；只进本地出站队列（outbound-queued）说明用户
  // 还没收到，不能清「连续没发 QQ」的计数，也不能重置卡住计时。
  const detachOutbox = ctx.effect(() => {
    const hook = (event, process) => {
      try {
        const detach = serviceEvent.on(event, (data) => {
          try { process(data?.qq) } catch { /* 忽略 */ }
        })
        return typeof detach === 'function' ? detach : () => {}
      } catch {
        return () => {}
      }
    }
    const detachers = [hook('sent', (qq) => guard.noteQqOutbound(qq))]
    return () => {
      for (const abort of detachers) {
        try { abort() } catch { /* 忽略 */ }
      }
    }
  }, 'fish-message: 出站记账')


  // 对外 Cordis 服务：ctx.get('fish.message')。薄门面，全部复用上面这些实例。
  const messageService = createFishMessageApi({
    bridge,
    transport,
    voice,
    stickers,
    images: imageLibrary,
    ai,
    getConfig: () => config,
    events: serviceEvent,
    logger,
  })

  logger.info(`dsh-fish-message v${version} 正在启动｜配置：${configFile}｜绑定 ${config.bindings.length} 条`)

  // 注册 fish.message；卸载时由 ctx.effect 自动注销（服务消失后 ops 会摘掉对应工具）。
  const stopService = registerMessageService(ctx, messageService, logger)
  // 表情工具：fish_sticker_list / fish_sticker_send / fish_sticker_save；宿主没有 ctx.tools 时安静跳过。
  const stopTool = ctx.effect(
    () => registerStickerTools(ctx, { api: messageService, logger, getConfig: () => config }),
    'fish-message: 注册表情工具',
  )
  // 图库工具：fish_image_get（取原图，尽量返回图片附件）/ fish_image_note（写回描述）。
  const stopImageTool = ctx.effect(
    () => registerImageTools(ctx, {
      api: messageService,
      logger,
      getConfig: () => config,
      getAttachments: () => getService('attachments'),
      getLlm: () => getService('llm'),
    }),
    'fish-message: 注册图库工具',
  )

  // 生命周期：启动桥；卸载时停 WS / 定时器。
  const lifecycle = ctx.effect(() => {
    void bridge.start().catch((error) => logger.error(`桥启动失败：${safeText(error?.message || error)}`))
    return () => { void bridge.stop() }
  }, 'fish-message: 启停 QQ 私聊桥')

  // 入站图片/语音缓存有保留期：启动后先清一次，之后每小时清一次。
  // 只碰收件箱里的 qq-image-* / qq-voice-*；表情库目录由 StickerStore 自己管。
  const stopCacheCleanup = ctx.effect(() => {
    const cleanup = () => {
      try {
        const days = Math.max(1, Number(config.inboxTtlDays) || 14)
        const result = stickers.cleanupExpireCache(days * 24 * 3600 * 1000)
        if (result.removed) logger.info(`清理入站缓存：${result.removed} 个文件，释放 ${result.freedMB} MB`)
      } catch (error) {
        logger.warn(`清理入站缓存失败：${safeText(error?.message || error)}`)
      }
    }
    cleanup()
    const timer = setInterval(cleanup, 60 * 60 * 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'fish-message: 清入站缓存')

  // 出站 + 防失联：同一个 session/event 监听里同时做回复转发和卡住判定。
  // 这里的先后顺序不影响判定：桥在 turn/end 之后才把 [QQ] 投出去，守卫的
  // 「这一回合发没发 QQ」因此延后到心跳里判（见 lib/guard.js 的 判掉待判定）。
  const detachListeners = ctx.effect(() => {
    const detach = ctx.on('session/event', (session, event) => {
      try {
        bridge.onSessionEvent(session, event)
      } catch (error) {
        logger.warn(`处理会话事件出错：${safeText(error?.message || error)}`)
      }
      try {
        const id = String(session?.id || session?.sessionId || '')
        if (id && config.guardEnabled) {
          guard.setBindings(config.bindings, titleTable())
          runGuardAction(guard.handleEvent(id, event))
        }
      } catch (error) {
        logger.warn(`防失联判定出错：${safeText(error?.message || error)}`)
      }
    })
    return () => {
      try { if (typeof detach === 'function') detach() } catch { /* 忽略 */ }
    }
  }, 'fish-message: 盯绑定会话的回复')

  /** 现在活着的会话（设置页挑绑定用）。 */
  function sessionList() {
    const out = []
    try {
      const service = ctx.get('sessions')
      const titleService = ctx.get('sessionTitle')
      const register = ctx.get('workspaceRegistry')
      const archive = new Set(((register && register.archivedSessionIds) || []).map(String))
      const list = service && typeof service.list === 'function' ? service.list() : []
      for (const s of list || []) {
        const id = String(s?.id || s?.sessionId || '')
        if (!id || archive.has(id) || archive.has(sessionKey(id))) continue
        let title = ''
        try {
          const snapshot = titleService && typeof titleService.get === 'function' ? titleService.get(s) : undefined
          title = snapshot && snapshot.title ? String(snapshot.title) : ''
        } catch { /* 没标题就空着 */ }
        out.push({ id, title: title || `…${id.slice(-8)}` })
      }
    } catch (error) {
      logger.debug(`读会话清单失败：${safeText(error?.message || error)}`)
    }
    return out
  }

  function status() {
    const checklist = sessionList()
    const titleTable = new Map(checklist.map((x) => [sessionKey(x.id), x.title]))
    const b = bridge.state()
    const aiStatus = ai.status()
    return {
      ok: true,
      version: version,
      configFile: configFile,
      stateFile: stateFile,
      outboxFile: outboxFile,
      forwardFile: forwardQueueFile,
      logFile: logFile,
      inboxDir: inbox,
      config: publicConfig(config),
      // 设置页要显示「留空时用哪段默认」；默认文案只放在 config.js 一处。
      defaults: {
        inboundImagePrompt: defaultImagePrompt,
        guardStuckPrompt: defaultLongTaskReminder,
        guardQqPrompt: defaultChannelReminder,
      },
      ai: aiStatus,
      // 记忆扩展：设置页两条状态行直接读这里（服务每次现探，不另开轮询）。
      memory: {
        service: Boolean(memoryService()),
        localAI: Boolean(aiStatus.online),
      },
      // 防失联：设置页显示在盯几个会话、有没有降级、哪些会话正在被提醒。
      guard: {
        enabled: Boolean(config.guardEnabled),
        approvalAvailable: approvalAvailable,
        approvalNever: Boolean(config.guardEnabled && approvalAvailable),
        deniedTools: [...refuseTool],
        ...guard.snapshot(),
      },
      bridge: b,
      transport: b.transport,
      bindings: (config.bindings || []).map((x) => {
        const sessionTitle = titleTable.get(sessionKey(x.session)) || ''
        const alive = checklist.some((y) => sessionKey(y.id) === sessionKey(x.session))
        // 新名为主；旧版字段名（中文）保留一份，老前端与外部脚本仍在读。
        return { ...x, sessionTitle, alive, '会话标题': sessionTitle, '活着': alive }
      }),
      sessions: checklist,
      stickers: stickers.stats(),
      stickerDir: stickers.dir,
      stickerDirExists: existsSync(stickers.dir),
      // 收图图库：设置页显示张数/占用，状态里一并给。
      images: imageLibrary.stats(),
      imageDir: imageLibrary.dir,
      imageDirExists: existsSync(imageLibrary.dir),
      logs: logger.recent(200),
      ts: Date.now(),
    }
  }

  async function restartBridge() {
    await bridge.stop()
    await bridge.start()
  }

  const route = (path, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: path,
    handler: async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        logger.error(`路由 ${path} 出错：${safeText(error?.message || error, 500)}`)
        respond(res, 500, { ok: false, error: safeText(error?.message || error, 500) })
      }
    },
  }), `fish-message: ${path}`)

  // 前缀路由：DELETE /outbox/{id} 这种带路径参数的接口用。
  const prefixRoute = (path, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: path,
    handler: async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        logger.error(`路由 ${path}* 出错：${safeText(error?.message || error, 500)}`)
        respond(res, 500, { ok: false, error: safeText(error?.message || error, 500) })
      }
    },
  }), `fish-message: ${path}*`)

  route(`${routePrefix}/state`, async (_req, res) => {
    respond(res, 200, status())
  })

  // 设置页的发送音色下拉：服务不可用时返回空列表 + 一句提示，前端退回文本输入。
  route(`${routePrefix}/ai/voices`, async (_req, res) => {
    const result = await ai.listVoices()
    respond(res, 200, result?.ok ? { ok: true, voices: result.voices } : { ok: false, voices: [], hint: result?.hint || '' })
  })

  route(`${routePrefix}/health`, async (_req, res) => {
    const bridgeState = bridge.state()
    const isRunning = Boolean(bridgeState?.running)
    respond(res, isRunning ? 200 : 503, {
      ok: isRunning,
      version: version,
      transport: bridgeState?.transport || null,
      bindings: (config.bindings || []).length,
      queueSize: bridgeState?.queueSize || 0,
      outboxPending: bridgeState?.outbox?.pending || 0,
      lastSyncAt: bridgeState?.lastSyncAt || 0,
      lastError: bridgeState?.lastSyncError || bridgeState?.stats?.lastError || '',
    })
  })

  route(`${routePrefix}/save`, async (req, res) => {
    const incoming = await readPayload(req)
    const patch = incoming && typeof incoming.config === 'object' ? incoming.config : incoming
    const prev = config
    const merge = { ...config, ...(patch && typeof patch === 'object' ? patch : {}) }
    // 设置页显示的是打码后的令牌；原样提交回来时保留旧令牌。
    if (merge.napcatToken === '***已设置***') merge.napcatToken = prev.napcatToken

    const save = configStore.save(merge)
    if (!save) {
      respond(res, 500, { ok: false, error: `写不进配置文件：${configFile}` })
      return
    }
    const connectionChanged = save.napcatBaseUrl !== prev.napcatBaseUrl
      || save.wsUrl !== prev.wsUrl
      || save.napcatToken !== prev.napcatToken
      || save.wsEnabled !== prev.wsEnabled
      || save.pollIntervalMs !== prev.pollIntervalMs
    config = save
    logger.setLevel(config.logLevel)
    // 图库上限/存不存原图都在设置页改：改完立刻生效，不用重载插件。
    try {
      imageLibrary.configure({
        maxItems: config.imageLibraryMaxItems,
        maxMB: config.imageLibraryMaxMB,
        keepFiles: config.imageLibraryKeepFiles,
      })
    } catch (error) {
      logger.warn(`更新图库上限失败（沿用旧上限）：${safeText(error?.message || error)}`)
    }
    if (config.stickerDir !== prev.stickerDir) {
      try {
        stickers.enterDir(config.stickerDir)
        logger.info(`表情库目录已切换：${stickers.dir}`)
      } catch (error) {
        logger.error(`切换表情库目录失败：${safeText(error?.message || error)}`)
      }
    }
    logger.info(`设置已保存：绑定 ${config.bindings.length} 条｜只发标记内 ${config.onlyInsideMarkers ? '开' : '关'}｜补投窗口 ${config.backfillWindowHours} 小时`)
    if (connectionChanged) {
      logger.info('连接参数变了，正在重启传输层…')
      await restartBridge()
    } else {
      bridge.updateConfig()
    }
    // 防失联开关或绑定变了：按新配置补装/拆除。
    resetGuard()
    respond(res, 200, { ok: true, message: '保存好了', ...status() })
  })

  // 会话输入框旁的收发渠道下拉：把一条渠道绑到当前会话，或解除当前会话的绑定。
  // 一条渠道只能绑一个会话：绑到新会话时，其它会话上的同一个渠道自动回到「未绑定」，渠道本身保留。
  route(`${routePrefix}/bindings/assign`, async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    const incoming = await readPayload(req)
    const sessionId = safeText(incoming?.sessionId, 200).trim()
    if (!sessionId) {
      respond(res, 400, { ok: false, error: '没有会话 id，无法绑定收发渠道。' })
      return
    }
    const qq = incoming?.qq === undefined || incoming?.qq === null
      ? ''
      : safeText(incoming.qq, 32).replace(/[^\d]/g, '')
    const key = sessionKey(sessionId)
    const current = config.bindings || []
    // qq 为空串 = 解除当前会话的绑定：只把 session 清空，渠道保留在设置页，随时能再绑。
    const target = qq ? current.find((b) => String(b.qq) === qq) : null
    if (qq && !target) {
      respond(res, 400, { ok: false, error: `没有 QQ ${qq} 的收发渠道，请先在设置页添加。` })
      return
    }
    const next = current.map((b) => {
      if (target && b === target) return { ...b, session: sessionId }
      if (sessionKey(b.session) === key) return { ...b, session: '' }
      return b
    })
    const save = configStore.save({ ...config, bindings: next })
    if (!save) {
      respond(res, 500, { ok: false, error: `写不进配置文件：${configFile}` })
      return
    }
    config = save
    bridge.updateConfig()
    // 刚绑上的渠道若还没有水位，从现在开始记，避免把它补绑之前的消息补投进来。
    bridge.ensureBaselines({ at: Date.now() })
    resetGuard()
    const who = target ? `${target.name || '主人'}：QQ-${qq}` : ''
    respond(res, 200, {
      ok: true,
      message: target ? `这个会话已改为接收 ${who} 的私聊。` : '这个会话已解除收发渠道绑定，渠道仍保留在设置页。',
      ...status(),
    })
  })

  route(`${routePrefix}/test-send`, async (req, res) => {
    const incoming = await readPayload(req)
    try {
      const result = await bridge.testSend(incoming.qq)
      respond(res, 200, { ok: true, ...result })
    } catch (error) {
      respond(res, 400, { ok: false, error: safeText(error?.message || error, 500) })
    }
  })

  route(`${routePrefix}/logs`, async (_req, res) => {
    respond(res, 200, { ok: true, logs: logger.recent(200) })
  })

  // 收图图库：设置页「清空图库」。图库是缓存，清了只会让同一张图下次重新识图。
  route(`${routePrefix}/images/clear`, async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    try {
      const result = imageLibrary.clear()
      respond(res, 200, { ok: true, ...result, ...imageLibrary.stats() })
    } catch (error) {
      respond(res, 500, { ok: false, error: safeText(error?.hint || error?.message || error, 500) })
    }
  })

  // ---------------- 表情库接口 ----------------
  // 全部由 lib/sticker-routes.js 生成，这里只负责挂到 webServer。
  for (const [path, process] of Object.entries(makeStickerRouteHandlers({
    stickers,
    bridge,
    getConfig: () => config,
    logger,
    inboxDir: inbox,
    routePrefix,
  }))) {
    route(path, process)
  }

  // ---------------- 图库管理接口 ----------------
  // 收图图库的列表 / 出图 / 改描述 / 打开原图，给图库主面板用。
  // 记忆图库、声纹库的页面与接口都在记忆插件里，这里不提供。
  for (const [path, process] of Object.entries(makeGalleryRouteHandlers({
    images: imageLibrary,
    routePrefix,
    logger,
  }))) {
    route(path, process)
  }

  // ---------------- 打开文件夹 ----------------
  // 只允许打开插件自己的目录；绝对路径、存在性、越界与大小写校验都在 lib/open-folder.js。
  route(`${routePrefix}/open-folder`, makeOpenFolderHandler({
    allowedDirs: () => [
      stickers.dir,
      imageLibrary.dir,
      inbox,
      dirname(outboxFile),
      join(homeDir, 'fish-message-cache'),
    ],
    logger,
  }))

  // ---------------- 出站队列接口 ----------------

  route(`${routePrefix}/outbox`, async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    const limit = Number(query(req).get('limit')) || 50
    respond(res, 200, { ok: true, ...bridge.listOutbox({ limit: limit }) })
  })

  route(`${routePrefix}/outbox/flush`, async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    const result = await bridge.flushOutbox('manual', { force: true })
    respond(res, result.ok ? 200 : 503, result)
  })

  route(`${routePrefix}/outbox/clear`, async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    respond(res, 200, { ok: true, ...bridge.clearOutbox() })
  })

  prefixRoute(`${routePrefix}/outbox/`, async (req, res) => {
    if (!requireMethod(req, res, 'DELETE')) return
    let id = ''
    try {
      id = decodeURIComponent(new URL(String(req.url || '/'), 'http://127.0.0.1').pathname.slice(`${routePrefix}/outbox/`.length))
    } catch {
      id = ''
    }
    if (!id || id.includes('/')) {
      respond(res, 404, { ok: false, error: 'not_found', detail: '没有这个出站队列条目' })
      return
    }
    const result = bridge.dropOutbox(id)
    if (!result.deleted) {
      respond(res, 404, { ok: false, error: 'not_found', detail: `出站队列里没有 ${id}` })
      return
    }
    respond(res, 200, { ok: true, ...result })
  })

  // 启动完成后把状态打进日志，方便没有设置页时也能从文件排查。
  setTimeout(() => {
    try {
      const state = bridge.state()
      logger.info(`连接状态：${state.transport?.mode || '未知'}｜在线 ${state.transport?.online ? '是' : '否'}｜收件队列 ${state.queueSize}｜出站积压 ${state.outbox?.pending || 0}｜待转发 ${state.forward?.pending || 0}${state.forward?.paused ? '（已暂停）' : ''}`)
    } catch { /* 忽略 */ }
  }, 1500)

  return { bridge, outbox, forwardQueue, logger, configStore, store, transport, voice, delivery, stickers, imageLibrary, visionCache, ai, guard: guard, message: messageService, serviceEvent, stop: async () => {
    try { lifecycle?.() } catch { /* 忽略 */ }
    try { stopCacheCleanup?.() } catch { /* 忽略 */ }
    try { detachListeners?.() } catch { /* 忽略 */ }
    try { stopGuardHeartbeat?.() } catch { /* 忽略 */ }
    try { if (injectionTimer) clearTimeout(injectionTimer) } catch { /* 忽略 */ }
    try { stopGuardEvents?.() } catch { /* 忽略 */ }
    for (const agent of [...installedGuards.keys()]) removeGuard(agent)
    try { stopTool?.() } catch { /* 忽略 */ }
    try { stopImageTool?.() } catch { /* 忽略 */ }
    try { detachOutbox?.() } catch { /* 忽略 */ }
    try { if (typeof stopService === 'function') stopService() } catch { /* 忽略 */ }
    try { serviceEvent.removeAllListeners() } catch { /* 忽略 */ }
    await bridge.stop()
  } }
}

export { version as version, routePrefix }
