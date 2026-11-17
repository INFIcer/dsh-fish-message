// 图片尺寸解析单测：只读文件头，不解码像素。
//
// 覆盖 PNG / JPEG / GIF / WebP（VP8、VP8L、VP8X）/ BMP，以及空、截断、伪造头等坏数据。

import test from 'node:test'
import assert from 'node:assert/strict'
import { imageSize } from '../lib/image-size.js'
import { makeBmp, makeGif, makeJpeg, makeWebp, smallPng } from './image-fixtures.js'

const zero = { width: 0, height: 0 }

test('PNG：从 IHDR 读宽高', () => {
  assert.deepEqual(imageSize(smallPng), { width: 1, height: 1 }, '内置 1×1 PNG')
  const resized = Buffer.from(smallPng)
  resized.writeUInt32BE(640, 16)
  resized.writeUInt32BE(480, 20)
  assert.deepEqual(imageSize(resized), { width: 640, height: 480 }, '只读头，不校验 CRC')
})

test('JPEG：跳过 APP0，扫到 SOF0 后取宽高', () => {
  assert.deepEqual(imageSize(makeJpeg({ width: 5, height: 6 })), { width: 5, height: 6 })
})

test('GIF：读逻辑屏幕宽高', () => {
  assert.deepEqual(imageSize(makeGif({ width: 3, height: 4 })), { width: 3, height: 4 })
})

test('WebP：VP8 / VP8L / VP8X 三种头都能读', () => {
  assert.deepEqual(imageSize(makeWebp({ width: 10, height: 8, variant: 'VP8' })), { width: 10, height: 8 })
  assert.deepEqual(imageSize(makeWebp({ width: 321, height: 123, variant: 'VP8L' })), { width: 321, height: 123 })
  assert.deepEqual(imageSize(makeWebp({ width: 4000, height: 3000, variant: 'VP8X' })), { width: 4000, height: 3000 })
})

test('BMP：读 BITMAPINFOHEADER，负高度取绝对值', () => {
  assert.deepEqual(imageSize(makeBmp({ width: 7, height: 9 })), { width: 7, height: 9 })
  assert.deepEqual(imageSize(makeBmp({ width: 7, height: 9, topDown: true })), { width: 7, height: 9 }, '自上而下存储')
})

test('坏数据：空、非 Buffer、截断、伪造头都返回 0 且不抛', () => {
  const cases = [
    null,
    undefined,
    '',
    'not a buffer',
    Buffer.alloc(0),
    Buffer.from('hello'),
    Buffer.alloc(64, 0xff),
    smallPng.subarray(0, 20), // PNG 只有签名与 IHDR 声明，宽高被截断
    makeJpeg({ width: 5, height: 6 }).subarray(0, 6), // JPEG 段长不完整
    makeGif({ width: 3, height: 4 }).subarray(0, 9), // GIF 缺高度最后 1 字节
    makeWebp({ variant: 'VP8L' }).subarray(0, 24), // WebP 尺寸位被截断
    makeBmp({ width: 7, height: 9 }).subarray(0, 20), // BMP 缺高度
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x02]), // 伪造 SOF：段长 < 2
  ]
  for (const value of cases) {
    assert.deepEqual(imageSize(value), zero, `坏数据应返回 0：${String(value).slice(0, 16)}`)
  }
})
