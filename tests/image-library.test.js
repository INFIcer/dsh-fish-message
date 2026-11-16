// 图库存储层单测：指纹去重、描述回填、命中计数、上限淘汰、索引容错、原子写。
//
// 全部离线：只用临时目录和手工拼的 PNG/GIF。

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ImageLibrary, ImageLibraryError, hashBuffer, hashFile, mimeFromExt } from '../lib/image-library.js'
import { makeGif, smallPng } from './image-fixtures.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'fish-image-library-'))

function makeLogger() {
  const lines = { warn: [], info: [], debug: [] }
  return {
    lines,
    warn: (message) => lines.warn.push(String(message)),
    info: (message) => lines.info.push(String(message)),
    debug: (message) => lines.debug.push(String(message)),
    error: (message) => lines.warn.push(String(message)),
  }
}

function makeLibrary(options = {}) {
  const logger = makeLogger()
  const dir = options.dir || tempDir()
  const library = new ImageLibrary({ dir, logger, ...options })
  return { library, dir, logger }
}

const shaOf = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** 造一张「内容不同」的假图：图库只按字节存，不嗅探格式。 */
const fakeImage = (name) => Buffer.from(`fake-image-${name}`)

test('指纹：同一份字节永远同一个 sha256，文件与内存一致', () => {
  const dir = tempDir()
  const file = join(dir, 'a.png')
  writeFileSync(file, smallPng)
  assert.equal(hashBuffer(smallPng), shaOf(smallPng))
  assert.equal(hashFile(file), hashBuffer(smallPng))
  assert.equal(hashBuffer(smallPng).length, 64)
  assert.throws(() => hashBuffer(Buffer.alloc(0)), { code: 'image_library_bad_request' })
  assert.throws(() => hashFile(''), { code: 'image_library_bad_request' })
  assert.throws(() => hashFile(join(dir, 'missing.png')), { code: 'image_library_io' })
})

test('入库：同 sha 只留一份，已有描述不被覆盖（force 才覆盖）', () => {
  const { library, dir } = makeLibrary()
  const first = library.remember({
    buffer: smallPng, ext: '.png', mime: 'image/png', desc: '一只橘猫趴在键盘上', descSource: 'local',
  })
  assert.equal(first.sha256, shaOf(smallPng))
  assert.equal(first.file, `img/${first.sha256.slice(0, 2)}/${first.sha256}.png`)
  assert.ok(existsSync(join(dir, first.file)), '原图落到 img/<sha 前两位>/<sha>.<ext>')

  const second = library.remember({ buffer: smallPng, desc: '另一个不一样的说法', descSource: 'manual' })
  assert.equal(second.sha256, first.sha256)
  assert.equal(second.desc, '一只橘猫趴在键盘上', '缓存语义：已有描述不覆盖')
  assert.equal(library.stats().count, 1, '同内容只有一条')

  const forced = library.remember({ buffer: smallPng, desc: '换成这句', force: true })
  assert.equal(forced.desc, '换成这句')
})

test('setDesc：给没描述的条目补写，未知指纹返回 null', () => {
  const { library } = makeLibrary()
  const entry = library.remember({ buffer: smallPng, ext: '.png' })
  assert.equal(entry.desc, '')
  assert.equal(entry.descFirstAt, '')

  const filled = library.setDesc(entry.sha256, '  一只猫  ', { descSource: 'manual' })
  assert.equal(filled.desc, '一只猫', '两端空白被去掉')
  assert.equal(filled.descSource, 'manual')
  assert.ok(filled.descAt)
  assert.equal(filled.descFirstAt, filled.descAt, '首次识别时间在第一次写描述时记下')

  const again = library.setDesc(entry.sha256, '换个说法')
  assert.equal(again.desc, '换个说法')
  assert.equal(again.descFirstAt, filled.descFirstAt, '再次修改不改「首次」时间')

  assert.equal(library.setDesc('f'.repeat(64), '没有这张图'), null, '找不到用返回值表达，不抛错')
})

test('命中 / 未命中计数：stats 汇总，未知指纹返回 null', () => {
  const { library } = makeLibrary()
  const entry = library.remember({ buffer: smallPng, ext: '.png' })
  library.noteHit(entry.sha256)
  library.noteHit(entry.sha256)
  library.noteMiss(entry.sha256)

  const stored = library.lookup(entry.sha256)
  assert.equal(stored.hits, 2)
  assert.equal(stored.misses, 1)
  assert.ok(stored.lastSeenAt)
  assert.equal(library.stats().hits, 2)
  assert.equal(library.stats().misses, 1)
  assert.equal(library.noteHit('f'.repeat(64)), null)
})

test('lookup：完整指纹与 8 位以上前缀，找不到 / 前缀撞车都返回 null', () => {
  const { library } = makeLibrary()
  const entry = library.remember({ buffer: smallPng, ext: '.png', desc: '一只猫' })
  assert.equal(library.lookup(entry.sha256).sha256, entry.sha256)
  assert.equal(library.lookup(entry.sha256.slice(0, 8)).sha256, entry.sha256, '允许用前缀定位')
  assert.equal(library.lookup('zzzzzzzz'), null)
  assert.equal(library.lookup(entry.sha256.slice(0, 4)), null, '太短的前缀不认')
  assert.equal(library.lookup('f'.repeat(64)), null)
})

test('上限淘汰：按 lastSeenAt 从旧到新删，原图文件一起删', () => {
  const { library, dir } = makeLibrary({ maxItems: 2 })
  const a = library.remember({ buffer: fakeImage('a'), ext: '.png' })
  const b = library.remember({ buffer: fakeImage('b'), ext: '.png' })
  // 同一秒内入库时时间戳相同，这里直接写时间，让淘汰顺序确定。
  library.entries[0].lastSeenAt = '2026-01-01T00:00:00'
  library.entries[1].lastSeenAt = '2026-01-02T00:00:00'
  const c = library.remember({ buffer: fakeImage('c'), ext: '.png' })

  assert.equal(library.stats().count, 2, '条数不超上限')
  assert.equal(library.lookup(a.sha256), null, '最久没见到的被淘汰')
  assert.ok(library.lookup(b.sha256))
  assert.ok(library.lookup(c.sha256))
  assert.equal(existsSync(join(dir, a.file)), false, '淘汰时原图文件一起删')
  assert.equal(library.stats().withFile, 2)
})

test('容量淘汰：原图总量超过 maxMB 时删最旧的，可用字节数回落', () => {
  const { library } = makeLibrary({ maxMB: 1 })
  const chunk = Buffer.alloc(600 * 1024, 7)
  const one = library.remember({ buffer: chunk, ext: '.png' })
  const two = library.remember({ buffer: Buffer.concat([chunk, Buffer.from('2')]), ext: '.png' })
  assert.ok(library.stats().bytes <= 1048576, '总量不超过 1MB')
  assert.equal(library.stats().count, 1)
  assert.equal(library.lookup(one.sha256), null)
  assert.ok(library.lookup(two.sha256))
})

test('keepFiles=false：只留描述与尺寸，不存原图也不占空间', () => {
  const { library } = makeLibrary({ keepFiles: false })
  const entry = library.remember({ buffer: smallPng, ext: '.png', mime: 'image/png', desc: '一只猫' })
  assert.equal(entry.file, '')
  assert.equal(entry.path, '')
  assert.equal(library.stats().withFile, 0)
  assert.equal(library.stats().bytes, 0, '不存原图就不算占用')
  assert.equal(library.stats().withDesc, 1)
  assert.equal(library.hasFile(entry), false)
  // 没有原图字节时，用描述也能入库（这类条目只用来提供文字）。
  const textOnly = library.remember({ sha256: shaOf(fakeImage('x')), desc: '只有文字' })
  assert.equal(textOnly.desc, '只有文字')
})

test('索引损坏：整份读不出来时留档并从空索引开始', () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'img'), { recursive: true })
  writeFileSync(join(dir, 'index.json'), '{ 这不是 JSON', 'utf8')
  const logger = makeLogger()
  const library = new ImageLibrary({ dir, logger })
  assert.equal(library.stats().count, 0)
  assert.ok(logger.lines.warn.some((line) => line.includes('图库索引已损坏')), '损坏要 warn')
  assert.ok(readdirSync(dir).some((name) => name.startsWith('index.json.bad-')), '原文件留档，方便人工恢复')
})

test('索引条目损坏：坏条目丢弃并 warn，好条目照常可用', () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'img'), { recursive: true })
  const good = shaOf(smallPng)
  writeFileSync(join(dir, 'index.json'), JSON.stringify({
    version: 1,
    items: [
      { sha256: '不是指纹' },
      { sha256: good, file: '../../../etc/passwd' },
      null,
      { sha256: good, file: `img/${good.slice(0, 2)}/${good}.png`, desc: '好的那条' },
    ],
  }), 'utf8')
  const logger = makeLogger()
  const library = new ImageLibrary({ dir, logger })
  assert.equal(library.stats().count, 1)
  assert.equal(library.lookup(good).desc, '好的那条')
  assert.ok(logger.lines.warn.some((line) => line.includes('3 条条目读不出来')), '丢弃条数要写进日志')
})

test('原子写：索引始终是完整 JSON，目录里没有写一半的临时文件', () => {
  const { library, dir } = makeLibrary()
  for (let i = 0; i < 5; i++) library.remember({ buffer: fakeImage(`n${i}`), ext: '.png', desc: `第 ${i} 张` })
  const disk = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
  assert.equal(disk.version, 1)
  assert.equal(disk.items.length, 5)
  assert.ok(disk.updatedAt)
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], '不留临时文件')
})

test('clear：条目、原图、索引一起清空', () => {
  const { library, dir } = makeLibrary()
  library.remember({ buffer: smallPng, ext: '.png', desc: '一只猫' })
  library.remember({ buffer: makeGif(), ext: '.gif', desc: '一张动图' })
  const result = library.clear()
  assert.equal(result.removed, 2)
  assert.ok(result.freedBytes > 0)
  assert.equal(library.stats().count, 0)
  assert.deepEqual(readdirSync(join(dir, 'img')), [], '原图目录清空')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).items, [])
})

test('磁盘错误抛带 code 的错误，参数不对抛 bad_request', () => {
  const dir = tempDir()
  const blocked = join(dir, 'blocked')
  writeFileSync(blocked, 'not a dir', 'utf8')
  const library = new ImageLibrary({ dir: blocked })
  assert.throws(
    () => library.remember({ buffer: smallPng, ext: '.png' }),
    (error) => error instanceof ImageLibraryError && error.code === 'image_library_io' && Boolean(error.hint),
  )
  const { library: normal } = makeLibrary()
  assert.throws(() => normal.remember({}), { code: 'image_library_bad_request' })
  assert.throws(() => normal.remember({ desc: '只有描述没有指纹' }), { code: 'image_library_bad_request' })
})

test('mimeFromExt：认识的扩展名给 mime，认不出给空串', () => {
  assert.equal(mimeFromExt('.png'), 'image/png')
  assert.equal(mimeFromExt('jpg'), 'image/jpeg')
  assert.equal(mimeFromExt('.webp'), 'image/webp')
  assert.equal(mimeFromExt('.txt'), '')
  assert.equal(mimeFromExt(''), '')
})
