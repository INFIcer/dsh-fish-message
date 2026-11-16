// 图库管理页的数据路由：收图图库（列表 / 出图 / 改描述 / 打开原图）、
// 记忆图库（列表 / 出图 / 改描述与标签）与声纹库（只读列表）。
//
// 约定与 lib/sticker-routes.js 一致：makeGalleryRouteHandlers() 返回「路径 → handler」，
// host.js 负责 ctx.effect 注册，单测直接拿 map 调；不 import 宿主。
//
// 记忆插件是可选的：服务取不到时返回 service:false + 一句提示，页面据此显示「记忆插件未启用」，
// 不抛错，也不影响收图图库与表情库的页签。

import { readFileSync, statSync } from 'node:fs'
import { spawn as defaultSpawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
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
 * @param {() => object|undefined} [options.getMemory] 取记忆服务（memory.library）；没装返回 undefined
 * @param {string} [options.routePrefix] 路由前缀（默认 /dsh-fish-message）
 * @param {object} [options.logger]
 * @param {NodeJS.Platform} [options.platform] 单测注入，默认当前平台
 * @param {typeof import('node:child_process').spawn} [options.spawn] 单测注入，默认 child_process.spawn
 * @returns {Record<string, (req:any,res:any)=>Promise<void>>}
 */
export function makeGalleryRouteHandlers({
  images = null,
  getMemory = () => undefined,
  routePrefix = '/dsh-fish-message',
  logger = null,
  platform = process.platform,
  spawn = defaultSpawn,
} = {}) {
  const prefix = text(routePrefix).replace(/\/+$/, '') || '/dsh-fish-message'

  /** 记忆服务每次现取：插件晚加载、重启后都能取到；取不到返回 null。 */
  function memory() {
    try {
      const service = getMemory()
      return service && typeof service === 'object' ? service : null
    } catch {
      return null
    }
  }

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

  /** 记忆服务不可用时的统一回执：200 + service:false，页面照常渲染降级提示。 */
  function memoryUnavailable(res, extra = {}) {
    respond(res, 200, { ok: true, service: false, hint: '记忆插件未启用', ...extra })
  }

  function memoryFailed(res, error) {
    respond(res, 502, {
      ok: false,
      service: true,
      code: String(error?.code || 'memory_failed'),
      error: String(error?.hint || error?.message || '记忆服务调用失败'),
    })
  }

  const handlers = {
    // ---------------- 收图图库 ----------------
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

    // ---------------- 记忆图库 ----------------
    [`${prefix}/memory/images`]: async (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      const service = memory()
      if (!service) {
        memoryUnavailable(res, { entries: [], total: 0 })
        return
      }
      if (typeof service.images?.list !== 'function') {
        respond(res, 503, { ok: false, service: true, error: '记忆插件版本太旧，没有提供图库列表能力。' })
        return
      }
      const q = query(req)
      try {
        const result = await service.images.list({
          q: text(q.get('q')),
          tag: text(q.get('tag')),
          limit: integer(q.get('limit'), 100, 1, 200),
        })
        respond(res, 200, {
          ok: true,
          service: true,
          total: Number(result?.total) || 0,
          entries: Array.isArray(result?.entries) ? result.entries : [],
        })
      } catch (error) {
        memoryFailed(res, error)
      }
    },

    [`${prefix}/memory/images/file`]: async (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      const service = memory()
      if (!service) {
        respond(res, 404, { ok: false, code: 'memory_unavailable', error: '记忆插件未启用。' })
        return
      }
      const sha = text(query(req).get('sha256')).toLowerCase()
      if (!shaPattern.test(sha)) {
        respond(res, 400, { ok: false, code: 'bad_request', error: '缺少有效的图片指纹。' })
        return
      }
      if (typeof service.images?.get !== 'function') {
        respond(res, 503, { ok: false, code: 'memory_unavailable', error: '记忆插件版本太旧，没有提供图库查询能力。' })
        return
      }
      let entry
      try {
        const result = await service.images.get({ sha256: sha })
        entry = result?.entry || null
      } catch (error) {
        respond(res, 404, { ok: false, code: 'not_found', error: String(error?.hint || '记忆图库里没有这张图。') })
        return
      }
      const file = text(entry?.path)
      if (!file || !isAbsolute(file)) {
        respond(res, 404, { ok: false, code: 'not_found', error: '这条记忆图库条目没有可读的原图。' })
        return
      }
      sendImageFile(res, file)
    },

    [`${prefix}/memory/images/note`]: async (req, res) => {
      if (!requireMethod(req, res, 'POST')) return
      const service = memory()
      if (!service) {
        respond(res, 503, { ok: false, service: false, error: '记忆插件未启用。' })
        return
      }
      if (typeof service.images?.note !== 'function') {
        respond(res, 503, { ok: false, service: true, error: '记忆插件版本太旧，没有提供改描述能力。' })
        return
      }
      const incoming = await readJson(req)
      const sha = text(incoming.sha256).toLowerCase()
      if (!shaPattern.test(sha)) {
        respond(res, 400, { ok: false, code: 'bad_request', error: '缺少有效的图片指纹。' })
        return
      }
      const input = { sha256: sha }
      if (incoming.desc !== undefined) input.desc = incoming.desc
      if (incoming.tags !== undefined) input.tags = incoming.tags
      try {
        const result = await service.images.note(input)
        respond(res, 200, { ok: true, service: true, ...(result && typeof result === 'object' ? result : {}) })
      } catch (error) {
        memoryFailed(res, error)
      }
    },

    // ---------------- 声纹库 ----------------
    [`${prefix}/memory/voices`]: async (req, res) => {
      if (!requireMethod(req, res, 'GET')) return
      const service = memory()
      if (!service) {
        memoryUnavailable(res, { people: [], threshold: 0 })
        return
      }
      if (typeof service.voices?.list !== 'function') {
        respond(res, 503, { ok: false, service: true, error: '记忆插件版本太旧，没有提供声纹列表能力。' })
        return
      }
      try {
        const result = await service.voices.list()
        respond(res, 200, {
          ok: true,
          service: true,
          threshold: Number(result?.threshold) || 0,
          people: Array.isArray(result?.people) ? result.people : [],
        })
      } catch (error) {
        memoryFailed(res, error)
      }
    },
  }

  return handlers
}
