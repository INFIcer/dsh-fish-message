// 测试用的最小 OneBot 11 服务器：HTTP + WebSocket。
// 只实现本插件用到的四个动作，足够验证收、发、补投和去重。

import http from 'node:http'
import { WebSocketServer } from 'ws'

function 读体(req) {
  return new Promise((resolve) => {
    let 文 = ''
    req.on('data', (c) => { 文 += c })
    req.on('end', () => {
      try { resolve(JSON.parse(文 || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function 回(res, 数据, code = 200) {
  const 文 = JSON.stringify(数据)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(文)
}

export class MockOneBotServer {
  constructor() {
    this.history = new Map()
    this.sent = []
    this.requests = []
    this.clients = new Set()
    this.下一个id = 9000
    this.server = null
    this.wss = null
    this.port = 0
  }

  get baseUrl() { return `http://127.0.0.1:${this.port}` }
  get wsUrl() { return `ws://127.0.0.1:${this.port}` }

  async start() {
    this.server = http.createServer(async (req, res) => {
      const 体 = await 读体(req)
      const action = String(req.url || '').replace(/^\//, '').split('?')[0]
      this.requests.push({ action, body: 体 })
      if (action === 'get_login_info') {
        return 回(res, { status: 'ok', retcode: 0, data: { user_id: 2983830957, nickname: '测试机器人' } })
      }
      if (action === 'get_friend_msg_history') {
        const qq = String(体.user_id)
        const 全部 = this.history.get(qq) || []
        const 数 = Math.max(1, Math.min(500, Number(体.count) || 100))
        // 模拟 NapCat：带 message_id 时，返回该条往前数（含锚点）。
        if (体.message_id !== undefined && 体.message_id !== null && 体.message_id !== '') {
          const 锚 = 全部.findIndex((m) => String(m.message_id) === String(体.message_id))
          if (锚 >= 0) {
            const 起 = Math.max(0, 锚 - 数 + 1)
            return 回(res, { status: 'ok', retcode: 0, data: { messages: 全部.slice(起, 锚 + 1) } })
          }
        }
        return 回(res, { status: 'ok', retcode: 0, data: { messages: 全部.slice(-数) } })
      }
      if (action === 'send_private_msg') {
        this.sent.push(体)
        return 回(res, { status: 'ok', retcode: 0, data: { message_id: this.下一个id++ } })
      }
      if (action === 'get_record') {
        return 回(res, { status: 'ok', retcode: 0, data: { file: '' } })
      }
      return 回(res, { status: 'failed', retcode: 404, wording: `未知动作 ${action}` }, 404)
    })
    this.wss = new WebSocketServer({ server: this.server })
    this.wss.on('connection', (ws) => {
      this.clients.add(ws)
      ws.on('close', () => this.clients.delete(ws))
      ws.on('error', () => this.clients.delete(ws))
    })
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.port = this.server.address().port
    return this
  }

  async stop() {
    for (const ws of this.clients) {
      try { ws.terminate() } catch { /* 忽略 */ }
    }
    this.clients.clear()
    await new Promise((resolve) => {
      if (this.wss) this.wss.close(() => resolve())
      else resolve()
    })
    await new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve())
      else resolve()
    })
  }

  setHistory(qq, messages) {
    this.history.set(String(qq), messages)
  }

  addHistory(qq, message) {
    const k = String(qq)
    if (!this.history.has(k)) this.history.set(k, [])
    this.history.get(k).push(message)
  }

  /** 给所有 WebSocket 客户端推一条 OneBot 事件。 */
  broadcast(event) {
    const 文 = JSON.stringify(event)
    for (const ws of this.clients) {
      try { ws.send(文) } catch { /* 忽略 */ }
    }
    return this.clients.size
  }
}

export function 消息(id, 文本, 时间, qq = '10001') {
  return {
    message_id: Number(id),
    message_seq: Number(id),
    time: Number(时间),
    user_id: Number(qq),
    message_type: 'private',
    message: [{ type: 'text', data: { text: 文本 } }],
    raw_message: 文本,
    sender: { user_id: Number(qq), nickname: '主人' },
  }
}

export const 睡 = (ms) => new Promise((r) => setTimeout(r, ms))

export async function 等(条件, 超时 = 3000, 间隔 = 30) {
  const 开始 = Date.now()
  while (Date.now() - 开始 < 超时) {
    if (await 条件()) return true
    await 睡(间隔)
  }
  return false
}
