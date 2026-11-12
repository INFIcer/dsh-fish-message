// 入站图片落盘：按内容 sha 命名，同一张图重复收到不堆副本；入库仍按 sha 合并。
//
// 全部离线：只用临时目录和手工拼的 PNG/GIF，不连 QQ、不连本地 AI。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VoiceService } from '../lib/voice.js'
import { StickerStore } from '../lib/stickers.js'
import { 造GIF, 小PNG } from './image-fixtures.js'

function 造环境() {
  const inbox = mkdtempSync(join(tmpdir(), 'fish-inbound-'))
  const dir = mkdtempSync(join(tmpdir(), 'fish-inbound-lib-'))
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  const voice = new VoiceService({
    getConfig: () => ({ maxImageMB: 10, maxVoiceMB: 10 }),
    logger,
    transport: { async download() { throw new Error('测试里不联网') } },
    inboxDir: inbox,
  })
  const 库 = new StickerStore({
    dir,
    inboxDir: inbox,
    logger,
    getConfig: () => ({ stickerMaxCount: 2000, stickerMaxMB: 1024 }),
  })
  return { inbox, 库, voice }
}

const 图段 = (buf) => ({ data: { file: 'base64://' + buf.toString('base64') } })

test('入站图片：同一张图收两次只落一份，入库一条并合并标签', async () => {
  const { inbox, 库, voice } = 造环境()
  const 一 = await voice.fetchImage(图段(小PNG), 'msg-a', 1)
  const 二 = await voice.fetchImage(图段(小PNG), 'msg-b', 2)

  assert.equal(一.path, 二.path, '同内容复用同一个路径')
  assert.match(一.path, /qq-image-[0-9a-f]{16}\.png$/, '文件名按内容寻址，扩展名取嗅探结果')
  assert.equal(
    readdirSync(inbox).filter((x) => x.startsWith('qq-image-')).length,
    1,
    '缓存目录只有一份',
  )

  const 首次 = 库.save(一.path, { source: 'qq-auto', tags: ['收到'] })
  const 再次 = 库.save(二.path, { source: 'qq-auto', tags: ['表情'] })
  assert.equal(首次.created, true)
  assert.equal(再次.created, false)
  assert.equal(再次.merged, true)
  assert.equal(库.stats().count, 1, '库里只一条')
  assert.deepEqual([...库.list({}).items[0].tags].sort(), ['收到', '表情'].sort())
  assert.equal(
    readdirSync(join(库.dir, 'img')).filter((x) => !x.endsWith('.tmp')).length,
    1,
    '库里只复制一份文件',
  )
  assert.equal(库.recentInbox().length, 1, '「最近收到的图片」也只一条')
})

test('入站图片：不同图片各落一份，清理仍认得 qq-image-*', async () => {
  const { inbox, 库, voice } = 造环境()
  const 甲 = await voice.fetchImage(图段(小PNG), 'msg-1', 1)
  const 乙 = await voice.fetchImage(图段(造GIF()), 'msg-2', 1)

  assert.notEqual(甲.path, 乙.path)
  assert.match(乙.path, /\.gif$/, '扩展名来自实际字节')
  assert.equal(readdirSync(inbox).length, 2)

  assert.equal(库.save(甲.path, {}).created, true)
  assert.equal(库.save(乙.path, {}).created, true)
  assert.equal(库.stats().count, 2)

  const 清 = 库.清理接收目录()
  assert.equal(清.removed, 2, '前缀保持 qq-image-*，清理逻辑照旧匹配')
  assert.deepEqual(readdirSync(inbox), [])
})
