// 很小的文件工具：读 JSON、原子写 JSON。
// 状态文件和水位最怕写一半断电，所以统一走「临时文件 + rename」。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function ensureDir(path) {
  try {
    mkdirSync(path, { recursive: true })
    return true
  } catch {
    return false
  }
}

export function readJson(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(path, value) {
  ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  const 文本 = JSON.stringify(value, null, 2)
  try {
    writeFileSync(tmp, 文本, 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    // Windows 上偶发 rename 被占用：退回直接写，至少别把这次保存丢了。
    try {
      writeFileSync(path, 文本, 'utf8')
      return true
    } catch {
      return false
    } finally {
      try { rmSync(tmp, { force: true }) } catch { /* 清不掉就算了 */ }
    }
  }
}

/** 文件大小；不存在返回 0。 */
export function fileSize(path) {
  try {
    return readFileSync(path).length
  } catch {
    return 0
  }
}
