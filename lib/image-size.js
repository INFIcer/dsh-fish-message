// 从图片字节头解析像素宽高：只读文件头，不解码像素，不依赖任何图形库。
//
// 支持 PNG / JPEG / GIF / WebP（VP8、VP8L、VP8X 三种头）与 BMP。
// 尺寸只是显示用的元数据：认不出格式、数据被截断或头是伪造的，一律返回 0；
// 任何情况下都不抛异常，避免一张坏图拖垮入库、命中与识图。
//
// 调用方不需要传尺寸，拿到什么字节就按什么字节读；读不出来就是 0。

const zero = () => ({ width: 0, height: 0 })

/** 把文件头里的数值规整成像素尺寸：0、负数、非有限数与超范围值都当「读不出来」。 */
function dimensions(width, height) {
  const clean = (value) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.min(0x7fffffff, Math.floor(n)) : 0
  }
  return { width: clean(width), height: clean(height) }
}

/** PNG：签名 + 首块必须是 IHDR，宽高在块数据区前 8 字节（大端）。 */
function readPng(buf) {
  if (buf.length < 24) return null
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  if (buf[4] !== 0x0d || buf[5] !== 0x0a || buf[6] !== 0x1a || buf[7] !== 0x0a) return null
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null
  return dimensions(buf.readUInt32BE(16), buf.readUInt32BE(20))
}

/** GIF：逻辑屏幕宽高在文件头 6-9 字节（小端）；不看帧，帧尺寸可能更小。 */
function readGif(buf) {
  if (buf.length < 10) return null
  const header = buf.toString('latin1', 0, 6)
  if (header !== 'GIF87a' && header !== 'GIF89a') return null
  return dimensions(buf.readUInt16LE(6), buf.readUInt16LE(8))
}

/** JPEG：跳过 APPn 等段，直到 SOF 段；宽高在该段数据区高度 2 字节之后。 */
function readJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let p = 2
  while (p + 1 < buf.length) {
    if (buf[p] !== 0xff) {
      p += 1
      continue
    }
    // 标记前允许任意个填充 0xFF。
    while (p + 1 < buf.length && buf[p + 1] === 0xff) p += 1
    const mark = buf[p + 1]
    p += 2
    if (mark === 0xd8 || (mark >= 0xd0 && mark <= 0xd7)) continue
    // EOI 之后没有尺寸；SOS 之后的熵编码数据里也不会再有 SOF。
    if (mark === 0xd9 || mark === 0xda) break
    if (p + 2 > buf.length) break
    const length = buf.readUInt16BE(p)
    if (length < 2) break
    // SOF 家族（排除 DHT/JPG/DAC）才有宽高。
    const isSof = mark >= 0xc0 && mark <= 0xcf && mark !== 0xc4 && mark !== 0xc8 && mark !== 0xcc
    if (isSof) {
      if (p + 7 > buf.length) break
      return dimensions(buf.readUInt16BE(p + 5), buf.readUInt16BE(p + 3))
    }
    if (p + length > buf.length) break
    p += length
  }
  return dimensions(0, 0)
}

/** WebP：RIFF 容器里的第一个块决定尺寸，三种编码的头结构不同。 */
function readWebp(buf) {
  if (buf.length < 20) return null
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null
  const fourcc = buf.toString('latin1', 12, 16)
  // 块数据从 20 开始：12-15 是 fourcc，16-19 是块长度。
  const data = 20
  if (fourcc === 'VP8 ') {
    if (buf.length < data + 10) return dimensions(0, 0)
    // 3 字节帧标签 + 起始码 9D 01 2A，随后是各 14 位的宽、高。
    if (buf[data + 3] !== 0x9d || buf[data + 4] !== 0x01 || buf[data + 5] !== 0x2a) return dimensions(0, 0)
    return dimensions(buf.readUInt16LE(data + 6) & 0x3fff, buf.readUInt16LE(data + 8) & 0x3fff)
  }
  if (fourcc === 'VP8L') {
    if (buf.length < data + 5) return dimensions(0, 0)
    // 1 字节签名 2F + 28 位：低 14 位是宽-1，高 14 位是高-1。
    if (buf[data] !== 0x2f) return dimensions(0, 0)
    const bits = buf.readUInt32LE(data + 1)
    return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (fourcc === 'VP8X') {
    if (buf.length < data + 10) return dimensions(0, 0)
    // 4 字节 flags/reserved 后是两个 24 位的「宽-1 / 高-1」。
    return dimensions(buf.readUIntLE(data + 4, 3) + 1, buf.readUIntLE(data + 7, 3) + 1)
  }
  return dimensions(0, 0)
}

/** BMP：DIB 头分 12 字节（16 位宽高）与 40 字节以上（32 位有符号，负高表示自上而下）。 */
function readBmp(buf) {
  if (buf.length < 18) return null
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) return null
  const headerSize = buf.readUInt32LE(14)
  if (headerSize === 12) {
    if (buf.length < 22) return dimensions(0, 0)
    return dimensions(buf.readUInt16LE(18), buf.readUInt16LE(20))
  }
  if (headerSize >= 40) {
    if (buf.length < 26) return dimensions(0, 0)
    return dimensions(Math.abs(buf.readInt32LE(18)), Math.abs(buf.readInt32LE(22)))
  }
  return dimensions(0, 0)
}

/**
 * 读图片像素宽高。
 * @param {Buffer} buffer 图片字节（其它类型一律按「读不出来」处理）
 * @returns {{width:number, height:number}} 读不出来时两项都为 0
 */
export function imageSize(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2) return zero()
    return readGif(buffer)
      || readPng(buffer)
      || readJpeg(buffer)
      || readWebp(buffer)
      || readBmp(buffer)
      || zero()
  } catch {
    return zero()
  }
}
