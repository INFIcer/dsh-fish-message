import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockOneBotServer, 等, 睡 } from './mock-onebot.js'

const QQ = '10001'
const 会话 = 'session-host-test'

function 假响应() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(文) { this.body = String(文 || '') },
  }
}

test('宿主入口：注册路由、状态可读、session/event 能发到 QQ', async () => {
  const server = await new MockOneBotServer().start()
  const dir = mkdtempSync(join(tmpdir(), 'fish-host-'))
  process.env.DSH_HOME = dir

  const routes = new Map()
  const 监听 = new Map()
  const agent = {
    session: { id: 会话 },
    async followup(msg) { this.收到 = msg },
  }
  const ctx = {
    effect(cb) {
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
    on(事件, fn) {
      监听.set(事件, fn)
      return () => 监听.delete(事件)
    },
    get(服务) {
      if (服务 === 'sessions') return { list: () => [{ id: 会话, title: '宿主测试' }], flush: async () => {} }
      if (服务 === 'sessionTitle') return { get: () => ({ title: '宿主测试' }) }
      if (服务 === 'workspaceRegistry') return { archivedSessionIds: [] }
      if (服务 === 'attachments') return { admitPromptContent: async (c) => c, imageHostPath: () => '' }
      return undefined
    },
    agents: { get: (id) => (id === 会话 || id === `session-${会话}` ? agent : undefined) },
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
  }

  const host = await import('../lib/host.js?host-test')
  const app = host.apply(ctx, {
    napcatBaseUrl: server.baseUrl,
    wsUrl: server.wsUrl,
    wsEnabled: false,
    bindings: [{ qq: QQ, session: 会话, name: '主人', enabled: true }],
    pollIntervalMs: 200,
    reorderBufferMs: 30,
    requestTimeoutMs: 3000,
  })
  await 等(() => app.bridge.running, 2000)

  const 状态响应 = 假响应()
  await routes.get('/dsh-fish-message/state')({}, 状态响应)
  const 状态 = JSON.parse(状态响应.body)
  assert.equal(状态.ok, true)
  assert.equal(状态.bindings.length, 1)
  assert.equal(状态.bindings[0].qq, QQ)
  assert.equal(状态.sessions[0].title, '宿主测试')

  const 健康响应 = 假响应()
  await routes.get('/dsh-fish-message/health')({}, 健康响应)
  assert.equal(健康响应.statusCode, 200)
  assert.equal(JSON.parse(健康响应.body).ok, true)

  const 发 = 监听.get('session/event')
  assert.equal(typeof 发, 'function')
  发({ id: 会话 }, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '块外 [QQ]宿主入口测试[/QQ] 块外' }] } },
  })
  发({ id: 会话 }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const 发出 = await 等(() => server.sent.length > 0, 2000)
  assert.equal(发出, true)
  assert.equal(server.sent[0].message[0].data.text, '宿主入口测试')

  await app.停()
  await 睡(20)
  await server.stop()
})
