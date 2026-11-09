// 两层 API：底层原样收发 + 高级语音能力。
//
// 底层（LowLevelApi）：
//   send-text / send-image / send-record / send-file / history
//   —— 不解析 [QQ] 标记、不转写、不合成；失败自动进持久化出站队列。
//
// 高级（AdvancedApi）：
//   transcribe / synthesize / voice-reply / voice-analyze / capabilities
//   —— 依赖 asrBaseUrl / ttsBaseUrl；地址留空返回 501，服务不通返回 502，绝不静默失败。
//
// 这里只做参数校验和结果映射，发送/队列/语音实现都在 Bridge / VoiceService 里。

import { existsSync } from 'node:fs'
import { basename } from 'node:path'

const 文本 = (值) => String(值 == null ? '' : 值)
const 数字 = (值, 兜底 = 0) => {
  const n = Number(值)
  return Number.isFinite(n) ? n : 兜底
}

/** 规整 QQ 号：只留数字。 */
export function 规整QQ(qq) {
  return 文本(qq).replace(/[^\d]/g, '')
}

/**
 * API 可预期的错误：host.js 直接按 status/body 返回。
 * body 固定 { ok:false, error, detail, ...extra }。
 */
export class ApiError extends Error {
  constructor(status, error, detail = '', extra = {}) {
    super(detail || error)
    this.name = 'ApiError'
    this.status = status
    this.body = { ok: false, error, detail: detail || error, ...extra }
  }
}

/**
 * qq 省略时用第一条启用中的绑定。
 * 底层 API 允许显式指定任意 QQ（原样发送）；只有「省略且没有绑定」才报错。
 */
export function 解析QQ(输入, config) {
  const 显式 = 规整QQ(输入)
  if (显式) return 显式
  const 首个 = (config?.bindings || []).find((b) => b.enabled) || (config?.bindings || [])[0]
  if (!首个?.qq) throw new ApiError(400, 'no_binding', '没有启用中的 QQ 绑定，请在设置里先加一条')
  return 规整QQ(首个.qq)
}

function 要求文件(path, 标签, { 允许URL = false } = {}) {
  const 值 = 文本(path).trim()
  if (!值) throw new ApiError(400, 'bad_request', `${标签}路径不能为空`)
  if (/^https?:\/\//i.test(值)) {
    if (允许URL) return 值
    throw new ApiError(400, 'file_not_found', `${标签}必须是本地路径：${值}`)
  }
  if (!existsSync(值)) throw new ApiError(400, 'file_not_found', `${标签}不存在：${值}`)
  return 值
}

export class LowLevelApi {
  constructor({ bridge, transport, getConfig, logger }) {
    this.bridge = bridge
    this.transport = transport
    this.getConfig = getConfig
    this.logger = logger
  }

  async 发送(qq, segments, 类型) {
    const 配置 = this.getConfig()
    const 号 = 解析QQ(qq, 配置)
    let 结果
    try {
      结果 = await this.bridge.sendOutbound(号, segments, { reason: `api:${类型}` })
    } catch (error) {
      throw new ApiError(502, 'send_failed', `发送失败且入队失败：${文本(error?.message || error)}`)
    }
    const 状态 = 结果?.queued ? 202 : 200
    return {
      status: 状态,
      body: {
        ok: true,
        kind: 类型,
        qq: 号,
        sent: Boolean(结果?.sent),
        queued: Boolean(结果?.queued),
        id: 结果?.id || null,
        pending: 数字(结果?.pending, this.bridge.outbox?.pending?.() || 0),
        persisted: 结果?.persisted !== false,
        ...(结果?.error ? { detail: 文本(结果.error) } : {}),
      },
    }
  }

  async sendText({ qq, text } = {}) {
    const 正文 = 文本(text)
    if (!正文.trim()) throw new ApiError(400, 'bad_request', 'text 不能为空')
    if (正文.length > 10000) throw new ApiError(400, 'bad_request', 'text 超过 10000 字')
    return await this.发送(qq, [{ type: 'text', data: { text: 正文 } }], 'text')
  }

  async sendImage({ qq, path } = {}) {
    const 路径 = 要求文件(path, '图片', { 允许URL: true })
    return await this.发送(qq, [{ type: 'image', data: { path: 路径 } }], 'image')
  }

  async sendRecord({ qq, path } = {}) {
    const 路径 = 要求文件(path, '语音')
    return await this.发送(qq, [{ type: 'record', data: { path: 路径 } }], 'record')
  }

  async sendFile({ qq, path, name } = {}) {
    const 路径 = 要求文件(path, '文件')
    const 文件名 = 文本(name).trim() || basename(路径.replace(/\\/g, '/'))
    return await this.发送(qq, [{ type: 'file', data: { path: 路径, name: 文件名 } }], 'file')
  }

  async history({ qq, count } = {}) {
    const 配置 = this.getConfig()
    const 号 = 解析QQ(qq, 配置)
    const 条数 = Math.max(1, Math.min(500, Math.round(数字(count, 配置.historyCount || 100))))
    let messages
    try {
      messages = await this.transport.fetchHistory(号, { count: 条数 })
    } catch (error) {
      throw new ApiError(502, 'onebot_error', `拉取 OneBot 历史失败：${文本(error?.message || error)}`)
    }
    const 列表 = Array.isArray(messages) ? messages : []
    return {
      status: 200,
      body: { ok: true, qq: 号, count: 列表.length, messages: 列表 },
    }
  }
}

export class AdvancedApi {
  constructor({ bridge, transport, voice, getConfig, logger }) {
    this.bridge = bridge
    this.transport = transport
    this.voice = voice
    this.getConfig = getConfig
    this.logger = logger
  }

  asr地址() {
    return 文本(this.getConfig()?.asrBaseUrl).trim()
  }

  tts地址() {
    return 文本(this.getConfig()?.ttsBaseUrl).trim()
  }

  /** 高级 API 的可用性：只看服务地址，地址留空 = 不可用。 */
  capabilities() {
    const asr = this.asr地址()
    const tts = this.tts地址()
    return {
      status: 200,
      body: {
        ok: true,
        lowLevel: true,
        advanced: {
          transcribe: Boolean(asr),
          synthesize: Boolean(tts),
          voiceReply: Boolean(tts),
          voiceAnalyze: Boolean(asr),
        },
        services: {
          asr: { url: asr, enabled: Boolean(asr) },
          tts: { url: tts, enabled: Boolean(tts) },
        },
      },
    }
  }

  需要服务(服务) {
    const 地址 = 服务 === 'asr' ? this.asr地址() : this.tts地址()
    if (地址) return 地址
    const 字段 = 服务 === 'asr' ? 'asrBaseUrl' : 'ttsBaseUrl'
    const 名 = 服务 === 'asr' ? 'asr' : 'tts'
    throw new ApiError(
      501,
      'advanced_api_disabled',
      `高级 API 未启用：请在设置里填写 ${名} 服务地址`,
      { missing: 字段, service: 名 },
    )
  }

  上游错误(服务, error) {
    const 名 = 服务 === 'asr' ? '语音识别' : '语音合成'
    return new ApiError(502, 'advanced_api_upstream_error', `${名}服务调用失败：${文本(error?.message || error)}`, { service: 服务 })
  }

  /** 在最近历史里找一条消息；必要时用 message_id 向前翻页。 */
  async 找消息(qq, messageId) {
    const 配置 = this.getConfig()
    const 目标 = 文本(messageId)
    if (!目标) throw new ApiError(400, 'bad_request', 'messageId 不能为空')
    const 页大小 = Math.max(10, Math.min(500, Math.round(数字(配置.historyCount, 100))))
    let 列表 = []
    let 锚 = ''
    const 看过 = new Set()
    for (let 页 = 0; 页 < 10; 页++) {
      try {
        列表 = await this.transport.fetchHistory(qq, { count: 页大小, ...(锚 ? { beforeMessageId: 锚 } : {}) })
      } catch (error) {
        throw new ApiError(502, 'onebot_error', `拉取 OneBot 历史失败：${文本(error?.message || error)}`)
      }
      if (!Array.isArray(列表) || !列表.length) break
      列表.sort((a, b) => 数字(a?.time) - 数字(b?.time))
      const 找到 = 列表.find((m) => 文本(m?.message_id) === 目标)
      if (找到) return 找到
      const 最早 = 列表[0]
      const 新锚 = 文本(最早?.message_id)
      if (!新锚 || 看过.has(新锚) || 列表.length < 页大小) break
      看过.add(新锚)
      锚 = 新锚
    }
    throw new ApiError(400, 'message_not_found', `最近历史里找不到消息 ${目标}`)
  }

  声音段(message) {
    const 段们 = Array.isArray(message?.message) ? message.message : []
    const 段 = 段们.find((x) => 文本(x?.type) === 'record')
    if (!段) throw new ApiError(400, 'no_audio_segment', `消息 ${文本(message?.message_id)} 里没有语音段`)
    return 段
  }

  async transcribe({ qq, path, messageId } = {}) {
    this.需要服务('asr')
    const 配置 = this.getConfig()
    let 号 = ''
    let 音频路径 = ''
    let 来源 = 'path'

    if (文本(path).trim()) {
      音频路径 = 要求文件(path, '音频')
      来源 = 'path'
    } else if (文本(messageId).trim()) {
      // 只有按 QQ 消息取音频时才需要 qq；纯本地文件转写不依赖绑定。
      号 = 解析QQ(qq, 配置)
      来源 = 'message'
      const 消息 = await this.找消息(号, messageId)
      const 段 = this.声音段(消息)
      try {
        const 文件 = await this.voice.recordToFile(段, 文本(messageId))
        音频路径 = 文件.wavPath || 文件.rawPath
      } catch (error) {
        throw new ApiError(502, 'audio_fetch_failed', `从消息取音频失败：${文本(error?.message || error)}`, { service: 'onebot' })
      }
    } else {
      throw new ApiError(400, 'bad_request', '需要 path（本地音频）或 messageId（QQ 语音消息）')
    }

    const 开始 = Date.now()
    let 结果
    try {
      结果 = await this.voice.transcribeFile(音频路径)
    } catch (error) {
      throw this.上游错误('asr', error)
    }
    const 毫秒 = Date.now() - 开始
    const 声纹 = { name: 结果.speakerName || '', known: Boolean(结果.speakerKnown) }
    return {
      status: 200,
      body: {
        ok: true,
        text: 结果.text,
        speaker: 声纹,
        speakerName: 声纹.name,
        engine: 结果.engine || 'local-asr',
        ms: 毫秒,
        audioPath: 音频路径,
        source: 来源,
        ...(来源 === 'message' ? { messageId: 文本(messageId) } : {}),
      },
    }
  }

  async synthesize({ text, voice } = {}) {
    this.需要服务('tts')
    const 正文 = 文本(text)
    if (!正文.trim()) throw new ApiError(400, 'bad_request', 'text 不能为空')
    if (正文.length > 5000) throw new ApiError(400, 'bad_request', 'text 超过 5000 字（TTS 上限）')
    const 音色 = 文本(voice).trim() || this.getConfig()?.ttsVoice || ''
    const 开始 = Date.now()
    let 路径
    try {
      路径 = await this.voice.synthesize(正文, { voice: 音色, ignoreSwitch: true })
    } catch (error) {
      throw this.上游错误('tts', error)
    }
    return {
      status: 200,
      body: { ok: true, path: 路径, ms: Date.now() - 开始, voice: 音色 },
    }
  }

  async voiceReply({ qq, text, voice } = {}) {
    this.需要服务('tts')
    const 配置 = this.getConfig()
    const 号 = 解析QQ(qq, 配置)
    const 合成 = await this.synthesize({ text, voice })
    const 音色 = 合成.body.voice
    let 结果
    try {
      结果 = await this.bridge.sendVoiceOutbound(号, {
        text: 文本(text),
        voice: 音色,
        path: 合成.body.path,
      }, { reason: 'api:voice-reply' })
    } catch (error) {
      throw new ApiError(502, 'send_failed', `语音发送失败且入队失败：${文本(error?.message || error)}`)
    }
    return {
      status: 结果?.queued ? 202 : 200,
      body: {
        ok: true,
        qq: 号,
        sent: Boolean(结果?.sent),
        queued: Boolean(结果?.queued),
        id: 结果?.id || null,
        pending: 数字(结果?.pending, this.bridge.outbox?.pending?.() || 0),
        persisted: 结果?.persisted !== false,
        path: 合成.body.path,
        ms: 合成.body.ms,
        voice: 音色,
      },
    }
  }

  async voiceAnalyze({ qq, messageId } = {}) {
    this.需要服务('asr')
    const 目标 = 文本(messageId).trim()
    if (!目标) throw new ApiError(400, 'bad_request', 'voice-analyze 需要 messageId（QQ 语音消息 id）')
    const 转写 = await this.transcribe({ qq, messageId: 目标 })
    return {
      status: 200,
      body: {
        ...转写.body,
        messageId: 目标,
        source: 'message',
      },
    }
  }
}
