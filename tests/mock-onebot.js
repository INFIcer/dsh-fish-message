// 测试用的最小 OneBot 11 服务器：HTTP + WebSocket。
// 只实现本插件用到的四个动作，足够验证收、发、补投和去重。

import http from 'node:http'
import { WebSocketServer } from 'ws'

function readPayload(req) {
  return new Promise((resolve) => {
    let str = ''
    req.on('data', (c) => { str += c })
    req.on('end', () => {
      try { resolve(JSON.parse(str || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function respond(res, data, code = 200) {
  const str = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(str)
}

export class MockOneBotServer {
  constructor() {
    this.history = new Map()
    this.sent = []
    this.requests = []
    this.clients = new Set()
    this.nextId = 9000
    this.failSend = false
    this.server = null
    this.wss = null
    this.port = 0
  }

  get baseUrl() { return `http://127.0.0.1:${this.port}` }
  get wsUrl() { return `ws://127.0.0.1:${this.port}` }

  async start() {
    this.server = http.createServer(async (req, res) => {
      const payload = await readPayload(req)
      const action = String(req.url || '').replace(/^\//, '').split('?')[0]
      this.requests.push({ action, body: payload })
      if (action === 'get_login_info') {
        return respond(res, { status: 'ok', retcode: 0, data: { user_id: 2983830957, nickname: '测试机器人' } })
      }
      if (action === 'get_friend_msg_history') {
        const qq = String(payload.user_id)
        const allItems = this.history.get(qq) || []
        const number = Math.max(1, Math.min(500, Number(payload.count) || 100))
        // 模拟 NapCat：带 message_id 时，返回该条往前数（含锚点）。
        if (payload.message_id !== undefined && payload.message_id !== null && payload.message_id !== '') {
          const anchor = allItems.findIndex((m) => String(m.message_id) === String(payload.message_id))
          if (anchor >= 0) {
            const start = Math.max(0, anchor - number + 1)
            return respond(res, { status: 'ok', retcode: 0, data: { messages: allItems.slice(start, anchor + 1) } })
          }
        }
        return respond(res, { status: 'ok', retcode: 0, data: { messages: allItems.slice(-number) } })
      }
      if (action === 'send_private_msg') {
        if (this.failSend) {
          return respond(res, { status: 'failed', retcode: 1200, wording: '模拟发送失败：机器人离线' }, 200)
        }
        this.sent.push(payload)
        return respond(res, { status: 'ok', retcode: 0, data: { message_id: this.nextId++ } })
      }
      if (action === 'get_record') {
        return respond(res, { status: 'ok', retcode: 0, data: { file: '' } })
      }
      return respond(res, { status: 'failed', retcode: 404, wording: `未知动作 ${action}` }, 404)
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
    const str = JSON.stringify(event)
    for (const ws of this.clients) {
      try { ws.send(str) } catch { /* 忽略 */ }
    }
    return this.clients.size
  }
}

export function message(id, text, time, qq = '10001') {
  return {
    message_id: Number(id),
    message_seq: Number(id),
    time: Number(time),
    user_id: Number(qq),
    message_type: 'private',
    message: [{ type: 'text', data: { text: text } }],
    raw_message: text,
    sender: { user_id: Number(qq), nickname: '主人' },
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function wait(condition, timeout = 3000, interval = 30) {
  const begin = Date.now()
  while (Date.now() - begin < timeout) {
    if (await condition()) return true
    await sleep(interval)
  }
  return false
}
