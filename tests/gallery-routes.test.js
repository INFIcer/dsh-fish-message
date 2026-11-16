// 图库管理路由：收图图库（列表 / 出图 / 改描述 / 打开原图）与记忆图库、声纹库
// （服务缺失时降级、服务可用时转发并校验参数）。
//
// 不启宿主：直接拿 makeGalleryRouteHandlers() 的「路径 → handler」，用假 req/res 调；
// 收图图库用真实存储层 + 临时目录，记忆服务用最小假服务。

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImageLibrary } from '../lib/image-library.js'
import { makeGalleryRouteHandlers } from '../lib/gallery-routes.js'
import { makeGif, smallPng } from './image-fixtures.js'

const prefix = '/dsh-fish-message'
const shaOf = (buffer) => createHash('sha256').update(buffer).digest('hex')

function makeRequest({ method = 'GET', url = '/', body = undefined } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = {}
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v) },
    end(value) { this.body = value },
  }
}

async function invoke(handlers, path, request) {
  const res = fakeResponse()
  const handler = handlers[path]
  assert.equal(typeof handler, 'function', `没有注册路由 ${path}`)
  await handler(request, res)
  return res
}

const json = (res) => JSON.parse(String(res.body))

function makeLibrary() {
  const dir = mkdtempSync(join(tmpdir(), 'fish-gallery-'))
  return { dir, library: new ImageLibrary({ dir }) }
}

function makeRoutes(options = {}) {
  return makeGalleryRouteHandlers({
    routePrefix: prefix,
    platform: 'win32',
    spawn: () => ({ on() {}, unref() {} }),
    ...options,
  })
}

test('收图图库：列表按关键词筛选、出图返回原图字节、参数与方式校验', async () => {
  const { library } = makeLibrary()
  const cat = library.remember({
    buffer: smallPng, ext: '.png', mime: 'image/png', desc: '一只橘猫', descSource: 'local',
  })
  const gif = library.remember({
    buffer: makeGif(), ext: '.gif', mime: 'image/gif', desc: '', descSource: 'api',
  })
  const handlers = makeRoutes({ images: library })

  const all = await invoke(handlers, `${prefix}/images`, makeRequest({ url: `${prefix}/images` }))
  const allBody = json(all)
  assert.equal(allBody.ok, true)
  assert.equal(allBody.total, 2)
  assert.equal(allBody.entries.length, 2)
  assert.equal(allBody.stats.count, 2)
  const catEntry = allBody.entries.find((entry) => entry.sha256 === cat.sha256)
  assert.ok(catEntry, '条目要带完整指纹')
  assert.equal(catEntry.path, cat.path, '条目要带原图绝对路径（存为表情要用）')
  assert.equal(catEntry.desc, '一只橘猫')

  const search = await invoke(handlers, `${prefix}/images`, makeRequest({
    url: `${prefix}/images?q=${encodeURIComponent('橘猫')}`,
  }))
  assert.equal(json(search).total, 1)

  const file = await invoke(handlers, `${prefix}/images/file`, makeRequest({
    url: `${prefix}/images/file?sha256=${cat.sha256}`,
  }))
  assert.equal(file.statusCode, 200)
  assert.equal(file.headers['content-type'], 'image/png')
  assert.ok(Buffer.isBuffer(file.body))
  assert.ok(file.body.equals(smallPng), '出图必须原样返回库里的原图')

  const missing = await invoke(handlers, `${prefix}/images/file`, makeRequest({
    url: `${prefix}/images/file?sha256=${'0'.repeat(64)}`,
  }))
  assert.equal(missing.statusCode, 404)

  const bad = await invoke(handlers, `${prefix}/images/file`, makeRequest({
    url: `${prefix}/images/file?sha256=nope`,
  }))
  assert.equal(bad.statusCode, 400)

  const method = await invoke(handlers, `${prefix}/images`, makeRequest({ method: 'POST', url: `${prefix}/images` }))
  assert.equal(method.statusCode, 405)
  assert.ok(gif.sha256)
})

test('收图图库：改描述只动索引，打开原图走资源管理器', async () => {
  const { library } = makeLibrary()
  const entry = library.remember({ buffer: smallPng, ext: '.png', mime: 'image/png' })
  const spawned = []
  const handlers = makeRoutes({
    images: library,
    platform: 'win32',
    spawn: (file, args) => {
      spawned.push({ file, args })
      return { on() {}, unref() {} }
    },
  })

  const saved = await invoke(handlers, `${prefix}/images/note`, makeRequest({
    method: 'POST',
    url: `${prefix}/images/note`,
    body: { sha256: entry.sha256, desc: '  一只猫坐在键盘上  ' },
  }))
  const savedBody = json(saved)
  assert.equal(savedBody.ok, true)
  assert.equal(savedBody.entry.desc, '一只猫坐在键盘上')
  assert.equal(savedBody.entry.descSource, 'manual')
  assert.equal(library.lookup(entry.sha256).desc, '一只猫坐在键盘上')

  const unknown = await invoke(handlers, `${prefix}/images/note`, makeRequest({
    method: 'POST',
    url: `${prefix}/images/note`,
    body: { sha256: 'f'.repeat(64), desc: 'x' },
  }))
  assert.equal(unknown.statusCode, 404)

  const opened = await invoke(handlers, `${prefix}/images/open`, makeRequest({
    method: 'POST',
    url: `${prefix}/images/open`,
    body: { sha256: entry.sha256 },
  }))
  assert.equal(json(opened).ok, true)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].file, 'explorer.exe')
  assert.deepEqual(spawned[0].args, [entry.path], '打开的是库里的原图文件')

  const notWindows = makeRoutes({ images: library, platform: 'linux' })
  const unsupported = await invoke(notWindows, `${prefix}/images/open`, makeRequest({
    method: 'POST',
    url: `${prefix}/images/open`,
    body: { sha256: entry.sha256 },
  }))
  assert.equal(unsupported.statusCode, 501)
})

test('记忆图库：转发列表、出图与改描述；声纹库转发 people 与阈值', async () => {
  const { dir } = makeLibrary()
  const imagePath = join(dir, 'memory.png')
  writeFileSync(imagePath, smallPng)
  const calls = []
  const entry = {
    sha256: shaOf(smallPng),
    name: '用户照片',
    tags: ['主人'],
    desc: '一张照片',
    width: 1,
    height: 1,
    bytes: smallPng.length,
    path: imagePath,
  }
  const service = {
    images: {
      async list(input) {
        calls.push({ method: 'list', input })
        return { total: 1, entries: [entry] }
      },
      async get(input) {
        calls.push({ method: 'get', input })
        return { entry }
      },
      async note(input) {
        calls.push({ method: 'note', input })
        return { updated: true, entry: { ...entry, desc: input.desc || entry.desc, tags: [...entry.tags, ...(input.tags || [])] } }
      },
    },
    voices: {
      async list() {
        calls.push({ method: 'voices.list' })
        return { threshold: 0.65, people: [{ name: '主人', tags: ['常用'], samples: 3, updated_at: '2026-11-16T12:00:00' }] }
      },
    },
  }
  const handlers = makeRoutes({ getMemory: () => service })

  const listed = await invoke(handlers, `${prefix}/memory/images`, makeRequest({
    url: `${prefix}/memory/images?q=${encodeURIComponent('照片')}&limit=10`,
  }))
  const listedBody = json(listed)
  assert.equal(listedBody.ok, true)
  assert.equal(listedBody.service, true)
  assert.equal(listedBody.total, 1)
  assert.equal(listedBody.entries[0].name, '用户照片')
  assert.deepEqual(calls[0], { method: 'list', input: { q: '照片', tag: '', limit: 10 } })

  const file = await invoke(handlers, `${prefix}/memory/images/file`, makeRequest({
    url: `${prefix}/memory/images/file?sha256=${entry.sha256}`,
  }))
  assert.equal(file.statusCode, 200)
  assert.equal(file.headers['content-type'], 'image/png')
  assert.ok(file.body.equals(smallPng))
  assert.deepEqual(calls[1], { method: 'get', input: { sha256: entry.sha256 } })

  const noted = await invoke(handlers, `${prefix}/memory/images/note`, makeRequest({
    method: 'POST',
    url: `${prefix}/memory/images/note`,
    body: { sha256: entry.sha256, desc: '新描述' },
  }))
  assert.equal(json(noted).ok, true)
  assert.deepEqual(calls[2], { method: 'note', input: { sha256: entry.sha256, desc: '新描述' } })

  const tags = await invoke(handlers, `${prefix}/memory/images/note`, makeRequest({
    method: 'POST',
    url: `${prefix}/memory/images/note`,
    body: { sha256: entry.sha256, tags: ['新标签'] },
  }))
  assert.equal(json(tags).ok, true)
  assert.deepEqual(calls[3].input, { sha256: entry.sha256, tags: ['新标签'] })

  const voices = await invoke(handlers, `${prefix}/memory/voices`, makeRequest({
    url: `${prefix}/memory/voices`,
  }))
  const voicesBody = json(voices)
  assert.equal(voicesBody.ok, true)
  assert.equal(voicesBody.service, true)
  assert.equal(voicesBody.threshold, 0.65)
  assert.equal(voicesBody.people[0].name, '主人')
  assert.equal(voicesBody.people[0].samples, 3)
})

test('记忆服务缺失：两个记忆接口降级但不报错，收图图库照常', async () => {
  const { library } = makeLibrary()
  const handlers = makeRoutes({ images: library, getMemory: () => undefined })

  const images = await invoke(handlers, `${prefix}/memory/images`, makeRequest({
    url: `${prefix}/memory/images`,
  }))
  const imagesBody = json(images)
  assert.equal(images.statusCode, 200)
  assert.equal(imagesBody.ok, true)
  assert.equal(imagesBody.service, false)
  assert.equal(imagesBody.hint, '记忆插件未启用')
  assert.deepEqual(imagesBody.entries, [])

  const voices = await invoke(handlers, `${prefix}/memory/voices`, makeRequest({
    url: `${prefix}/memory/voices`,
  }))
  const voicesBody = json(voices)
  assert.equal(voices.statusCode, 200)
  assert.equal(voicesBody.service, false)
  assert.equal(voicesBody.hint, '记忆插件未启用')
  assert.deepEqual(voicesBody.people, [])

  const file = await invoke(handlers, `${prefix}/memory/images/file`, makeRequest({
    url: `${prefix}/memory/images/file?sha256=${'a'.repeat(64)}`,
  }))
  assert.equal(file.statusCode, 404)

  const note = await invoke(handlers, `${prefix}/memory/images/note`, makeRequest({
    method: 'POST',
    url: `${prefix}/memory/images/note`,
    body: { sha256: 'a'.repeat(64), desc: 'x' },
  }))
  assert.equal(note.statusCode, 503)

  // 收图图库不依赖记忆服务，照样能列。
  const own = await invoke(handlers, `${prefix}/images`, makeRequest({ url: `${prefix}/images` }))
  assert.equal(json(own).ok, true)
  assert.equal(json(own).total, 0)
})

test('记忆服务抛错：返回 502 + 可读错误，不把裸异常抛给页面', async () => {
  const handlers = makeRoutes({
    getMemory: () => ({
      images: { list: async () => { throw new Error('索引坏了') } },
      voices: { list: async () => { throw new Error('声纹文件坏了') } },
    }),
  })
  const images = await invoke(handlers, `${prefix}/memory/images`, makeRequest({ url: `${prefix}/memory/images` }))
  assert.equal(images.statusCode, 502)
  assert.equal(json(images).ok, false)
  assert.equal(json(images).service, true)
  assert.match(json(images).error, /索引坏了/)

  const voices = await invoke(handlers, `${prefix}/memory/voices`, makeRequest({ url: `${prefix}/memory/voices` }))
  assert.equal(voices.statusCode, 502)
})