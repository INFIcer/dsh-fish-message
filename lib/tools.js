// 表情库的 Agent 工具：fish_sticker_list / fish_sticker_send / fish_sticker_save。
//
// 注册方式与 dsh-LocalAIService 的工具一致：ctx.tools.register(定义)，定义里带
// parameters（JSON Schema 子集）+ output.schema（字段写清楚）+ execute。
// 失败不抛裸异常，统一返回 { ok:false, code, hint, detail? }，方便 Agent 解释原因。
// 任何返回值都不含 base64。

import { readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { readPictureInfo, normalizeTags } from './stickers.js'
import { DEFAULT_CONFIG } from './config.js'
import { channelLabel, normalizeChannel, normalizePeer, parseChannel, peerProblem } from './peer.js'

const isText = (value) => typeof value === 'string'

function render(value) {
  try {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  } catch {
    return [{ type: 'text', text: String(value) }]
  }
}

export function outputSchema(properties = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', description: '是否成功' },
      code: { type: 'string', description: '失败时的错误码' },
      hint: { type: 'string', description: '可直接展示给人看的中文提示' },
      detail: { type: 'string', description: '诊断细节（不含敏感信息）' },
      ...properties,
    },
  }
}

/**
 * 统一包一个工具定义：失败不抛裸异常，统一成 {ok:false, code, hint}。
 * render 可选：默认把结构化返回值 JSON 化；需要返回图片等非文本内容时传自定义投影。
 */
export function makeTool({ name, description, parameters, output, execute, logger, render: renderValue }) {
  const safeExecute = async (args, exec) => {
    try {
      return await execute(args || {}, exec)
    } catch (error) {
      logger?.warn?.(`工具 ${name} 失败：${error?.code || ''} ${error?.message || error}`)
      return {
        ok: false,
        code: String(error?.code || 'sticker_error'),
        hint: String(error?.hint || error?.message || '表情库操作失败'),
        ...(error?.detail ? { detail: String(error.detail) } : {}),
      }
    }
  }
  return {
    name,
    description,
    parameters: parameters || { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: output || outputSchema(),
      render: typeof renderValue === 'function' ? renderValue : (_args, value) => render(value),
    },
    execute: safeExecute,
  }
}

/** 这条通道的第一条启用绑定；没有就返回空串。 */
function defaultPeer(channel, getConfig) {
  try {
    const binding = (getConfig?.()?.bindings || [])
      .filter((b) => b && b.enabled !== false && b.qq && normalizeChannel(b.channel) === channel)
    return binding.length ? String(binding[0].qq) : ''
  } catch {
    return ''
  }
}

/**
 * 解析对端：qq 保持老口径（5~12 位数字），微信只校验非空、长度与字符集。
 * 省略时退回这条通道的第一条启用绑定，避免工具调用方还要知道对端长什么样。
 */
function requirePeer(channel, value, getConfig) {
  const original = String(value == null ? '' : value).trim()
  if (!original) {
    const fallback = defaultPeer(channel, getConfig)
    if (!fallback) {
      throw Object.assign(new Error(`没有可用的 ${channel} 绑定`), {
        code: 'no_binding',
        hint: `没有可用的${channelLabel(channel)}绑定：先在「鱼讯」设置页加一条绑定，或给 qq 参数。`,
      })
    }
    return fallback
  }
  const peer = normalizePeer(channel, original)
  if (channel === 'qq' && (peer.length < 5 || peer.length > 12)) {
    throw Object.assign(new Error(`qq=${original}`), {
      code: 'bad_request',
      hint: '参数不对：qq 必须是 5~12 位数字。',
      detail: `qq=${original}`,
    })
  }
  const problem = peerProblem(channel, peer)
  if (problem) {
    throw Object.assign(new Error(`peer=${original}`), {
      code: 'bad_request',
      hint: `参数不对：${problem}`,
      detail: `peer=${original}`,
    })
  }
  return peer
}

function requireName(value) {
  const name = isText(value) ? value.trim() : (value == null ? '' : String(value).trim())
  if (!name) {
    throw Object.assign(new Error('name 为空'), {
      code: 'bad_request',
      hint: '参数不对：name 不能为空（表情名字 / #标签 / id）。',
    })
  }
  if (name.length > 120) {
    throw Object.assign(new Error('name 太长'), {
      code: 'bad_request',
      hint: '参数不对：name 最多 120 字。',
    })
  }
  return name
}

function requireInteger(value, fallback, min, max, field) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw Object.assign(new Error(`${field}=${value}`), {
      code: 'bad_request',
      hint: `参数不对：${field} 必须是 ${min}~${max} 的整数。`,
      detail: `${field}=${value}`,
    })
  }
  return n
}

/**
 * 表情条目的完整字段：必须与 lib/stickers.js 的 规整条目() / 装饰() 一致。
 * 工具输出按 additionalProperties:false 校验，少声明一个字段整次调用都会被拒；
 * frames / duration_s 只有 GIF 才有，所以不能写成必填。
 */
function stickerEntrySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '表情编号（12 位十六进制，取自 sha256 前 12 位）。' },
      file: { type: 'string', description: '相对表情库根目录的路径，如 gif/xxx.gif。' },
      type: { type: 'string', enum: ['gif', 'img'], description: 'gif=动图；img=静态图。' },
      sha256: { type: 'string', description: '图片内容的 sha256（入库去重就按它）。' },
      size_kb: { type: 'number', description: '文件大小（KB，四舍五入，最小 1）。' },
      width: { type: 'number', description: '像素宽。' },
      height: { type: 'number', description: '像素高。' },
      frames: { type: 'number', description: 'GIF 帧数；静态图没有这个字段。' },
      duration_s: { type: 'number', description: 'GIF 总时长（秒）；静态图没有这个字段。' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签列表。' },
      desc: { type: 'string', description: '描述，可能为空串。' },
      source: { type: 'string', description: '来源标记（agent / qq-inbox / qq-auto / upload 等），可能为空串。' },
      added_at: { type: 'string', description: '入库时间（本地时间 ISO 串，无毫秒）。' },
      used_count: { type: 'number', description: '被发送过多少次。' },
      last_used_at: { type: 'string', description: '最后一次发送时间；从没用过是空串。' },
      path: { type: 'string', description: '本机绝对路径（发送/取图用）。' },
    },
  }
}

/** 库统计：字段与 lib/stickers.js 的 stats() 一一对应。 */
function stickerStatsSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    description: '库容量与占用统计。',
    properties: {
      count: { type: 'number', description: '库里现有条数。' },
      maxCount: { type: 'number', description: '条数上限。' },
      totalBytes: { type: 'number', description: '占用字节数。' },
      sizeMB: { type: 'number', description: '占用 MB（保留一位小数）。' },
      maxMB: { type: 'number', description: '总容量上限（MB）。' },
      used: { type: 'number', description: '发送过的条数。' },
      unused: { type: 'number', description: '还没发过的条数。' },
      dir: { type: 'string', description: '表情库目录的绝对路径。' },
      indexPath: { type: 'string', description: '索引文件 index.json 的绝对路径。' },
    },
  }
}

/**
 * 单张图的大小上限（MB）：用独立的 stickerMaxFileMB，不借用表情库总容量 stickerMaxMB。
 * 先按文件大小 / Content-Length 挡一层，免得超大文件整读进内存；真正入库时库还会再查一次。
 */
function getSingleMaxMB(getConfig) {
  let configValue = DEFAULT_CONFIG.stickerMaxFileMB
  try {
    const n = Number(getConfig?.()?.stickerMaxFileMB)
    if (Number.isFinite(n) && n > 0) configValue = n
  } catch { /* 配置读不到就用默认 */ }
  return configValue
}

/** 入库文件名：只收文件名，拒绝目录与空串；不传返回空串。 */
function requireFileName(value) {
  if (value === undefined || value === null || value === '') return ''
  if (!isText(value)) {
    throw Object.assign(new Error('name 不是文本'), {
      code: 'bad_request',
      hint: '参数不对：name 必须是文件名文本。',
    })
  }
  const name = value.trim()
  if (!name) return ''
  if (name.includes('/') || name.includes('\\')) {
    throw Object.assign(new Error('name=' + name), {
      code: 'bad_request',
      hint: '参数不对：name 只写文件名，不要带目录。',
      detail: 'name=' + name,
    })
  }
  if (name.length > 120) {
    throw Object.assign(new Error('name 太长'), {
      code: 'bad_request',
      hint: '参数不对：name 最多 120 字。',
    })
  }
  return name
}

/** 读本机图片：先校验路径再读字节，错误码区分 bad_path / too_large / not_image。 */
function getLocalImage(path, maxBytes, maxMB) {
  const original = String(path ?? '').trim()
  if (!isAbsolute(original)) {
    throw Object.assign(new Error('path=' + original), {
      code: 'bad_path',
      hint: '参数不对：path 只接受本机绝对路径（如 E:\\图片\\a.gif）。',
      detail: 'path=' + original,
    })
  }
  let file
  try {
    file = statSync(original)
  } catch {
    throw Object.assign(new Error('path=' + original), {
      code: 'bad_path',
      hint: '找不到这个文件：' + original,
      detail: 'path=' + original,
    })
  }
  if (!file.isFile()) {
    throw Object.assign(new Error('path=' + original), {
      code: 'bad_path',
      hint: 'path 必须指向一个文件，不能是目录。',
      detail: 'path=' + original,
    })
  }
  if (!file.size) {
    throw Object.assign(new Error('path=' + original), {
      code: 'not_image',
      hint: '这个文件是空的，没法当表情。',
      detail: 'path=' + original,
    })
  }
  if (file.size > maxBytes) {
    throw Object.assign(new Error('size=' + file.size), {
      code: 'too_large',
      hint: '这张图有 ' + (file.size / 1048576).toFixed(1) + 'MB，超过单张上限 ' + maxMB + 'MB。',
      detail: 'size=' + file.size + ', max=' + maxBytes,
    })
  }
  let buf
  try {
    buf = readFileSync(original)
  } catch (error) {
    throw Object.assign(new Error(String(error?.message || error)), {
      code: 'bad_path',
      hint: '这个文件读不了（可能被占用或没有权限）。',
      detail: String(error?.message || error),
    })
  }
  return { buf, fileName: basename(original) }
}

/** 下载网络图片：只认 http(s)，先看 Content-Type/长度再落地。 */
async function downloadPicture(rawUrl, maxBytes, maxMB) {
  let address
  try {
    address = new URL(String(rawUrl ?? '').trim())
  } catch {
    throw Object.assign(new Error('url 不合法'), {
      code: 'bad_request',
      hint: '参数不对：url 必须是完整的 http(s) 地址。',
      detail: String(rawUrl ?? ''),
    })
  }
  if (address.protocol !== 'http:' && address.protocol !== 'https:') {
    throw Object.assign(new Error('protocol=' + address.protocol), {
      code: 'bad_request',
      hint: '参数不对：url 只支持 http / https。',
      detail: 'protocol=' + address.protocol,
    })
  }
  let response
  try {
    response = await fetch(address, { redirect: 'follow', signal: AbortSignal.timeout(20000) })
  } catch (error) {
    throw Object.assign(new Error(String(error?.message || error)), {
      code: 'download_failed',
      hint: '图片下载失败，请检查地址与网络。',
      detail: String(error?.message || error),
    })
  }
  if (!response.ok) {
    throw Object.assign(new Error('HTTP ' + response.status), {
      code: 'download_failed',
      hint: '下载图片失败（HTTP ' + response.status + '）。',
      detail: 'url=' + address.href,
    })
  }
  const kind = String(response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim()
  if (kind && !kind.startsWith('image/')) {
    throw Object.assign(new Error('content-type=' + kind), {
      code: 'not_image',
      hint: '这个地址返回的不是图片（Content-Type: ' + kind + '）。',
      detail: 'url=' + address.href,
    })
  }
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw Object.assign(new Error('content-length=' + declaredLength), {
      code: 'too_large',
      hint: '这张图有 ' + (declaredLength / 1048576).toFixed(1) + 'MB，超过单张上限 ' + maxMB + 'MB。',
      detail: 'content-length=' + declaredLength + ', max=' + maxBytes,
    })
  }
  let buf
  try {
    buf = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    throw Object.assign(new Error(String(error?.message || error)), {
      code: 'download_failed',
      hint: '图片下载中断，请重试或改用 path。',
      detail: String(error?.message || error),
    })
  }
  if (!buf.length) {
    throw Object.assign(new Error('空响应'), {
      code: 'not_image',
      hint: '这个地址返回了空内容。',
      detail: 'url=' + address.href,
    })
  }
  if (buf.length > maxBytes) {
    throw Object.assign(new Error('size=' + buf.length), {
      code: 'too_large',
      hint: '这张图有 ' + (buf.length / 1048576).toFixed(1) + 'MB，超过单张上限 ' + maxMB + 'MB。',
      detail: 'size=' + buf.length + ', max=' + maxBytes,
    })
  }
  const lastSegment = address.pathname.split('/').filter(Boolean).pop() || ''
  let fileName = 'sticker'
  try { fileName = decodeURIComponent(lastSegment) || 'sticker' } catch { fileName = lastSegment || 'sticker' }
  return { buf, fileName }
}

/** 把 service / StickerStore 的错误翻成工具错误码：库接口的 code 不适合直接给 Agent 看。 */
function toStoreError(error) {
  const code = String(error?.code || '')
  const hint = String(error?.hint || error?.message || '表情入库失败')
  let outgoingCode = code || 'sticker_error'
  if (code === 'fish_message_unavailable') outgoingCode = 'unavailable'
  else if (code === 'fish_message_sticker_limit') outgoingCode = 'too_large'
  else if (/仅支持|不是图片|内容为空/.test(hint)) outgoingCode = 'not_image'
  else if (/找不到|必须是文件|完整路径|只接受本机/.test(hint)) outgoingCode = 'bad_path'
  return Object.assign(new Error(hint), {
    code: outgoingCode,
    hint: hint,
    detail: String(error?.detail || ''),
  })
}

export function makeStickerListTool({ api, logger, getConfig }) {
  return makeTool({
    name: 'fish_sticker_list',
    description: '搜索/列出表情库：只读，返回条目（id、文件、标签、描述、尺寸、用量），不含 base64。q 搜标签/描述/文件名，tag 精确筛标签，limit 1~100。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: '搜索词：匹配标签、描述、文件名、id。' },
        tag: { type: 'string', description: '只列这个标签；带不带 # 都行。' },
        limit: { type: 'integer', description: '返回条数 1~100，默认 20。' },
        sort: { type: 'string', enum: ['used', 'recent', 'name'], description: '排序：used=按用量（默认）、recent=按加入时间、name=按文件名。' },
      },
    },
    output: outputSchema({
      count: { type: 'number', description: '本次返回条数' },
      total: { type: 'number', description: '命中总数' },
      items: {
        type: 'array',
        description: '命中的表情条目（字段含义见 items 的 properties）。',
        items: stickerEntrySchema(),
      },
      tags: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { tag: { type: 'string' }, count: { type: 'number' } },
        },
      },
      stats: stickerStatsSchema(),
    }),
    execute: async (args) => {
      if (!api?.stickers || typeof api.stickers.list !== 'function') {
        return { ok: false, code: 'unavailable', hint: '表情库还没准备好（fish.message 服务没有 stickers）。' }
      }
      const limit = requireInteger(args.limit, 20, 1, 100, 'limit')
      const r = await api.stickers.list({
        ...(isText(args.q) && args.q.trim() ? { q: args.q.trim() } : {}),
        ...(isText(args.tag) && args.tag.trim() ? { tag: args.tag.trim() } : {}),
        ...(isText(args.sort) ? { sort: args.sort } : {}),
        limit,
      })
      return {
        ok: true,
        count: (r.items || []).length,
        total: Number(r.total) || 0,
        items: r.items || [],
        tags: r.tags || [],
        stats: r.stats || {},
      }
    },
    logger,
    getConfig,
  })
}

export function makeStickerSendTool({ api, logger, getConfig }) {
  return makeTool({
    name: 'fish_sticker_send',
    description: '把表情库里的表情发到 QQ 或微信私聊（图片段，GIF 保留动图）。name 可以是名字、#标签或 id；channel 缺省 qq，发微信要显式写 wechat；qq 省略时用这条通道的第一条绑定；count 1~5。发送成功会计入用量。不返回 base64。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: { type: 'string', enum: ['qq', 'wechat'], description: '通道：qq（默认）或 wechat。' },
        qq: { type: 'string', description: '对方 id：QQ 号或微信 peer（wxid_xxx / o9cq...@im.wechat）；省略=这条通道的第一条启用绑定。' },
        name: { type: 'string', description: '表情名字 / #标签 / id（大小写不敏感）。' },
        count: { type: 'integer', description: '连发几张，1~5，默认 1；标签命中多个时会轮换。' },
      },
      required: ['name'],
    },
    output: outputSchema({
      channel: { type: 'string' },
      qq: { type: 'string' },
      count: { type: 'number' },
      sent: { type: 'number' },
      queued: { type: 'boolean' },
      pending: { type: 'number' },
      stickers: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            file: { type: 'string' },
            name: { type: 'string' },
            sent: { type: 'boolean' },
            queued: { type: 'boolean' },
            pending: { type: 'number' },
          },
        },
      },
    }),
    execute: async (args) => {
      if (!api?.stickers || typeof api.stickers.send !== 'function') {
        return { ok: false, code: 'unavailable', hint: '表情库还没准备好（fish.message 服务没有 stickers）。' }
      }
      const channel = parseChannel(args.channel)
      if (!channel) {
        throw Object.assign(new Error(`channel=${String(args.channel)}`), {
          code: 'bad_request',
          hint: '参数不对：channel 只能是 qq 或 wechat。',
          detail: `channel=${JSON.stringify(args.channel)}`,
        })
      }
      const qq = requirePeer(channel, args.qq, getConfig)
      const name = requireName(args.name)
      const count = requireInteger(args.count, 1, 1, 5, 'count')

      const emitted = []
      for (let i = 0; i < count; i++) {
        // 按标签/模糊匹配时每次解析可能轮换到不同表情，所以 id/file 取自本次实际发出的条目。
        const r = await api.stickers.send(qq, name, { channel })
        const actual = r?.sticker || {}
        emitted.push({
          id: String(actual.id || ''),
          file: String(actual.file || ''),
          name: String((actual.file || '').split(/[\\/]/).pop() || ''),
          sent: Boolean(r?.sent),
          queued: Boolean(r?.queued),
          pending: Number(r?.pending) || 0,
        })
      }
      return {
        ok: true,
        channel,
        qq,
        count: emitted.length,
        sent: emitted.filter((x) => x.sent).length,
        queued: emitted.some((x) => x.queued),
        pending: emitted.reduce((m, x) => Math.max(m, x.pending), 0),
        stickers: emitted,
      }
    },
    logger,
    getConfig,
  })
}

export function makeStickerSaveTool({ api, logger, getConfig }) {
  return makeTool({
    name: 'fish_sticker_save',
    description: "把一张图片收进表情库（GIF 保留动图，不转码）。path 与 url 二选一；按 sha256 去重：同一张图不复制文件、不改已有名字，只把标签取并集；描述与来源只在原来为空时才补上。tags 最多 16 个，desc 最多 500 字，source 默认 'agent'。不返回 base64。",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '本机图片的绝对路径（与 url 二选一），支持 GIF/PNG/JPEG/WebP/BMP。' },
        url: { type: 'string', description: '图片地址 http(s)（与 path 二选一），由插件下载后入库。' },
        name: { type: 'string', description: '可选：入库文件名，只写文件名不要带目录；默认沿用来源文件名。' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，最多 16 个，每个最多 32 字。' },
        desc: { type: 'string', description: '描述，最多 500 字。' },
        source: { type: 'string', description: "来源标记，默认 'agent'。" },
      },
    },
    output: outputSchema({
      created: { type: 'boolean', description: 'true=新入库；false=库里已有同一张图（按 sha256 命中）。' },
      exists: { type: 'boolean', description: '库里原本就有这张图；此时只可能合并标签/描述。' },
      merged: { type: 'boolean', description: '是否把标签/描述合并进了已有条目。' },
      entry: stickerEntrySchema(),
    }),
    execute: async (args) => {
      if (!api?.stickers || typeof api.stickers.save !== 'function') {
        return { ok: false, code: 'unavailable', hint: '表情库还没准备好（fish.message 服务没有 stickers）。' }
      }
      const hasPath = isText(args.path) && Boolean(args.path.trim())
      const hasUrl = isText(args.url) && Boolean(args.url.trim())
      if (hasPath === hasUrl) {
        throw Object.assign(new Error('path/url'), {
          code: 'bad_request',
          hint: hasPath ? '参数不对：path 与 url 只能给一个。' : '参数不对：path（本机绝对路径）与 url 必须给一个。',
        })
      }

      const maxMB = getSingleMaxMB(getConfig)
      const maxBytes = Math.round(maxMB * 1024 * 1024)
      const picked = hasPath
        ? getLocalImage(args.path, maxBytes, maxMB)
        : await downloadPicture(args.url, maxBytes, maxMB)

      if (!readPictureInfo(picked.buf)) {
        throw Object.assign(new Error('不是图片'), {
          code: 'not_image',
          hint: '仅支持 GIF、PNG、JPEG、WebP、BMP 格式的图片。',
          detail: hasPath ? 'path=' + String(args.path).trim() : 'url=' + String(args.url).trim(),
        })
      }

      if (args.desc !== undefined && args.desc !== null && !isText(args.desc)) {
        throw Object.assign(new Error('desc 不是文本'), {
          code: 'bad_request',
          hint: '参数不对：desc 必须是文本。',
        })
      }
      if (args.source !== undefined && args.source !== null && !isText(args.source)) {
        throw Object.assign(new Error('source 不是文本'), {
          code: 'bad_request',
          hint: '参数不对：source 必须是文本。',
        })
      }

      const fileName = requireFileName(args.name) || picked.fileName
      const tags = normalizeTags(args.tags)
      const desc = isText(args.desc) ? args.desc.trim().slice(0, 500) : ''
      const source = isText(args.source) && args.source.trim() ? args.source.trim().slice(0, 200) : 'agent'

      let r
      try {
        // 不传 overwrite：库按 sha256 去重，同名的不同内容会自动加后缀，不会覆盖已有表情。
        r = await api.stickers.save(picked.buf, { tags, desc, source, name: fileName })
      } catch (error) {
        throw toStoreError(error)
      }
      return {
        ok: true,
        created: Boolean(r?.created),
        exists: !r?.created,
        merged: Boolean(r?.merged),
        entry: r?.entry || {},
      }
    },
    logger,
    getConfig,
  })
}

/** 造三个工具定义（不注册，方便单测）。 */
export function buildStickerToolDefinitions({ api, logger, getConfig } = {}) {
  return [
    makeStickerListTool({ api, logger, getConfig }),
    makeStickerSendTool({ api, logger, getConfig }),
    makeStickerSaveTool({ api, logger, getConfig }),
  ]
}

/**
 * 注册到宿主；返回 disposer。宿主没有 ctx.tools 时安静跳过（表情库本身照常可用）。
 */
export function registerStickerTools(ctx, { api, logger, getConfig } = {}) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    logger?.warn?.('宿主没有 ctx.tools，跳过表情工具注册（设置页/服务仍然可用）')
    return () => {}
  }
  const detach = []
  for (const definition of buildStickerToolDefinitions({ api, logger, getConfig })) {
    try {
      const disposer = ctx.tools.register(definition)
      if (typeof disposer === 'function') detach.push(disposer)
    } catch (error) {
      logger?.error?.(`工具 ${definition.name} 注册失败：${error?.message || error}`)
    }
  }
  return () => {
    for (const func of detach.splice(0)) {
      try { func() } catch { /* 已卸载 */ }
    }
  }
}

export const stickerToolName = Object.freeze(['fish_sticker_list', 'fish_sticker_send', 'fish_sticker_save'])
