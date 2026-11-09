// 测试用的本地 AI 服务：只实现 /asr、/tts、/media/to_wav、/health。
// 完全离线，不发真实请求；用 failAsr / failTts 模拟 502 上游错误。

import http from 'node:http'

function 读体(req) {
  return new Promise((resolve) => {
    const 块们 = []
    req.on('data', (c) => 块们.push(c))
    req.on('end', () => resolve(Buffer.concat(块们)))
    req.on('error', () => resolve(Buffer.alloc(0)))
  })
}

function 回(res, 数据, code = 200, 类型 = 'application/json; charset=utf-8') {
  const 体 = Buffer.isBuffer(数据) ? 数据 : Buffer.from(JSON.stringify(数据))
  res.writeHead(code, { 'content-type': 类型, 'content-length': 体.length })
  res.end(体)
}

/** 一个最小的 16k 单声道 wav 头，voice 只检查文件非空，不校验音频内容。 */
function 小wav() {
  const 头 = Buffer.alloc(44)
  头.write('RIFF', 0, 'ascii')
  头.writeUInt32LE(36, 4)
  头.write('WAVE', 8, 'ascii')
  头.write('fmt ', 12, 'ascii')
  头.writeUInt32LE(16, 16)
  头.writeUInt16LE(1, 20)
  头.writeUInt16LE(1, 22)
  头.writeUInt32LE(16000, 24)
  头.writeUInt32LE(32000, 28)
  头.writeUInt16LE(2, 32)
  头.writeUInt16LE(16, 34)
  头.write('data', 36, 'ascii')
  头.writeUInt32LE(0, 40)
  return 头
}

export class MockAiServer {
  constructor() {
    this.port = 0
    this.server = null
    this.asrCalls = 0
    this.ttsCalls = 0
    this.toWavCalls = 0
    this.failAsr = false
    this.failTts = false
    this.回显 = '这是 Mock ASR 转写出来的文字'
    this.engine = 'mock-asr'
  }

  get baseUrl() { return `http://127.0.0.1:${this.port}` }

  async start() {
    this.server = http.createServer(async (req, res) => {
      const 路径 = String(req.url || '/').split('?')[0]
      await 读体(req)
      if (路径 === '/health') {
        return 回(res, { ok: true, asr: { ready: true }, model_ready: true })
      }
      if (路径 === '/asr') {
        this.asrCalls++
        if (this.failAsr) return 回(res, { ok: false, detail: '模拟 ASR 失败' }, 500)
        return 回(res, {
          ok: true,
          text: this.回显,
          speaker: { name: '主人', known: true },
          engine: this.engine,
        })
      }
      if (路径 === '/tts') {
        this.ttsCalls++
        if (this.failTts) return 回(res, { ok: false, detail: '模拟 TTS 失败' }, 500)
        return 回(res, 小wav(), 200, 'audio/wav')
      }
      if (路径 === '/media/to_wav') {
        this.toWavCalls++
        return 回(res, 小wav(), 200, 'audio/wav')
      }
      return 回(res, { ok: false, detail: `未知路径 ${路径}` }, 404)
    })
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.port = this.server.address().port
    return this
  }

  async stop() {
    await new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve())
      else resolve()
    })
  }
}
