// /open-folder：参数、越界、不存在、正常打开（spawn 用替身）与非 Windows 分支。
//
// 不启宿主：直接调 makeOpenFolderHandler() 返回的 handler。
// 所有测试目录都在系统临时目录；正常打开只记录 spawn 参数，不真的弹资源管理器。

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeOpenFolderHandler, insideDir } from '../lib/open-folder.js'

function makeRequest({ method = 'POST', body = undefined } = {}) {
  const req = new EventEmitter()
  req.method = method
  process.nextTick(() => {
    if (body !== undefined) {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    }
    req.emit('end')
  })
  return req
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v) },
    end(value) { this.body = String(value == null ? '' : value) },
  }
}

async function invoke(handler, request) {
  const res = fakeResponse()
  await handler(request, res)
  return { res, data: JSON.parse(res.body || '{}') }
}

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'fish-open-folder-'))
  const sticker = join(root, 'stickers')
  const receive = join(root, 'inbox')
  const outOfRange = join(root, 'outside')
  const looksLikePrefix = join(root, 'stickers-2')
  for (const dir of [sticker, receive, outOfRange, looksLikePrefix]) mkdirSync(dir)
  return { root, sticker, receive, outOfRange, looksLikePrefix }
}

function makeHandler(env, { platform = 'win32', spawnImpl = null } = {}) {
  const call = []
  const handler = makeOpenFolderHandler({
    allowedDirs: () => [env.sticker, env.receive],
    platform,
    spawn: (...params) => {
      call.push(params)
      if (spawnImpl) return spawnImpl(...params)
      return { on() {}, unref() {} }
    },
    logger: { warn() {} },
  })
  return { handler, call }
}

const env = makeEnv()

test('/open-folder：参数校验（缺路径、非字符串、相对路径、方法不对）', async () => {
  const { handler, call } = makeHandler(env)

  const empty = await invoke(handler, makeRequest({ body: {} }))
  assert.equal(empty.res.statusCode, 400)
  assert.match(empty.data.error, /请提供/)

  const notString = await invoke(handler, makeRequest({ body: { path: 123 } }))
  assert.equal(notString.res.statusCode, 400)

  const relative = await invoke(handler, makeRequest({ body: { path: 'stickers' } }))
  assert.equal(relative.res.statusCode, 400)
  assert.match(relative.data.error, /绝对路径/)

  const method = await invoke(handler, makeRequest({ method: 'GET', body: { path: env.sticker } }))
  assert.equal(method.res.statusCode, 405)

  assert.equal(call.length, 0)
})

test('/open-folder：路径不存在返回 400，不打开', async () => {
  const { handler, call } = makeHandler(env)
  const { res, data } = await invoke(handler, makeRequest({ body: { path: join(env.sticker, '不存在') } }))
  assert.equal(res.statusCode, 400)
  assert.equal(data.ok, false)
  assert.match(data.error, /不存在/)
  assert.equal(call.length, 0)
})

test('/open-folder：越界与 ../ 穿越返回 403，不打开', async () => {
  const { handler, call } = makeHandler(env)

  const outOfRange = await invoke(handler, makeRequest({ body: { path: env.outOfRange } }))
  assert.equal(outOfRange.res.statusCode, 403)
  assert.match(outOfRange.data.error, /只能打开/)

  const traverse = await invoke(handler, makeRequest({ body: { path: join(env.sticker, '..', 'outside') } }))
  assert.equal(traverse.res.statusCode, 403)

  // 前缀相似的兄弟目录不能误判为目录内。
  const looksLikePrefix = await invoke(handler, makeRequest({ body: { path: env.looksLikePrefix } }))
  assert.equal(looksLikePrefix.res.statusCode, 403)

  assert.equal(call.length, 0)
})

test('/open-folder：允许目录内正常打开，spawn 参数正确', async () => {
  const { handler, call } = makeHandler(env)
  const { res, data } = await invoke(handler, makeRequest({ body: { path: env.sticker } }))
  assert.equal(res.statusCode, 200)
  assert.equal(data.ok, true)
  assert.equal(data.path, realpathSync(env.sticker))

  assert.equal(call.length, 1)
  const [file, params, options] = call[0]
  assert.equal(file, 'explorer.exe')
  assert.deepEqual(params, [realpathSync(env.sticker)])
  assert.equal(options.detached, true)
  assert.equal(options.stdio, 'ignore')
})

test('/open-folder：允许目录内的单个文件也能定位', async () => {
  const { handler, call } = makeHandler(env)
  const file = join(env.sticker, 'a.png')
  writeFileSync(file, 'x')
  const { res, data } = await invoke(handler, makeRequest({ body: { path: file } }))
  assert.equal(res.statusCode, 200)
  assert.equal(data.ok, true)
  assert.equal(call.length, 1)
})

test('/open-folder：非 Windows 返回「暂不支持」', async () => {
  const { handler, call } = makeHandler(env, { platform: 'linux' })
  const { res, data } = await invoke(handler, makeRequest({ body: { path: env.sticker } }))
  assert.equal(res.statusCode, 501)
  assert.match(data.error, /Windows/)
  assert.equal(call.length, 0)
})

test('/open-folder：spawn 抛错时返回 500', async () => {
  const { handler } = makeHandler(env, {
    spawnImpl: () => { throw new Error('没有资源管理器') },
  })
  const { res, data } = await invoke(handler, makeRequest({ body: { path: env.sticker } }))
  assert.equal(res.statusCode, 500)
  assert.match(data.error, /打开失败/)
})

test('在目录内：根、子路径、前缀陷阱与大小写', () => {
  assert.equal(insideDir('/a/b', '/a/b', { ignoreCase: false }), true)
  assert.equal(insideDir('/a/b/c', '/a/b', { ignoreCase: false }), true)
  assert.equal(insideDir('/a/bc', '/a/b', { ignoreCase: false }), false)
  assert.equal(insideDir('C:\\A\\B\\C', 'c:\\a\\b', { ignoreCase: true }), true)
  assert.equal(insideDir('C:\\A\\BC', 'c:\\a\\b', { ignoreCase: true }), false)
  assert.equal(insideDir('', '/a/b'), false)
})

test('/open-folder：Windows 下大小写不同仍可打开', { skip: process.platform !== 'win32' }, async () => {
  const { handler, call } = makeHandler(env)
  const { res } = await invoke(handler, makeRequest({ body: { path: env.sticker.toUpperCase() } }))
  assert.equal(res.statusCode, 200)
  assert.equal(call.length, 1)
})
