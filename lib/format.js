// 出站格式解析：`[QQ]…[/QQ]`、反斜杠转义、显式图片/语音/文件指令。
//
// 这个文件是纯函数，不碰网络、不碰文件，单测直接喂字符串。
//
// 设计口径（跟 docs/FORMAT.md 完全一致）：
//   1. 标记只认**未被反斜杠转义、且不在代码块 / 行内代码里**的 `[QQ]` / `[/QQ]`；
//   2. 解析顺序是「先按转义扫描标记，再对块内做反转义」；
//   3. 多个块按出现顺序拼接；只写开头没写结尾 = 开头之后全算；
//   4. 块外内容不发；关掉「只发标记内」时整条发，但标记本身仍然剥掉。

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
    const 起点 = i
    if (n >= 3) {
      // 围栏代码块：找同样长度的闭合围栏；找不到就一直到结尾。
      const 闭合 = s.indexOf('`'.repeat(n), i + n)
      if (闭合 < 0) {
        ranges.push([起点, s.length])
        break
      }
      ranges.push([起点, 闭合 + n])
      i = 闭合 + n
      continue
    }
    // 行内代码：不能跨行，闭合必须是同样数量的反引号。
    const 行尾 = s.indexOf('\n', i + n)
    const 上限 = 行尾 < 0 ? s.length : 行尾
    const 闭合 = s.indexOf('`'.repeat(n), i + n)
    if (闭合 >= 0 && 闭合 < 上限) {
      ranges.push([起点, 闭合 + n])
      i = 闭合 + n
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
  const 标记正则 = /^\[\s*(\/?)\s*QQ\s*\]/i
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '[') continue
    if (isEscaped(s, i) || inRanges(i, codeRanges)) continue
    const m = 标记正则.exec(s.slice(i))
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
    let 上次 = 0
    for (const m of markers) {
      out += s.slice(上次, m.start)
      上次 = m.end
    }
    out += s.slice(上次)
    const 净 = unescape(out).trim()
    return {
      send: 净.length > 0,
      text: 净,
      blocks: [],
      reason: 净.length ? '' : '剥掉标记后没有内容',
    }
  }

  const blocks = []
  let 开 = -1
  for (const m of markers) {
    if (m.type === 'open') {
      // 不支持嵌套；第二个 `[QQ]` 会被当成块内文字。
      if (开 < 0) 开 = m.end
      continue
    }
    if (开 >= 0) {
      blocks.push(unescape(s.slice(开, m.start)).trim())
      开 = -1
    }
  }
  // 只写开头没写结尾：之后全算（保留旧桥的容错）。
  if (开 >= 0) blocks.push(unescape(s.slice(开)).trim())

  const 有内容 = blocks.filter((x) => x.length > 0)
  if (!有内容.length) {
    return {
      send: false,
      text: '',
      blocks,
      reason: markers.length ? 'QQ 块是空的' : '正文里没有未转义的 [QQ] 块',
    }
  }
  return {
    send: true,
    text: 有内容.join('\n').trim(),
    blocks,
    reason: 开 >= 0 ? '只写了 [QQ] 没写 [/QQ]，按「[QQ] 之后全是要发的」处理' : '',
  }
}

/**
 * 把正文里的显式指令拆成有序 token。
 * 支持：
 *   [语音]要合成的话[/语音]
 *   [语音:C:\path\a.wav]
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
  let 文本缓冲 = ''
  const 冲文本 = () => {
    if (!文本缓冲) return
    const 上一块 = tokens[tokens.length - 1]
    if (上一块 && 上一块.type === 'text') 上一块.text += 文本缓冲
    else tokens.push({ type: 'text', text: 文本缓冲 })
    文本缓冲 = ''
  }

  for (let i = 0; i < s.length;) {
    if (s[i] === '[') {
      const 余下 = s.slice(i)
      const 语音块 = /^\[语音\]([\s\S]*?)\[\/语音\]/i.exec(余下)
      if (语音块) {
        冲文本()
        const 正文 = 语音块[1].trim()
        if (正文) tokens.push({ type: 'voice', text: 正文 })
        i += 语音块[0].length
        continue
      }
      const 单项 = /^\[(语音|图片|文件|表情)\s*[:：]\s*([^\]]+)\]/i.exec(余下)
      if (单项 && 单项[2].trim()) {
        冲文本()
        const 类型 = 单项[1]
        const 值 = 单项[2].trim()
        if (类型 === '语音') tokens.push({ type: 'voiceFile', path: 值 })
        else if (类型 === '图片') tokens.push({ type: 'image', path: 值 })
        else if (类型 === '文件') tokens.push({ type: 'file', path: 值 })
        else tokens.push({ type: 'sticker', name: 值 })
        i += 单项[0].length
        continue
      }
    }
    文本缓冲 += s[i]
    i++
  }
  冲文本()

  // 去掉首尾空白；连续文本已经合并过了。
  return tokens
    .map((t) => (t.type === 'text' ? { ...t, text: t.text.trim() } : t))
    .filter((t) => (t.type === 'text' ? t.text.length > 0 : true))
}

/**
 * 出站总入口：先抠 QQ 块，再拆显式指令。
 * @returns {{send: boolean, reason: string, qqText: string, tokens: Array<object>, blocks: string[]}}
 */
export function extractOutbound(text, onlyInside = true) {
  const qq = parseQQBlock(text, onlyInside)
  if (!qq.send) return { send: false, reason: qq.reason, qqText: '', tokens: [], blocks: qq.blocks }
  const tokens = parseDirectives(qq.text)
  if (!tokens.length) {
    return { send: false, reason: '块里只有空白', qqText: qq.text, tokens: [], blocks: qq.blocks }
  }
  return { send: true, reason: qq.reason, qqText: qq.text, tokens, blocks: qq.blocks }
}
