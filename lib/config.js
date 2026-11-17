// 配置：默认值、旧桥迁移、范围钳制、持久化、cordis / schemastery schema。
//
// 配置的真身是 <DSH 家目录>/fish-message-config.json。
// 设置页读写这个文件；插件启动时读它。schema 只是给 DSH 的声明，不靠它存运行配置。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { quarantineFile, readJsonWithBackup, writeJsonAtomic } from './fs-util.js'

export const CONFIG_VERSION = 1

/**
 * 入站图片 / 表情包识图的默认提示词。
 *
 * 设置项留空时用它；想改默认文案只改这里，别抄到别处。
 * 提示词最终会作为 prompt 覆盖参数交给本地 AI 的 visionDescribe。
 */
export const defaultImagePrompt = '描述这张 QQ 图片/表情包：角色或主体、表情与情绪、动作、画面上的文字（逐字照抄）、可能的梗或用途；一两句话，不要评价，不要编造。'

/** 识图提示词长度上限；和本地 AI 的覆盖参数上限一致，超过按默认处理。 */
export const imagePromptMaxLength = 4000

/**
 * 长任务提醒的默认文案。
 *
 * 提醒发生在「本回合已经跑太久、QQ 那头一直收不到回复」时，所以只说结论和做法：
 * 长任务派出去，主会话保持能回话。用通用称呼「用户」，不带个人设定。
 */
export const defaultLongTaskReminder = '检测到执行任务过久，当前会话通过 QQ 与用户对话，需要保持快速响应、不堵塞。不要在主会话里做长任务：写代码、修 bug、大规模文档整理等都交给子代理。'

/**
 * 消息通道提醒的默认文案。
 *
 * 提醒发生在「连续几轮回复都没有 QQ 出站」时。本插件不提供发消息工具，
 * 出站只走 [QQ] 块（lib/format.js），所以「怎么办」只能指向标记格式。
 */
export const defaultChannelReminder = '检测到多轮对话没有 QQ 出站，只在会话里回复的话，QQ 那头的用户看不到。把给用户的内容写进 [QQ]…[/QQ]。'

/** 提醒提示词长度上限；超过按没设处理，回退内置默认。 */
export const reminderPromptLimit = 4000

const homeDir = process.env.DSH_HOME || join(homedir(), '.dsh')

export const DEFAULT_CONFIG = Object.freeze({
  /** NapCat / OneBot 11 HTTP 根地址，不要带结尾斜杠 */
  napcatBaseUrl: 'http://127.0.0.1:3000',
  /** OneBot access_token；NapCat 没开鉴权就留空 */
  napcatToken: '',
  /** 是否优先连 WebSocket；连不上会自动降级 HTTP 轮询 */
  wsEnabled: true,
  /** 留空 = 从 napcatBaseUrl 推导（http→ws / https→wss） */
  wsUrl: '',
  /** 私聊绑定：一行 = 一个 QQ 号 → 一间 DSH 会话。v1 只有私聊。 */
  bindings: [],
  /** true = 只发 [QQ]…[/QQ] 块内；false = 整条发但剥掉标记 */
  onlyInsideMarkers: true,
  /** true = 暂停把 QQ 消息转进 DSH 会话；消息照常接收，存待转发队列，恢复后按顺序补发 */
  forwardPaused: false,
  /** true = 防失联：绑定会话里挡掉会等人/会中断的工具，卡住时提醒；只对启用的绑定生效 */
  guardEnabled: true,
  /** 绑定会话连续运行超过这么久就提醒（秒，1~7200）：这一轮还在跑，QQ 那边就收不到回复 */
  guardStuckSeconds: 600,
  /** 连续这么多轮 assistant 回合没有 QQ 出站，就提醒一次（1~50，默认 3） */
  guardQqRemindTurns: 3,
  /** 长任务提醒的提示词；留空用内置默认（`defaultLongTaskReminder`） */
  guardStuckPrompt: '',
  /** 消息通道提醒的提示词；留空用内置默认（`defaultChannelReminder`） */
  guardQqPrompt: '',
  /** 补投窗口：超过这么多小时的离线消息只发一条摘要 */
  backfillWindowHours: 24,
  /** 出站队列 TTL（小时）：超过就丢弃并记日志/统计 */
  outboxTtlHours: 24,
  /** 出站队列去重窗口（分钟）：相同 fingerprint 只留一条 */
  outboxDedupMinutes: 10,
  /** 出站队列心跳/补发间隔（毫秒） */
  outboxFlushIntervalMs: 10000,
  /** WS 不可用时的 HTTP 轮询间隔 */
  pollIntervalMs: 2000,
  /** 即使 WS 连着，也每隔这么久拉一次历史兜底 */
  historyIntervalMs: 60000,
  /** 乱序缓冲：收到消息后等这么久再按时间排序处理 */
  reorderBufferMs: 1500,
  /**
   * 入站编辑窗口（毫秒）：最后一条消息之后再静默这么久，才把这一批合并成一条递进会话。
   * 窗口内每来一条新消息就重新计时；期间撤回的消息直接从待投队列删掉。
   * 0 = 关掉合并，退回逐条投递（旧行为）。
   */
  inboundEditWindowMs: 15000,
  /** 出站逐条延迟（毫秒）：每条 QQ 消息发送前固定等这么久；0 = 不等 */
  outboxPerMessageDelayMs: 2000,
  /** 出站逐字延迟（毫秒）：按字数再加的等待；字数口径见 lib/pacing.js */
  outboxPerCharDelayMs: 100,
  /** 每次拉历史拉多少条 */
  historyCount: 100,
  /** 单张入站/出站图片上限 */
  maxImageMB: 10,
  /** 单个语音文件上限（base64 兜底也用这个） */
  maxVoiceMB: 20,
  /** 入站图片/语音缓存（收件箱）保留天数，超期自动清理；表情库不受影响 */
  inboxTtlDays: 14,
  /** 普通 OneBot HTTP 请求超时 */
  requestTimeoutMs: 15000,
  /** 表情库目录：索引 index.json，图片 gif/ 与 img/ */
  stickerDir: join(homeDir, 'fish-message-stickers'),
  /** 入站图片是否自动入库（默认关，避免刷屏；开了标签留空、来源 qq-auto） */
  autoSaveStickers: false,
  /** 表情库条数上限；超了提示清理，不静默删 */
  stickerMaxCount: 2000,
  /** 表情库总大小上限（MB） */
  stickerMaxMB: 1024,
  /** 单张表情文件上限（MB）：入库前按文件大小挡一层，避免超大图整读进内存 */
  stickerMaxFileMB: 64,
  /** 发送语音的音色；和本地 AI 插件自己的「朗读音色」是两套设置 */
  sayVoice: 'dafeiyu',
  /** 发送语音的语速（0.5~2） */
  saySpeed: 1,
  /** 收到 QQ 语音后是否交给本地 AI 分析（文字） */
  transcribeInbound: true,
  /** 入站语音分析语言：auto/zh/en/ja/ko/yue */
  asrLanguage: 'auto',
  /**
   * 入站图片是否先在本地识图：inherit 跟随本地 AI 插件的开关，on/off 强制。
   * 默认继承；没有插件时按「开」处理，识图失败仍然退回原图。
   */
  describeInboundImages: 'inherit',
  /** 入站图片/表情包识图提示词；空串 = 用内置默认（`defaultImagePrompt`） */
  inboundImagePrompt: '',
  /**
   * 收图图库（按 sha256 缓存识别结果）总开关。
   * 关掉就完全退回旧行为：每次按 describeInboundImages 的设置识图，不查库也不写库。
   */
  imageLibraryEnabled: true,
  /** 图库条数上限；超了按「最久没见到」静默淘汰（缓存语义，不提示） */
  imageLibraryMaxItems: 1000,
  /** 图库原图总大小上限（MB）；关掉存原图时只有描述，不占空间 */
  imageLibraryMaxMB: 512,
  /** 是否在图库里存原图；关掉只留描述，inbox 被清理后就没法回看原图 */
  imageLibraryKeepFiles: true,
  /**
   * 记忆扩展总开关：装了记忆插件后开启，收到的图片、语音与记忆图库 / 声纹库比对。
   * 默认关；没装记忆插件时保持关闭（服务缺失只会跳过比对，不影响收发）。
   */
  memoryExtension: false,
  /** 记忆扩展：图片与记忆图库按内容指纹比对（总开关关闭时无效） */
  memoryCompareImages: true,
  /** 记忆扩展：语音与声纹库按声音认人（总开关关闭时无效；需要本地 AI 服务在跑） */
  memoryCompareVoices: true,
  /** debug / info / warn / error */
  logLevel: 'info',
})

/**
 * 已从本插件移除的 ASR / TTS 配置键。
 *
 * 旧版本的 fish-message-config.json 里可能还留着它们；加载时直接忽略，
 * 并顺手把落盘文件里的这些键静默清掉（不删用户文件、不报错）。
 * 识别 / 合成现在由可选的本地 AI 插件提供，本插件不再直连这些旧地址。
 */
export const removedVoiceFields = Object.freeze([
  'transcriptionEnabled',
  'asrBaseUrl',
  'asrCommand',
  'asrTimeoutMs',
  'ttsEnabled',
  'ttsBaseUrl',
  'ttsVoice',
  'ttsTimeoutMs',
])

const hasRemovedVoiceFields = (object) => Boolean(
  object && typeof object === 'object' && removedVoiceFields.some((key) => key in object),
)

const clampNumber = (value, fallback, min, max) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** 长任务阈值：优先读秒；旧配置只有分钟时换算成秒。 */
const secondThreshold = (secondValue, minutesValue) => {
  const s = Number(secondValue)
  if (Number.isFinite(s)) return s
  const m = Number(minutesValue)
  if (Number.isFinite(m)) return m * 60
  return undefined
}

const boolean = (value, fallback) => {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return fallback
}

const text = (value, fallback = '') => (typeof value === 'string' ? value.trim() : (value == null ? fallback : String(value).trim()))

/** 入站识图的三种取值；旧版本的布尔开关按 true→on、false→off 迁移。 */
export const imageDescSwitches = Object.freeze(['inherit', 'on', 'off'])

const imageDescriptionEnabled = (value) => {
  if (value === true || value === 'true' || value === 1 || value === '1') return 'on'
  if (value === false || value === 'false' || value === 0 || value === '0') return 'off'
  const lowercase = text(value).toLowerCase()
  return imageDescSwitches.includes(lowercase) ? lowercase : 'inherit'
}

/** 自定义识图提示词：非字符串、超长都当没设，回退内置默认。 */
const imagePrompt = (value) => {
  if (typeof value !== 'string') return ''
  const clean = value.trim()
  return clean && clean.length <= imagePromptMaxLength ? clean : ''
}

/** 自定义提醒提示词：空串/非字符串/超长都当没设，回退内置默认。 */
const reminderPrompt = (value) => {
  if (typeof value !== 'string') return ''
  const clean = value.trim()
  return clean && clean.length <= reminderPromptLimit ? clean : ''
}

/** 实际交给本地 AI 的识图提示词：设置里留空时用内置默认。 */
export function inboundImagePrompt(config) {
  return text(config?.inboundImagePrompt) || defaultImagePrompt
}

const stripTrailingSlash = (value) => text(value).replace(/\/+$/, '')

const sessionKey = (id) => {
  const s = text(id)
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

/** 从 http(s) base 推导 OneBot WS 地址。 */
export function deriveWsUrl(baseUrl) {
  const base = stripTrailingSlash(baseUrl)
  if (!base) return ''
  try {
    const u = new URL(base)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    return u.toString().replace(/\/+$/, '')
  } catch {
    return base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')
  }
}

/**
 * 规整绑定：只留私聊、去重、钳长度。
 *
 * session 允许为空：这表示渠道保留、但当前不绑定任何会话（会话级入口选「不绑定」）。
 * 空 session 只按 qq 去重，不参与会话去重；非空 session 仍是一间会话只能绑一个渠道。
 */
export function normalizeBindings(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seeQq = new Set()
  const seeSession = new Set()
  for (const item of raw.slice(0, 30)) {
    if (!item || typeof item !== 'object') continue
    const legacyKind = text(item.类型 || item.type)
    if (legacyKind && legacyKind !== '私聊' && legacyKind.toLowerCase() !== 'private') continue
    const qq = text(item.qq ?? item.QQ ?? item.号码 ?? item.userId).replace(/[^\d]/g, '')
    const session = text(item.session ?? item.会话 ?? item.sessionId)
    if (!qq) continue
    const key = session ? sessionKey(session) : ''
    if (seeQq.has(qq) || (key && seeSession.has(key))) continue
    seeQq.add(qq)
    if (key) seeSession.add(key)
    out.push({
      qq,
      session,
      name: (text(item.name ?? item.称呼) || '主人').slice(0, 24),
      enabled: boolean(item.enabled ?? item.启用, true),
    })
  }
  return out
}

/** 旧桥（dsh-qq-bridge）的配置 → 本插件配置。 */
export function migrateLegacyConfig(legacy) {
  if (!legacy || typeof legacy !== 'object') return null
  return normalizeConfig({
    napcatBaseUrl: legacy.NapCat,
    napcatToken: legacy.令牌,
    bindings: legacy.绑定,
    onlyInsideMarkers: legacy.只发标记内,
    // 旧桥的「语音转写」开关不再迁移：转写改由可选的本地 AI 插件提供。
    // 旧桥默认只补 10 分钟；本插件按需求默认 24 小时，迁移时至少给 24 小时。
    backfillWindowHours: Math.max(DEFAULT_CONFIG.backfillWindowHours, (Number(legacy.补投窗口分) || 0) / 60),
    pollIntervalMs: legacy.轮询间隔毫秒,
    reorderBufferMs: Math.max(1500, (Number(legacy.合并窗口秒) || 1) * 1000),
  })
}

/** 读进来的任何东西都走这里：补默认值、认旧字段、钳范围。 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const pick = (...keys) => {
    for (const k of keys) if (src[k] !== undefined && src[k] !== null && src[k] !== '') return src[k]
    return undefined
  }

  const napcatBaseUrl = stripTrailingSlash(pick('napcatBaseUrl', 'NapCat', 'napcat')) || DEFAULT_CONFIG.napcatBaseUrl
  const wsUrl = stripTrailingSlash(pick('wsUrl')) || deriveWsUrl(napcatBaseUrl)
  const logLevelRaw = text(pick('logLevel', '日志级别'), DEFAULT_CONFIG.logLevel).toLowerCase()
  const logLevel = ['debug', 'info', 'warn', 'error'].includes(logLevelRaw) ? logLevelRaw : 'info'
  const backfillRaw = pick('backfillWindowHours')
  const backfillWindowHours = backfillRaw === undefined
    ? DEFAULT_CONFIG.backfillWindowHours
    : clampNumber(backfillRaw, DEFAULT_CONFIG.backfillWindowHours, 0, 168)

  const configLanguage = text(pick('asrLanguage'), DEFAULT_CONFIG.asrLanguage)
  const asrLanguage = ['auto', 'zh', 'en', 'ja', 'ko', 'yue'].includes(configLanguage)
    ? configLanguage
    : DEFAULT_CONFIG.asrLanguage

  return {
    napcatBaseUrl,
    napcatToken: text(pick('napcatToken', '令牌'), DEFAULT_CONFIG.napcatToken),
    wsEnabled: boolean(pick('wsEnabled'), DEFAULT_CONFIG.wsEnabled),
    wsUrl,
    bindings: normalizeBindings(pick('bindings', '绑定')),
    onlyInsideMarkers: boolean(pick('onlyInsideMarkers', '只发标记内'), DEFAULT_CONFIG.onlyInsideMarkers),
    forwardPaused: boolean(pick('forwardPaused'), DEFAULT_CONFIG.forwardPaused),
    guardEnabled: boolean(pick('guardEnabled'), DEFAULT_CONFIG.guardEnabled),
    // 旧配置存的是分钟：读回来换算成秒，之后只认 guardStuckSeconds。
    guardStuckSeconds: Math.round(clampNumber(
      secondThreshold(pick('guardStuckSeconds'), pick('guardStuckMinutes')),
      DEFAULT_CONFIG.guardStuckSeconds, 1, 7200,
    )),
    guardQqRemindTurns: Math.round(clampNumber(pick('guardQqRemindTurns'), DEFAULT_CONFIG.guardQqRemindTurns, 1, 50)),
    guardStuckPrompt: reminderPrompt(pick('guardStuckPrompt')),
    guardQqPrompt: reminderPrompt(pick('guardQqPrompt')),
    backfillWindowHours,
    outboxTtlHours: clampNumber(pick('outboxTtlHours'), DEFAULT_CONFIG.outboxTtlHours, 1, 720),
    outboxDedupMinutes: clampNumber(pick('outboxDedupMinutes'), DEFAULT_CONFIG.outboxDedupMinutes, 0, 1440),
    outboxFlushIntervalMs: clampNumber(pick('outboxFlushIntervalMs'), DEFAULT_CONFIG.outboxFlushIntervalMs, 1000, 600000),
    pollIntervalMs: clampNumber(pick('pollIntervalMs', '轮询间隔毫秒'), DEFAULT_CONFIG.pollIntervalMs, 500, 30000),
    historyIntervalMs: clampNumber(pick('historyIntervalMs'), DEFAULT_CONFIG.historyIntervalMs, 5000, 600000),
    reorderBufferMs: clampNumber(pick('reorderBufferMs'), DEFAULT_CONFIG.reorderBufferMs, 0, 5000),
    inboundEditWindowMs: Math.round(clampNumber(pick('inboundEditWindowMs'), DEFAULT_CONFIG.inboundEditWindowMs, 0, 120000)),
    // 出站节奏的上限是防手滑：单条最多等 1 分钟，逐字最多 5 秒/字。
    outboxPerMessageDelayMs: Math.round(clampNumber(pick('outboxPerMessageDelayMs'), DEFAULT_CONFIG.outboxPerMessageDelayMs, 0, 60000)),
    outboxPerCharDelayMs: Math.round(clampNumber(pick('outboxPerCharDelayMs'), DEFAULT_CONFIG.outboxPerCharDelayMs, 0, 5000)),
    historyCount: Math.round(clampNumber(pick('historyCount'), DEFAULT_CONFIG.historyCount, 10, 500)),
    maxImageMB: clampNumber(pick('maxImageMB'), DEFAULT_CONFIG.maxImageMB, 1, 50),
    maxVoiceMB: clampNumber(pick('maxVoiceMB'), DEFAULT_CONFIG.maxVoiceMB, 1, 50),
    inboxTtlDays: Math.round(clampNumber(pick('inboxTtlDays'), DEFAULT_CONFIG.inboxTtlDays, 1, 365)),
    requestTimeoutMs: clampNumber(pick('requestTimeoutMs'), DEFAULT_CONFIG.requestTimeoutMs, 3000, 60000),
    stickerDir: text(pick('stickerDir', '表情目录')) || DEFAULT_CONFIG.stickerDir,
    autoSaveStickers: boolean(pick('autoSaveStickers', '自动入库'), DEFAULT_CONFIG.autoSaveStickers),
    stickerMaxCount: Math.round(clampNumber(pick('stickerMaxCount'), DEFAULT_CONFIG.stickerMaxCount, 1, 10000)),
    stickerMaxMB: clampNumber(pick('stickerMaxMB'), DEFAULT_CONFIG.stickerMaxMB, 1, 10240),
    stickerMaxFileMB: clampNumber(pick('stickerMaxFileMB'), DEFAULT_CONFIG.stickerMaxFileMB, 1, 1024),
    sayVoice: text(pick('sayVoice'), DEFAULT_CONFIG.sayVoice) || DEFAULT_CONFIG.sayVoice,
    saySpeed: clampNumber(pick('saySpeed'), DEFAULT_CONFIG.saySpeed, 0.5, 2),
    transcribeInbound: boolean(pick('transcribeInbound'), DEFAULT_CONFIG.transcribeInbound),
    asrLanguage,
    describeInboundImages: imageDescriptionEnabled(pick('describeInboundImages')),
    inboundImagePrompt: imagePrompt(pick('inboundImagePrompt')),
    imageLibraryEnabled: boolean(pick('imageLibraryEnabled'), DEFAULT_CONFIG.imageLibraryEnabled),
    imageLibraryMaxItems: Math.round(clampNumber(pick('imageLibraryMaxItems'), DEFAULT_CONFIG.imageLibraryMaxItems, 1, 100000)),
    imageLibraryMaxMB: clampNumber(pick('imageLibraryMaxMB'), DEFAULT_CONFIG.imageLibraryMaxMB, 1, 102400),
    imageLibraryKeepFiles: boolean(pick('imageLibraryKeepFiles'), DEFAULT_CONFIG.imageLibraryKeepFiles),
    memoryExtension: boolean(pick('memoryExtension'), DEFAULT_CONFIG.memoryExtension),
    memoryCompareImages: boolean(pick('memoryCompareImages'), DEFAULT_CONFIG.memoryCompareImages),
    memoryCompareVoices: boolean(pick('memoryCompareVoices'), DEFAULT_CONFIG.memoryCompareVoices),
    logLevel,
  }
}

export class ConfigStore {
  constructor({ homeDir, fileName = 'fish-message-config.json', legacyPath = '', logger = null }) {
    this.homeDir = homeDir
    this.filePath = join(homeDir, fileName)
    this.legacyPath = legacyPath || join(homeDir, 'qq-bridge-config.json')
    this.logger = logger
  }

  load(pluginConfig) {
    const existing = readJsonWithBackup(this.filePath, null, { logger: this.logger, label: '配置文件' })
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      const clean = normalizeConfig(existing)
      // 旧配置残留的 ASR/TTS 字段：静默清理一次，写回规范化后的配置。
      // 只删这几个键，其它未知键原样保留（避免误删用户的注释性字段）。
      // 写失败也不影响运行（内存里已经是干净的）；绝不删除用户的配置文件。
      if (hasRemovedVoiceFields(existing)) {
        const cleanup = { ...existing }
        for (const key of removedVoiceFields) delete cleanup[key]
        try { writeJsonAtomic(this.filePath, { ...cleanup, ...clean }) } catch { /* 只读目录也照常跑 */ }
      }
      return clean
    }
    if (existing) {
      // 能解析但不是对象：留档后按默认配置继续，用户还能在设置页重新保存一份。
      quarantineFile(this.filePath, { logger: this.logger, label: '配置文件', reason: '结构不认识' })
    }
    // 第一次跑：优先搬旧桥的绑定和地址，避免升级后要重新配一遍。
    if (this.legacyPath && existsSync(this.legacyPath)) {
      const prev = readJson(this.legacyPath, null)
      const migrate = migrateLegacyConfig(prev)
      if (migrate) return migrate
    }
    return normalizeConfig(pluginConfig || {})
  }

  save(config) {
    const clean = normalizeConfig(config)
    const success = writeJsonAtomic(this.filePath, clean)
    return success ? clean : null
  }
}

/** 给设置页看的配置（令牌打码，避免整份贴到日志/界面）。 */
export function publicConfig(config) {
  const c = normalizeConfig(config)
  return {
    ...c,
    napcatToken: c.napcatToken ? '***已设置***' : '',
  }
}

/** cordis / schemastery 配置 schema；schemastery 拿不到时返回 undefined，插件照常加载。 */
export function buildConfigSchema(z) {
  const field = (schema) => schema.extra('volatile', true)
  const binding = z.object({
    qq: z.string().default('').description('对方 QQ 号'),
    session: z.string().default('').description('DSH 会话 id'),
    name: z.string().default('主人').description('称呼'),
    enabled: z.boolean().default(true).description('是否启用'),
  }).description('一行 = 一个私聊 → 一间 DSH 会话')

  return z.object({
    napcatBaseUrl: field(z.string().default(DEFAULT_CONFIG.napcatBaseUrl).description('NapCat / OneBot 11 HTTP 根地址')),
    napcatToken: field(z.string().default('').description('OneBot access_token，没有就留空')),
    wsEnabled: field(z.boolean().default(true).description('优先使用 WebSocket')),
    wsUrl: field(z.string().default('').description('WebSocket 地址；留空自动推导')),
    bindings: field(z.array(binding).default([]).description('私聊绑定列表')),
    onlyInsideMarkers: field(z.boolean().default(true).description('只发 [QQ]…[/QQ] 块内内容')),
    forwardPaused: field(z.boolean().default(false).description('暂停转发到 DSH 会话（消息照常接收，恢复后按顺序补发）')),
    guardEnabled: field(z.boolean().default(true).description('防失联：绑定会话不能停下来等人，卡住时提醒（只对启用的绑定生效）')),
    guardStuckSeconds: field(z.natural().default(600).max(7200).description('主会话单轮连续运行超过多少秒就提醒（1~7200）')),
    guardQqRemindTurns: field(z.natural().default(3).description('连续几轮只会话内回话、没有 QQ 出站就提醒一次（1~50）')),
    guardStuckPrompt: field(z.string().max(4000).default('').description('长任务提醒的提示词；留空用内置默认')),
    guardQqPrompt: field(z.string().max(4000).default('').description('消息通道提醒的提示词；留空用内置默认')),
    backfillWindowHours: field(z.natural().default(DEFAULT_CONFIG.backfillWindowHours).description('离线补投窗口（小时）')),
    outboxTtlHours: field(z.natural().default(DEFAULT_CONFIG.outboxTtlHours).description('出站队列 TTL（小时）')),
    outboxDedupMinutes: field(z.natural().default(DEFAULT_CONFIG.outboxDedupMinutes).description('出站队列去重窗口（分钟）')),
    outboxFlushIntervalMs: field(z.natural().default(DEFAULT_CONFIG.outboxFlushIntervalMs).description('出站队列补发心跳（毫秒）')),
    pollIntervalMs: field(z.natural().default(DEFAULT_CONFIG.pollIntervalMs).description('HTTP 轮询间隔（毫秒）')),
    historyIntervalMs: field(z.natural().default(DEFAULT_CONFIG.historyIntervalMs).description('历史兜底间隔（毫秒）')),
    reorderBufferMs: field(z.natural().default(DEFAULT_CONFIG.reorderBufferMs).description('乱序缓冲（毫秒）')),
    inboundEditWindowMs: field(z.natural().default(DEFAULT_CONFIG.inboundEditWindowMs).max(120000).description('入站编辑窗口（毫秒）：静默这么久后把这一批合并投递；0 = 逐条投递')),
    outboxPerMessageDelayMs: field(z.natural().default(DEFAULT_CONFIG.outboxPerMessageDelayMs).max(60000).description('出站逐条延迟（毫秒）')),
    outboxPerCharDelayMs: field(z.natural().default(DEFAULT_CONFIG.outboxPerCharDelayMs).max(5000).description('出站逐字延迟（毫秒）')),
    historyCount: field(z.natural().default(DEFAULT_CONFIG.historyCount).description('每次拉历史条数')),
    maxImageMB: field(z.natural().default(DEFAULT_CONFIG.maxImageMB).description('图片大小上限（MB）')),
    maxVoiceMB: field(z.natural().default(DEFAULT_CONFIG.maxVoiceMB).description('语音大小上限（MB）')),
    inboxTtlDays: field(z.natural().default(DEFAULT_CONFIG.inboxTtlDays).min(1).max(365).description('入站图片/语音缓存保留天数（1~365）；表情库不受影响')),
    requestTimeoutMs: field(z.natural().default(DEFAULT_CONFIG.requestTimeoutMs).description('OneBot 请求超时（毫秒）')),
    stickerDir: field(z.string().default(DEFAULT_CONFIG.stickerDir).description('表情库目录（index.json + gif/ + img/）')),
    autoSaveStickers: field(z.boolean().default(false).description('入站图片自动入库（默认关）')),
    stickerMaxCount: field(z.natural().default(DEFAULT_CONFIG.stickerMaxCount).description('表情库条数上限')),
    stickerMaxMB: field(z.natural().default(DEFAULT_CONFIG.stickerMaxMB).description('表情库总大小上限（MB）')),
    stickerMaxFileMB: field(z.natural().default(DEFAULT_CONFIG.stickerMaxFileMB).min(1).max(1024).description('单张表情文件大小上限（MB）')),
    sayVoice: field(z.string().default(DEFAULT_CONFIG.sayVoice).description('发送语音的音色')),
    saySpeed: field(z.number().default(DEFAULT_CONFIG.saySpeed).description('发送语音的语速（0.5~2）')),
    transcribeInbound: field(z.boolean().default(DEFAULT_CONFIG.transcribeInbound).description('收到语音后自动分析（文字）')),
    asrLanguage: field(z.string().default(DEFAULT_CONFIG.asrLanguage).description('语音分析语言：auto/zh/en/ja/ko/yue')),
    describeInboundImages: field(z.string().default(DEFAULT_CONFIG.describeInboundImages).description('入站图片本地识图：inherit 跟随本地 AI 插件，on/off 强制')),
    inboundImagePrompt: field(z.string().default(DEFAULT_CONFIG.inboundImagePrompt).description('入站图片/表情包识图提示词；留空用内置默认，最长 4000 字')),
    imageLibraryEnabled: field(z.boolean().default(true).description('收图图库：按内容指纹缓存识别结果；关掉退回每次识图')),
    imageLibraryMaxItems: field(z.natural().default(DEFAULT_CONFIG.imageLibraryMaxItems).min(1).max(100000).description('图库条数上限（超了淘汰最久没见到的）')),
    imageLibraryMaxMB: field(z.natural().default(DEFAULT_CONFIG.imageLibraryMaxMB).min(1).max(102400).description('图库原图总大小上限（MB）')),
    imageLibraryKeepFiles: field(z.boolean().default(true).description('在图库里存原图；关掉只留描述')),
    memoryExtension: field(z.boolean().default(false).description('记忆扩展：装了记忆插件后开启，收到的图片、语音会与记忆库比对，把识别结果附在消息上')),
    memoryCompareImages: field(z.boolean().default(true).description('比对图像：与记忆图库按内容指纹比对（总开关关闭时无效）')),
    memoryCompareVoices: field(z.boolean().default(true).description('比对声纹：与声纹库按声音认人（总开关关闭时无效；需要本地 AI 服务在跑）')),
    logLevel: field(z.string().default(DEFAULT_CONFIG.logLevel).description('日志级别：debug/info/warn/error')),
  }).description('dsh-fish-message 配置')
}
