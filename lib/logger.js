// 日志：内存环（设置页看最近 200 行）+ 落盘文件（超过 5 MB 滚动一次）。
// 全部同步写，量很小；出问题绝不影响消息主流程。

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

const levelWeight = { debug: 10, info: 20, warn: 30, error: 40 }

export class Logger {
  constructor({ filePath, level = 'info', maxMemory = 200, maxBytes = 5 * 1024 * 1024 }) {
    this.filePath = filePath
    this.level = levelWeight[level] ? level : 'info'
    this.maxMemory = maxMemory
    this.maxBytes = maxBytes
    this.lines = []
  }

  setLevel(level) {
    if (levelWeight[level]) this.level = level
  }

  enabled(level) {
    return (levelWeight[level] || 20) >= (levelWeight[this.level] || 20)
  }

  log(level, message) {
    const levelName = levelWeight[level] ? level : 'info'
    const text = String(message == null ? '' : message).replace(/\r?\n/g, ' ⏎ ')
    const time = new Date()
    const supplement = (n, w = 2) => String(n).padStart(w, '0')
    const row = `${time.getFullYear()}-${supplement(time.getMonth() + 1)}-${supplement(time.getDate())} `
      + `${supplement(time.getHours())}:${supplement(time.getMinutes())}:${supplement(time.getSeconds())}.${supplement(time.getMilliseconds(), 3)} `
      + `[${levelName.toUpperCase()}] ${text}`

    this.lines.push(row)
    if (this.lines.length > this.maxMemory) this.lines.splice(0, this.lines.length - this.maxMemory)

    if (!this.enabled(levelName) || !this.filePath) return
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      if (existsSync(this.filePath) && statSync(this.filePath).size > this.maxBytes) {
        const prev = `${this.filePath}.1`
        try { if (existsSync(prev)) unlinkSync(prev) } catch { /* 旧文件删不掉就算了 */ }
        try { renameSync(this.filePath, prev) } catch { /* 滚动失败就继续追加 */ }
      }
      appendFileSync(this.filePath, row + '\n', 'utf8')
    } catch {
      // 日志写不进去不影响收发消息。
    }
  }

  debug(msg) { this.log('debug', msg) }
  info(msg) { this.log('info', msg) }
  warn(msg) { this.log('warn', msg) }
  error(msg) { this.log('error', msg) }

  recent(n = 200) {
    const number = Math.max(1, Math.min(1000, Number(n) || 200))
    return this.lines.slice(-number)
  }
}
