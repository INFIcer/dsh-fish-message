import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WechatIlinkTransport } from '../lib/transport/wechat-ilink.js'
import { Logger } from '../lib/logger.js'
import { cipherSize, decodeAesKey, decryptEcb } from '../lib/ilink/protocol.js'
import { MockIlinkServer, sleep, textMessage, wait } from './mock-ilink.js'

const PEER = 'o9cq800kum_4g8Py8Qw5G0a@im.wechat'
const BOT = 'e06c1ceea05e@im.bot'
const SESSION_FILE = 'fish-message-ilink.json'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'fish-ilink-'))
}

function makeTransport({ dir = tempDir(), server, timings = {}, config = {} } = {}) {
  const logger = new Logger({ filePath: join(dir, 'ilink.log'), level: 'debug' })
  const transport = new WechatIlinkTransport({
    getConfig: () => ({ maxImageMB: 10, requestTimeoutMs: 2000, ...config }),
    logger,
    homeDir: dir,
    baseUrl: server?.baseUrl || '',
    cdnBaseUrl: server?.cdnBaseUrl || '',
    timings: { pollTimeoutMs: 100, loginPollIntervalMs: 10, errorRetryMs: 10, ...timings },
  })
  return { transport, dir, logger }
}

/** 预置一份「已经扫码登录过」的会话，跳过登录直接测长轮询与发送。 */
function seedSession(dir, server, { token = 'ilinkbot_test_token', cursor = '', peers = {} } = {}) {
  writeFileSync(join(dir, SESSION_FILE), JSON.stringify({
    version: 1,
    botToken: token,
    botId: BOT,
    userId: PEER,
    baseUrl: server.baseUrl,
    cursor,
    peers,
  }))
}

function collectEvents(transport) {
  const events = []
  transport.onEvent((event) => events.push(event))
  return events
}

const textSegment = (text) => [{ type: 'text', data: { text } }]

test('扫码登录：state 走 wait → scaned → confirmed，二维码内容原样给出', async () => {
  const server = await new MockIlinkServer().start()
  const { transport } = makeTransport({ server })
  const states = []
  await transport.start({ onStatus: (status) => states.push(status.state) })
  try {
    assert.ok(await wait(() => transport.getStatus().state === 'confirmed'), '应当进入 confirmed')
    assert.ok(states.includes('waiting_scan'), `状态序列：${states.join('→')}`)
    assert.ok(states.includes('scaned'), `状态序列：${states.join('→')}`)

    const qr = transport.getQrcode()
    assert.equal(qr.qrcode, 'qrc_test_1')
    // qrcode_img_content 原样交给上层，本层不渲染。
    assert.equal(qr.imgContent, server.qrImg)

    const qrReq = server.lastRequest('/ilink/bot/get_bot_qrcode')
    assert.equal(qrReq.query.bot_type, '3')
    // 扫码状态查询必须带客户端版本头，缺了服务端不认。
    assert.equal(server.lastRequest('/ilink/bot/get_qrcode_status').headers['ilink-app-clientversion'], '1')

    const status = transport.getStatus()
    assert.equal(status.name, 'wechat-ilink')
    assert.equal(status.connected, true)
    assert.equal(status.mode, 'ilink')
    assert.equal(status.botId, BOT)
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('扫码状态接口被服务端 hold：本地超时不能算登录失败', async () => {
  const server = await new MockIlinkServer().start()
  server.qrStatuses = ['wait', 'wait', 'confirmed']
  // 服务端 hold 比客户端请求超时长：真实服务端就是「一直挂到状态变化」。
  server.qrHoldMs = 200
  const { transport } = makeTransport({ server, config: { requestTimeoutMs: 60 } })
  const states = []
  await transport.start({ onStatus: (status) => states.push(status.state) })
  try {
    assert.ok(await wait(() => transport.getStatus().state === 'confirmed', 5000), `state=${transport.getStatus().state}`)
    // 超时只是「还没变」：不能进 error，否则设置页在二维码还有效时显示登录失败。
    assert.ok(!states.includes('error'), `超时不该进 error：${states.join('→')}`)
    assert.equal(transport.getStatus().lastError, '')
    assert.equal(transport.getQrcode().error, '')
    assert.ok(server.requestsTo('/ilink/bot/get_qrcode_status').length >= 3, '超时之后要立刻续轮')
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('扫码状态接口偶发业务错误：链路恢复后回到等待扫码，不卡在登录失败', async () => {
  const server = await new MockIlinkServer().start()
  server.qrStatuses = ['wait', 'confirmed']
  server.qrErrors = [-3]
  const { transport } = makeTransport({ server })
  const states = []
  await transport.start({ onStatus: (status) => states.push(status.state) })
  try {
    assert.ok(await wait(() => transport.getStatus().state === 'confirmed', 5000), `state=${transport.getStatus().state}`)
    assert.ok(states.includes('error'), `应当先失败过一次：${states.join('→')}`)
    assert.ok(states.indexOf('error') < states.lastIndexOf('waiting_scan'), `恢复后要回到 waiting_scan：${states.join('→')}`)
    assert.equal(transport.getStatus().lastError, '')
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('业务请求头：bot_token、AuthorizationType、base_info 与每请求重算的 X-WECHAT-UIN', async () => {
  const server = await new MockIlinkServer().start()
  server.qrStatuses = ['confirmed']
  const { transport } = makeTransport({ server })
  await transport.start()
  try {
    assert.ok(await wait(() => server.requestsTo('/ilink/bot/getupdates').length >= 3))
    const requests = server.requestsTo('/ilink/bot/getupdates').slice(0, 3)
    for (const request of requests) {
      assert.equal(request.headers.authorization, `Bearer ${server.botToken}`)
      assert.equal(request.headers.authorizationtype, 'ilink_bot_token')
      assert.equal(request.headers['content-type'], 'application/json')
      assert.equal(request.body.base_info.channel_version, '1.0.0')
      const uin = Buffer.from(request.headers['x-wechat-uin'], 'base64').toString('utf8')
      assert.match(uin, /^\d+$/)
    }
    // 同一个 UIN 连发会被当重放，所以必须每请求重算。
    const uins = new Set(requests.map((x) => x.headers['x-wechat-uin']))
    assert.ok(uins.size > 1, 'X-WECHAT-UIN 应当每请求重算')
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('长轮询：本地超时当 wait 立刻续轮，续轮之后照样收得到消息', async () => {
  const server = await new MockIlinkServer().start()
  server.qrStatuses = ['confirmed']
  // 服务端 hold 比客户端超时长：客户端会先 abort，等价于「这一轮没有新消息」。
  server.holdMs = 260
  const { transport } = makeTransport({ server, timings: { pollTimeoutMs: 120 } })
  const events = collectEvents(transport)
  await transport.start()
  try {
    assert.ok(await wait(() => transport.getStatus().state === 'confirmed'))
    assert.ok(await wait(() => server.updateCount >= 3, 5000), `续轮次数：${server.updateCount}`)
    assert.equal(events.length, 0)
    // 超时不是错误：不能把状态打成断线，否则 Bridge 会去做无意义的历史补拉。
    assert.equal(transport.getStatus().lastError, '')

    server.pushFrame({ msgs: [textMessage('超时之后还能收', { messageId: 9001 })], cursor: 'cursor-1' })
    assert.ok(await wait(() => events.length === 1, 5000), '超时续轮之后仍能收到消息')
    assert.equal(events[0].raw_message, '超时之后还能收')
    assert.ok(transport.getStatus().lastOkAt > 0)
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('重复帧去重：同一条消息重复投递只产生一个事件', async () => {
  const server = await new MockIlinkServer().start()
  server.qrStatuses = ['confirmed']
  const { transport } = makeTransport({ server })
  const events = collectEvents(transport)
  const message = textMessage('重复帧', { messageId: 1234, seq: 7 })
  server.pushFrame({ msgs: [message], cursor: 'c1' })
  server.pushFrame({ msgs: [{ ...message }, { ...message }], cursor: 'c2' })
  await transport.start()
  try {
    assert.ok(await wait(() => events.length >= 1))
    await sleep(150)
    assert.equal(events.length, 1)
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('ret=-14：清凭证与游标、重新扫码', async () => {
  const server = await new MockIlinkServer().start()
  // 重登后停在 wait，好断言「确实重新申请了二维码」。
  server.qrStatuses = ['wait']
  const dir = tempDir()
  seedSession(dir, server, { cursor: 'cursor-9', peers: { [PEER]: { contextToken: 'CT_OLD', lastActiveAt: 1 } } })
  server.pushFrame({ ret: -14, errmsg: 'session timeout' })
  const { transport } = makeTransport({ dir, server })
  await transport.start()
  try {
    assert.ok(await wait(() => transport.getStatus().state === 'waiting_scan', 5000), `state=${transport.getStatus().state}`)
    assert.equal(transport.getStatus().connected, false)
    const saved = JSON.parse(readFileSync(join(dir, SESSION_FILE), 'utf8'))
    assert.equal(saved.botToken, '')
    assert.equal(saved.cursor, '')
    assert.deepEqual(saved.peers, {})
    assert.ok(server.requestsTo('/ilink/bot/get_bot_qrcode').length >= 1)
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('sendmessage 的 ret=-2 原样抛出：窗口关闭 / 单条超长 / 限额不可区分', async () => {
  const server = await new MockIlinkServer().start()
  const dir = tempDir()
  seedSession(dir, server, { peers: { [PEER]: { contextToken: 'CT_1', lastActiveAt: Date.now() } } })
  server.sendResponses.push({ ret: -2, errcode: -2, errmsg: 'prepare failed' })
  const { transport } = makeTransport({ dir, server })
  await transport.start()
  try {
    await assert.rejects(transport.sendMessage(PEER, textSegment('在吗')), (error) => {
      assert.equal(error.ret, -2)
      assert.match(error.message, /窗口已关闭/)
      assert.match(error.message, /单条超长/)
      assert.match(error.message, /限额/)
      return true
    })
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('context_token 沿传入站消息，落盘后换个实例（= 重启）仍然能回复', async () => {
  const server = await new MockIlinkServer().start()
  server.qrStatuses = ['confirmed']
  const dir = tempDir()
  const { transport } = makeTransport({ dir, server })
  const events = collectEvents(transport)
  await transport.start()
  try {
    server.pushFrame({ msgs: [textMessage('你好', { messageId: 5001, token: 'CT_abc' })], cursor: 'c1' })
    assert.ok(await wait(() => events.length === 1))
    await transport.sendMessage(PEER, textSegment('收到'))

    const sent = server.sent.at(-1).msg
    assert.equal(sent.context_token, 'CT_abc')
    assert.equal(sent.to_user_id, PEER)
    assert.equal(sent.message_type, 2)
    assert.equal(sent.message_state, 2)
    assert.deepEqual(sent.item_list, [{ type: 1, text_item: { text: '收到' } }])
  } finally {
    await transport.stop()
  }

  // 新实例共享同一个家目录：锚点从盘上恢复，不需要再收一条消息才能发。
  const restarted = makeTransport({ dir, server })
  await restarted.transport.start()
  try {
    await restarted.transport.sendMessage(PEER, textSegment('重启之后'))
    const first = server.sent.at(-2).msg
    const second = server.sent.at(-1).msg
    assert.equal(second.context_token, 'CT_abc')
    // 每一条都必须换新 client_id，否则服务端会按幂等吞掉。
    assert.notEqual(second.client_id, first.client_id)
    assert.deepEqual(restarted.transport.listRecentPeers().map((x) => x.peer), [PEER])
  } finally {
    await restarted.transport.stop()
    await server.stop()
  }
})

test('事件规整：OneBot 11 私聊形状，message_id 走 message_id → client_id → seq', async () => {
  const server = await new MockIlinkServer().start()
  server.qrStatuses = ['confirmed']
  const { transport } = makeTransport({ server })
  const events = collectEvents(transport)
  const createdMs = 1774158905123
  await transport.start()
  try {
    server.pushFrame({
      msgs: [
        textMessage('A', { messageId: 7001, seq: 1, createTimeMs: createdMs }),
        textMessage('B', { messageId: null, clientId: 'wx-msg-abc', seq: 2, createTimeMs: createdMs }),
        textMessage('C', { messageId: null, clientId: '', seq: 3, createTimeMs: createdMs }),
      ],
      cursor: 'c1',
    })
    assert.ok(await wait(() => events.length === 3))
    const [a, b, c] = events
    assert.equal(a.post_type, 'message')
    assert.equal(a.message_type, 'private')
    assert.equal(a.channel, 'wechat')
    assert.equal(a.user_id, PEER)
    assert.equal(a.message_id, '7001')
    assert.equal(a.message_seq, 1)
    assert.equal(a.time, Math.floor(createdMs / 1000))
    assert.deepEqual(a.message, [{ type: 'text', data: { text: 'A' } }])
    assert.equal(a.raw_message, 'A')
    assert.equal(b.message_id, 'wx-msg-abc')
    // 只有 seq 时加前缀，避免与数字 message_id 撞键。
    assert.equal(c.message_id, 'seq:3')
    // 不能填 self_id：Bridge 的 sameNumber 会把带 @ 的 iLink id 全抹成空串，
    // 填了就会被判成「自己发给自己」整条丢掉。
    assert.equal(a.self_id, undefined)
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('跳过机器人自己的回流与带 group_id 的群消息', async () => {
  const server = await new MockIlinkServer().start()
  server.qrStatuses = ['confirmed']
  const { transport } = makeTransport({ server })
  const events = collectEvents(transport)
  await transport.start()
  try {
    server.pushFrame({
      msgs: [
        textMessage('机器人回显', { messageType: 2, messageId: 1 }),
        textMessage('群里的话', { groupId: 'g1@chatroom', messageId: 2 }),
        textMessage('主人的私聊', { messageId: 3 }),
      ],
      cursor: 'c1',
    })
    assert.ok(await wait(() => events.length === 1))
    await sleep(80)
    assert.equal(events.length, 1)
    assert.equal(events[0].raw_message, '主人的私聊')
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('入站图片：CDN 密文解密后落盘，aes_key 两种编码与 image_item.aeskey 都认', async () => {
  const server = await new MockIlinkServer().start()
  server.qrStatuses = ['confirmed']
  const dir = tempDir()
  const { transport } = makeTransport({ dir, server })
  const events = collectEvents(transport)

  const pngA = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('AAA')])
  const jpgB = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('BBB')])
  const pngC = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('CCC')])
  const keyA = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const keyB = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex')
  const keyC = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex')
  const wrongKey = Buffer.from('aaaabbbbccccddddeeeeffff00001111', 'hex')

  const imageMessage = (messageId, imageItem) => ({
    ...textMessage('', { messageId }),
    item_list: [{ type: 2, image_item: imageItem }],
  })

  server.pushFrame({
    msgs: [
      // 格式 A：base64(raw 16 字节)
      imageMessage(6001, {
        media: {
          encrypt_query_param: server.addFrame(pngA, keyA, 'A'),
          aes_key: 'ABEiM0RVZneImaq7zN3u/w==',
          encrypt_type: 1,
        },
      }),
      // 格式 B：base64(hex 字符串)
      imageMessage(6002, {
        media: {
          encrypt_query_param: server.addFrame(jpgB, keyB, 'B'),
          aes_key: 'ZmZlZWRkY2NiYmFhOTk4ODc3NjY1NTQ0MzMyMjExMDA=',
          encrypt_type: 1,
        },
      }),
      // image_item.aeskey（32 位 hex）优先，media.aes_key 是错的也不能用
      imageMessage(6003, {
        media: {
          encrypt_query_param: server.addFrame(pngC, keyC, 'C'),
          aes_key: 'ZmZmZmVlZWVkZGRkY2NjY2JiYmJiYWFhYWE5OTk5OTk4ODg4ODc3Nzc3NjY2NjY1NTU1NTU0NDQ0NDMzMzMzMjIyMjIyMTExMTExMDAwMDAw',
          encrypt_type: 1,
        },
        aeskey: keyC.toString('hex'),
      }),
    ],
    cursor: 'c1',
  })

  await transport.start()
  try {
    assert.ok(await wait(() => events.length === 3))
    const expected = [pngA, jpgB, pngC]
    for (let i = 0; i < 3; i++) {
      const segment = events[i].message.find((x) => x.type === 'image')
      assert.ok(segment, `第 ${i + 1} 条应有 image 段`)
      assert.ok(existsSync(segment.data.path), '图片应当已落盘')
      assert.deepEqual(readFileSync(segment.data.path), expected[i])
      // 落盘名沿用收件箱已有规则，清理与「最近图片」才认。
      assert.match(segment.data.path, /qq-image-[0-9a-f]{16}\.(png|jpg)$/)
    }
    assert.equal(events[0].raw_message, '[图片]')
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('入站语音用 voice_item.text；没有转写给占位；文件与视频给一行说明', async () => {
  const server = await new MockIlinkServer().start()
  server.qrStatuses = ['confirmed']
  const { transport } = makeTransport({ server })
  const events = collectEvents(transport)
  await transport.start()
  try {
    server.pushFrame({
      msgs: [
        { ...textMessage('', { messageId: 8001 }), item_list: [{ type: 3, voice_item: { encode_type: 6, sample_rate: 24000, playtime: 4210, text: '我下午三点到。' } }] },
        { ...textMessage('', { messageId: 8002 }), item_list: [{ type: 3, voice_item: { encode_type: 6, playtime: 8000 } }] },
        { ...textMessage('', { messageId: 8003 }), item_list: [{ type: 4, file_item: { file_name: '报价单-2026Q1.pdf', len: '542188' } }] },
        { ...textMessage('', { messageId: 8004 }), item_list: [{ type: 5, video_item: { play_length: 3000 } }] },
      ],
      cursor: 'c1',
    })
    assert.ok(await wait(() => events.length === 4))

    // 有转写：直接当文本用
    assert.deepEqual(events[0].message, [{ type: 'text', data: { text: '（语音：我下午三点到。）' } }])
    assert.equal(events[0].raw_message, '（语音：我下午三点到。）')
    // 没转写：占位里说明为什么没有声音可用
    assert.match(events[1].raw_message, /不解码 SILK/)
    assert.match(events[1].raw_message, /8 秒/)
    // 文件只带名字与大小，Bridge 会渲染成一行文字
    assert.equal(events[2].message[0].type, 'file')
    assert.equal(events[2].message[0].data.name, '报价单-2026Q1.pdf')
    assert.match(events[2].raw_message, /\[文件：报价单-2026Q1\.pdf\]/)
    assert.equal(events[3].message[0].type, 'video')
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('出站图片：getuploadurl 参数正确、CDN 收到可解的密文、sendmessage 带回 aes_key', async () => {
  const server = await new MockIlinkServer().start()
  const dir = tempDir()
  seedSession(dir, server, { peers: { [PEER]: { contextToken: 'CT_IMG', lastActiveAt: Date.now() } } })
  const { transport } = makeTransport({ dir, server })
  await transport.start()
  try {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('image-bytes')])
    // Bridge 把本机图片转成 base64:// 段；直链与本机路径也支持（见 readMediaBuffer）。
    await transport.sendMessage(PEER, [{ type: 'image', data: { file: `base64://${png.toString('base64')}` } }])

    const uploadRequest = server.lastRequest('/ilink/bot/getuploadurl').body
    assert.equal(uploadRequest.media_type, 1)
    assert.equal(uploadRequest.to_user_id, PEER)
    assert.equal(uploadRequest.rawsize, png.length)
    assert.equal(uploadRequest.rawfilemd5, createHash('md5').update(png).digest('hex'))
    // 密文长度要按 PKCS7 补齐算，CDN 会核对。
    assert.equal(uploadRequest.filesize, cipherSize(png.length))
    assert.match(uploadRequest.aeskey, /^[0-9a-f]{32}$/)
    assert.equal(uploadRequest.no_need_thumb, true)

    assert.equal(server.uploads.length, 1)
    const item = server.sent.at(-1).msg.item_list[0]
    assert.equal(item.type, 2)
    assert.equal(item.image_item.media.encrypt_type, 1)
    assert.equal(item.image_item.mid_size, cipherSize(png.length))
    assert.equal(item.image_item.media.encrypt_query_param, `ENC_${server.uploads[0].filekey}`)
    // 出站 aes_key 是 base64(hex 字符串)，与实际加密的 key 一致。
    const key = decodeAesKey(item.image_item.media.aes_key)
    assert.equal(key.toString('hex'), uploadRequest.aeskey)
    assert.deepEqual(decryptEcb(server.uploads[0].cipher, key), png)
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('出站文件：media_type=3，带 file_name / 明文 len / md5，密文可解', async () => {
  const server = await new MockIlinkServer().start()
  const dir = tempDir()
  seedSession(dir, server, { peers: { [PEER]: { contextToken: 'CT_FILE', lastActiveAt: Date.now() } } })
  const { transport } = makeTransport({ dir, server })
  const filePath = join(dir, '报价单.txt')
  const content = Buffer.from('报价单内容', 'utf8')
  writeFileSync(filePath, content)
  await transport.start()
  try {
    await transport.sendMessage(PEER, [{ type: 'file', data: { file: filePath.replace(/\\/g, '/'), name: '报价单.txt' } }])
    const uploadRequest = server.lastRequest('/ilink/bot/getuploadurl').body
    assert.equal(uploadRequest.media_type, 3)
    const item = server.sent.at(-1).msg.item_list[0]
    assert.equal(item.type, 4)
    assert.equal(item.file_item.file_name, '报价单.txt')
    assert.equal(item.file_item.len, String(content.length))
    assert.equal(item.file_item.md5, createHash('md5').update(content).digest('hex'))
    const key = decodeAesKey(item.file_item.media.aes_key)
    assert.deepEqual(decryptEcb(server.uploads[0].cipher, key), content)
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('发不出去的三种情况都明确抛错：没锚点、语音段、未知段', async () => {
  const server = await new MockIlinkServer().start()
  const dir = tempDir()
  seedSession(dir, server, { peers: { [PEER]: { contextToken: 'CT_1', lastActiveAt: Date.now() } } })
  const { transport } = makeTransport({ dir, server })
  await transport.start()
  try {
    // iLink 没有「打开会话」的接口：没收到过对方消息就没有 context_token。
    await assert.rejects(transport.sendMessage('someone-else', textSegment('在吗')), /没有 context_token 锚点/)
    // v1 不做语音发送：要 SILK 编码，明确抛错让 Outbox 按失败记账。
    await assert.rejects(transport.sendMessage(PEER, [{ type: 'record', data: { file: 'x.wav' } }]), /不支持发送语音/)
    await assert.rejects(transport.sendMessage(PEER, [{ type: 'face', data: {} }]), /不支持的段类型/)
    await assert.rejects(transport.sendMessage(PEER, []), /消息段为空/)
    assert.equal(server.sent.length, 0)
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('撤回：同一条消息被重推一次带 delete_time_ms，只产生撤回通知、不再当新消息投递', async () => {
  const server = await new MockIlinkServer().start()
  server.qrStatuses = ['confirmed']
  const { transport } = makeTransport({ server })
  const events = collectEvents(transport)
  const message = textMessage('这句话要撤回', { messageId: 7788, seq: 11 })
  server.pushFrame({ msgs: [message], cursor: 'c1' })
  await transport.start()
  try {
    assert.ok(await wait(() => events.length === 1))
    assert.equal(events[0].post_type, 'message')
    // 服务端撤回的表现：同一条消息再推一次，多出 delete_time_ms。
    server.pushFrame({ msgs: [{ ...message, delete_time_ms: Date.now() }], cursor: 'c2' })
    assert.ok(await wait(() => events.length === 2, 5000), '应当收到撤回通知')
    const notice = events[1]
    assert.equal(notice.post_type, 'notice')
    assert.equal(notice.notice_type, 'friend_recall')
    assert.equal(notice.channel, 'wechat')
    assert.equal(notice.user_id, PEER)
    assert.equal(String(notice.message_id), '7788')
    assert.ok(notice.time > 0)
    await sleep(120)
    assert.equal(events.length, 2, '撤回帧不能再产生一条消息事件')
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('撤回：原消息还没到就先收到 delete 帧，也绝不投递占位内容', async () => {
  const server = await new MockIlinkServer().start()
  server.qrStatuses = ['confirmed']
  const { transport } = makeTransport({ server })
  const events = collectEvents(transport)
  const message = textMessage('从未投递就被撤回', { messageId: 7789, seq: 12 })
  // 撤回帧里 item_list 通常还在，但即使空了也不能因为「没有可识别内容」而占位投递。
  server.pushFrame({ msgs: [{ ...message, delete_time_ms: Date.now(), item_list: [] }], cursor: 'c1' })
  await transport.start()
  try {
    assert.ok(await wait(() => events.length >= 1, 5000))
    await sleep(120)
    assert.equal(events.length, 1)
    assert.equal(events[0].post_type, 'notice')
    assert.equal(events[0].notice_type, 'friend_recall')
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('fetchHistory 恒返回 []（iLink 没有历史接口）；listRecentPeers 按活跃时间倒序', async () => {
  const server = await new MockIlinkServer().start()
  server.qrStatuses = ['confirmed']
  const { transport } = makeTransport({ server })
  const events = collectEvents(transport)
  await transport.start()
  try {
    // 没有历史接口：恒空数组，Bridge 拿到就静默跳过，不会去做无意义的补拉。
    assert.deepEqual(await transport.fetchHistory(PEER, { count: 100 }), [])
    const older = 'aaa@im.wechat'
    server.pushFrame({ msgs: [textMessage('先来', { messageId: 11, peer: older, token: 'CT_OLD' })], cursor: 'c1' })
    assert.ok(await wait(() => events.length === 1))
    // 两帧之间留时间差：最近活跃时间是毫秒级，同毫秒内谁先谁后没有意义。
    await sleep(20)
    server.pushFrame({ msgs: [textMessage('后来', { messageId: 12, token: 'CT_NEW' })], cursor: 'c2' })
    assert.ok(await wait(() => events.length === 2))
    const peers = transport.listRecentPeers()
    assert.equal(peers.length, 2)
    assert.equal(peers[0].peer, PEER)
    assert.ok(peers[0].lastActiveAt > 0)
    assert.equal(peers[1].peer, older)
    assert.deepEqual(transport.listRecentPeers({ limit: 1 }).map((x) => x.peer), [PEER])
  } finally {
    await transport.stop()
    await server.stop()
  }
})

test('stop：状态转 stopped 且不再继续长轮询', async () => {
  const server = await new MockIlinkServer().start()
  server.qrStatuses = ['confirmed']
  const { transport } = makeTransport({ server })
  await transport.start()
  try {
    assert.ok(await wait(() => transport.getStatus().connected === true))
    const before = server.updateCount
    await transport.stop()
    const status = transport.getStatus()
    assert.equal(status.state, 'stopped')
    assert.equal(status.connected, false)
    await sleep(200)
    assert.ok(server.updateCount <= before + 1, `停止后不该继续轮询：${before} → ${server.updateCount}`)
  } finally {
    await server.stop()
  }
})
