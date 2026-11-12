// 表情库：索引、入库、去重、标签、搜索、导入、清理。
//
// 目录结构（默认 <DSH 家目录>/fish-message-stickers/，可用 stickerDir 改）：
//   index.json        索引，原子写
//   gif/*.gif         动图
//   img/*.png|jpg|webp|bmp
//
// 索引条目（字段顺序与 Python 表情库工具保持兼容）：
//   { id, file, type:'gif'|'img', sha256, size_kb, width, height,
//     frames?, duration_s?, tags:[], desc, source, added_at,
//     used_count, last_used_at }
//
// 设计口径：
//   1. 入库按 sha256 去重：同内容只留一份文件，标签取并集；
//   2. 上限（条数 / 总 MB）只在**新增**时检查，超上限给明确错误，绝不静默删；
//   3. 索引写入统一走 fs-util 的原子写；文件先写临时名再 rename，避免半截文件；
//   4. 所有对外返回的条目额外带 path（绝对路径），但 path 不写进索引；
//   5. 这个模块只碰磁盘，不碰网络、不碰 DSH，方便单测。

import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative as pathRelative, resolve, sep } from 'node:path'
import { ensureDir, readJson, writeJsonAtomic } from './fs-util.js'

export const indexVersion = 1
export const defaultMaxItemNumber = 2000
export const defaultMaxMB = 1024
export const defaultInboxDirName = 'fish-message-stickers'
/** Windows 上 Python 表情库的默认位置；一键导入用，路由可覆盖。 */
export const defaultImportDir = 'D:\\dsh_ws\\表情库'

const text = (value, fallback = '') => (value == null ? fallback : String(value).trim())
const toNumber = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, '')

/** 结构化错误：code 给程序判断，hint 给人看。 */
export class StickerError extends Error {
  constructor(code, { hint = '', detail = '', cause } = {}) {
    const errorCode = String(code || 'sticker_error')
    super(detail || hint || errorCode)
    this.name = 'StickerError'
    this.code = errorCode
    this.hint = String(hint || '')
    this.detail = String(detail || '')
    if (cause !== undefined) this.cause = cause
  }
}

/** 标签规整：接受数组或「逗号/顿号/分号/#」分隔的字符串；去重、限长。 */
export function normalizeTags(input, { maxCount = 16, eachMaxLength = 32 } = {}) {
  const original = Array.isArray(input)
    ? input
    : (input == null ? [] : String(input).split(/[,，、;；#]+/))
  const out = []
  const seen = new Set()
  for (const item of original) {
    let mark = text(item).replace(/^#+/, '').trim()
    if (!mark) continue
    if (mark.length > eachMaxLength) mark = mark.slice(0, eachMaxLength)
    const key = mark.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(mark)
    if (out.length >= maxCount) break
  }
  return out
}

/** 文件名安全化：去掉 Windows 非法字符与路径分隔符，保留中文。 */
export function safeFileName(name, fallback = 'sticker') {
  let value = text(name)
  try { value = decodeURIComponent(value) } catch { /* 不是编码就按原文 */ }
  value = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim()
  value = value.replace(/^[.\s]+/, '')
  if (!value) value = fallback
  if (value.length > 80) {
    const ext = extname(value)
    value = `${value.slice(0, Math.max(1, 80 - ext.length))}${ext}`
  }
  return value
}

// ---------------- 图片头解析（不依赖任何图形库） ----------------

function skipGifSubBlocks(buf, p) {
  let i = p
  while (i < buf.length) {
    const n = buf[i]
    i += 1
    if (!n) break
    i += n
  }
  return i
}

/** GIF：逻辑屏幕宽高 + 帧数 + 总时长（按 GCE 延迟累加）。 */
function readGif(buf) {
  const header = buf.toString('latin1', 0, 6)
  if (header !== 'GIF87a' && header !== 'GIF89a') return null
  if (buf.length < 13) return { width: 0, height: 0, frames: 0, duration_s: 0 }
  const width = buf.readUInt16LE(6)
  const height = buf.readUInt16LE(8)
  const globalMap = buf[10]
  let p = 13
  if (globalMap & 0x80) p += 3 * (1 << ((globalMap & 0x07) + 1))
  let frames = 0
  let delayCentiseconds = 0
  while (p < buf.length) {
    const block = buf[p]
    if (block === 0x3b) break // trailer
    if (block === 0x21) {
      // 扩展块：GCE 记延迟，其它扩展跳过子块。
      const tags = buf[p + 1]
      p += 2
      if (tags === 0xf9) {
        const size = buf[p] || 0
        if (size >= 4 && p + 4 < buf.length) delayCentiseconds += buf.readUInt16LE(p + 2)
        p += 1 + size + 1
      } else {
        p = skipGifSubBlocks(buf, p)
      }
      continue
    }
    if (block === 0x2c) {
      // 图像描述符：10 字节头 + 可选局部色表 + LZW 最小码长 + 子块。
      frames += 1
      if (p + 9 >= buf.length) break
      const localMap = buf[p + 9]
      p += 10
      if (localMap & 0x80) p += 3 * (1 << ((localMap & 0x07) + 1))
      p += 1
      p = skipGifSubBlocks(buf, p)
      continue
    }
    break
  }
  return {
    width,
    height,
    frames,
    duration_s: Math.round(delayCentiseconds) / 100,
  }
}

/** PNG：IHDR 宽高。 */
function readPng(buf) {
  if (buf.length < 8) return null
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null
  if (buf.length < 24) return { width: 0, height: 0 }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** JPEG：扫 SOF 标记取宽高。 */
function readJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let p = 2
  while (p + 1 < buf.length) {
    if (buf[p] !== 0xff) { p += 1; continue }
    const mark = buf[p + 1]
    p += 2
    if (mark === 0xd8 || mark === 0xd9 || (mark >= 0xd0 && mark <= 0xd7)) continue
    if (p + 1 >= buf.length) break
    const long = buf.readUInt16BE(p)
    if (long < 2) break
    if (mark >= 0xc0 && mark <= 0xcf && mark !== 0xc4 && mark !== 0xc8 && mark !== 0xcc) {
      if (p + 6 < buf.length) {
        return { width: buf.readUInt16BE(p + 5), height: buf.readUInt16BE(p + 3) }
      }
      break
    }
    p += long
  }
  return { width: 0, height: 0 }
}

/** WebP：只认 VP8X（扩展格式）的 canvas 尺寸；其它分支给 0。 */
function readWebp(buf) {
  if (buf.length < 30) return null
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null
  if (buf.toString('latin1', 12, 16) !== 'VP8X') return { width: 0, height: 0 }
  return {
    width: 1 + buf.readUIntLE(24, 3),
    height: 1 + buf.readUIntLE(27, 3),
  }
}

/**
 * 识别图片格式并读尺寸/帧数。
 * @returns {{ext:string, mime:string, type:'gif'|'img', width:number, height:number, frames?:number, duration_s?:number}|null}
 */
export function readPictureInfo(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null
  const gif = readGif(buf)
  if (gif) {
    return {
      ext: '.gif',
      mime: 'image/gif',
      type: 'gif',
      width: gif.width,
      height: gif.height,
      frames: gif.frames,
      duration_s: gif.duration_s,
    }
  }
  const png = readPng(buf)
  if (png) return { ext: '.png', mime: 'image/png', type: 'img', ...png }
  const jpg = readJpeg(buf)
  if (jpg) return { ext: '.jpg', mime: 'image/jpeg', type: 'img', ...jpg }
  const webp = readWebp(buf)
  if (webp) return { ext: '.webp', mime: 'image/webp', type: 'img', ...webp }
  if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return {
      ext: '.bmp',
      mime: 'image/bmp',
      type: 'img',
      width: buf.length >= 26 ? buf.readInt32LE(18) : 0,
      height: buf.length >= 26 ? Math.abs(buf.readInt32LE(22)) : 0,
    }
  }
  return null
}

const extAllowList = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp', '.bmp'])

/** 按扩展名给 HTTP content-type。 */
export function imageMime(path) {
  const ext = extname(String(path || '')).toLowerCase()
  const table = {
    '.gif': 'image/gif',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  }
  return table[ext] || ''
}

// ---------------- 表情库 ----------------

export class StickerStore {
  /**
   * @param {object} options
   * @param {string} options.dir 库目录；省略时读 getConfig().stickerDir
   * @param {string} [options.inboxDir] 入站图片目录（最近图片/清理用）
   * @param {() => object} [options.getConfig]
   * @param {object} [options.logger]
   * @param {number} [options.maxCount] 覆盖配置上限（单测用）
   * @param {number} [options.maxMB] 覆盖配置上限（单测用）
   */
  constructor({ dir = '', getConfig = () => ({}), inboxDir = '', logger = null, maxCount, maxMB } = {}) {
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({})
    this.logger = logger
    this.inboxDir = text(inboxDir)
    this.fixedMaxItemNumber = maxCount
    this.fixedMaxMB = maxMB
    const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.dsh')
    const configDir = text(dir) || text(this.getConfig().stickerDir) || join(home, defaultInboxDirName)
    // 相对路径按 DSH 家目录解析，避免跟着进程工作目录跑。
    this.dir = isAbsolute(configDir) ? resolve(configDir) : resolve(home, configDir)
    this.indexPath = join(this.dir, 'index.json')
    this.entries = []
    this.load()
  }

  // ---- 基础 ----

  /** 设置页改了 stickerDir：就地换目录并重新读索引，实例引用不变。 */
  enterDir(nextDir) {
    const target = resolve(text(nextDir))
    if (!target || target === this.dir) return this.dir
    this.dir = target
    this.indexPath = join(this.dir, 'index.json')
    this.entries = []
    this.load()
    this.logger?.info?.(`表情库目录切到 ${this.dir}`)
    return this.dir
  }

  limits() {
    const config = this.getConfig() || {}
    return {
      maxCount: Math.max(1, Math.floor(toNumber(this.fixedMaxItemNumber ?? config.stickerMaxCount, defaultMaxItemNumber))),
      maxMB: Math.max(1, toNumber(this.fixedMaxMB ?? config.stickerMaxMB, defaultMaxMB)),
    }
  }

  load() {
    ensureDir(join(this.dir, 'gif'))
    ensureDir(join(this.dir, 'img'))
    if (!existsSync(this.indexPath)) {
      this.entries = []
      return
    }    const disk = readJson(this.indexPath, null)
    if (!disk || typeof disk !== 'object') {
      // 索引坏了不要静默清空：留一份备份再从空开始，方便人工恢复。
      try {
        const backup = `${this.indexPath}.bad-${Date.now()}`
        renameSync(this.indexPath, backup)
        this.logger?.warn?.(`表情索引读不出来，已备份到 ${backup}，从空索引开始`)
      } catch (error) {
        this.logger?.error?.(`表情索引读不出来，备份也失败：${String(error?.message || error)}`)
      }
      this.entries = []
      return
    }
    const list = Array.isArray(disk) ? disk : (Array.isArray(disk.stickers) ? disk.stickers : [])
    this.entries = list.map((x) => this.normalizeEntry(x)).filter(Boolean)
  }

  normalizeEntry(original) {
    if (!original || typeof original !== 'object') return null
    const id = text(original.id)
    const file = text(original.file).replace(/\\/g, '/')
    if (!id || !file) return null
    // 索引可能被手改/迁移过：带 ..、绝对路径、盘符的条目直接丢弃，避免删/读越界。
    const segment = file.split('/').filter(Boolean)
    if (!segment.length || file.startsWith('/') || /^[A-Za-z]:/.test(file) || segment.includes('..')) return null
    const type = original.type === 'gif' || /\.gif$/i.test(file) ? 'gif' : 'img'
    return {
      id,
      file,
      type,
      sha256: text(original.sha256),
      size_kb: Math.max(0, Math.round(toNumber(original.size_kb, 0))),
      width: Math.max(0, Math.round(toNumber(original.width, 0))),
      height: Math.max(0, Math.round(toNumber(original.height, 0))),
      ...(type === 'gif' ? { frames: Math.max(0, Math.round(toNumber(original.frames, 0))) } : {}),
      ...(type === 'gif' ? { duration_s: Math.max(0, toNumber(original.duration_s, 0)) } : {}),      tags: normalizeTags(original.tags),
      desc: text(original.desc).slice(0, 500),
      source: text(original.source).slice(0, 200),
      added_at: text(original.added_at) || now(),
      used_count: Math.max(0, Math.round(toNumber(original.used_count, 0))),
      last_used_at: text(original.last_used_at),
    }
  }

  saveIndex() {
    const disk = { version: indexVersion, updatedAt: now(), stickers: this.entries }
    if (!writeJsonAtomic(this.indexPath, disk)) {
      throw new StickerError('sticker_io', {
        hint: '表情库索引无法写入，请检查保存位置与磁盘空间。',
        detail: this.indexPath,
      })
    }
    return true
  }

  decorate(entry) {
    if (!entry) return null
    return { ...entry, path: this.absolutePath(entry.file) }
  }

  absolutePath(relative) {
    const target = resolve(this.dir, ...String(relative || '').replace(/\\/g, '/').split('/').filter(Boolean))
    const inner = pathRelative(this.dir, target)
    if (!inner || inner.startsWith('..') || isAbsolute(inner)) {
      throw new StickerError('sticker_bad_request', {
        hint: '表情文件路径超出表情库范围。',
        detail: text(relative),
      })
    }
    return target
  }

  bySha(sha) {
    if (!sha) return null
    return this.entries.find((x) => x.sha256 === sha) || null
  }

  byId(id) {
    const key = text(id)
    if (!key) return null
    return this.entries.find((x) => x.id === key) || null
  }

  /** 造一个不会和现有 id 撞的 12 位十六进制 id（取自 sha）。 */
  makeId(sha) {
    const baseId = String(sha || '').slice(0, 12) || createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 12)
    if (!this.byId(baseId)) return baseId
    for (let i = 0; i < 100; i++) {
      const tryIt = createHash('sha256').update(`${sha}:${i}`).digest('hex').slice(0, 12)
      if (!this.byId(tryIt)) return tryIt
    }
    return createHash('sha256').update(`${sha}:${Date.now()}`).digest('hex').slice(0, 12)
  }

  /** 目标文件名：沿用来源名；同名的不同内容追加 sha 前 8 位。 */
  makeFileName(name, sha, info) {
    let stem = safeFileName(name || '', 'sticker')
    let ext = extname(stem).toLowerCase()
    if (!extAllowList.has(ext)) {
      ext = info.ext
      stem = `${stem}${ext}`
    }
    // 扩展名以真实内容为准：内容 GIF 就存 .gif，避免 NapCat 按扩展名判错。
    if (extname(stem).toLowerCase() !== info.ext) stem = `${stem.slice(0, Math.max(1, stem.length - extname(stem).length))}${info.ext}`
    const dir = info.type === 'gif' ? 'gif' : 'img'
    const used = new Set(this.entries.map((x) => x.file.toLowerCase()))
    let relative = `${dir}/${stem}`
    if (!used.has(relative.toLowerCase())) return relative
    const stripExt = stem.slice(0, stem.length - extname(stem).length)
    for (let i = 0; i < 50; i++) {
      const tryIt = `${stripExt}-${String(sha).slice(0, 8)}${i ? `-${i}` : ''}${info.ext}`
      relative = `${dir}/${tryIt}`
      if (!used.has(relative.toLowerCase())) return relative
    }
    return `${dir}/${stripExt}-${Date.now()}${info.ext}`
  }

  checkCapacity(nextBytes) {
    const { maxCount, maxMB } = this.limits()
    if (this.entries.length >= maxCount) {
      throw new StickerError('sticker_limit', {
        hint: `表情库已达到 ${maxCount} 条上限，请清理后再添加。`,
        detail: `count=${this.entries.length}, max=${maxCount}`,
      })
    }
    const currentBytes = this.usedBytes()
    if (currentBytes + nextBytes > maxMB * 1024 * 1024) {
      throw new StickerError('sticker_limit', {
        hint: `表情库已达到 ${maxMB}MB 上限（当前 ${(currentBytes / 1048576).toFixed(1)}MB，本次 ${(nextBytes / 1048576).toFixed(1)}MB），请清理后再添加。`,
        detail: `used=${currentBytes}, add=${nextBytes}, max=${maxMB}MB`,
      })
    }
  }

  usedBytes() {
    let total = 0
    for (const x of this.entries) {
      try {
        total += statSync(this.absolutePath(x.file)).size
      } catch {
        total += Math.max(0, toNumber(x.size_kb, 0)) * 1024
      }
    }
    return total
  }

  writeFile(relative, buf) {
    const target = this.absolutePath(relative)
    ensureDir(dirname(target))
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temp, buf)
      renameSync(temp, target)
    } catch (error) {
      try { rmSync(temp, { force: true }) } catch { /* 清不掉就算了 */ }
      throw new StickerError('sticker_io', {
        hint: '表情文件无法保存，请检查保存位置与磁盘空间。',
        detail: String(error?.message || error),
        cause: error,
      })
    }
  }

  // ---- 入库 ----

  /**
   * 入库。同 sha256 已存在时不复制新文件，只合并标签/描述并返回旧条目。
   * @param {string|Buffer} pathOrBuffer 本机图片路径或图片字节
   * @param {{tags?:string[]|string, desc?:string, source?:string, name?:string}} [选项]
   * @returns {{ok:boolean, created:boolean, merged:boolean, entry:object}}
   */
  save(pathOrBuffer, options = {}) {
    let buf
    let sourcePath = ''
    if (Buffer.isBuffer(pathOrBuffer)) {
      buf = pathOrBuffer
    } else {
      sourcePath = text(pathOrBuffer)
      if (!sourcePath) {
        throw new StickerError('sticker_bad_request', { hint: '请提供图片文件或图片内容。' })
      }
      if (!isAbsolute(sourcePath)) {
        throw new StickerError('sticker_bad_request', { hint: '请提供本机图片的完整路径。', detail: sourcePath })
      }
      try {
        buf = readFileSync(sourcePath)
      } catch (error) {
        throw new StickerError('sticker_bad_request', {
          hint: `无法读取图片：${sourcePath}`,
          detail: String(error?.message || error),
          cause: error,
        })
      }
    }
    if (!buf || !buf.length) {
      throw new StickerError('sticker_bad_request', { hint: '图片内容为空。' })
    }
    const info = readPictureInfo(buf)
    if (!info) {
      throw new StickerError('sticker_bad_request', {
        hint: '仅支持 GIF、PNG、JPEG、WebP、BMP 格式的图片。',
        detail: sourcePath || 'buffer',
      })
    }

    const sha = createHash('sha256').update(buf).digest('hex')
    const existing = this.bySha(sha)
    if (existing) {
      const merge = this.mergeTags(existing, options)
      existing.tags = merge
      const nextDescription = text(options.desc).slice(0, 500)
      if (nextDescription && !existing.desc) existing.desc = nextDescription
      if (!existing.source && text(options.source)) existing.source = text(options.source).slice(0, 200)
      this.saveIndex()
      return { ok: true, created: false, merged: true, entry: this.decorate(existing) }
    }

    this.checkCapacity(buf.length)
    const relative = this.makeFileName(options.name || basename(sourcePath || '') || 'sticker', sha, info)
    this.writeFile(relative, buf)
    const entry = {
      id: this.makeId(sha),
      file: relative,
      type: info.type,
      sha256: sha,
      size_kb: Math.max(1, Math.round(buf.length / 1024)),
      width: info.width,
      height: info.height,
      ...(info.type === 'gif' ? { frames: info.frames || 0, duration_s: info.duration_s || 0 } : {}),
      tags: normalizeTags(options.tags),
      desc: text(options.desc).slice(0, 500),
      source: text(options.source).slice(0, 200),
      added_at: now(),
      used_count: 0,
      last_used_at: '',
    }
    this.entries.push(entry)
    try {
      this.saveIndex()
    } catch (error) {
      // 索引没写进去就把刚复制的文件撤掉，避免变成孤儿文件。
      this.entries.pop()
      try { rmSync(this.absolutePath(relative), { force: true }) } catch { /* 忽略 */ }
      throw error
    }
    this.logger?.info?.(`表情入库：${entry.file}（${entry.size_kb}KB，${entry.type}）`)
    return { ok: true, created: true, merged: false, entry: this.decorate(entry) }
  }

  mergeTags(entry, options) {
    return normalizeTags([...(entry.tags || []), ...normalizeTags(options?.tags)])
  }

  // ---- 查询 ----

  /**
   * 列表 / 搜索。
   * @param {{q?:string, tag?:string, limit?:number, offset?:number, sort?:'used'|'recent'|'name'}} [选项]
   */
  list(options = {}) {
    const q = text(options.q).toLowerCase()
    const tag = text(options.tag).replace(/^#+/, '').toLowerCase()
    const sort = ['used', 'recent', 'name'].includes(options.sort) ? options.sort : 'used'
    const limit = Math.max(1, Math.min(500, Math.round(toNumber(options.limit, 50))))
    const offset = Math.max(0, Math.round(toNumber(options.offset, 0)))

    let hit = this.entries
    if (tag) hit = hit.filter((x) => (x.tags || []).some((t) => t.toLowerCase() === tag))
    if (q) {
      hit = hit.filter((x) => {
        const fileName = basename(x.file).toLowerCase()
        const noExt = basename(x.file, extname(x.file)).toLowerCase()
        return x.id.toLowerCase().includes(q)
          || x.file.toLowerCase().includes(q)
          || fileName.includes(q)
          || noExt.includes(q)
          || (x.desc || '').toLowerCase().includes(q)
          || (x.tags || []).some((t) => t.toLowerCase().includes(q))
      })
    }
    hit = [...hit].sort((a, b) => {
      if (sort === 'name') return basename(a.file).localeCompare(basename(b.file), 'zh-CN')
      if (sort === 'recent') return String(b.added_at).localeCompare(String(a.added_at))
      return (b.used_count || 0) - (a.used_count || 0)
        || String(b.last_used_at || '').localeCompare(String(a.last_used_at || ''))
        || String(b.added_at).localeCompare(String(a.added_at))
    })
    const page = hit.slice(offset, offset + limit)
    return {
      items: page.map((x) => this.decorate(x)),
      total: hit.length,
      offset,
      limit,
      stats: this.stats(),
      tags: this.tagsStats(),
    }
  }

  tagsStats() {
    const table = new Map()
    for (const x of this.entries) {
      for (const t of x.tags || []) table.set(t, (table.get(t) || 0) + 1)
    }
    return [...table.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
      .map(([tag, count]) => ({ tag, count }))
  }

  stats() {
    const { maxCount, maxMB } = this.limits()
    const bytes = this.usedBytes()
    return {
      count: this.entries.length,
      maxCount,
      totalBytes: bytes,
      sizeMB: Math.round((bytes / 1048576) * 10) / 10,
      maxMB,
      used: this.entries.filter((x) => (x.used_count || 0) > 0).length,
      unused: this.entries.filter((x) => (x.used_count || 0) === 0).length,
      dir: this.dir,
      indexPath: this.indexPath,
    }
  }

  /** 名字解析：id / 文件名（含扩展名或不含）/ #标签 / 描述模糊匹配。 */
  find(name) {
    const q = text(name)
    if (!q) return null
    if (q.startsWith('#')) {
      const tag = q.slice(1).toLowerCase()
      if (!tag) return null
      const hit = this.entries.filter((x) => (x.tags || []).some((t) => t.toLowerCase() === tag))
      if (!hit.length) return null
      const rotate = [...hit].sort((a, b) => (a.used_count || 0) - (b.used_count || 0)
        || String(a.last_used_at || '').localeCompare(String(b.last_used_at || ''))
        || String(a.added_at).localeCompare(String(b.added_at)))
      return { entry: rotate[0], matches: hit, matchedBy: 'tag' }
    }
    const originalId = this.byId(q)
    if (originalId) return { entry: originalId, matches: [originalId], matchedBy: 'id' }
    const originalName = this.entries.find((x) => x.file === q
      || basename(x.file) === q
      || basename(x.file, extname(x.file)) === q)
    if (originalName) return { entry: originalName, matches: [originalName], matchedBy: 'name' }

    const lowercase = q.toLowerCase()
    const fuzzy = this.entries.filter((x) => basename(x.file, extname(x.file)).toLowerCase().includes(lowercase)
      || basename(x.file).toLowerCase().includes(lowercase)
      || (x.desc || '').toLowerCase().includes(lowercase)
      || (x.tags || []).some((t) => t.toLowerCase().includes(lowercase)))
    if (!fuzzy.length) return null
    // 多个命中时挑「用得最少、最久没用」的，天然形成轮换。
    fuzzy.sort((a, b) => (a.used_count || 0) - (b.used_count || 0)
      || String(a.last_used_at || '').localeCompare(String(b.last_used_at || ''))
      || String(a.added_at).localeCompare(String(b.added_at)))
    return { entry: fuzzy[0], matches: fuzzy, matchedBy: 'fuzzy' }
  }

  /** 取一个条目（带 path）；找不到返回 null。 */
  get(idOrName) {
    const middle = this.find(idOrName)
    return middle ? this.decorate(middle.entry) : null
  }

  /** 发指令用：解析名字，找不到给结构化错误。 */
  resolve(name) {
    const middle = this.find(name)
    if (!middle) {
      throw new StickerError('sticker_not_found', {
        hint: `找不到表情「${text(name)}」，请使用设置页「表情包」中的名称或标签重试。`,
        detail: text(name),
      })
    }
    return { ...this.decorate(middle.entry), matchedBy: middle.matchedBy, matchCount: middle.matches.length }
  }

  // ---- 修改 ----

  update(id, patch = {}) {
    const entry = this.byId(id)
    if (!entry) {
      throw new StickerError('sticker_not_found', { hint: '找不到该表情。' })
    }
    if (patch.tags !== undefined) entry.tags = normalizeTags(patch.tags)
    if (patch.desc !== undefined) entry.desc = text(patch.desc).slice(0, 500)
    if (patch.source !== undefined) entry.source = text(patch.source).slice(0, 200)
    if (patch.name !== undefined && text(patch.name)) {
      const newName = this.makeRename(entry, patch.name)
      if (newName && newName !== entry.file) {
        const oldAbsolute = this.absolutePath(entry.file)
        const newAbsolute = this.absolutePath(newName)
        if (existsSync(newAbsolute)) {
          throw new StickerError('sticker_bad_request', {
            hint: `重命名失败：已存在同名表情「${newName}」。`,
            detail: newName,
          })
        }
        try {
          ensureDir(dirname(newAbsolute))
          renameSync(oldAbsolute, newAbsolute)
        } catch (error) {
          throw new StickerError('sticker_io', {
            hint: `重命名失败：${String(error?.message || error)}`,
            detail: newName,
            cause: error,
          })
        }
        entry.file = newName
      }
    }
    this.saveIndex()
    return this.decorate(entry)
  }

  makeRename(entry, name) {
    const dir = entry.type === 'gif' ? 'gif' : 'img'
    let stem = safeFileName(name, basename(entry.file, extname(entry.file)))
    let ext = extname(stem).toLowerCase()
    if (!extAllowList.has(ext)) ext = extname(entry.file).toLowerCase()
    stem = `${stem.slice(0, Math.max(1, stem.length - extname(stem).length))}${ext}`
    return `${dir}/${stem}`
  }

  delete(id, { removeFile = true } = {}) {
    const position = this.entries.findIndex((x) => x.id === text(id))
    if (position < 0) {
      throw new StickerError('sticker_not_found', { hint: '找不到该表情。' })
    }
    const [entry] = this.entries.splice(position, 1)
    this.saveIndex()
    let deletedFile = false
    if (removeFile) {
      try {
        rmSync(this.absolutePath(entry.file), { force: true })
        deletedFile = true
      } catch (error) {
        this.logger?.warn?.(`表情文件删不掉：${entry.file}｜${String(error?.message || error)}`)
      }
    }
    return { ok: true, deleted: true, id: entry.id, file: entry.file, fileRemoved: deletedFile }
  }

  /** 使用计数：发送成功后调用。 */
  bump(id) {
    const entry = this.byId(id)
    if (!entry) return null
    entry.used_count = Math.max(0, Math.round(toNumber(entry.used_count, 0))) + 1
    entry.last_used_at = now()
    this.saveIndex()
    return this.decorate(entry)
  }

  // ---- 导入 / 清理 ----

  /**
   * 从 Python 表情库目录导入：读 index.json，把条目转成本库格式，按 sha256 去重。
   * 源目录可以是 { version, stickers: [...] }，也可以直接是数组。
   */
  importFrom(sourceDir, { source = '' } = {}) {
    const root = text(sourceDir)
    if (!root) {
      throw new StickerError('sticker_bad_request', { hint: '请选择要导入的表情库目录。' })
    }
    const absoluteRoot = resolve(root)
    const indexFile = join(absoluteRoot, 'index.json')
    if (!existsSync(indexFile)) {
      throw new StickerError('sticker_bad_request', {
        hint: '该目录不是有效的表情库（缺少索引文件）。',
        detail: indexFile,
      })
    }
    const disk = readJson(indexFile, null)
    const list = Array.isArray(disk) ? disk : (Array.isArray(disk?.stickers) ? disk.stickers : null)
    if (!list) {
      throw new StickerError('sticker_bad_request', {
        hint: '表情库索引格式无法识别。',
        detail: indexFile,
      })
    }

    const result = { ok: true, dir: absoluteRoot, total: list.length, imported: 0, merged: 0, skipped: 0, errors: [] }
    for (const original of list) {
      try {
        const relative = text(original?.file).replace(/\\/g, '/')
        if (!relative) throw new StickerError('sticker_bad_request', { hint: '表情条目缺少文件名。' })
        const absolute = resolve(absoluteRoot, ...relative.split('/').filter(Boolean))
        const inner = pathRelative(absoluteRoot, absolute)
        if (!inner || inner.startsWith('..') || isAbsolute(inner) || inner.includes(`..${sep}`)) {
          throw new StickerError('sticker_bad_request', { hint: `表情文件路径超出表情库范围：${relative}` })
        }
        if (!existsSync(absolute)) {
          throw new StickerError('sticker_bad_request', { hint: `源图片不存在：${relative}` })
        }
        const buf = readFileSync(absolute)
        const info = readPictureInfo(buf)
        if (!info) throw new StickerError('sticker_bad_request', { hint: `文件不是受支持的图片格式：${relative}` })
        const sha = createHash('sha256').update(buf).digest('hex')
        const existing = this.bySha(sha)
        if (existing) {
          existing.tags = normalizeTags([...(existing.tags || []), ...normalizeTags(original.tags)])
          if (!existing.desc && text(original.desc)) existing.desc = text(original.desc).slice(0, 500)
          if (!existing.source && (text(original.source) || source)) existing.source = (text(original.source) || source).slice(0, 200)
          result.merged += 1
          continue
        }
        this.checkCapacity(buf.length)
        const sourceId = /^[A-Za-z0-9_-]{4,64}$/.test(text(original.id)) ? text(original.id) : ''
        const idToUse = sourceId && !this.byId(sourceId) ? sourceId : this.makeId(sha)
        const targetRelative = this.makeFileName(basename(relative), sha, info)
        this.writeFile(targetRelative, buf)
        this.entries.push({
          id: idToUse,
          file: targetRelative,
          type: info.type,
          sha256: sha,
          size_kb: Math.max(1, Math.round(buf.length / 1024)),
          width: Math.max(0, Math.round(toNumber(original.width, info.width))),
          height: Math.max(0, Math.round(toNumber(original.height, info.height))),
          ...(info.type === 'gif'
            ? {
                frames: Math.max(0, Math.round(toNumber(original.frames, 0) > 0 ? toNumber(original.frames, 0) : (info.frames || 0))),
                duration_s: Math.max(0, toNumber(original.duration_s, 0) > 0 ? toNumber(original.duration_s, 0) : (info.duration_s || 0)),
              }
            : {}),
          tags: normalizeTags(original.tags),
          desc: text(original.desc).slice(0, 500),
          source: (text(original.source) || source).slice(0, 200),
          added_at: text(original.added_at) || now(),
          used_count: Math.max(0, Math.round(toNumber(original.used_count, 0))),
          last_used_at: text(original.last_used_at),
        })
        result.imported += 1
      } catch (error) {
        result.skipped += 1
        if (error?.code === 'sticker_limit') {
          result.errors.push({ file: text(original?.file), error: error.hint || error.message, code: error.code })
          // 到上限就没必要一条条试了，剩下的都记成跳过。
          const remaining = list.length - result.imported - result.merged - result.skipped
          if (remaining > 0) {
            result.skipped += remaining
            result.errors.push({ file: '', error: `表情库已达到上限，剩余 ${remaining} 条未导入，清理后可重新导入。`, code: 'sticker_limit' })
          }
          break
        }
        result.errors.push({
          file: text(original?.file),
          error: String(error?.hint || error?.message || error),
          ...(error?.code ? { code: error.code } : {}),
        })
      }
    }
    if (result.imported || result.merged) this.saveIndex()
    this.logger?.info?.(`从 ${absoluteRoot} 导入表情：新增 ${result.imported}，合并 ${result.merged}，跳过 ${result.skipped}`)
    return result
  }

  /** 清理未使用条目。 */
  cleanupUnused() {
    const theDelete = this.entries.filter((x) => (x.used_count || 0) === 0)
    let release = 0
    for (const entry of theDelete) {
      try { release += statSync(this.absolutePath(entry.file)).size } catch { /* 文件可能已经不在 */ }
      try { rmSync(this.absolutePath(entry.file), { force: true }) } catch { /* 忽略 */ }
    }
    this.entries = this.entries.filter((x) => (x.used_count || 0) > 0)
    if (theDelete.length) this.saveIndex()
    return { ok: true, removed: theDelete.length, freedBytes: release, freedMB: Math.round((release / 1048576) * 10) / 10 }
  }

  /** 清理重复 sha：保留用得最多、最早加入的那条，其它删文件并合并标签。 */
  cleanupDuplicates() {
    const group = new Map()
    for (const entry of this.entries) {
      const key = entry.sha256 || `无sha:${entry.id}`
      if (!group.has(key)) group.set(key, [])
      group.get(key).push(entry)
    }
    let theDelete = 0
    let release = 0
    const deleteId = new Set()
    for (const [, items] of group) {
      if (items.length < 2) continue
      items.sort((a, b) => (b.used_count || 0) - (a.used_count || 0)
        || String(a.added_at).localeCompare(String(b.added_at)))
      const [retain, ...excess] = items
      retain.tags = normalizeTags([...(retain.tags || []), ...excess.flatMap((x) => x.tags || [])])
      if (!retain.desc) retain.desc = excess.map((x) => x.desc).find(Boolean) || ''
      for (const entry of excess) {
        deleteId.add(entry.id)
        try { release += statSync(this.absolutePath(entry.file)).size } catch { /* 忽略 */ }
        try { rmSync(this.absolutePath(entry.file), { force: true }) } catch { /* 忽略 */ }
        theDelete += 1
      }
    }
    if (theDelete) {
      this.entries = this.entries.filter((x) => !deleteId.has(x.id))
      this.saveIndex()
    }
    return { ok: true, removed: theDelete, freedBytes: release, freedMB: Math.round((release / 1048576) * 10) / 10 }
  }

  /** 最近收到的入站图片（inbox，默认 20 个）。 */
  recentInbox(limit = 20) {
    if (!this.inboxDir) return []
    let files = []
    try {
      files = readdirSync(this.inboxDir, { withFileTypes: true })
        .filter((x) => x.isFile() && /^qq-image-.*\.(gif|png|jpe?g|webp|bmp)$/i.test(x.name))
        .map((x) => {
          const path = join(this.inboxDir, x.name)
          let info = { mtime: 0, size: 0 }
          try {
            const st = statSync(path)
            info = { mtime: st.mtimeMs, size: st.size }
          } catch { /* 忽略 */ }
          return {
            name: x.name,
            path: path,
            size: info.size,
            mtime: info.mtime,
            type: /\.gif$/i.test(x.name) ? 'gif' : 'img',
            mime: imageMime(x.name),
          }
        })
    } catch {
      return []
    }
    return files.sort((a, b) => b.mtime - a.mtime).slice(0, Math.max(1, Math.min(100, Math.round(toNumber(limit, 20)))))
  }

  /** 清空「最近收到的图片」：只删 qq-image-*，不碰别的文件。 */
  cleanupInbox() {
    if (!this.inboxDir) return { ok: true, removed: 0, freedBytes: 0 }
    let theDelete = 0
    let release = 0
    try {
      for (const x of readdirSync(this.inboxDir, { withFileTypes: true })) {
        if (!x.isFile() || !/^qq-image-.*\.(gif|png|jpe?g|webp|bmp)$/i.test(x.name)) continue
        const path = join(this.inboxDir, x.name)
        try { release += statSync(path).size } catch { /* 忽略 */ }
        try { rmSync(path, { force: true }); theDelete += 1 } catch { /* 忽略 */ }
      }
    } catch {
      return { ok: true, removed: 0, freedBytes: 0 }
    }
    return { ok: true, removed: theDelete, freedBytes: release, freedMB: Math.round((release / 1048576) * 10) / 10 }
  }

  /**
   * 清掉入站缓存里超过保留期的图片与语音。
   *
   * 只认 qq-image-* / qq-voice-* 两类文件；表情库目录、其它文件一律不动。
   * 过期按 mtime 判断：缓存文件写入后不再改动，mtime 就是收到的时刻。
   * 保留期给 0 或负数时什么都不删，避免配置算错时把整个缓存清空。
   */
  cleanupExpireCache(retainMs) {
    if (!this.inboxDir) return { ok: true, removed: 0, freedBytes: 0 }
    const retain = toNumber(retainMs, 0)
    if (!(retain > 0)) return { ok: true, removed: 0, freedBytes: 0 }
    const deadline = Date.now() - retain
    let theDelete = 0
    let release = 0
    try {
      for (const x of readdirSync(this.inboxDir, { withFileTypes: true })) {
        if (!x.isFile() || !/^qq-(image|voice)-/i.test(x.name)) continue
        const path = join(this.inboxDir, x.name)
        try {
          const st = statSync(path)
          if (st.mtimeMs >= deadline) continue
          release += st.size
          rmSync(path, { force: true })
          theDelete += 1
        } catch { /* 单个文件读不到/删不掉不影响其它文件 */ }
      }
    } catch {
      return { ok: true, removed: 0, freedBytes: 0 }
    }
    return { ok: true, removed: theDelete, freedBytes: release, freedMB: Math.round((release / 1048576) * 10) / 10 }
  }

  /** 兼容多选上传：一次存多张。 */
  saveMany(files, options = {}) {
    const result = []
    for (const file of files || []) {
      try {
        const r = this.save(file.path ?? file.buffer ?? file, {
          ...options,
          ...(file.name ? { name: file.name } : {}),
        })
        result.push({ ok: true, ...r, name: file.name || basename(String(file.path || '')) })
      } catch (error) {
        result.push({
          ok: false,
          name: file?.name || basename(String(file?.path || '')),
          code: error?.code || 'sticker_error',
          error: String(error?.hint || error?.message || error),
        })
      }
    }
    return result
  }
}

export { defaultMaxItemNumber as STICKER_DEFAULT_MAX_COUNT, defaultMaxMB as STICKER_DEFAULT_MAX_MB }
