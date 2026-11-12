// 表情库的 Agent 工具：fish_sticker_list / fish_sticker_send / fish_sticker_save。
//
// 注册方式与 dsh-fish-service 的工具一致：ctx.tools.register(定义)，定义里带
// parameters（JSON Schema 子集）+ output.schema（字段写清楚）+ execute。
// 失败不抛裸异常，统一返回 { ok:false, code, hint, detail? }，方便 Agent 解释原因。
// 任何返回值都不含 base64。

import { readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { 读图片信息, 规整标签, 默认最大MB } from './stickers.js'

const 是文本 = (值) => typeof 值 === 'string'

function 渲染(value) {
  try {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  } catch {
    return [{ type: 'text', text: String(value) }]
  }
}

export function 输出Schema(properties = {}) {
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

export function 造工具({ name, description, parameters, output, execute, logger }) {
  const 安全执行 = async (args, exec) => {
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
      schema: output || 输出Schema(),
      render: (_args, value) => 渲染(value),
    },
    execute: 安全执行,
  }
}

/** 第一条启用的绑定；没有就返回空串。 */
function 默认QQ(getConfig) {
  try {
    const 绑定 = (getConfig?.()?.bindings || []).filter((b) => b && b.enabled !== false && b.qq)
    return 绑定.length ? String(绑定[0].qq) : ''
  } catch {
    return ''
  }
}

function 要QQ(值, getConfig) {
  const 原 = String(值 == null ? '' : 值).trim()
  if (!原) {
    const 兜底 = 默认QQ(getConfig)
    if (!兜底) {
      throw Object.assign(new Error('没有可用的 QQ 绑定'), {
        code: 'no_binding',
        hint: '没有可用的 QQ 绑定：先在「鱼讯 QQ」设置页加一条绑定，或给 qq 参数。',
      })
    }
    return 兜底
  }
  const 号 = 原.replace(/[^\d]/g, '')
  if (号.length < 5 || 号.length > 12) {
    throw Object.assign(new Error(`qq=${原}`), {
      code: 'bad_request',
      hint: '参数不对：qq 必须是 5~12 位数字。',
      detail: `qq=${原}`,
    })
  }
  return 号
}

function 要名字(值) {
  const 名 = 是文本(值) ? 值.trim() : (值 == null ? '' : String(值).trim())
  if (!名) {
    throw Object.assign(new Error('name 为空'), {
      code: 'bad_request',
      hint: '参数不对：name 不能为空（表情名字 / #标签 / id）。',
    })
  }
  if (名.length > 120) {
    throw Object.assign(new Error('name 太长'), {
      code: 'bad_request',
      hint: '参数不对：name 最多 120 字。',
    })
  }
  return 名
}

function 要整数(值, 兜底, 最小, 最大, 字段) {
  if (值 === undefined || 值 === null || 值 === '') return 兜底
  const n = Number(值)
  if (!Number.isInteger(n) || n < 最小 || n > 最大) {
    throw Object.assign(new Error(`${字段}=${值}`), {
      code: 'bad_request',
      hint: `参数不对：${字段} 必须是 ${最小}~${最大} 的整数。`,
      detail: `${字段}=${值}`,
    })
  }
  return n
}

/**
 * 表情条目的完整字段：必须与 lib/stickers.js 的 规整条目() / 装饰() 一致。
 * 工具输出按 additionalProperties:false 校验，少声明一个字段整次调用都会被拒；
 * frames / duration_s 只有 GIF 才有，所以不能写成必填。
 */
function 表情条目Schema() {
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
function 表情统计Schema() {
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
 * 单张图的大小上限（MB）：沿用配置里的 stickerMaxMB（库里就是这一项在限容量）。
 * 先按文件大小/Content-Length 挡一层，免得大文件白读进内存；真正入库时库还会再查一次。
 */
function 取单张上限MB(getConfig) {
  let 配置值 = 默认最大MB
  try {
    const n = Number(getConfig?.()?.stickerMaxMB)
    if (Number.isFinite(n) && n > 0) 配置值 = n
  } catch { /* 配置读不到就用默认 */ }
  return 配置值
}

/** 入库文件名：只收文件名，拒绝目录与空串；不传返回空串。 */
function 要文件名(值) {
  if (值 === undefined || 值 === null || 值 === '') return ''
  if (!是文本(值)) {
    throw Object.assign(new Error('name 不是文本'), {
      code: 'bad_request',
      hint: '参数不对：name 必须是文件名文本。',
    })
  }
  const 名 = 值.trim()
  if (!名) return ''
  if (名.includes('/') || 名.includes('\\')) {
    throw Object.assign(new Error('name=' + 名), {
      code: 'bad_request',
      hint: '参数不对：name 只写文件名，不要带目录。',
      detail: 'name=' + 名,
    })
  }
  if (名.length > 120) {
    throw Object.assign(new Error('name 太长'), {
      code: 'bad_request',
      hint: '参数不对：name 最多 120 字。',
    })
  }
  return 名
}

/** 读本机图片：先校验路径再读字节，错误码区分 bad_path / too_large / not_image。 */
function 取本机图片(路径, 上限字节, 上限MB) {
  const 原 = String(路径 ?? '').trim()
  if (!isAbsolute(原)) {
    throw Object.assign(new Error('path=' + 原), {
      code: 'bad_path',
      hint: '参数不对：path 只接受本机绝对路径（如 E:\\图片\\a.gif）。',
      detail: 'path=' + 原,
    })
  }
  let 文件
  try {
    文件 = statSync(原)
  } catch {
    throw Object.assign(new Error('path=' + 原), {
      code: 'bad_path',
      hint: '找不到这个文件：' + 原,
      detail: 'path=' + 原,
    })
  }
  if (!文件.isFile()) {
    throw Object.assign(new Error('path=' + 原), {
      code: 'bad_path',
      hint: 'path 必须指向一个文件，不能是目录。',
      detail: 'path=' + 原,
    })
  }
  if (!文件.size) {
    throw Object.assign(new Error('path=' + 原), {
      code: 'not_image',
      hint: '这个文件是空的，没法当表情。',
      detail: 'path=' + 原,
    })
  }
  if (文件.size > 上限字节) {
    throw Object.assign(new Error('size=' + 文件.size), {
      code: 'too_large',
      hint: '这张图有 ' + (文件.size / 1048576).toFixed(1) + 'MB，超过单张上限 ' + 上限MB + 'MB。',
      detail: 'size=' + 文件.size + ', max=' + 上限字节,
    })
  }
  let buf
  try {
    buf = readFileSync(原)
  } catch (error) {
    throw Object.assign(new Error(String(error?.message || error)), {
      code: 'bad_path',
      hint: '这个文件读不了（可能被占用或没有权限）。',
      detail: String(error?.message || error),
    })
  }
  return { buf, 名字: basename(原) }
}

/** 下载网络图片：只认 http(s)，先看 Content-Type/长度再落地。 */
async function 下载图片(地址原文, 上限字节, 上限MB) {
  let 地址
  try {
    地址 = new URL(String(地址原文 ?? '').trim())
  } catch {
    throw Object.assign(new Error('url 不合法'), {
      code: 'bad_request',
      hint: '参数不对：url 必须是完整的 http(s) 地址。',
      detail: String(地址原文 ?? ''),
    })
  }
  if (地址.protocol !== 'http:' && 地址.protocol !== 'https:') {
    throw Object.assign(new Error('protocol=' + 地址.protocol), {
      code: 'bad_request',
      hint: '参数不对：url 只支持 http / https。',
      detail: 'protocol=' + 地址.protocol,
    })
  }
  let 响应
  try {
    响应 = await fetch(地址, { redirect: 'follow', signal: AbortSignal.timeout(20000) })
  } catch (error) {
    throw Object.assign(new Error(String(error?.message || error)), {
      code: 'download_failed',
      hint: '图片下载失败，请检查地址与网络。',
      detail: String(error?.message || error),
    })
  }
  if (!响应.ok) {
    throw Object.assign(new Error('HTTP ' + 响应.status), {
      code: 'download_failed',
      hint: '下载图片失败（HTTP ' + 响应.status + '）。',
      detail: 'url=' + 地址.href,
    })
  }
  const 类型 = String(响应.headers.get('content-type') || '').toLowerCase().split(';')[0].trim()
  if (类型 && !类型.startsWith('image/')) {
    throw Object.assign(new Error('content-type=' + 类型), {
      code: 'not_image',
      hint: '这个地址返回的不是图片（Content-Type: ' + 类型 + '）。',
      detail: 'url=' + 地址.href,
    })
  }
  const 声明长度 = Number(响应.headers.get('content-length'))
  if (Number.isFinite(声明长度) && 声明长度 > 上限字节) {
    throw Object.assign(new Error('content-length=' + 声明长度), {
      code: 'too_large',
      hint: '这张图有 ' + (声明长度 / 1048576).toFixed(1) + 'MB，超过单张上限 ' + 上限MB + 'MB。',
      detail: 'content-length=' + 声明长度 + ', max=' + 上限字节,
    })
  }
  let buf
  try {
    buf = Buffer.from(await 响应.arrayBuffer())
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
      detail: 'url=' + 地址.href,
    })
  }
  if (buf.length > 上限字节) {
    throw Object.assign(new Error('size=' + buf.length), {
      code: 'too_large',
      hint: '这张图有 ' + (buf.length / 1048576).toFixed(1) + 'MB，超过单张上限 ' + 上限MB + 'MB。',
      detail: 'size=' + buf.length + ', max=' + 上限字节,
    })
  }
  const 末段 = 地址.pathname.split('/').filter(Boolean).pop() || ''
  let 名字 = 'sticker'
  try { 名字 = decodeURIComponent(末段) || 'sticker' } catch { 名字 = 末段 || 'sticker' }
  return { buf, 名字 }
}

/** 把 service / StickerStore 的错误翻成工具错误码：库接口的 code 不适合直接给 Agent 看。 */
function 转存库错误(error) {
  const 码 = String(error?.code || '')
  const 提示 = String(error?.hint || error?.message || '表情入库失败')
  let 出码 = 码 || 'sticker_error'
  if (码 === 'fish_message_unavailable') 出码 = 'unavailable'
  else if (码 === 'fish_message_sticker_limit') 出码 = 'too_large'
  else if (/仅支持|不是图片|内容为空/.test(提示)) 出码 = 'not_image'
  else if (/找不到|必须是文件|完整路径|只接受本机/.test(提示)) 出码 = 'bad_path'
  return Object.assign(new Error(提示), {
    code: 出码,
    hint: 提示,
    detail: String(error?.detail || ''),
  })
}

export function makeStickerListTool({ api, logger, getConfig }) {
  return 造工具({
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
    output: 输出Schema({
      count: { type: 'number', description: '本次返回条数' },
      total: { type: 'number', description: '命中总数' },
      items: {
        type: 'array',
        description: '命中的表情条目（字段含义见 items 的 properties）。',
        items: 表情条目Schema(),
      },
      tags: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { tag: { type: 'string' }, count: { type: 'number' } },
        },
      },
      stats: 表情统计Schema(),
    }),
    execute: async (args) => {
      if (!api?.stickers || typeof api.stickers.list !== 'function') {
        return { ok: false, code: 'unavailable', hint: '表情库还没准备好（fish.message 服务没有 stickers）。' }
      }
      const limit = 要整数(args.limit, 20, 1, 100, 'limit')
      const r = await api.stickers.list({
        ...(是文本(args.q) && args.q.trim() ? { q: args.q.trim() } : {}),
        ...(是文本(args.tag) && args.tag.trim() ? { tag: args.tag.trim() } : {}),
        ...(是文本(args.sort) ? { sort: args.sort } : {}),
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
  return 造工具({
    name: 'fish_sticker_send',
    description: '把表情库里的表情发到 QQ 私聊（图片段，GIF 保留动图）。name 可以是名字、#标签或 id；qq 省略时用第一条绑定；count 1~5。发送成功会计入用量。不返回 base64。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        qq: { type: 'string', description: '对方 QQ 号；省略=第一条启用的绑定。' },
        name: { type: 'string', description: '表情名字 / #标签 / id（大小写不敏感）。' },
        count: { type: 'integer', description: '连发几张，1~5，默认 1；标签命中多个时会轮换。' },
      },
      required: ['name'],
    },
    output: 输出Schema({
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
      const qq = 要QQ(args.qq, getConfig)
      const name = 要名字(args.name)
      const count = 要整数(args.count, 1, 1, 5, 'count')

      // 先解析一次，拿到 id/文件名；找不到时直接给明确错误。
      let 条目
      try {
        条目 = await api.stickers.get(name)
      } catch (error) {
        throw Object.assign(new Error(String(error?.hint || error?.message || '找不到表情')), {
          code: error?.code || 'sticker_not_found',
          hint: error?.hint || `找不到表情「${name}」。`,
          detail: error?.detail || '',
        })
      }

      const 发出 = []
      for (let i = 0; i < count; i++) {
        const r = await api.stickers.send(qq, name)
        发出.push({
          id: String(条目?.id || ''),
          file: String(条目?.file || ''),
          name: String((条目?.file || '').split(/[\\/]/).pop() || ''),
          sent: Boolean(r?.sent),
          queued: Boolean(r?.queued),
          pending: Number(r?.pending) || 0,
        })
      }
      return {
        ok: true,
        qq,
        count: 发出.length,
        sent: 发出.filter((x) => x.sent).length,
        queued: 发出.some((x) => x.queued),
        pending: 发出.reduce((m, x) => Math.max(m, x.pending), 0),
        stickers: 发出,
      }
    },
    logger,
    getConfig,
  })
}

export function makeStickerSaveTool({ api, logger, getConfig }) {
  return 造工具({
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
    output: 输出Schema({
      created: { type: 'boolean', description: 'true=新入库；false=库里已有同一张图（按 sha256 命中）。' },
      exists: { type: 'boolean', description: '库里原本就有这张图；此时只可能合并标签/描述。' },
      merged: { type: 'boolean', description: '是否把标签/描述合并进了已有条目。' },
      entry: 表情条目Schema(),
    }),
    execute: async (args) => {
      if (!api?.stickers || typeof api.stickers.save !== 'function') {
        return { ok: false, code: 'unavailable', hint: '表情库还没准备好（fish.message 服务没有 stickers）。' }
      }
      const 有路径 = 是文本(args.path) && Boolean(args.path.trim())
      const 有地址 = 是文本(args.url) && Boolean(args.url.trim())
      if (有路径 === 有地址) {
        throw Object.assign(new Error('path/url'), {
          code: 'bad_request',
          hint: 有路径 ? '参数不对：path 与 url 只能给一个。' : '参数不对：path（本机绝对路径）与 url 必须给一个。',
        })
      }

      const 上限MB = 取单张上限MB(getConfig)
      const 上限字节 = Math.round(上限MB * 1024 * 1024)
      const 取的 = 有路径
        ? 取本机图片(args.path, 上限字节, 上限MB)
        : await 下载图片(args.url, 上限字节, 上限MB)

      if (!读图片信息(取的.buf)) {
        throw Object.assign(new Error('不是图片'), {
          code: 'not_image',
          hint: '仅支持 GIF、PNG、JPEG、WebP、BMP 格式的图片。',
          detail: 有路径 ? 'path=' + String(args.path).trim() : 'url=' + String(args.url).trim(),
        })
      }

      if (args.desc !== undefined && args.desc !== null && !是文本(args.desc)) {
        throw Object.assign(new Error('desc 不是文本'), {
          code: 'bad_request',
          hint: '参数不对：desc 必须是文本。',
        })
      }
      if (args.source !== undefined && args.source !== null && !是文本(args.source)) {
        throw Object.assign(new Error('source 不是文本'), {
          code: 'bad_request',
          hint: '参数不对：source 必须是文本。',
        })
      }

      const 名字 = 要文件名(args.name) || 取的.名字
      const tags = 规整标签(args.tags)
      const desc = 是文本(args.desc) ? args.desc.trim().slice(0, 500) : ''
      const source = 是文本(args.source) && args.source.trim() ? args.source.trim().slice(0, 200) : 'agent'

      let r
      try {
        // 不传 overwrite：库按 sha256 去重，同名的不同内容会自动加后缀，不会覆盖已有表情。
        r = await api.stickers.save(取的.buf, { tags, desc, source, name: 名字 })
      } catch (error) {
        throw 转存库错误(error)
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
  const 摘 = []
  for (const 定义 of buildStickerToolDefinitions({ api, logger, getConfig })) {
    try {
      const disposer = ctx.tools.register(定义)
      if (typeof disposer === 'function') 摘.push(disposer)
    } catch (error) {
      logger?.error?.(`工具 ${定义.name} 注册失败：${error?.message || error}`)
    }
  }
  return () => {
    for (const 函数 of 摘.splice(0)) {
      try { 函数() } catch { /* 已卸载 */ }
    }
  }
}

export const 表情工具名 = Object.freeze(['fish_sticker_list', 'fish_sticker_send', 'fish_sticker_save'])
