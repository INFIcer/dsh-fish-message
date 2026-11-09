// 表情库：入库/去重/搜索/标签/改名/删除/bump/上限/导入/GIF 保留，以及服务门面。
//
// 全部离线：只用临时目录和手工拼的 GIF/PNG，不连 QQ、不连 DSH。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  StickerError,
  StickerStore,
  规整标签,
  读图片信息,
} from '../lib/stickers.js'
import { 造GIF, 小PNG, 造大PNG } from './image-fixtures.js'
import { createFishMessageApi } from '../lib/service.js'
import { buildStickerToolDefinitions } from '../lib/tools.js'
import { Bridge } from '../lib/bridge.js'

function 造库(配置 = {}, 额外 = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fish-sticker-'))
  const 库 = new StickerStore({
    dir,
    getConfig: () => ({ stickerMaxCount: 2000, stickerMaxMB: 1024, ...配置 }),
    ...额外,
  })
  return { dir, 库 }
}

function 写临时图(buf, 名 = 'a.gif') {
  const dir = mkdtempSync(join(tmpdir(), 'fish-sticker-src-'))
  const 文件 = join(dir, 名)
  writeFileSync(文件, buf)
  return 文件
}

test('入库：复制进 gif/、字段完整、GIF 字节原样保留', () => {
  const { dir, 库 } = 造库()
  const gif = 造GIF({ width: 3, height: 4, frames: 2, delay: 15 })
  const 源 = 写临时图(gif, '猫猫.gif')
  const r = 库.save(源, { tags: ['猫', '可爱'], desc: '一只猫', source: '测试' })

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
  assert.equal(库.stats().count, 1)
})

test('去重：同 sha256 不复制新文件，只合并标签/描述', () => {
  const { dir, 库 } = 造库()
  const gif = 造GIF()
  const 第一次 = 库.save(gif, { name: 'a.gif', tags: ['猫'], desc: '旧的' })
  const 第二次 = 库.save(gif, { name: '换名.gif', tags: ['可爱', '猫'], desc: '新的' })

  assert.equal(第二次.created, false)
  assert.equal(第二次.merged, true)
  assert.equal(第二次.entry.id, 第一次.entry.id)
  assert.deepEqual(第二次.entry.tags, ['猫', '可爱'])
  // 已有描述不会被覆盖。
  assert.equal(第二次.entry.desc, '旧的')
  assert.equal(库.stats().count, 1)
  assert.equal(readdirSync(join(dir, 'gif')).length, 1)
})

test('搜索 / 标签 / id / 文件名 / 模糊名解析', () => {
  const { 库 } = 造库()
  const 思考 = 库.save(小PNG, { name: 'thinking.png', tags: ['思考', 'DeepSeek娘'], desc: '歪头思考' }).entry
  const 哈欠 = 库.save(造GIF(), { name: 'yawn.gif', tags: ['打哈欠', '起床'], desc: '打哈欠' }).entry

  assert.equal(库.list({ q: '歪头' }).total, 1)
  assert.equal(库.list({ q: '起床' }).total, 1)
  assert.equal(库.list({ tag: '#打哈欠' }).total, 1)
  assert.equal(库.list({ tag: 'DeepSeek娘' }).total, 1)
  assert.equal(库.list({}).total, 2)
  assert.equal(库.list({ limit: 1 }).items.length, 1)

  assert.equal(库.get(思考.id).id, 思考.id)
  assert.equal(库.get('thinking.png').id, 思考.id)
  assert.equal(库.get('thinking').id, 思考.id)
  assert.equal(库.get('#打哈欠').id, 哈欠.id)
  assert.equal(库.get('哈欠').id, 哈欠.id)
  assert.equal(库.get('完全不存在的表情'), null)
})

test('更新：标签/描述/改名，旧文件路径失效', () => {
  const { dir, 库 } = 造库()
  const 条目 = 库.save(小PNG, { name: 'a.png', tags: ['旧'] }).entry
  const 旧文件 = 条目.path

  const 改 = 库.update(条目.id, { tags: ['新', '标签'], desc: '新描述', name: '新名字.png' })
  assert.deepEqual(改.tags, ['新', '标签'])
  assert.equal(改.desc, '新描述')
  assert.equal(basename(改.file), '新名字.png')
  assert.notEqual(改.path, 旧文件)
  assert.equal(statSync(改.path).isFile(), true)
  assert.throws(() => statSync(旧文件), /ENOENT/)

  // 重名要报错，不覆盖（内容不同，避免被 sha 去重）。
  库.save(造大PNG(2048), { name: 'b.png' })
  assert.throws(() => 库.update(条目.id, { name: 'b.png' }), (error) => {
    assert.equal(error.code, 'sticker_bad_request')
    return true
  })
})

test('删除：默认删文件；removeFile=false 保留文件', () => {
  const { 库 } = 造库()
  const 甲 = 库.save(小PNG, { name: 'a.png' }).entry
  const 甲文件 = 甲.path
  库.delete(甲.id)
  assert.equal(库.get(甲.id), null)
  assert.throws(() => statSync(甲文件), /ENOENT/)
  assert.throws(() => 库.delete(甲.id), (error) => {
    assert.equal(error.code, 'sticker_not_found')
    return true
  })

  const 乙 = 库.save(造GIF(), { name: 'b.gif' }).entry
  const 乙文件 = 乙.path
  库.delete(乙.id, { removeFile: false })
  assert.equal(库.get(乙.id), null)
  assert.equal(statSync(乙文件).isFile(), true)
})

test('bump：用量与最近使用时间，列表按用量排序', () => {
  const { 库 } = 造库()
  const 甲 = 库.save(小PNG, { name: 'a.png' }).entry
  const 乙 = 库.save(造GIF(), { name: 'b.gif' }).entry

  库.bump(甲.id)
  库.bump(甲.id)
  const 后 = 库.bump(乙.id)

  assert.equal(库.get(甲.id).used_count, 2)
  assert.ok(库.get(甲.id).last_used_at)
  assert.equal(后.used_count, 1)
  const 列表 = 库.list({}).items
  assert.equal(列表[0].id, 甲.id)
  assert.equal(库.bump('不存在'), null)
})

test('上限：条数 / 总大小，超限明确报错且不落盘', () => {
  const 条数库 = 造库({ stickerMaxCount: 1 })
  条数库.库.save(小PNG, { name: 'a.png' })
  assert.throws(() => 条数库.库.save(造GIF(), { name: 'b.gif' }), (error) => {
    assert.ok(error instanceof StickerError)
    assert.equal(error.code, 'sticker_limit')
    assert.match(error.hint, /清理/)
    return true
  })
  assert.equal(条数库.库.stats().count, 1)
  assert.equal(readdirSync(join(条数库.dir, 'gif')).length, 0)

  const 大小库 = 造库({ stickerMaxMB: 1 })
  assert.throws(() => 大小库.库.save(造大PNG(1024 * 1024 + 1024), { name: 'big.png' }), (error) => {
    assert.equal(error.code, 'sticker_limit')
    return true
  })
  assert.equal(大小库.库.stats().count, 0)
})

test('导入：Python 表情库格式 → 本库字段，按 sha 去重，路径穿越拒绝', () => {
  const 源 = mkdtempSync(join(tmpdir(), 'fish-sticker-import-'))
  mkdirSync(join(源, 'gif'))
  mkdirSync(join(源, 'img'))
  const gif = 造GIF({ frames: 2, delay: 258 })
  const png = 小PNG
  writeFileSync(join(源, 'gif', 'sleep.gif'), gif)
  writeFileSync(join(源, 'img', 'art.png'), png)
  writeFileSync(join(源, 'index.json'), JSON.stringify({
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

  const { dir, 库 } = 造库()
  const 第一次 = 库.importFrom(源)
  assert.equal(第一次.ok, true)
  assert.equal(第一次.total, 3)
  assert.equal(第一次.imported, 2)
  assert.equal(第一次.skipped, 1)
  assert.match(第一次.errors[0].error, /跑出库目录/)

  const 睡 = 库.get('abc123def456')
  assert.equal(睡.type, 'gif')
  assert.equal(睡.file, 'gif/sleep.gif')
  assert.equal(睡.width, 180)
  assert.equal(睡.frames, 62)
  assert.equal(睡.duration_s, 5.16)
  assert.equal(睡.added_at, '2026-11-08T16:18:26')
  assert.equal(睡.source, 'QQ 主人发送')
  assert.deepEqual(readFileSync(join(dir, 'gif', 'sleep.gif')), gif)

  const 画 = 库.get('jpg000000001')
  assert.equal(画.type, 'img')
  assert.match(画.file, /^img\//)
  assert.equal(画.frames, undefined)

  const 第二次 = 库.importFrom(源)
  assert.equal(第二次.imported, 0)
  assert.equal(第二次.merged, 2)
  assert.equal(库.stats().count, 2)

  assert.throws(() => 库.importFrom(join(源, '不存在')), (error) => {
    assert.equal(error.code, 'sticker_bad_request')
    return true
  })
})

test('清理：删未使用、去重、清空最近图片（只删 qq-image-*）', () => {
  const inbox = mkdtempSync(join(tmpdir(), 'fish-sticker-inbox-'))
  writeFileSync(join(inbox, 'qq-image-1-1-1.gif'), 造GIF())
  writeFileSync(join(inbox, 'qq-image-2-1-2.png'), 小PNG)
  writeFileSync(join(inbox, '别删我.txt'), 'x')
  const { dir, 库 } = 造库({}, { inboxDir: inbox })
  const 甲 = 库.save(小PNG, { name: 'a.png' }).entry
  const 乙 = 库.save(造GIF(), { name: 'b.gif' }).entry
  库.bump(甲.id)

  const 未用 = 库.清理未使用()
  assert.equal(未用.removed, 1)
  assert.equal(库.stats().count, 1)
  assert.equal(库.get(乙.id), null)

  // 手工造一条重复 sha 的条目（正常 save 会去重），验证去重清理。
  const 索引文件 = join(dir, 'index.json')
  const 盘 = JSON.parse(readFileSync(索引文件, 'utf8'))
  const 复制 = { ...盘.stickers[0], id: 'dup000000001', file: 'img/dup.png' }
  writeFileSync(join(dir, 'img', 'dup.png'), 小PNG)
  盘.stickers.push(复制)
  writeFileSync(索引文件, JSON.stringify(盘))
  const 重开 = new StickerStore({ dir, getConfig: () => ({}) })
  assert.equal(重开.stats().count, 2)
  const 去重 = 重开.清理重复()
  assert.equal(去重.removed, 1)
  assert.equal(重开.stats().count, 1)

  const 最近 = 库.recentInbox(10)
  assert.equal(最近.length, 2)
  const 清 = 库.清理接收目录()
  assert.equal(清.removed, 2)
  assert.equal(readdirSync(inbox).includes('别删我.txt'), true)
})

test('标签与图片头解析：中文/分隔符/去重；PNG 尺寸', () => {
  assert.deepEqual(规整标签('猫, 可爱、#猫#新'), ['猫', '可爱', '新'])
  assert.deepEqual(规整标签(['  ', 'a', 'A']), ['a'])
  const 信息 = 读图片信息(小PNG)
  assert.equal(信息.type, 'img')
  assert.equal(信息.width, 1)
  assert.equal(信息.height, 1)
  assert.equal(读图片信息(Buffer.from('not an image')), null)
})

test('fish.message 服务：stickers.list/save/get/send 与错误码', async () => {
  const { 库 } = 造库()
  const 调用 = []
  const 桥 = {
    outbox: { pending: () => 0 },
    async sendOutbound(qq, 段们, 选项) {
      调用.push({ qq, 段们, 选项 })
      return { ok: true, sent: true, queued: false, pending: 0 }
    },
  }
  const api = createFishMessageApi({
    bridge: 桥,
    stickers: 库,
    getConfig: () => ({ bindings: [{ qq: '10001', enabled: true }] }),
  })
  assert.equal(api.capabilities().stickers, true)

  const 图 = 写临时图(造GIF(), 'wa.gif')
  const 存 = await api.stickers.save(图, { tags: ['晚安'], desc: '打哈欠' })
  assert.equal(存.ok, true)
  assert.equal(存.created, true)

  const 列表 = await api.stickers.list({ tag: '#晚安' })
  assert.equal(列表.total, 1)
  assert.equal(列表.items[0].id, 存.entry.id)

  const 取 = await api.stickers.get('wa')
  assert.equal(取.id, 存.entry.id)

  const 发 = await api.stickers.send('10001', '#晚安')
  assert.equal(发.sent, true)
  assert.equal(调用[0].qq, '10001')
  assert.equal(调用[0].段们[0].type, 'image')
  assert.equal(调用[0].段们[0].data.stickerId, 存.entry.id)

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

test('表情工具：fish_sticker_list / fish_sticker_send 注册、执行、不含 base64', async () => {
  const { 库 } = 造库()
  const 调用 = []
  const 桥 = {
    outbox: { pending: () => 0 },
    async sendOutbound(qq, 段们) {
      调用.push({ qq, 段们 })
      return { ok: true, sent: false, queued: true, pending: 1 }
    },
  }
  const api = createFishMessageApi({
    bridge: 桥,
    stickers: 库,
    getConfig: () => ({ bindings: [{ qq: '10001', enabled: true }] }),
  })
  库.save(造GIF(), { name: '晚安.gif', tags: ['晚安'] })

  const 定义 = buildStickerToolDefinitions({ api, getConfig: () => ({ bindings: [{ qq: '10001', enabled: true }] }) })
  assert.deepEqual(定义.map((x) => x.name), ['fish_sticker_list', 'fish_sticker_send'])

  const 列表 = await 定义[0].execute({ tag: '#晚安' })
  assert.equal(列表.ok, true)
  assert.equal(列表.total, 1)
  assert.equal(JSON.stringify(列表).includes('base64'), false)

  const 发 = await 定义[1].execute({ name: '晚安', count: 2 })
  assert.equal(发.ok, true)
  assert.equal(发.qq, '10001')
  assert.equal(发.count, 2)
  assert.equal(发.queued, true)
  assert.equal(调用.length, 2)
  assert.equal(JSON.stringify(发).includes('base64'), false)

  const 找不到 = await 定义[1].execute({ name: '不存在' })
  assert.equal(找不到.ok, false)
  assert.equal(找不到.code, 'fish_message_sticker_not_found')

  // 注册：宿主有 ctx.tools 时拿到两个定义，卸载时摘掉。
  const 注册表 = new Map()
  const ctx = {
    tools: {
      register(d) { 注册表.set(d.name, d); return () => 注册表.delete(d.name) },
    },
  }
  const { registerStickerTools } = await import('../lib/tools.js')
  const 停 = registerStickerTools(ctx, { api, getConfig: () => ({ bindings: [] }) })
  assert.deepEqual([...注册表.keys()], ['fish_sticker_list', 'fish_sticker_send'])
  停()
  assert.equal(注册表.size, 0)
})

test('Bridge：出站 [表情:…] 发图片段并 bump；找不到时只记错误不刷会话', async () => {
  const { 库 } = 造库()
  const 条目 = 库.save(造GIF(), { name: '晚安.gif', tags: ['晚安'] }).entry
  const 发出 = []
  const 通知 = []
  const 配置 = {
    bindings: [{ qq: '10001', session: 'session-b', name: '主人', enabled: true }],
    onlyInsideMarkers: true,
    maxImageMB: 10,
    reorderBufferMs: 0,
    autoSaveStickers: false,
  }
  const 错记录 = []
  const 存储 = {
    getWatermark: () => null,
    setWatermark() {},
    hasSeen: () => false,
    markSeen() {},
    noteError(文) { 错记录.push(String(文 || '')) },
    noteReceived() {},
    noteDelivered() {},
    recordEvent() {},
    save() {},
    snapshot: () => ({ watermarks: {}, stats: {}, recent: [] }),
  }
  const 出站 = { expire: () => 0, next: () => null, pending: () => 0, markSent: () => true }
  const 传输 = {
    getStatus: () => ({ mode: 'http', connected: false }),
    async sendMessage(qq, 段们) { 发出.push({ qq, 段们 }) },
    async fetchHistory() { return [] },
  }
  const 投递 = { async deliver(包) { 通知.push(包); return { ok: true } } }
  const voice = {
    async fetchImage() {
      const 目录 = mkdtempSync(join(tmpdir(), 'fish-sticker-inbound-'))
      const 路径 = join(目录, 'qq-image-1-1-1.gif')
      writeFileSync(路径, 造GIF({ frames: 3, delay: 5 }))
      return { base64: '', mime: 'image/gif', path: 路径, ext: '.gif' }
    },
  }
  const bridge = new Bridge({
    getConfig: () => 配置,
    transport: 传输,
    store: 存储,
    logger: null,
    voice,
    delivery: 投递,
    outbox: 出站,
    stickers: 库,
    autoTimers: false,
  })
  bridge.running = true

  await bridge.deliverAssistantTurn('session-b', '[QQ]看 [表情:晚安][/QQ]')
  assert.equal(发出.length, 2, '文字和表情各发一次')
  assert.equal(发出[0].qq, '10001')
  assert.equal(发出[0].段们[0].type, 'text')
  assert.equal(发出[1].段们[0].type, 'image')
  assert.match(发出[1].段们[0].data.file, /^base64:\/\//)
  assert.equal(库.get(条目.id).used_count, 1)

  await bridge.deliverAssistantTurn('session-b', '[QQ][表情:没有这个表情][/QQ]')
  assert.equal(发出.length, 2, '找不到时不应该发任何东西')
  assert.equal(通知.length, 0, '找不到表情时不再往会话里塞提示')
  assert.match(错记录.join('\n'), /找不到表情/)

  配置.autoSaveStickers = true
  const 入站 = await bridge.buildInbound(配置.bindings[0], {
    message_id: 'm1',
    message: [{ type: 'image', data: { url: 'http://example.com/a.gif' } }],
  })
  assert.equal(入站.images.length, 1)
  const 自动 = 库.get('qq-image-1-1-1')
  assert.ok(自动, '入站图片应自动入库')
  assert.equal(自动.source, 'qq-auto')
  assert.equal(库.stats().count, 2)
})
