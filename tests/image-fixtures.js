// 测试用图片：不依赖任何图形库，手工拼最小合法 GIF / PNG / JPEG / WebP / BMP。
//
// GIF 结构：头 + LSD + N 个（GCE + 图像描述符 + LZW 子块）+ trailer。
// 解析器只读结构不解码像素，所以 LZW 用一小段占位数据即可。

/** 造一个 width×height、frames 帧、每帧 delay 厘秒的 GIF。 */
export function makeGif({ width = 2, height = 2, frames = 2, delay = 10, extraBytes = 0 } = {}) {
  const segments = []
  const header = Buffer.alloc(13)
  header.write('GIF89a', 0, 'latin1')
  header.writeUInt16LE(width, 6)
  header.writeUInt16LE(height, 8)
  header[10] = 0x00 // 无全局色表
  header[11] = 0
  header[12] = 0
  segments.push(header)

  for (let i = 0; i < Math.max(1, frames); i++) {
    const control = Buffer.from([
      0x21, 0xf9, 0x04, 0x00,
      delay & 0xff, (delay >> 8) & 0xff,
      0x00, 0x00,
    ])
    const description = Buffer.alloc(10)
    description[0] = 0x2c
    description.writeUInt16LE(0, 1)
    description.writeUInt16LE(0, 3)
    description.writeUInt16LE(width, 5)
    description.writeUInt16LE(height, 7)
    description[9] = 0x00
    // LZW 最小码长 2；子块长度 2、数据 2 字节；结束块 0。
    const data = Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00])
    segments.push(control, description, data)
  }
  segments.push(Buffer.from([0x3b]))
  const image = Buffer.concat(segments)
  return extraBytes > 0 ? Buffer.concat([image, Buffer.alloc(extraBytes)]) : image
}

/** 1×1 透明 PNG。 */
export const smallPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

/** 造一张「看起来是 PNG、体积可控」的图（尾部补零，解析器仍认）。 */
export function makeLargePng(byteCount = 1024 * 1024) {
  const supplement = Math.max(0, Math.ceil(byteCount) - smallPng.length)
  return Buffer.concat([smallPng, Buffer.alloc(supplement)])
}

/** 造一张 width×height 的最小 JPEG：APP0 段 + 一个 SOF0 段 + EOI，只够读头。 */
export function makeJpeg({ width = 8, height = 6 } = {}) {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ])
  const sof = Buffer.alloc(19)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3
  const components = [1, 0x22, 0x00, 2, 0x11, 0x01, 3, 0x11, 0x01]
  for (let i = 0; i < components.length; i += 1) sof[10 + i] = components[i]
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

/**
 * 造一个只有单个头的 WebP 容器（variant = VP8 / VP8L / VP8X）。
 * 只够解析器读 canvas 尺寸，不含真正的图像数据。
 */
export function makeWebp({ width = 10, height = 8, variant = 'VP8X' } = {}) {
  const u32le = (value) => {
    const buf = Buffer.alloc(4)
    buf.writeUInt32LE(value >>> 0, 0)
    return buf
  }
  let payload
  let fourcc = variant
  if (variant === 'VP8') {
    fourcc = 'VP8 '
    payload = Buffer.alloc(10)
    payload[3] = 0x9d
    payload[4] = 0x01
    payload[5] = 0x2a
    payload.writeUInt16LE(width & 0x3fff, 6)
    payload.writeUInt16LE(height & 0x3fff, 8)
  } else if (variant === 'VP8L') {
    payload = Buffer.alloc(5)
    payload[0] = 0x2f
    payload.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1)
  } else {
    fourcc = 'VP8X'
    payload = Buffer.alloc(10)
    payload.writeUIntLE(width - 1, 4, 3)
    payload.writeUIntLE(height - 1, 7, 3)
  }
  const chunk = Buffer.concat([Buffer.from(fourcc, 'latin1'), u32le(payload.length), payload])
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunk])
  const header = Buffer.alloc(8)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body])
}

/** 造一张最小 BMP（BITMAPINFOHEADER，24 位）；topDown=true 时高度为负。 */
export function makeBmp({ width = 4, height = 3, topDown = false } = {}) {
  const buf = Buffer.alloc(54)
  buf.write('BM', 0, 'latin1')
  buf.writeUInt32LE(54, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(topDown ? -height : height, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  return buf
}
