// 语音 / 图片 / TTS / ASR：只调本地 AI 服务（127.0.0.1:7880）的 HTTP 接口，不改它的代码。
//
// 入站语音：record 段 → get_record(wav) → 落 inbox → /asr?speaker=1 → 文字 + 声纹名
// 出站语音：[语音]文字[/语音] → /tts → 落 outbox → 交给 transport 发 record
// 另外提供 /media/to_wav 和图片下载/落盘，给 Bridge 复用。

import { spawn } from 'node:child_process'
import { basename, extname, join } from 'node:path'
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

async function 带超时(地址, 选项, 毫秒) {
  const 控 = new AbortController()
  const 定时 = setTimeout(() => 控.abort(new Error(`超时（${Math.round(毫秒 / 1000)} 秒）`)), Math.max(1000, 毫秒))
  try {
    return await fetch(地址, { ...选项, signal: 控.signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`请求超时（${Math.round(毫秒 / 1000)} 秒）`)
    throw error
  } finally {
    clearTimeout(定时)
  }
}

export class VoiceService {
  constructor({ getConfig, logger, transport, inboxDir, outboxDir }) {
    this.getConfig = getConfig
    this.logger = logger
    this.transport = transport
    this.inboxDir = inboxDir
    this.outboxDir = outboxDir
    this.asrBusy = false
  }

  ensureDirs() {
    try { mkdirSync(this.inboxDir, { recursive: true }) } catch { /* 忽略 */ }
    try { mkdirSync(this.outboxDir, { recursive: true }) } catch { /* 忽略 */ }
  }

  saveBuffer(buffer, prefix, ext) {
    this.ensureDirs()
    const 文件 = join(this.inboxDir, `${安全名(prefix)}-${Date.now()}.${String(ext || 'bin').replace(/^\./, '')}`)
    writeFileSync(文件, buffer)
    return 文件
  }

  saveOut(buffer, prefix, ext) {
    this.ensureDirs()
    const 文件 = join(this.outboxDir, `${安全名(prefix)}-${Date.now()}.${String(ext || 'bin').replace(/^\./, '')}`)
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
   * 把 record 段变成 wav 文件。
   * 先问 get_record（NapCat 解码 silk/amr），拿不到再下载/读本地。
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

    // ② 直接下载 / base64 / 本地文件。
    if (!raw) {
      const 取 = await this.bytesFromSegment(segment, Number(this.getConfig().maxVoiceMB) * 1024 * 1024)
      raw = 取.buffer
      rawExt = 取.ext || rawExt
    }
    if (!raw?.length) throw new Error('语音文件是空的')

    const rawPath = this.saveBuffer(raw, `qq-voice-${messageId || 'x'}`, rawExt)
    let wavPath = 是wav(raw) ? rawPath : ''
    if (!wavPath) {
      try {
        wavPath = await this.toWav(rawPath)
      } catch (error) {
        this.logger?.warn(`语音转 16k wav 失败，直接把原文件交给 ASR：${String(error?.message || error)}`)
      }
    }
    return { rawPath, wavPath: wavPath || rawPath, isWav: Boolean(wavPath) }
  }

  /** 调本地 /media/to_wav，落盘成 16k 单声道 wav。 */
  async toWav(path) {
    const 配置 = this.getConfig()
    if (!配置.asrBaseUrl) throw new Error('ASR 服务地址未配置（asrBaseUrl 为空），无法转 wav')
    const 根 = 配置.asrBaseUrl
    const 字节 = readFileSync(path)
    const form = new FormData()
    form.append('file', new Blob([字节]), basename(path))
    const 响应 = await 带超时(`${根}/media/to_wav`, {
      method: 'POST',
      body: form,
    }, Math.max(15000, Number(配置.asrTimeoutMs) || 180000))
    if (!响应.ok) {
      const 文 = await 响应.text().catch(() => '')
      throw new Error(`/media/to_wav HTTP ${响应.status} ${文.slice(0, 160)}`)
    }
    const buf = Buffer.from(await 响应.arrayBuffer())
    if (!buf.length) throw new Error('/media/to_wav 返回空文件')
    return this.saveBuffer(buf, 'voice-16k', 'wav')
  }

  /** 外部命令转写：模板里必须带 {file}。 */
  async transcribeByCommand(path, command, timeoutMs) {
    if (!String(command).includes('{file}')) throw new Error('转写命令里没有 {file} 占位符')
    const 完整 = String(command).replace(/\{file\}/g, path)
    return await new Promise((resolve, reject) => {
      let 出 = ''
      let 错 = ''
      let 结束 = false
      const 子 = spawn(完整, { shell: true, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
      const 定时 = setTimeout(() => {
        if (结束) return
        结束 = true
        try { 子.kill() } catch { /* 忽略 */ }
        reject(new Error(`转写命令超时（${Math.round(timeoutMs / 1000)} 秒）`))
      }, Math.max(5000, timeoutMs))
      子.stdout?.on('data', (c) => { 出 += String(c) })
      子.stderr?.on('data', (c) => { 错 += String(c) })
      子.on('error', (error) => {
        if (结束) return
        结束 = true
        clearTimeout(定时)
        reject(error)
      })
      子.on('close', (码) => {
        if (结束) return
        结束 = true
        clearTimeout(定时)
        const 文字 = 出.trim()
        if (码 === 0 && 文字) resolve({ text: 文字, speakerName: '', speakerKnown: false, raw: null })
        else reject(new Error(`转写命令退出码 ${码}：${(错 || 出 || '').trim().slice(0, 200)}`))
      })
    })
  }

  /**
   * 对一个已有的本地音频文件做转写（入站语音用）。
   * 返回统一的 { text, speakerName, speakerKnown, engine, raw }。
   */
  async asrFile(path) {
    const 配置 = this.getConfig()
    if (!配置.asrBaseUrl && !配置.asrCommand) {
      throw new Error('ASR 服务地址未配置：请在设置里填写 asrBaseUrl，或配置 asrCommand')
    }
    const 要转 = String(path || '').trim()
    if (!要转 || !existsSync(要转)) throw new Error(`音频文件不存在：${要转}`)

    if (配置.asrCommand) {
      const 结果 = await this.transcribeByCommand(要转, 配置.asrCommand, Number(配置.asrTimeoutMs) || 180000)
      return {
        text: String(结果.text || '').trim(),
        speakerName: String(结果.speakerName || ''),
        speakerKnown: Boolean(结果.speakerKnown),
        engine: 'command',
        raw: 结果.raw || null,
      }
    }

    const 字节 = readFileSync(要转)
    const form = new FormData()
    form.append('file', new Blob([字节], { type: 'audio/wav' }), basename(要转))
    const 响应 = await 带超时(`${配置.asrBaseUrl}/asr?speaker=1`, {
      method: 'POST',
      body: form,
    }, Number(配置.asrTimeoutMs) || 180000)
    const 文本 = await 响应.text()
    let json = null
    try { json = JSON.parse(文本) } catch { /* 下面报错 */ }
    if (!响应.ok || !json?.ok) {
      throw new Error(`/asr HTTP ${响应.status} ${(json?.detail || 文本 || '').slice(0, 200)}`)
    }
    return {
      text: String(json.text || '').trim(),
      speakerName: json.speaker?.name ? String(json.speaker.name) : '',
      speakerKnown: Boolean(json.speaker?.known),
      engine: String(json.engine || json.model || json.backend || 'local-asr'),
      raw: json,
    }
  }

  /** 一条语音 → 文字 + 声纹。 */
  async transcribeRecord(segment, messageId, 称呼 = '') {
    const 配置 = this.getConfig()
    if (!配置.transcriptionEnabled) return { text: '', speakerName: '', error: '', skipped: true }
    const 文件 = await this.recordToFile(segment, messageId)
    const 要转 = 文件.wavPath || 文件.rawPath
    const 结果 = await this.asrFile(要转)
    if (!结果.text) throw new Error('ASR 没有返回文字')
    return {
      text: 结果.text,
      speakerName: 结果.speakerName || '',
      speakerKnown: Boolean(结果.speakerKnown),
      engine: 结果.engine,
      称呼,
      rawPath: 文件.rawPath,
      wavPath: 文件.wavPath,
      error: '',
    }
  }

  /**
   * 出站 TTS：返回本地 wav 路径。
   * @param {object} [选项] { voice }：指定音色；补发 record_text 时传入队时记下的音色。
   */
  async synthesize(text, 选项 = {}) {
    const 配置 = this.getConfig()
    if (!配置.ttsEnabled) throw new Error('TTS 开关关着')
    if (!配置.ttsBaseUrl) throw new Error('TTS 服务地址未配置：请在设置里填写 ttsBaseUrl')
    const 正文 = String(text || '').trim()
    if (!正文) throw new Error('要合成的文字是空的')
    if (正文.length > 5000) throw new Error('TTS 文字超过 5000 字')
    const 音色 = String(选项.voice || 配置.ttsVoice || '').slice(0, 80)
    const 响应 = await 带超时(`${配置.ttsBaseUrl}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text: 正文, voice: 音色 }),
    }, Number(配置.ttsTimeoutMs) || 180000)
    if (!响应.ok) {
      const 文 = await 响应.text().catch(() => '')
      throw new Error(`/tts HTTP ${响应.status} ${文.slice(0, 200)}`)
    }
    const 类型 = String(响应.headers.get('content-type') || '')
    if (类型 && !类型.includes('audio') && !类型.includes('octet-stream')) {
      const 文 = await 响应.text().catch(() => '')
      throw new Error(`/tts 返回的不是音频：${类型} ${文.slice(0, 120)}`)
    }
    const buf = Buffer.from(await 响应.arrayBuffer())
    if (!buf.length) throw new Error('/tts 返回空文件')
    return this.saveOut(buf, `tts-${音色 || 'voice'}`, 从Mime猜扩展(类型, '.wav'))
  }

  /** 入站图片：下载/解码 → inbox，返回 base64 和本地路径。 */
  async fetchImage(segment, messageId, index = 1) {
    const d = segment?.data || {}
    const 最大 = Number(this.getConfig().maxImageMB) * 1024 * 1024
    const 候 = []
    const url = String(d.url || '').trim()
    const file = String(d.file || '').trim()
    if (url.startsWith('http')) 候.push({ kind: 'url', value: url })
    if (file.startsWith('base64://')) 候.push({ kind: 'base64', value: file })
    else if (/^https?:/i.test(file)) 候.push({ kind: 'url', value: file })
    else if (file && existsSync(file)) 候.push({ kind: 'local', value: file })
    if (d.path && existsSync(String(d.path))) 候.push({ kind: 'local', value: String(d.path) })

    let 最后 = ''
    for (const x of 候) {
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

  /** 健康检查（给设置页显示本地 AI 服务在不在）。 */
  async health() {
    const 配置 = this.getConfig()
    try {
      const 响应 = await 带超时(`${配置.asrBaseUrl}/health`, {}, 3000)
      const json = await 响应.json().catch(() => null)
      return { ok: Boolean(json?.ok), asrReady: Boolean(json?.asr?.ready), ttsReady: Boolean(json?.model_ready || json?.engine_loaded) }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }
}

export { 看图类, 从Mime猜扩展, 音频扩展, 图片扩展 }
