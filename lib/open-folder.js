// 「打开文件夹」：只允许用系统资源管理器打开本插件自己的目录。
//
// 安全边界（按顺序校验）：
//   1. 请求体里的 path 必须是非空字符串、绝对路径；
//   2. realpath 后必须真实存在；
//   3. realpath 后必须落在允许目录内（Windows 忽略大小写），挡住 ../ 与符号链接穿越；
//   4. 只调用系统文件管理器，不执行命令、不读取文件内容。
//
// 为了让单测不真的弹出窗口，spawn / platform 都从参数注入。

import { realpathSync } from 'node:fs'
import { spawn as defaultSpawn } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'

const text = (value) => (value == null ? '' : String(value))

function respond(res, code, data) {
  try {
    res.statusCode = code
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.end?.(JSON.stringify(data))
  } catch {
    // 客户端断开就算了。
  }
}

/** 读 JSON 请求体；超限或解析失败都按空对象处理。 */
function readJson(req, limit = 64 * 1024) {
  return new Promise((resolvePromise) => {
    let str = ''
    let done = false
    req.on('data', (block) => {
      if (done) return
      str += block
      if (str.length > limit) {
        done = true
        resolvePromise({})
      }
    })
    req.on('end', () => {
      if (done) return
      done = true
      try {
        const value = JSON.parse(str || '{}')
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

/**
 * 目标是否等于根目录或位于根目录内。
 * 比较前已 realpath；Windows 按小写比较（盘符和路径都不区分大小写）。
 */
export function insideDir(target, root, { ignoreCase = process.platform === 'win32' } = {}) {
  const same = (value) => {
    const str = text(value)
    return ignoreCase ? str.toLowerCase() : str
  }
  const targetText = same(target)
  const rootText = same(root)
  if (!targetText || !rootText) return false
  const diff = relative(rootText, targetText)
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff))
}

/** 尽量取真实路径；目录还不存在时退回绝对路径，交给后续校验。 */
function realPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * 把目录交给系统资源管理器。
 *
 * 只做「交出去」这一步：目录是否存在、是不是本插件的目录由调用方校验；
 * 不等待窗口关闭（detached + unref），spawn 报错只记日志。
 *
 * @returns {boolean} 是否已交给资源管理器
 */
export function openInExplorer(dir, {
  platform = process.platform,
  spawn = defaultSpawn,
  logger = null,
} = {}) {
  if (platform !== 'win32') return false
  try {
    const childProcess = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' })
    childProcess?.on?.('error', (error) => {
      logger?.warn?.(`打开文件夹失败：${text(error?.message || error)}`)
    })
    childProcess?.unref?.()
    return true
  } catch (error) {
    logger?.warn?.(`打开文件夹失败：${text(error?.message || error)}`)
    return false
  }
}

/**
 * 造 POST /open-folder 的 handler。
 *
 * @param {object} options
 * @param {() => string[]} options.允许目录们 每次请求时现取（表情库目录可能被改）
 * @param {NodeJS.Platform} [options.platform]
 * @param {typeof import('node:child_process').spawn} [options.spawn]
 * @param {{warn?: (消息: string) => void}} [options.logger]
 */
export function makeOpenFolderHandler({
  allowedDirs = () => [],
  platform = process.platform,
  spawn = defaultSpawn,
  logger = null,
} = {}) {
  if (typeof allowedDirs !== 'function') throw new Error('makeOpenFolderHandler 需要 允许目录们()')

  return async function openFolder(req, res) {
    if (String(req?.method || 'GET').toUpperCase() !== 'POST') {
      respond(res, 405, { ok: false, code: 'method_not_allowed', error: '请求方式不正确。' })
      return
    }

    const incoming = await readJson(req)
    const originalText = incoming?.path
    if (typeof originalText !== 'string' || !originalText.trim()) {
      respond(res, 400, { ok: false, code: 'bad_path', error: '请提供要打开的文件夹路径。' })
      return
    }
    const wanted = originalText.trim()
    if (!isAbsolute(wanted)) {
      respond(res, 400, { ok: false, code: 'bad_path', error: '路径必须是绝对路径。' })
      return
    }

    if (platform !== 'win32') {
      respond(res, 501, { ok: false, code: 'unsupported', error: '暂不支持：打开文件夹目前仅支持 Windows。' })
      return
    }

    let resolvedPath
    try {
      resolvedPath = realpathSync(wanted)
    } catch {
      respond(res, 400, { ok: false, code: 'not_found', error: '路径不存在或无法访问，请检查后重试。' })
      return
    }

    const roots = []
    for (const root of allowedDirs() || []) {
      const str = text(root).trim()
      if (!str) continue
      roots.push(realPath(str))
    }
    if (!roots.some((root) => insideDir(resolvedPath, root, { ignoreCase: platform === 'win32' }))) {
      respond(res, 403, {
        ok: false,
        code: 'forbidden',
        error: '只能打开本插件的表情库、收件箱、待发消息或缓存目录。',
      })
      return
    }

    if (!openInExplorer(resolvedPath, { platform, spawn, logger })) {
      respond(res, 500, { ok: false, code: 'open_failed', error: '打开失败，请稍后重试。' })
      return
    }

    respond(res, 200, { ok: true, path: resolvedPath })
  }
}
