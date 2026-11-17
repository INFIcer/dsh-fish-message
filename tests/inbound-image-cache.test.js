// 入站图片 + 收图图库：第一次只登记不识别，第二次起才补描述；命中次数按真实复用累计。
// 另覆盖命中缓存、借表情库描述、识图失败、旧条目兼容与总开关退回旧行为。
//
// 全部离线：假的本地 AI 服务 + 临时图库/表情库目录，真实走 Bridge.buildInbound。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '../lib/bridge.js'
import { StateStore } from '../lib/storage.js'
import { AiService } from '../lib/ai.js'
import { normalizeConfig } from '../lib/config.js'
import { ImageLibrary, hashBuffer } from '../lib/image-library.js'
import { VisionCache } from '../lib/vision-cache.js'
import { StickerStore } from '../lib/stickers.js'
import { smallPng } from './image-fixtures.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'fish-inbound-cache-'))
const QQ = '10001'
const session = 'session-test-0001'
const imageMessage = (id) => ({ message_id: id, message: [{ type: 'image', data: { file: 'a.png' } }] })

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

/** 假本地 AI 服务：形状按 fish.service 的公开契约。 */
class fakeVisionService {
  constructor({ text = '一只橘猫趴在键盘上', fail = false, visionPrefs } = {}) {
    this.text = text
    this.fail = fail
    this.visionPrefsResult = visionPrefs
    this.calls = { vision: [], prefs: 0 }
    this.capabilities = { vision: { available: true, ready: true }, tts: false, asr: false }
  }

  async visionPrefs() {
    this.calls.prefs += 1
    return this.visionPrefsResult
  }

  async visionDescribe(path, opts) {
    this.calls.vision.push({ path, opts })
    if (this.fail) return { ok: false, code: 'busy', hint: '本地 AI 正忙' }
    return { ok: true, items: [{ path, text: this.text }] }
  }
}

/**
 * 造一套入站环境：inbox 里有一张固定图片，图库与策略层都是真的，只有本地 AI 是假的。
 * service=null 表示没装本地 AI 插件。
 */
function makeEnv({ config = {}, service = null, libraryOptions = {}, preload = null, stickers = null } = {}) {
  const dir = tempDir()
  const imagePath = join(dir, 'qq.png')
  writeFileSync(imagePath, smallPng)
  const buffer = smallPng
  const sha256 = hashBuffer(buffer)

  const logger = silentLogger
  const cfg = normalizeConfig({
    bindings: [{ qq: QQ, session, name: '主人', enabled: true }],
    reorderBufferMs: 0,
    ...config,
  })
  const library = new ImageLibrary({ dir: join(dir, 'images'), logger, ...libraryOptions })
  // 预置图库内容：用于「命中缓存」「旧版留下的空描述条目」两类用例。
  if (preload) library.remember({ buffer, path: imagePath, ext: '.png', mime: 'image/png', ...preload })

  const ai = service ? new AiService({ getService: () => service, getConfig: () => ({}), logger }) : null
  const visionCache = new VisionCache({ library, ai, stickers, getConfig: () => cfg, logger })
  const bridge = new Bridge({
    getConfig: () => cfg,
    transport: { getStatus: () => ({ mode: 'http' }) },
    store: new StateStore({ homeDir: dir }),
    logger,
    voice: {
      async fetchImage() {
        return { buffer, base64: buffer.toString('base64'), mime: 'image/png', path: imagePath, ext: '.png' }
      },
    },
    delivery: { async deliver() { return { ok: true } }, async attachmentPath() { return '' } },
    ai,
    visionCache,
    autoTimers: false,
  })
  return { bridge, library, imagePath, sha256, cfg, dir }
}

test('命中收图图库：直接用上次的描述，回执写明来自收图图库', async () => {
  const service = new fakeVisionService({ text: '不该被调用' })
  const env = makeEnv({ config: { describeInboundImages: 'on' }, service, preload: { desc: '一只猫在键盘上睡觉', descSource: 'local' } })
  const content = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-cache-1'))

  assert.equal(content.images.length, 0, '命中缓存不附原图')
  assert.match(content.text, /一只猫在键盘上睡觉/)
  assert.match(content.text, /来自收图图库/, '回执要说明是收图图库，而不是笼统的「图库」')
  assert.doesNotMatch(content.text, /来自表情库/, '命中收图图库时不能提表情库')
  assert.match(content.text, /第 1 次见到/)
  assert.match(content.text, /首次识别于/)
  assert.equal(service.calls.vision.length, 0, '命中缓存不能再识图')
  assert.equal(env.library.lookup(env.sha256).hits, 1, '命中要记一次')

  // 老条目再出现一次：仍然只用缓存，命中次数继续累加。
  const again = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-cache-1b'))
  assert.match(again.text, /第 2 次见到/)
  assert.equal(env.library.lookup(env.sha256).hits, 2)
  assert.equal(service.calls.vision.length, 0)
})

test('命中缓存：没装本地 AI 也能用描述（图库不依赖识图服务）', async () => {
  const env = makeEnv({ config: { describeInboundImages: 'on' }, service: null, preload: { desc: '一只戴着墨镜的狗' } })
  const content = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-cache-2'))
  assert.equal(content.images.length, 0)
  assert.match(content.text, /一只戴着墨镜的狗/)
})

test('第一次收到（本地识图开）：只登记、不识图，原图照旧附给会话', async () => {
  const service = new fakeVisionService({ text: '不该被调用' })
  const env = makeEnv({ config: { describeInboundImages: 'on' }, service })
  const content = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-first-1'))

  assert.equal(service.calls.vision.length, 0, '第一次见到不能识图')
  assert.equal(content.images.length, 1, '没有描述就把原图交给会话')
  assert.match(content.text, /\[图片\]/)
  assert.match(content.text, /第一次见到/)
  assert.match(content.text, /这次先不识别/)
  assert.doesNotMatch(content.text, /fish_image_note/, '第一次不再要求补描述')

  const entry = env.library.lookup(env.sha256)
  assert.ok(entry, '第一次见到要登记，才能知道「第二次」')
  assert.equal(entry.desc, '')
  assert.equal(entry.descSource, 'deferred', '描述来源标成待识别')
  assert.equal(entry.misses, 1, '第一次见到记 misses')
  assert.equal(entry.hits, 0, '第一次见到不算命中')
  assert.ok(entry.file, '默认存原图，下次识图前也能回看')
  assert.equal(entry.width, 1, '入站登记时从字节头记下像素尺寸')
  assert.equal(entry.height, 1)
})

test('第一次收到（本地识图关）：只登记，正文直接看图、不再要求补描述', async () => {
  const service = new fakeVisionService({ text: '不该被调用' })
  const env = makeEnv({ config: { describeInboundImages: 'off' }, service })
  const content = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-first-2'))

  assert.equal(service.calls.vision.length, 0)
  assert.equal(content.images.length, 1)
  assert.match(content.text, /第一次见到/)
  assert.match(content.text, /这次直接看图/)
  assert.doesNotMatch(content.text, /fish_image_note/)

  const entry = env.library.lookup(env.sha256)
  assert.equal(entry.desc, '')
  assert.equal(entry.misses, 1)
  assert.equal(entry.hits, 0)
})

test('同一张图第二次（本地识图开）：识图一次、描述入库，第三次起走缓存', async () => {
  const service = new fakeVisionService({ text: '一只橘猫趴在键盘上' })
  const env = makeEnv({ config: { describeInboundImages: 'on' }, service })

  const first = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-second-1'))
  assert.equal(first.images.length, 1)
  assert.equal(service.calls.vision.length, 0, '第一次不识图')

  const second = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-second-2'))
  assert.equal(service.calls.vision.length, 1, '第二次才识图')
  assert.equal(second.images.length, 0, '有描述就不再附原图')
  assert.match(second.text, /一只橘猫趴在键盘上/)
  assert.match(second.text, /第 2 次见到/)
  assert.match(second.text, /已自动补上描述/)

  let entry = env.library.lookup(env.sha256)
  assert.equal(entry.desc, '一只橘猫趴在键盘上', '识图结果写进收图图库')
  assert.equal(entry.descSource, 'local')
  assert.equal(entry.hits, 1, '第二次见到算一次复用命中')
  assert.equal(entry.misses, 1)

  const third = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-second-3'))
  assert.equal(service.calls.vision.length, 1, '第三次直接命中缓存，不再识图')
  assert.equal(third.images.length, 0)
  assert.match(third.text, /来自收图图库/)
  assert.match(third.text, /第 3 次见到/)

  entry = env.library.lookup(env.sha256)
  assert.equal(entry.hits, 2)
  assert.equal(entry.misses, 1)
})

test('同一张图第二次（本地识图关）：不识别、记一次命中、原图照旧', async () => {
  const service = new fakeVisionService({ text: '不该被调用' })
  const env = makeEnv({ config: { describeInboundImages: 'off' }, service })

  const first = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-off-hit-1'))
  assert.equal(first.images.length, 1)
  assert.equal(service.calls.vision.length, 0)

  const second = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-off-hit-2'))
  assert.equal(service.calls.vision.length, 0, '本地识图关着就不能调识图')
  assert.equal(second.images.length, 1, '没有描述，原图照旧交给会话')
  assert.match(second.text, /第 2 次见到/)
  assert.match(second.text, /还没有描述/)
  assert.match(second.text, /这次直接看图/)
  assert.doesNotMatch(second.text, /fish_image_note/, '不再要求补描述')

  const entry = env.library.lookup(env.sha256)
  assert.equal(entry.desc, '')
  assert.equal(entry.hits, 1, '第二次见到记命中')
  assert.equal(entry.misses, 1, '首次的未命中保留')
})

test('计数不变式：第 N 次见到 = hits + misses，从 1 开始每次只 +1', async () => {
  const env = makeEnv({ config: { describeInboundImages: 'off' }, service: new fakeVisionService() })
  for (let n = 1; n <= 4; n += 1) {
    const content = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage(`m-count-${n}`))
    const entry = env.library.lookup(env.sha256)
    assert.equal(entry.hits + entry.misses, n, `第 ${n} 次见到时计数和应为 ${n}`)
    assert.equal(entry.misses, 1, '只有第一次见到记 misses')
    assert.equal(entry.hits, Math.max(0, n - 1), '之后每次见到记 hits')
    if (n === 1) assert.match(content.text, /第一次见到/)
    else assert.match(content.text, new RegExp(`第 ${n} 次见到`))
  }
})

test('图库里已有空描述条目（旧版遗留）：本地识图开着就补描述，记一次命中', async () => {
  const service = new fakeVisionService({ text: '一只橘猫趴在键盘上' })
  const env = makeEnv({ config: { describeInboundImages: 'on' }, service, preload: { desc: '' } })
  // 模拟旧策略留下的状态：见过一次，但没有描述。
  env.library.noteMiss(env.sha256)

  const content = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-empty-1'))
  assert.equal(service.calls.vision.length, 1, '已有条目缺描述，这次要补识别')
  assert.equal(content.images.length, 0)
  assert.match(content.text, /一只橘猫趴在键盘上/)
  assert.match(content.text, /第 2 次见到/)
  assert.match(content.text, /已自动补上描述/)

  const entry = env.library.lookup(env.sha256)
  assert.equal(entry.desc, '一只橘猫趴在键盘上', '识图结果补写进库')
  assert.equal(entry.descSource, 'local')
  assert.equal(entry.hits, 1)
  assert.equal(entry.misses, 1)
})

test('图库里已有空描述条目：本地识图关着就把原图交给会话，不再要求补描述', async () => {
  const service = new fakeVisionService({ text: '不该被调用' })
  const env = makeEnv({ config: { describeInboundImages: 'off' }, service, preload: { desc: '' } })
  env.library.noteMiss(env.sha256)

  const content = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-empty-2'))
  assert.equal(service.calls.vision.length, 0, '本地识图关着不能识图')
  assert.equal(content.images.length, 1, '这次只能把原图交给会话')
  assert.match(content.text, /\[图片\]/)
  assert.match(content.text, /第 2 次见到/)
  assert.match(content.text, /还没有描述/)
  assert.match(content.text, /这次直接看图/)
  assert.doesNotMatch(content.text, /fish_image_note/)

  const entry = env.library.lookup(env.sha256)
  assert.equal(entry.desc, '', '没有识图就不写描述')
  assert.equal(entry.hits, 1)
  assert.equal(entry.misses, 1)
})

test('缺描述 + 本地识图失败：第二次退回原图，命中照记，下次再试', async () => {
  const service = new fakeVisionService({ fail: true })
  const env = makeEnv({ config: { describeInboundImages: 'on' }, service })

  const first = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-fail-1'))
  assert.equal(first.images.length, 1, '第一次只登记，原图照旧')
  assert.equal(service.calls.vision.length, 0)

  const second = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-fail-2'))
  assert.equal(service.calls.vision.length, 1)
  assert.equal(second.images.length, 1, '识图失败要退回原图')
  assert.match(second.text, /第 2 次见到/)
  assert.match(second.text, /本地识图没成功/)
  assert.match(second.text, /本地 AI 正忙/, '失败原因要写进正文')

  const entry = env.library.lookup(env.sha256)
  assert.equal(entry.desc, '', '失败不写描述')
  assert.equal(entry.hits, 1, '这次也算见到一次，照样记命中')
  assert.equal(entry.misses, 1)
})

test('总开关关掉：完全退回旧行为，不查库也不写库', async () => {
  const service = new fakeVisionService({ text: '这次是现场识别的结果' })
  const env = makeEnv({
    config: { describeInboundImages: 'on', imageLibraryEnabled: false },
    service,
    preload: { desc: '图库里的旧描述（不该被用）' },
  })
  const content = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-off-1'))

  assert.equal(content.images.length, 0)
  assert.match(content.text, /这次是现场识别的结果/, '关掉图库就每次现场识图')
  assert.doesNotMatch(content.text, /来自收图图库|来自表情库/)
  const entry = env.library.lookup(env.sha256)
  assert.equal(entry.hits, 0, '关掉时不算命中')
  assert.equal(entry.desc, '图库里的旧描述（不该被用）', '关掉时不写库')
})

test('总开关关掉 + 本地识图也关：保持最老的行为（原图 + 路径，没有任何提醒）', async () => {
  const env = makeEnv({ config: { describeInboundImages: 'off', imageLibraryEnabled: false }, service: new fakeVisionService() })
  const content = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-off-2'))
  assert.equal(content.images.length, 1)
  assert.doesNotMatch(content.text, /fish_image_note|第一次见到|第 \d+ 次见到/)
  assert.equal(env.library.stats().count, 0, '关掉时什么都不写')
})

test('策略层：图库开着但没装本地 AI、也没缓存时，第一次只登记并直接看图', async () => {
  const env = makeEnv({ config: { describeInboundImages: 'on' }, service: null })
  const content = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-noai-1'))
  assert.equal(content.images.length, 1)
  assert.match(content.text, /第一次见到/)
  assert.match(content.text, /这次直接看图/)
  assert.doesNotMatch(content.text, /fish_image_note/)

  const entry = env.library.lookup(env.sha256)
  assert.equal(entry.desc, '')
  assert.equal(entry.misses, 1)
  assert.equal(entry.hits, 0)
})

/** 造一个真实表情库实例，并把这张图按「带描述的表情包」存进去。 */
function makeStickerStore(desc) {
  const dir = tempDir()
  const store = new StickerStore({ dir: join(dir, 'stickers'), getConfig: () => ({}), logger: silentLogger })
  store.save(smallPng, { desc })
  return store
}

test('收图图库命中但没有描述：采用表情库里的同图描述，回执标明表情库并写回图库', async () => {
  const service = new fakeVisionService({ text: '不该被调用' })
  const stickers = makeStickerStore('表情库里的描述：一只打哈欠的猫')
  const env = makeEnv({ config: { describeInboundImages: 'on' }, service, preload: { desc: '' }, stickers })
  // 模拟第一次登记过后留下的条目：见过一次、没有描述。
  env.library.noteMiss(env.sha256)
  const content = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-sticker-1'))

  assert.equal(content.images.length, 0, '拿到描述就不用再附原图')
  assert.match(content.text, /表情库里的描述：一只打哈欠的猫/)
  assert.match(content.text, /来自表情库/, '回执要说明描述来自表情库')
  assert.match(content.text, /第 2 次见到/)
  assert.doesNotMatch(content.text, /不该被调用/)
  assert.equal(service.calls.vision.length, 0, '有表情库描述就不必再识图')

  const entry = env.library.lookup(env.sha256)
  assert.equal(entry.desc, '表情库里的描述：一只打哈欠的猫', '描述要写回收图图库，下次直接命中缓存')
  assert.equal(entry.descSource, 'sticker')
  assert.equal(entry.hits, 1, '这次算一次复用命中')
  assert.equal(entry.misses, 1)
  assert.ok(entry.file, '收图图库是缓存，原图要跟着存一份')
})

test('收图图库未命中：表情库里有同图描述时直接采用，并收入收图图库', async () => {
  const service = new fakeVisionService({ text: '不该被调用' })
  const stickers = makeStickerStore('表情库里的描述：一张写着晚安的图')
  const env = makeEnv({ config: { describeInboundImages: 'on' }, service, stickers })
  const content = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-sticker-2'))

  assert.equal(content.images.length, 0)
  assert.match(content.text, /来自表情库/)
  assert.match(content.text, /第 1 次见到/)
  assert.match(content.text, /已收入收图图库/)
  assert.equal(service.calls.vision.length, 0)

  const entry = env.library.lookup(env.sha256)
  assert.ok(entry, '要收进收图图库')
  assert.equal(entry.desc, '表情库里的描述：一张写着晚安的图')
  assert.equal(entry.descSource, 'sticker')
  assert.equal(entry.hits, 1, '描述当场可用，这一次算命中')
  assert.equal(entry.misses, 0)
  assert.ok(entry.file, '原图一起存')
})

test('表情库抛错：安静退回原行为（再次见到缺描述就识图），不影响收消息', async () => {
  const broken = { bySha() { throw new Error('表情库索引坏了') } }
  const service = new fakeVisionService({ text: '这次是现场识别的结果' })
  const env = makeEnv({ config: { describeInboundImages: 'on' }, service, preload: { desc: '' }, stickers: broken })
  env.library.noteMiss(env.sha256)
  const content = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-sticker-broken'))

  assert.equal(content.images.length, 0)
  assert.match(content.text, /这次是现场识别的结果/, '表情库坏了也要照常识图')
  assert.doesNotMatch(content.text, /表情库/, '单子库出错时回执不冒充表情库来源')
  assert.equal(env.library.lookup(env.sha256).desc, '这次是现场识别的结果')
})

test('表情库抛错 + 本地识图关着：照样把原图交给会话，不要求补描述', async () => {
  const broken = { bySha() { throw new Error('表情库坏了') } }
  const env = makeEnv({ config: { describeInboundImages: 'off' }, stickers: broken })
  const content = await env.bridge.buildInbound({ qq: QQ, name: '主人' }, imageMessage('m-sticker-broken-2'))

  assert.equal(content.images.length, 1)
  assert.match(content.text, /第一次见到/)
  assert.match(content.text, /这次直接看图/)
  assert.doesNotMatch(content.text, /fish_image_note/)
})
