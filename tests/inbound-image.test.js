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
import { makeGif, smallPng } from './image-fixtures.js'

function makeEnv() {
  const inbox = mkdtempSync(join(tmpdir(), 'fish-inbound-'))
  const dir = mkdtempSync(join(tmpdir(), 'fish-inbound-lib-'))
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  const voice = new VoiceService({
    getConfig: () => ({ maxImageMB: 10, maxVoiceMB: 10 }),
    logger,
    transport: { async download() { throw new Error('测试里不联网') } },
    inboxDir: inbox,
  })
  const store = new StickerStore({
    dir,
    inboxDir: inbox,
    logger,
    getConfig: () => ({ stickerMaxCount: 2000, stickerMaxMB: 1024 }),
  })
  return { inbox, store, voice }
}

const imageSegment = (buf) => ({ data: { file: 'base64://' + buf.toString('base64') } })

test('入站图片：同一张图收两次只落一份，入库一条并合并标签', async () => {
  const { inbox, store, voice } = makeEnv()
  const one = await voice.fetchImage(imageSegment(smallPng), 'msg-a', 1)
  const two = await voice.fetchImage(imageSegment(smallPng), 'msg-b', 2)

  assert.equal(one.path, two.path, '同内容复用同一个路径')
  assert.match(one.path, /qq-image-[0-9a-f]{16}\.png$/, '文件名按内容寻址，扩展名取嗅探结果')
  assert.equal(
    readdirSync(inbox).filter((x) => x.startsWith('qq-image-')).length,
    1,
    '缓存目录只有一份',
  )

  const firstSave = store.save(one.path, { source: 'qq-auto', tags: ['收到'] })
  const secondSave = store.save(two.path, { source: 'qq-auto', tags: ['表情'] })
  assert.equal(firstSave.created, true)
  assert.equal(secondSave.created, false)
  assert.equal(secondSave.merged, true)
  assert.equal(store.stats().count, 1, '库里只一条')
  assert.deepEqual([...store.list({}).items[0].tags].sort(), ['收到', '表情'].sort())
  assert.equal(
    readdirSync(join(store.dir, 'img')).filter((x) => !x.endsWith('.tmp')).length,
    1,
    '库里只复制一份文件',
  )
  assert.equal(store.recentInbox().length, 1, '「最近收到的图片」也只一条')
})

test('入站图片：不同图片各落一份，清理仍认得 qq-image-*', async () => {
  const { inbox, store, voice } = makeEnv()
  const alpha = await voice.fetchImage(imageSegment(smallPng), 'msg-1', 1)
  const beta = await voice.fetchImage(imageSegment(makeGif()), 'msg-2', 1)

  assert.notEqual(alpha.path, beta.path)
  assert.match(beta.path, /\.gif$/, '扩展名来自实际字节')
  assert.equal(readdirSync(inbox).length, 2)

  assert.equal(store.save(alpha.path, {}).created, true)
  assert.equal(store.save(beta.path, {}).created, true)
  assert.equal(store.stats().count, 2)

  const clear = store.cleanupInbox()
  assert.equal(clear.removed, 2, '前缀保持 qq-image-*，清理逻辑照旧匹配')
  assert.deepEqual(readdirSync(inbox), [])
})
