// 可选的本地 AI 能力：语音合成、语音识别、入站图片识图。
//
// 鱼讯不硬依赖本地 AI 插件：每次真的要用时才通过 ctx.get('fish.service') 取一次，
// 取不到就返回一句人话，桥层继续按原来的方式工作（文字照发、语音只递路径、图片照收）。
// 这里不 import 任何 DSH / fish.service 的代码，只依赖调用方传进来的 getService()。

const 默认音色 = 'dafeiyu'
const 支持语言 = new Set(['auto', 'zh', 'en', 'ja', 'ko', 'yue'])

const 动作词 = {
  tts: { 做不了: '发不了语音', 不支持: '发语音' },
  asr: { 做不了: '转不了语音', 不支持: '转写语音' },
  vision: { 做不了: '识不了图片', 不支持: '识图' },
  '': { 做不了: '用不了本地 AI', 不支持: '使用本地 AI' },
}

const 取字 = (值) => (值 == null ? '' : String(值).trim())

// 入站语音的情感/背景音：上游 asr 给了就带出来，旧版插件没给就整段省略。
// 这里只做「码 → 短中文」的映射，消息怎么排由桥层决定。
const 情绪表 = {
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
const 背景表 = {
  LAUGHTER: '笑声',
  LAUGH: '笑声',
  APPLAUSE: '掌声',
  CLAPPING: '掌声',
  BGM: '音乐',
  MUSIC: '音乐',
}

/** 多个背景音只取一个，按这个顺序挑最显眼的。 */
const 背景顺序 = ['笑声', '掌声', '音乐']

/** 去掉方括号和空白、统一大写：兼容 "Speech" / "[Speech]" / " speech "。 */
const 规整标签 = (值) => String(值 ?? '').trim().replace(/^\[+|\]+$/g, '').trim().toUpperCase()

/** 情绪码 → 短中文；缺字段、空值、不认识的值都返回空串（消息里就不写）。 */
export function 情绪中文(值) {
  return 情绪表[规整标签(值)] || ''
}

/** events 里挑一个背景音（笑声/掌声/音乐）；没有、只有 Speech 或都不认识时返回空串。 */
export function 背景中文(事件们) {
  const 列表 = Array.isArray(事件们)
    ? 事件们
    : (typeof 事件们 === 'string' ? 事件们.split(/[,，、;；]/) : [])
  const 有 = new Set()
  for (const 事 of 列表) {
    const 词 = 背景表[规整标签(事)]
    if (词) 有.add(词)
  }
  for (const 词 of 背景顺序) if (有.has(词)) return 词
  return ''
}

/** 声纹结果 → {name, score, known}；没有名字就当没识别出来（不影响转写）。 */
const 取说话人 = (项) => {
  const 原 = 项?.speaker
  if (!原 || typeof 原 !== 'object') return null
  const 名 = 取字(原.name)
  if (!名) return null
  return { name: 名, score: Number(原.score) || 0, known: Boolean(原.known) }
}

/** 从错误对象里拿一个稳定的错误码；服务有时抛错、有时返回 {ok:false,code}。 */
function 取码(错误) {
  const 码 = 取字(错误?.code || 错误?.reason)
  if (码) return 码
  const 状态 = Number(错误?.httpStatus || 错误?.status || 0)
  if (状态 === 507) return 'vram_exhausted'
  if (状态 === 503) return 'model_missing'
  return ''
}

/** 能力子项：服务可能给布尔值，也可能给 {available,ready,reason}。 */
export function 能力项(服务, 名) {
  try {
    const 能力 = 服务?.capabilities
    if (!能力 || typeof 能力 !== 'object') return null
    const 项 = 能力[名]
    if (typeof 项 === 'boolean') return 项 ? { available: true } : { available: false, reason: 'not_supported' }
    return 项 && typeof 项 === 'object' ? 项 : null
  } catch {
    return null
  }
}

/** 某个能力是否可用：方法存在 + 服务端能力没被标成不可用。 */
export function 能力状态(服务, 名, 方法名) {
  if (!服务 || typeof 服务 !== 'object') {
    return { installed: false, available: false, reason: 'service_not_installed', ready: false }
  }
  const 有方法 = typeof 服务[方法名] === 'function'
  const 项 = 能力项(服务, 名)
  let 可用 = 有方法
  let 原因 = 有方法 ? '' : 'not_supported'
  if (可用 && 项) {
    if (typeof 项 === 'boolean') 可用 = 项
    else if (项.available === false) 可用 = false
    if (!可用) 原因 = 取字(项.reason) || 'not_supported'
  }
  return {
    installed: true,
    available: 可用,
    reason: 原因,
    ready: 可用 && 项?.ready !== false,
  }
}

/** 错误码 → 一句用户能看懂的话（不出现端口、接口名、模型文件名）。 */
export function 友好提示(错误, 动作 = '') {
  const 码 = 取码(错误)
  const 词 = 动作词[动作] || 动作词['']
  const 后缀 = '其它功能不受影响。'
  switch (码) {
    case 'service_not_installed':
    case 'service_down':
      return `本地 AI 插件没装或没启动，暂时${词.做不了}，${后缀}`
    case 'not_supported':
    case 'not_implemented':
      return `本地 AI 暂不支持${词.不支持}，${后缀}`
    case 'model_missing':
      return `本地 AI 的${动作 === 'vision' ? '识图模型' : '语音模型'}还没准备好，暂时${词.做不了}，${后缀}`
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
      return `这次没能${词.不支持}，稍后再试。`
    default:
      return `这次没能${词.不支持}，稍后再试。`
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
  服务() {
    try {
      const 服务 = this.getService()
      return 服务 && typeof 服务 === 'object' ? 服务 : null
    } catch (error) {
      this.logger?.debug?.(`读取本地 AI 服务失败（不影响其它功能）：${String(error?.message || error)}`)
      return null
    }
  }

  最近错误(服务) {
    try {
      return 服务?.lastError || null
    } catch {
      return null
    }
  }

  /** 把异常/失败返回值统一成 {ok:false, code, hint, detail}。 */
  失败(错误, 动作 = '') {
    let 源 = 错误 && typeof 错误 === 'object' ? 错误 : { message: 取字(错误) }
    if (!取码(源)) {
      const 末 = this.最近错误(this.服务())
      if (末 && 取码(末)) 源 = 末
    }
    const 码 = 取码(源)
    const 详情 = 取字(源?.detail || 源?.message)
    if (详情) this.logger?.debug?.(`本地 AI ${动作 || '任务'}失败：${码 || 'unknown'}｜${详情}`)
    return {
      ok: false,
      code: 码 || 'unknown',
      hint: 友好提示({ ...源, code: 码 }, 动作),
      ...(详情 ? { detail: 详情 } : {}),
    }
  }

  /** 给设置页看的同步状态。不联网，只读服务最近一次探测结果。 */
  status() {
    const 服务 = this.服务()
    if (!服务) {
      return {
        installed: false,
        online: false,
        tts: false,
        asr: false,
        vision: false,
        hint: 友好提示({ code: 'service_not_installed' }),
      }
    }
    const tts = 能力状态(服务, 'tts', 'tts').available
    const asr = 能力状态(服务, 'asr', 'asr').available
    const vision = 能力状态(服务, 'vision', 'visionDescribe').available
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
    const 服务 = this.服务()
    if (!服务 || typeof 服务.visionPrefs !== 'function') return { known: false }
    try {
      const 结果 = await 服务.visionPrefs()
      if (!结果 || typeof 结果 !== 'object') return { known: false }
      const 值 = 结果.localDescribe
      if (typeof 值 === 'boolean') return { known: true, localDescribe: 值 }
      if (值 === 'true' || 值 === 1 || 值 === '1') return { known: true, localDescribe: true }
      if (值 === 'false' || 值 === 0 || 值 === '0') return { known: true, localDescribe: false }
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
  async 入站识图开关(设置 = 'inherit') {
    if (设置 === 'on') return true
    if (设置 === 'off') return false
    const 偏好 = await this.visionPrefs()
    return 偏好.known ? 偏好.localDescribe : true
  }

  /** 语音合成：成功返回可以直接交给 sendRecord 的 wavPath。 */
  async tts(text, { voice = 默认音色, speed = 1 } = {}) {
    const 服务 = this.服务()
    const 状态 = 能力状态(服务, 'tts', 'tts')
    if (!状态.available) return this.失败({ code: 状态.reason || 'not_supported' }, 'tts')
    const 正文 = 取字(text)
    if (!正文) return { ok: false, code: 'bad_request', hint: '没有可合成的文字。' }
    const 音色 = 取字(voice) || 默认音色
    const 语速 = Math.max(0.5, Math.min(2, Number(speed) || 1))
    try {
      const 结果 = await 服务.tts(正文, { voice: 音色, speed: 语速 })
      if (结果?.ok === false) return this.失败(结果, 'tts')
      const 项 = Array.isArray(结果?.items) ? 结果.items[0] : (结果?.items || 结果)
      const 路径 = 取字(项?.wavPath || 结果?.wavPath)
      if (!路径) return this.失败({ code: 'bad_request', detail: '合成结果没有 wavPath' }, 'tts')
      return { ok: true, wavPath: 路径, voice: 取字(项?.voice) || 音色, item: 项 }
    } catch (error) {
      return this.失败(error, 'tts')
    }
  }

  /**
   * 语音识别：成功返回文字（可能是空串，代表没听出内容）、声纹信息（可能没有），
   * 以及情绪/背景音的短中文（旧版插件没这两个字段时是空串，桥层据此省略）。
   */
  async asr(path, { language = 'auto' } = {}) {
    const 服务 = this.服务()
    const 状态 = 能力状态(服务, 'asr', 'asr')
    if (!状态.available) return this.失败({ code: 状态.reason || 'not_supported' }, 'asr')
    const 文件 = 取字(path)
    if (!文件) return { ok: false, code: 'bad_request', hint: '语音文件路径为空。' }
    const 语言 = 支持语言.has(String(language)) ? String(language) : 'auto'
    try {
      const 结果 = await 服务.asr(文件, { language: 语言 })
      if (结果?.ok === false) return this.失败(结果, 'asr')
      const 项 = Array.isArray(结果?.items) ? 结果.items[0] : (结果?.items || 结果)
      const 文字 = 取字(项?.text)
      return {
        ok: true,
        text: 文字,
        speaker: 取说话人(项),
        item: 项,
        language: 取字(项?.language) || 语言,
        // 拿不到就是空串，不写 undefined / null，桥层直接跳过这两段。
        emotion: 情绪中文(项?.emotion),
        background: 背景中文(项?.events),
      }
    } catch (error) {
      return this.失败(error, 'asr')
    }
  }

  /**
   * 入站图片识图。visionDescribe 由本地 AI 插件提供；没有这个方法就当不可用。
   * 契约：visionDescribe(path, {mode:'caption'}) → {ok, items:[{path,text}]}
   */
  async describeImage(path, { prompt = '', mode = 'caption' } = {}) {
    const 服务 = this.服务()
    const 状态 = 能力状态(服务, 'vision', 'visionDescribe')
    if (!状态.available) return this.失败({ code: 状态.reason || 'not_supported' }, 'vision')
    const 文件 = 取字(path)
    if (!文件) return { ok: false, code: 'bad_request', hint: '图片路径为空。' }
    try {
      const 参数 = { mode }
      if (取字(prompt)) 参数.prompt = 取字(prompt)
      const 结果 = await 服务.visionDescribe(文件, 参数)
      if (结果?.ok === false) return this.失败(结果, 'vision')
      const 项 = Array.isArray(结果?.items) ? 结果.items[0] : (结果?.items || 结果)
      const 文字 = 取字(项?.text).replace(/\s+/g, ' ')
      if (!文字) return this.失败({ code: 'bad_request', detail: '识图结果为空' }, 'vision')
      return { ok: true, text: 文字 }
    } catch (error) {
      return this.失败(error, 'vision')
    }
  }

  /** 可用音色列表；失败时返回空列表 + 一句提示，设置页退回文本框。 */
  async listVoices() {
    const 服务 = this.服务()
    const 状态 = 能力状态(服务, 'tts', 'tts')
    if (!状态.available) return { ...this.失败({ code: 状态.reason || 'not_supported' }, 'tts'), voices: [] }
    try {
      const 结果 = await 服务.voices?.()
      const 原始 = Array.isArray(结果)
        ? 结果
        : (Array.isArray(结果?.items) ? 结果.items : (Array.isArray(结果?.voices) ? 结果.voices : []))
      const 音色们 = 原始
        .map((项) => (typeof 项 === 'string' ? 项 : 取字(项?.name)))
        .filter(Boolean)
      return { ok: true, voices: [...new Set(音色们)] }
    } catch (error) {
      return { ...this.失败(error, 'tts'), voices: [] }
    }
  }
}

export { 默认音色, 支持语言 }
