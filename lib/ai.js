// 可选的本地 AI 能力：语音合成、语音识别、入站图片识图。
//
// 鱼讯不硬依赖本地 AI 插件：每次真的要用时才通过 ctx.get('fish.service') 取一次，
// 取不到就返回一句人话，桥层继续按原来的方式工作（文字照发、语音只递路径、图片照收）。
// 这里不 import 任何 DSH / fish.service 的代码，只依赖调用方传进来的 getService()。

import { ttsFriendly, splitVoiceText } from './tts-text.js'

const defaultVoice = 'dafeiyu'
const supportedLanguages = new Set(['auto', 'zh', 'en', 'ja', 'ko', 'yue'])

const actionWords = {
  tts: { cannotDo: '发不了语音', unsupported: '发语音' },
  asr: { cannotDo: '转不了语音', unsupported: '转写语音' },
  vision: { cannotDo: '识不了图片', unsupported: '识图' },
  '': { cannotDo: '用不了本地 AI', unsupported: '使用本地 AI' },
}

const toText = (value) => (value == null ? '' : String(value).trim())

// 入站语音的情感/背景音：上游 asr 给了就带出来，旧版插件没给就整段省略。
// 这里只做「码 → 短中文」的映射，消息怎么排由桥层决定。
const emotionMap = {
  NEUTRAL: '中性',
  HAPPY: '开心',
  SAD: '难过',
  ANGRY: '生气',
  FEARFUL: '害怕',
  FEAR: '害怕',
  DISGUSTED: '厌恶',
  SURPRISED: '惊讶',
}

/** 上游 events → 短中文；Speech 只是「有人在说话」，不算背景音。 */
const backgroundMap = {
  LAUGHTER: '笑声',
  LAUGH: '笑声',
  APPLAUSE: '掌声',
  CLAPPING: '掌声',
  BGM: '音乐',
  MUSIC: '音乐',
}

/** 多个背景音只取一个，按这个顺序挑最显眼的。 */
const backgroundOrder = ['笑声', '掌声', '音乐']

/** 去掉方括号和空白、统一大写：兼容 "Speech" / "[Speech]" / " speech "。 */
const normalizeTags = (value) => String(value ?? '').trim().replace(/^\[+|\]+$/g, '').trim().toUpperCase()

/** 情绪码 → 短中文；缺字段、空值、不认识的值都返回空串（消息里就不写）。 */
export function emotionText(value) {
  return emotionMap[normalizeTags(value)] || ''
}

/** events 里挑一个背景音（笑声/掌声/音乐）；没有、只有 Speech 或都不认识时返回空串。 */
export function backgroundText(events) {
  const list = Array.isArray(events)
    ? events
    : (typeof events === 'string' ? events.split(/[,，、;；]/) : [])
  const has = new Set()
  for (const thing of list) {
    const word = backgroundMap[normalizeTags(thing)]
    if (word) has.add(word)
  }
  for (const word of backgroundOrder) if (has.has(word)) return word
  return ''
}

/** 从错误对象里拿一个稳定的错误码；服务有时抛错、有时返回 {ok:false,code}。 */
function getCode(error) {
  const code = toText(error?.code || error?.reason)
  if (code) return code
  const status = Number(error?.httpStatus || error?.status || 0)
  if (status === 507) return 'vram_exhausted'
  if (status === 503) return 'model_missing'
  return ''
}

/** 能力子项：服务可能给布尔值，也可能给 {available,ready,reason}。 */
export function capabilityItem(service, name) {
  try {
    const capabilities = service?.capabilities
    if (!capabilities || typeof capabilities !== 'object') return null
    const item = capabilities[name]
    if (typeof item === 'boolean') return item ? { available: true } : { available: false, reason: 'not_supported' }
    return item && typeof item === 'object' ? item : null
  } catch {
    return null
  }
}

/** 某个能力是否可用：方法存在 + 服务端能力没被标成不可用。 */
export function capabilityStatus(service, name, methodName) {
  if (!service || typeof service !== 'object') {
    return { installed: false, available: false, reason: 'service_not_installed', ready: false }
  }
  const hasMethod = typeof service[methodName] === 'function'
  const item = capabilityItem(service, name)
  let available = hasMethod
  let reason = hasMethod ? '' : 'not_supported'
  if (available && item) {
    if (typeof item === 'boolean') available = item
    else if (item.available === false) available = false
    if (!available) reason = toText(item.reason) || 'not_supported'
  }
  return {
    installed: true,
    available: available,
    reason: reason,
    ready: available && item?.ready !== false,
  }
}

/** 错误码 → 一句用户能看懂的话（不出现端口、接口名、模型文件名）。 */
export function friendlyHint(error, action = '') {
  const code = getCode(error)
  const word = actionWords[action] || actionWords['']
  const suffix = '其它功能不受影响。'
  switch (code) {
    case 'service_not_installed':
    case 'service_down':
      return `本地 AI 插件没装或没启动，暂时${word.cannotDo}，${suffix}`
    case 'not_supported':
    case 'not_implemented':
      return `本地 AI 暂不支持${word.unsupported}，${suffix}`
    case 'model_missing':
      return `本地 AI 的${action === 'vision' ? '识图模型' : '语音模型'}还没准备好，暂时${word.cannotDo}，${suffix}`
    case 'model_loading':
      return '本地 AI 正在加载模型，稍等一下再试。'
    case 'vram_exhausted':
      return '显卡被别的任务占满了，等本地 AI 空下来再试。'
    case 'busy':
      return '本地 AI 正忙，稍等一下再试。'
    case 'timeout':
      return '本地 AI 响应太慢，稍后再试。'
    case 'bad_request':
      return '这次没能处理，换一段内容再试。'
    case 'api_incompatible':
      return '本地 AI 插件版本太旧，更新后再试。'
    case 'canceled':
      return '这次操作已取消。'
    case 'upstream_error':
      return '本地 AI 出了点问题，稍后再试。'
    case '':
      return `这次没能${word.unsupported}，稍后再试。`
    default:
      return `这次没能${word.unsupported}，稍后再试。`
  }
}

/**
 * 可选 AI 门面。所有方法都不抛错，统一返回 {ok, ...}；
 * 调用方只看 ok / hint，不需要认识 fish.service 的错误类型。
 */
export class AiService {
  constructor({ getService, getConfig, logger } = {}) {
    this.getService = typeof getService === 'function' ? getService : () => null
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({})
    this.logger = logger
  }

  /** 每次现取：插件可能比鱼讯晚加载，不能在 apply 时缓存成 null。 */
  service() {
    try {
      const service = this.getService()
      return service && typeof service === 'object' ? service : null
    } catch (error) {
      this.logger?.debug?.(`读取本地 AI 服务失败（不影响其它功能）：${String(error?.message || error)}`)
      return null
    }
  }

  recentError(service) {
    try {
      return service?.lastError || null
    } catch {
      return null
    }
  }

  /** 把异常/失败返回值统一成 {ok:false, code, hint, detail}。 */
  failure(error, action = '') {
    let source = error && typeof error === 'object' ? error : { message: toText(error) }
    if (!getCode(source)) {
      const end = this.recentError(this.service())
      if (end && getCode(end)) source = end
    }
    const code = getCode(source)
    const detail = toText(source?.detail || source?.message)
    if (detail) this.logger?.debug?.(`本地 AI ${action || '任务'}失败：${code || 'unknown'}｜${detail}`)
    return {
      ok: false,
      code: code || 'unknown',
      hint: friendlyHint({ ...source, code: code }, action),
      ...(detail ? { detail: detail } : {}),
    }
  }

  /** 给设置页看的同步状态。不联网，只读服务最近一次探测结果。 */
  status() {
    const service = this.service()
    if (!service) {
      return {
        installed: false,
        online: false,
        tts: false,
        asr: false,
        vision: false,
        hint: friendlyHint({ code: 'service_not_installed' }),
      }
    }
    const tts = capabilityStatus(service, 'tts', 'tts').available
    const asr = capabilityStatus(service, 'asr', 'asr').available
    const vision = capabilityStatus(service, 'vision', 'visionDescribe').available
    const online = tts || asr || vision
    return {
      installed: true,
      online,
      tts,
      asr,
      vision,
      hint: online ? '' : '本地 AI 插件没启动，语音和识图暂不可用。',
    }
  }

  /**
   * 读本地 AI 插件自己的识图开关。契约（v0.4）：visionPrefs() → { localDescribe }。
   * 插件没装、还没有这个方法、抛错或返回值不认识，都返回 {known:false}，由调用方兜底。
   */
  async visionPrefs() {
    const service = this.service()
    if (!service || typeof service.visionPrefs !== 'function') return { known: false }
    try {
      const result = await service.visionPrefs()
      if (!result || typeof result !== 'object') return { known: false }
      const value = result.localDescribe
      if (typeof value === 'boolean') return { known: true, localDescribe: value }
      if (value === 'true' || value === 1 || value === '1') return { known: true, localDescribe: true }
      if (value === 'false' || value === 0 || value === '0') return { known: true, localDescribe: false }
      return { known: false }
    } catch (error) {
      this.logger?.debug(`读取本地 AI 识图开关失败（按开启处理）：${String(error?.message || error)}`)
      return { known: false }
    }
  }

  /**
   * 设置页三态 → 这条消息到底识不识图。
   * on/off 直接生效；inherit 看插件的开关；插件没装或接口还没有时按「开」，
   * 识图失败会退回原图，不会丢消息。
   */
  async inboundImageEnabled(settings = 'inherit') {
    if (settings === 'on') return true
    if (settings === 'off') return false
    const prefs = await this.visionPrefs()
    return prefs.known ? prefs.localDescribe : true
  }

  /**
   * 语音合成：先把正文改写成 TTS 读得顺的写法，再按句子分段合成。
   * 成功返回 wavPaths（按顺序发送）和第一段的 wavPath（兼容旧的单段调用方）。
   *
   * 分段的原因不是服务端装不下：服务端单条上限 5000 字，而一口气读几百字
   * 既难听、也更容易被上游链路截断。这里按句末标点切到 200 字以内，逐段
   * 顺序合成，任意一段失败就整体失败，不会只发出一半。
   */
  async tts(text, { voice = defaultVoice, speed = 1 } = {}) {
    const service = this.service()
    const status = capabilityStatus(service, 'tts', 'tts')
    if (!status.available) return this.failure({ code: status.reason || 'not_supported' }, 'tts')
    // 先友好化再判空：纯空白或只剩符号的文本改写后是空串，不值得发请求。
    const bodyText = ttsFriendly(toText(text))
    if (!bodyText) return { ok: false, code: 'bad_request', hint: '没有可合成的文字。' }
    const voiceName = toText(voice) || defaultVoice
    const playbackSpeed = Math.max(0.5, Math.min(2, Number(speed) || 1))
    try {
      const paths = []
      const capabilities = []
      for (const segment of splitVoiceText(bodyText)) {
        const result = await service.tts(segment, { voice: voiceName, speed: playbackSpeed })
        if (result?.ok === false) return this.failure(result, 'tts')
        const item = Array.isArray(result?.items) ? result.items[0] : (result?.items || result)
        const path = toText(item?.wavPath || result?.wavPath)
        if (!path) return this.failure({ code: 'bad_request', detail: '合成结果没有 wavPath' }, 'tts')
        paths.push(path)
        capabilities.push(item)
      }
      return {
        ok: true,
        wavPath: paths[0],
        wavPaths: paths,
        voice: toText(capabilities[0]?.voice) || voiceName,
        item: capabilities[0],
        items: capabilities,
      }
    } catch (error) {
      return this.failure(error, 'tts')
    }
  }

  /**
   * 语音识别：成功返回文字（可能是空串，代表没听出内容），
   * 以及情绪/背景音的短中文（旧版插件没这两个字段时是空串，桥层据此省略）。
   */
  async asr(path, { language = 'auto' } = {}) {
    const service = this.service()
    const status = capabilityStatus(service, 'asr', 'asr')
    if (!status.available) return this.failure({ code: status.reason || 'not_supported' }, 'asr')
    const file = toText(path)
    if (!file) return { ok: false, code: 'bad_request', hint: '语音文件路径为空。' }
    const lang = supportedLanguages.has(String(language)) ? String(language) : 'auto'
    try {
      const result = await service.asr(file, { language: lang })
      if (result?.ok === false) return this.failure(result, 'asr')
      const item = Array.isArray(result?.items) ? result.items[0] : (result?.items || result)
      const plainText = toText(item?.text)
      return {
        ok: true,
        text: plainText,
        item: item,
        language: toText(item?.language) || lang,
        // 拿不到就是空串，不写 undefined / null，桥层直接跳过这两段。
        emotion: emotionText(item?.emotion),
        background: backgroundText(item?.events),
      }
    } catch (error) {
      return this.failure(error, 'asr')
    }
  }

  /**
   * 入站图片识图。visionDescribe 由本地 AI 插件提供；没有这个方法就当不可用。
   * 契约：visionDescribe(path, {mode:'caption'}) → {ok, items:[{path,text}]}
   */
  async describeImage(path, { prompt = '', mode = 'caption' } = {}) {
    const service = this.service()
    const status = capabilityStatus(service, 'vision', 'visionDescribe')
    if (!status.available) return this.failure({ code: status.reason || 'not_supported' }, 'vision')
    const file = toText(path)
    if (!file) return { ok: false, code: 'bad_request', hint: '图片路径为空。' }
    try {
      const params = { mode }
      if (toText(prompt)) params.prompt = toText(prompt)
      const result = await service.visionDescribe(file, params)
      if (result?.ok === false) return this.failure(result, 'vision')
      const item = Array.isArray(result?.items) ? result.items[0] : (result?.items || result)
      const plainText = toText(item?.text).replace(/\s+/g, ' ')
      if (!plainText) return this.failure({ code: 'bad_request', detail: '识图结果为空' }, 'vision')
      return { ok: true, text: plainText }
    } catch (error) {
      return this.failure(error, 'vision')
    }
  }

  /** 可用音色列表；失败时返回空列表 + 一句提示，设置页退回文本框。 */
  async listVoices() {
    const service = this.service()
    const status = capabilityStatus(service, 'tts', 'tts')
    if (!status.available) return { ...this.failure({ code: status.reason || 'not_supported' }, 'tts'), voices: [] }
    try {
      const result = await service.voices?.()
      const raw = Array.isArray(result)
        ? result
        : (Array.isArray(result?.items) ? result.items : (Array.isArray(result?.voices) ? result.voices : []))
      const voices = raw
        .map((item) => (typeof item === 'string' ? item : toText(item?.name)))
        .filter(Boolean)
      return { ok: true, voices: [...new Set(voices)] }
    } catch (error) {
      return { ...this.failure(error, 'tts'), voices: [] }
    }
  }
}

export { defaultVoice, supportedLanguages }
