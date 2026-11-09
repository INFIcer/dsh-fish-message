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
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ensureDir, readJson, writeJsonAtomic } from './fs-util.js'

export const 索引版本 = 1
export const 默认最大条数 = 2000
export const 默认最大MB = 1024
export const 默认接收目录名 = 'fish-message-stickers'
/** Windows 上 Python 表情库的默认位置；一键导入用，路由可覆盖。 */
export const 默认导入目录 = 'D:\\dsh_ws\\表情库'

const 文本 = (值, 兜底 = '') => (值 == null ? 兜底 : String(值).trim())
const 数字 = (值, 兜底 = 0) => {
  const n = Number(值)
  return Number.isFinite(n) ? n : 兜底
}

const 现在 = () => new Date().toISOString().replace(/\.\d{3}Z$/, '')

/** 结构化错误：code 给程序判断，hint 给人看。 */
export class StickerError extends Error {
  constructor(code, { hint = '', detail = '', cause } = {}) {
    const 码 = String(code || 'sticker_error')
    super(detail || hint || 码)
    this.name = 'StickerError'
    this.code = 码
    this.hint = String(hint || '')
    this.detail = String(detail || '')
    if (cause !== undefined) this.cause = cause
  }
}

/** 标签规整：接受数组或「逗号/顿号/分号/#」分隔的字符串；去重、限长。 */
export function 规整标签(输入, { 最多 = 16, 每个最长 = 32 } = {}) {
  const 原 = Array.isArray(输入)
    ? 输入
    : (输入 == null ? [] : String(输入).split(/[,，、;；#]+/))
  const 出 = []
  const 见 = new Set()
  for (const 项 of 原) {
    let 标 = 文本(项).replace(/^#+/, '').trim()
    if (!标) continue
    if (标.length > 每个最长) 标 = 标.slice(0, 每个最长)
    const 键 = 标.toLowerCase()
    if (见.has(键)) continue
    见.add(键)
    出.push(标)
    if (出.length >= 最多) break
  }
  return 出
}

/** 文件名安全化：去掉 Windows 非法字符与路径分隔符，保留中文。 */
export function 安全文件名(名, 兜底 = 'sticker') {
  let 值 = 文本(名)
  try { 值 = decodeURIComponent(值) } catch { /* 不是编码就按原文 */ }
  值 = 值.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim()
  值 = 值.replace(/^[.\s]+/, '')
  if (!值) 值 = 兜底
  if (值.length > 80) {
    const 扩 = extname(值)
    值 = `${值.slice(0, Math.max(1, 80 - 扩.length))}${扩}`
  }
  return 值
}

// ---------------- 图片头解析（不依赖任何图形库） ----------------

function 跳GIF子块(buf, p) {
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
function 读GIF(buf) {
  const 头 = buf.toString('latin1', 0, 6)
  if (头 !== 'GIF87a' && 头 !== 'GIF89a') return null
  if (buf.length < 13) return { width: 0, height: 0, frames: 0, duration_s: 0 }
  const width = buf.readUInt16LE(6)
  const height = buf.readUInt16LE(8)
  const 全局表 = buf[10]
  let p = 13
  if (全局表 & 0x80) p += 3 * (1 << ((全局表 & 0x07) + 1))
  let frames = 0
  let 延迟厘秒 = 0
  while (p < buf.length) {
    const 块 = buf[p]
    if (块 === 0x3b) break // trailer
    if (块 === 0x21) {
      // 扩展块：GCE 记延迟，其它扩展跳过子块。
      const 标签 = buf[p + 1]
      p += 2
      if (标签 === 0xf9) {
        const 大小 = buf[p] || 0
        if (大小 >= 4 && p + 4 < buf.length) 延迟厘秒 += buf.readUInt16LE(p + 2)
        p += 1 + 大小 + 1
      } else {
        p = 跳GIF子块(buf, p)
      }
      continue
    }
    if (块 === 0x2c) {
      // 图像描述符：10 字节头 + 可选局部色表 + LZW 最小码长 + 子块。
      frames += 1
      if (p + 9 >= buf.length) break
      const 局部表 = buf[p + 9]
      p += 10
      if (局部表 & 0x80) p += 3 * (1 << ((局部表 & 0x07) + 1))
      p += 1
      p = 跳GIF子块(buf, p)
      continue
    }
    break
  }
  return {
    width,
    height,
    frames,
    duration_s: Math.round(延迟厘秒) / 100,
  }
}

/** PNG：IHDR 宽高。 */
function 读PNG(buf) {
  if (buf.length < 8) return null
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null
  if (buf.length < 24) return { width: 0, height: 0 }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** JPEG：扫 SOF 标记取宽高。 */
function 读JPEG(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let p = 2
  while (p + 1 < buf.length) {
    if (buf[p] !== 0xff) { p += 1; continue }
    const 标 = buf[p + 1]
    p += 2
    if (标 === 0xd8 || 标 === 0xd9 || (标 >= 0xd0 && 标 <= 0xd7)) continue
    if (p + 1 >= buf.length) break
    const 长 = buf.readUInt16BE(p)
    if (长 < 2) break
    if (标 >= 0xc0 && 标 <= 0xcf && 标 !== 0xc4 && 标 !== 0xc8 && 标 !== 0xcc) {
      if (p + 6 < buf.length) {
        return { width: buf.readUInt16BE(p + 5), height: buf.readUInt16BE(p + 3) }
      }
      break
    }
    p += 长
  }
  return { width: 0, height: 0 }
}

/** WebP：只认 VP8X（扩展格式）的 canvas 尺寸；其它分支给 0。 */
function 读WebP(buf) {
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
export function 读图片信息(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null
  const gif = 读GIF(buf)
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
  const png = 读PNG(buf)
  if (png) return { ext: '.png', mime: 'image/png', type: 'img', ...png }
  const jpg = 读JPEG(buf)
  if (jpg) return { ext: '.jpg', mime: 'image/jpeg', type: 'img', ...jpg }
  const webp = 读WebP(buf)
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

const 扩展名白名单 = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp', '.bmp'])

/** 按扩展名给 HTTP content-type。 */
export function 图片Mime(路径) {
  const 扩 = extname(String(路径 || '')).toLowerCase()
  const 表 = {
    '.gif': 'image/gif',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  }
  return 表[扩] || ''
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
    this.inboxDir = 文本(inboxDir)
    this.固定最大条数 = maxCount
    this.固定最大MB = maxMB
    const 家 = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.dsh')
    const 配置目录 = 文本(dir) || 文本(this.getConfig().stickerDir) || join(家, 默认接收目录名)
    // 相对路径按 DSH 家目录解析，避免跟着进程工作目录跑。
    this.dir = isAbsolute(配置目录) ? resolve(配置目录) : resolve(家, 配置目录)
    this.indexPath = join(this.dir, 'index.json')
    this.entries = []
    this.加载()
  }

  // ---- 基础 ----

  /** 设置页改了 stickerDir：就地换目录并重新读索引，实例引用不变。 */
  切换目录(新目录) {
    const 目标 = resolve(文本(新目录))
    if (!目标 || 目标 === this.dir) return this.dir
    this.dir = 目标
    this.indexPath = join(this.dir, 'index.json')
    this.entries = []
    this.加载()
    this.logger?.info?.(`表情库目录切到 ${this.dir}`)
    return this.dir
  }

  上限() {
    const 配置 = this.getConfig() || {}
    return {
      maxCount: Math.max(1, Math.floor(数字(this.固定最大条数 ?? 配置.stickerMaxCount, 默认最大条数))),
      maxMB: Math.max(1, 数字(this.固定最大MB ?? 配置.stickerMaxMB, 默认最大MB)),
    }
  }

  加载() {
    ensureDir(join(this.dir, 'gif'))
    ensureDir(join(this.dir, 'img'))
    if (!existsSync(this.indexPath)) {
      this.entries = []
      return
    }    const 盘 = readJson(this.indexPath, null)
    if (!盘 || typeof 盘 !== 'object') {
      // 索引坏了不要静默清空：留一份备份再从空开始，方便人工恢复。
      try {
        const 备份 = `${this.indexPath}.bad-${Date.now()}`
        renameSync(this.indexPath, 备份)
        this.logger?.warn?.(`表情索引读不出来，已备份到 ${备份}，从空索引开始`)
      } catch (error) {
        this.logger?.error?.(`表情索引读不出来，备份也失败：${String(error?.message || error)}`)
      }
      this.entries = []
      return
    }
    const 列表 = Array.isArray(盘) ? 盘 : (Array.isArray(盘.stickers) ? 盘.stickers : [])
    this.entries = 列表.map((x) => this.规整条目(x)).filter(Boolean)
  }

  规整条目(原) {
    if (!原 || typeof 原 !== 'object') return null
    const id = 文本(原.id)
    const file = 文本(原.file).replace(/\\/g, '/')
    if (!id || !file) return null
    // 索引可能被手改/迁移过：带 ..、绝对路径、盘符的条目直接丢弃，避免删/读越界。
    const 段 = file.split('/').filter(Boolean)
    if (!段.length || file.startsWith('/') || /^[A-Za-z]:/.test(file) || 段.includes('..')) return null
    const type = 原.type === 'gif' || /\.gif$/i.test(file) ? 'gif' : 'img'
    return {
      id,
      file,
      type,
      sha256: 文本(原.sha256),
      size_kb: Math.max(0, Math.round(数字(原.size_kb, 0))),
      width: Math.max(0, Math.round(数字(原.width, 0))),
      height: Math.max(0, Math.round(数字(原.height, 0))),
      ...(type === 'gif' ? { frames: Math.max(0, Math.round(数字(原.frames, 0))) } : {}),
      ...(type === 'gif' ? { duration_s: Math.max(0, 数字(原.duration_s, 0)) } : {}),      tags: 规整标签(原.tags),
      desc: 文本(原.desc).slice(0, 500),
      source: 文本(原.source).slice(0, 200),
      added_at: 文本(原.added_at) || 现在(),
      used_count: Math.max(0, Math.round(数字(原.used_count, 0))),
      last_used_at: 文本(原.last_used_at),
    }
  }

  保存索引() {
    const 盘 = { version: 索引版本, updatedAt: 现在(), stickers: this.entries }
    if (!writeJsonAtomic(this.indexPath, 盘)) {
      throw new StickerError('sticker_io', {
        hint: '表情库索引无法写入，请检查保存位置与磁盘空间。',
        detail: this.indexPath,
      })
    }
    return true
  }

  装饰(条目) {
    if (!条目) return null
    return { ...条目, path: this.绝对路径(条目.file) }
  }

  绝对路径(相对) {
    const 目标 = resolve(this.dir, ...String(相对 || '').replace(/\\/g, '/').split('/').filter(Boolean))
    const 内 = relative(this.dir, 目标)
    if (!内 || 内.startsWith('..') || isAbsolute(内)) {
      throw new StickerError('sticker_bad_request', {
        hint: '表情文件路径超出表情库范围。',
        detail: 文本(相对),
      })
    }
    return 目标
  }

  按sha(sha) {
    if (!sha) return null
    return this.entries.find((x) => x.sha256 === sha) || null
  }

  按id(id) {
    const 键 = 文本(id)
    if (!键) return null
    return this.entries.find((x) => x.id === 键) || null
  }

  /** 造一个不会和现有 id 撞的 12 位十六进制 id（取自 sha）。 */
  造id(sha) {
    const 基础 = String(sha || '').slice(0, 12) || createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 12)
    if (!this.按id(基础)) return 基础
    for (let i = 0; i < 100; i++) {
      const 试 = createHash('sha256').update(`${sha}:${i}`).digest('hex').slice(0, 12)
      if (!this.按id(试)) return 试
    }
    return createHash('sha256').update(`${sha}:${Date.now()}`).digest('hex').slice(0, 12)
  }

  /** 目标文件名：沿用来源名；同名的不同内容追加 sha 前 8 位。 */
  造文件名(名, sha, 信息) {
    let 基 = 安全文件名(名 || '', 'sticker')
    let 扩 = extname(基).toLowerCase()
    if (!扩展名白名单.has(扩)) {
      扩 = 信息.ext
      基 = `${基}${扩}`
    }
    // 扩展名以真实内容为准：内容 GIF 就存 .gif，避免 NapCat 按扩展名判错。
    if (extname(基).toLowerCase() !== 信息.ext) 基 = `${基.slice(0, Math.max(1, 基.length - extname(基).length))}${信息.ext}`
    const 目录 = 信息.type === 'gif' ? 'gif' : 'img'
    const 已用 = new Set(this.entries.map((x) => x.file.toLowerCase()))
    let 相对 = `${目录}/${基}`
    if (!已用.has(相对.toLowerCase())) return 相对
    const 去扩 = 基.slice(0, 基.length - extname(基).length)
    for (let i = 0; i < 50; i++) {
      const 试 = `${去扩}-${String(sha).slice(0, 8)}${i ? `-${i}` : ''}${信息.ext}`
      相对 = `${目录}/${试}`
      if (!已用.has(相对.toLowerCase())) return 相对
    }
    return `${目录}/${去扩}-${Date.now()}${信息.ext}`
  }

  检查容量(新字节) {
    const { maxCount, maxMB } = this.上限()
    if (this.entries.length >= maxCount) {
      throw new StickerError('sticker_limit', {
        hint: `表情库已达到 ${maxCount} 条上限，请清理后再添加。`,
        detail: `count=${this.entries.length}, max=${maxCount}`,
      })
    }
    const 已用字节 = this.占用字节()
    if (已用字节 + 新字节 > maxMB * 1024 * 1024) {
      throw new StickerError('sticker_limit', {
        hint: `表情库已达到 ${maxMB}MB 上限（当前 ${(已用字节 / 1048576).toFixed(1)}MB，本次 ${(新字节 / 1048576).toFixed(1)}MB），请清理后再添加。`,
        detail: `used=${已用字节}, add=${新字节}, max=${maxMB}MB`,
      })
    }
  }

  占用字节() {
    let 总 = 0
    for (const x of this.entries) {
      try {
        总 += statSync(this.绝对路径(x.file)).size
      } catch {
        总 += Math.max(0, 数字(x.size_kb, 0)) * 1024
      }
    }
    return 总
  }

  写文件(相对, buf) {
    const 目标 = this.绝对路径(相对)
    ensureDir(dirname(目标))
    const 临时 = `${目标}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(临时, buf)
      renameSync(临时, 目标)
    } catch (error) {
      try { rmSync(临时, { force: true }) } catch { /* 清不掉就算了 */ }
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
  save(pathOrBuffer, 选项 = {}) {
    let buf
    let 来源路径 = ''
    if (Buffer.isBuffer(pathOrBuffer)) {
      buf = pathOrBuffer
    } else {
      来源路径 = 文本(pathOrBuffer)
      if (!来源路径) {
        throw new StickerError('sticker_bad_request', { hint: '请提供图片文件或图片内容。' })
      }
      if (!isAbsolute(来源路径)) {
        throw new StickerError('sticker_bad_request', { hint: '请提供本机图片的完整路径。', detail: 来源路径 })
      }
      try {
        buf = readFileSync(来源路径)
      } catch (error) {
        throw new StickerError('sticker_bad_request', {
          hint: `无法读取图片：${来源路径}`,
          detail: String(error?.message || error),
          cause: error,
        })
      }
    }
    if (!buf || !buf.length) {
      throw new StickerError('sticker_bad_request', { hint: '图片内容为空。' })
    }
    const 信息 = 读图片信息(buf)
    if (!信息) {
      throw new StickerError('sticker_bad_request', {
        hint: '仅支持 GIF、PNG、JPEG、WebP、BMP 格式的图片。',
        detail: 来源路径 || 'buffer',
      })
    }

    const sha = createHash('sha256').update(buf).digest('hex')
    const 已有 = this.按sha(sha)
    if (已有) {
      const 合并 = this.合并标签(已有, 选项)
      已有.tags = 合并
      const 新描述 = 文本(选项.desc).slice(0, 500)
      if (新描述 && !已有.desc) 已有.desc = 新描述
      if (!已有.source && 文本(选项.source)) 已有.source = 文本(选项.source).slice(0, 200)
      this.保存索引()
      return { ok: true, created: false, merged: true, entry: this.装饰(已有) }
    }

    this.检查容量(buf.length)
    const 相对 = this.造文件名(选项.name || basename(来源路径 || '') || 'sticker', sha, 信息)
    this.写文件(相对, buf)
    const 条目 = {
      id: this.造id(sha),
      file: 相对,
      type: 信息.type,
      sha256: sha,
      size_kb: Math.max(1, Math.round(buf.length / 1024)),
      width: 信息.width,
      height: 信息.height,
      ...(信息.type === 'gif' ? { frames: 信息.frames || 0, duration_s: 信息.duration_s || 0 } : {}),
      tags: 规整标签(选项.tags),
      desc: 文本(选项.desc).slice(0, 500),
      source: 文本(选项.source).slice(0, 200),
      added_at: 现在(),
      used_count: 0,
      last_used_at: '',
    }
    this.entries.push(条目)
    try {
      this.保存索引()
    } catch (error) {
      // 索引没写进去就把刚复制的文件撤掉，避免变成孤儿文件。
      this.entries.pop()
      try { rmSync(this.绝对路径(相对), { force: true }) } catch { /* 忽略 */ }
      throw error
    }
    this.logger?.info?.(`表情入库：${条目.file}（${条目.size_kb}KB，${条目.type}）`)
    return { ok: true, created: true, merged: false, entry: this.装饰(条目) }
  }

  合并标签(条目, 选项) {
    return 规整标签([...(条目.tags || []), ...规整标签(选项?.tags)])
  }

  // ---- 查询 ----

  /**
   * 列表 / 搜索。
   * @param {{q?:string, tag?:string, limit?:number, offset?:number, sort?:'used'|'recent'|'name'}} [选项]
   */
  list(选项 = {}) {
    const q = 文本(选项.q).toLowerCase()
    const tag = 文本(选项.tag).replace(/^#+/, '').toLowerCase()
    const sort = ['used', 'recent', 'name'].includes(选项.sort) ? 选项.sort : 'used'
    const limit = Math.max(1, Math.min(500, Math.round(数字(选项.limit, 50))))
    const offset = Math.max(0, Math.round(数字(选项.offset, 0)))

    let 命中 = this.entries
    if (tag) 命中 = 命中.filter((x) => (x.tags || []).some((t) => t.toLowerCase() === tag))
    if (q) {
      命中 = 命中.filter((x) => {
        const 名字 = basename(x.file).toLowerCase()
        const 无扩 = basename(x.file, extname(x.file)).toLowerCase()
        return x.id.toLowerCase().includes(q)
          || x.file.toLowerCase().includes(q)
          || 名字.includes(q)
          || 无扩.includes(q)
          || (x.desc || '').toLowerCase().includes(q)
          || (x.tags || []).some((t) => t.toLowerCase().includes(q))
      })
    }
    命中 = [...命中].sort((a, b) => {
      if (sort === 'name') return basename(a.file).localeCompare(basename(b.file), 'zh-CN')
      if (sort === 'recent') return String(b.added_at).localeCompare(String(a.added_at))
      return (b.used_count || 0) - (a.used_count || 0)
        || String(b.last_used_at || '').localeCompare(String(a.last_used_at || ''))
        || String(b.added_at).localeCompare(String(a.added_at))
    })
    const 页 = 命中.slice(offset, offset + limit)
    return {
      items: 页.map((x) => this.装饰(x)),
      total: 命中.length,
      offset,
      limit,
      stats: this.stats(),
      tags: this.标签统计(),
    }
  }

  标签统计() {
    const 表 = new Map()
    for (const x of this.entries) {
      for (const t of x.tags || []) 表.set(t, (表.get(t) || 0) + 1)
    }
    return [...表.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
      .map(([tag, count]) => ({ tag, count }))
  }

  stats() {
    const { maxCount, maxMB } = this.上限()
    const 字节 = this.占用字节()
    return {
      count: this.entries.length,
      maxCount,
      totalBytes: 字节,
      sizeMB: Math.round((字节 / 1048576) * 10) / 10,
      maxMB,
      used: this.entries.filter((x) => (x.used_count || 0) > 0).length,
      unused: this.entries.filter((x) => (x.used_count || 0) === 0).length,
      dir: this.dir,
      indexPath: this.indexPath,
    }
  }

  /** 名字解析：id / 文件名（含扩展名或不含）/ #标签 / 描述模糊匹配。 */
  查找(name) {
    const q = 文本(name)
    if (!q) return null
    if (q.startsWith('#')) {
      const tag = q.slice(1).toLowerCase()
      if (!tag) return null
      const 命中 = this.entries.filter((x) => (x.tags || []).some((t) => t.toLowerCase() === tag))
      if (!命中.length) return null
      const 轮换 = [...命中].sort((a, b) => (a.used_count || 0) - (b.used_count || 0)
        || String(a.last_used_at || '').localeCompare(String(b.last_used_at || ''))
        || String(a.added_at).localeCompare(String(b.added_at)))
      return { entry: 轮换[0], matches: 命中, matchedBy: 'tag' }
    }
    const 原id = this.按id(q)
    if (原id) return { entry: 原id, matches: [原id], matchedBy: 'id' }
    const 原名 = this.entries.find((x) => x.file === q
      || basename(x.file) === q
      || basename(x.file, extname(x.file)) === q)
    if (原名) return { entry: 原名, matches: [原名], matchedBy: 'name' }

    const 小写 = q.toLowerCase()
    const 模糊 = this.entries.filter((x) => basename(x.file, extname(x.file)).toLowerCase().includes(小写)
      || basename(x.file).toLowerCase().includes(小写)
      || (x.desc || '').toLowerCase().includes(小写)
      || (x.tags || []).some((t) => t.toLowerCase().includes(小写)))
    if (!模糊.length) return null
    // 多个命中时挑「用得最少、最久没用」的，天然形成轮换。
    模糊.sort((a, b) => (a.used_count || 0) - (b.used_count || 0)
      || String(a.last_used_at || '').localeCompare(String(b.last_used_at || ''))
      || String(a.added_at).localeCompare(String(b.added_at)))
    return { entry: 模糊[0], matches: 模糊, matchedBy: 'fuzzy' }
  }

  /** 取一个条目（带 path）；找不到返回 null。 */
  get(idOrName) {
    const 中 = this.查找(idOrName)
    return 中 ? this.装饰(中.entry) : null
  }

  /** 发指令用：解析名字，找不到给结构化错误。 */
  resolve(name) {
    const 中 = this.查找(name)
    if (!中) {
      throw new StickerError('sticker_not_found', {
        hint: `找不到表情「${文本(name)}」，请使用设置页「表情包」中的名称或标签重试。`,
        detail: 文本(name),
      })
    }
    return { ...this.装饰(中.entry), matchedBy: 中.matchedBy, matchCount: 中.matches.length }
  }

  // ---- 修改 ----

  update(id, 补丁 = {}) {
    const 条目 = this.按id(id)
    if (!条目) {
      throw new StickerError('sticker_not_found', { hint: '找不到该表情。' })
    }
    if (补丁.tags !== undefined) 条目.tags = 规整标签(补丁.tags)
    if (补丁.desc !== undefined) 条目.desc = 文本(补丁.desc).slice(0, 500)
    if (补丁.source !== undefined) 条目.source = 文本(补丁.source).slice(0, 200)
    if (补丁.name !== undefined && 文本(补丁.name)) {
      const 新名 = this.造重命名(条目, 补丁.name)
      if (新名 && 新名 !== 条目.file) {
        const 旧绝对 = this.绝对路径(条目.file)
        const 新绝对 = this.绝对路径(新名)
        if (existsSync(新绝对)) {
          throw new StickerError('sticker_bad_request', {
            hint: `重命名失败：已存在同名表情「${新名}」。`,
            detail: 新名,
          })
        }
        try {
          ensureDir(dirname(新绝对))
          renameSync(旧绝对, 新绝对)
        } catch (error) {
          throw new StickerError('sticker_io', {
            hint: `重命名失败：${String(error?.message || error)}`,
            detail: 新名,
            cause: error,
          })
        }
        条目.file = 新名
      }
    }
    this.保存索引()
    return this.装饰(条目)
  }

  造重命名(条目, 名) {
    const 目录 = 条目.type === 'gif' ? 'gif' : 'img'
    let 基 = 安全文件名(名, basename(条目.file, extname(条目.file)))
    let 扩 = extname(基).toLowerCase()
    if (!扩展名白名单.has(扩)) 扩 = extname(条目.file).toLowerCase()
    基 = `${基.slice(0, Math.max(1, 基.length - extname(基).length))}${扩}`
    return `${目录}/${基}`
  }

  delete(id, { removeFile = true } = {}) {
    const 位置 = this.entries.findIndex((x) => x.id === 文本(id))
    if (位置 < 0) {
      throw new StickerError('sticker_not_found', { hint: '找不到该表情。' })
    }
    const [条目] = this.entries.splice(位置, 1)
    this.保存索引()
    let 删了文件 = false
    if (removeFile) {
      try {
        rmSync(this.绝对路径(条目.file), { force: true })
        删了文件 = true
      } catch (error) {
        this.logger?.warn?.(`表情文件删不掉：${条目.file}｜${String(error?.message || error)}`)
      }
    }
    return { ok: true, deleted: true, id: 条目.id, file: 条目.file, fileRemoved: 删了文件 }
  }

  /** 使用计数：发送成功后调用。 */
  bump(id) {
    const 条目 = this.按id(id)
    if (!条目) return null
    条目.used_count = Math.max(0, Math.round(数字(条目.used_count, 0))) + 1
    条目.last_used_at = 现在()
    this.保存索引()
    return this.装饰(条目)
  }

  // ---- 导入 / 清理 ----

  /**
   * 从 Python 表情库目录导入：读 index.json，把条目转成本库格式，按 sha256 去重。
   * 源目录可以是 { version, stickers: [...] }，也可以直接是数组。
   */
  importFrom(源目录, { source = '' } = {}) {
    const 根 = 文本(源目录)
    if (!根) {
      throw new StickerError('sticker_bad_request', { hint: '请选择要导入的表情库目录。' })
    }
    const 绝对根 = resolve(根)
    const 索引文件 = join(绝对根, 'index.json')
    if (!existsSync(索引文件)) {
      throw new StickerError('sticker_bad_request', {
        hint: '该目录不是有效的表情库（缺少索引文件）。',
        detail: 索引文件,
      })
    }
    const 盘 = readJson(索引文件, null)
    const 列表 = Array.isArray(盘) ? 盘 : (Array.isArray(盘?.stickers) ? 盘.stickers : null)
    if (!列表) {
      throw new StickerError('sticker_bad_request', {
        hint: '表情库索引格式无法识别。',
        detail: 索引文件,
      })
    }

    const 结果 = { ok: true, dir: 绝对根, total: 列表.length, imported: 0, merged: 0, skipped: 0, errors: [] }
    for (const 原 of 列表) {
      try {
        const 相对 = 文本(原?.file).replace(/\\/g, '/')
        if (!相对) throw new StickerError('sticker_bad_request', { hint: '表情条目缺少文件名。' })
        const 绝对 = resolve(绝对根, ...相对.split('/').filter(Boolean))
        const 内 = relative(绝对根, 绝对)
        if (!内 || 内.startsWith('..') || isAbsolute(内) || 内.includes(`..${sep}`)) {
          throw new StickerError('sticker_bad_request', { hint: `表情文件路径超出表情库范围：${相对}` })
        }
        if (!existsSync(绝对)) {
          throw new StickerError('sticker_bad_request', { hint: `源图片不存在：${相对}` })
        }
        const buf = readFileSync(绝对)
        const 信息 = 读图片信息(buf)
        if (!信息) throw new StickerError('sticker_bad_request', { hint: `文件不是受支持的图片格式：${相对}` })
        const sha = createHash('sha256').update(buf).digest('hex')
        const 已有 = this.按sha(sha)
        if (已有) {
          已有.tags = 规整标签([...(已有.tags || []), ...规整标签(原.tags)])
          if (!已有.desc && 文本(原.desc)) 已有.desc = 文本(原.desc).slice(0, 500)
          if (!已有.source && (文本(原.source) || source)) 已有.source = (文本(原.source) || source).slice(0, 200)
          结果.merged += 1
          continue
        }
        this.检查容量(buf.length)
        const 源id = /^[A-Za-z0-9_-]{4,64}$/.test(文本(原.id)) ? 文本(原.id) : ''
        const 用id = 源id && !this.按id(源id) ? 源id : this.造id(sha)
        const 目标相对 = this.造文件名(basename(相对), sha, 信息)
        this.写文件(目标相对, buf)
        this.entries.push({
          id: 用id,
          file: 目标相对,
          type: 信息.type,
          sha256: sha,
          size_kb: Math.max(1, Math.round(buf.length / 1024)),
          width: Math.max(0, Math.round(数字(原.width, 信息.width))),
          height: Math.max(0, Math.round(数字(原.height, 信息.height))),
          ...(信息.type === 'gif'
            ? {
                frames: Math.max(0, Math.round(数字(原.frames, 0) > 0 ? 数字(原.frames, 0) : (信息.frames || 0))),
                duration_s: Math.max(0, 数字(原.duration_s, 0) > 0 ? 数字(原.duration_s, 0) : (信息.duration_s || 0)),
              }
            : {}),
          tags: 规整标签(原.tags),
          desc: 文本(原.desc).slice(0, 500),
          source: (文本(原.source) || source).slice(0, 200),
          added_at: 文本(原.added_at) || 现在(),
          used_count: Math.max(0, Math.round(数字(原.used_count, 0))),
          last_used_at: 文本(原.last_used_at),
        })
        结果.imported += 1
      } catch (error) {
        结果.skipped += 1
        if (error?.code === 'sticker_limit') {
          结果.errors.push({ file: 文本(原?.file), error: error.hint || error.message, code: error.code })
          // 到上限就没必要一条条试了，剩下的都记成跳过。
          const 剩 = 列表.length - 结果.imported - 结果.merged - 结果.skipped
          if (剩 > 0) {
            结果.skipped += 剩
            结果.errors.push({ file: '', error: `表情库已达到上限，剩余 ${剩} 条未导入，清理后可重新导入。`, code: 'sticker_limit' })
          }
          break
        }
        结果.errors.push({
          file: 文本(原?.file),
          error: String(error?.hint || error?.message || error),
          ...(error?.code ? { code: error.code } : {}),
        })
      }
    }
    if (结果.imported || 结果.merged) this.保存索引()
    this.logger?.info?.(`从 ${绝对根} 导入表情：新增 ${结果.imported}，合并 ${结果.merged}，跳过 ${结果.skipped}`)
    return 结果
  }

  /** 清理未使用条目。 */
  清理未使用() {
    const 删 = this.entries.filter((x) => (x.used_count || 0) === 0)
    let 释放 = 0
    for (const 条目 of 删) {
      try { 释放 += statSync(this.绝对路径(条目.file)).size } catch { /* 文件可能已经不在 */ }
      try { rmSync(this.绝对路径(条目.file), { force: true }) } catch { /* 忽略 */ }
    }
    this.entries = this.entries.filter((x) => (x.used_count || 0) > 0)
    if (删.length) this.保存索引()
    return { ok: true, removed: 删.length, freedBytes: 释放, freedMB: Math.round((释放 / 1048576) * 10) / 10 }
  }

  /** 清理重复 sha：保留用得最多、最早加入的那条，其它删文件并合并标签。 */
  清理重复() {
    const 组 = new Map()
    for (const 条目 of this.entries) {
      const 键 = 条目.sha256 || `无sha:${条目.id}`
      if (!组.has(键)) 组.set(键, [])
      组.get(键).push(条目)
    }
    let 删 = 0
    let 释放 = 0
    const 删id = new Set()
    for (const [, 条们] of 组) {
      if (条们.length < 2) continue
      条们.sort((a, b) => (b.used_count || 0) - (a.used_count || 0)
        || String(a.added_at).localeCompare(String(b.added_at)))
      const [保留, ...多余] = 条们
      保留.tags = 规整标签([...(保留.tags || []), ...多余.flatMap((x) => x.tags || [])])
      if (!保留.desc) 保留.desc = 多余.map((x) => x.desc).find(Boolean) || ''
      for (const 条目 of 多余) {
        删id.add(条目.id)
        try { 释放 += statSync(this.绝对路径(条目.file)).size } catch { /* 忽略 */ }
        try { rmSync(this.绝对路径(条目.file), { force: true }) } catch { /* 忽略 */ }
        删 += 1
      }
    }
    if (删) {
      this.entries = this.entries.filter((x) => !删id.has(x.id))
      this.保存索引()
    }
    return { ok: true, removed: 删, freedBytes: 释放, freedMB: Math.round((释放 / 1048576) * 10) / 10 }
  }

  /** 最近收到的入站图片（inbox，默认 20 个）。 */
  recentInbox(limit = 20) {
    if (!this.inboxDir) return []
    let 文件们 = []
    try {
      文件们 = readdirSync(this.inboxDir, { withFileTypes: true })
        .filter((x) => x.isFile() && /^qq-image-.*\.(gif|png|jpe?g|webp|bmp)$/i.test(x.name))
        .map((x) => {
          const 路径 = join(this.inboxDir, x.name)
          let 信息 = { mtime: 0, size: 0 }
          try {
            const st = statSync(路径)
            信息 = { mtime: st.mtimeMs, size: st.size }
          } catch { /* 忽略 */ }
          return {
            name: x.name,
            path: 路径,
            size: 信息.size,
            mtime: 信息.mtime,
            type: /\.gif$/i.test(x.name) ? 'gif' : 'img',
            mime: 图片Mime(x.name),
          }
        })
    } catch {
      return []
    }
    return 文件们.sort((a, b) => b.mtime - a.mtime).slice(0, Math.max(1, Math.min(100, Math.round(数字(limit, 20)))))
  }

  /** 清空「最近收到的图片」：只删 qq-image-*，不碰别的文件。 */
  清理接收目录() {
    if (!this.inboxDir) return { ok: true, removed: 0, freedBytes: 0 }
    let 删 = 0
    let 释放 = 0
    try {
      for (const x of readdirSync(this.inboxDir, { withFileTypes: true })) {
        if (!x.isFile() || !/^qq-image-.*\.(gif|png|jpe?g|webp|bmp)$/i.test(x.name)) continue
        const 路径 = join(this.inboxDir, x.name)
        try { 释放 += statSync(路径).size } catch { /* 忽略 */ }
        try { rmSync(路径, { force: true }); 删 += 1 } catch { /* 忽略 */ }
      }
    } catch {
      return { ok: true, removed: 0, freedBytes: 0 }
    }
    return { ok: true, removed: 删, freedBytes: 释放, freedMB: Math.round((释放 / 1048576) * 10) / 10 }
  }

  /** 兼容多选上传：一次存多张。 */
  saveMany(文件们, 选项 = {}) {
    const 结果 = []
    for (const 文件 of 文件们 || []) {
      try {
        const r = this.save(文件.path ?? 文件.buffer ?? 文件, {
          ...选项,
          ...(文件.name ? { name: 文件.name } : {}),
        })
        结果.push({ ok: true, ...r, name: 文件.name || basename(String(文件.path || '')) })
      } catch (error) {
        结果.push({
          ok: false,
          name: 文件?.name || basename(String(文件?.path || '')),
          code: error?.code || 'sticker_error',
          error: String(error?.hint || error?.message || error),
        })
      }
    }
    return 结果
  }
}

export { 默认最大条数 as STICKER_DEFAULT_MAX_COUNT, 默认最大MB as STICKER_DEFAULT_MAX_MB }
