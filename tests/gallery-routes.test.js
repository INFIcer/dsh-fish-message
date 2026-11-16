// 图库主面板的收图图库路由：列表 / 搜索 / 出图 / 改描述 / 打开原图。
//
// 不启宿主：直接拿 makeGalleryRouteHandlers() 的「路径 → handler」，用假 req/res 调；
// 收图图库用真实存储层 + 临时目录。

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImageLibrary } from '../lib/image-library.js'
import { makeGalleryRouteHandlers } from '../lib/gallery-routes.js'
import { makeGif, smallPng } from './image-fixtures.js'

const prefix = '/dsh-fish-message'

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

test('图库没准备好：列表返回 503，不抛裸异常', async () => {
  const handlers = makeRoutes({ images: null })
  const listed = await invoke(handlers, `${prefix}/images`, makeRequest({ url: `${prefix}/images` }))
  assert.equal(listed.statusCode, 503)
  assert.equal(json(listed).ok, false)
})
