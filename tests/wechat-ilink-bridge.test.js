import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WechatIlinkTransport } from '../lib/transport/wechat-ilink.js'
import { Bridge } from '../lib/bridge.js'
import { StateStore } from '../lib/storage.js'
import { Logger } from '../lib/logger.js'
import { normalizeConfig } from '../lib/config.js'
import { watermarkKey } from '../lib/peer.js'
import { MockIlinkServer, textMessage, wait } from './mock-ilink.js'

const PEER = 'o9cq800kum_4g8Py8Qw5G0a@im.wechat'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'fish-ilink-bridge-'))
}

function makeTransport({ dir, server }) {
  const logger = new Logger({ filePath: join(dir, 'ilink.log'), level: 'debug' })
  const transport = new WechatIlinkTransport({
    getConfig: () => ({ maxImageMB: 10, requestTimeoutMs: 2000 }),
    logger,
    homeDir: dir,
    baseUrl: server.baseUrl,
    cdnBaseUrl: server.cdnBaseUrl,
    timings: { pollTimeoutMs: 100, loginPollIntervalMs: 10, errorRetryMs: 10 },
  })
  return { transport, logger }
}

/**
 * 端到端：真的 Bridge + 真的 transport + 假 iLink 服务端。
 *
 * 这条用例的作用只有一个：证明「入站规整成 OneBot 11 事件 + getStatus 报在线」
 * 之后 Bridge 主体一行都不用改，收、发两条链路都能跑。
 */
test('Bridge 主体不改：用这个 transport 收一条、回一条', async () => {
  const server = await new MockIlinkServer().start()
  server.qrStatuses = ['confirmed']
  let bridge = null
  try {
    const dir = tempDir()
    const { transport, logger } = makeTransport({ dir, server })
    const store = new StateStore({ homeDir: dir })
    const config = normalizeConfig({
      bindings: [{ channel: 'wechat', qq: PEER, session: 'session-ilink-1', name: '主人', enabled: true }],
      reorderBufferMs: 20,
      inboundEditWindowMs: 0,
      outboxPerMessageDelayMs: 0,
      outboxPerCharDelayMs: 0,
      pollIntervalMs: 200,
      historyIntervalMs: 60000,
      requestTimeoutMs: 2000,
    })
    // 水位键按通道分桶：微信的键带 wechat: 前缀，不和老 QQ 号共用一格。
    store.setWatermark(watermarkKey('wechat', PEER), { timestamp: 1, messageId: '' })
    const delivered = []
    const delivery = {
      async deliver(request) { delivered.push(request); return { ok: true } },
      async attachmentPath() { return '' },
    }
    const voice = {
      async fetchImage() { throw new Error('测试里不放图片') },
      async recordToFile() { throw new Error('测试里没有语音') },
    }
    bridge = new Bridge({
      getConfig: () => config,
      transport,
      store,
      logger,
      voice,
      delivery,
      autoTimers: false,
    })
    await bridge.start({ syncNow: false })

    // 长轮询一起来 Bridge 就该把这条通道当「在线」（它据此停掉 HTTP 补拉）。
    assert.ok(await wait(() => bridge.state().transport?.connected === true), 'Bridge 应当认为通道在线')
    server.pushFrame({ msgs: [textMessage('今晚吃鱼', { messageId: 9101, token: 'CT_bridge' })], cursor: 'c1' })
    assert.ok(await wait(() => delivered.length === 1), '消息应当被投进会话')
    assert.match(delivered[0].text, /今晚吃鱼/)
    assert.equal(delivered[0].sessionId, 'session-ilink-1')

    await bridge.sendText(PEER, '好的', { channel: 'wechat' })
    assert.equal(server.sent.length, 1)
    assert.equal(server.sent[0].msg.context_token, 'CT_bridge')
    assert.equal(server.sent[0].msg.to_user_id, PEER)
    assert.deepEqual(server.sent[0].msg.item_list, [{ type: 1, text_item: { text: '好的' } }])
  } finally {
    if (bridge) await bridge.stop()
    await server.stop()
  }
})
