import test from 'node:test'
import assert from 'node:assert/strict'
import { parseQQBlock, extractOutbound, parseDirectives, unescape } from '../lib/format.js'

test('合法块：只发块内', () => {
  const r = parseQQBlock('这句留本地。\n[QQ]你好，主人[/QQ]\n这句也留本地。', true)
  assert.equal(r.send, true)
  assert.equal(r.text, '你好，主人')
})

test('多个块：按出现顺序用换行拼接', () => {
  const r = parseQQBlock('[QQ]第一句[/QQ] 中间的废话 [QQ]第二句[/QQ]', true)
  assert.equal(r.send, true)
  assert.equal(r.text, '第一句\n第二句')
})

test('只写开头没写结尾：开头之后全算', () => {
  const r = parseQQBlock('前言 [QQ]第一行\n第二行', true)
  assert.equal(r.send, true)
  assert.equal(r.text, '第一行\n第二行')
  assert.match(r.reason, /没写/)
})

test('空块不发', () => {
  const r = parseQQBlock('[QQ]   [/QQ]', true)
  assert.equal(r.send, false)
})

test('转义：\\[QQ] 不是标记', () => {
  const r = parseQQBlock('\\[QQ]这不是块\\[/QQ]', true)
  assert.equal(r.send, false)
})

test('转义：块内可以发送字面量 [/QQ]', () => {
  const r = parseQQBlock('[QQ]字面 \\[\\/QQ] 结束[/QQ]', true)
  assert.equal(r.send, true)
  assert.equal(r.text, '字面 [/QQ] 结束')
  const r2 = parseQQBlock('[QQ]字面 \\[/QQ] 结束[/QQ]', true)
  assert.equal(r2.text, '字面 [/QQ] 结束')
})

test('转义：块内可以发送字面量 [QQ]', () => {
  const r = parseQQBlock('[QQ]字面 \\[QQ] 结束[/QQ]', true)
  assert.equal(r.send, true)
  assert.equal(r.text, '字面 [QQ] 结束')
})

test('转义：\\[ 和 \\] 在块内反转义', () => {
  const r = parseQQBlock('[QQ]a\\[b\\]c\\\\\\\\d[/QQ]', true)
  assert.equal(r.text, 'a[b]c\\\\d')
})

test('反引号里的标记不算标记', () => {
  const r = parseQQBlock('看这个 `[QQ]` 和 `[/QQ]`', true)
  assert.equal(r.send, false)
  const r2 = parseQQBlock('看这个 `[QQ]` 和 `[/QQ]`', false)
  assert.equal(r2.send, true)
  assert.match(r2.text, /`\[QQ\]`/)
})

test('围栏代码块里的标记不算标记', () => {
  const 文 = '说明\n```\n[QQ]这不是要发的[/QQ]\n```\n结束'
  const r = parseQQBlock(文, true)
  assert.equal(r.send, false)
  const r2 = parseQQBlock(文, false)
  assert.equal(r2.send, true)
  assert.match(r2.text, /\[QQ]这不是要发的\[\/QQ]/)
})

test('关掉只发块内：整条发，但剥掉块外标记', () => {
  const r = parseQQBlock('前 [QQ]中[/QQ] 后', false)
  assert.equal(r.send, true)
  assert.equal(r.text, '前 中 后')
})

test('关掉只发块内：转义后的标记会还原成文字', () => {
  const r = parseQQBlock('前 \\[QQ] 后 \\[/QQ]', false)
  assert.equal(r.send, true)
  assert.equal(r.text, '前 [QQ] 后 [/QQ]')
})

test('反斜杠转义函数', () => {
  assert.equal(unescape('\\[\\]\\\\'), '[]\\')
  assert.equal(unescape('D:\\dsh_ws\\a'), 'D:\\dsh_ws\\a')
})

test('显式指令：语音块 / 图片 / 文件', () => {
  const t = parseDirectives('[语音]你好呀[/语音] 中间 [图片:C:\\a.png] 尾巴 [文件:D:/b.pdf]')
  assert.deepEqual(t.map((x) => x.type), ['voice', 'text', 'image', 'text', 'file'])
  assert.equal(t[0].text, '你好呀')
  assert.equal(t[2].path, 'C:\\a.png')
  assert.equal(t[4].path, 'D:/b.pdf')
})

test('显式指令：直接发已有音频', () => {
  const t = parseDirectives('[语音:C:/a.wav]')
  assert.deepEqual(t, [{ type: 'voiceFile', path: 'C:/a.wav' }])
})

test('出站总入口：只发块内的指令', () => {
  const r = extractOutbound('本地的解释 [QQ][语音]晚安[/语音][/QQ] 块外', true)
  assert.equal(r.send, true)
  assert.equal(r.qqText, '[语音]晚安[/语音]')
  assert.deepEqual(r.tokens, [{ type: 'voice', text: '晚安' }])
})

test('出站总入口：块内为空不发', () => {
  const r = extractOutbound('只有解释', true)
  assert.equal(r.send, false)
})

// ---------------- [表情:…] ----------------

test('表情指令：名字 / #标签 / id 都解析成 sticker token', () => {
  const t = parseDirectives('[表情:打哈欠][表情:#睡觉][表情:3b23f496681f]')
  assert.deepEqual(t, [
    { type: 'sticker', name: '打哈欠' },
    { type: 'sticker', name: '#睡觉' },
    { type: 'sticker', name: '3b23f496681f' },
  ])
})

test('表情指令：大小写不敏感、中文冒号也认', () => {
  const t = parseDirectives('[表情:DSCHAN_Gaming] [表情：晚安]')
  assert.deepEqual(t.map((x) => x.type), ['sticker', 'sticker'])
  assert.equal(t[0].name, 'DSCHAN_Gaming')
  assert.equal(t[1].name, '晚安')
})

test('表情指令：一次多个，与其它指令按出现顺序混排', () => {
  const t = parseDirectives('先说 [表情:晚安] 再听 [语音]晚安[/语音] 看图 [图片:C:\\a.png] 最后 [表情:#生气]')
  assert.deepEqual(t.map((x) => x.type), ['text', 'sticker', 'text', 'voice', 'text', 'image', 'text', 'sticker'])
  assert.equal(t[1].name, '晚安')
  assert.equal(t[7].name, '#生气')
})

test('表情指令：不存在也只是 token，解析不存在由发送层报错，不静默吞掉', () => {
  const r = extractOutbound('[QQ]看这个 [表情:完全没有这个表情][/QQ]', true)
  assert.equal(r.send, true)
  assert.deepEqual(r.tokens, [
    { type: 'text', text: '看这个' },
    { type: 'sticker', name: '完全没有这个表情' },
  ])
})

test('表情指令：空名字不生成 token', () => {
  const t = parseDirectives('[表情:   ]尾巴')
  assert.deepEqual(t, [{ type: 'text', text: '[表情:   ]尾巴' }])
})

test('转义表情指令：\\[表情:名字] 只当字面量', () => {
  const r = extractOutbound('[QQ]写法示例：\\[表情:名字]、\\[表情:#标签]、\\[表情:id][/QQ]', true)
  assert.equal(r.send, true)
  assert.equal(r.tokens.length, 1)
  assert.equal(r.tokens[0].type, 'text')
  assert.equal(r.tokens[0].text, '写法示例：[表情:名字]、[表情:#标签]、[表情:id]')
})

test('未转义的表情指令仍然生效', () => {
  const r = extractOutbound('[QQ]来一个 [表情:dschan_thumbs-up] 吧[/QQ]', true)
  assert.deepEqual(r.tokens, [
    { type: 'text', text: '来一个' },
    { type: 'sticker', name: 'dschan_thumbs-up' },
    { type: 'text', text: '吧' },
  ])
})

test('转义语音/图片/文件指令：只当字面量', () => {
  const t = parseDirectives('看 \\[语音]文本\\[/语音] 和 \\[图片:C:\\a.png]')
  assert.equal(t.length, 1)
  assert.equal(t[0].type, 'text')
  assert.equal(t[0].text, '看 [语音]文本[/语音] 和 [图片:C:\\a.png]')
})
