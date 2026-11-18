// dsh-fish-message · fish.message Cordis 服务（很薄的一层门面）
//
// 目的：别的插件不需要知道对端怎么映射、出站队列怎么补发、
// 历史怎么翻页，只要 ctx.get('fish.message') 拿一个稳定 API。
//
// 原则：
//   - 这里**不重新实现**任何逻辑：发送交回 Bridge（它已经有直发 + 出站队列 + 去重），
//     历史交给 Transport，语音落盘交给 VoiceService；
//   - 失败给结构化错误（FishMessageError，code 以 fish_message_ 开头），
//     不发裸字符串；与 fish-service 的 FishServiceError 风格保持一致；
//   - 不返回 base64、不返回令牌；getConfig() 只给脱敏后的只读配置；
//   - 服务实例只在本插件生命周期内有效，卸载时由 ctx.effect 自动注销。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { basename, isAbsolute } from 'node:path'
import { publicConfig } from './config.js'
import { hashBuffer } from './image-library.js'
import {
  DEFAULT_CHANNEL,
  channelLabel,
  isInboundMessage,
  normalizePeer,
  parseChannel,
  peerProblem,
} from './peer.js'

/** 契约版本：0.x 允许小版本破坏，调用方必须在 requires 里写清楚。 */
export const serviceVersion = '0.1'

/** 结构化错误：code 给程序判断，hint 给人看，detail 只用于诊断。 */
export class FishMessageError extends Error {
  constructor(code, { hint = '', detail = '', cause } = {}) {
    const errorCode = String(code || 'fish_message_error')
    super(detail || hint || errorCode)
    this.name = 'FishMessageError'
    this.code = errorCode
    this.hint = String(hint || '')
    this.detail = String(detail || '')
    if (cause !== undefined) this.cause = cause
  }

  /** 转成工具层使用的失败包（与 fish-service 的 toPublicError 同形状）。 */
  toPublic() {
    const thePackage = {
      ok: false,
      error: { code: this.code, hint: this.hint },
    }
    if (this.detail) thePackage.error.detail = this.detail
    return thePackage
  }
}

/**
 * 参数里的通道 + 对端：channel 缺省 qq。
 *
 * 报错文案按通道走：微信对端是 wxid / openid（带字母、@、下划线），
 * 照搬「必须是纯数字 QQ 渠道号」的说法只会让人更困惑。
 */
function resolveTarget(qqInput, channelInput) {
  const channel = parseChannel(channelInput)
  if (!channel) {
    throw new FishMessageError('fish_message_bad_request', {
      hint: '参数不对：channel 只能是 qq 或 wechat。',
      detail: `channel=${JSON.stringify(channelInput)}`,
    })
  }
  const peer = normalizePeer(channel, qqInput)
  const problem = peerProblem(channel, peer)
  if (problem) {
    throw new FishMessageError('fish_message_bad_request', {
      hint: `参数不对：${problem}`,
      detail: `channel=${channel} qq=${JSON.stringify(qqInput)}`,
    })
  }
  return { channel, peer }
}

const getBody = (text) => {
  const str = String(text == null ? '' : text).trim()
  if (!str) {
    throw new FishMessageError('fish_message_bad_request', { hint: '参数不对：文字不能为空。' })
  }
  if (str.length > 5000) {
    throw new FishMessageError('fish_message_bad_request', {
      hint: '参数不对：单条文字最多 5000 字，请分段。',
      detail: `length=${str.length}`,
    })
  }
  return str
}

const checkLocalFile = (path, field = '文件') => {
  const value = String(path == null ? '' : path).trim()
  if (!value) {
    throw new FishMessageError('fish_message_bad_request', { hint: `参数不对：${field}路径不能为空。` })
  }
  if (!isAbsolute(value)) {
    throw new FishMessageError('fish_message_bad_request', {
      hint: `参数不对：${field}要给本机绝对路径。`,
      detail: `path=${value}`,
    })
  }
  if (!existsSync(value)) {
    throw new FishMessageError('fish_message_bad_request', {
      hint: `参数不对：找不到${field}。`,
      detail: `path=${value}`,
    })
  }
  let info
  try {
    info = statSync(value)
  } catch (error) {
    throw new FishMessageError('fish_message_bad_request', {
      hint: `参数不对：${field}读不到。`,
      detail: String(error?.message || error),
    })
  }
  if (!info.isFile()) {
    throw new FishMessageError('fish_message_bad_request', {
      hint: `参数不对：${field}必须是文件。`,
      detail: `path=${value}`,
    })
  }
  return value
}

const toInteger = (value, fallback, min, max) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

const findVoiceSegment = (message) => {
  const segments = Array.isArray(message?.message) ? message.message : []
  return segments.find((segment) => segment && String(segment.type || '') === 'record') || null
}

const shorten = (str, longest = 120) => {
  const value = String(str == null ? '' : str).replace(/\s+/g, ' ').trim()
  return value.length > longest ? `${value.slice(0, longest)}…` : value
}

/**
 * 造 fish.message 服务实例。
 *
 * @param {object} options
 * @param {object} options.bridge   已经启动/可启动的 Bridge 实例（发送与队列的唯一入口）
 * @param {object} options.transport NapCat/OneBot 传输层（拉历史）
 * @param {object} options.voice     VoiceService（语音消息落盘）
 * @param {object} [options.stickers] StickerStore（表情库；不传则表情方法给明确不可用错误）
 * @param {object} [options.images] ImageLibrary（收图图库；不传则图库方法给明确不可用错误）
 * @param {object} [options.ai] AiService（图库的 describe 要识图；不传则只读缓存）
 * @param {() => object} options.getConfig 读当前运行配置（宿主里是闭包）
 * @param {EventEmitter} [options.events] 与 Bridge 共用的事件发射器
 * @param {object} [options.logger]
 */
export function createFishMessageApi({ bridge, transport, voice, stickers, images, ai, getConfig, events, logger } = {}) {
  if (typeof getConfig !== 'function') {
    throw new FishMessageError('fish_message_bad_request', { hint: '内部错误：创建 fish.message 时缺少 getConfig。' })
  }
  const emitter = events instanceof EventEmitter ? events : new EventEmitter()

  /** 统一把 Bridge 抛出来的普通错误转成结构化错误。 */
  function toError(error, scenario) {
    if (error instanceof FishMessageError) return error
    const detail = String(error?.message || error || '未知错误')
    return new FishMessageError('fish_message_send_failed', {
      hint: `${scenario}失败：${shorten(detail, 200)}`,
      detail: detail,
      cause: error,
    })
  }

  /** 调 Bridge 上的方法；Bridge 不存在/没这个方法时给明确错误。 */
  async function callBridge(method, ...params) {
    if (!bridge || typeof bridge[method] !== 'function') {
      throw new FishMessageError('fish_message_unavailable', {
        hint: '消息桥还没准备好（Bridge 未初始化），稍后再试。',
        detail: `bridge.${method} 不可用`,
      })
    }
    try {
      return await bridge[method](...params)
    } catch (error) {
      throw toError(error, '发送')
    }
  }

  /** 发送结果统一成 {ok, sent, queued, pending, id?}；queue 后仍然 ok:true。 */
  function normalizeSend(result) {
    const out = {
      ok: result?.ok !== false,
      sent: Boolean(result?.sent),
      queued: Boolean(result?.queued),
      pending: Number(result?.pending) || 0,
    }
    if (result?.id) out.id = String(result.id)
    if (result?.deduped) out.deduped = true
    // 直发失败但已入队时 Bridge 会带 error；保留给调用方诊断，不影响 ok。
    if (result?.error) out.error = String(result.error)
    return out
  }

  async function sendSegment(qq, segment, reason, channel = DEFAULT_CHANNEL) {
    const target = resolveTarget(qq, channel)
    const r = await callBridge('sendOutbound', target.peer, [segment], { reason: reason, channel: target.channel })
    return normalizeSend(r)
  }

  /** 表情库没准备好 / 操作失败 → 结构化错误，不抛裸异常。 */
  function requireStickerStore() {
    if (!stickers || typeof stickers.list !== 'function') {
      throw new FishMessageError('fish_message_unavailable', {
        hint: '表情库还没准备好（StickerStore 未初始化），稍后再试。',
        detail: 'stickers 不可用',
      })
    }
    return stickers
  }

  function toStickerError(error) {
    if (error instanceof FishMessageError) return error
    const originalCode = String(error?.code || '')
    const errorCode = originalCode === 'sticker_not_found'
      ? 'fish_message_sticker_not_found'
      : (originalCode === 'sticker_limit' ? 'fish_message_sticker_limit' : 'fish_message_sticker_failed')
    return new FishMessageError(errorCode, {
      hint: String(error?.hint || error?.message || '表情库操作失败'),
      detail: String(error?.detail || error?.message || ''),
      cause: error,
    })
  }

  async function stickerOp(scenario, fn) {
    try {
      return await fn(requireStickerStore())
    } catch (error) {
      throw toStickerError(error)
    }
  }

  /** 图库没准备好 / 操作失败 → 结构化错误。 */
  function requireImageLibrary() {
    if (!images || typeof images.lookup !== 'function') {
      throw new FishMessageError('fish_message_unavailable', {
        hint: '收图图库还没准备好（ImageLibrary 未初始化），稍后再试。',
        detail: 'images 不可用',
      })
    }
    return images
  }

  function toImageError(error) {
    if (error instanceof FishMessageError) return error
    const originalCode = String(error?.code || '')
    const errorCode = originalCode === 'image_library_io'
      ? 'fish_message_image_io'
      : (originalCode === 'image_library_bad_request' ? 'fish_message_bad_request' : 'fish_message_image_failed')
    return new FishMessageError(errorCode, {
      hint: String(error?.hint || error?.message || '图库操作失败'),
      detail: String(error?.detail || error?.message || ''),
      cause: error,
    })
  }

  async function imageOp(fn) {
    try {
      return await fn(requireImageLibrary())
    } catch (error) {
      throw toImageError(error)
    }
  }

  /** 读本机图片字节（图库的 describe/remember 都要算指纹、存原图）。 */
  function readImageBytes(path) {
    const file = checkLocalFile(path, '图片')
    try {
      return { file, buffer: readFileSync(file) }
    } catch (error) {
      throw new FishMessageError('fish_message_bad_request', {
        hint: '参数不对：图片读不到（可能被占用或没有权限）。',
        detail: String(error?.message || error),
      })
    }
  }

  const api = {
    apiVersion: serviceVersion,

    /** 能力声明：转写不在这个插件里（fish-service 负责），所以是 false。 */
    capabilities() {
      return {
        sendText: true,
        sendImage: true,
        sendRecord: true,
        sendRecordFile: true,
        sendFile: true,
        fetchHistory: true,
        stickers: true,
        images: true,
        transcribe: { text: false },
      }
    },

    /**
     * 表情库门面（供 ops / 其它插件用）：
     *   list({q, tag, limit, offset})  只读列表
     *   save(path 或 Buffer, {tags, desc, source, name})  入库（按 sha256 去重）
     *   get(name)                      名字/标签/id → 条目
     *   send(qq, name)                 发一张表情（走 Bridge 的直发 + 出站队列），返回实际发出的条目 id/file
     * 所有方法都不返回 base64。
     */
    stickers: {
      async list(options = {}) {
        return stickerOp('列表', (store) => {
          const r = store.list(options || {})
          return { ok: true, ...r }
        })
      },

      async save(pathOrBuffer, options = {}) {
        const input = Buffer.isBuffer(pathOrBuffer)
          ? pathOrBuffer
          : checkLocalFile(pathOrBuffer, '图片')
        return stickerOp('入库', (store) => {
          const r = store.save(input, options || {})
          return { ok: true, ...r }
        })
      },

      async get(name) {
        return stickerOp('查询', (store) => store.resolve(name))
      },

      async send(qq, name, { channel = DEFAULT_CHANNEL } = {}) {
        const target = resolveTarget(qq, channel)
        const entry = await stickerOp('发送', (store) => store.resolve(name))
        const result = await sendSegment(target.peer, { type: 'image', data: { path: entry.path, stickerId: entry.id } }, 'fish.message:sticker', target.channel)
        // 按标签/模糊匹配时每次解析可能轮到不同表情；调用方需要知道这一张到底是哪个。
        return { ...result, sticker: { id: entry.id, file: entry.file } }
      },
    },

    /**
     * 收图图库门面（供别的插件按需取用，例如以后记忆插件缓存在自己库里的用户照片）：
     *   lookup(指纹)                 只读；64 位完整指纹或 8 位以上前缀，找不到返回 entry:null
     *   describe(path)               查库 →（没有描述才）识图 → 写库，一条龙
     *   remember(input, {desc,...})  手动写一条（path 或 Buffer）
     *   stats() / clear()            统计 / 清空
     * 命中缓存不返回原图字节；要原图请用条目的 path（或在工具里取图片附件）。
     */
    images: {
      async lookup(sha256) {
        const key = String(sha256 == null ? '' : sha256).trim().toLowerCase()
        if (!/^[0-9a-f]{8,64}$/.test(key)) {
          throw new FishMessageError('fish_message_bad_request', {
            hint: '参数不对：sha256 要给 8~64 位十六进制（图库条目指纹或它的前缀）。',
            detail: `sha256=${JSON.stringify(sha256)}`,
          })
        }
        return imageOp((library) => {
          const entry = library.lookup(key)
          return { ok: true, entry: entry || null }
        })
      },

      async describe(path, options = {}) {
        const { file, buffer } = readImageBytes(path)
        const prompt = String(options?.prompt || '').trim()
        const refresh = options?.refresh === true
        return imageOp(async (library) => {
          const sha256 = hashBuffer(buffer)
          const existing = library.lookup(sha256)
          if (existing && existing.desc && !refresh) {
            return { ok: true, cached: true, source: 'cache', entry: existing }
          }
          if (!ai || typeof ai.describeImage !== 'function') {
            throw new FishMessageError('fish_message_unavailable', {
              hint: '本地 AI 插件没装或没启动，认不出这张图；图库只读缓存照常可用。',
              detail: 'ai.describeImage 不可用',
            })
          }
          const described = await ai.describeImage(file, { mode: 'caption', prompt })
          if (!described?.ok || !String(described.text || '').trim()) {
            throw new FishMessageError('fish_message_vision_failed', {
              hint: String(described?.hint || '这次没能识图，稍后再试。'),
              detail: String(described?.code || ''),
            })
          }
          const entry = library.remember({
            sha256,
            buffer,
            path: file,
            desc: String(described.text).trim(),
            descSource: 'local',
          })
          return { ok: true, cached: false, source: 'local', entry }
        })
      },

      async remember(input, options = {}) {
        const { file, buffer } = readImageBytes(input)
        const desc = String(options?.desc == null ? '' : options.desc).trim()
        return imageOp((library) => {
          const sha256 = hashBuffer(buffer)
          const before = library.lookup(sha256)
          const entry = library.remember({
            sha256,
            buffer,
            path: file,
            desc,
            descSource: String(options?.descSource || 'manual'),
            force: options?.force === true,
          })
          return { ok: true, created: !before, updated: Boolean(before), entry }
        })
      },

      /**
       * 只改描述（条目必须已存在）：工具回填描述用，避免为了改一句话重读原图。
       * @returns {{ok:boolean, entry:object|null, replaced:boolean, previousDesc:string}}
       */
      async setDesc(sha256, desc, options = {}) {
        const key = String(sha256 == null ? '' : sha256).trim().toLowerCase()
        if (!/^[0-9a-f]{8,64}$/.test(key)) {
          throw new FishMessageError('fish_message_bad_request', {
            hint: '参数不对：sha256 要给 8~64 位十六进制。',
            detail: `sha256=${JSON.stringify(sha256)}`,
          })
        }
        return imageOp((library) => {
          const before = library.lookup(key)
          if (!before) {
            throw new FishMessageError('fish_message_image_not_found', {
              hint: `图库里没有指纹 ${key} 对应的图。`,
              detail: `sha256=${key}`,
            })
          }
          const previousDesc = String(before.desc || '')
          const entry = library.setDesc(before.sha256, desc, { descSource: String(options?.descSource || 'manual') })
          return {
            ok: true,
            entry: entry || null,
            replaced: Boolean(previousDesc) && previousDesc !== String(desc == null ? '' : desc).trim(),
            previousDesc,
          }
        })
      },

      async stats() {
        return imageOp((library) => ({ ok: true, ...library.stats() }))
      },

      async clear() {
        return imageOp((library) => ({ ok: true, ...library.clear() }))
      },
    },

    /** 发文字。失败自动进持久化出站队列，返回 queued:true。channel 缺省 qq。 */
    async sendText(qq, text, { channel = DEFAULT_CHANNEL } = {}) {
      const target = resolveTarget(qq, channel)
      const str = getBody(text)
      return normalizeSend(await callBridge('sendText', target.peer, str, { channel: target.channel }))
    },

    /** 发图片：path 必须是本机存在的文件。 */
    async sendImage(qq, path, { channel = DEFAULT_CHANNEL } = {}) {
      const image = checkLocalFile(path, '图片')
      return sendSegment(qq, { type: 'image', data: { path: image } }, 'fish.message:image', channel)
    },

    /** 发语音：path 必须是本机存在的音频文件（转码由 NapCat/服务端负责）。 */
    async sendRecord(qq, path, { channel = DEFAULT_CHANNEL } = {}) {
      const audio = checkLocalFile(path, '语音')
      return sendSegment(qq, { type: 'record', data: { path: audio } }, 'fish.message:record', channel)
    },

    /**
     * sendRecord 的等价别名（语义更明确：发的是「已有音频文件」，不是合成结果）。
     * 合成语音请在消息里写 [语音]文字[/语音]，由桥层调用可选的本地 AI 完成。
     */
    async sendRecordFile(qq, path, options = {}) {
      return api.sendRecord(qq, path, options)
    },

    /** 发文件：name 省略时用文件名。 */
    async sendFile(qq, path, name = '', { channel = DEFAULT_CHANNEL } = {}) {
      const filePath = checkLocalFile(path, '文件')
      const fileName = String(name || '').trim() || basename(filePath)
      return sendSegment(qq, { type: 'file', data: { path: filePath, name: fileName } }, 'fish.message:file', channel)
    },

    /**
     * 拉某个私聊的历史消息（OneBot 原始消息对象数组）。
     * 只读；count 1~100，默认 20。分页用 beforeMessageId。
     */
    async fetchHistory(qq, opts = {}) {
      const target = resolveTarget(qq, opts?.channel)
      if (!transport || typeof transport.fetchHistory !== 'function') {
        throw new FishMessageError('fish_message_unavailable', {
          hint: '传输层还没准备好，暂时拉不了历史。',
          detail: 'transport.fetchHistory 不可用',
        })
      }
      const count = toInteger(opts?.count, 20, 1, 100)
      const params = { count }
      if (opts?.beforeMessageId !== undefined && opts?.beforeMessageId !== null && opts.beforeMessageId !== '') {
        params.beforeMessageId = String(opts.beforeMessageId)
      }
      try {
        const list = await transport.fetchHistory(target.peer, params)
        return Array.isArray(list) ? list.slice(0, count) : []
      } catch (error) {
        const detail = String(error?.message || error || '未知错误')
        throw new FishMessageError('fish_message_upstream_error', {
          hint: `拉取 ${channelLabel(target.channel)} 历史失败：${shorten(detail, 200)}`,
          detail: detail,
          cause: error,
        })
      }
    },

    /**
     * 取某个私聊里最近一条（或指定 messageId 的）语音消息，落到本机 wav。
     *
     * 说明：历史接口只按「最近 N 条」翻页，所以指定 messageId 时它必须在这 N 条里；
     * 找不到会给 fish_message_message_not_found，而不是悄悄换一条。
     *
     * @returns {Promise<{ok:boolean, filePath:string, rawPath?:string, messageId:string, time?:number, sender?:object}>}
     */
    async latestVoice(qq, opts = {}) {
      const who = resolveTarget(qq, opts?.channel)
      const count = toInteger(opts?.count, 50, 1, 100)
      const wantedId = opts?.messageId === undefined || opts?.messageId === null ? '' : String(opts.messageId).trim()
      const list = await api.fetchHistory(who.peer, { count, channel: who.channel })
      const inbound = list.filter((m) => isInboundMessage(m, who.channel, who.peer))

      let target = null
      if (wantedId) {
        target = inbound.find((m) => String(m?.message_id ?? '') === wantedId) || null
        if (!target) {
          throw new FishMessageError('fish_message_message_not_found', {
            hint: `最近 ${count} 条消息里没有 id=${wantedId} 的那条；把 count 调大或改用 filePath。`,
            detail: `messageId=${wantedId}`,
          })
        }
        if (!findVoiceSegment(target)) {
          throw new FishMessageError('fish_message_no_voice', {
            hint: '这条消息不是语音消息。',
            detail: `messageId=${wantedId}`,
          })
        }
      } else {
        const hasVoice = inbound.filter((m) => findVoiceSegment(m))
        if (!hasVoice.length) {
          throw new FishMessageError('fish_message_no_voice', {
            hint: `这个聊天最近 ${count} 条消息里没有语音。`,
            detail: `channel=${who.channel} qq=${who.peer}`,
          })
        }
        // 历史不保证顺序：按时间取最新；时间缺失时按数组靠后算。
        target = hasVoice.reduce((best, m) => {
          const hour = Number(m?.time) || 0
          const atBest = Number(best?.time) || 0
          return hour >= atBest ? m : best
        }, hasVoice[0])
      }

      if (!voice || typeof voice.recordToFile !== 'function') {
        throw new FishMessageError('fish_message_unavailable', {
          hint: '语音落盘模块还没准备好，暂时取不了语音文件。',
          detail: 'voice.recordToFile 不可用',
        })
      }

      const messageId = String(target?.message_id ?? '')
      let filePath
      try {
        filePath = await voice.recordToFile(findVoiceSegment(target), messageId)
      } catch (error) {
        const detail = String(error?.message || error || '未知错误')
        throw new FishMessageError('fish_message_voice_download_failed', {
          hint: `语音下载/转码失败：${shorten(detail, 200)}`,
          detail: detail,
          cause: error,
        })
      }

      const path = String(filePath?.wavPath || filePath?.rawPath || '')
      if (!path) {
        throw new FishMessageError('fish_message_voice_download_failed', {
          hint: '语音下载完成但没拿到本地文件路径。',
          detail: `messageId=${messageId}`,
        })
      }

      return {
        ok: true,
        filePath: path,
        ...(filePath?.rawPath && filePath.rawPath !== path ? { rawPath: String(filePath.rawPath) } : {}),
        messageId: messageId,
        ...(Number(target?.time) ? { time: Number(target.time) } : {}),
        ...(target?.sender && typeof target.sender === 'object'
          ? { sender: { ...(target.sender.user_id ? { qq: String(target.sender.user_id) } : {}), ...(target.sender.nickname ? { name: String(target.sender.nickname) } : {}) } }
          : {}),
      }
    },

    /** 通道 + 对端 → DSH 会话 的只读绑定表。 */
    bindings() {
      return (getConfig().bindings || []).map((b) => ({
        channel: String(b.channel || DEFAULT_CHANNEL),
        qq: String(b.qq),
        session: String(b.session),
        name: String(b.name || ''),
      }))
    },

    /** 只读公开配置：napcatToken 已打码，不含任何内部对象。 */
    getConfig() {
      return publicConfig(getConfig())
    },

    /** 事件：received / sent / outbox-flushed（由 Bridge 发，见 lib/bridge.js）。 */
    events: emitter,

    /** 诊断用：服务自身是否可发送（不触发网络）。 */
    health() {
      return {
        ok: Boolean(bridge && typeof bridge.sendText === 'function'),
        apiVersion: serviceVersion,
        bridgeRunning: Boolean(bridge?.running),
        bindings: (getConfig().bindings || []).length,
        pending: Number(bridge?.outbox?.pending?.() || 0),
      }
    },
  }

  logger?.debug?.(`fish.message 服务已创建（apiVersion ${serviceVersion}）`)
  return api
}

/**
 * 在宿主上注册 fish.message；卸载时自动注销。
 * 用 ctx.effect 包一层，兼容「宿主没有 effect」的极简测试环境。
 */
export function registerMessageService(ctx, api, logger = null) {
  if (!ctx || typeof ctx.provide !== 'function') {
    logger?.warn?.('宿主没有 ctx.provide，跳过 fish.message 服务注册（消息桥本身照常工作）')
    return () => {}
  }
  const provide = () => {
    const detach = ctx.provide('fish.message', api)
    return typeof detach === 'function' ? detach : () => {}
  }
  if (typeof ctx.effect === 'function') {
    return ctx.effect(provide, 'fish-message: 提供 fish.message 服务')
  }
  return provide()
}
