// 出站合并与发送去重：纯函数，不碰网络、不碰文件、不碰定时器，单测直接喂字符串。
//
// 为什么需要它：DSH 对同一轮回复可能按内容块多次触发 `session/event`
// （`assistant/message` + `turn/end` 成对或多对），如果每个 `turn/end`
// 都立刻发，同一轮的后半段就会被当成「新一轮」再发一遍。
// 这里负责把窗口内陆续到达的文本合并成一条，并提供发送级指纹判断。

import { createHash } from 'node:crypto'
import { scanMarkers } from './format.js'

/** 统一换行、去掉首尾空白；null/undefined 都当空串。 */
const 空白 = (text) => String(text == null ? '' : text).replace(/\r\n/g, '\n').trim()

/** 比较用的规范化：空白折叠，避免「一模一样只是换行不同」的段落漏去重。 */
const 规范化 = (text) => 空白(text).replace(/\s+/g, ' ')

/**
 * 去重比较键：先剥掉未被转义、不在代码里的 `[QQ]` / `[/QQ]` 标记，再折叠空白。
 * 标记只是「要不要发」的结构，不该让同一段内容因为标记位置不同而躲过去重。
 * 转义字面量（`\[\/QQ]`）不是标记，会被原样保留。
 */
export function 比较键(text) {
  const s = String(text == null ? '' : text).replace(/\r\n/g, '\n')
  const { markers } = scanMarkers(s)
  let out = ''
  let 上次 = 0
  for (const m of markers) {
    out += s.slice(上次, m.start)
    上次 = m.end
  }
  out += s.slice(上次)
  return 规范化(out)
}

/**
 * 按段落切分：优先空行（`\n\s*\n`）；没有空行就按单换行切。
 * 返回值都已 trim，空段落丢掉。
 */
export function 切段(text) {
  const s = 空白(text)
  if (!s) return []
  const 空行段 = s.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)
  if (空行段.length > 1) return 空行段
  return s.split(/\n/).map((x) => x.trim()).filter(Boolean)
}

/**
 * 合并「已在缓冲里的文本」和「新到的一批文本」。
 *
 * 规则（对应修复要求）：
 *   1. 其中一份是另一份的子串（典型：后半段又到了一次）→ 只保留更完整的那份，不重复拼接；
 *   2. 否则按段落拼接，保留首次出现顺序，完全重复的段落去重；
 *   3. 段落级也做一次包含判断，避免「段落被拆得不一样」导致重复。
 *
 * @returns {{text: string, 段数: number, 跳过: number}} 段数 = 合并后段落数，跳过 = 被去重掉的段落数
 */
export function 合并文本(已有, 新到) {
  const 甲 = 空白(已有)
  const 乙 = 空白(新到)
  if (!乙) return { text: 甲, 段数: 切段(甲).length, 跳过: 0 }
  if (!甲) return { text: 乙, 段数: 切段(乙).length, 跳过: 0 }

  const 甲段 = 切段(甲)
  const 乙段 = 切段(乙)
  const 甲键 = 比较键(甲)
  const 乙键 = 比较键(乙)

  // 内容一样（标记位置可能不同）：保留先到的那份。
  if (甲键 === 乙键) return { text: 甲, 段数: 甲段.length, 跳过: 甲段.length }

  // 后到的只是前一段的一部分（同一轮的后半段又发了一遍）：保留更完整的那份。
  if (乙键.length >= 8 && 甲键.includes(乙键)) return { text: 甲, 段数: 甲段.length, 跳过: 乙段.length }
  // 反过来：先到的是后半段，后到的是完整文本（更完整的那份胜出）。
  if (甲键.length >= 8 && 乙键.includes(甲键)) return { text: 乙, 段数: 乙段.length, 跳过: 甲段.length }

  // 段落集合包含：先到的每一段都能在新文本里找到（顺序可能被打散），就用更完整的新文本。
  const 甲段键 = new Set(甲段.map(比较键))
  const 乙段键 = new Set(乙段.map(比较键))
  if (甲段.length && 甲段.every((段) => 乙段键.has(比较键(段))) && 乙段.length > 甲段.length) {
    return { text: 乙, 段数: 乙段.length, 跳过: 甲段.length }
  }
  if (乙段.length && 乙段.every((段) => 甲段键.has(比较键(段))) && 甲段.length > 乙段.length) {
    return { text: 甲, 段数: 甲段.length, 跳过: 乙段.length }
  }

  const 段们 = [...甲段]
  const 见 = new Set(段们.map(比较键))
  let 跳过 = 0
  for (const 段 of 乙段) {
    const 键 = 比较键(段)
    if (见.has(键)) {
      跳过++
      continue
    }
    // 段落级包含：新段更完整就替换旧的，否则整段跳过。
    let 吞并 = -1
    for (let i = 0; i < 段们.length; i++) {
      const 旧键 = 比较键(段们[i])
      if (段.length >= 8 && 旧键.includes(键)) { 吞并 = -2; break }
      if (旧键.length >= 8 && 键.includes(旧键)) { 吞并 = i; break }
    }
    if (吞并 === -2) {
      跳过++
      continue
    }
    if (吞并 >= 0) {
      const 旧键 = 比较键(段们[吞并])
      段们[吞并] = 段
      见.delete(旧键)
      见.add(键)
      continue
    }
    段们.push(段)
    见.add(键)
  }

  return { text: 段们.join('\n\n'), 段数: 段们.length, 跳过 }
}

/** 发送指纹：sha256(文本)，用于「发送级去重」兜底。 */
export function 文本指纹(text) {
  return createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex')
}

/**
 * 判断这次要发的文本是不是「最近一次已发内容」的重复。
 * 规则：完全相同，或者是它的子串/后缀（长度 ≥ 8 才有意义）。
 *
 * 时间窗口（默认 60 秒）由调用方维护，这里只做纯比较。
 */
export function 判断重复(本次, 最近) {
  const 甲 = 空白(本次)
  const 乙 = 空白(最近?.text)
  if (!甲 || !乙) return { 重复: false, 原因: '' }
  if (文本指纹(甲) === 最近?.hash) return { 重复: true, 原因: '与最近一次发送完全相同' }
  if (甲.length >= 8 && 乙.includes(甲)) return { 重复: true, 原因: '是最近一次发送的子串/后缀' }
  return { 重复: false, 原因: '' }
}
