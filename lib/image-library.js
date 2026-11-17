// 图库：按内容指纹（sha256）缓存图片原图与识别描述。
//
// 纯存储层：只碰磁盘，不认识「识图」这件事，不 import 任何 DSH / cordis 代码。
// 目录结构（默认 <DSH 家目录>/fish-message-images/）：
//   index.json                      索引，原子写
//   img/<sha 前两位>/<sha>.<ext>    原图一份；keepFiles=false 时不存
//
// 语义是「缓存」，不是「收藏」：
//   1. 同 sha256 只留一份；已有描述不覆盖，除非调用方明确 force；
//   2. 超过条数 / 容量上限时，按 lastSeenAt 从旧到新静默淘汰（缓存允许丢旧数据）；
//   3. 索引写入走 fs-util 的原子写；单条条目坏了只丢那一条，不要让整个索引报废；
//   4. 磁盘错误抛 ImageLibraryError（带 code），「找不到」一律用 null / 空值表达。
//
// 与表情库（lib/stickers.js）刻意不共用底层：表情库是收藏语义（有标签、到上限报错、
// 绝不静默删），图库是缓存语义（允许淘汰）。两份代码可以长得像，但改一边不该牵动另一边。

import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, isAbsolute, join, relative as pathRelative, resolve } from 'node:path'
import { ensureDir, readJsonWithBackup, writeJsonAtomic } from './fs-util.js'

export const indexVersion = 1
export const defaultMaxItems = 1000
export const defaultMaxMB = 512
export const defaultDirName = 'fish-message-images'
/** 描述正文上限；识图结果是一两句，留足余量但不让单条把索引撑爆。 */
export const descMaxLength = 2000

const text = (value, fallback = '') => (value == null ? fallback : String(value).trim())
const toNumber = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 时间戳统一用本地 ISO 串（去掉毫秒），和表情库的写法保持一致。 */
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, '')

const hexSha = /^[0-9a-f]{64}$/
const hexKey = /^[0-9a-f]{8,64}$/

/** 指纹：只在内存里算，不碰磁盘。 */
export function hashBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new ImageLibraryError('image_library_bad_request', { hint: '图片内容是空的，算不出指纹。' })
  }
  return createHash('sha256').update(buffer).digest('hex')
}

/** 读本机文件算指纹；读不到抛 io 错误，由调用方决定要不要降级。 */
export function hashFile(path) {
  const file = text(path)
  if (!file || !isAbsolute(file)) {
    throw new ImageLibraryError('image_library_bad_request', { hint: '要算指纹的文件必须给本机绝对路径。', detail: file })
  }
  let buffer
  try {
    buffer = readFileSync(file)
  } catch (error) {
    throw new ImageLibraryError('image_library_io', {
      hint: `读不到图片文件：${file}`,
      detail: String(error?.message || error),
      cause: error,
    })
  }
  if (!buffer.length) {
    throw new ImageLibraryError('image_library_bad_request', { hint: `图片文件是空的：${file}`, detail: file })
  }
  return hashBuffer(buffer)
}

const mimeTable = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/** 扩展名 → mime；认不出就空串（图库不负责嗅探字节）。 */
export function mimeFromExt(ext) {
  const lower = String(ext || '').toLowerCase().replace(/^\./, '')
  return mimeTable[`.${lower}`] || ''
}

/** 规整扩展名：只留字母数字，带点、小写；认不出给空串。 */
function normalizeExt(value) {
  const raw = String(value || '').toLowerCase().trim()
  if (!raw) return ''
  const withDot = raw.startsWith('.') ? raw : `.${raw}`
  return /^\.[a-z0-9]{1,8}$/.test(withDot) ? withDot : ''
}

/** 结构化错误：code 给程序判断，hint 给人看。 */
export class ImageLibraryError extends Error {
  constructor(code, { hint = '', detail = '', cause } = {}) {
    const errorCode = String(code || 'image_library_error')
    super(detail || hint || errorCode)
    this.name = 'ImageLibraryError'
    this.code = errorCode
    this.hint = String(hint || '')
    this.detail = String(detail || '')
    if (cause !== undefined) this.cause = cause
  }
}

export class ImageLibrary {
  /**
   * @param {object} options
   * @param {string} options.dir 图库目录（绝对路径；相对路径按 DSH 家目录解析）
   * @param {number} [options.maxItems] 条数上限
   * @param {number} [options.maxMB] 原图总大小上限（MB）
   * @param {boolean} [options.keepFiles] 是否存原图；关掉只留描述与尺寸
   * @param {object} [options.logger]
   */
  constructor({ dir = '', maxItems = defaultMaxItems, maxMB = defaultMaxMB, keepFiles = true, logger = null } = {}) {
    this.logger = logger
    const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.dsh')
    const target = text(dir) || join(home, defaultDirName)
    // 相对路径按 DSH 家目录解析，避免跟着进程工作目录跑。
    this.dir = isAbsolute(target) ? resolve(target) : resolve(home, target)
    this.indexPath = join(this.dir, 'index.json')
    this.imgDir = join(this.dir, 'img')
    this.maxItems = maxItems
    this.maxMB = maxMB
    this.keepFiles = keepFiles !== false
    this.entries = []
    this.load()
  }

  // ---------------- 基础 ----------------

  /** 运行期改上限（设置页保存后调用），不重新读索引。 */
  configure({ maxItems, maxMB, keepFiles } = {}) {
    if (maxItems !== undefined) this.maxItems = maxItems
    if (maxMB !== undefined) this.maxMB = maxMB
    if (keepFiles !== undefined) this.keepFiles = keepFiles !== false
    return this.limits()
  }

  limits() {
    return {
      maxItems: Math.max(1, Math.trunc(toNumber(this.maxItems, defaultMaxItems))),
      maxMB: Math.max(1, toNumber(this.maxMB, defaultMaxMB)),
      keepFiles: this.keepFiles !== false,
    }
  }

  load() {
    ensureDir(this.imgDir)
    if (!existsSync(this.indexPath)) {
      this.entries = []
      return
    }
    // 整个索引读不出来时 readJsonWithBackup 会把原文件改名留档并 warn；这里按空索引继续。
    const disk = readJsonWithBackup(this.indexPath, null, { logger: this.logger, label: '图库索引' })
    if (!disk || typeof disk !== 'object') {
      this.entries = []
      return
    }
    const list = Array.isArray(disk) ? disk : (Array.isArray(disk.items) ? disk.items : [])
    const kept = []
    let dropped = 0
    for (const item of list) {
      const entry = this.normalizeEntry(item)
      if (entry) kept.push(entry)
      else dropped += 1
    }
    if (dropped) this.logger?.warn?.(`图库索引里有 ${dropped} 条条目读不出来，已丢弃（其余条目照常可用）`)
    this.entries = kept
  }

  /** 索引条目规整：字段不认识或路径越界都返回 null，由 load() 丢掉。 */
  normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null
    const sha256 = text(raw.sha256).toLowerCase()
    if (!hexSha.test(sha256)) return null
    const file = text(raw.file).replace(/\\/g, '/')
    if (file && !this.isInside(file)) return null
    const desc = text(raw.desc).slice(0, descMaxLength)
    return {
      sha256,
      file,
      ext: normalizeExt(raw.ext) || normalizeExt(file ? extname(file) : ''),
      mime: text(raw.mime) || mimeFromExt(extname(file)),
      bytes: Math.max(0, Math.round(toNumber(raw.bytes, 0))),
      width: Math.max(0, Math.round(toNumber(raw.width, 0))),
      height: Math.max(0, Math.round(toNumber(raw.height, 0))),
      desc,
      descSource: text(raw.descSource),
      descModel: text(raw.descModel),
      descAt: desc ? text(raw.descAt) : '',
      descFirstAt: desc ? (text(raw.descFirstAt) || text(raw.descAt)) : '',
      firstSeenAt: text(raw.firstSeenAt) || now(),
      lastSeenAt: text(raw.lastSeenAt) || text(raw.firstSeenAt) || now(),
      hits: Math.max(0, Math.round(toNumber(raw.hits, 0))),
      misses: Math.max(0, Math.round(toNumber(raw.misses, 0))),
    }
  }

  saveIndex() {
    const payload = { version: indexVersion, updatedAt: now(), items: this.entries }
    if (!writeJsonAtomic(this.indexPath, payload)) {
      throw new ImageLibraryError('image_library_io', {
        hint: '图库索引写不进去，请检查保存位置与磁盘空间。',
        detail: this.indexPath,
      })
    }
    return true
  }

  /** 相对路径是否落在图库目录内（拒绝绝对路径、盘符、..）。 */
  isInside(relativePath) {
    const parts = String(relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean)
    if (!parts.length) return false
    if (String(relativePath).startsWith('/') || /^[A-Za-z]:/.test(String(relativePath))) return false
    if (parts.includes('..')) return false
    const absolute = resolve(this.dir, ...parts)
    const inner = pathRelative(this.dir, absolute)
    return Boolean(inner) && !inner.startsWith('..') && !isAbsolute(inner)
  }

  absolutePath(relativePath) {
    const relativeFile = text(relativePath).replace(/\\/g, '/')
    if (!relativeFile || !this.isInside(relativeFile)) {
      throw new ImageLibraryError('image_library_bad_request', {
        hint: '图库文件路径超出图库范围。',
        detail: text(relativePath),
      })
    }
    return resolve(this.dir, ...relativeFile.split('/').filter(Boolean))
  }

  /** 对外条目额外带 path（绝对路径，可能已经不在了），path 不写进索引。 */
  decorate(entry) {
    if (!entry) return null
    let path = ''
    try {
      path = entry.file ? this.absolutePath(entry.file) : ''
    } catch { /* 路径坏了就当没有原图 */ }
    return { ...entry, path }
  }

  bySha(sha256) {
    const key = text(sha256).toLowerCase()
    if (!key) return null
    return this.entries.find((item) => item.sha256 === key) || null
  }

  // ---------------- 查询 ----------------

  /**
   * 按指纹取条目，只读、不产生副作用。
   * 64 位十六进制按完整指纹；8~63 位按前缀匹配（命中多张时返回 null，交给调用方去认）。
   */
  lookup(key) {
    const value = text(key).toLowerCase()
    if (!hexKey.test(value)) return null
    if (value.length === 64) {
      const exact = this.bySha(value)
      return exact ? this.decorate(exact) : null
    }
    const hits = this.entries.filter((item) => item.sha256.startsWith(value))
    return hits.length === 1 ? this.decorate(hits[0]) : null
  }

  /**
   * 只读列表：按「最近见到」倒序，关键词匹配描述 / 路径 / 指纹。
   * 图库管理页用它分页浏览；返回的条目带绝对路径（path），没有原图时为空串。
   *
   * @param {{q?: string, limit?: number, offset?: number}} [options]
   * @returns {{total:number, entries:object[]}}
   */
  list({ q = '', limit = 50, offset = 0 } = {}) {
    const keyword = text(q).toLowerCase()
    const matched = this.entries.filter((entry) => !keyword
      || [entry.desc, entry.file, entry.sha256, entry.descSource]
        .some((value) => text(value).toLowerCase().includes(keyword)))
    matched.sort((a, b) => String(b.lastSeenAt || b.firstSeenAt || '')
      .localeCompare(String(a.lastSeenAt || a.firstSeenAt || '')))
    const start = Math.max(0, Math.trunc(toNumber(offset, 0)))
    const size = Math.max(1, Math.min(200, Math.trunc(toNumber(limit, 50))))
    return { total: matched.length, entries: matched.slice(start, start + size).map((entry) => this.decorate(entry)) }
  }

  stats() {
    const { maxItems, maxMB, keepFiles } = this.limits()
    const bytes = this.usedBytes()
    const hits = this.entries.reduce((sum, item) => sum + item.hits, 0)
    const misses = this.entries.reduce((sum, item) => sum + item.misses, 0)
    return {
      count: this.entries.length,
      maxItems,
      maxMB,
      keepFiles,
      bytes,
      sizeMB: Math.round((bytes / 1048576) * 100) / 100,
      hits,
      misses,
      withDesc: this.entries.filter((item) => Boolean(item.desc)).length,
      withFile: this.entries.filter((item) => Boolean(item.file)).length,
      dir: this.dir,
      indexPath: this.indexPath,
    }
  }

  /** 库内在用的原图总字节；只统计真的存了原图的条目。 */
  usedBytes() {
    let total = 0
    for (const entry of this.entries) {
      if (entry.file) total += Math.max(0, toNumber(entry.bytes, 0))
    }
    return total
  }

  // ---------------- 写入 ----------------

  writeOriginal(relativeFile, buffer) {
    const target = this.absolutePath(relativeFile)
    ensureDir(dirname(target))
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temp, buffer)
      renameSync(temp, target)
    } catch (error) {
      try { rmSync(temp, { force: true }) } catch { /* 清不掉就算了 */ }
      throw new ImageLibraryError('image_library_io', {
        hint: '图库原图保存失败，请检查保存位置与磁盘空间。',
        detail: String(error?.message || error),
        cause: error,
      })
    }
  }

  /** 原图相对路径：img/<sha 前两位>/<sha><ext>，内容寻址，同 sha 永远同一路径。 */
  relativeFileFor(sha256, ext) {
    return `img/${sha256.slice(0, 2)}/${sha256}${normalizeExt(ext)}`
  }

  /**
   * 入库：同 sha 只留一份；已有描述不覆盖（force=true 才覆盖）。
   *
   * 创建时至少要给 buffer 或 path（keepFiles=false 时允许只有 sha + 描述）。
   * @returns {object} 条目（带 path）
   */
  remember(options = {}) {
    const input = options && typeof options === 'object' ? options : {}
    const { maxItems, maxMB, keepFiles } = this.limits()
    let buffer = Buffer.isBuffer(input.buffer) ? input.buffer : null
    const sourcePath = text(input.path)
    if (!buffer && sourcePath) {
      try {
        buffer = readFileSync(sourcePath)
      } catch (error) {
        throw new ImageLibraryError('image_library_bad_request', {
          hint: `读不到要入库的图片：${sourcePath}`,
          detail: String(error?.message || error),
          cause: error,
        })
      }
    }
    const sha256 = hexSha.test(text(input.sha256).toLowerCase())
      ? text(input.sha256).toLowerCase()
      : (buffer ? hashBuffer(buffer) : '')
    if (!sha256) {
      throw new ImageLibraryError('image_library_bad_request', {
        hint: '入库要给出图片内容（buffer / path）或完整指纹。',
        detail: sourcePath || '',
      })
    }

    const desc = text(input.desc).slice(0, descMaxLength)
    const descSource = text(input.descSource) || (desc ? 'manual' : '')
    const descModel = text(input.descModel)
    const stamp = now()
    const existing = this.bySha(sha256)

    if (existing) {
      let changed = false
      // 描述只补空：缓存语义下，旧描述比新识图更可能是人工确认过的。
      if (desc && (input.force === true || !existing.desc)) {
        existing.desc = desc
        existing.descSource = descSource
        existing.descModel = descModel
        existing.descAt = stamp
        if (!existing.descFirstAt) existing.descFirstAt = stamp
        changed = true
      }
      if (!existing.file && keepFiles && buffer) {
        const relativeFile = this.relativeFileFor(sha256, input.ext || existing.ext)
        this.writeOriginal(relativeFile, buffer)
        existing.file = relativeFile
        existing.bytes = buffer.length
        existing.ext = normalizeExt(input.ext) || existing.ext
        existing.mime = text(input.mime) || existing.mime || mimeFromExt(existing.ext)
        changed = true
      }
      if (!existing.width && toNumber(input.width, 0) > 0) {
        existing.width = Math.round(toNumber(input.width, 0))
        existing.height = Math.round(toNumber(input.height, 0))
        changed = true
      }
      if (changed) this.saveIndex()
      this.pruneQuietly()
      return this.decorate(existing)
    }

    if (!buffer && !desc) {
      throw new ImageLibraryError('image_library_bad_request', {
        hint: '没有原图也没有描述，入库没有意义。',
        detail: sha256.slice(0, 12),
      })
    }
    if (!buffer && keepFiles) {
      throw new ImageLibraryError('image_library_bad_request', {
        hint: '图库开了「存原图」，但没有拿到图片内容，无法入库。',
        detail: sha256.slice(0, 12),
      })
    }

    const ext = normalizeExt(input.ext) || normalizeExt(sourcePath ? extname(sourcePath) : '')
    const entry = {
      sha256,
      file: '',
      ext,
      mime: text(input.mime) || mimeFromExt(ext),
      bytes: 0,
      width: Math.max(0, Math.round(toNumber(input.width, 0))),
      height: Math.max(0, Math.round(toNumber(input.height, 0))),
      desc,
      descSource,
      descModel,
      descAt: desc ? stamp : '',
      descFirstAt: desc ? stamp : '',
      firstSeenAt: stamp,
      lastSeenAt: stamp,
      hits: 0,
      misses: 0,
    }
    if (keepFiles && buffer) {
      entry.file = this.relativeFileFor(sha256, ext)
      this.writeOriginal(entry.file, buffer)
      entry.bytes = buffer.length
    }
    this.entries.push(entry)
    try {
      this.saveIndex()
    } catch (error) {
      // 索引没写进去就把刚写的原图撤掉，避免孤文件。
      this.entries.pop()
      if (entry.file) {
        try { rmSync(this.absolutePath(entry.file), { force: true }) } catch { /* 忽略 */ }
      }
      throw error
    }
    this.logger?.debug?.(`图库入库：${sha256.slice(0, 12)}${entry.desc ? '（含描述）' : '（无描述）'}，当前 ${this.entries.length}/${maxItems} 条、${Math.round(this.usedBytes() / 1048576 * 10) / 10}/${maxMB}MB`)
    this.pruneQuietly()
    return this.decorate(this.bySha(sha256) || entry)
  }

  /**
   * 回填 / 修改描述。条目不存在返回 null（不抛「找不到」）。
   * @returns {object|null} 更新后的条目
   */
  setDesc(sha256, desc, { descSource = 'manual', descModel = '' } = {}) {
    const entry = this.bySha(text(sha256).toLowerCase())
    if (!entry) return null
    const clean = text(desc).slice(0, descMaxLength)
    entry.desc = clean
    entry.descSource = text(descSource) || 'manual'
    entry.descModel = text(descModel)
    entry.descAt = clean ? now() : ''
    if (!clean) entry.descFirstAt = ''
    else if (!entry.descFirstAt) entry.descFirstAt = entry.descAt
    this.saveIndex()
    return this.decorate(entry)
  }

  /**
   * 命中复用：已有描述直接用，或同一张图第二次及以后出现。计数 + 刷新 lastSeenAt。
   * 条目不存在返回 null。命中次数就是这条图被复用的次数，界面「命中 N 次」读它。
   */
  noteHit(sha256) {
    return this.noteSeen(sha256, 'hits')
  }

  /**
   * 首次见到（图库里还没有这张图，刚登记）：计数 + 刷新 lastSeenAt。条目不存在返回 null。
   * 与 noteHit 合起来的约定：每次见到恰好让 hits 或 misses 其中之一 +1；首次记 misses，
   * 之后记 hits，所以 hits + misses 等于「第几次见到」。
   */
  noteMiss(sha256) {
    return this.noteSeen(sha256, 'misses')
  }

  noteSeen(sha256, field) {
    const entry = this.bySha(text(sha256).toLowerCase())
    if (!entry) return null
    entry[field] = Math.max(0, Math.round(toNumber(entry[field], 0))) + 1
    entry.lastSeenAt = now()
    this.saveIndex()
    return this.decorate(entry)
  }

  // ---------------- 淘汰 / 清空 ----------------

  /**
   * 按上限淘汰：先按 lastSeenAt 从旧到新删，直到条数与占用都不超限。
   * 缓存语义允许静默删，调用方不需要处理「被删了」。
   * @returns {{removed:number, freedBytes:number}}
   */
  prune() {
    const { maxItems, maxMB } = this.limits()
    const maxBytes = maxMB * 1048576
    let removed = 0
    let freedBytes = 0
    const ordered = () => [...this.entries].sort((a, b) => {
      const bySeen = String(a.lastSeenAt || a.firstSeenAt || '').localeCompare(String(b.lastSeenAt || b.firstSeenAt || ''))
      if (bySeen) return bySeen
      return String(a.firstSeenAt || '').localeCompare(String(b.firstSeenAt || ''))
    })
    while (this.entries.length > maxItems || this.usedBytes() > maxBytes) {
      const [oldest] = ordered()
      if (!oldest) break
      this.entries = this.entries.filter((item) => item !== oldest)
      removed += 1
      freedBytes += Math.max(0, toNumber(oldest.bytes, 0))
      if (oldest.file) {
        try { rmSync(this.absolutePath(oldest.file), { force: true }) } catch { /* 删不掉也不影响索引 */ }
      }
    }
    if (removed) {
      this.saveIndex()
      this.logger?.info?.(`图库超出上限，已淘汰 ${removed} 张最久没见的图（释放 ${Math.round(freedBytes / 1048576 * 10) / 10}MB）`)
    }
    return { removed, freedBytes }
  }

  /** 记住时顺手淘汰；淘汰失败只记日志，别让一次写库失败毁掉整条消息。 */
  pruneQuietly() {
    try {
      return this.prune()
    } catch (error) {
      this.logger?.warn?.(`图库淘汰失败（不影响本次入库）：${String(error?.message || error)}`)
      return { removed: 0, freedBytes: 0 }
    }
  }

  /** 清空图库：条目、原图、索引一起清。返回删掉的条数与释放的字节数。 */
  clear() {
    const removed = this.entries.length
    let freedBytes = 0
    let fileRemoved = 0
    let failed = null
    for (const entry of this.entries) {
      if (!entry.file) continue
      freedBytes += Math.max(0, toNumber(entry.bytes, 0))
      try {
        rmSync(this.absolutePath(entry.file), { force: true })
        fileRemoved += 1
      } catch (error) {
        failed = failed || error
      }
    }
    try {
      rmSync(this.imgDir, { recursive: true, force: true })
    } catch (error) {
      failed = failed || error
    }
    this.entries = []
    ensureDir(this.imgDir)
    try {
      this.saveIndex()
    } catch (error) {
      failed = failed || error
      throw error
    }
    if (failed) {
      this.logger?.warn?.(`清空图库时有个别文件删不掉：${String(failed?.message || failed)}`)
    }
    this.logger?.info?.(`图库已清空：${removed} 条、释放 ${Math.round(freedBytes / 1048576 * 10) / 10}MB`)
    return { removed, fileRemoved, freedBytes }
  }

  /** 原图是否还在本机（inbox 会被清理，所以取图前要确认）。 */
  hasFile(entry) {
    if (!entry || !entry.file) return false
    try {
      return statSync(this.absolutePath(entry.file)).isFile()
    } catch {
      return false
    }
  }
}
