import test from 'node:test'
import assert from 'node:assert/strict'
import { splitVoiceText, voiceSegmentMaxLength } from '../lib/split-voice-text.js'

test('切分：短文本原样返回，空文本返回空数组', () => {
  assert.deepEqual(splitVoiceText('你好。'), ['你好。'])
  assert.deepEqual(splitVoiceText(''), [])
  assert.deepEqual(splitVoiceText(null), [])
})

test('切分：不改写原文，数字、邮箱与标识符原样保留', () => {
  const text = '版本 2.5.0，邮箱 user12@example.com，日期 2026-11-12。'
  assert.deepEqual(splitVoiceText(text), [text])
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

test('切分：自定义上限生效，句末标点是切分点', () => {
  assert.deepEqual(splitVoiceText('甲乙。丙丁。', 3), ['甲乙。', '丙丁。'])
  assert.deepEqual(splitVoiceText('第一句。第二句！第三句？', 8), ['第一句。第二句！', '第三句？'])
})
