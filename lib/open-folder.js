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
import { spawn as 默认spawn } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'

const 文本 = (值) => (值 == null ? '' : String(值))

function 回(res, code, data) {
  try {
    res.statusCode = code
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.end?.(JSON.stringify(data))
  } catch {
    // 客户端断开就算了。
  }
}

/** 读 JSON 请求体；超限或解析失败都按空对象处理。 */
function 读JSON(req, 上限 = 64 * 1024) {
  return new Promise((resolvePromise) => {
    let 文 = ''
    let 完了 = false
    req.on('data', (块) => {
      if (完了) return
      文 += 块
      if (文.length > 上限) {
        完了 = true
        resolvePromise({})
      }
    })
    req.on('end', () => {
      if (完了) return
      完了 = true
      try {
        const 值 = JSON.parse(文 || '{}')
        resolvePromise(值 && typeof 值 === 'object' && !Array.isArray(值) ? 值 : {})
      } catch {
        resolvePromise({})
      }
    })
    req.on('error', () => {
      if (完了) return
      完了 = true
      resolvePromise({})
    })
  })
}

/**
 * 目标是否等于根目录或位于根目录内。
 * 比较前已 realpath；Windows 按小写比较（盘符和路径都不区分大小写）。
 */
export function 在目录内(目标, 根, { 忽略大小写 = process.platform === 'win32' } = {}) {
  const 同 = (值) => {
    const 文 = 文本(值)
    return 忽略大小写 ? 文.toLowerCase() : 文
  }
  const 目标文 = 同(目标)
  const 根文 = 同(根)
  if (!目标文 || !根文) return false
  const 差 = relative(根文, 目标文)
  return 差 === '' || (!差.startsWith('..') && !isAbsolute(差))
}

/** 尽量取真实路径；目录还不存在时退回绝对路径，交给后续校验。 */
function 实路径(路径) {
  try {
    return realpathSync(路径)
  } catch {
    return resolve(路径)
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
  允许目录们 = () => [],
  platform = process.platform,
  spawn = 默认spawn,
  logger = null,
} = {}) {
  if (typeof 允许目录们 !== 'function') throw new Error('makeOpenFolderHandler 需要 允许目录们()')

  return async function 打开文件夹(req, res) {
    if (String(req?.method || 'GET').toUpperCase() !== 'POST') {
      回(res, 405, { ok: false, code: 'method_not_allowed', error: '请求方式不正确。' })
      return
    }

    const 来 = await 读JSON(req)
    const 原文 = 来?.path
    if (typeof 原文 !== 'string' || !原文.trim()) {
      回(res, 400, { ok: false, code: 'bad_path', error: '请提供要打开的文件夹路径。' })
      return
    }
    const 要的 = 原文.trim()
    if (!isAbsolute(要的)) {
      回(res, 400, { ok: false, code: 'bad_path', error: '路径必须是绝对路径。' })
      return
    }

    if (platform !== 'win32') {
      回(res, 501, { ok: false, code: 'unsupported', error: '暂不支持：打开文件夹目前仅支持 Windows。' })
      return
    }

    let 真实
    try {
      真实 = realpathSync(要的)
    } catch {
      回(res, 400, { ok: false, code: 'not_found', error: '路径不存在或无法访问，请检查后重试。' })
      return
    }

    const 根们 = []
    for (const 根 of 允许目录们() || []) {
      const 文 = 文本(根).trim()
      if (!文) continue
      根们.push(实路径(文))
    }
    if (!根们.some((根) => 在目录内(真实, 根, { 忽略大小写: platform === 'win32' }))) {
      回(res, 403, {
        ok: false,
        code: 'forbidden',
        error: '只能打开本插件的表情库、收件箱、待发消息或缓存目录。',
      })
      return
    }

    try {
      const 子进程 = spawn('explorer.exe', [真实], { detached: true, stdio: 'ignore' })
      子进程?.on?.('error', (error) => {
        logger?.warn?.(`打开文件夹失败：${文本(error?.message || error)}`)
      })
      子进程?.unref?.()
    } catch (error) {
      logger?.warn?.(`打开文件夹失败：${文本(error?.message || error)}`)
      回(res, 500, { ok: false, code: 'open_failed', error: '打开失败，请稍后重试。' })
      return
    }

    回(res, 200, { ok: true, path: 真实 })
  }
}
