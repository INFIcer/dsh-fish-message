import test from 'node:test'
import assert from 'node:assert/strict'
import { AiService, friendlyHint, capabilityStatus, emotionText, backgroundText } from '../lib/ai.js'
import { normalizeConfig, defaultImagePrompt, inboundImagePrompt, imagePromptMaxLength } from '../lib/config.js'
import { voiceSegmentMaxLength } from '../lib/split-voice-text.js'

function makeService(patch = {}) {
  return {
    capabilities: {
      tts: { available: true, ready: true },
      asr: { available: true, ready: true },
      vision: { available: true, ready: true },
    },
    async tts(text, opts) {
      return { ok: true, items: [{ wavPath: 'C:/cache/a.wav', voice: opts?.voice, ms: 1 }] }
    },
    async asr(path, opts) {
      return { ok: true, items: [{ text: '听清楚了', language: opts?.language }] }
    },
    async visionDescribe(path, opts) {
      return { ok: true, items: [{ path, text: '一张桌子的照片', ms: 1 }] }
    },
    async voices() {
      return [{ name: 'dafeiyu' }, { name: 'test_voice' }, { name: 'dafeiyu' }]
    },
    ...patch,
  }
}

const build = (getService, logger = null) => new AiService({ getService, getConfig: () => ({}), logger })

test('本地 AI：没装服务时所有能力都判不可用，提示是人话', async () => {
  const ai = build(() => null)
  const status = ai.status()
  assert.equal(status.installed, false)
  assert.equal(status.online, false)
  assert.match(status.hint, /本地 AI 插件没装或没启动/)

  const synthesize = await ai.tts('晚安')
  assert.equal(synthesize.ok, false)
  assert.equal(synthesize.code, 'service_not_installed')
  assert.match(synthesize.hint, /其它功能不受影响/)

  const transcribe = await ai.asr('C:/a.wav')
  assert.equal(transcribe.ok, false)
  assert.equal(transcribe.code, 'service_not_installed')

  const voice = await ai.listVoices()
  assert.deepEqual(voice.voices, [])
  assert.equal(voice.ok, false)
})

test('本地 AI：服务在但能力标成不可用时，按原因降级而不是抛错', async () => {
  const service = makeService({
    capabilities: { tts: { available: false, ready: false, reason: 'model_missing' } },
  })
  const ai = build(() => service)
  assert.equal(ai.status().tts, false)
  assert.equal(ai.status().online, true, '语音不可用不影响识别可用')

  const result = await ai.tts('晚安')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'model_missing')
  assert.match(result.hint, /语音模型还没准备好/)
})

test('本地 AI：visionDescribe 不存在时识图算不可用', async () => {
  const service = makeService()
  delete service.visionDescribe
  const ai = build(() => service)
  assert.equal(ai.status().vision, false)
  const result = await ai.describeImage('C:/a.png')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not_supported')
  assert.match(result.hint, /暂不支持识图/)
})

test('本地 AI：tts 正常时把音色和语速传给服务，并返回 wavPath', async () => {
  let received = null
  const service = makeService({
    async tts(text, opts) {
      received = { text, opts }
      return { ok: true, items: [{ wavPath: 'C:/cache/a.wav', voice: opts.voice, ms: 12 }] }
    },
  })
  const ai = build(() => service)
  const result = await ai.tts('晚安', { voice: 'test_voice', speed: 9 })
  assert.equal(result.ok, true)
  assert.equal(result.wavPath, 'C:/cache/a.wav')
  assert.deepEqual(received, { text: '晚安', opts: { voice: 'test_voice', speed: 2 } })
})

test('本地 AI：asr 正常时返回文字，非法语言回退 auto', async () => {
  let received = null
  const service = makeService({
    async asr(path, opts) {
      received = { path, opts }
      return { ok: true, items: [{ text: '今晚早点睡' }] }
    },
  })
  const ai = build(() => service)
  const result = await ai.asr('C:/a.wav', { language: 'klingon' })
  assert.equal(result.ok, true)
  assert.equal(result.text, '今晚早点睡')
  assert.equal('speaker' in result, false, '转写结果不再带声纹身份')
  assert.deepEqual(received, { path: 'C:/a.wav', opts: { language: 'auto' } })
})

test('本地 AI：asr 带出情绪和背景音，旧版插件缺字段时是空串', async () => {
  const service = makeService({
    async asr() {
      return { ok: true, items: [{ text: '哈哈', emotion: 'HAPPY', events: ['Speech', '[Laughter]'] }] }
    },
  })
  const result = await build(() => service).asr('C:/a.wav')
  assert.equal(result.emotion, '开心')
  assert.equal(result.background, '笑声')

  // 旧版插件没有 emotion / events：给空串，桥层据此整段省略，不写 undefined。
  const legacy = await build(() => makeService()).asr('C:/a.wav')
  assert.equal(legacy.emotion, '')
  assert.equal(legacy.background, '')
})

test('本地 AI：情绪码映射成短中文，未知值和空值一律当没有', () => {
  assert.equal(emotionText('NEUTRAL'), '中性')
  assert.equal(emotionText('HAPPY'), '开心')
  assert.equal(emotionText('SAD'), '难过')
  assert.equal(emotionText('ANGRY'), '生气')
  assert.equal(emotionText('FEARFUL'), '害怕')
  assert.equal(emotionText('FEAR'), '害怕')
  assert.equal(emotionText('DISGUSTED'), '厌恶')
  assert.equal(emotionText('SURPRISED'), '惊讶')

  // 大小写和空白不敏感；不认识的情绪、缺字段、非字符串都当没有。
  assert.equal(emotionText(' happy '), '开心')
  assert.equal(emotionText('BORED'), '')
  assert.equal(emotionText(''), '')
  assert.equal(emotionText(null), '')
  assert.equal(emotionText(undefined), '')
  assert.equal(emotionText(0), '')
})

test('本地 AI：events 只挑一个背景音，Speech、空数组和未知事件都忽略', () => {
  assert.equal(backgroundText(['Speech']), '')
  assert.equal(backgroundText([]), '')
  assert.equal(backgroundText(null), '')
  assert.equal(backgroundText(undefined), '')
  assert.equal(backgroundText(['[Laughter]']), '笑声')
  assert.equal(backgroundText(['Music']), '音乐')
  assert.equal(backgroundText(['Cough']), '')

  // 多个事件按「笑声 > 掌声 > 音乐」挑最显眼的一个，不堆字段。
  assert.equal(backgroundText(['Music', '[Applause]', '[Laughter]']), '笑声')
  assert.equal(backgroundText(['BGM', 'Applause']), '掌声')
  assert.equal(backgroundText('Speech,Laughter'), '笑声', '兼容逗号分隔的字符串')
})

test('本地 AI：识图偏好读 visionPrefs，接口缺失或返回不认识时算 unknown', async () => {
  const has = makeService({ async visionPrefs() { return { localDescribe: false } } })
  assert.deepEqual(await build(() => has).visionPrefs(), { known: true, localDescribe: false })

  const open = makeService({ async visionPrefs() { return { localDescribe: true } } })
  assert.deepEqual(await build(() => open).visionPrefs(), { known: true, localDescribe: true })

  assert.deepEqual(await build(() => makeService()).visionPrefs(), { known: false }, '接口还没实现')
  assert.deepEqual(await build(() => null).visionPrefs(), { known: false }, '没装插件')

  const throwError = makeService({ async visionPrefs() { throw new Error('还没实现') } })
  assert.deepEqual(await build(() => throwError).visionPrefs(), { known: false })

  const weirdValue = makeService({ async visionPrefs() { return { localDescribe: '大概吧' } } })
  assert.deepEqual(await build(() => weirdValue).visionPrefs(), { known: false })
})

test('本地 AI：三态识图开关 on/off 直接生效，继承时跟随插件、拿不到按开', async () => {
  const closePrefs = makeService({ async visionPrefs() { return { localDescribe: false } } })
  const close = build(() => closePrefs)
  assert.equal(await close.inboundImageEnabled('on'), true)
  assert.equal(await close.inboundImageEnabled('off'), false)
  assert.equal(await close.inboundImageEnabled('inherit'), false)
  assert.equal(await close.inboundImageEnabled(), false, '缺省按继承处理')

  const openPrefs = makeService({ async visionPrefs() { return { localDescribe: true } } })
  assert.equal(await build(() => openPrefs).inboundImageEnabled('inherit'), true)

  // 没装插件、或者插件还没有 visionPrefs：按「开」处理，识图失败会退回原图。
  assert.equal(await build(() => null).inboundImageEnabled('inherit'), true)
  assert.equal(await build(() => makeService()).inboundImageEnabled('inherit'), true)
})

test('本地 AI：识图按 caption 模式调用，并压掉多余空白', async () => {
  let received = null
  const service = makeService({
    async visionDescribe(path, opts) {
      received = { path, opts }
      return { ok: true, items: [{ path, text: '  一只猫\n趴在键盘上  ' }] }
    },
  })
  const ai = build(() => service)
  const result = await ai.describeImage('C:/a.png')
  assert.equal(result.ok, true)
  assert.equal(result.text, '一只猫 趴在键盘上')
  assert.deepEqual(received, { path: 'C:/a.png', opts: { mode: 'caption' } })
})

test('本地 AI：自定义识图提示词作为 prompt 覆盖参数传下去', async () => {
  let received = null
  const service = makeService({
    async visionDescribe(path, opts) {
      received = { path, opts }
      return { ok: true, items: [{ path, text: '一只猫' }] }
    },
  })
  const ai = build(() => service)
  const result = await ai.describeImage('C:/a.png', { prompt: '  描述这张表情包  ' })
  assert.equal(result.ok, true)
  assert.deepEqual(received, { path: 'C:/a.png', opts: { mode: 'caption', prompt: '描述这张表情包' } })
})

test('本地 AI：服务抛错时读 lastError 转成中文提示，不把原始错误抛给调用方', async () => {
  const service = makeService({
    async tts() { throw new Error('CUDA out of memory') },
  })
  service.lastError = { code: 'vram_exhausted', httpStatus: 507, hint: '显存不足' }
  const ai = build(() => service)
  const result = await ai.tts('晚安')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'vram_exhausted')
  assert.match(result.hint, /显卡被别的任务占满了/)
  assert.equal(friendlyHint({ httpStatus: 507 }), '显卡被别的任务占满了，等本地 AI 空下来再试。')
})

test('本地 AI：音色列表去重，兼容裸字符串数组', async () => {
  const service = makeService({ async voices() { return ['dafeiyu', 'test_voice', 'dafeiyu'] } })
  const ai = build(() => service)
  const result = await ai.listVoices()
  assert.equal(result.ok, true)
  assert.deepEqual(result.voices, ['dafeiyu', 'test_voice'])
})

test('本地 AI：插件晚于鱼讯加载时，每次调用都能重新取到服务', async () => {
  let service = null
  const ai = build(() => service)
  assert.equal(ai.status().installed, false)
  service = makeService()
  assert.equal(ai.status().installed, true)
  assert.equal((await ai.tts('晚安')).ok, true)
})

test('能力状态：有方法但 capabilities 为 false 时判不可用', () => {
  const status = capabilityStatus({ tts() {}, capabilities: { tts: false } }, 'tts', 'tts')
  assert.equal(status.available, false)
  assert.equal(status.reason, 'not_supported')
})

test('配置：语音相关字段有默认值，识图开关兼容旧布尔值', () => {
  const theDefault = normalizeConfig({})
  assert.equal(theDefault.sayVoice, 'dafeiyu')
  assert.equal(theDefault.saySpeed, 1)
  assert.equal(theDefault.transcribeInbound, true)
  assert.equal(theDefault.asrLanguage, 'auto')
  assert.equal(theDefault.describeInboundImages, 'inherit', '默认跟随本地 AI 插件')
  assert.equal(theDefault.inboundImagePrompt, '', '识图提示词默认留空，实际用内置默认')

  const changed = normalizeConfig({
    sayVoice: 'test_voice', saySpeed: 9, transcribeInbound: false,
    asrLanguage: 'fr', describeInboundImages: 'off',
  })
  assert.equal(changed.sayVoice, 'test_voice')
  assert.equal(changed.saySpeed, 2)
  assert.equal(changed.transcribeInbound, false)
  assert.equal(changed.asrLanguage, 'auto')
  assert.equal(changed.describeInboundImages, 'off')

  // 旧版本存的是布尔值：true → on，false → off；缺失或不认识 → inherit。
  assert.equal(normalizeConfig({ describeInboundImages: true }).describeInboundImages, 'on')
  assert.equal(normalizeConfig({ describeInboundImages: false }).describeInboundImages, 'off')
  assert.equal(normalizeConfig({ describeInboundImages: 'maybe' }).describeInboundImages, 'inherit')
  assert.equal(normalizeConfig({ describeInboundImages: 'ON' }).describeInboundImages, 'on')

  assert.equal(normalizeConfig({ saySpeed: 0.1 }).saySpeed, 0.5)
  assert.equal(normalizeConfig({ asrLanguage: 'yue' }).asrLanguage, 'yue')
})

test('配置：识图提示词留空即默认，非法值回退默认', () => {
  assert.equal(inboundImagePrompt(normalizeConfig({})), defaultImagePrompt, '留空时实际用内置默认')
  assert.equal(inboundImagePrompt(), defaultImagePrompt, '没有配置时也用内置默认')

  const custom = normalizeConfig({ inboundImagePrompt: '  看看这个表情包是什么梗  ' })
  assert.equal(custom.inboundImagePrompt, '看看这个表情包是什么梗', '去掉首尾空白')
  assert.equal(inboundImagePrompt(custom), '看看这个表情包是什么梗')

  // 旧配置没有这个字段：补空串，用内置默认。
  const prev = normalizeConfig({ describeInboundImages: 'on' })
  assert.equal(prev.inboundImagePrompt, '')
  assert.equal(inboundImagePrompt(prev), defaultImagePrompt)

  // 非字符串、超长都回退默认（空串）；正好到上限的保留。
  assert.equal(normalizeConfig({ inboundImagePrompt: 123 }).inboundImagePrompt, '')
  assert.equal(normalizeConfig({ inboundImagePrompt: null }).inboundImagePrompt, '')
  assert.equal(normalizeConfig({ inboundImagePrompt: '长'.repeat(imagePromptMaxLength + 1) }).inboundImagePrompt, '')
  assert.equal(
    normalizeConfig({ inboundImagePrompt: '长'.repeat(imagePromptMaxLength) }).inboundImagePrompt.length,
    imagePromptMaxLength,
    '正好上限保留',
  )
})

// 朗读化归 fish.service：鱼讯只按句切段，不改写正文。
const ttsService = () => {
  const calls = []
  const service = makeService({
    async tts(text, opts) {
      calls.push({ text, opts })
      return { ok: true, items: [{ wavPath: 'C:/cache/' + calls.length + '.wav', voice: opts?.voice }] }
    },
  })
  return { calls, service }
}

test('本地 AI：tts 不改写原文，朗读化交给 fish.service', async () => {
  const { calls, service } = ttsService()
  const text = '版本 2.5.0，日期 2026-11-12，邮箱 user12@example.com。'
  const result = await build(() => service).tts(text)
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map((call) => call.text), [text])
})

test('本地 AI：tts 长文本仍按 200 字上限按句切段', async () => {
  const { calls, service } = ttsService()
  const sentence = '一'.repeat(98) + '。'
  const fullText = sentence.repeat(3)
  const result = await build(() => service).tts(fullText)
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.text.length <= voiceSegmentMaxLength))
  assert.equal(calls.map((call) => call.text).join(''), fullText)
  assert.deepEqual(result.wavPaths, ['C:/cache/1.wav', 'C:/cache/2.wav'])
  assert.equal(result.wavPath, 'C:/cache/1.wav')
})

test('本地 AI：tts 空文本不发请求，标点原样交给服务', async () => {
  const { calls, service } = ttsService()
  const ai = build(() => service)
  const blank = await ai.tts('   ')
  assert.equal(blank.ok, false)
  assert.equal(blank.code, 'bad_request')
  assert.equal(calls.length, 0)
  const punctuation = await ai.tts('。。。')
  assert.equal(punctuation.ok, true)
  assert.deepEqual(calls.map((call) => call.text), ['。。。'])
})

test('本地 AI：tts 任意一段失败就整体失败，不返回半份结果', async () => {
  let time = 0
  const service = makeService({
    async tts() {
      time += 1
      if (time === 2) return { ok: false, code: 'engine_error', hint: '第二段失败' }
      return { ok: true, items: [{ wavPath: 'C:/cache/' + time + '.wav' }] }
    },
  })
  const sentence = '一'.repeat(98) + '。'
  const result = await build(() => service).tts(sentence.repeat(3))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'engine_error')
  assert.equal(result.wavPaths, undefined)
})
