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

/**
 * 读 JSON；文件存在但解析失败时，先把原文件改名留档（.bad-<时间戳>）再返回 fallback。
 * 文件不存在不算损坏。解析成功但结构不对的，由调用方用 quarantineFile() 留档。
 */
export function readJsonWithBackup(path, fallback = null, { logger = null, label = 'JSON 文件' } = {}) {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    quarantineFile(path, { logger, label, reason: `解析失败：${error?.message || error}` })
    return fallback
  }
}

/**
 * 把损坏的文件改名留档，避免下一次写入直接覆盖掉唯一证据；不删除原文件。
 * @returns {string} 留档后的路径；改名失败返回空串（原文件保持不动）。
 */
export function quarantineFile(path, { logger = null, label = 'JSON 文件', reason = '格式不对' } = {}) {
  const 目标 = `${path}.bad-${Date.now()}`
  try {
    renameSync(path, 目标)
    logger?.warn?.(`${label}已损坏（${reason}），原文件留档为 ${目标}，按空值继续`)
    return 目标
  } catch (error) {
    logger?.warn?.(`${label}已损坏（${reason}），留档失败：${error?.message || error}；按空值继续`)
    return ''
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
