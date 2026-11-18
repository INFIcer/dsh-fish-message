import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHANNEL_VERSION,
  aesKeyForImage,
  aesKeyForMedia,
  baseInfo,
  businessHeaders,
  cipherSize,
  decodeAesKey,
  decryptEcb,
  encodeAesKeyForSend,
  encryptEcb,
  loginHeaders,
  messageIdOf,
  wechatUin,
} from '../lib/ilink/protocol.js'

// 协议示例里同一个 key 的两种编码：raw 16 字节的 key 是 00112233…eeff。
const KEY_HEX = '00112233445566778899aabbccddeeff'
const KEY = Buffer.from(KEY_HEX, 'hex')
const KEY_BASE64_RAW = 'ABEiM0RVZneImaq7zN3u/w==' // base64(raw 16 bytes)
const KEY_BASE64_HEX = 'MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=' // base64(hex 字符串)

test('aes_key：base64(raw 16 字节) 与 base64(hex 字符串) 解出同一个 key', () => {
  assert.deepEqual(decodeAesKey(KEY_BASE64_RAW), KEY)
  assert.deepEqual(decodeAesKey(KEY_BASE64_HEX), KEY)
  // 图片的 image_item.aeskey 直接就是 32 位 hex。
  assert.deepEqual(decodeAesKey(KEY_HEX), KEY)
  assert.equal(decodeAesKey(''), null)
  assert.equal(decodeAesKey('不是 base64'), null)
  assert.equal(decodeAesKey('YWJj'), null)
})

test('图片 key：image_item.aeskey 优先于 media.aes_key', () => {
  const other = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex')
  assert.deepEqual(
    aesKeyForImage({ aeskey: 'ffeeddccbbaa99887766554433221100', media: { aes_key: KEY_BASE64_RAW } }),
    other,
  )
  // 没有 image_item.aeskey 时退回 media.aes_key（两种编码都认）。
  assert.deepEqual(aesKeyForImage({ media: { aes_key: KEY_BASE64_HEX } }), KEY)
  assert.deepEqual(aesKeyForMedia({ aes_key: KEY_BASE64_RAW }), KEY)
  assert.equal(aesKeyForImage({}), null)
})

test('出站 aes_key 写成 base64(hex 字符串)，下载方两种解码都认', () => {
  const encoded = encodeAesKeyForSend(KEY)
  assert.equal(encoded, KEY_BASE64_HEX)
  assert.deepEqual(decodeAesKey(encoded), KEY)
})

test('AES-128-ECB：加解密往返，密文长度与 cipherSize 公式一致', () => {
  for (const size of [0, 1, 15, 16, 17, 1024]) {
    const plain = Buffer.alloc(size, 7)
    const cipher = encryptEcb(plain, KEY)
    assert.equal(cipher.length, cipherSize(size), `明文 ${size} 字节的密文长度`)
    // PKCS7 永远补，所以明文整除 16 时也要多一整块。
    assert.equal(cipher.length % 16, 0)
    assert.deepEqual(decryptEcb(cipher, KEY), plain)
  }
  assert.equal(cipherSize(248731), 248736)
})

test('消息 id 优先级链：message_id → client_id → seq', () => {
  assert.equal(messageIdOf({ message_id: 9812451782375, client_id: 'wx-msg-1', seq: 429 }), '9812451782375')
  assert.equal(messageIdOf({ client_id: 'wx-msg-1', seq: 429 }), 'wx-msg-1')
  // 只有 seq 时加前缀，避免和数字 message_id 撞成同一个键。
  assert.equal(messageIdOf({ seq: 429 }), 'seq:429')
  assert.equal(messageIdOf({ message_id: '', client_id: '', seq: 0 }), 'seq:0')
  assert.equal(messageIdOf({}), '')
  // 同一个 id 反复取必须稳定：at-least-once 重复帧靠它落到同一个键。
  const message = { message_id: 42 }
  assert.equal(messageIdOf(message), messageIdOf({ ...message }))
})

test('请求头：业务头带 bot_token 与每请求重算的 X-WECHAT-UIN，登录头带客户端版本', () => {
  const headers = businessHeaders('ilinkbot_abc')
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers.authorizationtype, 'ilink_bot_token')
  assert.equal(headers.authorization, 'Bearer ilinkbot_abc')
  // UIN 是「随机 uint32 的十进制字符串」再做 base64。
  const decoded = Buffer.from(headers['x-wechat-uin'], 'base64').toString('utf8')
  assert.match(decoded, /^\d+$/)
  assert.ok(Number(decoded) >= 0 && Number(decoded) <= 0xffffffff)

  // 每次请求重新生成：连取三次不该全一样（取一次相同是极小概率事件）。
  const uins = new Set([wechatUin(), wechatUin(), wechatUin()])
  assert.ok(uins.size > 1, 'X-WECHAT-UIN 应当每请求重算')

  assert.deepEqual(loginHeaders(), { 'iLink-App-ClientVersion': '1' })
  assert.deepEqual(baseInfo(), { channel_version: CHANNEL_VERSION })
})
