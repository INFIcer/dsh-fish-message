// /stickers 路由：参数校验、multipart、发送、取图穿越防护、导入、清理。
//
// 不启宿主：直接拿 makeStickerRouteHandlers() 的「路径 → handler」，
// 用假 req/res 调；所有文件都在临时目录。

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StickerStore } from '../lib/stickers.js'
import { makeStickerRouteHandlers, 解析multipart } from '../lib/sticker-routes.js'
import { 造GIF, 小PNG } from './image-fixtures.js'

const 前缀 = '/dsh-fish-message'

function 造请求({ method = 'GET', url = '/', body = undefined, headers = {} } = {}) {
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

function 假响应() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v) },
    end(值) { this.body = 值 },
  }
}

async function 调(handlers, path, 请求) {
  const res = 假响应()
  const handler = handlers[path]
  assert.equal(typeof handler, 'function', `没有注册路由 ${path}`)
  await handler(请求, res)
  return res
}

const JSON头 = { 'content-type': 'application/json' }

function 造环境(配置 = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fish-sticker-route-'))
  const inbox = mkdtempSync(join(tmpdir(), 'fish-sticker-route-inbox-'))
  const 库 = new StickerStore({
    dir,
    inboxDir: inbox,
    getConfig: () => ({ stickerMaxCount: 2000, stickerMaxMB: 1024, ...配置 }),
  })
  return { dir, inbox, 库 }
}

function 造路由(库, 额外 = {}) {
  const 调用 = []
  const bridge = 额外.bridge ?? {
    async sendOutbound(qq, 段们, 选项) {
      调用.push({ qq, 段们, 选项 })
      return { ok: true, sent: true, queued: false, pending: 0 }
    },
  }
  const handlers = makeStickerRouteHandlers({
    stickers: 库,
    bridge,
    getConfig: 额外.getConfig ?? (() => ({ bindings: [{ qq: '10001', enabled: true }] })),
    路由前缀: 前缀,
    导入默认目录: join(tmpdir(), '不存在的默认导入目录'),
  })
  return { handlers, 调用 }
}

function multipart体(边界, parts) {
  const 段们 = []
  for (const p of parts) {
    段们.push(Buffer.from(
      `--${边界}\r\ncontent-disposition: form-data; name="${p.name}"`
      + `${p.filename ? `; filename="${p.filename}"` : ''}\r\n`
      + `${p.type ? `content-type: ${p.type}\r\n` : ''}\r\n`,
    ))
    段们.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data)))
    段们.push(Buffer.from('\r\n'))
  }
  段们.push(Buffer.from(`--${边界}--\r\n`))
  return Buffer.concat(段们)
}

test('/stickers：列表、搜索、limit 兜底、方法校验', async () => {
  const { 库 } = 造环境()
  库.save(小PNG, { name: 'thinking.png', tags: ['思考'] })
  库.save(造GIF(), { name: 'yawn.gif', tags: ['打哈欠'] })
  const { handlers } = 造路由(库)

  const 全 = await 调(handlers, `${前缀}/stickers`, 造请求({ url: `${前缀}/stickers` }))
  const 全体 = JSON.parse(全.body)
  assert.equal(全体.ok, true)
  assert.equal(全体.total, 2)
  assert.equal(全体.stats.count, 2)

  const 搜 = await 调(handlers, `${前缀}/stickers`, 造请求({ url: `${前缀}/stickers?q=%E6%80%9D%E8%80%83` }))
  assert.equal(JSON.parse(搜.body).total, 1)

  const 标签 = await 调(handlers, `${前缀}/stickers`, 造请求({ url: `${前缀}/stickers?tag=%23%E6%89%93%E5%93%88%E6%AC%A0` }))
  assert.equal(JSON.parse(标签.body).total, 1)

  const 坏 = await 调(handlers, `${前缀}/stickers`, 造请求({ url: `${前缀}/stickers?limit=abc` }))
  assert.equal(JSON.parse(坏.body).limit, 50)

  const 方法 = await 调(handlers, `${前缀}/stickers`, 造请求({ method: 'POST', url: `${前缀}/stickers` }))
  assert.equal(方法.statusCode, 405)
})

test('/stickers/save：JSON 路径入库与参数校验', async () => {
  const { 库 } = 造环境()
  const { handlers } = 造路由(库)
  const 图 = join(mkdtempSync(join(tmpdir(), 'fish-sticker-save-')), 'a.png')
  writeFileSync(图, 小PNG)

  const 成 = await 调(handlers, `${前缀}/stickers/save`, 造请求({
    method: 'POST', url: `${前缀}/stickers/save`, headers: JSON头,
    body: { path: 图, tags: '猫, 可爱', desc: '一只猫' },
  }))
  const 结果 = JSON.parse(成.body)
  assert.equal(成.statusCode, 200)
  assert.equal(结果.ok, true)
  assert.equal(结果.created, true)
  assert.deepEqual(结果.entry.tags, ['猫', '可爱'])

  const 缺 = await 调(handlers, `${前缀}/stickers/save`, 造请求({
    method: 'POST', url: `${前缀}/stickers/save`, headers: JSON头, body: {},
  }))
  assert.equal(缺.statusCode, 400)
  assert.equal(JSON.parse(缺.body).code, 'sticker_bad_request')

  const 不存在 = await 调(handlers, `${前缀}/stickers/save`, 造请求({
    method: 'POST', url: `${前缀}/stickers/save`, headers: JSON头,
    body: { path: join(tmpdir(), '没有这个文件.png') },
  }))
  assert.equal(不存在.statusCode, 400)

  const 文本 = join(mkdtempSync(join(tmpdir(), 'fish-sticker-save-')), 'a.txt')
  writeFileSync(文本, '不是图片')
  const 假图 = await 调(handlers, `${前缀}/stickers/save`, 造请求({
    method: 'POST', url: `${前缀}/stickers/save`, headers: JSON头, body: { path: 文本 },
  }))
  assert.equal(假图.statusCode, 400)
  assert.match(JSON.parse(假图.body).error, /仅支持/)

  const 方法 = await 调(handlers, `${前缀}/stickers/save`, 造请求({ method: 'GET', url: `${前缀}/stickers/save` }))
  assert.equal(方法.statusCode, 405)
})

test('/stickers/save：multipart 多图上传，标签/描述从表单读', async () => {
  const { 库 } = 造环境()
  const { handlers } = 造路由(库)
  const 边界 = '----fishboundary123'
  const 体 = multipart体(边界, [
    { name: 'tags', data: '上传, 测试' },
    { name: 'desc', data: '多图' },
    { name: 'file1', filename: 'a.gif', type: 'image/gif', data: 造GIF() },
    { name: 'file2', filename: 'b.png', type: 'image/png', data: 小PNG },
  ])
  const 解析 = 解析multipart(体, `multipart/form-data; boundary=${边界}`)
  assert.equal(解析.files.length, 2)
  assert.equal(解析.fields.tags, '上传, 测试')

  const 回 = await 调(handlers, `${前缀}/stickers/save`, 造请求({
    method: 'POST', url: `${前缀}/stickers/save`,
    headers: { 'content-type': `multipart/form-data; boundary=${边界}` },
    body: 体,
  }))
  const 结果 = JSON.parse(回.body)
  assert.equal(回.statusCode, 200)
  assert.equal(结果.ok, true)
  assert.equal(结果.count, 2)
  assert.equal(库.stats().count, 2)
  assert.deepEqual(库.list({ tag: '上传' }).items[0].tags, ['上传', '测试'])
})

test('/stickers/save：超上限 409，不静默删旧条目', async () => {
  const { 库 } = 造环境({ stickerMaxCount: 1 })
  库.save(小PNG, { name: 'a.png' })
  const { handlers } = 造路由(库)
  const 图 = join(mkdtempSync(join(tmpdir(), 'fish-sticker-limit-')), 'b.gif')
  writeFileSync(图, 造GIF())

  const 回 = await 调(handlers, `${前缀}/stickers/save`, 造请求({
    method: 'POST', url: `${前缀}/stickers/save`, headers: JSON头, body: { path: 图 },
  }))
  assert.equal(回.statusCode, 409)
  assert.equal(JSON.parse(回.body).code, 'sticker_limit')
  assert.equal(库.stats().count, 1)
})

test('/stickers/update 与 /delete：id 校验、未知 id 404、删文件', async () => {
  const { 库 } = 造环境()
  const 条目 = 库.save(小PNG, { name: 'a.png', tags: ['旧'] }).entry
  const { handlers } = 造路由(库)

  const 缺 = await 调(handlers, `${前缀}/stickers/update`, 造请求({
    method: 'POST', url: `${前缀}/stickers/update`, headers: JSON头, body: {},
  }))
  assert.equal(缺.statusCode, 400)

  const 改 = await 调(handlers, `${前缀}/stickers/update`, 造请求({
    method: 'POST', url: `${前缀}/stickers/update`, headers: JSON头,
    body: { id: 条目.id, tags: '#新标签', desc: '新描述' },
  }))
  assert.equal(改.statusCode, 200)
  assert.deepEqual(JSON.parse(改.body).entry.tags, ['新标签'])

  const 未知 = await 调(handlers, `${前缀}/stickers/update`, 造请求({
    method: 'POST', url: `${前缀}/stickers/update`, headers: JSON头, body: { id: 'nope', tags: [] },
  }))
  assert.equal(未知.statusCode, 404)

  const 删 = await 调(handlers, `${前缀}/stickers/delete`, 造请求({
    method: 'POST', url: `${前缀}/stickers/delete`, headers: JSON头, body: { id: 条目.id },
  }))
  assert.equal(删.statusCode, 200)
  assert.equal(JSON.parse(删.body).fileRemoved, true)
  assert.equal(库.stats().count, 0)

  const 再删 = await 调(handlers, `${前缀}/stickers/delete`, 造请求({
    method: 'POST', url: `${前缀}/stickers/delete`, headers: JSON头, body: { id: 条目.id },
  }))
  assert.equal(再删.statusCode, 404)
})

test('/stickers/file：只读库目录内图片，路径穿越 403，非图片 415', async () => {
  const { dir, 库 } = 造环境()
  const 条目 = 库.save(造GIF(), { name: 'a.gif' }).entry
  mkdirSync(join(dir, 'img'), { recursive: true })
  writeFileSync(join(dir, 'img', '说明.txt'), '不是图片')
  const 外部 = mkdtempSync(join(tmpdir(), 'fish-sticker-outside-'))
  const 秘密 = join(外部, 'secret.png')
  writeFileSync(秘密, 小PNG)
  const { handlers } = 造路由(库)

  const 相对 = await 调(handlers, `${前缀}/stickers/file`, 造请求({
    url: `${前缀}/stickers/file?path=${encodeURIComponent(条目.file)}`,
  }))
  assert.equal(相对.statusCode, 200)
  assert.equal(相对.headers['content-type'], 'image/gif')
  assert.deepEqual(相对.body, readFileSync(条目.path))

  const 绝对 = await 调(handlers, `${前缀}/stickers/file`, 造请求({
    url: `${前缀}/stickers/file?path=${encodeURIComponent(条目.path)}`,
  }))
  assert.equal(绝对.statusCode, 200)

  for (const 坏路径 of ['../../secret.png', 秘密]) {
    const 回 = await 调(handlers, `${前缀}/stickers/file`, 造请求({
      url: `${前缀}/stickers/file?path=${encodeURIComponent(坏路径)}`,
    }))
    assert.equal(回.statusCode, 403, `应拒绝 ${坏路径}`)
    assert.notDeepEqual(回.body, 小PNG)
  }
  if (process.platform === 'win32') {
    const 回 = await 调(handlers, `${前缀}/stickers/file`, 造请求({
      url: `${前缀}/stickers/file?path=${encodeURIComponent('..\\..\\secret.png')}`,
    }))
    assert.equal(回.statusCode, 403)
  }

  const 非图 = await 调(handlers, `${前缀}/stickers/file`, 造请求({
    url: `${前缀}/stickers/file?path=${encodeURIComponent('img/说明.txt')}`,
  }))
  assert.equal(非图.statusCode, 415)

  const 缺 = await 调(handlers, `${前缀}/stickers/file`, 造请求({ url: `${前缀}/stickers/file` }))
  assert.equal(缺.statusCode, 400)

  const 不存 = await 调(handlers, `${前缀}/stickers/file`, 造请求({
    url: `${前缀}/stickers/file?path=${encodeURIComponent('img/none.png')}`,
  }))
  assert.equal(不存.statusCode, 404)
})

test('/stickers/send：参数校验、未知名字 404、成功调用 bridge', async () => {
  const { 库 } = 造环境()
  const 条目 = 库.save(造GIF(), { name: '晚安.gif', tags: ['晚安'] }).entry
  const { handlers, 调用 } = 造路由(库)

  const 缺 = await 调(handlers, `${前缀}/stickers/send`, 造请求({
    method: 'POST', url: `${前缀}/stickers/send`, headers: JSON头, body: {},
  }))
  assert.equal(缺.statusCode, 400)

  const 无 = await 调(handlers, `${前缀}/stickers/send`, 造请求({
    method: 'POST', url: `${前缀}/stickers/send`, headers: JSON头, body: { name: '不存在' },
  }))
  assert.equal(无.statusCode, 404)

  const 成 = await 调(handlers, `${前缀}/stickers/send`, 造请求({
    method: 'POST', url: `${前缀}/stickers/send`, headers: JSON头,
    body: { qq: '10002', name: '#晚安', count: 2 },
  }))
  const 结果 = JSON.parse(成.body)
  assert.equal(成.statusCode, 200)
  assert.equal(结果.ok, true)
  assert.equal(结果.qq, '10002')
  assert.equal(结果.count, 2)
  assert.equal(结果.sent, 2)
  assert.equal(调用.length, 2)
  assert.equal(调用[0].段们[0].data.stickerId, 条目.id)

  const 无绑定 = 造路由(库, { getConfig: () => ({ bindings: [] }) })
  const 回 = await 调(无绑定.handlers, `${前缀}/stickers/send`, 造请求({
    method: 'POST', url: `${前缀}/stickers/send`, headers: JSON头, body: { name: '#晚安' },
  }))
  assert.equal(回.statusCode, 400)
  assert.equal(JSON.parse(回.body).code, 'no_binding')
})

test('/stickers/recent 与 recent/file：最近入站图、文件名防穿越', async () => {
  const { inbox, 库 } = 造环境()
  writeFileSync(join(inbox, 'qq-image-1-1-1.gif'), 造GIF())
  writeFileSync(join(inbox, 'qq-image-2-1-2.png'), 小PNG)
  writeFileSync(join(inbox, '无关.txt'), 'x')
  const { handlers } = 造路由(库)

  const 列 = await 调(handlers, `${前缀}/stickers/recent`, 造请求({ url: `${前缀}/stickers/recent` }))
  const 结果 = JSON.parse(列.body)
  assert.equal(结果.ok, true)
  assert.equal(结果.count, 2)
  assert.ok(结果.items.every((x) => x.name.startsWith('qq-image-')))

  const 图 = await 调(handlers, `${前缀}/stickers/recent/file`, 造请求({
    url: `${前缀}/stickers/recent/file?name=qq-image-1-1-1.gif`,
  }))
  assert.equal(图.statusCode, 200)
  assert.equal(图.headers['content-type'], 'image/gif')

  const 穿 = await 调(handlers, `${前缀}/stickers/recent/file`, 造请求({
    url: `${前缀}/stickers/recent/file?name=${encodeURIComponent('../secret.png')}`,
  }))
  assert.equal(穿.statusCode, 400)

  const 缺 = await 调(handlers, `${前缀}/stickers/recent/file`, 造请求({ url: `${前缀}/stickers/recent/file?name=none.gif` }))
  assert.equal(缺.statusCode, 404)
})

test('/stickers/import 与 /cleanup：导入去重、清理模式校验', async () => {
  const 源 = mkdtempSync(join(tmpdir(), 'fish-sticker-import-route-'))
  mkdirSync(join(源, 'gif'))
  writeFileSync(join(源, 'gif', 'a.gif'), 造GIF())
  writeFileSync(join(源, 'index.json'), JSON.stringify({
    version: 1,
    stickers: [{ id: 'abc123def456', file: 'gif/a.gif', type: 'gif', tags: ['导入'], desc: '来导入' }],
  }))

  const { 库 } = 造环境()
  const { handlers } = 造路由(库)

  const 一 = await 调(handlers, `${前缀}/stickers/import`, 造请求({
    method: 'POST', url: `${前缀}/stickers/import`, headers: JSON头, body: { dir: 源 },
  }))
  assert.equal(一.statusCode, 200)
  assert.equal(JSON.parse(一.body).imported, 1)

  const 二 = await 调(handlers, `${前缀}/stickers/import`, 造请求({
    method: 'POST', url: `${前缀}/stickers/import`, headers: JSON头, body: { dir: 源 },
  }))
  assert.equal(JSON.parse(二.body).merged, 1)

  const 没索引 = await 调(handlers, `${前缀}/stickers/import`, 造请求({
    method: 'POST', url: `${前缀}/stickers/import`, headers: JSON头,
    body: { dir: mkdtempSync(join(tmpdir(), 'fish-sticker-empty-')) },
  }))
  assert.equal(没索引.statusCode, 400)

  const 坏模式 = await 调(handlers, `${前缀}/stickers/cleanup`, 造请求({
    method: 'POST', url: `${前缀}/stickers/cleanup`, headers: JSON头, body: { mode: '乱写' },
  }))
  assert.equal(坏模式.statusCode, 400)

  const 未用 = await 调(handlers, `${前缀}/stickers/cleanup`, 造请求({
    method: 'POST', url: `${前缀}/stickers/cleanup`, headers: JSON头, body: { mode: 'unused' },
  }))
  assert.equal(未用.statusCode, 200)
  assert.equal(JSON.parse(未用.body).removed, 1)
  assert.equal(库.stats().count, 0)
})
