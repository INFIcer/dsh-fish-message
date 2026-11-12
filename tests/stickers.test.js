// 表情库：入库/去重/搜索/标签/改名/删除/bump/上限/导入/GIF 保留，以及服务门面。
//
// 全部离线：只用临时目录和手工拼的 GIF/PNG，不连 QQ、不连 DSH。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { basename, join } from 'node:path'
import {
  StickerError,
  StickerStore,
  normalizeTags,
  readPictureInfo,
} from '../lib/stickers.js'
import { makeGif, smallPng, makeLargePng } from './image-fixtures.js'
import { createFishMessageApi } from '../lib/service.js'
import { buildStickerToolDefinitions } from '../lib/tools.js'
import { Bridge } from '../lib/bridge.js'

function makeStore(config = {}, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fish-sticker-'))
  const store = new StickerStore({
    dir,
    getConfig: () => ({ stickerMaxCount: 2000, stickerMaxMB: 1024, ...config }),
    ...extra,
  })
  return { dir, store }
}

function writeTempImage(buf, name = 'a.gif') {
  const dir = mkdtempSync(join(tmpdir(), 'fish-sticker-src-'))
  const file = join(dir, name)
  writeFileSync(file, buf)
  return file
}

/** 最小 JSON Schema 校验：只覆盖工具用到的关键字，够把「声明字段」和「真实返回」对齐。 */
function validate(value, mode, path = '$') {
  if (mode.type) {
    const actual = Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value)
    const require = mode.type === 'integer' ? 'number' : mode.type
    assert.equal(actual, require, path + ' 类型应为 ' + mode.type + '，实际 ' + actual)
    if (mode.type === 'integer') assert.ok(Number.isInteger(value), path + ' 应为整数')
  }
  if (mode.enum) assert.ok(mode.enum.includes(value), path + ' 不在 enum 里：' + JSON.stringify(value))
  if (Array.isArray(value) && mode.items) {
    value.forEach((item, i) => validate(item, mode.items, path + '[' + i + ']'))
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && mode.type === 'object') {
    for (const key of mode.required || []) assert.ok(key in value, path + ' 缺少必填字段 ' + key)
    for (const key of Object.keys(value)) {
      const child = value[key]
      const submode = mode.properties?.[key]
      if (!submode) {
        assert.notEqual(mode.additionalProperties, false, path + '.' + key + ' 未在 schema 声明（additionalProperties:false 会拒掉整次调用）')
        if (mode.additionalProperties && typeof mode.additionalProperties === 'object') validate(child, mode.additionalProperties, path + '.' + key)
        continue
      }
      if (child === undefined) continue
      validate(child, submode, path + '.' + key)
    }
  }
}

function makeStickerApi(store, getConfig = () => ({})) {
  return createFishMessageApi({
    bridge: { outbox: { pending: () => 0 } },
    stickers: store,
    getConfig,
  })
}

function getTool(name, api, getConfig = () => ({})) {
  return buildStickerToolDefinitions({ api, getConfig }).find((x) => x.name === name)
}
test('入库：复制进 gif/、字段完整、GIF 字节原样保留', () => {
  const { dir, store } = makeStore()
  const gif = makeGif({ width: 3, height: 4, frames: 2, delay: 15 })
  const source = writeTempImage(gif, '猫猫.gif')
  const r = store.save(source, { tags: ['猫', '可爱'], desc: '一只猫', source: '测试' })

  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.equal(r.merged, false)
  assert.match(r.entry.file, /^gif\//)
  assert.equal(r.entry.type, 'gif')
  assert.equal(r.entry.width, 3)
  assert.equal(r.entry.height, 4)
  assert.equal(r.entry.frames, 2)
  assert.equal(r.entry.duration_s, 0.3)
  assert.deepEqual(r.entry.tags, ['猫', '可爱'])
  assert.equal(r.entry.desc, '一只猫')
  assert.equal(r.entry.used_count, 0)
  assert.ok(r.entry.sha256.length === 64)
  assert.ok(r.entry.path.endsWith(basename(r.entry.file)))

  // 文件按字节复制，动图不会被转码（GIF 保留）。
  assert.deepEqual(readFileSync(join(dir, 'gif', basename(r.entry.file))), gif)
  assert.ok(statSync(join(dir, 'index.json')).isFile())
  assert.equal(store.stats().count, 1)
})

test('去重：同 sha256 不复制新文件，只合并标签/描述', () => {
  const { dir, store } = makeStore()
  const gif = makeGif()
  const firstRun = store.save(gif, { name: 'a.gif', tags: ['猫'], desc: '旧的' })
  const secondRun = store.save(gif, { name: '换名.gif', tags: ['可爱', '猫'], desc: '新的' })

  assert.equal(secondRun.created, false)
  assert.equal(secondRun.merged, true)
  assert.equal(secondRun.entry.id, firstRun.entry.id)
  assert.deepEqual(secondRun.entry.tags, ['猫', '可爱'])
  // 已有描述不会被覆盖。
  assert.equal(secondRun.entry.desc, '旧的')
  assert.equal(store.stats().count, 1)
  assert.equal(readdirSync(join(dir, 'gif')).length, 1)
})

test('搜索 / 标签 / id / 文件名 / 模糊名解析', () => {
  const { store } = makeStore()
  const think = store.save(smallPng, { name: 'thinking.png', tags: ['思考', 'DeepSeek娘'], desc: '歪头思考' }).entry
  const yawn = store.save(makeGif(), { name: 'yawn.gif', tags: ['打哈欠', '起床'], desc: '打哈欠' }).entry

  assert.equal(store.list({ q: '歪头' }).total, 1)
  assert.equal(store.list({ q: '起床' }).total, 1)
  assert.equal(store.list({ tag: '#打哈欠' }).total, 1)
  assert.equal(store.list({ tag: 'DeepSeek娘' }).total, 1)
  assert.equal(store.list({}).total, 2)
  assert.equal(store.list({ limit: 1 }).items.length, 1)

  assert.equal(store.get(think.id).id, think.id)
  assert.equal(store.get('thinking.png').id, think.id)
  assert.equal(store.get('thinking').id, think.id)
  assert.equal(store.get('#打哈欠').id, yawn.id)
  assert.equal(store.get('哈欠').id, yawn.id)
  assert.equal(store.get('完全不存在的表情'), null)
})

test('更新：标签/描述/改名，旧文件路径失效', () => {
  const { dir, store } = makeStore()
  const entry = store.save(smallPng, { name: 'a.png', tags: ['旧'] }).entry
  const legacyFile = entry.path

  const change = store.update(entry.id, { tags: ['新', '标签'], desc: '新描述', name: '新名字.png' })
  assert.deepEqual(change.tags, ['新', '标签'])
  assert.equal(change.desc, '新描述')
  assert.equal(basename(change.file), '新名字.png')
  assert.notEqual(change.path, legacyFile)
  assert.equal(statSync(change.path).isFile(), true)
  assert.throws(() => statSync(legacyFile), /ENOENT/)

  // 重名要报错，不覆盖（内容不同，避免被 sha 去重）。
  store.save(makeLargePng(2048), { name: 'b.png' })
  assert.throws(() => store.update(entry.id, { name: 'b.png' }), (error) => {
    assert.equal(error.code, 'sticker_bad_request')
    return true
  })
})

test('删除：默认删文件；removeFile=false 保留文件', () => {
  const { store } = makeStore()
  const alpha = store.save(smallPng, { name: 'a.png' }).entry
  const alphaFile = alpha.path
  store.delete(alpha.id)
  assert.equal(store.get(alpha.id), null)
  assert.throws(() => statSync(alphaFile), /ENOENT/)
  assert.throws(() => store.delete(alpha.id), (error) => {
    assert.equal(error.code, 'sticker_not_found')
    return true
  })

  const beta = store.save(makeGif(), { name: 'b.gif' }).entry
  const betaFile = beta.path
  store.delete(beta.id, { removeFile: false })
  assert.equal(store.get(beta.id), null)
  assert.equal(statSync(betaFile).isFile(), true)
})

test('bump：用量与最近使用时间，列表按用量排序', () => {
  const { store } = makeStore()
  const alpha = store.save(smallPng, { name: 'a.png' }).entry
  const beta = store.save(makeGif(), { name: 'b.gif' }).entry

  store.bump(alpha.id)
  store.bump(alpha.id)
  const after = store.bump(beta.id)

  assert.equal(store.get(alpha.id).used_count, 2)
  assert.ok(store.get(alpha.id).last_used_at)
  assert.equal(after.used_count, 1)
  const list = store.list({}).items
  assert.equal(list[0].id, alpha.id)
  assert.equal(store.bump('不存在'), null)
})

test('上限：条数 / 总大小，超限明确报错且不落盘', () => {
  const itemNumberStore = makeStore({ stickerMaxCount: 1 })
  itemNumberStore.store.save(smallPng, { name: 'a.png' })
  assert.throws(() => itemNumberStore.store.save(makeGif(), { name: 'b.gif' }), (error) => {
    assert.ok(error instanceof StickerError)
    assert.equal(error.code, 'sticker_limit')
    assert.match(error.hint, /清理/)
    return true
  })
  assert.equal(itemNumberStore.store.stats().count, 1)
  assert.equal(readdirSync(join(itemNumberStore.dir, 'gif')).length, 0)

  const sizeStore = makeStore({ stickerMaxMB: 1 })
  assert.throws(() => sizeStore.store.save(makeLargePng(1024 * 1024 + 1024), { name: 'big.png' }), (error) => {
    assert.equal(error.code, 'sticker_limit')
    return true
  })
  assert.equal(sizeStore.store.stats().count, 0)
})

test('导入：Python 表情库格式 → 本库字段，按 sha 去重，路径穿越拒绝', () => {
  const source = mkdtempSync(join(tmpdir(), 'fish-sticker-import-'))
  mkdirSync(join(source, 'gif'))
  mkdirSync(join(source, 'img'))
  const gif = makeGif({ frames: 2, delay: 258 })
  const png = smallPng
  writeFileSync(join(source, 'gif', 'sleep.gif'), gif)
  writeFileSync(join(source, 'img', 'art.png'), png)
  writeFileSync(join(source, 'index.json'), JSON.stringify({
    version: 1,
    stickers: [
      {
        id: 'abc123def456',
        file: 'gif/sleep.gif',
        type: 'gif',
        size_kb: 999,
        width: 180,
        height: 180,
        frames: 62,
        duration_s: 5.16,
        sha256: '源里写的 sha 不可信',
        tags: ['睡觉', '打哈欠'],
        desc: '睡着打哈欠',
        source: 'QQ 主人发送',
        added_at: '2026-11-08T16:18:26',
      },
      {
        id: 'jpg000000001',
        file: 'img/art.png',
        type: 'jpg',
        width: 1,
        height: 1,
        tags: ['立绘'],
        desc: '立绘',
        source: '测试',
      },
      { id: 'evil00000001', file: '../evil.gif', type: 'gif', tags: [] },
    ],
  }))

  const { dir, store } = makeStore()
  const firstRun = store.importFrom(source)
  assert.equal(firstRun.ok, true)
  assert.equal(firstRun.total, 3)
  assert.equal(firstRun.imported, 2)
  assert.equal(firstRun.skipped, 1)
  assert.match(firstRun.errors[0].error, /超出表情库/)

  const sleep = store.get('abc123def456')
  assert.equal(sleep.type, 'gif')
  assert.equal(sleep.file, 'gif/sleep.gif')
  assert.equal(sleep.width, 180)
  assert.equal(sleep.frames, 62)
  assert.equal(sleep.duration_s, 5.16)
  assert.equal(sleep.added_at, '2026-11-08T16:18:26')
  assert.equal(sleep.source, 'QQ 主人发送')
  assert.deepEqual(readFileSync(join(dir, 'gif', 'sleep.gif')), gif)

  const draw = store.get('jpg000000001')
  assert.equal(draw.type, 'img')
  assert.match(draw.file, /^img\//)
  assert.equal(draw.frames, undefined)

  const secondRun = store.importFrom(source)
  assert.equal(secondRun.imported, 0)
  assert.equal(secondRun.merged, 2)
  assert.equal(store.stats().count, 2)

  assert.throws(() => store.importFrom(join(source, '不存在')), (error) => {
    assert.equal(error.code, 'sticker_bad_request')
    return true
  })
})

test('清理：删未使用、去重、清空最近图片（只删 qq-image-*）', () => {
  const inbox = mkdtempSync(join(tmpdir(), 'fish-sticker-inbox-'))
  writeFileSync(join(inbox, 'qq-image-1-1-1.gif'), makeGif())
  writeFileSync(join(inbox, 'qq-image-2-1-2.png'), smallPng)
  writeFileSync(join(inbox, '别删我.txt'), 'x')
  const { dir, store } = makeStore({}, { inboxDir: inbox })
  const alpha = store.save(smallPng, { name: 'a.png' }).entry
  const beta = store.save(makeGif(), { name: 'b.gif' }).entry
  store.bump(alpha.id)

  const unused = store.cleanupUnused()
  assert.equal(unused.removed, 1)
  assert.equal(store.stats().count, 1)
  assert.equal(store.get(beta.id), null)

  // 手工造一条重复 sha 的条目（正常 save 会去重），验证去重清理。
  const indexFile = join(dir, 'index.json')
  const disk = JSON.parse(readFileSync(indexFile, 'utf8'))
  const copy = { ...disk.stickers[0], id: 'dup000000001', file: 'img/dup.png' }
  writeFileSync(join(dir, 'img', 'dup.png'), smallPng)
  disk.stickers.push(copy)
  writeFileSync(indexFile, JSON.stringify(disk))
  const reopen = new StickerStore({ dir, getConfig: () => ({}) })
  assert.equal(reopen.stats().count, 2)
  const dedup = reopen.cleanupDuplicates()
  assert.equal(dedup.removed, 1)
  assert.equal(reopen.stats().count, 1)

  const recent = store.recentInbox(10)
  assert.equal(recent.length, 2)
  const clear = store.cleanupInbox()
  assert.equal(clear.removed, 2)
  assert.equal(readdirSync(inbox).includes('别删我.txt'), true)
})

test('清理过期缓存：只删过期的 qq-image-* / qq-voice-*，表情库与其它文件不动', () => {
  const inbox = mkdtempSync(join(tmpdir(), 'fish-inbox-ttl-'))
  const { dir, store } = makeStore({}, { inboxDir: inbox })
  const prevImage = join(inbox, 'qq-image-old.png')
  const prevVoice = join(inbox, 'qq-voice-old.wav')
  const nextImage = join(inbox, 'qq-image-new.png')
  const other = join(inbox, '别删我.txt')
  for (const path of [prevImage, prevVoice, nextImage]) writeFileSync(path, smallPng)
  writeFileSync(other, 'x')
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000)
  utimesSync(prevImage, thirtyDaysAgo, thirtyDaysAgo)
  utimesSync(prevVoice, thirtyDaysAgo, thirtyDaysAgo)

  // 表情库里的文件不能被当成缓存删掉。
  const entry = store.save(smallPng, { name: 'keep.png' }).entry
  const storeFile = join(dir, entry.file)

  const result = store.cleanupExpireCache(14 * 24 * 3600 * 1000)
  assert.equal(result.removed, 2)
  assert.ok(result.freedBytes > 0)
  assert.deepEqual(readdirSync(inbox).sort(), ['qq-image-new.png', '别删我.txt'].sort())
  assert.equal(existsSync(storeFile), true)
  assert.equal(store.stats().count, 1)

  // 保留期算错（0/负数）时什么都不删，避免误清空整个缓存。
  assert.equal(store.cleanupExpireCache(0).removed, 0)
  assert.equal(store.cleanupExpireCache(-1).removed, 0)
  assert.equal(readdirSync(inbox).length, 2)
})

test('标签与图片头解析：中文/分隔符/去重；PNG 尺寸', () => {
  assert.deepEqual(normalizeTags('猫, 可爱、#猫#新'), ['猫', '可爱', '新'])
  assert.deepEqual(normalizeTags(['  ', 'a', 'A']), ['a'])
  const info = readPictureInfo(smallPng)
  assert.equal(info.type, 'img')
  assert.equal(info.width, 1)
  assert.equal(info.height, 1)
  assert.equal(readPictureInfo(Buffer.from('not an image')), null)
})

test('fish.message 服务：stickers.list/save/get/send 与错误码', async () => {
  const { store } = makeStore()
  const call = []
  const bridge = {
    outbox: { pending: () => 0 },
    async sendOutbound(qq, segments, options) {
      call.push({ qq, segments, options })
      return { ok: true, sent: true, queued: false, pending: 0 }
    },
  }
  const api = createFishMessageApi({
    bridge: bridge,
    stickers: store,
    getConfig: () => ({ bindings: [{ qq: '10001', enabled: true }] }),
  })
  assert.equal(api.capabilities().stickers, true)

  const image = writeTempImage(makeGif(), 'wa.gif')
  const saved = await api.stickers.save(image, { tags: ['晚安'], desc: '打哈欠' })
  assert.equal(saved.ok, true)
  assert.equal(saved.created, true)

  const list = await api.stickers.list({ tag: '#晚安' })
  assert.equal(list.total, 1)
  assert.equal(list.items[0].id, saved.entry.id)

  const get = await api.stickers.get('wa')
  assert.equal(get.id, saved.entry.id)

  const send = await api.stickers.send('10001', '#晚安')
  assert.equal(send.sent, true)
  assert.equal(send.sticker.id, saved.entry.id, 'send 返回实际解析到的条目')
  assert.equal(call[0].qq, '10001')
  assert.equal(call[0].segments[0].type, 'image')
  assert.equal(call[0].segments[0].data.stickerId, saved.entry.id)

  await assert.rejects(() => api.stickers.get('根本没有'), (error) => {
    assert.equal(error.code, 'fish_message_sticker_not_found')
    assert.match(error.hint, /找不到表情/)
    return true
  })
  await assert.rejects(() => api.stickers.send('10001', '根本没有'), (error) => {
    assert.equal(error.code, 'fish_message_sticker_not_found')
    return true
  })
})

test('表情工具：fish_sticker_list / fish_sticker_send / fish_sticker_save 注册、执行、不含 base64', async () => {
  const { store } = makeStore()
  const call = []
  const bridge = {
    outbox: { pending: () => 0 },
    async sendOutbound(qq, segments) {
      call.push({ qq, segments })
      return { ok: true, sent: false, queued: true, pending: 1 }
    },
  }
  const api = createFishMessageApi({
    bridge: bridge,
    stickers: store,
    getConfig: () => ({ bindings: [{ qq: '10001', enabled: true }] }),
  })
  store.save(makeGif(), { name: '晚安.gif', tags: ['晚安'] })

  const definition = buildStickerToolDefinitions({ api, getConfig: () => ({ bindings: [{ qq: '10001', enabled: true }] }) })
  assert.deepEqual(definition.map((x) => x.name), ['fish_sticker_list', 'fish_sticker_send', 'fish_sticker_save'])

  const list = await definition[0].execute({ tag: '#晚安' })
  assert.equal(list.ok, true)
  assert.equal(list.total, 1)
  assert.equal(JSON.stringify(list).includes('base64'), false)

  const send = await definition[1].execute({ name: '晚安', count: 2 })
  assert.equal(send.ok, true)
  assert.equal(send.qq, '10001')
  assert.equal(send.count, 2)
  assert.equal(send.queued, true)
  assert.equal(call.length, 2)
  assert.equal(JSON.stringify(send).includes('base64'), false)

  // 标签命中多个时按用量轮换：返回的 id/file 必须是真正发出去的那条，而不是第一次解析的。
  store.save(makeGif({ frames: 5 }), { name: '晚安2.gif', tags: ['晚安'] })
  const actual = []
  const bridge2 = {
    outbox: { pending: () => 0 },
    async sendOutbound(qq, segments) {
      actual.push({ qq, segments })
      store.bump(segments[0].data.stickerId)
      return { ok: true, sent: true, queued: false, pending: 0 }
    },
  }
  const api2 = createFishMessageApi({
    bridge: bridge2,
    stickers: store,
    getConfig: () => ({ bindings: [{ qq: '10001', enabled: true }] }),
  })
  const definition2 = buildStickerToolDefinitions({ api: api2, getConfig: () => ({ bindings: [{ qq: '10001', enabled: true }] }) })
  const rotate = await definition2[1].execute({ name: '#晚安', count: 2 })
  assert.equal(rotate.ok, true)
  assert.equal(actual.length, 2)
  assert.notEqual(actual[0].segments[0].data.stickerId, actual[1].segments[0].data.stickerId, '按用量应轮到不同表情')
  assert.deepEqual(rotate.stickers.map((x) => x.id), actual.map((x) => x.segments[0].data.stickerId))
  assert.deepEqual(rotate.stickers.map((x) => x.file), actual.map((x) => store.get(x.segments[0].data.stickerId).file))

  const notFound = await definition[1].execute({ name: '不存在' })
  assert.equal(notFound.ok, false)
  assert.equal(notFound.code, 'fish_message_sticker_not_found')

  // 换一份字节不同的 GIF，避免命中前面那条的表情（同 sha256 会走去重）。
  const saved = await definition[2].execute({ path: writeTempImage(makeGif({ frames: 3 }), '存入.gif'), tags: ['入库'] })
  assert.equal(saved.ok, true)
  assert.equal(saved.created, true)
  assert.equal(saved.entry.source, 'agent')
  assert.equal(JSON.stringify(saved).includes('base64'), false)

  // 注册：宿主有 ctx.tools 时拿到两个定义，卸载时摘掉。
  const registerTable = new Map()
  const ctx = {
    tools: {
      register(d) { registerTable.set(d.name, d); return () => registerTable.delete(d.name) },
    },
  }
  const { registerStickerTools } = await import('../lib/tools.js')
  const stop = registerStickerTools(ctx, { api, getConfig: () => ({ bindings: [] }) })
  assert.deepEqual([...registerTable.keys()], ['fish_sticker_list', 'fish_sticker_send', 'fish_sticker_save'])
  stop()
  assert.equal(registerTable.size, 0)
})

test('Bridge：出站 [表情:…] 发图片段并 bump；找不到时只记错误不刷会话', async () => {
  const { store } = makeStore()
  const entry = store.save(makeGif(), { name: '晚安.gif', tags: ['晚安'] }).entry
  const emitted = []
  const notify = []
  const config = {
    bindings: [{ qq: '10001', session: 'session-b', name: '主人', enabled: true }],
    onlyInsideMarkers: true,
    maxImageMB: 10,
    reorderBufferMs: 0,
    autoSaveStickers: false,
  }
  const errorRecord = []
  const storage = {
    getWatermark: () => null,
    setWatermark() {},
    hasSeen: () => false,
    markSeen() {},
    noteError(str) { errorRecord.push(String(str || '')) },
    noteReceived() {},
    noteDelivered() {},
    recordEvent() {},
    save() {},
    snapshot: () => ({ watermarks: {}, stats: {}, recent: [] }),
  }
  const outbound = { expire: () => 0, next: () => null, pending: () => 0, markSent: () => true }
  const transport = {
    getStatus: () => ({ mode: 'http', connected: false }),
    async sendMessage(qq, segments) { emitted.push({ qq, segments }) },
    async fetchHistory() { return [] },
  }
  const deliver = { async deliver(thePackage) { notify.push(thePackage); return { ok: true } } }
  const voice = {
    async fetchImage() {
      const dir = mkdtempSync(join(tmpdir(), 'fish-sticker-inbound-'))
      const path = join(dir, 'qq-image-1-1-1.gif')
      writeFileSync(path, makeGif({ frames: 3, delay: 5 }))
      return { base64: '', mime: 'image/gif', path: path, ext: '.gif' }
    },
  }
  const bridge = new Bridge({
    getConfig: () => config,
    transport: transport,
    store: storage,
    logger: null,
    voice,
    delivery: deliver,
    outbox: outbound,
    stickers: store,
    autoTimers: false,
  })
  bridge.running = true

  await bridge.deliverAssistantTurn('session-b', '[QQ]看 [表情:晚安][/QQ]')
  assert.equal(emitted.length, 2, '文字和表情各发一次')
  assert.equal(emitted[0].qq, '10001')
  assert.equal(emitted[0].segments[0].type, 'text')
  assert.equal(emitted[1].segments[0].type, 'image')
  assert.match(emitted[1].segments[0].data.file, /^base64:\/\//)
  assert.equal(store.get(entry.id).used_count, 1)

  await bridge.deliverAssistantTurn('session-b', '[QQ][表情:没有这个表情][/QQ]')
  assert.equal(emitted.length, 2, '找不到时不应该发任何东西')
  assert.equal(notify.length, 0, '找不到表情时不再往会话里塞提示')
  assert.match(errorRecord.join('\n'), /找不到表情/)

  config.autoSaveStickers = true
  const inbound = await bridge.buildInbound(config.bindings[0], {
    message_id: 'm1',
    message: [{ type: 'image', data: { url: 'http://example.com/a.gif' } }],
  })
  assert.equal(inbound.images.length, 1)
  const auto = store.get('qq-image-1-1-1')
  assert.ok(auto, '入站图片应自动入库')
  assert.equal(auto.source, 'qq-auto')
  assert.equal(store.stats().count, 2)
})
test('fish_sticker_save：path 入库，中文标签/描述、默认 source=agent', async () => {
  const { store } = makeStore()
  const tool = getTool('fish_sticker_save', makeStickerApi(store), () => ({ stickerMaxFileMB: 1024 }))
  const gif = makeGif({ width: 5, height: 6, frames: 2, delay: 15 })
  const source = writeTempImage(gif, '大肥鱼.gif')

  const r = await tool.execute({ path: source, tags: ['大肥鱼', '动图'], desc: '大肥鱼的默认形象' })
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.equal(r.exists, false)
  assert.equal(r.merged, false)
  assert.equal(r.entry.file, 'gif/大肥鱼.gif')
  assert.equal(r.entry.type, 'gif')
  assert.equal(r.entry.width, 5)
  assert.equal(r.entry.height, 6)
  assert.equal(r.entry.frames, 2)
  assert.equal(r.entry.source, 'agent')
  assert.equal(r.entry.desc, '大肥鱼的默认形象')
  assert.deepEqual(r.entry.tags, ['大肥鱼', '动图'])
  assert.equal(r.entry.sha256.length, 64)
  assert.ok(r.entry.path.endsWith('大肥鱼.gif'))
  assert.equal(JSON.stringify(r).includes('base64'), false)
  validate(r, tool.output.schema)
  assert.equal(store.stats().count, 1)
})

test('fish_sticker_save：缺参 / 两个都给 / 路径不存在 / 相对路径 / 目录 / 名字带目录', async () => {
  const { store } = makeStore()
  const tool = getTool('fish_sticker_save', makeStickerApi(store))
  const source = writeTempImage(makeGif(), 'a.gif')

  const absent = await tool.execute({})
  assert.equal(absent.ok, false)
  assert.equal(absent.code, 'bad_request')
  assert.match(absent.hint, /path/)
  assert.match(absent.hint, /url/)

  const duplicate = await tool.execute({ path: source, url: 'http://example.com/a.gif' })
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.code, 'bad_request')

  const notFound = await tool.execute({ path: join(tmpdir(), '根本没有这个文件.gif') })
  assert.equal(notFound.code, 'bad_path')
  assert.match(notFound.hint, /找不到/)

  const relative = await tool.execute({ path: 'assets/a.gif' })
  assert.equal(relative.code, 'bad_path')

  const dir = await tool.execute({ path: tmpdir() })
  assert.equal(dir.code, 'bad_path')
  assert.match(dir.hint, /文件|目录/)

  const withDir = await tool.execute({ path: source, name: 'sub/a.gif' })
  assert.equal(withDir.ok, false)
  assert.equal(withDir.code, 'bad_request')

  assert.equal(store.stats().count, 0)
})

test('fish_sticker_save：非图片 → not_image，超单张上限 → too_large', async () => {
  const { store } = makeStore()
  const tool = getTool('fish_sticker_save', makeStickerApi(store))
  const notImage = writeTempImage(Buffer.from('这不是图片'), '假图.txt')
  const notImageResult = await tool.execute({ path: notImage })
  assert.equal(notImageResult.ok, false)
  assert.equal(notImageResult.code, 'not_image')
  assert.match(notImageResult.hint, /仅支持/)

  // 单张上限取 stickerMaxFileMB（不借用库总容量）：配成约 1KB 后，4KB 的图必须在读取前就被挡掉。
  const { store: smallStore } = makeStore()
  const smallTool = getTool('fish_sticker_save', makeStickerApi(smallStore), () => ({ stickerMaxFileMB: 0.001 }))
  const largeImage = writeTempImage(makeGif({ extraBytes: 4096 }), 'big.gif')
  const tooLarge = await smallTool.execute({ path: largeImage })
  assert.equal(tooLarge.ok, false)
  assert.equal(tooLarge.code, 'too_large')
  assert.match(tooLarge.hint, /单张上限/)
  assert.equal(smallStore.stats().count, 0)
})

test('fish_sticker_save：同 sha256 去重 → created=false，只合并标签、不覆盖描述与名字', async () => {
  const { store } = makeStore()
  const tool = getTool('fish_sticker_save', makeStickerApi(store))
  const source = writeTempImage(makeGif(), '旧名字.gif')

  const firstRun = await tool.execute({ path: source, tags: ['猫'], desc: '旧的' })
  assert.equal(firstRun.created, true)

  const secondRun = await tool.execute({ path: source, name: '新名字.gif', tags: ['可爱', '猫'], desc: '新的' })
  assert.equal(secondRun.ok, true)
  assert.equal(secondRun.created, false)
  assert.equal(secondRun.exists, true)
  assert.equal(secondRun.merged, true)
  assert.equal(secondRun.entry.id, firstRun.entry.id)
  assert.deepEqual(secondRun.entry.tags, ['猫', '可爱'])
  assert.equal(secondRun.entry.desc, '旧的')
  assert.equal(secondRun.entry.file, firstRun.entry.file)
  validate(secondRun, tool.output.schema)
  assert.equal(store.stats().count, 1)
})

test('fish_sticker_save：url 下载入库（本机 HTTP 夹具）', async () => {
  const gif = makeGif({ frames: 3, delay: 5 })
  const service = createServer((request, response) => {
    // fetch 会把中文路径百分号编码，这里解码后再比。
    if (decodeURIComponent(request.url) === '/emoji/开心.gif') {
      response.writeHead(200, { 'content-type': 'image/gif', 'content-length': gif.length })
      response.end(gif)
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
    }
  })
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve))
  const port = service.address().port
  try {
    const { store } = makeStore()
    const tool = getTool('fish_sticker_save', makeStickerApi(store))
    const r = await tool.execute({ url: 'http://127.0.0.1:' + port + '/emoji/开心.gif', tags: ['开心'] })
    assert.equal(r.ok, true)
    assert.equal(r.created, true)
    assert.equal(r.entry.file, 'gif/开心.gif')
    assert.equal(r.entry.frames, 3)
    validate(r, tool.output.schema)

    const cannotDownload = await tool.execute({ url: 'http://127.0.0.1:' + port + '/没有.gif' })
    assert.equal(cannotDownload.ok, false)
    assert.equal(cannotDownload.code, 'download_failed')
  } finally {
    await new Promise((resolve) => service.close(resolve))
  }
})

test('fish_sticker_list 输出能过 output.schema：真实条目 + 真实服务形状夹具', async () => {
  const { store } = makeStore()
  const api = makeStickerApi(store)
  store.save(makeGif({ frames: 2 }), { name: '动图.gif', tags: ['大肥鱼', '动图'], desc: '动图' })
  store.save(smallPng, { name: '静态.png', tags: ['大肥鱼'] })

  const tool = getTool('fish_sticker_list', api)
  const result = await tool.execute({ limit: 10 })
  assert.equal(result.ok, true)
  assert.equal(result.items.length, 2)
  validate(result, tool.output.schema)

  // 夹具的字段直接照本机 /dsh-fish-message/stickers?limit=1 的真实返回抄（含 sha256/source/path），
  // 顶层按工具实际返回裁剪（工具只回 count/total/items/tags/stats）。
  const fixture = {
    ok: true,
    count: 1,
    total: 8,
    items: [{
      id: '9efadc3fd79f',
      file: 'gif/dschan_thumbs-up.gif',
      type: 'gif',
      sha256: '9efadc3fd79f9b70fb3c11628ec1de599b9e65dae17fb6518d38c249ca2e3d75',
      size_kb: 2956,
      width: 500,
      height: 500,
      frames: 13,
      duration_s: 0.39,
      tags: ['点赞', '竖大拇指', '大肥鱼', 'DeepSeek娘', '动图'],
      desc: 'Q版大肥鱼竖大拇指点赞',
      source: 'GitHub BrickAZ/deepseek-chan-emotes（非商业二创）',
      added_at: '2026-11-08T16:22:33',
      used_count: 2,
      last_used_at: '2026-11-09T13:42:55',
      path: 'C:\\Users\\Administrator\\.dsh\\fish-message-stickers\\gif\\dschan_thumbs-up.gif',
    }],
    tags: [{ tag: '大肥鱼', count: 7 }],
    stats: {
      count: 8,
      maxCount: 2000,
      totalBytes: 20280852,
      sizeMB: 19.3,
      maxMB: 1024,
      used: 1,
      unused: 7,
      dir: 'C:\\Users\\Administrator\\.dsh\\fish-message-stickers',
      indexPath: 'C:\\Users\\Administrator\\.dsh\\fish-message-stickers\\index.json',
    },
  }
  validate(fixture, tool.output.schema)

  // 反证：返回里多一个没声明的字段，校验必须失败——原来的 bug 就是这么被拒的。
  const multiField = { ...fixture, items: [{ ...fixture.items[0], unknownField: 1 }] }
  assert.throws(() => validate(multiField, tool.output.schema))
})
