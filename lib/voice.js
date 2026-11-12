// 媒体落盘：入站语音（get_record → wav）与入站图片，只碰 QQ 传输和本机文件。
//
// **不做语音识别、不做语音合成**：这两项由可选的本地 AI 插件提供，桥层通过
// AiService 调用；VoiceService 只负责把 QQ 里的文件拿下来、存到 inbox/，
// 把「本地路径 + 时长」交给会话。出站只认 [语音:路径] 这种已有文件。
//
// 入站语音：record 段 → transport.get_record（NapCat 直接给 wav）→ 落 inbox → 返回路径/时长
// 入站图片：下载 / base64 / 本机文件 → 落 inbox → 返回 base64 + 路径
//
// 这个文件不发 HTTP 请求（除了通过注入的 transport 走 OneBot），单测可以完全离线。

import { extname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'

const audioExt = new Set(['.wav', '.mp3', '.amr', '.silk', '.slk', '.ogg', '.m4a', '.flac', '.aac', '.opus', '.wma', '.aiff', '.ape'])
const imageExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

const safeName = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || randomUUID()

function guessExtFromPath(p, fallback = '.bin') {
  const e = extname(String(p || '')).toLowerCase()
  return e && e.length <= 8 ? e : fallback
}

function guessExtFromMime(mime, fallback = '.bin') {
  const m = String(mime || '').toLowerCase()
  if (m.includes('png')) return '.png'
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg'
  if (m.includes('gif')) return '.gif'
  if (m.includes('webp')) return '.webp'
  if (m.includes('wav')) return '.wav'
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3'
  if (m.includes('ogg')) return '.ogg'
  if (m.includes('amr')) return '.amr'
  return fallback
}

function imageCategory(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif'
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp'
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  } catch { /* 忽略 */ }
  return 'image/jpeg'
}

function isWav(buf) {
  return buf && buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE'
}

/**
 * 从 wav 头读时长（秒）；读不出来返回 0。
 *
 * 只解析本地文件，不调 ffprobe / 不联网：get_record 拿到的通常就是 16k wav，
 * 这里只为给会话提示「N 秒」，解析失败不影响消息本身。
 */
export function readWavDurationSeconds(path) {
  try {
    const buf = readFileSync(path)
    if (!isWav(buf)) return 0
    let offset = 12
    let sampleRate = 0
    let channels = 0
    let bitDepth = 0
    let dataLength = 0
    while (offset + 8 <= buf.length) {
      const blockName = buf.toString('ascii', offset, offset + 4)
      const blockLength = buf.readUInt32LE(offset + 4)
      if (blockName === 'fmt ' && offset + 24 <= buf.length) {
        channels = buf.readUInt16LE(offset + 10)
        sampleRate = buf.readUInt32LE(offset + 12)
        bitDepth = buf.readUInt16LE(offset + 22)
      } else if (blockName === 'data') {
        dataLength = Math.min(blockLength, Math.max(0, buf.length - offset - 8))
        break
      }
      // 块按偶数字节对齐；块长为 0 说明头坏了，直接放弃。
      if (!blockLength) break
      offset += 8 + blockLength + (blockLength % 2)
    }
    const bytesPerFrame = channels * (bitDepth / 8)
    if (!sampleRate || !bytesPerFrame || !dataLength) return 0
    const second = dataLength / (sampleRate * bytesPerFrame)
    return Number.isFinite(second) && second > 0 ? second : 0
  } catch {
    return 0
  }
}

export class VoiceService {
  constructor({ getConfig, logger, transport, inboxDir }) {
    this.getConfig = getConfig
    this.logger = logger
    this.transport = transport
    this.inboxDir = inboxDir
  }

  ensureDirs() {
    try { mkdirSync(this.inboxDir, { recursive: true }) } catch { /* 忽略 */ }
  }

  saveBuffer(buffer, prefix, ext) {
    this.ensureDirs()
    const file = join(this.inboxDir, `${safeName(prefix)}-${Date.now()}.${String(ext || 'bin').replace(/^\./, '')}`)
    writeFileSync(file, buffer)
    return file
  }

  /** 下载入站语音的原始文件（拿不到 get_record 时的兜底）。 */
  async bytesFromSegment(segment, maxBytes) {
    const d = segment?.data || {}
    const candidate = []
    const file = String(d.file || '').trim()
    const url = String(d.url || '').trim()
    if (url.startsWith('http')) candidate.push({ kind: 'url', value: url })
    if (file.startsWith('base64://')) candidate.push({ kind: 'base64', value: file })
    else if (/^https?:/i.test(file)) candidate.push({ kind: 'url', value: file })
    else if (file && existsSync(file)) candidate.push({ kind: 'local', value: file })
    if (d.path && existsSync(String(d.path))) candidate.push({ kind: 'local', value: String(d.path) })

    let lastError = ''
    for (const x of candidate) {
      try {
        let buf
        if (x.kind === 'url') buf = await this.transport.download(x.value, { maxBytes })
        else if (x.kind === 'base64') buf = Buffer.from(x.value.slice('base64://'.length), 'base64')
        else buf = readFileSync(x.value)
        if (buf?.length) return { buffer: buf, ext: guessExtFromPath(x.value, '.amr') }
      } catch (error) {
        lastError = String(error?.message || error)
      }
    }
    throw new Error(lastError || '没有可用的语音地址')
  }

  /**
   * 把 record 段变成 inbox 里的本地文件。
   *
   * 只做传输层处理：先问 get_record（NapCat 解码 silk/amr，给 wav），
   * 拿不到再下载 / 解 base64 / 读本机文件。**不转 16k、不调 /media/to_wav、不转写。**
   *
   * @returns {Promise<{rawPath:string, wavPath:string, isWav:boolean, seconds:number}>}
   */
  async recordToFile(segment, messageId = '') {
    const d = segment?.data || {}
    const originalName = String(d.file || d.url || '').trim()
    let raw = null
    let rawExt = guessExtFromPath(originalName, '.amr')

    // ① get_record：最省事，NapCat 直接给 wav。
    if (originalName) {
      try {
        const data = await this.transport.getRecord(originalName)
        const local = data?.file || data?.path
        if (local && existsSync(String(local))) {
          raw = readFileSync(String(local))
          rawExt = guessExtFromPath(String(local), '.wav')
        } else if (data?.base64) {
          raw = Buffer.from(String(data.base64).replace(/^data:[^,]*,/, ''), 'base64')
          rawExt = '.wav'
        } else if (data?.url) {
          raw = await this.transport.download(String(data.url), { maxBytes: Number(this.getConfig().maxVoiceMB) * 1024 * 1024 })
          rawExt = guessExtFromPath(String(data.url), '.wav')
        }
      } catch (error) {
        this.logger?.debug(`get_record 失败，尝试直接下载：${String(error?.message || error)}`)
      }
    }

    // ② 直接下载 / base64 / 本机文件。
    if (!raw) {
      const get = await this.bytesFromSegment(segment, Number(this.getConfig().maxVoiceMB) * 1024 * 1024)
      raw = get.buffer
      rawExt = get.ext || rawExt
    }
    if (!raw?.length) throw new Error('语音文件是空的')

    const rawPath = this.saveBuffer(raw, `qq-voice-${messageId || 'x'}`, rawExt)
    const wavFile = isWav(raw)
    // 非 wav 保留原样；不再为了 ASR 去转 16k。
    const seconds = wavFile
      ? readWavDurationSeconds(rawPath)
      : segmentDurationSeconds(d)

    return {
      rawPath,
      // 落盘文件名不变：是 wav 就直接用，不是也把原始文件路径交出去（不再转码合成）。
      wavPath: rawPath,
      isWav: wavFile,
      seconds,
    }
  }

  /** 入站图片：下载 / 解码 → inbox，返回 base64 和本地路径。 */
  async fetchImage(segment, messageId, index = 1) {
    const d = segment?.data || {}
    const max = Number(this.getConfig().maxImageMB) * 1024 * 1024
    const candidate = []
    const url = String(d.url || '').trim()
    const file = String(d.file || '').trim()
    if (url.startsWith('http')) candidate.push({ kind: 'url', value: url })
    if (file.startsWith('base64://')) candidate.push({ kind: 'base64', value: file })
    else if (/^https?:/i.test(file)) candidate.push({ kind: 'url', value: file })
    else if (file && existsSync(file)) candidate.push({ kind: 'local', value: file })
    if (d.path && existsSync(String(d.path))) candidate.push({ kind: 'local', value: String(d.path) })

    let lastError = ''
    for (const x of candidate) {
      try {
        let buf
        if (x.kind === 'url') buf = await this.transport.download(x.value, { maxBytes: max })
        else if (x.kind === 'base64') buf = Buffer.from(x.value.slice('base64://'.length), 'base64')
        else buf = readFileSync(x.value)
        if (!buf?.length) continue
        if (buf.length > max) throw new Error(`图片超过 ${Math.round(max / 1048576)}MB`)
        const mime = imageCategory(buf)
        // 扩展名取实际嗅探出的格式，不信消息里带的 ext（同 sha 才可能同名）。
        const ext = guessExtFromMime(mime, '.jpg')
        this.ensureDirs()
        // 内容寻址：同一张图重复收到时复用同一个文件，不再按消息 id / 时间堆副本。
        // 前缀仍是 qq-image-*，清理与「最近图片」的匹配规则不用变。
        const path = join(this.inboxDir, `qq-image-${createHash('sha256').update(buf).digest('hex').slice(0, 16)}${ext}`)
        if (!existsSync(path)) writeFileSync(path, buf)
        return { buffer: buf, base64: buf.toString('base64'), mime, path: path, ext: ext }
      } catch (error) {
        lastError = String(error?.message || error)
      }
    }
    throw new Error(lastError || '没有可用的图片地址')
  }
}

/**
 * 段里自带的时长（有些 OneBot 实现会给 duration）。
 * 只接受看起来像「秒」的值：0.1~600；超出的当毫秒或脏数据，直接忽略。
 */
function segmentDurationSeconds(d) {
  const n = Number(d?.duration)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n >= 0.1 && n <= 600) return n
  if (n > 600 && n <= 600000) return n / 1000
  return 0
}

export { imageCategory, guessExtFromMime, audioExt, imageExt }
