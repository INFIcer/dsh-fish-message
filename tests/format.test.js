import test from 'node:test'
import assert from 'node:assert/strict'
import { parseQQBlock, extractOutboundBlocks, parseDirectives, unescape } from '../lib/format.js'

test('合法块：只发块内', () => {
  const r = parseQQBlock('这句留本地。\n[MSG]你好，主人[/MSG]\n这句也留本地。', true)
  assert.equal(r.send, true)
  assert.equal(r.text, '你好，主人')
})

test('多个块：切块结果按出现顺序，预览用换行拼接', () => {
  const r = parseQQBlock('[MSG]第一句[/MSG] 中间的废话 [MSG]第二句[/MSG]', true)
  assert.equal(r.send, true)
  assert.deepEqual(r.blocks, ['第一句', '第二句'])
  assert.deepEqual(r.rawBlocks, ['第一句', '第二句'])
  assert.equal(r.text, '第一句\n第二句', 'text 只是展示预览')
})

test('多个块：每块单独解析，块与块之间不粘文字', () => {
  const r = extractOutboundBlocks('[MSG]第一句[/MSG] 中间的废话 [MSG]第二句[/MSG]', true)
  assert.equal(r.send, true)
  assert.equal(r.blocks.length, 2)
  assert.deepEqual(r.blocks.map((b) => b.tokens), [
    [{ type: 'text', text: '第一句' }],
    [{ type: 'text', text: '第二句' }],
  ])
})

test('空块忽略：只把非空块当消息', () => {
  const r = extractOutboundBlocks('[MSG]   [/MSG][MSG]第二块[/MSG][MSG][/MSG]', true)
  assert.equal(r.send, true)
  assert.equal(r.blocks.length, 1)
  assert.deepEqual(r.blocks[0].tokens, [{ type: 'text', text: '第二块' }])
})

test('块内指令不跨块：上一块的 [图片] 不会带进下一块', () => {
  const r = extractOutboundBlocks('[MSG]看图 [图片:C:\\a.png][/MSG][MSG]第二块[/MSG]', true)
  assert.deepEqual(r.blocks.map((b) => b.tokens.map((t) => t.type)), [['text', 'image'], ['text']])
})

test('未闭合 [MSG] 之后全算，但只到这一块结尾', () => {
  const r = extractOutboundBlocks('块外 [MSG]第一块[/MSG] 也块外 [MSG]没闭合', true)
  assert.equal(r.blocks.length, 2)
  assert.deepEqual(r.blocks[1].tokens, [{ type: 'text', text: '没闭合' }])
})

test('转义 \\[MSG] 不开块：整条没有可发内容', () => {
  const r = extractOutboundBlocks('\\[MSG]不是块\\[/MSG]', true)
  assert.equal(r.send, false)
  assert.equal(r.blocks.length, 0)
})

test('关掉只发块内：整条是一块，标记剥掉', () => {
  const r = extractOutboundBlocks('前 [MSG]中[/MSG] 后', false)
  assert.equal(r.send, true)
  assert.equal(r.blocks.length, 1)
  assert.deepEqual(r.blocks[0].tokens, [{ type: 'text', text: '前 中 后' }])
})

test('只写开头没写结尾：开头之后全算', () => {
  const r = parseQQBlock('前言 [MSG]第一行\n第二行', true)
  assert.equal(r.send, true)
  assert.equal(r.text, '第一行\n第二行')
  assert.match(r.reason, /没写/)
})

test('空块不发', () => {
  const r = parseQQBlock('[MSG]   [/MSG]', true)
  assert.equal(r.send, false)
})

test('转义：\\[MSG] 不是标记', () => {
  const r = parseQQBlock('\\[MSG]这不是块\\[/MSG]', true)
  assert.equal(r.send, false)
})

test('转义：块内可以发送字面量 [/MSG]', () => {
  const r = parseQQBlock('[MSG]字面 \\[\\/MSG] 结束[/MSG]', true)
  assert.equal(r.send, true)
  assert.equal(r.text, '字面 [/MSG] 结束')
  const r2 = parseQQBlock('[MSG]字面 \\[/MSG] 结束[/MSG]', true)
  assert.equal(r2.text, '字面 [/MSG] 结束')
})

test('转义：块内可以发送字面量 [MSG]', () => {
  const r = parseQQBlock('[MSG]字面 \\[MSG] 结束[/MSG]', true)
  assert.equal(r.send, true)
  assert.equal(r.text, '字面 [MSG] 结束')
})

test('转义：\\[ 和 \\] 在块内反转义', () => {
  const r = parseQQBlock('[MSG]a\\[b\\]c\\\\\\\\d[/MSG]', true)
  assert.equal(r.text, 'a[b]c\\\\d')
})

test('反引号里的标记不算标记', () => {
  const r = parseQQBlock('看这个 `[MSG]` 和 `[/MSG]`', true)
  assert.equal(r.send, false)
  const r2 = parseQQBlock('看这个 `[MSG]` 和 `[/MSG]`', false)
  assert.equal(r2.send, true)
  assert.match(r2.text, /`\[MSG\]`/)
})

test('围栏代码块里的标记不算标记', () => {
  const str = '说明\n```\n[MSG]这不是要发的[/MSG]\n```\n结束'
  const r = parseQQBlock(str, true)
  assert.equal(r.send, false)
  const r2 = parseQQBlock(str, false)
  assert.equal(r2.send, true)
  assert.match(r2.text, /\[MSG]这不是要发的\[\/MSG]/)
})

test('关掉只发块内：整条发，但剥掉块外标记', () => {
  const r = parseQQBlock('前 [MSG]中[/MSG] 后', false)
  assert.equal(r.send, true)
  assert.equal(r.text, '前 中 后')
})

test('关掉只发块内：转义后的标记会还原成文字', () => {
  const r = parseQQBlock('前 \\[MSG] 后 \\[/MSG]', false)
  assert.equal(r.send, true)
  assert.equal(r.text, '前 [MSG] 后 [/MSG]')
})

test('反斜杠转义函数', () => {
  assert.equal(unescape('\\[\\]\\\\'), '[]\\')
  assert.equal(unescape('D:\\dsh_ws\\a'), 'D:\\dsh_ws\\a')
})

test('显式指令：语音块 / 图片 / 文件', () => {
  const t = parseDirectives('[语音]你好呀[/语音] 中间 [图片:C:\\a.png] 尾巴 [文件:D:/b.pdf]')
  assert.deepEqual(t.map((x) => x.type), ['tts', 'text', 'image', 'text', 'file'])
  assert.equal(t[0].text, '你好呀')
  assert.equal(t[2].path, 'C:\\a.png')
  assert.equal(t[4].path, 'D:/b.pdf')
})

test('显式指令：直接发已有音频', () => {
  const t = parseDirectives('[语音:C:/a.wav]')
  assert.deepEqual(t, [{ type: 'voiceFile', path: 'C:/a.wav' }])
})

test('出站总入口：只发块内的指令，[语音] 块标成 tts', () => {
  const r = extractOutboundBlocks('本地的解释 [MSG][语音]晚安[/语音][/MSG] 块外', true)
  assert.equal(r.send, true)
  assert.equal(r.qqText, '[语音]晚安[/语音]')
  assert.deepEqual(r.blocks[0].tokens, [{ type: 'tts', text: '晚安' }])
  assert.equal(r.tts, true)
})

test('出站总入口：块内为空不发', () => {
  const r = extractOutboundBlocks('只有解释', true)
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
  assert.deepEqual(t.map((x) => x.type), ['text', 'sticker', 'text', 'tts', 'text', 'image', 'text', 'sticker'])
  assert.equal(t[1].name, '晚安')
  assert.equal(t[7].name, '#生气')
})

test('表情指令：不存在也只是 token，解析不存在由发送层报错，不静默吞掉', () => {
  const r = extractOutboundBlocks('[MSG]看这个 [表情:完全没有这个表情][/MSG]', true)
  assert.equal(r.send, true)
  assert.deepEqual(r.blocks[0].tokens, [
    { type: 'text', text: '看这个' },
    { type: 'sticker', name: '完全没有这个表情' },
  ])
})

test('表情指令：空名字不生成 token', () => {
  const t = parseDirectives('[表情:   ]尾巴')
  assert.deepEqual(t, [{ type: 'text', text: '[表情:   ]尾巴' }])
})

test('转义表情指令：\\[表情:名字] 只当字面量', () => {
  const r = extractOutboundBlocks('[MSG]写法示例：\\[表情:名字]、\\[表情:#标签]、\\[表情:id][/MSG]', true)
  assert.equal(r.send, true)
  assert.equal(r.blocks[0].tokens.length, 1)
  assert.equal(r.blocks[0].tokens[0].type, 'text')
  assert.equal(r.blocks[0].tokens[0].text, '写法示例：[表情:名字]、[表情:#标签]、[表情:id]')
})

test('未转义的表情指令仍然生效', () => {
  const r = extractOutboundBlocks('[MSG]来一个 [表情:dschan_thumbs-up] 吧[/MSG]', true)
  assert.deepEqual(r.blocks[0].tokens, [
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
