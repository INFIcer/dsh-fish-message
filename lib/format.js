// 出站格式解析：`[QQ]…[/QQ]`、反斜杠转义、显式图片/语音文件/文件/表情指令。
//
// 这个文件是纯函数，不碰网络、不碰文件，单测直接喂字符串。
//
// 设计口径（跟 docs/FORMAT.md 完全一致）：
//   1. 标记只认**未被反斜杠转义、且不在代码块 / 行内代码里**的 `[QQ]` / `[/QQ]`；
//   2. 解析顺序是「先按转义扫描标记，再对块内做反转义」；
//   3. 多个块按出现顺序拼接；只写开头没写结尾 = 开头之后全算；
//   4. 块外内容不发；关掉「只发标记内」时整条发，但标记本身仍然剥掉。
//   5. `[语音]文字[/语音]` 解析成 tts token，由桥层决定能否合成；
//      没装本地 AI 时桥层只提示，不影响其它内容。`[语音:路径]` 照旧是文件。

/** 反斜杠转义：`\[` → `[`、`\]` → `]`、`\\` → `\`；额外认 `\/` → `/`（方便写 `\[\/QQ]`）。 */
export function unescape(text) {
  const s = String(text == null ? '' : text)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = s[i + 1]
    if (next === '[' || next === ']' || next === '\\' || next === '/') {
      out += next
      i++
      continue
    }
    // 不是可识别转义就保留反斜杠，避免把 Windows 路径里的 `\` 吃掉。
    out += '\\'
  }
  return out
}

/** 判断某个位置是不是被反斜杠转义了（前面连续奇数个反斜杠才算转义）。 */
export function isEscaped(text, index) {
  let n = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) n++
  return n % 2 === 1
}

/**
 * 找出 Markdown 代码范围（围栏代码块 + 行内代码）。
 * 这些范围里的 `[QQ]` 一律当普通文字，不参与标记识别。
 */
export function findCodeRanges(text) {
  const s = String(text == null ? '' : text)
  const ranges = []
  let i = 0
  while (i < s.length) {
    if (s[i] !== '`') {
      i++
      continue
    }
    let n = 0
    while (s[i + n] === '`') n++
    const start = i
    if (n >= 3) {
      // 围栏代码块：找同样长度的闭合围栏；找不到就一直到结尾。
      const closed = s.indexOf('`'.repeat(n), i + n)
      if (closed < 0) {
        ranges.push([start, s.length])
        break
      }
      ranges.push([start, closed + n])
      i = closed + n
      continue
    }
    // 行内代码：不能跨行，闭合必须是同样数量的反引号。
    const lineEnd = s.indexOf('\n', i + n)
    const limit = lineEnd < 0 ? s.length : lineEnd
    const closed = s.indexOf('`'.repeat(n), i + n)
    if (closed >= 0 && closed < limit) {
      ranges.push([start, closed + n])
      i = closed + n
    } else {
      i += n
    }
  }
  return ranges
}

function inRanges(index, ranges) {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true
  }
  return false
}

/**
 * 扫描未转义、且不在代码里的 QQ 标记。
 * @returns {{markers: Array<{type: 'open'|'close', start: number, end: number}>, codeRanges: Array<[number, number]>}}
 */
export function scanMarkers(text) {
  const s = String(text == null ? '' : text)
  const codeRanges = findCodeRanges(s)
  const markers = []
  const markRegex = /^\[\s*(\/?)\s*QQ\s*\]/i
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '[') continue
    if (isEscaped(s, i) || inRanges(i, codeRanges)) continue
    const m = markRegex.exec(s.slice(i))
    if (!m) continue
    markers.push({
      type: m[1] === '/' ? 'close' : 'open',
      start: i,
      end: i + m[0].length,
    })
    i += m[0].length - 1
  }
  return { markers, codeRanges }
}

/**
 * 处理 `[QQ]…[/QQ]`。
 * @param {string} text 这一轮 assistant 的正文
 * @param {boolean} onlyInside true = 只发块内；false = 整条发但剥掉标记
 * @returns {{send: boolean, text: string, blocks: string[], reason: string}}
 */
export function parseQQBlock(text, onlyInside = true) {
  const s = String(text == null ? '' : text)
  const { markers } = scanMarkers(s)

  if (!onlyInside) {
    // 整条发：把块外的标记字符删掉，再统一反转义。代码块里的标记不删。
    let out = ''
    let cursor = 0
    for (const m of markers) {
      out += s.slice(cursor, m.start)
      cursor = m.end
    }
    out += s.slice(cursor)
    const clean = unescape(out).trim()
    return {
      send: clean.length > 0,
      text: clean,
      rawText: out.trim(),
      blocks: [],
      reason: clean.length ? '' : '剥掉标记后没有内容',
    }
  }

  const blocks = []
  // 原始（保留反斜杠）一份，给 parseDirectives 用；反转义一份，给日志/展示用。
  const rawBlocks = []
  let open = -1
  for (const m of markers) {
    if (m.type === 'open') {
      // 不支持嵌套；第二个 `[QQ]` 会被当成块内文字。
      if (open < 0) open = m.end
      continue
    }
    if (open >= 0) {
      const raw = s.slice(open, m.start)
      rawBlocks.push(raw)
      blocks.push(unescape(raw).trim())
      open = -1
    }
  }
  // 只写开头没写结尾：之后全算（保留旧桥的容错）。
  if (open >= 0) {
    const raw = s.slice(open)
    rawBlocks.push(raw)
    blocks.push(unescape(raw).trim())
  }

  const rawText = rawBlocks.map((x) => x.trim()).filter((x) => x.length > 0).join('\n')
  const hasContent = blocks.filter((x) => x.length > 0)
  if (!hasContent.length) {
    return {
      send: false,
      text: '',
      rawText: '',
      blocks,
      reason: markers.length ? 'QQ 块是空的' : '正文里没有未转义的 [QQ] 块',
    }
  }
  return {
    send: true,
    text: hasContent.join('\n').trim(),
    rawText,
    blocks,
    reason: open >= 0 ? '只写了 [QQ] 没写 [/QQ]，按「[QQ] 之后全是要发的」处理' : '',
  }
}

/**
 * 把正文里的显式指令拆成有序 token。
 * 支持：
 *   [语音]要合成的话[/语音]   → { type: 'tts', text }（能否合成由桥层按本地 AI 状态决定）
 *   [语音:C:\path\a.wav]      → { type: 'voiceFile', path }
 *   [图片:C:\path\a.png] / [图片:https://…]
 *   [文件:C:\path\a.pdf]
 *   [表情:名字] / [表情:#标签] / [表情:id]
 *
 * 表情指令只保留「要查什么」，真正解析成文件路径在发送时由 Bridge 调表情库完成，
 * 所以这个文件仍然是纯函数。
 */
export function parseDirectives(text) {
  const s = String(text == null ? '' : text)
  const tokens = []
  let textBuffer = ''
  const flushText = () => {
    if (!textBuffer) return
    const previousBlock = tokens[tokens.length - 1]
    if (previousBlock && previousBlock.type === 'text') previousBlock.text += textBuffer
    else tokens.push({ type: 'text', text: textBuffer })
    textBuffer = ''
  }

  for (let i = 0; i < s.length;) {
    // 反斜杠转义：``\[`` 只当普通字符，不参与指令识别（于是可以发送字面量 [表情:xxx]）。
    if (s[i] === '\\' && i + 1 < s.length && '[]\\/'.includes(s[i + 1])) {
      textBuffer += s[i + 1]
      i += 2
      continue
    }
    if (s[i] === '[') {
      const remainingItems = s.slice(i)
      const voiceBlock = /^\[语音\]([\s\S]*?)\[\/语音\]/i.exec(remainingItems)
      if (voiceBlock) {
        flushText()
        const bodyText = voiceBlock[1].trim()
        // 只负责解析；能不能合成由可选的本地 AI 决定，桥层做降级。
        if (bodyText) tokens.push({ type: 'tts', text: bodyText })
        i += voiceBlock[0].length
        continue
      }
      const singleItem = /^\[(语音|图片|文件|表情)\s*[:：]\s*([^\]]+)\]/i.exec(remainingItems)
      if (singleItem && singleItem[2].trim()) {
        flushText()
        const kind = singleItem[1]
        const value = singleItem[2].trim()
        if (kind === '语音') tokens.push({ type: 'voiceFile', path: value })
        else if (kind === '图片') tokens.push({ type: 'image', path: value })
        else if (kind === '文件') tokens.push({ type: 'file', path: value })
        else tokens.push({ type: 'sticker', name: value })
        i += singleItem[0].length
        continue
      }
    }
    textBuffer += s[i]
    i++
  }
  flushText()

  // 去掉首尾空白；连续文本已经合并过了。文本 token 里剩下的转义序列在这里还原。
  return tokens
    .map((t) => (t.type === 'text' ? { ...t, text: unescape(t.text).trim() } : t))
    .filter((t) => (t.type === 'text' ? t.text.length > 0 : true))
}

/**
 * 出站总入口：先抠 QQ 块，再拆显式指令。
 * @returns {{send:boolean, reason:string, qqText:string, tokens:Array<object>, blocks:string[], tts?:boolean}}
 */
export function extractOutbound(text, onlyInside = true) {
  const qq = parseQQBlock(text, onlyInside)
  if (!qq.send) return { send: false, reason: qq.reason, qqText: '', tokens: [], blocks: qq.blocks }
  // 指令解析要用「保留反斜杠」的原文，否则 \\[表情:…] 会被当成真指令。
  const tokens = parseDirectives(qq.rawText == null ? qq.text : qq.rawText)
  if (!tokens.length) {
    return { send: false, reason: '块里只有空白', qqText: qq.text, tokens: [], blocks: qq.blocks }
  }
  const tts = tokens.some((t) => t.type === 'tts')
  return {
    send: true,
    reason: qq.reason,
    qqText: qq.text,
    tokens,
    blocks: qq.blocks,
    ...(tts ? { tts: true } : {}),
  }
}
