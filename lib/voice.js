// 媒体落盘：入站语音（get_record → wav）与入站图片，只碰 QQ 传输和本机文件。
//
// **不做语音识别、不做语音合成**：ASR / TTS 已经上移到 dsh-fish-ops
//（它调 fish.service，再经 fish.message 发出去）。鱼讯只负责把 QQ 里的文件拿下来、
// 存到 inbox/、把「本地路径 + 时长」交给会话；出站只认 [语音:路径] 这种已有文件。
//
// 入站语音：record 段 → transport.get_record（NapCat 直接给 wav）→ 落 inbox → 返回路径/时长
// 入站图片：下载 / base64 / 本机文件 → 落 inbox → 返回 base64 + 路径
//
// 这个文件不发 HTTP 请求（除了通过注入的 transport 走 OneBot），单测可以完全离线。

import { extname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const 音频扩展 = new Set(['.wav', '.mp3', '.amr', '.silk', '.slk', '.ogg', '.m4a', '.flac', '.aac', '.opus', '.wma', '.aiff', '.ape'])
const 图片扩展 = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

const 安全名 = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || randomUUID()

function 从路径猜扩展(p, 兜底 = '.bin') {
  const e = extname(String(p || '')).toLowerCase()
  return e && e.length <= 8 ? e : 兜底
}

function 从Mime猜扩展(mime, 兜底 = '.bin') {
  const m = String(mime || '').toLowerCase()
  if (m.includes('png')) return '.png'
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg'
  if (m.includes('gif')) return '.gif'
  if (m.includes('webp')) return '.webp'
  if (m.includes('wav')) return '.wav'
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3'
  if (m.includes('ogg')) return '.ogg'
  if (m.includes('amr')) return '.amr'
  return 兜底
}

function 看图类(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif'
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp'
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  } catch { /* 忽略 */ }
  return 'image/jpeg'
}

function 是wav(buf) {
  return buf && buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE'
}

/**
 * 从 wav 头读时长（秒）；读不出来返回 0。
 *
 * 只解析本地文件，不调 ffprobe / 不联网：get_record 拿到的通常就是 16k wav，
 * 这里只为给会话提示「N 秒」，解析失败不影响消息本身。
 */
export function 读wav时长秒(path) {
  try {
    const buf = readFileSync(path)
    if (!是wav(buf)) return 0
    let 偏移 = 12
    let 采样率 = 0
    let 声道 = 0
    let 位深 = 0
    let 数据长 = 0
    while (偏移 + 8 <= buf.length) {
      const 块名 = buf.toString('ascii', 偏移, 偏移 + 4)
      const 块长 = buf.readUInt32LE(偏移 + 4)
      if (块名 === 'fmt ' && 偏移 + 24 <= buf.length) {
        声道 = buf.readUInt16LE(偏移 + 10)
        采样率 = buf.readUInt32LE(偏移 + 12)
        位深 = buf.readUInt16LE(偏移 + 22)
      } else if (块名 === 'data') {
        数据长 = Math.min(块长, Math.max(0, buf.length - 偏移 - 8))
        break
      }
      // 块按偶数字节对齐；块长为 0 说明头坏了，直接放弃。
      if (!块长) break
      偏移 += 8 + 块长 + (块长 % 2)
    }
    const 每帧字节 = 声道 * (位深 / 8)
    if (!采样率 || !每帧字节 || !数据长) return 0
    const 秒 = 数据长 / (采样率 * 每帧字节)
    return Number.isFinite(秒) && 秒 > 0 ? 秒 : 0
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
    const 文件 = join(this.inboxDir, `${安全名(prefix)}-${Date.now()}.${String(ext || 'bin').replace(/^\./, '')}`)
    writeFileSync(文件, buffer)
    return 文件
  }

  /** 下载入站语音的原始文件（拿不到 get_record 时的兜底）。 */
  async bytesFromSegment(segment, maxBytes) {
    const d = segment?.data || {}
    const 候选 = []
    const file = String(d.file || '').trim()
    const url = String(d.url || '').trim()
    if (url.startsWith('http')) 候选.push({ kind: 'url', value: url })
    if (file.startsWith('base64://')) 候选.push({ kind: 'base64', value: file })
    else if (/^https?:/i.test(file)) 候选.push({ kind: 'url', value: file })
    else if (file && existsSync(file)) 候选.push({ kind: 'local', value: file })
    if (d.path && existsSync(String(d.path))) 候选.push({ kind: 'local', value: String(d.path) })

    let 最后错误 = ''
    for (const x of 候选) {
      try {
        let buf
        if (x.kind === 'url') buf = await this.transport.download(x.value, { maxBytes })
        else if (x.kind === 'base64') buf = Buffer.from(x.value.slice('base64://'.length), 'base64')
        else buf = readFileSync(x.value)
        if (buf?.length) return { buffer: buf, ext: 从路径猜扩展(x.value, '.amr') }
      } catch (error) {
        最后错误 = String(error?.message || error)
      }
    }
    throw new Error(最后错误 || '没有可用的语音地址')
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
    const 原名 = String(d.file || d.url || '').trim()
    let raw = null
    let rawExt = 从路径猜扩展(原名, '.amr')

    // ① get_record：最省事，NapCat 直接给 wav。
    if (原名) {
      try {
        const 数据 = await this.transport.getRecord(原名)
        const 本地 = 数据?.file || 数据?.path
        if (本地 && existsSync(String(本地))) {
          raw = readFileSync(String(本地))
          rawExt = 从路径猜扩展(String(本地), '.wav')
        } else if (数据?.base64) {
          raw = Buffer.from(String(数据.base64).replace(/^data:[^,]*,/, ''), 'base64')
          rawExt = '.wav'
        } else if (数据?.url) {
          raw = await this.transport.download(String(数据.url), { maxBytes: Number(this.getConfig().maxVoiceMB) * 1024 * 1024 })
          rawExt = 从路径猜扩展(String(数据.url), '.wav')
        }
      } catch (error) {
        this.logger?.debug(`get_record 失败，尝试直接下载：${String(error?.message || error)}`)
      }
    }

    // ② 直接下载 / base64 / 本机文件。
    if (!raw) {
      const 取 = await this.bytesFromSegment(segment, Number(this.getConfig().maxVoiceMB) * 1024 * 1024)
      raw = 取.buffer
      rawExt = 取.ext || rawExt
    }
    if (!raw?.length) throw new Error('语音文件是空的')

    const rawPath = this.saveBuffer(raw, `qq-voice-${messageId || 'x'}`, rawExt)
    const isWav = 是wav(raw)
    // 非 wav 保留原样；不再为了 ASR 去转 16k。
    const seconds = isWav
      ? 读wav时长秒(rawPath)
      : 段内时长秒(d)

    return {
      rawPath,
      // 落盘文件名不变：是 wav 就直接用，不是也把原始文件路径交出去（不再转码合成）。
      wavPath: rawPath,
      isWav,
      seconds,
    }
  }

  /** 入站图片：下载 / 解码 → inbox，返回 base64 和本地路径。 */
  async fetchImage(segment, messageId, index = 1) {
    const d = segment?.data || {}
    const 最大 = Number(this.getConfig().maxImageMB) * 1024 * 1024
    const 候选 = []
    const url = String(d.url || '').trim()
    const file = String(d.file || '').trim()
    if (url.startsWith('http')) 候选.push({ kind: 'url', value: url })
    if (file.startsWith('base64://')) 候选.push({ kind: 'base64', value: file })
    else if (/^https?:/i.test(file)) 候选.push({ kind: 'url', value: file })
    else if (file && existsSync(file)) 候选.push({ kind: 'local', value: file })
    if (d.path && existsSync(String(d.path))) 候选.push({ kind: 'local', value: String(d.path) })

    let 最后 = ''
    for (const x of 候选) {
      try {
        let buf
        if (x.kind === 'url') buf = await this.transport.download(x.value, { maxBytes: 最大 })
        else if (x.kind === 'base64') buf = Buffer.from(x.value.slice('base64://'.length), 'base64')
        else buf = readFileSync(x.value)
        if (!buf?.length) continue
        if (buf.length > 最大) throw new Error(`图片超过 ${Math.round(最大 / 1048576)}MB`)
        const mime = 看图类(buf)
        const 扩展名 = 从Mime猜扩展(mime, '.jpg')
        this.ensureDirs()
        const 路径 = join(this.inboxDir, `qq-image-${安全名(messageId)}-${index}-${Date.now()}${扩展名}`)
        writeFileSync(路径, buf)
        return { buffer: buf, base64: buf.toString('base64'), mime, path: 路径, ext: 扩展名 }
      } catch (error) {
        最后 = String(error?.message || error)
      }
    }
    throw new Error(最后 || '没有可用的图片地址')
  }
}

/**
 * 段里自带的时长（有些 OneBot 实现会给 duration）。
 * 只接受看起来像「秒」的值：0.1~600；超出的当毫秒或脏数据，直接忽略。
 */
function 段内时长秒(d) {
  const n = Number(d?.duration)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n >= 0.1 && n <= 600) return n
  if (n > 600 && n <= 600000) return n / 1000
  return 0
}

export { 看图类, 从Mime猜扩展, 音频扩展, 图片扩展 }
