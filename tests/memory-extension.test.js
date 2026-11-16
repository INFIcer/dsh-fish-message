// 记忆扩展：入站图片 / 语音与记忆图库、声纹库比对的开关、格式与降级行为。
//
// 全部离线：注入假的 memory.library 服务，不 import 记忆插件、不连本地 AI。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '../lib/bridge.js'
import { StateStore } from '../lib/storage.js'
import { normalizeConfig } from '../lib/config.js'
import { MemoryExtension, formatImageNote, formatVoiceNote } from '../lib/memory-extension.js'
import { smallPng } from './image-fixtures.js'

const QQ = '10001'
const session = 'session-test-0001'
const binding = { qq: QQ, name: '主人' }
const imageMessage = (id) => ({ message_id: id, message: [{ type: 'image', data: { file: 'a.png' } }] })
const voiceMessage = (id) => ({ message_id: id, message: [{ type: 'record', data: { file: 'a.silk' } }] })

function makeLogger() {
  const counts = { debug: 0, info: 0, warn: 0, error: 0 }
  return {
    counts,
    debug() { counts.debug += 1 },
    info() { counts.info += 1 },
    warn() { counts.warn += 1 },
    error() { counts.error += 1 },
  }
}

/** 假记忆服务：只实现鱼讯会调的两个只读方法，形状按记忆插件 v0.1 契约。 */
function fakeMemory({
  matchResult = { hit: false },
  identifyResult = { ok: true, best: null, matches: [] },
  matchThrows = false,
  identifyThrows = false,
} = {}) {
  const calls = { match: [], identify: [] }
  return {
    calls,
    images: {
      async match(input) {
        calls.match.push(input)
        if (matchThrows) throw new Error('记忆图库索引坏了')
        return matchResult
      },
    },
    voices: {
      async identify(input) {
        calls.identify.push(input)
        if (identifyThrows) throw new Error('声纹服务没起来')
        return identifyResult
      },
    },
  }
}

/** 造一套入站环境：图片与语音都落成临时文件，只有记忆服务是假的。 */
function makeEnv({ config = {}, memory, getMemory } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fish-memory-'))
  const imagePath = join(dir, 'qq.png')
  const wavPath = join(dir, 'qq.wav')
  writeFileSync(imagePath, smallPng)
  writeFileSync(wavPath, 'fake-wav')
  let memoryLookups = 0
  const lookup = typeof getMemory === 'function'
    ? getMemory
    : () => { memoryLookups += 1; return memory }
  const cfg = normalizeConfig({
    bindings: [{ qq: QQ, session, name: '主人', enabled: true }],
    reorderBufferMs: 0,
    memoryExtension: true,
    ...config,
  })
  const logger = makeLogger()
  const bridge = new Bridge({
    getConfig: () => cfg,
    transport: { getStatus: () => ({ mode: 'http' }) },
    store: new StateStore({ homeDir: dir }),
    logger,
    voice: {
      async fetchImage() {
        return { buffer: smallPng, base64: smallPng.toString('base64'), mime: 'image/png', path: imagePath, ext: '.png' }
      },
      async recordToFile() {
        return { wavPath, seconds: 2 }
      },
    },
    delivery: { async deliver() { return { ok: true } }, async attachmentPath() { return '' } },
    ai: null,
    memory: lookup,
    autoTimers: false,
  })
  return { bridge, cfg, logger, memory, wavPath, lookups: () => memoryLookups }
}

test('图片命中且有描述：正文追加描述与标签，只把字节交给记忆库', async () => {
  const memory = fakeMemory({
    matchResult: { hit: true, sha256: 'a'.repeat(64), entry: { desc: '一只橘猫趴在键盘上', tags: ['猫', '睡觉'] } },
  })
  const env = makeEnv({ memory })
  const content = await env.bridge.buildInbound(binding, imageMessage('m-hit-desc'))
  assert.match(content.text, /（记忆：一只橘猫趴在键盘上｜标签：猫、睡觉）/)
  assert.equal(memory.calls.match.length, 1)
  assert.ok(Buffer.isBuffer(memory.calls.match[0].buffer), '匹配只传字节，不发图')
})

test('图片命中但没有描述：正文说明图库里有图、还没写描述', async () => {
  const memory = fakeMemory({
    matchResult: { hit: true, sha256: 'b'.repeat(64), entry: { tags: ['主人'] } },
  })
  const env = makeEnv({ memory })
  const content = await env.bridge.buildInbound(binding, imageMessage('m-hit-nodesc'))
  assert.match(content.text, /（记忆：这张图在图库里〔标签：主人〕，还没写描述）/)
})

test('图片未命中：不追加记忆行，图片本身照常递', async () => {
  const memory = fakeMemory({ matchResult: { hit: false, sha256: 'c'.repeat(64) } })
  const env = makeEnv({ memory })
  const content = await env.bridge.buildInbound(binding, imageMessage('m-miss'))
  assert.match(content.text, /\[图片\]/)
  assert.doesNotMatch(content.text, /记忆：/)
})

test('记忆服务抛错：消息照常生成，不追加记忆行，也不刷 warn', async () => {
  const memory = fakeMemory({ matchThrows: true, identifyThrows: true })
  const env = makeEnv({ memory })
  const image = await env.bridge.buildInbound(binding, imageMessage('m-broken-img'))
  const voice = await env.bridge.buildInbound(binding, voiceMessage('m-broken-voice'))
  assert.match(image.text, /\[图片\]/)
  assert.match(voice.text, /（语音：.+\.wav，2 秒）/)
  assert.doesNotMatch(image.text + voice.text, /记忆：/)
  assert.equal(env.logger.counts.warn, 0, '抛错只记 debug，不刷 warn')
})

test('语音认出：追加声音来自谁与相似度，音频路径交给声纹库', async () => {
  const memory = fakeMemory({
    identifyResult: { ok: true, best: { name: '主人', score: 0.8266 }, matches: [] },
  })
  const env = makeEnv({ memory })
  const content = await env.bridge.buildInbound(binding, voiceMessage('m-voice-hit'))
  assert.match(content.text, /（记忆：声音来自主人，相似度 0\.83）/)
  assert.equal(memory.calls.identify.length, 1)
  assert.equal(memory.calls.identify[0].wavPath, env.wavPath)
})

test('语音认不出：只记日志，正文不加噪音', async () => {
  const memory = fakeMemory({ identifyResult: { ok: true, best: null, matches: [] } })
  const env = makeEnv({ memory })
  const content = await env.bridge.buildInbound(binding, voiceMessage('m-voice-miss'))
  assert.match(content.text, /（语音：.+\.wav，2 秒）/)
  assert.doesNotMatch(content.text, /记忆：/)
  assert.ok(env.logger.counts.debug >= 1)
})

test('声纹服务不可用：只跳过声纹比对，语音消息照常', async () => {
  const memory = fakeMemory({ identifyResult: { ok: false, code: 'memory_voice_service_unavailable' } })
  const env = makeEnv({ memory })
  const content = await env.bridge.buildInbound(binding, voiceMessage('m-voice-unavailable'))
  assert.match(content.text, /（语音：.+\.wav，2 秒）/)
  assert.doesNotMatch(content.text, /记忆：/)
})

test('总开关关掉：完全不取记忆服务，也不比对', async () => {
  const memory = fakeMemory({
    matchResult: { hit: true, entry: { desc: '不该出现' } },
    identifyResult: { ok: true, best: { name: '主人', score: 0.9 } },
  })
  const env = makeEnv({ memory, config: { memoryExtension: false } })
  const image = await env.bridge.buildInbound(binding, imageMessage('m-off-img'))
  const voice = await env.bridge.buildInbound(binding, voiceMessage('m-off-voice'))
  assert.doesNotMatch(image.text + voice.text, /记忆：/)
  assert.equal(env.lookups(), 0, '关掉时连记忆服务都不取')
  assert.equal(memory.calls.match.length, 0)
  assert.equal(memory.calls.identify.length, 0)
})

test('两个子开关各自关掉：只跳过对应的那一半', async () => {
  const imageOnlyMemory = fakeMemory({
    matchResult: { hit: true, entry: { desc: '记忆里的图' } },
    identifyResult: { ok: true, best: { name: '主人', score: 0.9 } },
  })
  const imageOnly = makeEnv({ memory: imageOnlyMemory, config: { memoryCompareVoices: false } })
  const image = await imageOnly.bridge.buildInbound(binding, imageMessage('m-sub-img'))
  await imageOnly.bridge.buildInbound(binding, voiceMessage('m-sub-voice-off'))
  assert.match(image.text, /记忆：记忆里的图/)
  assert.equal(imageOnlyMemory.calls.match.length, 1)
  assert.equal(imageOnlyMemory.calls.identify.length, 0, '关掉声纹就只跳语音')

  const voiceOnlyMemory = fakeMemory({
    matchResult: { hit: true, entry: { desc: '不该出现' } },
    identifyResult: { ok: true, best: { name: '主人', score: 0.9 } },
  })
  const voiceOnly = makeEnv({ memory: voiceOnlyMemory, config: { memoryCompareImages: false } })
  const plainImage = await voiceOnly.bridge.buildInbound(binding, imageMessage('m-sub-img-off'))
  const voice = await voiceOnly.bridge.buildInbound(binding, voiceMessage('m-sub-voice'))
  assert.doesNotMatch(plainImage.text, /记忆：/)
  assert.match(voice.text, /记忆：声音来自主人/)
  assert.equal(voiceOnlyMemory.calls.match.length, 0, '关掉图像就只跳图片')
  assert.equal(voiceOnlyMemory.calls.identify.length, 1)
})

test('记忆服务缺失：消息照常，不崩；只记一次 debug、不 warn', async () => {
  const env = makeEnv({ memory: undefined })
  const image = await env.bridge.buildInbound(binding, imageMessage('m-none-img'))
  const voice = await env.bridge.buildInbound(binding, voiceMessage('m-none-voice'))
  assert.match(image.text, /\[图片\]/)
  assert.match(voice.text, /（语音：.+\.wav，2 秒）/)
  assert.doesNotMatch(image.text + voice.text, /记忆：/)
  assert.equal(env.logger.counts.warn, 0)
  assert.equal(env.logger.counts.debug, 1, '服务缺失只记一次 debug，不刷屏')
})

test('取值函数自己抛错：同样吞掉，不影响收发', async () => {
  const env = makeEnv({ getMemory: () => { throw new Error('没有 memory.library 服务') } })
  const content = await env.bridge.buildInbound(binding, imageMessage('m-getter-throws'))
  assert.match(content.text, /\[图片\]/)
  assert.equal(env.logger.counts.warn, 0)
})

test('格式化：无标签、无分数时用降级写法', () => {
  assert.equal(formatImageNote({ desc: '一只猫', tags: [] }), '（记忆：一只猫）')
  assert.equal(formatImageNote({ desc: '', tags: [] }), '（记忆：这张图在图库里，还没写描述）')
  assert.equal(formatVoiceNote({ name: '主人' }), '（记忆：声音来自主人）')
  assert.equal(formatVoiceNote({}), '')
})

test('记忆服务不响应：超时后放弃比对，正文回到现状', async () => {
  const logger = makeLogger()
  const extension = new MemoryExtension({
    getService: () => ({ images: { match: () => new Promise(() => {}) } }),
    getConfig: () => ({ memoryExtension: true, memoryCompareImages: true }),
    logger,
    timeoutMs: 20,
  })
  assert.equal(await extension.imageNote(Buffer.from('x')), '')
  assert.ok(logger.counts.debug >= 1)
})
