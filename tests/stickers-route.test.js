// /stickers 路由：参数校验、multipart、发送、取图穿越防护、导入、清理。
//
// 不启宿主：直接拿 makeStickerRouteHandlers() 的「路径 → handler」，
// 用假 req/res 调；所有文件都在临时目录。

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StickerStore } from '../lib/stickers.js'
import { makeStickerRouteHandlers, parseMultipart } from '../lib/sticker-routes.js'
import { makeGif, smallPng } from './image-fixtures.js'

const prefix = '/dsh-fish-message'

function makeRequest({ method = 'GET', url = '/', body = undefined, headers = {} } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  process.nextTick(() => {
    if (body !== undefined) {
      req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    }
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

const jsonHeaders = { 'content-type': 'application/json' }

function makeEnv(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fish-sticker-route-'))
  const inbox = mkdtempSync(join(tmpdir(), 'fish-sticker-route-inbox-'))
  const store = new StickerStore({
    dir,
    inboxDir: inbox,
    getConfig: () => ({ stickerMaxCount: 2000, stickerMaxMB: 1024, ...config }),
  })
  return { dir, inbox, store }
}

function makeRoutes(store, extra = {}) {
  const call = []
  const bridge = extra.bridge ?? {
    async sendOutbound(qq, segments, options) {
      call.push({ qq, segments, options })
      return { ok: true, sent: true, queued: false, pending: 0 }
    },
  }
  const handlers = makeStickerRouteHandlers({
    stickers: store,
    bridge,
    getConfig: extra.getConfig ?? (() => ({ bindings: [{ qq: '10001', enabled: true }] })),
    routePrefix: prefix,
    importDefaultDir: join(tmpdir(), '不存在的默认导入目录'),
    ...(extra.routeOptions || {}),
  })
  return { handlers, call }
}

function multipartBody(boundary, parts) {
  const segments = []
  for (const p of parts) {
    segments.push(Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="${p.name}"`
      + `${p.filename ? `; filename="${p.filename}"` : ''}\r\n`
      + `${p.type ? `content-type: ${p.type}\r\n` : ''}\r\n`,
    ))
    segments.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data)))
    segments.push(Buffer.from('\r\n'))
  }
  segments.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(segments)
}

test('/stickers：列表、搜索、limit 兜底、方法校验', async () => {
  const { store } = makeEnv()
  store.save(smallPng, { name: 'thinking.png', tags: ['思考'] })
  store.save(makeGif(), { name: 'yawn.gif', tags: ['打哈欠'] })
  const { handlers } = makeRoutes(store)

  const all = await invoke(handlers, `${prefix}/stickers`, makeRequest({ url: `${prefix}/stickers` }))
  const allItems = JSON.parse(all.body)
  assert.equal(allItems.ok, true)
  assert.equal(allItems.total, 2)
  assert.equal(allItems.stats.count, 2)

  const search = await invoke(handlers, `${prefix}/stickers`, makeRequest({ url: `${prefix}/stickers?q=%E6%80%9D%E8%80%83` }))
  assert.equal(JSON.parse(search.body).total, 1)

  const tags = await invoke(handlers, `${prefix}/stickers`, makeRequest({ url: `${prefix}/stickers?tag=%23%E6%89%93%E5%93%88%E6%AC%A0` }))
  assert.equal(JSON.parse(tags.body).total, 1)

  const bad = await invoke(handlers, `${prefix}/stickers`, makeRequest({ url: `${prefix}/stickers?limit=abc` }))
  assert.equal(JSON.parse(bad.body).limit, 50)

  const method = await invoke(handlers, `${prefix}/stickers`, makeRequest({ method: 'POST', url: `${prefix}/stickers` }))
  assert.equal(method.statusCode, 405)
})

test('/stickers/save：JSON 路径入库与参数校验', async () => {
  const { store } = makeEnv()
  const { handlers } = makeRoutes(store)
  const image = join(mkdtempSync(join(tmpdir(), 'fish-sticker-save-')), 'a.png')
  writeFileSync(image, smallPng)

  const toBe = await invoke(handlers, `${prefix}/stickers/save`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/save`, headers: jsonHeaders,
    body: { path: image, tags: '猫, 可爱', desc: '一只猫' },
  }))
  const result = JSON.parse(toBe.body)
  assert.equal(toBe.statusCode, 200)
  assert.equal(result.ok, true)
  assert.equal(result.created, true)
  assert.deepEqual(result.entry.tags, ['猫', '可爱'])

  const missingArg = await invoke(handlers, `${prefix}/stickers/save`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/save`, headers: jsonHeaders, body: {},
  }))
  assert.equal(missingArg.statusCode, 400)
  assert.equal(JSON.parse(missingArg.body).code, 'sticker_bad_request')

  const notFound = await invoke(handlers, `${prefix}/stickers/save`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/save`, headers: jsonHeaders,
    body: { path: join(tmpdir(), '没有这个文件.png') },
  }))
  assert.equal(notFound.statusCode, 400)

  const text = join(mkdtempSync(join(tmpdir(), 'fish-sticker-save-')), 'a.txt')
  writeFileSync(text, '不是图片')
  const fakeImage = await invoke(handlers, `${prefix}/stickers/save`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/save`, headers: jsonHeaders, body: { path: text },
  }))
  assert.equal(fakeImage.statusCode, 400)
  assert.match(JSON.parse(fakeImage.body).error, /仅支持/)

  const method = await invoke(handlers, `${prefix}/stickers/save`, makeRequest({ method: 'GET', url: `${prefix}/stickers/save` }))
  assert.equal(method.statusCode, 405)
})

test('/stickers/save：multipart 多图上传，标签/描述从表单读', async () => {
  const { store } = makeEnv()
  const { handlers } = makeRoutes(store)
  const boundary = '----fishboundary123'
  const payload = multipartBody(boundary, [
    { name: 'tags', data: '上传, 测试' },
    { name: 'desc', data: '多图' },
    { name: 'file1', filename: 'a.gif', type: 'image/gif', data: makeGif() },
    { name: 'file2', filename: 'b.png', type: 'image/png', data: smallPng },
  ])
  const parse = parseMultipart(payload, `multipart/form-data; boundary=${boundary}`)
  assert.equal(parse.files.length, 2)
  assert.equal(parse.fields.tags, '上传, 测试')

  const respond = await invoke(handlers, `${prefix}/stickers/save`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/save`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: payload,
  }))
  const result = JSON.parse(respond.body)
  assert.equal(respond.statusCode, 200)
  assert.equal(result.ok, true)
  assert.equal(result.count, 2)
  assert.equal(store.stats().count, 2)
  assert.deepEqual(store.list({ tag: '上传' }).items[0].tags, ['上传', '测试'])
})

test('/stickers/save：超上限 409，不静默删旧条目', async () => {
  const { store } = makeEnv({ stickerMaxCount: 1 })
  store.save(smallPng, { name: 'a.png' })
  const { handlers } = makeRoutes(store)
  const image = join(mkdtempSync(join(tmpdir(), 'fish-sticker-limit-')), 'b.gif')
  writeFileSync(image, makeGif())

  const respond = await invoke(handlers, `${prefix}/stickers/save`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/save`, headers: jsonHeaders, body: { path: image },
  }))
  assert.equal(respond.statusCode, 409)
  assert.equal(JSON.parse(respond.body).code, 'sticker_limit')
  assert.equal(store.stats().count, 1)
})

test('/stickers/update 与 /delete：id 校验、未知 id 404、删文件', async () => {
  const { store } = makeEnv()
  const entry = store.save(smallPng, { name: 'a.png', tags: ['旧'] }).entry
  const { handlers } = makeRoutes(store)

  const missingArg = await invoke(handlers, `${prefix}/stickers/update`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/update`, headers: jsonHeaders, body: {},
  }))
  assert.equal(missingArg.statusCode, 400)

  const change = await invoke(handlers, `${prefix}/stickers/update`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/update`, headers: jsonHeaders,
    body: { id: entry.id, tags: '#新标签', desc: '新描述' },
  }))
  assert.equal(change.statusCode, 200)
  assert.deepEqual(JSON.parse(change.body).entry.tags, ['新标签'])

  const unknown = await invoke(handlers, `${prefix}/stickers/update`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/update`, headers: jsonHeaders, body: { id: 'nope', tags: [] },
  }))
  assert.equal(unknown.statusCode, 404)

  const theDelete = await invoke(handlers, `${prefix}/stickers/delete`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/delete`, headers: jsonHeaders, body: { id: entry.id },
  }))
  assert.equal(theDelete.statusCode, 200)
  assert.equal(JSON.parse(theDelete.body).fileRemoved, true)
  assert.equal(store.stats().count, 0)

  const deleteAgain = await invoke(handlers, `${prefix}/stickers/delete`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/delete`, headers: jsonHeaders, body: { id: entry.id },
  }))
  assert.equal(deleteAgain.statusCode, 404)
})

test('/stickers/file：只读库目录内图片，路径穿越 403，非图片 415', async () => {
  const { dir, store } = makeEnv()
  const entry = store.save(makeGif(), { name: 'a.gif' }).entry
  mkdirSync(join(dir, 'img'), { recursive: true })
  writeFileSync(join(dir, 'img', '说明.txt'), '不是图片')
  const external = mkdtempSync(join(tmpdir(), 'fish-sticker-outside-'))
  const secret = join(external, 'secret.png')
  writeFileSync(secret, smallPng)
  const { handlers } = makeRoutes(store)

  const relative = await invoke(handlers, `${prefix}/stickers/file`, makeRequest({
    url: `${prefix}/stickers/file?path=${encodeURIComponent(entry.file)}`,
  }))
  assert.equal(relative.statusCode, 200)
  assert.equal(relative.headers['content-type'], 'image/gif')
  assert.deepEqual(relative.body, readFileSync(entry.path))

  const absolute = await invoke(handlers, `${prefix}/stickers/file`, makeRequest({
    url: `${prefix}/stickers/file?path=${encodeURIComponent(entry.path)}`,
  }))
  assert.equal(absolute.statusCode, 200)

  for (const badPath of ['../../secret.png', secret]) {
    const respond = await invoke(handlers, `${prefix}/stickers/file`, makeRequest({
      url: `${prefix}/stickers/file?path=${encodeURIComponent(badPath)}`,
    }))
    assert.equal(respond.statusCode, 403, `应拒绝 ${badPath}`)
    assert.notDeepEqual(respond.body, smallPng)
  }
  if (process.platform === 'win32') {
    const respond = await invoke(handlers, `${prefix}/stickers/file`, makeRequest({
      url: `${prefix}/stickers/file?path=${encodeURIComponent('..\\..\\secret.png')}`,
    }))
    assert.equal(respond.statusCode, 403)
  }

  const notImage = await invoke(handlers, `${prefix}/stickers/file`, makeRequest({
    url: `${prefix}/stickers/file?path=${encodeURIComponent('img/说明.txt')}`,
  }))
  assert.equal(notImage.statusCode, 415)

  const missingArg = await invoke(handlers, `${prefix}/stickers/file`, makeRequest({ url: `${prefix}/stickers/file` }))
  assert.equal(missingArg.statusCode, 400)

  const notStored = await invoke(handlers, `${prefix}/stickers/file`, makeRequest({
    url: `${prefix}/stickers/file?path=${encodeURIComponent('img/none.png')}`,
  }))
  assert.equal(notStored.statusCode, 404)
})

test('/stickers/send：参数校验、未知名字 404、成功调用 bridge', async () => {
  const { store } = makeEnv()
  const entry = store.save(makeGif(), { name: '晚安.gif', tags: ['晚安'] }).entry
  const { handlers, call } = makeRoutes(store)

  const missingArg = await invoke(handlers, `${prefix}/stickers/send`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/send`, headers: jsonHeaders, body: {},
  }))
  assert.equal(missingArg.statusCode, 400)

  const no = await invoke(handlers, `${prefix}/stickers/send`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/send`, headers: jsonHeaders, body: { name: '不存在' },
  }))
  assert.equal(no.statusCode, 404)

  const toBe = await invoke(handlers, `${prefix}/stickers/send`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/send`, headers: jsonHeaders,
    body: { qq: '10002', name: '#晚安', count: 2 },
  }))
  const result = JSON.parse(toBe.body)
  assert.equal(toBe.statusCode, 200)
  assert.equal(result.ok, true)
  assert.equal(result.qq, '10002')
  assert.equal(result.count, 2)
  assert.equal(result.sent, 2)
  assert.equal(call.length, 2)
  assert.equal(call[0].segments[0].data.stickerId, entry.id)

  const noBinding = makeRoutes(store, { getConfig: () => ({ bindings: [] }) })
  const respond = await invoke(noBinding.handlers, `${prefix}/stickers/send`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/send`, headers: jsonHeaders, body: { name: '#晚安' },
  }))
  assert.equal(respond.statusCode, 400)
  assert.equal(JSON.parse(respond.body).code, 'no_binding')
})

test('/stickers/recent 与 recent/file：最近入站图、文件名防穿越', async () => {
  const { inbox, store } = makeEnv()
  writeFileSync(join(inbox, 'qq-image-1-1-1.gif'), makeGif())
  writeFileSync(join(inbox, 'qq-image-2-1-2.png'), smallPng)
  writeFileSync(join(inbox, '无关.txt'), 'x')
  const { handlers } = makeRoutes(store)

  const column = await invoke(handlers, `${prefix}/stickers/recent`, makeRequest({ url: `${prefix}/stickers/recent` }))
  const result = JSON.parse(column.body)
  assert.equal(result.ok, true)
  assert.equal(result.count, 2)
  assert.ok(result.items.every((x) => x.name.startsWith('qq-image-')))

  const image = await invoke(handlers, `${prefix}/stickers/recent/file`, makeRequest({
    url: `${prefix}/stickers/recent/file?name=qq-image-1-1-1.gif`,
  }))
  assert.equal(image.statusCode, 200)
  assert.equal(image.headers['content-type'], 'image/gif')

  const traverse = await invoke(handlers, `${prefix}/stickers/recent/file`, makeRequest({
    url: `${prefix}/stickers/recent/file?name=${encodeURIComponent('../secret.png')}`,
  }))
  assert.equal(traverse.statusCode, 400)

  const missingArg = await invoke(handlers, `${prefix}/stickers/recent/file`, makeRequest({ url: `${prefix}/stickers/recent/file?name=none.gif` }))
  assert.equal(missingArg.statusCode, 404)
})

test('/stickers/open-folder：只开库目录、忽略请求路径、目录没了先建', async () => {
  const { dir, store } = makeEnv()
  const call = []
  const route = makeRoutes(store, {
    routeOptions: {
      platform: 'win32',
      spawn: (command, params, options) => {
        call.push({ command, params, options })
        return { on() {}, unref() {} }
      },
    },
  })

  const good = await invoke(route.handlers, `${prefix}/stickers/open-folder`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/open-folder`, headers: jsonHeaders,
    body: { path: 'C:\\Windows' },
  }))
  assert.equal(good.statusCode, 200)
  const real = realpathSync(store.dir)
  assert.equal(JSON.parse(good.body).path, real)
  assert.equal(call.length, 1)
  assert.equal(call[0].command, 'explorer.exe')
  assert.deepEqual(call[0].params, [real], '只开库目录，不认请求里的 path')
  assert.deepEqual(call[0].options, { detached: true, stdio: 'ignore' })

  rmSync(dir, { recursive: true, force: true })
  const build = await invoke(route.handlers, `${prefix}/stickers/open-folder`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/open-folder`, headers: jsonHeaders, body: {},
  }))
  assert.equal(build.statusCode, 200)
  assert.equal(existsSync(dir), true, '目录被删后先建回来')

  const wrongWay = await invoke(route.handlers, `${prefix}/stickers/open-folder`, makeRequest({
    url: `${prefix}/stickers/open-folder`,
  }))
  assert.equal(wrongWay.statusCode, 405)
})

test('/stickers/open-folder：非 Windows 与资源管理器启动失败都明确报错', async () => {
  const { store } = makeEnv()
  const not = makeRoutes(store, { routeOptions: { platform: 'linux' } })
  const unsupported = await invoke(not.handlers, `${prefix}/stickers/open-folder`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/open-folder`, headers: jsonHeaders, body: {},
  }))
  assert.equal(unsupported.statusCode, 501)
  assert.match(JSON.parse(unsupported.body).error, /Windows/)

  const bad = makeRoutes(store, {
    routeOptions: { platform: 'win32', spawn: () => { throw new Error('没有权限') } },
  })
  const failure = await invoke(bad.handlers, `${prefix}/stickers/open-folder`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/open-folder`, headers: jsonHeaders, body: {},
  }))
  assert.equal(failure.statusCode, 500)
  const payload = JSON.parse(failure.body)
  assert.equal(payload.code, 'open_failed')
  assert.match(payload.error, /资源管理器没能启动/)
  assert.match(payload.error, /手动打开/)
})

test('/stickers/import 与 /cleanup：导入去重、清理模式校验', async () => {
  const source = mkdtempSync(join(tmpdir(), 'fish-sticker-import-route-'))
  mkdirSync(join(source, 'gif'))
  writeFileSync(join(source, 'gif', 'a.gif'), makeGif())
  writeFileSync(join(source, 'index.json'), JSON.stringify({
    version: 1,
    stickers: [{ id: 'abc123def456', file: 'gif/a.gif', type: 'gif', tags: ['导入'], desc: '来导入' }],
  }))

  const { store } = makeEnv()
  const { handlers } = makeRoutes(store)

  const one = await invoke(handlers, `${prefix}/stickers/import`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/import`, headers: jsonHeaders, body: { dir: source },
  }))
  assert.equal(one.statusCode, 200)
  assert.equal(JSON.parse(one.body).imported, 1)

  const two = await invoke(handlers, `${prefix}/stickers/import`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/import`, headers: jsonHeaders, body: { dir: source },
  }))
  assert.equal(JSON.parse(two.body).merged, 1)

  const noIndex = await invoke(handlers, `${prefix}/stickers/import`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/import`, headers: jsonHeaders,
    body: { dir: mkdtempSync(join(tmpdir(), 'fish-sticker-empty-')) },
  }))
  assert.equal(noIndex.statusCode, 400)

  const badMode = await invoke(handlers, `${prefix}/stickers/cleanup`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/cleanup`, headers: jsonHeaders, body: { mode: '乱写' },
  }))
  assert.equal(badMode.statusCode, 400)

  const unused = await invoke(handlers, `${prefix}/stickers/cleanup`, makeRequest({
    method: 'POST', url: `${prefix}/stickers/cleanup`, headers: jsonHeaders, body: { mode: 'unused' },
  }))
  assert.equal(unused.statusCode, 200)
  assert.equal(JSON.parse(unused.body).removed, 1)
  assert.equal(store.stats().count, 0)
})
