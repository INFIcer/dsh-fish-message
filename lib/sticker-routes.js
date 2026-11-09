// 表情库 HTTP 路由：列表、入库（JSON 路径 / multipart 上传）、改、删、发、取图、
// 最近入站图、导入、清理。
//
// 全部按现有约定：只挂 127.0.0.1（由宿主 webServer 决定）、无鉴权、JSON 返回。
// 这个文件不 import 宿主：makeStickerRouteHandlers() 返回「路径 → handler」，
// host.js 负责 ctx.effect 注册，单测直接拿 map 调 handler。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { 默认导入目录, 图片Mime, 规整标签 } from './stickers.js'

const 文本 = (值, 兜底 = '') => (值 == null ? 兜底 : String(值).trim())
const 整数 = (值, 兜底, 最小, 最大) => {
  if (值 === undefined || 值 === null || 值 === '') return 兜底
  const n = Number(值)
  if (!Number.isFinite(n)) return 兜底
  return Math.max(最小, Math.min(最大, Math.trunc(n)))
}

function 回(res, code, data) {
  try {
    res.statusCode = code
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.end?.(JSON.stringify(data))
  } catch {
    // 客户端断开就算了。
  }
}

function 要方法(req, res, 方法) {
  const 来 = String(req?.method || 'GET').toUpperCase()
  if (来 === 方法) return true
  回(res, 405, { ok: false, code: 'method_not_allowed', error: `这个接口只支持 ${方法}` })
  return false
}

function 查询(req) {
  try {
    return new URL(String(req?.url || '/'), 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function 头(req, 名) {
  const h = req?.headers || {}
  return String(h[名] || h[名.toLowerCase()] || '')
}

/** 读原始请求体；超过上限返回 null（路由层回 413）。 */
function 读原始(req, 上限 = 64 * 1024 * 1024) {
  return new Promise((resolvePromise) => {
    const 块们 = []
    let 总 = 0
    let 完了 = false
    const 收 = (块) => {
      if (完了) return
      const b = Buffer.isBuffer(块) ? 块 : Buffer.from(块)
      总 += b.length
      if (总 > 上限) {
        完了 = true
        resolvePromise(null)
        return
      }
      块们.push(b)
    }
    req.on('data', 收)
    req.on('end', () => {
      if (完了) return
      完了 = true
      resolvePromise(Buffer.concat(块们))
    })
    req.on('error', () => {
      if (完了) return
      完了 = true
      resolvePromise(Buffer.alloc(0))
    })
  })
}

async function 读JSON(req) {
  const buf = await 读原始(req, 4 * 1024 * 1024)
  if (buf === null) return null
  try {
    const 值 = JSON.parse(buf.toString('utf8') || '{}')
    return 值 && typeof 值 === 'object' && !Array.isArray(值) ? 值 : {}
  } catch {
    return {}
  }
}

/**
 * 极简 multipart/form-data 解析：够接收多张图片 + 文本字段。
 * @returns {{fields: Record<string,string>, files: Array<{name:string, filename:string, type:string, buffer:Buffer}>}}
 */
export function 解析multipart(buf, contentType) {
  const 边界匹配 = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''))
  const 边界 = 文本(边界匹配?.[1] || 边界匹配?.[2])
  if (!边界 || !Buffer.isBuffer(buf) || !buf.length) return { fields: {}, files: [] }
  const 分隔 = Buffer.from(`--${边界}`)
  const fields = {}
  const files = []
  let 位置 = buf.indexOf(分隔)
  while (位置 !== -1) {
    let 起 = 位置 + 分隔.length
    if (buf[起] === 0x2d && buf[起 + 1] === 0x2d) break // 收尾 --
    while (buf[起] === 0x0d || buf[起] === 0x0a) 起 += 1
    const 头尾 = buf.indexOf('\r\n\r\n', 起)
    if (头尾 < 0) break
    const 头文 = buf.toString('utf8', 起, 头尾)
    const 数据起 = 头尾 + 4
    const 下个 = buf.indexOf(分隔, 数据起)
    if (下个 < 0) break
    let 数据尾 = 下个
    if (buf[数据尾 - 2] === 0x0d && buf[数据尾 - 1] === 0x0a) 数据尾 -= 2
    const 名 = /name="([^"]*)"/i.exec(头文)?.[1] || ''
    let 文件名 = /filename="([^"]*)"/i.exec(头文)?.[1] || ''
    if (!文件名) {
      // 兼容 filename*=UTF-8''xxx 的写法。
      const 星 = /filename\*=UTF-8''([^;\r\n]+)/i.exec(头文)?.[1]
      if (星) {
        try { 文件名 = decodeURIComponent(星) } catch { 文件名 = 星 }
      }
    }
    const 型 = /content-type:\s*([^\r\n]+)/i.exec(头文)?.[1]?.trim() || ''
    if (文件名) files.push({ name: 名, filename: 文件名, type: 型, buffer: buf.subarray(数据起, 数据尾) })
    else if (名) fields[名] = buf.toString('utf8', 数据起, 数据尾)
    位置 = 下个
  }
  return { fields, files }
}

/** 把表情库错误映射成 HTTP 状态码；不静默。 */
export function 表情错误响应(res, error) {
  const 码 = String(error?.code || '')
  const 状态 = 码 === 'sticker_not_found' ? 404
    : 码 === 'sticker_limit' ? 409
      : 码 === 'sticker_bad_request' ? 400
        : 码 === 'sticker_io' ? 500 : 500
  回(res, 状态, {
    ok: false,
    code: 码 || 'sticker_error',
    error: String(error?.hint || error?.message || '表情库操作失败'),
    ...(error?.detail ? { detail: error.detail } : {}),
  })
  return 状态
}

function 取标签(源) {
  if (源 === undefined) return undefined
  return 规整标签(源)
}

/**
 * 造一组路由 handler。
 *
 * @param {object} options
 * @param {import('./stickers.js').StickerStore} options.stickers
 * @param {object} [options.bridge] 发送入口（sendOutbound）
 * @param {() => object} [options.getConfig] 读当前配置（找默认 QQ）
 * @param {object} [options.logger]
 * @param {string} [options.inboxDir] 入站图片目录
 * @param {string} [options.路由前缀]
 * @param {string} [options.导入默认目录]
 * @returns {Record<string, (req:any,res:any)=>Promise<void>>}
 */
export function makeStickerRouteHandlers({
  stickers,
  bridge = null,
  getConfig = () => ({}),
  logger = null,
  inboxDir = '',
  路由前缀 = '/dsh-fish-message',
  导入默认目录: 默认目录 = 默认导入目录,
} = {}) {
  if (!stickers) throw new Error('makeStickerRouteHandlers 缺少 stickers')

  const 收件箱 = 文本(inboxDir) || 文本(stickers.inboxDir)
  const 前缀 = 文本(路由前缀).replace(/\/+$/, '') || '/dsh-fish-message'

  /** 默认发送对象：第一条启用的绑定。 */
  function 默认QQ() {
    const 绑定 = getConfig()?.bindings || []
    const 可用 = 绑定.find((b) => b && b.enabled !== false && b.qq) || 绑定[0]
    return 可用 ? String(可用.qq) : ''
  }

  async function 保存上传(req, res) {
    const 类型 = 头(req, 'content-type')
    if (/multipart\/form-data/i.test(类型)) {
      const 体 = await 读原始(req)
      if (体 === null) {
        回(res, 413, { ok: false, code: 'too_large', error: '上传内容超过 64MB，请分批上传。' })
        return
      }
      const { fields, files } = 解析multipart(体, 类型)
      if (!files.length) {
        回(res, 400, { ok: false, code: 'sticker_bad_request', error: '上传里没有图片文件（表单字段名随意，但要有文件）。' })
        return
      }
      const tags = 取标签(fields.tags ?? fields.标签)
      const desc = fields.desc ?? fields.描述
      const saved = []
      for (const 文件 of files) {
        try {
          const r = stickers.save(文件.buffer, {
            tags,
            desc,
            source: 'upload',
            name: 文件.filename,
          })
          saved.push({ ok: true, name: 文件.filename, ...r })
        } catch (error) {
          saved.push({
            ok: false,
            name: 文件.filename,
            code: String(error?.code || 'sticker_error'),
            error: String(error?.hint || error?.message || error),
          })
        }
      }
      const 成功 = saved.filter((x) => x.ok)
      回(res, 成功.length ? 200 : 400, {
        ok: 成功.length > 0,
        count: 成功.length,
        failed: saved.length - 成功.length,
        saved,
        stats: stickers.stats(),
      })
      return
    }

    const 来 = await 读JSON(req)
    if (!来 || !文本(来.path)) {
      回(res, 400, { ok: false, code: 'sticker_bad_request', error: '参数不对：要么用 multipart 上传文件，要么给 { path: 本机绝对路径 }。' })
      return
    }
    try {
      const r = stickers.save(文本(来.path), {
        tags: 取标签(来.tags),
        desc: 来.desc,
        source: 文本(来.source) || 'manual',
        name: 来.name,
      })
      回(res, 200, { ok: true, ...r, stats: stickers.stats() })
    } catch (error) {
      表情错误响应(res, error)
    }
  }

  const handlers = {
    [`${前缀}/stickers`]: async (req, res) => {
      if (!要方法(req, res, 'GET')) return
      const q = 查询(req)
      const r = stickers.list({
        q: 文本(q.get('q')),
        tag: 文本(q.get('tag')),
        limit: 整数(q.get('limit'), 50, 1, 200),
        offset: 整数(q.get('offset'), 0, 0, 1e9),
        sort: 文本(q.get('sort')) || 'used',
      })
      回(res, 200, {
        ok: true,
        ...r,
        dir: stickers.dir,
        importDir: 默认目录,
      })
    },

    [`${前缀}/stickers/save`]: async (req, res) => {
      if (!要方法(req, res, 'POST')) return
      await 保存上传(req, res)
    },

    [`${前缀}/stickers/update`]: async (req, res) => {
      if (!要方法(req, res, 'POST')) return
      const 来 = await 读JSON(req)
      const id = 文本(来?.id)
      if (!id) {
        回(res, 400, { ok: false, code: 'sticker_bad_request', error: '参数不对：缺少 id。' })
        return
      }
      const 拿 = (键) => (来[键] === undefined ? undefined : 来[键])
      try {
        const entry = stickers.update(id, {
          ...(拿('tags') !== undefined ? { tags: 取标签(来.tags) } : {}),
          ...(拿('desc') !== undefined ? { desc: 来.desc } : {}),
          ...(拿('name') !== undefined ? { name: 来.name } : {}),
        })
        回(res, 200, { ok: true, entry, stats: stickers.stats() })
      } catch (error) {
        表情错误响应(res, error)
      }
    },

    [`${前缀}/stickers/delete`]: async (req, res) => {
      if (!要方法(req, res, 'POST')) return
      const 来 = await 读JSON(req)
      const id = 文本(来?.id)
      if (!id) {
        回(res, 400, { ok: false, code: 'sticker_bad_request', error: '参数不对：缺少 id。' })
        return
      }
      try {
        const r = stickers.delete(id, { removeFile: 来.removeFile !== false })
        回(res, 200, { ok: true, ...r, stats: stickers.stats() })
      } catch (error) {
        表情错误响应(res, error)
      }
    },

    [`${前缀}/stickers/send`]: async (req, res) => {
      if (!要方法(req, res, 'POST')) return
      const 来 = await 读JSON(req)
      const name = 文本(来?.name)
      if (!name) {
        回(res, 400, { ok: false, code: 'sticker_bad_request', error: '参数不对：缺少 name（表情名字 / #标签 / id）。' })
        return
      }
      const qq = 文本(来.qq).replace(/[^\d]/g, '') || 默认QQ()
      if (!qq) {
        回(res, 400, { ok: false, code: 'no_binding', error: '没有可用的 QQ 绑定，先在设置页加一条。' })
        return
      }
      if (!bridge || typeof bridge.sendOutbound !== 'function') {
        回(res, 503, { ok: false, code: 'bridge_unavailable', error: 'QQ 桥还没准备好，暂时发不了表情。' })
        return
      }
      const 次数 = 整数(来.count, 1, 1, 5)
      const 发出 = []
      for (let i = 0; i < 次数; i++) {
        let 条目
        try {
          条目 = stickers.resolve(name)
        } catch (error) {
          表情错误响应(res, error)
          return
        }
        try {
          const 结果 = await bridge.sendOutbound(qq, [{
            type: 'image',
            data: { path: 条目.path, stickerId: 条目.id },
          }], { reason: 'sticker' })
          发出.push({
            ok: 结果?.ok !== false,
            id: 条目.id,
            file: 条目.file,
            name: basename(条目.file),
            sent: Boolean(结果?.sent),
            queued: Boolean(结果?.queued),
            pending: Number(结果?.pending) || 0,
          })
        } catch (error) {
          回(res, 502, {
            ok: false,
            code: 'send_failed',
            error: String(error?.message || error),
            sent: 发出.length,
          })
          return
        }
      }
      回(res, 200, {
        ok: true,
        qq,
        count: 发出.length,
        sent: 发出.filter((x) => x.sent).length,
        queued: 发出.some((x) => x.queued),
        pending: 发出.reduce((m, x) => Math.max(m, x.pending), 0),
        stickers: 发出,
      })
    },

    [`${前缀}/stickers/file`]: async (req, res) => {
      if (!要方法(req, res, 'GET')) return
      const 要的 = 文本(查询(req).get('path'))
      if (!要的) {
        回(res, 400, { ok: false, code: 'sticker_bad_request', error: '参数不对：缺少 path。' })
        return
      }
      const 库根 = resolve(stickers.dir)
      const 绝对 = isAbsolute(要的) ? resolve(要的) : resolve(库根, 要的)
      const 相对 = relative(库根, 绝对)
      if (!相对 || 相对.startsWith('..') || isAbsolute(相对)) {
        回(res, 403, { ok: false, code: 'forbidden', error: '只允许读表情库目录里的文件。' })
        return
      }
      let 信息
      try {
        信息 = statSync(绝对)
      } catch {
        回(res, 404, { ok: false, code: 'not_found', error: '文件不存在。' })
        return
      }
      if (!信息.isFile()) {
        回(res, 404, { ok: false, code: 'not_found', error: '不是文件。' })
        return
      }
      const mime = 图片Mime(绝对)
      if (!mime) {
        回(res, 415, { ok: false, code: 'unsupported_media', error: '只允许读图片文件。' })
        return
      }
      try {
        const buf = readFileSync(绝对)
        res.statusCode = 200
        res.setHeader?.('content-type', mime)
        res.setHeader?.('content-length', String(buf.length))
        res.setHeader?.('cache-control', 'private, max-age=3600')
        res.end?.(buf)
      } catch (error) {
        回(res, 500, { ok: false, code: 'sticker_io', error: String(error?.message || error) })
      }
    },

    [`${前缀}/stickers/recent`]: async (req, res) => {
      if (!要方法(req, res, 'GET')) return
      const limit = 整数(查询(req).get('limit'), 20, 1, 100)
      const items = stickers.recentInbox(limit)
      回(res, 200, { ok: true, dir: 收件箱, items, count: items.length })
    },

    // 额外接口：最近图片的预览。只认文件名，不允许带路径。
    [`${前缀}/stickers/recent/file`]: async (req, res) => {
      if (!要方法(req, res, 'GET')) return
      const name = 文本(查询(req).get('name'))
      if (!name || name !== basename(name) || /[\\/]/.test(name)) {
        回(res, 400, { ok: false, code: 'sticker_bad_request', error: '参数不对：name 只能是文件名。' })
        return
      }
      if (!收件箱) {
        回(res, 404, { ok: false, code: 'not_found', error: '没有收件箱目录。' })
        return
      }
      const 绝对 = join(收件箱, name)
      let 信息
      try {
        信息 = statSync(绝对)
      } catch {
        回(res, 404, { ok: false, code: 'not_found', error: '文件不存在。' })
        return
      }
      if (!信息.isFile()) {
        回(res, 404, { ok: false, code: 'not_found', error: '不是文件。' })
        return
      }
      const mime = 图片Mime(绝对)
      if (!mime) {
        回(res, 415, { ok: false, code: 'unsupported_media', error: '只允许读图片文件。' })
        return
      }
      try {
        const buf = readFileSync(绝对)
        res.statusCode = 200
        res.setHeader?.('content-type', mime)
        res.setHeader?.('content-length', String(buf.length))
        res.setHeader?.('cache-control', 'no-store')
        res.end?.(buf)
      } catch (error) {
        回(res, 500, { ok: false, code: 'sticker_io', error: String(error?.message || error) })
      }
    },

    [`${前缀}/stickers/import`]: async (req, res) => {
      if (!要方法(req, res, 'POST')) return
      const 来 = await 读JSON(req)
      const 目录 = 文本(来?.dir) || 默认目录
      try {
        const r = stickers.importFrom(目录)
        回(res, 200, { ok: true, ...r, stats: stickers.stats() })
      } catch (error) {
        表情错误响应(res, error)
      }
    },

    [`${前缀}/stickers/cleanup`]: async (req, res) => {
      if (!要方法(req, res, 'POST')) return
      const 来 = await 读JSON(req)
      const 模式 = 文本(来?.mode) || 'unused'
      try {
        let r
        if (模式 === 'unused') r = stickers.清理未使用()
        else if (模式 === 'dedupe') r = stickers.清理重复()
        else if (模式 === 'inbox') r = stickers.清理接收目录()
        else {
          回(res, 400, {
            ok: false,
            code: 'sticker_bad_request',
            error: '参数不对：mode 只能是 unused / dedupe / inbox。',
          })
          return
        }
        回(res, 200, { ok: true, mode: 模式, ...r, stats: stickers.stats() })
      } catch (error) {
        表情错误响应(res, error)
      }
    },
  }

  return handlers
}
