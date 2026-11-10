import test from 'node:test'
import assert from 'node:assert/strict'
import { AiService, 友好提示, 能力状态, 情绪中文, 背景中文 } from '../lib/ai.js'
import { normalizeConfig } from '../lib/config.js'

function 造服务(补丁 = {}) {
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
    ...补丁,
  }
}

const 建 = (getService, logger = null) => new AiService({ getService, getConfig: () => ({}), logger })

test('本地 AI：没装服务时所有能力都判不可用，提示是人话', async () => {
  const ai = 建(() => null)
  const 状态 = ai.status()
  assert.equal(状态.installed, false)
  assert.equal(状态.online, false)
  assert.match(状态.hint, /本地 AI 插件没装或没启动/)

  const 合成 = await ai.tts('晚安')
  assert.equal(合成.ok, false)
  assert.equal(合成.code, 'service_not_installed')
  assert.match(合成.hint, /其它功能不受影响/)

  const 转写 = await ai.asr('C:/a.wav')
  assert.equal(转写.ok, false)
  assert.equal(转写.code, 'service_not_installed')

  const 音色 = await ai.listVoices()
  assert.deepEqual(音色.voices, [])
  assert.equal(音色.ok, false)
})

test('本地 AI：服务在但能力标成不可用时，按原因降级而不是抛错', async () => {
  const 服务 = 造服务({
    capabilities: { tts: { available: false, ready: false, reason: 'model_missing' } },
  })
  const ai = 建(() => 服务)
  assert.equal(ai.status().tts, false)
  assert.equal(ai.status().online, true, '语音不可用不影响识别可用')

  const 结果 = await ai.tts('晚安')
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'model_missing')
  assert.match(结果.hint, /语音模型还没准备好/)
})

test('本地 AI：visionDescribe 不存在时识图算不可用', async () => {
  const 服务 = 造服务()
  delete 服务.visionDescribe
  const ai = 建(() => 服务)
  assert.equal(ai.status().vision, false)
  const 结果 = await ai.describeImage('C:/a.png')
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'not_supported')
  assert.match(结果.hint, /暂不支持识图/)
})

test('本地 AI：tts 正常时把音色和语速传给服务，并返回 wavPath', async () => {
  let 收到 = null
  const 服务 = 造服务({
    async tts(text, opts) {
      收到 = { text, opts }
      return { ok: true, items: [{ wavPath: 'C:/cache/a.wav', voice: opts.voice, ms: 12 }] }
    },
  })
  const ai = 建(() => 服务)
  const 结果 = await ai.tts('晚安', { voice: 'test_voice', speed: 9 })
  assert.equal(结果.ok, true)
  assert.equal(结果.wavPath, 'C:/cache/a.wav')
  assert.deepEqual(收到, { text: '晚安', opts: { voice: 'test_voice', speed: 2 } })
})

test('本地 AI：asr 正常时返回文字和声纹，非法语言回退 auto', async () => {
  let 收到 = null
  const 服务 = 造服务({
    async asr(path, opts) {
      收到 = { path, opts }
      return { ok: true, items: [{ text: '今晚早点睡', speaker: { name: '主人', score: 0.91, known: true } }] }
    },
  })
  const ai = 建(() => 服务)
  const 结果 = await ai.asr('C:/a.wav', { language: 'klingon' })
  assert.equal(结果.ok, true)
  assert.equal(结果.text, '今晚早点睡')
  assert.deepEqual(结果.speaker, { name: '主人', score: 0.91, known: true })
  assert.deepEqual(收到, { path: 'C:/a.wav', opts: { language: 'auto' } })

  // 服务没给 speaker（或没识别出来）时是 null，不影响转写。
  const 空结果 = await 建(() => 造服务()).asr('C:/a.wav')
  assert.equal(空结果.speaker, null)
})

test('本地 AI：asr 带出情绪和背景音，旧版插件缺字段时是空串', async () => {
  const 服务 = 造服务({
    async asr() {
      return { ok: true, items: [{ text: '哈哈', emotion: 'HAPPY', events: ['Speech', '[Laughter]'] }] }
    },
  })
  const 结果 = await 建(() => 服务).asr('C:/a.wav')
  assert.equal(结果.emotion, '开心')
  assert.equal(结果.background, '笑声')

  // 旧版插件没有 emotion / events：给空串，桥层据此整段省略，不写 undefined。
  const 旧版 = await 建(() => 造服务()).asr('C:/a.wav')
  assert.equal(旧版.emotion, '')
  assert.equal(旧版.background, '')
})

test('本地 AI：情绪码映射成短中文，未知值和空值一律当没有', () => {
  assert.equal(情绪中文('NEUTRAL'), '中性')
  assert.equal(情绪中文('HAPPY'), '开心')
  assert.equal(情绪中文('SAD'), '难过')
  assert.equal(情绪中文('ANGRY'), '生气')
  assert.equal(情绪中文('FEARFUL'), '害怕')
  assert.equal(情绪中文('FEAR'), '害怕')
  assert.equal(情绪中文('DISGUSTED'), '厌恶')
  assert.equal(情绪中文('SURPRISED'), '惊讶')

  // 大小写和空白不敏感；不认识的情绪、缺字段、非字符串都当没有。
  assert.equal(情绪中文(' happy '), '开心')
  assert.equal(情绪中文('BORED'), '')
  assert.equal(情绪中文(''), '')
  assert.equal(情绪中文(null), '')
  assert.equal(情绪中文(undefined), '')
  assert.equal(情绪中文(0), '')
})

test('本地 AI：events 只挑一个背景音，Speech、空数组和未知事件都忽略', () => {
  assert.equal(背景中文(['Speech']), '')
  assert.equal(背景中文([]), '')
  assert.equal(背景中文(null), '')
  assert.equal(背景中文(undefined), '')
  assert.equal(背景中文(['[Laughter]']), '笑声')
  assert.equal(背景中文(['Music']), '音乐')
  assert.equal(背景中文(['Cough']), '')

  // 多个事件按「笑声 > 掌声 > 音乐」挑最显眼的一个，不堆字段。
  assert.equal(背景中文(['Music', '[Applause]', '[Laughter]']), '笑声')
  assert.equal(背景中文(['BGM', 'Applause']), '掌声')
  assert.equal(背景中文('Speech,Laughter'), '笑声', '兼容逗号分隔的字符串')
})

test('本地 AI：识图偏好读 visionPrefs，接口缺失或返回不认识时算 unknown', async () => {
  const 有 = 造服务({ async visionPrefs() { return { localDescribe: false } } })
  assert.deepEqual(await 建(() => 有).visionPrefs(), { known: true, localDescribe: false })

  const 开 = 造服务({ async visionPrefs() { return { localDescribe: true } } })
  assert.deepEqual(await 建(() => 开).visionPrefs(), { known: true, localDescribe: true })

  assert.deepEqual(await 建(() => 造服务()).visionPrefs(), { known: false }, '接口还没实现')
  assert.deepEqual(await 建(() => null).visionPrefs(), { known: false }, '没装插件')

  const 抛错 = 造服务({ async visionPrefs() { throw new Error('还没实现') } })
  assert.deepEqual(await 建(() => 抛错).visionPrefs(), { known: false })

  const 怪值 = 造服务({ async visionPrefs() { return { localDescribe: '大概吧' } } })
  assert.deepEqual(await 建(() => 怪值).visionPrefs(), { known: false })
})

test('本地 AI：三态识图开关 on/off 直接生效，继承时跟随插件、拿不到按开', async () => {
  const 关偏好 = 造服务({ async visionPrefs() { return { localDescribe: false } } })
  const 关 = 建(() => 关偏好)
  assert.equal(await 关.入站识图开关('on'), true)
  assert.equal(await 关.入站识图开关('off'), false)
  assert.equal(await 关.入站识图开关('inherit'), false)
  assert.equal(await 关.入站识图开关(), false, '缺省按继承处理')

  const 开偏好 = 造服务({ async visionPrefs() { return { localDescribe: true } } })
  assert.equal(await 建(() => 开偏好).入站识图开关('inherit'), true)

  // 没装插件、或者插件还没有 visionPrefs：按「开」处理，识图失败会退回原图。
  assert.equal(await 建(() => null).入站识图开关('inherit'), true)
  assert.equal(await 建(() => 造服务()).入站识图开关('inherit'), true)
})

test('本地 AI：识图按 caption 模式调用，并压掉多余空白', async () => {
  let 收到 = null
  const 服务 = 造服务({
    async visionDescribe(path, opts) {
      收到 = { path, opts }
      return { ok: true, items: [{ path, text: '  一只猫\n趴在键盘上  ' }] }
    },
  })
  const ai = 建(() => 服务)
  const 结果 = await ai.describeImage('C:/a.png')
  assert.equal(结果.ok, true)
  assert.equal(结果.text, '一只猫 趴在键盘上')
  assert.deepEqual(收到, { path: 'C:/a.png', opts: { mode: 'caption' } })
})

test('本地 AI：服务抛错时读 lastError 转成中文提示，不把原始错误抛给调用方', async () => {
  const 服务 = 造服务({
    async tts() { throw new Error('CUDA out of memory') },
  })
  服务.lastError = { code: 'vram_exhausted', httpStatus: 507, hint: '显存不足' }
  const ai = 建(() => 服务)
  const 结果 = await ai.tts('晚安')
  assert.equal(结果.ok, false)
  assert.equal(结果.code, 'vram_exhausted')
  assert.match(结果.hint, /显卡被别的任务占满了/)
  assert.equal(友好提示({ httpStatus: 507 }), '显卡被别的任务占满了，等本地 AI 空下来再试。')
})

test('本地 AI：音色列表去重，兼容裸字符串数组', async () => {
  const 服务 = 造服务({ async voices() { return ['dafeiyu', 'test_voice', 'dafeiyu'] } })
  const ai = 建(() => 服务)
  const 结果 = await ai.listVoices()
  assert.equal(结果.ok, true)
  assert.deepEqual(结果.voices, ['dafeiyu', 'test_voice'])
})

test('本地 AI：插件晚于鱼讯加载时，每次调用都能重新取到服务', async () => {
  let 服务 = null
  const ai = 建(() => 服务)
  assert.equal(ai.status().installed, false)
  服务 = 造服务()
  assert.equal(ai.status().installed, true)
  assert.equal((await ai.tts('晚安')).ok, true)
})

test('能力状态：有方法但 capabilities 为 false 时判不可用', () => {
  const 状态 = 能力状态({ tts() {}, capabilities: { tts: false } }, 'tts', 'tts')
  assert.equal(状态.available, false)
  assert.equal(状态.reason, 'not_supported')
})

test('配置：语音相关字段有默认值，识图开关兼容旧布尔值', () => {
  const 默认 = normalizeConfig({})
  assert.equal(默认.sayVoice, 'dafeiyu')
  assert.equal(默认.saySpeed, 1)
  assert.equal(默认.transcribeInbound, true)
  assert.equal(默认.asrLanguage, 'auto')
  assert.equal(默认.describeInboundImages, 'inherit', '默认跟随本地 AI 插件')

  const 改过 = normalizeConfig({
    sayVoice: 'test_voice', saySpeed: 9, transcribeInbound: false,
    asrLanguage: 'fr', describeInboundImages: 'off',
  })
  assert.equal(改过.sayVoice, 'test_voice')
  assert.equal(改过.saySpeed, 2)
  assert.equal(改过.transcribeInbound, false)
  assert.equal(改过.asrLanguage, 'auto')
  assert.equal(改过.describeInboundImages, 'off')

  // 旧版本存的是布尔值：true → on，false → off；缺失或不认识 → inherit。
  assert.equal(normalizeConfig({ describeInboundImages: true }).describeInboundImages, 'on')
  assert.equal(normalizeConfig({ describeInboundImages: false }).describeInboundImages, 'off')
  assert.equal(normalizeConfig({ describeInboundImages: 'maybe' }).describeInboundImages, 'inherit')
  assert.equal(normalizeConfig({ describeInboundImages: 'ON' }).describeInboundImages, 'on')

  assert.equal(normalizeConfig({ saySpeed: 0.1 }).saySpeed, 0.5)
  assert.equal(normalizeConfig({ asrLanguage: 'yue' }).asrLanguage, 'yue')
})
