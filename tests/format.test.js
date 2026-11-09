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
