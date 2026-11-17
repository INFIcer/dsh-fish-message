// 图库工具：fish_image_get（取原图）与 fish_image_note（写回描述）。
//
// 重点覆盖「取原图」的两条返回路径：宿主有附件服务时返回图片块，没有时退回本机路径。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImageLibrary, hashBuffer } from '../lib/image-library.js'
import { VisionCache } from '../lib/vision-cache.js'
import { createFishMessageApi } from '../lib/service.js'
import { buildImageToolDefinitions } from '../lib/image-tools.js'
import { smallPng } from './image-fixtures.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'fish-image-tools-'))
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

function makeEnv({ attachments = null } = {}) {
  const dir = tempDir()
  const imagePath = join(dir, 'qq.png')
  writeFileSync(imagePath, smallPng)
  const library = new ImageLibrary({ dir: join(dir, 'images'), logger: silentLogger })
  const config = { imageLibraryEnabled: true, imageLibraryMaxItems: 1000, imageLibraryMaxMB: 512, imageLibraryKeepFiles: true }
  const api = createFishMessageApi({
    images: library,
    ai: null,
    getConfig: () => config,
    logger: silentLogger,
  })
  const definitions = buildImageToolDefinitions({
    api,
    logger: silentLogger,
    getConfig: () => config,
    getAttachments: () => attachments,
  })
  const tool = (name) => definitions.find((item) => item.name === name)
  return { dir, imagePath, library, api, tool, sha256: hashBuffer(smallPng) }
}

test('fish_image_get：有附件服务时返回图片块，不返回 base64', async () => {
  const saved = []
  const env = makeEnv({
    attachments: {
      async saveImage(input) {
        saved.push(input)
        return { attachmentId: 'att-123', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }
      },
    },
  })
  env.library.remember({ buffer: smallPng, path: env.imagePath, ext: '.png', mime: 'image/png', desc: '一只猫' })

  const get = env.tool('fish_image_get')
  const value = await get.execute({ sha256: env.sha256.slice(0, 12) }, {})
  assert.equal(value.ok, true)
  assert.equal(value.sha256, env.sha256)
  assert.equal(value.attached, true)
  assert.equal(value.library, '收图图库', '回执要注明原图来自收图图库，避免和表情库混淆')
  assert.equal(value.desc, '一只猫')
  assert.equal(value.image.attachmentId, 'att-123')
  assert.equal('hint' in value, false)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/png')

  const blocks = get.output.render({}, value)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /收图图库原图/)
  assert.match(blocks[0].text, /描述：一只猫/)
  assert.deepEqual(blocks[1], { type: 'image', attachment: value.image })
  assert.equal(JSON.stringify(value).includes('base64'), false, '工具不返回 base64')
})

test('fish_image_get：宿主没有附件服务时退回本机路径并提示用 read_image', async () => {
  const env = makeEnv({ attachments: null })
  env.library.remember({ buffer: smallPng, ext: '.png', mime: 'image/png', desc: '一只狗' })
  const get = env.tool('fish_image_get')
  const value = await get.execute({ sha256: env.sha256 }, {})
  assert.equal(value.ok, true)
  assert.equal(value.attached, false)
  assert.equal('image' in value, false)
  assert.match(value.path, /img/)
  assert.match(value.hint, /read_image/)

  const blocks = get.output.render({}, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /read_image|"attached": false/)
})

test('fish_image_get：可以按本机路径定位；不在图库时明确说找不到', async () => {
  const env = makeEnv({ attachments: null })
  env.library.remember({ buffer: smallPng, path: env.imagePath, ext: '.png', mime: 'image/png', desc: '一只猫' })
  const get = env.tool('fish_image_get')

  const byPath = await get.execute({ path: env.imagePath }, {})
  assert.equal(byPath.ok, true)
  assert.equal(byPath.sha256, env.sha256)

  const other = join(env.dir, 'other.png')
  writeFileSync(other, Buffer.concat([smallPng, Buffer.from('别的图')]))
  const missing = await get.execute({ path: other }, {})
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'not_found')
  assert.match(missing.hint, /fish_image_note/)

  const unknown = await get.execute({ sha256: 'f'.repeat(64) }, {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'not_found')
})

test('fish_image_get：图库只留描述（没存原图）时给 no_file，不装作拿到了图', async () => {
  const env = makeEnv({ attachments: null })
  env.library.configure({ keepFiles: false })
  env.library.remember({ buffer: smallPng, ext: '.png', desc: '只有一句描述' })
  const get = env.tool('fish_image_get')
  const value = await get.execute({ sha256: env.sha256 }, {})
  assert.equal(value.ok, false)
  assert.equal(value.code, 'no_file')
  assert.match(value.hint, /只存了描述/)
})

test('fish_image_note：按路径新建条目，回执说明是新建', async () => {
  const env = makeEnv()
  const note = env.tool('fish_image_note')
  const value = await note.execute({ path: env.imagePath, desc: '一张写着晚安的表情包' }, {})
  assert.equal(value.ok, true)
  assert.equal(value.created, true)
  assert.equal(value.updated, false)
  assert.equal(value.replaced, false)
  assert.equal(value.previousDesc, '')
  assert.equal(value.sha256, env.sha256)
  assert.equal(value.library, '收图图库', '回执要说明描述写进了收图图库')

  const entry = env.library.lookup(env.sha256)
  assert.equal(entry.desc, '一张写着晚安的表情包')
  assert.ok(entry.file, '新建时把原图也存进图库')
})

test('fish_image_note：给已有描述的条目改写，回执说明覆盖了旧描述', async () => {
  const env = makeEnv()
  env.library.remember({ buffer: smallPng, path: env.imagePath, ext: '.png', desc: '旧描述' })
  const note = env.tool('fish_image_note')

  const value = await note.execute({ sha256: env.sha256.slice(0, 8), desc: '新描述' }, {})
  assert.equal(value.ok, true)
  assert.equal(value.created, false)
  assert.equal(value.updated, true)
  assert.equal(value.replaced, true)
  assert.equal(value.previousDesc, '旧描述')
  assert.equal(env.library.lookup(env.sha256).desc, '新描述')

  // 同样的描述再写一次：不算覆盖。
  const same = await note.execute({ sha256: env.sha256, desc: '新描述' }, {})
  assert.equal(same.replaced, false)
})

test('fish_image_note：指纹不存在时明确报 not_found，空描述被拒', async () => {
  const env = makeEnv()
  const note = env.tool('fish_image_note')
  const missing = await note.execute({ sha256: 'f'.repeat(64), desc: '随便' }, {})
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'not_found')
  assert.match(missing.hint, /path/)

  const empty = await note.execute({ path: env.imagePath, desc: '   ' }, {})
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'bad_request')
})

test('fish.message 的 images API：lookup / remember / stats / clear 都能用', async () => {
  const env = makeEnv()
  const missing = await env.api.images.lookup('f'.repeat(64))
  assert.equal(missing.entry, null)

  const remembered = await env.api.images.remember(env.imagePath, { desc: '一只猫' })
  assert.equal(remembered.ok, true)
  assert.equal(remembered.created, true)

  const found = await env.api.images.lookup(env.sha256.slice(0, 10))
  assert.equal(found.entry.desc, '一只猫')

  const stats = await env.api.images.stats()
  assert.equal(stats.count, 1)
  assert.equal(stats.withDesc, 1)

  const cleared = await env.api.images.clear()
  assert.equal(cleared.removed, 1)
  assert.equal((await env.api.images.stats()).count, 0)
})

test('fish.message 的 images.setDesc：只改描述，条目不存在给结构化错误', async () => {
  const env = makeEnv()
  env.library.remember({ buffer: smallPng, path: env.imagePath, ext: '.png', desc: '' })
  const updated = await env.api.images.setDesc(env.sha256, '补上的描述')
  assert.equal(updated.entry.desc, '补上的描述')
  assert.equal(updated.replaced, false)

  await assert.rejects(
    () => env.api.images.setDesc('f'.repeat(64), '没有这张图'),
    (error) => error.code === 'fish_message_image_not_found',
  )
})

test('注册：宿主没有 ctx.tools 时安静跳过，不抛异常', async () => {
  const env = makeEnv()
  const { registerImageTools } = await import('../lib/image-tools.js')
  const warns = []
  const stop = registerImageTools({}, { api: env.api, logger: { warn: (m) => warns.push(String(m)) }, getConfig: () => ({}) })
  assert.equal(typeof stop, 'function')
  assert.equal(warns.length, 1)
})

test('VisionCache：库操作抛错时降级为不缓存，不让收消息失败', async () => {
  const broken = {
    lookup() { throw new Error('磁盘坏了') },
    noteHit() { throw new Error('磁盘坏了') },
  }
  const warnings = []
  const cache = new VisionCache({
    library: broken,
    ai: null,
    getConfig: () => ({ imageLibraryEnabled: true }),
    logger: { debug() {}, info() {}, warn: (m) => warnings.push(String(m)) },
  })
  const result = await cache.resolve({ buffer: smallPng, path: 'x.png', localVision: false })
  assert.equal(result.source, 'deferred', '库坏了也按「第一次只登记」的策略返回，不伪装成识图')
  assert.equal(result.desc, '')
  assert.match(result.note, /第一次见到/)
  assert.ok(warnings.some((line) => line.includes('图库操作失败')))
})
