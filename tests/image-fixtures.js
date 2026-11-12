// 测试用图片：不依赖任何图形库，手工拼最小合法 GIF / PNG。
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
