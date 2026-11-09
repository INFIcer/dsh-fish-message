// 测试用图片：不依赖任何图形库，手工拼最小合法 GIF / PNG。
//
// GIF 结构：头 + LSD + N 个（GCE + 图像描述符 + LZW 子块）+ trailer。
// 解析器只读结构不解码像素，所以 LZW 用一小段占位数据即可。

/** 造一个 width×height、frames 帧、每帧 delay 厘秒的 GIF。 */
export function 造GIF({ width = 2, height = 2, frames = 2, delay = 10, 额外字节 = 0 } = {}) {
  const 段们 = []
  const 头 = Buffer.alloc(13)
  头.write('GIF89a', 0, 'latin1')
  头.writeUInt16LE(width, 6)
  头.writeUInt16LE(height, 8)
  头[10] = 0x00 // 无全局色表
  头[11] = 0
  头[12] = 0
  段们.push(头)

  for (let i = 0; i < Math.max(1, frames); i++) {
    const 控制 = Buffer.from([
      0x21, 0xf9, 0x04, 0x00,
      delay & 0xff, (delay >> 8) & 0xff,
      0x00, 0x00,
    ])
    const 描述 = Buffer.alloc(10)
    描述[0] = 0x2c
    描述.writeUInt16LE(0, 1)
    描述.writeUInt16LE(0, 3)
    描述.writeUInt16LE(width, 5)
    描述.writeUInt16LE(height, 7)
    描述[9] = 0x00
    // LZW 最小码长 2；子块长度 2、数据 2 字节；结束块 0。
    const 数据 = Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00])
    段们.push(控制, 描述, 数据)
  }
  段们.push(Buffer.from([0x3b]))
  const 图 = Buffer.concat(段们)
  return 额外字节 > 0 ? Buffer.concat([图, Buffer.alloc(额外字节)]) : 图
}

/** 1×1 透明 PNG。 */
export const 小PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

/** 造一张「看起来是 PNG、体积可控」的图（尾部补零，解析器仍认）。 */
export function 造大PNG(字节数 = 1024 * 1024) {
  const 补 = Math.max(0, Math.ceil(字节数) - 小PNG.length)
  return Buffer.concat([小PNG, Buffer.alloc(补)])
}
