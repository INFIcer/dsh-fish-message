import test from 'node:test'
import assert from 'node:assert/strict'
import { ttsFriendly, splitVoiceText, voiceSegmentMaxLength } from '../lib/tts-text.js'
import { AiService } from '../lib/ai.js'

// 期望值来自 Python 参考程序 tts_friendly() 的实测输出。时间读法是唯一的有意偏离：
// 参考程序把 11:05 读成「十一点零零五」（分钟双零且缺「分」），这里按验收要求
// 读成「十一点零五分」；其余用例逐字一致。
const contrast = [
  [
    "QQ邮箱：1796117435@qq.com",
    "QQ邮箱：幺七九六幺幺七四三五 at qq dot com"
  ],
  [
    "工作邮箱：user12@email.com",
    "工作邮箱：user一二 at email dot com"
  ],
  [
    "备用邮箱：user1@example.com",
    "备用邮箱：user一 at example dot com"
  ],
  [
    "混合邮箱：first.last+tag1@mail.co.uk",
    "混合邮箱：first dot last plus tag一 at mail dot co dot uk"
  ],
  [
    "纯数字带符号：1.2.3@test.com",
    "纯数字带符号：一 dot 二 dot 三 at test dot com"
  ],
  [
    "联系电话13812345678",
    "联系电话幺三八幺二三四五六七八"
  ],
  [
    "手机 +86 13812345678",
    "手机 加八六，幺三八幺二三四五六七八"
  ],
  [
    "user_1@ex-ample.com",
    "user underscore 一 at ex dash ample dot com"
  ],
  [
    "400-123-4567",
    "四零零，幺二三，四五六七"
  ],
  [
    "010-12345678",
    "零幺零，幺二三四五六七八"
  ],
  [
    "+1-234567890",
    "加幺，二三四五六七八九零"
  ],
  [
    "文件名叫 my_file-name 吧",
    "文件名叫 my file name 吧"
  ],
  [
    "订单 1,234 元，共 12,345,678 件",
    "订单 一千二百三十四 元，共 一千二百三十四万五千六百七十八 件"
  ],
  [
    "日期 2026-11-12、2026/1/5、2026.11.12",
    "日期 二零二六年十一月十二日、二零二六年一月五日、二零二六年十一月十二日"
  ],
  [
    "日期 2026年11月12日 和 2026年11月、2026年",
    "日期 二零二六年十一月十二日 和 二零二六年十一月、二零二六年"
  ],
  [
    "时间 11:05、11:05:09、23:59、9:07、0:00、2:30",
    "时间 十一点零五分、十一点零五分零九秒、二十三点五十九分、九点零七分、零点零零分、二点三十分"
  ],
  [
    "温度 36.5℃、25°C、90°、-5℃",
    "温度 三十六点五摄氏度、二十五摄氏度、九十度、减五摄氏度"
  ],
  [
    "百分比 100%、3.14%、0.5%",
    "百分比 百分之一百、百分之三点一四、百分之零点五"
  ],
  [
    "小数 3.14、0.5、12.0",
    "小数 三点一四、零点五、十二点零"
  ],
  [
    "整数 0、123、1001、10000、10001、100000000、123456789",
    "整数 零、一百二十三、一千零一、一万、一万零一、一亿、一亿二千三百四十五万六千七百八十九"
  ],
  [
    "符号 a+b=c、3×4、10÷2、x=1、#1、a&b、a|b、2^3、~、<、>",
    "符号 a加b等于c、三乘四、十除以二、x等于一、井号一、a and b、a or b、二次方三、波浪号、小于、大于"
  ],
  [
    "货币 $100、€5、£3、¥8",
    "货币 美元一百、欧元五、英镑三、元八"
  ],
  [
    "数学 ±1、≈3、≠4、≤5、≥6",
    "数学 正负一、约等于三、不等于四、小于等于五、大于等于六"
  ],
  [
    "括号 (a)、[b]、{c}",
    "括号 括号a括号、方括号b方括号、花括号c花括号"
  ],
  [
    "换行第一行\n第二行\n\n第三行",
    "换行第一行。第二行。第三行"
  ],
  [
    "清理。。。你好。。。  　 世界 。",
    "清理。你好。世界。"
  ],
  [
    "混合：会议定在2026年11月12日 11:05，温度36.5℃，进度100%。",
    "混合：会议定在二零二六年十一月十二日 十一点零五分，温度三十六点五摄氏度，进度百分之一百。"
  ],
  [
    "请发到 user1@example.com 或 13812345678",
    "请发到 user一 at example dot com 或 幺三八幺二三四五六七八"
  ],
  [
    "纯空白   \t　 ",
    "纯空白"
  ],
  [
    "",
    ""
  ],
  [
    "版本 v1.2.3 和 AI-助手",
    "版本 v1.2.3 和 AI减助手"
  ],
  [
    "编号 000123 和 007",
    "编号 一百二十三 和 七"
  ],
  [
    "超大 12345678901234567",
    "超大 一兆二千三百四十五万亿六千七百八十九亿零一百二十三万四千五百六十八"
  ],
  [
    "小数与句号 3.14. 结束",
    "小数与句号 3.14. 结束"
  ],
  [
    "百分比和温度连写 50% 25℃",
    "百分比和温度连写 百分之五十 二十五摄氏度"
  ],
  [
    "价格 1,000,000 元",
    "价格 一百万 元"
  ],
  [
    "1,23 不是千分位",
    "一,二十三 不是千分位"
  ],
  [
    "一亿 100000000 一千万 10000000 十万 100000 一百万 1000000",
    "一亿 一亿 一千万 一千万 十万 十万 一百万 一百万"
  ],
  [
    "1000000000000",
    "一万亿"
  ],
  [
    "2026年1月5日 10:30:00",
    "二零二六年一月五日 十点三十分零零秒"
  ],
  [
    "邮箱 a1b2@x-y.com",
    "邮箱 a一b二 at x dash y dot com"
  ],
  [
    "温度 -5.5℃",
    "温度 减五点五摄氏度"
  ],
  [
    "abc-def a-b-c",
    "abc def a b c"
  ],
  [
    "@user",
    "at user"
  ],
  [
    "a&b",
    "a and b"
  ],
  [
    "。。。",
    ""
  ],
  [
    "你好。。。",
    "你好。"
  ],
  [
    "\n",
    ""
  ],
  [
    "  。  ",
    ""
  ],
  [
    "第1名 和 第2名",
    "第一名 和 第二名"
  ],
  [
    "3.14%的人",
    "百分之三点一四的人"
  ],
  [
    "50％全角",
    "五十％全角"
  ],
  [
    "1.2.3 版本",
    "1.2.3 版本"
  ],
  [
    "13812345678。",
    "幺三八幺二三四五六七八。"
  ],
  [
    "电话13812345678号",
    "电话幺三八幺二三四五六七八号"
  ],
  [
    "金额￥1,234.50",
    "金额￥一千二百三十四点五零"
  ],
  [
    "坐标 (3.5, 4.25)",
    "坐标 括号三点五, 四点二五括号"
  ],
  [
    "100% sure 3.5℃",
    "百分之一百 sure 三点五摄氏度"
  ]
]

test('可朗读化：全部用例与参考实现一致（时间读法按验收要求修正）', () => {
  for (const [input, expected] of contrast) {
    assert.equal(ttsFriendly(input), expected, '输入：' + JSON.stringify(input))
  }
})

test('可朗读化：非字符串输入按空串处理', () => {
  assert.equal(ttsFriendly(null), '')
  assert.equal(ttsFriendly(undefined), '')
  assert.equal(ttsFriendly('   \t　 '), '')
})

test('可朗读化：超过 26 个地址时占位符继续编号并全部还原', () => {
  const input = Array.from({ length: 30 }, (_, i) => 'u' + i + '@e' + i + '.com').join('；')
  const out = ttsFriendly(input)
  assert.ok(!out.includes('\u0000'), '不应残留占位符')
  assert.equal((out.match(/ at /g) || []).length, 30)
})

test('切分：短文本原样返回，空文本返回空数组', () => {
  assert.deepEqual(splitVoiceText('你好。'), ['你好。'])
  assert.deepEqual(splitVoiceText(''), [])
  assert.deepEqual(splitVoiceText(null), [])
})

test('切分：按句子切到上限内，顺序和内容不变', () => {
  const sentence = '一'.repeat(98) + '。'
  const fullText = sentence.repeat(3)
  const segments = splitVoiceText(fullText)
  assert.equal(segments.length, 2)
  assert.ok(segments.every((segment) => segment.length <= voiceSegmentMaxLength))
  assert.equal(segments.join(''), fullText)
})

test('切分：没有句号的超长文本按上限硬切', () => {
  const segments = splitVoiceText('啊'.repeat(450))
  assert.deepEqual(segments.map((segment) => segment.length), [200, 200, 50])
})

test('切分：自定义上限生效', () => {
  assert.deepEqual(splitVoiceText('甲乙。丙丁。', 3), ['甲乙。', '丙丁。'])
})

function makeService(extra = {}) {
  return {
    capabilities: { tts: { available: true, ready: true } },
    calls: [],
    async tts(text, opts) {
      this.calls.push({ text, opts })
      return { ok: true, items: [{ wavPath: 'C:/cache/' + this.calls.length + '.wav', voice: opts?.voice }] }
    },
    ...extra,
  }
}

const build = (service) => new AiService({ getService: () => service, getConfig: () => ({}), logger: null })

test('ai.tts：转发前先做可朗读化', async () => {
  const service = makeService()
  const result = await build(service).tts('会议 9:07，邮箱 user12@email.com')
  assert.equal(result.ok, true)
  assert.equal(service.calls.length, 1)
  assert.equal(service.calls[0].text, '会议 九点零七分，邮箱 user一二 at email dot com')
})

test('ai.tts：语速夹到 0.5~2，非法值回落 1，空音色用默认', async () => {
  const service = makeService()
  const ai = build(service)
  await ai.tts('第一句', { voice: '', speed: 9 })
  await ai.tts('第二句', { voice: 'test_voice', speed: 0.1 })
  await ai.tts('第三句', { speed: 'abc' })
  assert.equal(service.calls[0].opts.voice, 'dafeiyu')
  assert.equal(service.calls[0].opts.speed, 2)
  assert.equal(service.calls[1].opts.voice, 'test_voice')
  assert.equal(service.calls[1].opts.speed, 0.5)
  assert.equal(service.calls[2].opts.speed, 1)
})

test('ai.tts：长文本按句子切段，逐段合成并顺序返回', async () => {
  const sentence = '一'.repeat(98) + '。'
  const fullText = sentence.repeat(3)
  const service = makeService()
  const result = await build(service).tts(fullText)
  assert.equal(service.calls.length, 2)
  assert.ok(service.calls.every((invoke) => invoke.text.length <= voiceSegmentMaxLength))
  assert.equal(service.calls.map((invoke) => invoke.text).join(''), fullText)
  assert.deepEqual(result.wavPaths, ['C:/cache/1.wav', 'C:/cache/2.wav'])
  assert.equal(result.wavPath, 'C:/cache/1.wav')
})

test('ai.tts：空文本或只剩符号时不发请求', async () => {
  const service = makeService()
  const ai = build(service)
  const blank = await ai.tts('   ')
  const symbol = await ai.tts('。。。')
  assert.equal(blank.ok, false)
  assert.equal(blank.code, 'bad_request')
  assert.equal(symbol.ok, false)
  assert.equal(service.calls.length, 0)
})

test('ai.tts：任意一段失败就整体失败，不返回半份结果', async () => {
  let time = 0
  const service = makeService({
    async tts() {
      time += 1
      if (time === 2) return { ok: false, code: 'engine_error', hint: '第二段失败' }
      return { ok: true, items: [{ wavPath: 'C:/cache/' + time + '.wav' }] }
    },
  })
  const sentence = '一'.repeat(98) + '。'
  const result = await build(service).tts(sentence.repeat(3))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'engine_error')
  assert.equal(result.wavPaths, undefined)
})
