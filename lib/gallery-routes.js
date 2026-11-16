// 图库管理主面板的数据路由：收图图库的列表 / 出图 / 改描述 / 打开原图。
//
// 约定与 lib/sticker-routes.js 一致：makeGalleryRouteHandlers() 返回「路径 → handler」，
// host.js 负责 ctx.effect 注册，单测直接拿 map 调；不 import 宿主。
//
// 这里只服务鱼讯自己的收图图库。记忆图库、声纹库属于记忆插件，页面与路由都由那个插件提供。

import { readFileSync, statSync } from 'node:fs'
import { spawn as defaultSpawn } from 'node:child_process'
import { openInExplorer } from './open-folder.js'
import { imageMime } from './stickers.js'

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

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolvePromise) => {
    let body = ''
    let done = false
    req.on('data', (block) => {
      if (done) return
      body += block
      if (body.length > limit) {
        done = true
        resolvePromise({})
      }
    })
    req.on('end', () => {
      if (done) return
      done = true
      try {
        const value = JSON.parse(body || '{}')
        resolvePromise(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
      } catch {
        resolvePromise({})
      }
    })
    req.on('error', () => {
      if (done) return
      done = true
      resolvePromise({})
    })
  })
}

const shaPattern = /^[0-9a-f]{8,64}$/

/**
 * 造一组图库管理路由 handler。
 *
 * @param {object} options
 * @param {import('./image-library.js').ImageLibrary} [options.images] 收图图库（存储层）
 * @param {string} [options.routePrefix] 路由前缀（默认 /dsh-fish-message）
 * @param {object} [options.logger]
 * @param {NodeJS.Platform} [options.platform] 单测注入，默认当前平台
 * @param {typeof import('node:child_process').spawn} [options.spawn] 单测注入，默认 child_process.spawn
 * @returns {Record<string, (req:any,res:any)=>Promise<void>>}
 */
export function makeGalleryRouteHandlers({
  images = null,
  routePrefix = '/dsh-fish-message',
  logger = null,
  platform = process.platform,
  spawn = defaultSpawn,
} = {}) {
  const prefix = text(routePrefix).replace(/\/+$/, '') || '/dsh-fish-message'

  function requireImages(res) {
    if (!images || typeof images.list !== 'function') {
      respond(res, 503, { ok: false, code: 'image_library_unavailable', error: '收图图库还没准备好，请稍后重试。' })
      return null
    }
    return images
  }

  /**
   * 输出本机图片。路由只接受指纹（不收路径），文件位置一律由存储层按索引解析，
   * 所以不存在路径穿越面。
   */
  function sendImageFile(res, file) {
    let info
    try {
      info = statSync(file)
    } catch {
      respond(res, 404, { ok: false, code: 'not_found', error: '图片不存在。' })
      return
    }
    if (!info.isFile()) {
      respond(res, 404, { ok: false, code: 'not_found', error: '该路径不是图片文件。' })
      return
    }
    const mime = imageMime(file)
    if (!mime) {
      respond(res, 415, { ok: false, code: 'unsupported_media', error: '仅支持图片文件。' })
      return
    }
    try {
      const buffer = readFileSync(file)
      res.statusCode = 200
      res.setHeader?.('content-type', mime)
      res.setHeader?.('content-length', String(buffer.length))
      res.setHeader?.('cache-control', 'no-store')
      res.end?.(buffer)
    } catch (error) {
      respond(res, 500, {
        ok: false,
        code: 'image_io',
        error: '图片读取失败，请稍后重试。',
        detail: String(error?.message || error),
      })
    }
  }

  const handlers = {
    [`${prefix}/images`]: async (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      const library = requireImages(res)
      if (!library) return
      const q = query(req)
      const result = library.list({
        q: text(q.get('q')),
        limit: integer(q.get('limit'), 50, 1, 200),
        offset: integer(q.get('offset'), 0, 0, 1e9),
      })
      respond(res, 200, { ok: true, ...result, stats: library.stats() })
    },

    [`${prefix}/images/file`]: async (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      const library = requireImages(res)
      if (!library) return
      const sha = text(query(req).get('sha256')).toLowerCase()
      if (!shaPattern.test(sha)) {
        respond(res, 400, { ok: false, code: 'bad_request', error: '缺少有效的图片指纹。' })
        return
      }
      const entry = library.lookup(sha)
      if (!entry || !entry.file) {
        respond(res, 404, { ok: false, code: 'not_found', error: '图库里没有这张图的原图。' })
        return
      }
      sendImageFile(res, library.absolutePath(entry.file))
    },

    // 就地改描述：只改索引里的文字，不动原图。
    [`${prefix}/images/note`]: async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const library = requireImages(res)
      if (!library) return
      const incoming = await readJson(req)
      const sha = text(incoming.sha256).toLowerCase()
      if (!shaPattern.test(sha)) {
        respond(res, 400, { ok: false, code: 'bad_request', error: '缺少有效的图片指纹。' })
        return
      }
      const entry = library.lookup(sha)
      if (!entry) {
        respond(res, 404, { ok: false, code: 'not_found', error: '图库里没有这张图。' })
        return
      }
      const updated = library.setDesc(entry.sha256, incoming.desc, { descSource: 'manual' })
      respond(res, 200, { ok: true, entry: updated })
    },

    [`${prefix}/images/open`]: async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const library = requireImages(res)
      if (!library) return
      if (platform !== 'win32') {
        respond(res, 501, { ok: false, code: 'unsupported', error: '暂不支持：打开文件目前仅支持 Windows。' })
        return
      }
      const incoming = await readJson(req)
      const sha = text(incoming.sha256).toLowerCase()
      if (!shaPattern.test(sha)) {
        respond(res, 400, { ok: false, code: 'bad_request', error: '缺少有效的图片指纹。' })
        return
      }
      const entry = library.lookup(sha)
      if (!entry || !entry.file) {
        respond(res, 404, { ok: false, code: 'not_found', error: '图库里没有这张图的原图。' })
        return
      }
      const file = library.absolutePath(entry.file)
      if (!library.hasFile(entry)) {
        respond(res, 404, { ok: false, code: 'not_found', error: '原图已经不在本机（可能被清理或删除了）。' })
        return
      }
      if (!openInExplorer(file, { platform, spawn, logger })) {
        respond(res, 500, { ok: false, code: 'open_failed', error: `没能打开原图，可以手动打开 ${file}。` })
        return
      }
      respond(res, 200, { ok: true, path: file })
    },
  }

  return handlers
}
