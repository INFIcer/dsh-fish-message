// dsh-fish-message · fish.message Cordis 服务（很薄的一层门面）
//
// 目的：别的插件（dsh-fish-ops 等）不需要知道 QQ 号怎么映射、出站队列怎么补发、
// 历史怎么翻页，只要 ctx.get('fish.message') 拿一个稳定 API。
//
// 原则：
//   - 这里**不重新实现**任何逻辑：发送交回 Bridge（它已经有直发 + 出站队列 + 去重），
//     历史交给 Transport，语音落盘交给 VoiceService；
//   - 失败给结构化错误（FishMessageError，code 以 fish_message_ 开头），
//     不发裸字符串；与 fish-service 的 FishServiceError 风格保持一致；
//   - 不返回 base64、不返回令牌；getConfig() 只给脱敏后的只读配置；
//   - 服务实例只在本插件生命周期内有效，卸载时由 ctx.effect 自动注销。

import { existsSync, statSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { basename, isAbsolute } from 'node:path'
import { publicConfig } from './config.js'

/** 契约版本：0.x 允许小版本破坏，调用方必须在 requires 里写清楚。 */
export const 服务版本 = '0.1'

/** 结构化错误：code 给程序判断，hint 给人看，detail 只用于诊断。 */
export class FishMessageError extends Error {
  constructor(code, { hint = '', detail = '', cause } = {}) {
    const 码 = String(code || 'fish_message_error')
    super(detail || hint || 码)
    this.name = 'FishMessageError'
    this.code = 码
    this.hint = String(hint || '')
    this.detail = String(detail || '')
    if (cause !== undefined) this.cause = cause
  }

  /** 转成工具层使用的失败包（与 fish-service 的 toPublicError 同形状）。 */
  toPublic() {
    const 包 = {
      ok: false,
      error: { code: this.code, hint: this.hint },
    }
    if (this.detail) 包.error.detail = this.detail
    return 包
  }
}

const 规整QQ = (qq) => {
  const 号 = String(qq == null ? '' : qq).replace(/[^\d]/g, '')
  if (!号) {
    throw new FishMessageError('fish_message_bad_request', {
      hint: '参数不对：qq 必须是对方的 QQ 号（纯数字）。',
      detail: `qq=${JSON.stringify(qq)}`,
    })
  }
  return 号
}

const 取正文 = (text) => {
  const 文 = String(text == null ? '' : text).trim()
  if (!文) {
    throw new FishMessageError('fish_message_bad_request', { hint: '参数不对：文字不能为空。' })
  }
  if (文.length > 5000) {
    throw new FishMessageError('fish_message_bad_request', {
      hint: '参数不对：单条文字最多 5000 字，请分段。',
      detail: `length=${文.length}`,
    })
  }
  return 文
}

const 检查本机文件 = (path, 字段 = '文件') => {
  const 值 = String(path == null ? '' : path).trim()
  if (!值) {
    throw new FishMessageError('fish_message_bad_request', { hint: `参数不对：${字段}路径不能为空。` })
  }
  if (!isAbsolute(值)) {
    throw new FishMessageError('fish_message_bad_request', {
      hint: `参数不对：${字段}要给本机绝对路径。`,
      detail: `path=${值}`,
    })
  }
  if (!existsSync(值)) {
    throw new FishMessageError('fish_message_bad_request', {
      hint: `参数不对：找不到${字段}。`,
      detail: `path=${值}`,
    })
  }
  let 信息
  try {
    信息 = statSync(值)
  } catch (error) {
    throw new FishMessageError('fish_message_bad_request', {
      hint: `参数不对：${字段}读不到。`,
      detail: String(error?.message || error),
    })
  }
  if (!信息.isFile()) {
    throw new FishMessageError('fish_message_bad_request', {
      hint: `参数不对：${字段}必须是文件。`,
      detail: `path=${值}`,
    })
  }
  return 值
}

const 取整数 = (值, 兜底, 最小, 最大) => {
  const n = Number(值)
  if (!Number.isFinite(n)) return 兜底
  return Math.max(最小, Math.min(最大, Math.trunc(n)))
}

const 同号 = (a, b) => String(a ?? '').replace(/[^\d]/g, '') === String(b ?? '').replace(/[^\d]/g, '')

const 是入站 = (message, qq) => {
  if (!message || typeof message !== 'object') return false
  if (message.message_type && message.message_type !== 'private') return false
  if (!同号(message.user_id, qq)) return false
  if (message.self_id && 同号(message.self_id, message.user_id)) return false
  return true
}

const 找语音段 = (message) => {
  const 段们 = Array.isArray(message?.message) ? message.message : []
  return 段们.find((段) => 段 && String(段.type || '') === 'record') || null
}

const 拍短 = (文, 最长 = 120) => {
  const 值 = String(文 == null ? '' : 文).replace(/\s+/g, ' ').trim()
  return 值.length > 最长 ? `${值.slice(0, 最长)}…` : 值
}

/**
 * 造 fish.message 服务实例。
 *
 * @param {object} options
 * @param {object} options.bridge   已经启动/可启动的 Bridge 实例（发送与队列的唯一入口）
 * @param {object} options.transport NapCat/OneBot 传输层（拉历史）
 * @param {object} options.voice     VoiceService（语音消息落盘）
 * @param {object} [options.stickers] StickerStore（表情库；不传则表情方法给明确不可用错误）
 * @param {() => object} options.getConfig 读当前运行配置（宿主里是闭包）
 * @param {EventEmitter} [options.events] 与 Bridge 共用的事件发射器
 * @param {object} [options.logger]
 */
export function createFishMessageApi({ bridge, transport, voice, stickers, getConfig, events, logger } = {}) {
  if (typeof getConfig !== 'function') {
    throw new FishMessageError('fish_message_bad_request', { hint: '内部错误：创建 fish.message 时缺少 getConfig。' })
  }
  const 发射器 = events instanceof EventEmitter ? events : new EventEmitter()

  /** 统一把 Bridge 抛出来的普通错误转成结构化错误。 */
  function 转错误(error, 场景) {
    if (error instanceof FishMessageError) return error
    const 详情 = String(error?.message || error || '未知错误')
    return new FishMessageError('fish_message_send_failed', {
      hint: `${场景}失败：${拍短(详情, 200)}`,
      detail: 详情,
      cause: error,
    })
  }

  /** 调 Bridge 上的方法；Bridge 不存在/没这个方法时给明确错误。 */
  async function 调桥(方法, ...参数) {
    if (!bridge || typeof bridge[方法] !== 'function') {
      throw new FishMessageError('fish_message_unavailable', {
        hint: 'QQ 桥还没准备好（Bridge 未初始化），稍后再试。',
        detail: `bridge.${方法} 不可用`,
      })
    }
    try {
      return await bridge[方法](...参数)
    } catch (error) {
      throw 转错误(error, 'QQ 发送')
    }
  }

  /** 发送结果统一成 {ok, sent, queued, pending, id?}；queue 后仍然 ok:true。 */
  function 规整发送(结果) {
    const 出 = {
      ok: 结果?.ok !== false,
      sent: Boolean(结果?.sent),
      queued: Boolean(结果?.queued),
      pending: Number(结果?.pending) || 0,
    }
    if (结果?.id) 出.id = String(结果.id)
    if (结果?.deduped) 出.deduped = true
    // 直发失败但已入队时 Bridge 会带 error；保留给调用方诊断，不影响 ok。
    if (结果?.error) 出.error = String(结果.error)
    return 出
  }

  async function 发段(qq, 段, 原因) {
    const 号 = 规整QQ(qq)
    const r = await 调桥('sendOutbound', 号, [段], { reason: 原因 })
    return 规整发送(r)
  }

  /** 表情库没准备好 / 操作失败 → 结构化错误，不抛裸异常。 */
  function 要表情库() {
    if (!stickers || typeof stickers.list !== 'function') {
      throw new FishMessageError('fish_message_unavailable', {
        hint: '表情库还没准备好（StickerStore 未初始化），稍后再试。',
        detail: 'stickers 不可用',
      })
    }
    return stickers
  }

  function 转表情错误(error) {
    if (error instanceof FishMessageError) return error
    const 原码 = String(error?.code || '')
    const 码 = 原码 === 'sticker_not_found'
      ? 'fish_message_sticker_not_found'
      : (原码 === 'sticker_limit' ? 'fish_message_sticker_limit' : 'fish_message_sticker_failed')
    return new FishMessageError(码, {
      hint: String(error?.hint || error?.message || '表情库操作失败'),
      detail: String(error?.detail || error?.message || ''),
      cause: error,
    })
  }

  async function 表情操作(场景, fn) {
    try {
      return await fn(要表情库())
    } catch (error) {
      throw 转表情错误(error)
    }
  }

  const api = {
    apiVersion: 服务版本,

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
        transcribe: { text: false, speaker: false },
      }
    },

    /**
     * 表情库门面（供 ops / 其它插件用）：
     *   list({q, tag, limit, offset})  只读列表
     *   save(path, {tags, desc, source, name})  入库（按 sha256 去重）
     *   get(name)                      名字/标签/id → 条目
     *   send(qq, name)                 发一张表情（走 Bridge 的直发 + 出站队列）
     * 所有方法都不返回 base64。
     */
    stickers: {
      async list(选项 = {}) {
        return 表情操作('列表', (库) => {
          const r = 库.list(选项 || {})
          return { ok: true, ...r }
        })
      },

      async save(pathOrBuffer, 选项 = {}) {
        const 输入 = Buffer.isBuffer(pathOrBuffer)
          ? pathOrBuffer
          : 检查本机文件(pathOrBuffer, '图片')
        return 表情操作('入库', (库) => {
          const r = 库.save(输入, 选项 || {})
          return { ok: true, ...r }
        })
      },

      async get(name) {
        return 表情操作('查询', (库) => 库.resolve(name))
      },

      async send(qq, name) {
        const 号 = 规整QQ(qq)
        const 条目 = await 表情操作('发送', (库) => 库.resolve(name))
        return 发段(号, { type: 'image', data: { path: 条目.path, stickerId: 条目.id } }, 'fish.message:sticker')
      },
    },

    /** 发文字。失败自动进持久化出站队列，返回 queued:true。 */
    async sendText(qq, text) {
      const 号 = 规整QQ(qq)
      const 文 = 取正文(text)
      return 规整发送(await 调桥('sendText', 号, 文))
    },

    /** 发图片：path 必须是本机存在的文件。 */
    async sendImage(qq, path) {
      const 图 = 检查本机文件(path, '图片')
      return 发段(qq, { type: 'image', data: { path: 图 } }, 'fish.message:image')
    },

    /** 发语音：path 必须是本机存在的音频文件（转码由 NapCat/服务端负责）。 */
    async sendRecord(qq, path) {
      const 音 = 检查本机文件(path, '语音')
      return 发段(qq, { type: 'record', data: { path: 音 } }, 'fish.message:record')
    },

    /**
     * sendRecord 的等价别名（语义更明确：发的是「已有音频文件」，不是合成结果）。
     * 合成请找 dsh-fish-ops 的 fish_say_and_send / fish_voice_reply。
     */
    async sendRecordFile(qq, path) {
      return api.sendRecord(qq, path)
    },

    /** 发文件：name 省略时用文件名。 */
    async sendFile(qq, path, name = '') {
      const 文件 = 检查本机文件(path, '文件')
      const 名字 = String(name || '').trim() || basename(文件)
      return 发段(qq, { type: 'file', data: { path: 文件, name: 名字 } }, 'fish.message:file')
    },

    /**
     * 拉某个私聊的历史消息（OneBot 原始消息对象数组）。
     * 只读；count 1~100，默认 20。分页用 beforeMessageId。
     */
    async fetchHistory(qq, opts = {}) {
      const 号 = 规整QQ(qq)
      if (!transport || typeof transport.fetchHistory !== 'function') {
        throw new FishMessageError('fish_message_unavailable', {
          hint: '传输层还没准备好，暂时拉不了历史。',
          detail: 'transport.fetchHistory 不可用',
        })
      }
      const count = 取整数(opts?.count, 20, 1, 100)
      const 参数 = { count }
      if (opts?.beforeMessageId !== undefined && opts?.beforeMessageId !== null && opts.beforeMessageId !== '') {
        参数.beforeMessageId = String(opts.beforeMessageId)
      }
      try {
        const 列表 = await transport.fetchHistory(号, 参数)
        return Array.isArray(列表) ? 列表.slice(0, count) : []
      } catch (error) {
        const 详情 = String(error?.message || error || '未知错误')
        throw new FishMessageError('fish_message_upstream_error', {
          hint: `拉取 QQ 历史失败：${拍短(详情, 200)}`,
          detail: 详情,
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
      const 号 = 规整QQ(qq)
      const count = 取整数(opts?.count, 50, 1, 100)
      const 要的id = opts?.messageId === undefined || opts?.messageId === null ? '' : String(opts.messageId).trim()
      const 列表 = await api.fetchHistory(号, { count })
      const 入站 = 列表.filter((m) => 是入站(m, 号))

      let 目标 = null
      if (要的id) {
        目标 = 入站.find((m) => String(m?.message_id ?? '') === 要的id) || null
        if (!目标) {
          throw new FishMessageError('fish_message_message_not_found', {
            hint: `最近 ${count} 条消息里没有 id=${要的id} 的那条；把 count 调大或改用 filePath。`,
            detail: `messageId=${要的id}`,
          })
        }
        if (!找语音段(目标)) {
          throw new FishMessageError('fish_message_no_voice', {
            hint: '这条消息不是语音消息。',
            detail: `messageId=${要的id}`,
          })
        }
      } else {
        const 有语音 = 入站.filter((m) => 找语音段(m))
        if (!有语音.length) {
          throw new FishMessageError('fish_message_no_voice', {
            hint: `这个聊天最近 ${count} 条消息里没有语音。`,
            detail: `qq=${号}`,
          })
        }
        // 历史不保证顺序：按时间取最新；时间缺失时按数组靠后算。
        目标 = 有语音.reduce((最好, m) => {
          const 时 = Number(m?.time) || 0
          const 最好时 = Number(最好?.time) || 0
          return 时 >= 最好时 ? m : 最好
        }, 有语音[0])
      }

      if (!voice || typeof voice.recordToFile !== 'function') {
        throw new FishMessageError('fish_message_unavailable', {
          hint: '语音落盘模块还没准备好，暂时取不了语音文件。',
          detail: 'voice.recordToFile 不可用',
        })
      }

      const 消息id = String(目标?.message_id ?? '')
      let 文件
      try {
        文件 = await voice.recordToFile(找语音段(目标), 消息id)
      } catch (error) {
        const 详情 = String(error?.message || error || '未知错误')
        throw new FishMessageError('fish_message_voice_download_failed', {
          hint: `语音下载/转码失败：${拍短(详情, 200)}`,
          detail: 详情,
          cause: error,
        })
      }

      const 路径 = String(文件?.wavPath || 文件?.rawPath || '')
      if (!路径) {
        throw new FishMessageError('fish_message_voice_download_failed', {
          hint: '语音下载完成但没拿到本地文件路径。',
          detail: `messageId=${消息id}`,
        })
      }

      return {
        ok: true,
        filePath: 路径,
        ...(文件?.rawPath && 文件.rawPath !== 路径 ? { rawPath: String(文件.rawPath) } : {}),
        messageId: 消息id,
        ...(Number(目标?.time) ? { time: Number(目标.time) } : {}),
        ...(目标?.sender && typeof 目标.sender === 'object'
          ? { sender: { ...(目标.sender.user_id ? { qq: String(目标.sender.user_id) } : {}), ...(目标.sender.nickname ? { name: String(目标.sender.nickname) } : {}) } }
          : {}),
      }
    },

    /** QQ 号 → DSH 会话 的只读绑定表。 */
    bindings() {
      return (getConfig().bindings || []).map((b) => ({
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
    events: 发射器,

    /** 诊断用：服务自身是否可发送（不触发网络）。 */
    health() {
      return {
        ok: Boolean(bridge && typeof bridge.sendText === 'function'),
        apiVersion: 服务版本,
        bridgeRunning: Boolean(bridge?.running),
        bindings: (getConfig().bindings || []).length,
        pending: Number(bridge?.outbox?.pending?.() || 0),
      }
    },
  }

  logger?.debug?.(`fish.message 服务已创建（apiVersion ${服务版本}）`)
  return api
}

/**
 * 在宿主上注册 fish.message；卸载时自动注销。
 * 用 ctx.effect 包一层，兼容「宿主没有 effect」的极简测试环境。
 */
export function 注册消息服务(ctx, api, logger = null) {
  if (!ctx || typeof ctx.provide !== 'function') {
    logger?.warn?.('宿主没有 ctx.provide，跳过 fish.message 服务注册（QQ 桥本身照常工作）')
    return () => {}
  }
  const 提供 = () => {
    const 摘 = ctx.provide('fish.message', api)
    return typeof 摘 === 'function' ? 摘 : () => {}
  }
  if (typeof ctx.effect === 'function') {
    return ctx.effect(提供, 'fish-message: 提供 fish.message 服务')
  }
  return 提供()
}
