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
import { makeOpenFolderHandler, 在目录内 } from '../lib/open-folder.js'

function 造请求({ method = 'POST', body = undefined } = {}) {
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

function 假响应() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v) },
    end(值) { this.body = String(值 == null ? '' : 值) },
  }
}

async function 调(handler, 请求) {
  const res = 假响应()
  await handler(请求, res)
  return { res, 数据: JSON.parse(res.body || '{}') }
}

function 造环境() {
  const 根 = mkdtempSync(join(tmpdir(), 'fish-open-folder-'))
  const 表情 = join(根, 'stickers')
  const 收件 = join(根, 'inbox')
  const 界外 = join(根, 'outside')
  const 像前缀 = join(根, 'stickers-2')
  for (const 目录 of [表情, 收件, 界外, 像前缀]) mkdirSync(目录)
  return { 根, 表情, 收件, 界外, 像前缀 }
}

function 造处理器(环境, { platform = 'win32', spawnImpl = null } = {}) {
  const 调用 = []
  const handler = makeOpenFolderHandler({
    允许目录们: () => [环境.表情, 环境.收件],
    platform,
    spawn: (...参数) => {
      调用.push(参数)
      if (spawnImpl) return spawnImpl(...参数)
      return { on() {}, unref() {} }
    },
    logger: { warn() {} },
  })
  return { handler, 调用 }
}

const 环境 = 造环境()

test('/open-folder：参数校验（缺路径、非字符串、相对路径、方法不对）', async () => {
  const { handler, 调用 } = 造处理器(环境)

  const 空 = await 调(handler, 造请求({ body: {} }))
  assert.equal(空.res.statusCode, 400)
  assert.match(空.数据.error, /请提供/)

  const 非字符串 = await 调(handler, 造请求({ body: { path: 123 } }))
  assert.equal(非字符串.res.statusCode, 400)

  const 相对 = await 调(handler, 造请求({ body: { path: 'stickers' } }))
  assert.equal(相对.res.statusCode, 400)
  assert.match(相对.数据.error, /绝对路径/)

  const 方法 = await 调(handler, 造请求({ method: 'GET', body: { path: 环境.表情 } }))
  assert.equal(方法.res.statusCode, 405)

  assert.equal(调用.length, 0)
})

test('/open-folder：路径不存在返回 400，不打开', async () => {
  const { handler, 调用 } = 造处理器(环境)
  const { res, 数据 } = await 调(handler, 造请求({ body: { path: join(环境.表情, '不存在') } }))
  assert.equal(res.statusCode, 400)
  assert.equal(数据.ok, false)
  assert.match(数据.error, /不存在/)
  assert.equal(调用.length, 0)
})

test('/open-folder：越界与 ../ 穿越返回 403，不打开', async () => {
  const { handler, 调用 } = 造处理器(环境)

  const 界外 = await 调(handler, 造请求({ body: { path: 环境.界外 } }))
  assert.equal(界外.res.statusCode, 403)
  assert.match(界外.数据.error, /只能打开/)

  const 穿越 = await 调(handler, 造请求({ body: { path: join(环境.表情, '..', 'outside') } }))
  assert.equal(穿越.res.statusCode, 403)

  // 前缀相似的兄弟目录不能误判为目录内。
  const 像前缀 = await 调(handler, 造请求({ body: { path: 环境.像前缀 } }))
  assert.equal(像前缀.res.statusCode, 403)

  assert.equal(调用.length, 0)
})

test('/open-folder：允许目录内正常打开，spawn 参数正确', async () => {
  const { handler, 调用 } = 造处理器(环境)
  const { res, 数据 } = await 调(handler, 造请求({ body: { path: 环境.表情 } }))
  assert.equal(res.statusCode, 200)
  assert.equal(数据.ok, true)
  assert.equal(数据.path, realpathSync(环境.表情))

  assert.equal(调用.length, 1)
  const [文件, 参数, 选项] = 调用[0]
  assert.equal(文件, 'explorer.exe')
  assert.deepEqual(参数, [realpathSync(环境.表情)])
  assert.equal(选项.detached, true)
  assert.equal(选项.stdio, 'ignore')
})

test('/open-folder：允许目录内的单个文件也能定位', async () => {
  const { handler, 调用 } = 造处理器(环境)
  const 文件 = join(环境.表情, 'a.png')
  writeFileSync(文件, 'x')
  const { res, 数据 } = await 调(handler, 造请求({ body: { path: 文件 } }))
  assert.equal(res.statusCode, 200)
  assert.equal(数据.ok, true)
  assert.equal(调用.length, 1)
})

test('/open-folder：非 Windows 返回「暂不支持」', async () => {
  const { handler, 调用 } = 造处理器(环境, { platform: 'linux' })
  const { res, 数据 } = await 调(handler, 造请求({ body: { path: 环境.表情 } }))
  assert.equal(res.statusCode, 501)
  assert.match(数据.error, /Windows/)
  assert.equal(调用.length, 0)
})

test('/open-folder：spawn 抛错时返回 500', async () => {
  const { handler } = 造处理器(环境, {
    spawnImpl: () => { throw new Error('没有资源管理器') },
  })
  const { res, 数据 } = await 调(handler, 造请求({ body: { path: 环境.表情 } }))
  assert.equal(res.statusCode, 500)
  assert.match(数据.error, /打开失败/)
})

test('在目录内：根、子路径、前缀陷阱与大小写', () => {
  assert.equal(在目录内('/a/b', '/a/b', { 忽略大小写: false }), true)
  assert.equal(在目录内('/a/b/c', '/a/b', { 忽略大小写: false }), true)
  assert.equal(在目录内('/a/bc', '/a/b', { 忽略大小写: false }), false)
  assert.equal(在目录内('C:\\A\\B\\C', 'c:\\a\\b', { 忽略大小写: true }), true)
  assert.equal(在目录内('C:\\A\\BC', 'c:\\a\\b', { 忽略大小写: true }), false)
  assert.equal(在目录内('', '/a/b'), false)
})

test('/open-folder：Windows 下大小写不同仍可打开', { skip: process.platform !== 'win32' }, async () => {
  const { handler, 调用 } = 造处理器(环境)
  const { res } = await 调(handler, 造请求({ body: { path: 环境.表情.toUpperCase() } }))
  assert.equal(res.statusCode, 200)
  assert.equal(调用.length, 1)
})
