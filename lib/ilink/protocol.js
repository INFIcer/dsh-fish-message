// iLink（微信 ClawBot）协议里与业务无关的纯函数：请求头、AES-128-ECB、
// aes_key 的两种编码解码、消息 id 的优先级链。
//
// 这一层不碰网络也不碰文件，所以协议里最容易踩错的几处都能单独断言：
//   - aes_key 有 base64(raw16) 与 base64(hex 字符串) 两种并存编码，图片还多一个
//     image_item.aeskey（32 位 hex）且优先级更高；
//   - X-WECHAT-UIN 每条请求重算（相同值会被当重放）；
//   - 密文长度要按 PKCS7 的整块补齐算，getuploadurl 的 filesize 与之一致。

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** 业务基座地址；登录返回里的 baseurl 优先于它。 */
export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
/** 媒体 CDN 基座地址（上传/下载都在它下面）。 */
export const ILINK_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
/** 业务 body 的 base_info.channel_version。 */
export const CHANNEL_VERSION = '1.0.0'
/** 扫码状态查询必须带的客户端版本头；缺了服务端不认。 */
export const CLIENT_VERSION = '1'

const HEX32 = /^[0-9a-fA-F]{32}$/

/** 随机 uint32 的十进制字符串再 base64：协议规定的每请求防重放标记。 */
export function wechatUin(value = randomBytes(4).readUInt32BE(0)) {
  return Buffer.from(String(Number(value) >>> 0), 'utf8').toString('base64')
}

/** 扫码登录的两个 GET 只要这一个头。 */
export function loginHeaders() {
  return { 'iLink-App-ClientVersion': CLIENT_VERSION }
}

/** 业务 POST 的固定头；Authorization 用扫码登录拿到的 bot_token。 */
export function businessHeaders(token) {
  return {
    'content-type': 'application/json',
    authorizationtype: 'ilink_bot_token',
    authorization: `Bearer ${token}`,
    // 每次请求重算：同一个 UIN 重复出现会被服务端当重放。
    'x-wechat-uin': wechatUin(),
  }
}

/** 所有业务 body 都要带的版本块，协议里没有「可省略」的余地。 */
export function baseInfo() {
  return { channel_version: CHANNEL_VERSION }
}

/**
 * 解出 16 字节 AES key。
 *
 * 兼容三种形态（协议里并存，是这块最容易踩的坑）：
 *   1. 32 位 hex 字符串本身（图片 image_item.aeskey 常见）；
 *   2. base64(raw 16 bytes)，例如 ABEiM0RVZneImaq7zN3u/w==；
 *   3. base64(hex 字符串)，例如 MDAxMTIy... —— 官方发媒体时用这种。
 * 解不出来返回 null，由调用方决定「按明文处理」还是直接失败。
 */
export function decodeAesKey(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  if (HEX32.test(text)) return Buffer.from(text, 'hex')
  const raw = Buffer.from(text, 'base64')
  if (raw.length === 16) return raw
  if (raw.length === 32) {
    const asHex = raw.toString('latin1')
    if (HEX32.test(asHex)) return Buffer.from(asHex, 'hex')
  }
  return null
}

/** 图片的 key：image_item.aeskey（32 位 hex）优先于 media.aes_key。 */
export function aesKeyForImage(imageItem) {
  return decodeAesKey(imageItem?.aeskey) || decodeAesKey(imageItem?.media?.aes_key)
}

/** 语音/文件/视频只有 media.aes_key。 */
export function aesKeyForMedia(media) {
  return decodeAesKey(media?.aes_key)
}

/** 出站统一写成 base64(hex 字符串)：官方实现对出站媒体就是这么写的。 */
export function encodeAesKeyForSend(key) {
  return Buffer.from(Buffer.from(key).toString('hex'), 'utf8').toString('base64')
}

/** AES-128-ECB + PKCS7；Node 默认就是 PKCS7 填充。 */
export function encryptEcb(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function decryptEcb(ciphertext, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** PKCS7 之后的密文长度：明文长度整除 16 时仍会多补一整块。 */
export function cipherSize(rawSize) {
  const size = Math.max(0, Math.floor(Number(rawSize) || 0))
  return Math.ceil((size + 1) / 16) * 16
}

/**
 * 一条 iLink 消息的稳定 id。
 *
 * 优先级链 message_id → client_id → seq：getupdates 是 at-least-once，
 * 同一条消息重复投递时必须落到同一个 id，否则 Bridge 的去重与水位全失效。
 * 只有 seq 时会加前缀，避免与数字 message_id 撞成同一个键。
 */
export function messageIdOf(message) {
  const id = message?.message_id
  if (id !== undefined && id !== null && String(id) !== '') return String(id)
  const clientId = String(message?.client_id ?? '').trim()
  if (clientId) return clientId
  const seq = message?.seq
  if (seq !== undefined && seq !== null && String(seq) !== '') return `seq:${seq}`
  return ''
}
