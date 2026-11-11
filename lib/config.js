// 配置：默认值、旧桥迁移、范围钳制、持久化、cordis / schemastery schema。
//
// 配置的真身是 <DSH 家目录>/fish-message-config.json。
// 设置页读写这个文件；插件启动时读它。schema 只是给 DSH 的声明，不靠它存运行配置。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './fs-util.js'

export const CONFIG_VERSION = 1

/**
 * 入站图片 / 表情包识图的默认提示词。
 *
 * 设置项留空时用它；想改默认文案只改这里，别抄到别处。
 * 提示词最终会作为 prompt 覆盖参数交给本地 AI 的 visionDescribe。
 */
export const 默认识图提示词 = '描述这张 QQ 图片/表情包：角色或主体、表情与情绪、动作、画面上的文字（逐字照抄）、可能的梗或用途；一两句话，不要评价，不要编造。'

/** 识图提示词长度上限；和本地 AI 的覆盖参数上限一致，超过按默认处理。 */
export const 识图提示词上限 = 4000

/** 长任务提醒的默认文案（主人给的原文，标点照抄，不要改措辞）。 */
export const 默认长任务提醒文案 = '检测到执行任务过久,当前会话绑定外部通讯收发,需要保持快速响应不堵塞。不要在主会话中执行长任务,写代码、修bug、大规模文档整理等长任务派给子代理完成'

/** 消息通道提醒的默认文案（主人给的原文，标点照抄，不要改措辞）。 */
export const 默认消息通道提醒文案 = '检测到多轮对话无消息出站,当前会话绑定外部通讯收发,仅回复会话用户可能看不到。调用发消息工具或者用指定格式回复'

/** 提醒提示词长度上限；超过按没设处理，回退内置默认。 */
export const 提醒提示词上限 = 4000

const 家目录 = process.env.DSH_HOME || join(homedir(), '.dsh')

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
  /** 绑定会话超过这么久没有新进展，就发一条提醒（分钟，1~120） */
  guardStuckMinutes: 10,
  /** 连续这么多轮 assistant 回合没有 QQ 出站，就提醒一次（1~50，默认 3） */
  guardQqRemindTurns: 3,
  /** 长任务提醒的提示词；留空用内置默认（默认长任务提醒文案） */
  guardStuckPrompt: '',
  /** 消息通道提醒的提示词；留空用内置默认（默认消息通道提醒文案） */
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
  /** 每次拉历史拉多少条 */
  historyCount: 100,
  /** 单张入站/出站图片上限 */
  maxImageMB: 10,
  /** 单个语音文件上限（base64 兜底也用这个） */
  maxVoiceMB: 20,
  /** 普通 OneBot HTTP 请求超时 */
  requestTimeoutMs: 15000,
  /** 表情库目录：索引 index.json，图片 gif/ 与 img/ */
  stickerDir: join(家目录, 'fish-message-stickers'),
  /** 入站图片是否自动入库（默认关，避免刷屏；开了标签留空、来源 qq-auto） */
  autoSaveStickers: false,
  /** 表情库条数上限；超了提示清理，不静默删 */
  stickerMaxCount: 2000,
  /** 表情库总大小上限（MB） */
  stickerMaxMB: 1024,
  /** 发送语音的音色；和本地 AI 插件自己的「朗读音色」是两套设置 */
  sayVoice: 'dafeiyu',
  /** 发送语音的语速（0.5~2） */
  saySpeed: 1,
  /** 收到 QQ 语音后是否交给本地 AI 分析（文字、说话人） */
  transcribeInbound: true,
  /** 入站语音分析语言：auto/zh/en/ja/ko/yue */
  asrLanguage: 'auto',
  /**
   * 入站图片是否先在本地识图：inherit 跟随本地 AI 插件的开关，on/off 强制。
   * 默认继承；没有插件时按「开」处理，识图失败仍然退回原图。
   */
  describeInboundImages: 'inherit',
  /** 入站图片/表情包识图提示词；空串 = 用内置默认（默认识图提示词） */
  inboundImagePrompt: '',
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
export const 已移除的语音字段 = Object.freeze([
  'transcriptionEnabled',
  'asrBaseUrl',
  'asrCommand',
  'asrTimeoutMs',
  'ttsEnabled',
  'ttsBaseUrl',
  'ttsVoice',
  'ttsTimeoutMs',
])

const 含已移除语音字段 = (对象) => Boolean(
  对象 && typeof 对象 === 'object' && 已移除的语音字段.some((键) => 键 in 对象),
)

const 数字范围 = (值, 兜底, 最小, 最大) => {
  const n = Number(值)
  if (!Number.isFinite(n)) return 兜底
  return Math.max(最小, Math.min(最大, n))
}

const 布尔 = (值, 兜底) => {
  if (值 === true || 值 === 'true' || 值 === 1 || 值 === '1') return true
  if (值 === false || 值 === 'false' || 值 === 0 || 值 === '0') return false
  return 兜底
}

const 字 = (值, 兜底 = '') => (typeof 值 === 'string' ? 值.trim() : (值 == null ? 兜底 : String(值).trim()))

/** 入站识图的三种取值；旧版本的布尔开关按 true→on、false→off 迁移。 */
export const 识图开关们 = Object.freeze(['inherit', 'on', 'off'])

const 识图开关 = (值) => {
  if (值 === true || 值 === 'true' || 值 === 1 || 值 === '1') return 'on'
  if (值 === false || 值 === 'false' || 值 === 0 || 值 === '0') return 'off'
  const 小写 = 字(值).toLowerCase()
  return 识图开关们.includes(小写) ? 小写 : 'inherit'
}

/** 自定义识图提示词：非字符串、超长都当没设，回退内置默认。 */
const 识图提示词 = (值) => {
  if (typeof 值 !== 'string') return ''
  const 净 = 值.trim()
  return 净 && 净.length <= 识图提示词上限 ? 净 : ''
}

/** 自定义提醒提示词：空串/非字符串/超长都当没设，回退内置默认。 */
const 提醒提示词 = (值) => {
  if (typeof 值 !== 'string') return ''
  const 净 = 值.trim()
  return 净 && 净.length <= 提醒提示词上限 ? 净 : ''
}

/** 实际交给本地 AI 的识图提示词：设置里留空时用内置默认。 */
export function 入站识图提示词(config) {
  return 字(config?.inboundImagePrompt) || 默认识图提示词
}

const 去尾斜杠 = (值) => 字(值).replace(/\/+$/, '')

const 会话键 = (id) => {
  const s = 字(id)
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

/** 从 http(s) base 推导 OneBot WS 地址。 */
export function deriveWsUrl(baseUrl) {
  const base = 去尾斜杠(baseUrl)
  if (!base) return ''
  try {
    const u = new URL(base)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    return u.toString().replace(/\/+$/, '')
  } catch {
    return base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')
  }
}

/** 规整绑定：只留私聊、去重、钳长度。 */
export function normalizeBindings(raw) {
  if (!Array.isArray(raw)) return []
  const 出 = []
  const 见QQ = new Set()
  const 见会话 = new Set()
  for (const item of raw.slice(0, 30)) {
    if (!item || typeof item !== 'object') continue
    const 旧类型 = 字(item.类型 || item.type)
    if (旧类型 && 旧类型 !== '私聊' && 旧类型.toLowerCase() !== 'private') continue
    const qq = 字(item.qq ?? item.QQ ?? item.号码 ?? item.userId).replace(/[^\d]/g, '')
    const session = 字(item.session ?? item.会话 ?? item.sessionId)
    if (!qq || !session) continue
    const key = 会话键(session)
    if (见QQ.has(qq) || 见会话.has(key)) continue
    见QQ.add(qq)
    见会话.add(key)
    出.push({
      qq,
      session,
      name: (字(item.name ?? item.称呼) || '主人').slice(0, 24),
      enabled: 布尔(item.enabled ?? item.启用, true),
    })
  }
  return 出
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

  const napcatBaseUrl = 去尾斜杠(pick('napcatBaseUrl', 'NapCat', 'napcat')) || DEFAULT_CONFIG.napcatBaseUrl
  const wsUrl = 去尾斜杠(pick('wsUrl')) || deriveWsUrl(napcatBaseUrl)
  const logLevelRaw = 字(pick('logLevel', '日志级别'), DEFAULT_CONFIG.logLevel).toLowerCase()
  const logLevel = ['debug', 'info', 'warn', 'error'].includes(logLevelRaw) ? logLevelRaw : 'info'
  const backfillRaw = pick('backfillWindowHours')
  const backfillWindowHours = backfillRaw === undefined
    ? DEFAULT_CONFIG.backfillWindowHours
    : 数字范围(backfillRaw, DEFAULT_CONFIG.backfillWindowHours, 0, 168)

  const 配置语言 = 字(pick('asrLanguage'), DEFAULT_CONFIG.asrLanguage)
  const asrLanguage = ['auto', 'zh', 'en', 'ja', 'ko', 'yue'].includes(配置语言)
    ? 配置语言
    : DEFAULT_CONFIG.asrLanguage

  return {
    napcatBaseUrl,
    napcatToken: 字(pick('napcatToken', '令牌'), DEFAULT_CONFIG.napcatToken),
    wsEnabled: 布尔(pick('wsEnabled'), DEFAULT_CONFIG.wsEnabled),
    wsUrl,
    bindings: normalizeBindings(pick('bindings', '绑定')),
    onlyInsideMarkers: 布尔(pick('onlyInsideMarkers', '只发标记内'), DEFAULT_CONFIG.onlyInsideMarkers),
    forwardPaused: 布尔(pick('forwardPaused'), DEFAULT_CONFIG.forwardPaused),
    guardEnabled: 布尔(pick('guardEnabled'), DEFAULT_CONFIG.guardEnabled),
    guardStuckMinutes: Math.round(数字范围(pick('guardStuckMinutes'), DEFAULT_CONFIG.guardStuckMinutes, 1, 120)),
    guardQqRemindTurns: Math.round(数字范围(pick('guardQqRemindTurns'), DEFAULT_CONFIG.guardQqRemindTurns, 1, 50)),
    guardStuckPrompt: 提醒提示词(pick('guardStuckPrompt')),
    guardQqPrompt: 提醒提示词(pick('guardQqPrompt')),
    backfillWindowHours,
    outboxTtlHours: 数字范围(pick('outboxTtlHours'), DEFAULT_CONFIG.outboxTtlHours, 1, 720),
    outboxDedupMinutes: 数字范围(pick('outboxDedupMinutes'), DEFAULT_CONFIG.outboxDedupMinutes, 0, 1440),
    outboxFlushIntervalMs: 数字范围(pick('outboxFlushIntervalMs'), DEFAULT_CONFIG.outboxFlushIntervalMs, 1000, 600000),
    pollIntervalMs: 数字范围(pick('pollIntervalMs', '轮询间隔毫秒'), DEFAULT_CONFIG.pollIntervalMs, 500, 30000),
    historyIntervalMs: 数字范围(pick('historyIntervalMs'), DEFAULT_CONFIG.historyIntervalMs, 5000, 600000),
    reorderBufferMs: 数字范围(pick('reorderBufferMs'), DEFAULT_CONFIG.reorderBufferMs, 0, 5000),
    historyCount: Math.round(数字范围(pick('historyCount'), DEFAULT_CONFIG.historyCount, 10, 500)),
    maxImageMB: 数字范围(pick('maxImageMB'), DEFAULT_CONFIG.maxImageMB, 1, 50),
    maxVoiceMB: 数字范围(pick('maxVoiceMB'), DEFAULT_CONFIG.maxVoiceMB, 1, 50),
    requestTimeoutMs: 数字范围(pick('requestTimeoutMs'), DEFAULT_CONFIG.requestTimeoutMs, 3000, 60000),
    stickerDir: 字(pick('stickerDir', '表情目录')) || DEFAULT_CONFIG.stickerDir,
    autoSaveStickers: 布尔(pick('autoSaveStickers', '自动入库'), DEFAULT_CONFIG.autoSaveStickers),
    stickerMaxCount: Math.round(数字范围(pick('stickerMaxCount'), DEFAULT_CONFIG.stickerMaxCount, 1, 10000)),
    stickerMaxMB: 数字范围(pick('stickerMaxMB'), DEFAULT_CONFIG.stickerMaxMB, 1, 10240),
    sayVoice: 字(pick('sayVoice'), DEFAULT_CONFIG.sayVoice) || DEFAULT_CONFIG.sayVoice,
    saySpeed: 数字范围(pick('saySpeed'), DEFAULT_CONFIG.saySpeed, 0.5, 2),
    transcribeInbound: 布尔(pick('transcribeInbound'), DEFAULT_CONFIG.transcribeInbound),
    asrLanguage,
    describeInboundImages: 识图开关(pick('describeInboundImages')),
    inboundImagePrompt: 识图提示词(pick('inboundImagePrompt')),
    logLevel,
  }
}

export class ConfigStore {
  constructor({ homeDir, fileName = 'fish-message-config.json', legacyPath = '' }) {
    this.homeDir = homeDir
    this.filePath = join(homeDir, fileName)
    this.legacyPath = legacyPath || join(homeDir, 'qq-bridge-config.json')
  }

  load(pluginConfig) {
    const 现成 = readJson(this.filePath, null)
    if (现成) {
      const 净 = normalizeConfig(现成)
      // 旧配置残留的 ASR/TTS 字段：静默清理一次，写回规范化后的配置。
      // 只删这几个键，其它未知键原样保留（避免误删用户的注释性字段）。
      // 写失败也不影响运行（内存里已经是干净的）；绝不删除用户的配置文件。
      if (含已移除语音字段(现成)) {
        const 清理 = { ...现成 }
        for (const 键 of 已移除的语音字段) delete 清理[键]
        try { writeJsonAtomic(this.filePath, { ...清理, ...净 }) } catch { /* 只读目录也照常跑 */ }
      }
      return 净
    }
    // 第一次跑：优先搬旧桥的绑定和地址，避免升级后要重新配一遍。
    if (this.legacyPath && existsSync(this.legacyPath)) {
      const 旧 = readJson(this.legacyPath, null)
      const 迁移 = migrateLegacyConfig(旧)
      if (迁移) return 迁移
    }
    return normalizeConfig(pluginConfig || {})
  }

  save(config) {
    const 净 = normalizeConfig(config)
    const 成功 = writeJsonAtomic(this.filePath, 净)
    return 成功 ? 净 : null
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
  const 字段 = (schema) => schema.extra('volatile', true)
  const 绑定 = z.object({
    qq: z.string().default('').description('对方 QQ 号'),
    session: z.string().default('').description('DSH 会话 id'),
    name: z.string().default('主人').description('称呼'),
    enabled: z.boolean().default(true).description('是否启用'),
  }).description('一行 = 一个私聊 → 一间 DSH 会话')

  return z.object({
    napcatBaseUrl: 字段(z.string().default(DEFAULT_CONFIG.napcatBaseUrl).description('NapCat / OneBot 11 HTTP 根地址')),
    napcatToken: 字段(z.string().default('').description('OneBot access_token，没有就留空')),
    wsEnabled: 字段(z.boolean().default(true).description('优先使用 WebSocket')),
    wsUrl: 字段(z.string().default('').description('WebSocket 地址；留空自动推导')),
    bindings: 字段(z.array(绑定).default([]).description('私聊绑定列表')),
    onlyInsideMarkers: 字段(z.boolean().default(true).description('只发 [QQ]…[/QQ] 块内内容')),
    forwardPaused: 字段(z.boolean().default(false).description('暂停转发到 DSH 会话（消息照常接收，恢复后按顺序补发）')),
    guardEnabled: 字段(z.boolean().default(true).description('防失联：绑定会话不能停下来等人，卡住时提醒（只对启用的绑定生效）')),
    guardStuckMinutes: 字段(z.natural().default(10).description('多久没有新进展算卡住（分钟）')),
    guardQqRemindTurns: 字段(z.natural().default(3).description('连续几轮只会话内回话、没有 QQ 出站就提醒一次（1~50）')),
    guardStuckPrompt: 字段(z.string().max(4000).default('').description('长任务提醒的提示词；留空用内置默认')),
    guardQqPrompt: 字段(z.string().max(4000).default('').description('消息通道提醒的提示词；留空用内置默认')),
    backfillWindowHours: 字段(z.natural().default(DEFAULT_CONFIG.backfillWindowHours).description('离线补投窗口（小时）')),
    outboxTtlHours: 字段(z.natural().default(DEFAULT_CONFIG.outboxTtlHours).description('出站队列 TTL（小时）')),
    outboxDedupMinutes: 字段(z.natural().default(DEFAULT_CONFIG.outboxDedupMinutes).description('出站队列去重窗口（分钟）')),
    outboxFlushIntervalMs: 字段(z.natural().default(DEFAULT_CONFIG.outboxFlushIntervalMs).description('出站队列补发心跳（毫秒）')),
    pollIntervalMs: 字段(z.natural().default(DEFAULT_CONFIG.pollIntervalMs).description('HTTP 轮询间隔（毫秒）')),
    historyIntervalMs: 字段(z.natural().default(DEFAULT_CONFIG.historyIntervalMs).description('历史兜底间隔（毫秒）')),
    reorderBufferMs: 字段(z.natural().default(DEFAULT_CONFIG.reorderBufferMs).description('乱序缓冲（毫秒）')),
    historyCount: 字段(z.natural().default(DEFAULT_CONFIG.historyCount).description('每次拉历史条数')),
    maxImageMB: 字段(z.natural().default(DEFAULT_CONFIG.maxImageMB).description('图片大小上限（MB）')),
    maxVoiceMB: 字段(z.natural().default(DEFAULT_CONFIG.maxVoiceMB).description('语音大小上限（MB）')),
    requestTimeoutMs: 字段(z.natural().default(DEFAULT_CONFIG.requestTimeoutMs).description('OneBot 请求超时（毫秒）')),
    stickerDir: 字段(z.string().default(DEFAULT_CONFIG.stickerDir).description('表情库目录（index.json + gif/ + img/）')),
    autoSaveStickers: 字段(z.boolean().default(false).description('入站图片自动入库（默认关）')),
    stickerMaxCount: 字段(z.natural().default(DEFAULT_CONFIG.stickerMaxCount).description('表情库条数上限')),
    stickerMaxMB: 字段(z.natural().default(DEFAULT_CONFIG.stickerMaxMB).description('表情库总大小上限（MB）')),
    sayVoice: 字段(z.string().default(DEFAULT_CONFIG.sayVoice).description('发送语音的音色')),
    saySpeed: 字段(z.number().default(DEFAULT_CONFIG.saySpeed).description('发送语音的语速（0.5~2）')),
    transcribeInbound: 字段(z.boolean().default(DEFAULT_CONFIG.transcribeInbound).description('收到语音后自动分析（文字、说话人）')),
    asrLanguage: 字段(z.string().default(DEFAULT_CONFIG.asrLanguage).description('语音分析语言：auto/zh/en/ja/ko/yue')),
    describeInboundImages: 字段(z.string().default(DEFAULT_CONFIG.describeInboundImages).description('入站图片本地识图：inherit 跟随本地 AI 插件，on/off 强制')),
    inboundImagePrompt: 字段(z.string().default(DEFAULT_CONFIG.inboundImagePrompt).description('入站图片/表情包识图提示词；留空用内置默认，最长 4000 字')),
    logLevel: 字段(z.string().default(DEFAULT_CONFIG.logLevel).description('日志级别：debug/info/warn/error')),
  }).description('dsh-fish-message 配置')
}
