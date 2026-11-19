// 配置：默认值、旧桥迁移、范围钳制、持久化、cordis / schemastery schema。
//
// 配置的真身是 <DSH 家目录>/fish-message-config.json。
// 设置页读写这个文件；插件启动时读它。schema 只是给 DSH 的声明，不靠它存运行配置。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { quarantineFile, readJsonWithBackup, writeJsonAtomic } from './fs-util.js'
import { normalizePeer, parseChannel, peerKey, peerProblem } from './peer.js'

export const CONFIG_VERSION = 1

/**
 * 入站图片 / 表情包识图的默认提示词。
 *
 * 设置项留空时用它；想改默认文案只改这里，别抄到别处。
 * 提示词最终会作为 prompt 覆盖参数交给本地 AI 的 visionDescribe。
 */
export const defaultImagePrompt = '描述这张聊天图片/表情包：角色或主体、表情与情绪、动作、画面上的文字（逐字照抄）、可能的梗或用途；一两句话，不要评价，不要编造。'

/** 识图提示词长度上限；和本地 AI 的覆盖参数上限一致，超过按默认处理。 */
export const imagePromptMaxLength = 4000

/**
 * 长任务提醒的默认文案。
 *
 * 提醒发生在「本回合已经跑太久、渠道那头一直收不到回复」时，所以只说结论和做法：
 * 长任务派出去，主会话保持能回话。用通用称呼「用户」，不带个人设定。
 */
export const defaultLongTaskReminder = '检测到执行任务过久，当前会话通过消息渠道与用户对话，需要保持快速响应、不堵塞。不要在主会话里做长任务：写代码、修 bug、大规模文档整理等都交给子代理。'

/**
 * 消息通道提醒的默认文案。
 *
 * 提醒发生在「连续几轮回复都没有消息出站」时。本插件不提供发消息工具，
 * 出站只走 [MSG] 块（lib/format.js），所以「怎么办」只能指向标记格式。
 */
export const defaultChannelReminder = '检测到多轮对话没有消息发出，只在会话里回复的话，聊天软件那头的用户看不到。把给用户的内容写进 [MSG]…[/MSG]。'

/** 提醒与系统提示词的长度上限；超过按没设处理，回退内置默认。 */
export const reminderPromptLimit = 4000

/**
 * 峰时提醒的默认文案（设置里留空时用它）。
 *
 * 峰时收到的消息先进非紧要任务队列，谷时再处理；所以只说三件事：现在是峰时、
 * 可以留言、想立刻处理就在开头写【紧要】。
 */
export const defaultPeakNotice = '当前为峰值计价时段，可留言。谷值计价时段会自动处理。可在留言开头使用【紧要】立即安排处理'

/** 余额提醒的默认文案；`{balance}` 会换成两位小数的余额。 */
export const defaultBalanceAlert = '当前余额 {balance} 元，余额偏低，记得充值。'

/**
 * 旧配置的余额提醒方式 → 两个独立开关。
 *
 * 只用于迁移：off 两个都关、message 只开文字、sticker 只开表情。
 * 只要配置里出现任一新的布尔键，旧键就不再参与（见 balanceAlertSwitches）。
 */
export const legacyBalanceAlertModes = Object.freeze({
  off: Object.freeze({ message: false, sticker: false }),
  message: Object.freeze({ message: true, sticker: false }),
  sticker: Object.freeze({ message: false, sticker: true }),
})

/** 提醒文案（峰时 / 余额）的长度上限；超过按没设处理，回退内置默认。 */
export const noticeTemplateLimit = 1000

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
  /** 私聊绑定：一行 = 一个对端（QQ 渠道号或微信 wxid/openid）→ 一间 DSH 会话；同一间会话可以挂多行（多个渠道）。v1 只有私聊。 */
  bindings: [],
  /**
   * 微信通道开关：开之前先在设置页扫码登录。
   * 关着时连 iLink 适配器都不建，不跑登录循环；打开后由设置页发起扫码。
   */
  wechatEnabled: false,
  /** true = 只发 [MSG]…[/MSG] 块内；false = 整条发但剥掉标记 */
  onlyInsideMarkers: true,
  /** true = 暂停把渠道消息转进 DSH 会话；消息照常接收，存待转发队列，恢复后按顺序补发 */
  forwardPaused: false,
  /** true = 防失联：绑定会话里挡掉会等人/会中断的工具，卡住时提醒；只对启用的绑定生效 */
  guardEnabled: true,
  /** 绑定会话连续运行超过这么久就提醒（秒，1~7200）：这一轮还在跑，渠道那头就收不到回复 */
  guardStuckSeconds: 600,
  /** 连续这么多轮 assistant 回合没有消息出站，就提醒一次（1~50，默认 3） */
  guardQqRemindTurns: 3,
  /** 长任务提醒的提示词；留空用内置默认（`defaultLongTaskReminder`） */
  guardStuckPrompt: '',
  /** 消息通道提醒的提示词；留空用内置默认（`defaultChannelReminder`） */
  guardQqPrompt: '',
  /** 注入给绑定会话的系统提示词；留空用内置默认（lib/guard.js 的 `guardRules`） */
  guardSystemPrompt: '',
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
  /** 出站固定间隔（毫秒）：与上一条消息发出的最小间隔；空闲后的第一条不等；0 = 不等 */
  outboxPerMessageDelayMs: 2000,
  /** 出站逐字间隔（毫秒）：按字数加到最小间隔上；字数口径见 lib/pacing.js */
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
  /** 收到渠道语音后是否交给本地 AI 分析（文字） */
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
  /**
   * 峰时把入站批次转进非紧要任务队列（需要 fish-token 提供 fish.token）。
   * 关掉或没装服务时照旧直接投进会话；服务在但时段查不到时按峰时处理（最保守）。
   */
  peakDeferEnabled: true,
  /** 峰时提醒文案；留空用内置默认（`defaultPeakNotice`），{offPeakStart}/{offPeakEnd} 填服务给的下一段谷时 */
  peakNoticeTemplate: '',
  /** 同一对端的峰时提醒冷却（分钟，0~1440）；0 = 每次都提醒 */
  peakNoticeCooldownMinutes: 30,
  /** 余额提醒：往当前送信渠道发一条文字（默认开）；与表情开关互相独立，两个都关 = 不提醒 */
  balanceAlertMessageEnabled: true,
  /** 余额提醒：再发一张表情（默认关）；表情发不出去时，文字开着就只留文字 */
  balanceAlertStickerEnabled: false,
  /** 余额提醒文案；`{balance}` 换成两位小数；留空用内置默认（`defaultBalanceAlert`） */
  balanceAlertTemplate: '',
  /** 余额提醒要发的表情名字 / #标签 / id；空串 = 本次只发文字 */
  balanceAlertSticker: '',
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

/** 值算不算「用户填了」：空串与 null/undefined 都当没填，与 normalizeConfig 的 pick 同口径。 */
const given = (value) => value !== undefined && value !== null && value !== ''

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

/** 峰时 / 余额提醒文案：非字符串、超长都当没设，回退内置默认。 */
const noticeTemplate = (value) => {
  if (typeof value !== 'string') return ''
  const clean = value.trim()
  return clean && clean.length <= noticeTemplateLimit ? clean : ''
}

/**
 * 余额提醒的两个开关：message 发文字、sticker 发表情。
 *
 * 任一新键有值就按新键走（另一个缺失的回落它自己的默认）；两个新键都没有才读旧
 * `balanceAlertMode` 做迁移。非布尔值按默认处理，与 /save 的规整口径一致。
 */
export function balanceAlertSwitches(config = {}) {
  const src = config && typeof config === 'object' ? config : {}
  const hasNewKeys = given(src.balanceAlertMessageEnabled) || given(src.balanceAlertStickerEnabled)
  if (!hasNewKeys) {
    const legacy = legacyBalanceAlertModes[text(src.balanceAlertMode).toLowerCase()]
    if (legacy) return { message: legacy.message, sticker: legacy.sticker }
  }
  return {
    message: boolean(src.balanceAlertMessageEnabled, DEFAULT_CONFIG.balanceAlertMessageEnabled),
    sticker: boolean(src.balanceAlertStickerEnabled, DEFAULT_CONFIG.balanceAlertStickerEnabled),
  }
}

/**
 * 峰时提醒文案：{offPeakStart}/{offPeakEnd} 换成 fish-token 给的「下一段谷时」起止时刻。
 *
 * 鱼讯不自己算峰谷窗口（窗口会随法定节假日 / 调休变化），所以占位符只能填服务给的
 * `nextOffPeakAt` / `nextPeakAt`；拿不到时刻时整段回退内置默认（默认文案不含占位符，
 * 不会出现「谷时 到 再处理」这样的半句）。
 */
export function renderPeakNotice(template, window = null) {
  const base = text(template) || defaultPeakNotice
  const start = text(window?.start)
  const end = text(window?.end)
  if ((base.includes('{offPeakStart}') || base.includes('{offPeakEnd}')) && (!start || !end)) {
    return defaultPeakNotice
  }
  return base
    .replace(/\{offPeakStart\}/g, start)
    .replace(/\{offPeakEnd\}/g, end)
}

/** 余额提醒实际要发的文字：{balance} 换成两位小数；余额不是数字时留空。 */
export function renderBalanceAlert(template, balance) {
  const base = text(template) || defaultBalanceAlert
  const n = Number(balance)
  const shown = Number.isFinite(n) ? n.toFixed(2) : ''
  return base.replace(/\{balance\}/g, shown)
}

const stripTrailingSlash = (value) => text(value).replace(/\/+$/, '')

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

/** 对端原值：qq 是兼容用的存储键，peer 是别名，哪个有值用哪个（空串不算有值）。 */
const bindingPeerValue = (item) => [item.qq, item.peer, item.QQ, item.号码, item.userId]
  .find((value) => value !== undefined && value !== null && String(value).trim() !== '')

/**
 * 规整绑定：只留私聊、按对端去重、钳长度。
 *
 * 一条绑定 = 一个渠道（channel + peer），所以对端唯一：同一个对端只能绑一间会话，
 * 重复的 peer 保留第一条。session 允许为空，表示渠道保留、当前不挂任何会话；
 * 反向不做限制：同一间会话可以挂多条绑定（多个渠道、多个对端）。
 *
 * channel 缺省 qq（老配置原样可用）；qq 字段继续作为对端值的存储键，peer 是它的别名。
 * 微信对端带字母、@、下划线，必须原样保留：清成空串等于把整条绑定丢掉。
 *
 * dropped 传数组时，每条被丢掉的条目都按 { channel, peer, reason } 追加一句中文原因，
 * reason 直接给设置页展示。加载配置、迁移旧桥不需要逐条解释，所以默认 null 时行为与旧版一致。
 */
export function normalizeBindings(raw, dropped = null) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seePeer = new Set()
  const report = (channel, peer, reason) => {
    if (Array.isArray(dropped)) dropped.push({ channel: channel || '', peer: peer || '', reason: reason || '' })
  }
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object') {
      report('', '', '条目格式不对')
      continue
    }
    const legacyKind = text(item.类型 || item.type)
    if (legacyKind && legacyKind !== '私聊' && legacyKind.toLowerCase() !== 'private') {
      report(text(item.channel ?? item.通道), text(bindingPeerValue(item)), '只支持私聊')
      continue
    }
    // 通道写错的那一行不猜：猜成 qq 会把微信对端剥成空串，静默丢配置。
    const channel = parseChannel(item.channel ?? item.通道)
    if (!channel) {
      report(text(item.channel ?? item.通道).slice(0, 20), text(bindingPeerValue(item)), '通道只能填 qq 或 wechat')
      continue
    }
    const rawPeer = text(bindingPeerValue(item))
    const peer = normalizePeer(channel, rawPeer)
    if (!peer) {
      // 规整后为空只可能是 QQ 对端里塞了非数字（微信对端只 trim，不会变空）。
      report(channel, rawPeer, rawPeer ? '对端格式不对：QQ 渠道号只能是数字' : '对端没填')
      continue
    }
    const problem = peerProblem(channel, peer)
    if (problem) {
      report(channel, peer, `对端格式不对：${problem}`)
      continue
    }
    const session = text(item.session ?? item.会话 ?? item.sessionId)
    // 去重键带通道：两个通道可以绑同一个对端字符串，互不挤占。
    const target = peerKey(channel, peer)
    if (seePeer.has(target)) {
      report(channel, peer, '这个对端已经有一条渠道了')
      continue
    }
    // 上限按「处理到第几条」算，与旧实现的 raw.slice(0, 30) 等价；超出同样要说出来。
    if (index >= 30) {
      report(channel, peer, '最多同时保存 30 条渠道')
      continue
    }
    seePeer.add(target)
    out.push({
      channel,
      qq: peer,
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

  // 余额提醒的两个开关：旧配置只有 balanceAlertMode 时在这里按迁移表展开。
  const balanceAlert = balanceAlertSwitches(src)

  return {
    napcatBaseUrl,
    napcatToken: text(pick('napcatToken', '令牌'), DEFAULT_CONFIG.napcatToken),
    wsEnabled: boolean(pick('wsEnabled'), DEFAULT_CONFIG.wsEnabled),
    wsUrl,
    bindings: normalizeBindings(pick('bindings', '绑定')),
    wechatEnabled: boolean(pick('wechatEnabled'), DEFAULT_CONFIG.wechatEnabled),
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
    guardSystemPrompt: reminderPrompt(pick('guardSystemPrompt')),
    backfillWindowHours,
    outboxTtlHours: clampNumber(pick('outboxTtlHours'), DEFAULT_CONFIG.outboxTtlHours, 1, 720),
    outboxDedupMinutes: clampNumber(pick('outboxDedupMinutes'), DEFAULT_CONFIG.outboxDedupMinutes, 0, 1440),
    outboxFlushIntervalMs: clampNumber(pick('outboxFlushIntervalMs'), DEFAULT_CONFIG.outboxFlushIntervalMs, 1000, 600000),
    pollIntervalMs: clampNumber(pick('pollIntervalMs', '轮询间隔毫秒'), DEFAULT_CONFIG.pollIntervalMs, 500, 30000),
    historyIntervalMs: clampNumber(pick('historyIntervalMs'), DEFAULT_CONFIG.historyIntervalMs, 5000, 600000),
    reorderBufferMs: clampNumber(pick('reorderBufferMs'), DEFAULT_CONFIG.reorderBufferMs, 0, 5000),
    inboundEditWindowMs: Math.round(clampNumber(pick('inboundEditWindowMs'), DEFAULT_CONFIG.inboundEditWindowMs, 0, 120000)),
    // 出站节奏的上限是防手滑：单条最多隔 1 分钟，逐字最多 5 秒/字。
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
    // fish.token 相关的六个键：旧配置没有它们时全部落默认值，行为与旧版一致。
    peakDeferEnabled: boolean(pick('peakDeferEnabled'), DEFAULT_CONFIG.peakDeferEnabled),
    peakNoticeTemplate: noticeTemplate(pick('peakNoticeTemplate')),
    peakNoticeCooldownMinutes: Math.round(clampNumber(
      pick('peakNoticeCooldownMinutes'),
      DEFAULT_CONFIG.peakNoticeCooldownMinutes, 0, 1440,
    )),
    balanceAlertMessageEnabled: balanceAlert.message,
    balanceAlertStickerEnabled: balanceAlert.sticker,
    balanceAlertTemplate: noticeTemplate(pick('balanceAlertTemplate')),
    balanceAlertSticker: text(pick('balanceAlertSticker')).slice(0, 120),
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
    channel: z.string().default('qq').description('通道：qq / wechat'),
    qq: z.string().default('').description('对方 id（QQ 渠道号或微信 id）'),
    session: z.string().default('').description('DSH 会话 id'),
    name: z.string().default('主人').description('称呼'),
    enabled: z.boolean().default(true).description('是否启用'),
  }).description('一行 = 一个渠道（对端）→ 一间 DSH 会话；同一间会话可以挂多行')

  return z.object({
    napcatBaseUrl: field(z.string().default(DEFAULT_CONFIG.napcatBaseUrl).description('NapCat / OneBot 11 HTTP 根地址')),
    napcatToken: field(z.string().default('').description('OneBot access_token，没有就留空')),
    wsEnabled: field(z.boolean().default(true).description('优先使用 WebSocket')),
    wsUrl: field(z.string().default('').description('WebSocket 地址；留空自动推导')),
    bindings: field(z.array(binding).default([]).description('私聊绑定列表')),
    wechatEnabled: field(z.boolean().default(DEFAULT_CONFIG.wechatEnabled).description('微信通道开关：开之前先在设置页扫码登录')),
    onlyInsideMarkers: field(z.boolean().default(true).description('只发 [MSG]…[/MSG] 块内内容')),
    forwardPaused: field(z.boolean().default(false).description('暂停转发到 DSH 会话（消息照常接收，恢复后按顺序补发）')),
    guardEnabled: field(z.boolean().default(true).description('防失联：绑定会话不能停下来等人，卡住时提醒（只对启用的绑定生效）')),
    guardStuckSeconds: field(z.natural().default(600).max(7200).description('主会话单轮连续运行超过多少秒就提醒（1~7200）')),
    guardQqRemindTurns: field(z.natural().default(3).description('连续几轮只会话内回话、没有消息出站就提醒一次（1~50）')),
    guardStuckPrompt: field(z.string().max(4000).default('').description('长任务提醒的提示词；留空用内置默认')),
    guardQqPrompt: field(z.string().max(4000).default('').description('消息通道提醒的提示词；留空用内置默认')),
    guardSystemPrompt: field(z.string().max(4000).default('').description('注入到绑定会话的系统提示词；留空用内置默认')),
    backfillWindowHours: field(z.natural().default(DEFAULT_CONFIG.backfillWindowHours).description('离线补投窗口（小时）')),
    outboxTtlHours: field(z.natural().default(DEFAULT_CONFIG.outboxTtlHours).description('出站队列 TTL（小时）')),
    outboxDedupMinutes: field(z.natural().default(DEFAULT_CONFIG.outboxDedupMinutes).description('出站队列去重窗口（分钟）')),
    outboxFlushIntervalMs: field(z.natural().default(DEFAULT_CONFIG.outboxFlushIntervalMs).description('出站队列补发心跳（毫秒）')),
    pollIntervalMs: field(z.natural().default(DEFAULT_CONFIG.pollIntervalMs).description('HTTP 轮询间隔（毫秒）')),
    historyIntervalMs: field(z.natural().default(DEFAULT_CONFIG.historyIntervalMs).description('历史兜底间隔（毫秒）')),
    reorderBufferMs: field(z.natural().default(DEFAULT_CONFIG.reorderBufferMs).description('乱序缓冲（毫秒）')),
    inboundEditWindowMs: field(z.natural().default(DEFAULT_CONFIG.inboundEditWindowMs).max(120000).description('入站编辑窗口（毫秒）：静默这么久后把这一批合并投递；0 = 逐条投递')),
    outboxPerMessageDelayMs: field(z.natural().default(DEFAULT_CONFIG.outboxPerMessageDelayMs).max(60000).description('出站固定间隔（毫秒）')),
    outboxPerCharDelayMs: field(z.natural().default(DEFAULT_CONFIG.outboxPerCharDelayMs).max(5000).description('出站逐字间隔（毫秒）')),
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
    peakDeferEnabled: field(z.boolean().default(true).description('峰时转任务队列：fish.token 报峰时，入站消息先收进非紧要任务队列，谷时再处理')),
    peakNoticeTemplate: field(z.string().max(1000).default('').description('峰时提醒文案；留空用内置默认，{offPeakStart}/{offPeakEnd} 填服务给的下一段谷时时刻')),
    peakNoticeCooldownMinutes: field(z.natural().default(30).max(1440).description('同一对端的峰时提醒冷却（分钟）；0 = 每次都提醒')),
    balanceAlertMessageEnabled: field(z.boolean().default(true).description('余额提醒：发一条文字')),
    balanceAlertStickerEnabled: field(z.boolean().default(false).description('余额提醒：再发一张表情（名字见 balanceAlertSticker）')),
    balanceAlertTemplate: field(z.string().max(1000).default('').description('余额提醒文案；{balance} 换成两位小数；留空用内置默认')),
    balanceAlertSticker: field(z.string().default('').description('余额提醒要发的表情名字 / #标签 / id；留空时本次只发文字')),
    logLevel: field(z.string().default(DEFAULT_CONFIG.logLevel).description('日志级别：debug/info/warn/error')),
  }).description('dsh-fish-message 配置')
}
