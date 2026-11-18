// 表情库 HTTP 路由：列表、入库（JSON 路径 / multipart 上传）、改、删、发、取图、
// 最近入站图、导入、清理。
//
// 全部按现有约定：只挂 127.0.0.1（由宿主 webServer 决定）、无鉴权、JSON 返回。
// 这个文件不 import 宿主：makeStickerRouteHandlers() 返回「路径 → handler」，
// host.js 负责 ctx.effect 注册，单测直接拿 map 调 handler。

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { spawn as defaultSpawn } from 'node:child_process'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { openInExplorer } from './open-folder.js'
import { defaultImportDir, imageMime, normalizeTags } from './stickers.js'

const text = (value, fallback = '') => (value == null ? fallback : String(value).trim())
const integer = (value, fallback, min, max) => {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function respond(res, code, data) {
  try {
    res.statusCode = code
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.end?.(JSON.stringify(data))
  } catch {
    // 客户端断开就算了。
  }
}

function requireMethod(req, res, method) {
  const incoming = String(req?.method || 'GET').toUpperCase()
  if (incoming === method) return true
  respond(res, 405, { ok: false, code: 'method_not_allowed', error: '请求方式不正确。' })
  return false
}

function query(req) {
  try {
    return new URL(String(req?.url || '/'), 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function header(req, name) {
  const h = req?.headers || {}
  return String(h[name] || h[name.toLowerCase()] || '')
}

/** 读原始请求体；超过上限返回 null（路由层回 413）。 */
function readRaw(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolvePromise) => {
    const blocks = []
    let total = 0
    let done = false
    const receive = (block) => {
      if (done) return
      const b = Buffer.isBuffer(block) ? block : Buffer.from(block)
      total += b.length
      if (total > limit) {
        done = true
        resolvePromise(null)
        return
      }
      blocks.push(b)
    }
    req.on('data', receive)
    req.on('end', () => {
      if (done) return
      done = true
      resolvePromise(Buffer.concat(blocks))
    })
    req.on('error', () => {
      if (done) return
      done = true
      resolvePromise(Buffer.alloc(0))
    })
  })
}

async function readJson(req) {
  const buf = await readRaw(req, 4 * 1024 * 1024)
  if (buf === null) return null
  try {
    const value = JSON.parse(buf.toString('utf8') || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * 极简 multipart/form-data 解析：够接收多张图片 + 文本字段。
 * @returns {{fields: Record<string,string>, files: Array<{name:string, filename:string, type:string, buffer:Buffer}>}}
 */
export function parseMultipart(buf, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''))
  const boundary = text(boundaryMatch?.[1] || boundaryMatch?.[2])
  if (!boundary || !Buffer.isBuffer(buf) || !buf.length) return { fields: {}, files: [] }
  const separator = Buffer.from(`--${boundary}`)
  const fields = {}
  const files = []
  let position = buf.indexOf(separator)
  while (position !== -1) {
    let start = position + separator.length
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break // 收尾 --
    while (buf[start] === 0x0d || buf[start] === 0x0a) start += 1
    const headTail = buf.indexOf('\r\n\r\n', start)
    if (headTail < 0) break
    const headerText = buf.toString('utf8', start, headTail)
    const dataStart = headTail + 4
    const nextIndex = buf.indexOf(separator, dataStart)
    if (nextIndex < 0) break
    let dataTail = nextIndex
    if (buf[dataTail - 2] === 0x0d && buf[dataTail - 1] === 0x0a) dataTail -= 2
    const name = /name="([^"]*)"/i.exec(headerText)?.[1] || ''
    let fileName = /filename="([^"]*)"/i.exec(headerText)?.[1] || ''
    if (!fileName) {
      // 兼容 filename*=UTF-8''xxx 的写法。
      const star = /filename\*=UTF-8''([^;\r\n]+)/i.exec(headerText)?.[1]
      if (star) {
        try { fileName = decodeURIComponent(star) } catch { fileName = star }
      }
    }
    const kind = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() || ''
    if (fileName) files.push({ name: name, filename: fileName, type: kind, buffer: buf.subarray(dataStart, dataTail) })
    else if (name) fields[name] = buf.toString('utf8', dataStart, dataTail)
    position = nextIndex
  }
  return { fields, files }
}

/** 把表情库错误映射成 HTTP 状态码；不静默。 */
export function stickerErrorResponse(res, error) {
  const code = String(error?.code || '')
  const status = code === 'sticker_not_found' ? 404
    : code === 'sticker_limit' ? 409
      : code === 'sticker_bad_request' ? 400
        : code === 'sticker_io' ? 500 : 500
  respond(res, status, {
    ok: false,
    code: code || 'sticker_error',
    error: String(error?.hint || error?.message || '表情库操作失败'),
    ...(error?.detail ? { detail: error.detail } : {}),
  })
  return status
}

function getTags(source) {
  if (source === undefined) return undefined
  return normalizeTags(source)
}

/**
 * 造一组路由 handler。
 *
 * @param {object} options
 * @param {import('./stickers.js').StickerStore} options.stickers
 * @param {object} [options.bridge] 发送入口（sendOutbound）
 * @param {() => object} [options.getConfig] 读当前配置（找默认渠道）
 * @param {object} [options.logger]
 * @param {string} [options.inboxDir] 入站图片目录
 * @param {string} [options.routePrefix] 路由前缀（默认 /dsh-fish-message）
 * @param {string} [options.importDefaultDir] 导入弹窗的默认目录
 * @param {NodeJS.Platform} [options.platform] 单测注入，默认当前平台
 * @param {typeof import('node:child_process').spawn} [options.spawn] 单测注入，默认 child_process.spawn
 * @returns {Record<string, (req:any,res:any)=>Promise<void>>}
 */
export function makeStickerRouteHandlers({
  stickers,
  bridge = null,
  getConfig = () => ({}),
  logger = null,
  inboxDir = '',
  routePrefix = '/dsh-fish-message',
  importDefaultDir: defaultDir = defaultImportDir,
  platform = process.platform,
  spawn = defaultSpawn,
} = {}) {
  if (!stickers) throw new Error('makeStickerRouteHandlers 缺少 stickers')

  const inbox = text(inboxDir) || text(stickers.inboxDir)
  const prefix = text(routePrefix).replace(/\/+$/, '') || '/dsh-fish-message'

  /** 默认发送对象：第一条启用的绑定。 */
  function defaultQq() {
    const binding = getConfig()?.bindings || []
    const available = binding.find((b) => b && b.enabled !== false && b.qq) || binding[0]
    return available ? String(available.qq) : ''
  }

  async function saveUpload(req, res) {
    const kind = header(req, 'content-type')
    if (/multipart\/form-data/i.test(kind)) {
      const payload = await readRaw(req)
      if (payload === null) {
        respond(res, 413, { ok: false, code: 'too_large', error: '上传内容超过 64MB，请分批上传。' })
        return
      }
      const { fields, files } = parseMultipart(payload, kind)
      if (!files.length) {
        respond(res, 400, { ok: false, code: 'sticker_bad_request', error: '未选择图片文件，请重新选择。' })
        return
      }
      const tags = getTags(fields.tags ?? fields.标签)
      const desc = fields.desc ?? fields.描述
      const saved = []
      for (const file of files) {
        try {
          const r = stickers.save(file.buffer, {
            tags,
            desc,
            source: 'upload',
            name: file.filename,
          })
          saved.push({ ok: true, name: file.filename, ...r })
        } catch (error) {
          saved.push({
            ok: false,
            name: file.filename,
            code: String(error?.code || 'sticker_error'),
            error: String(error?.hint || error?.message || error),
          })
        }
      }
      const success = saved.filter((x) => x.ok)
      respond(res, success.length ? 200 : 400, {
        ok: success.length > 0,
        count: success.length,
        failed: saved.length - success.length,
        saved,
        stats: stickers.stats(),
      })
      return
    }

    const incoming = await readJson(req)
    if (!incoming || !text(incoming.path)) {
      respond(res, 400, { ok: false, code: 'sticker_bad_request', error: '请上传图片文件，或提供本机图片路径。' })
      return
    }
    try {
      const r = stickers.save(text(incoming.path), {
        tags: getTags(incoming.tags),
        desc: incoming.desc,
        source: text(incoming.source) || 'manual',
        name: incoming.name,
      })
      respond(res, 200, { ok: true, ...r, stats: stickers.stats() })
    } catch (error) {
      stickerErrorResponse(res, error)
    }
  }

  const handlers = {
    [`${prefix}/stickers`]: async (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      const q = query(req)
      const r = stickers.list({
        q: text(q.get('q')),
        tag: text(q.get('tag')),
        limit: integer(q.get('limit'), 50, 1, 200),
        offset: integer(q.get('offset'), 0, 0, 1e9),
        sort: text(q.get('sort')) || 'used',
      })
      respond(res, 200, {
        ok: true,
        ...r,
        dir: stickers.dir,
        importDir: defaultDir,
      })
    },

    [`${prefix}/stickers/save`]: async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      await saveUpload(req, res)
    },

    [`${prefix}/stickers/update`]: async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const incoming = await readJson(req)
      const id = text(incoming?.id)
      if (!id) {
        respond(res, 400, { ok: false, code: 'sticker_bad_request', error: '缺少表情编号。' })
        return
      }
      const pickField = (key) => (incoming[key] === undefined ? undefined : incoming[key])
      try {
        const entry = stickers.update(id, {
          ...(pickField('tags') !== undefined ? { tags: getTags(incoming.tags) } : {}),
          ...(pickField('desc') !== undefined ? { desc: incoming.desc } : {}),
          ...(pickField('name') !== undefined ? { name: incoming.name } : {}),
        })
        respond(res, 200, { ok: true, entry, stats: stickers.stats() })
      } catch (error) {
        stickerErrorResponse(res, error)
      }
    },

    [`${prefix}/stickers/delete`]: async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const incoming = await readJson(req)
      const id = text(incoming?.id)
      if (!id) {
        respond(res, 400, { ok: false, code: 'sticker_bad_request', error: '缺少表情编号。' })
        return
      }
      try {
        const r = stickers.delete(id, { removeFile: incoming.removeFile !== false })
        respond(res, 200, { ok: true, ...r, stats: stickers.stats() })
      } catch (error) {
        stickerErrorResponse(res, error)
      }
    },

    [`${prefix}/stickers/send`]: async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const incoming = await readJson(req)
      const name = text(incoming?.name)
      if (!name) {
        respond(res, 400, { ok: false, code: 'sticker_bad_request', error: '缺少表情名称。' })
        return
      }
      const qq = text(incoming.qq).replace(/[^\d]/g, '') || defaultQq()
      if (!qq) {
        respond(res, 400, { ok: false, code: 'no_binding', error: '尚未配置渠道绑定，请先在设置页添加。' })
        return
      }
      if (!bridge || typeof bridge.sendOutbound !== 'function') {
        respond(res, 503, { ok: false, code: 'bridge_unavailable', error: '消息服务尚未就绪，暂时无法发送表情。' })
        return
      }
      const times = integer(incoming.count, 1, 1, 5)
      const emitted = []
      for (let i = 0; i < times; i++) {
        let entry
        try {
          entry = stickers.resolve(name)
        } catch (error) {
          stickerErrorResponse(res, error)
          return
        }
        try {
          const result = await bridge.sendOutbound(qq, [{
            type: 'image',
            data: { path: entry.path, stickerId: entry.id },
          }], { reason: 'sticker' })
          emitted.push({
            ok: result?.ok !== false,
            id: entry.id,
            file: entry.file,
            name: basename(entry.file),
            sent: Boolean(result?.sent),
            queued: Boolean(result?.queued),
            pending: Number(result?.pending) || 0,
          })
        } catch (error) {
          respond(res, 502, {
            ok: false,
            code: 'send_failed',
            error: '发送失败，请稍后重试。',
            detail: String(error?.message || error),
            sent: emitted.length,
          })
          return
        }
      }
      respond(res, 200, {
        ok: true,
        qq,
        count: emitted.length,
        sent: emitted.filter((x) => x.sent).length,
        queued: emitted.some((x) => x.queued),
        pending: emitted.reduce((m, x) => Math.max(m, x.pending), 0),
        stickers: emitted,
      })
    },

    [`${prefix}/stickers/file`]: async (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      const wanted = text(query(req).get('path'))
      if (!wanted) {
        respond(res, 400, { ok: false, code: 'sticker_bad_request', error: '缺少图片路径。' })
        return
      }
      const storeRoot = resolve(stickers.dir)
      const absolute = isAbsolute(wanted) ? resolve(wanted) : resolve(storeRoot, wanted)
      const relativePath = relative(storeRoot, absolute)
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        respond(res, 403, { ok: false, code: 'forbidden', error: '仅能读取表情库中的图片。' })
        return
      }
      let info
      try {
        info = statSync(absolute)
      } catch {
        respond(res, 404, { ok: false, code: 'not_found', error: '图片不存在。' })
        return
      }
      if (!info.isFile()) {
        respond(res, 404, { ok: false, code: 'not_found', error: '该路径不是图片文件。' })
        return
      }
      const mime = imageMime(absolute)
      if (!mime) {
        respond(res, 415, { ok: false, code: 'unsupported_media', error: '仅支持图片文件。' })
        return
      }
      try {
        const buf = readFileSync(absolute)
        res.statusCode = 200
        res.setHeader?.('content-type', mime)
        res.setHeader?.('content-length', String(buf.length))
        res.setHeader?.('cache-control', 'private, max-age=3600')
        res.end?.(buf)
      } catch (error) {
        respond(res, 500, { ok: false, code: 'sticker_io', error: '图片读取失败，请稍后重试。', detail: String(error?.message || error) })
      }
    },

    [`${prefix}/stickers/recent`]: async (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      const limit = integer(query(req).get('limit'), 20, 1, 100)
      const items = stickers.recentInbox(limit)
      respond(res, 200, { ok: true, dir: inbox, items, count: items.length })
    },

    // 额外接口：最近图片的预览。只认文件名，不允许带路径。
    [`${prefix}/stickers/recent/file`]: async (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      const name = text(query(req).get('name'))
      if (!name || name !== basename(name) || /[\\/]/.test(name)) {
        respond(res, 400, { ok: false, code: 'sticker_bad_request', error: '参数不正确：文件名不能包含路径。' })
        return
      }
      if (!inbox) {
        respond(res, 404, { ok: false, code: 'not_found', error: '图片目录不存在。' })
        return
      }
      const absolute = join(inbox, name)
      let info
      try {
        info = statSync(absolute)
      } catch {
        respond(res, 404, { ok: false, code: 'not_found', error: '图片不存在。' })
        return
      }
      if (!info.isFile()) {
        respond(res, 404, { ok: false, code: 'not_found', error: '该路径不是图片文件。' })
        return
      }
      const mime = imageMime(absolute)
      if (!mime) {
        respond(res, 415, { ok: false, code: 'unsupported_media', error: '仅支持图片文件。' })
        return
      }
      try {
        const buf = readFileSync(absolute)
        res.statusCode = 200
        res.setHeader?.('content-type', mime)
        res.setHeader?.('content-length', String(buf.length))
        res.setHeader?.('cache-control', 'no-store')
        res.end?.(buf)
      } catch (error) {
        respond(res, 500, { ok: false, code: 'sticker_io', error: '图片读取失败，请稍后重试。', detail: String(error?.message || error) })
      }
    },

    // 保留「从默认表情库导入」的后端能力，供脚本/兼容调用；管理页已不再暴露入口。
    [`${prefix}/stickers/import`]: async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const incoming = await readJson(req)
      const dir = text(incoming?.dir) || defaultDir
      try {
        const r = stickers.importFrom(dir)
        respond(res, 200, { ok: true, ...r, stats: stickers.stats() })
      } catch (error) {
        stickerErrorResponse(res, error)
      }
    },

    // 打开表情库文件夹：只开本插件配置里的库目录，不接受任何路径参数。
    // 目录被删掉时先建回来，保证「打开」这个动作本身不会失败。
    [`${prefix}/stickers/open-folder`]: async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      if (platform !== 'win32') {
        respond(res, 501, { ok: false, code: 'unsupported', error: '暂不支持：打开文件夹目前仅支持 Windows。' })
        return
      }
      const dir = text(stickers.dir)
      if (!dir) {
        respond(res, 500, { ok: false, code: 'sticker_io', error: '表情库目录还没准备好，无法打开。' })
        return
      }
      let resolvedPath
      try {
        mkdirSync(dir, { recursive: true })
        resolvedPath = realpathSync(dir)
      } catch (error) {
        logger?.warn?.(`打开表情库文件夹失败：${String(error?.message || error)}`)
        respond(res, 500, {
          ok: false,
          code: 'sticker_io',
          error: `表情库目录不可用：${dir}。请检查磁盘空间与权限后重试。`,
        })
        return
      }
      if (!openInExplorer(resolvedPath, { platform, spawn, logger })) {
        respond(res, 500, {
          ok: false,
          code: 'open_failed',
          error: `资源管理器没能启动。可以手动打开 ${resolvedPath}。`,
        })
        return
      }
      respond(res, 200, { ok: true, path: resolvedPath })
    },

    [`${prefix}/stickers/cleanup`]: async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const incoming = await readJson(req)
      const mode = text(incoming?.mode) || 'unused'
      try {
        let r
        if (mode === 'unused') r = stickers.cleanupUnused()
        else if (mode === 'dedupe') r = stickers.cleanupDuplicates()
        else if (mode === 'inbox') r = stickers.cleanupInbox()
        else {
          respond(res, 400, {
            ok: false,
            code: 'sticker_bad_request',
            error: '清理方式不正确。',
          })
          return
        }
        respond(res, 200, { ok: true, mode: mode, ...r, stats: stickers.stats() })
      } catch (error) {
        stickerErrorResponse(res, error)
      }
    },
  }

  return handlers
}
