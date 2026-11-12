// 路径文案：区分「真实的本机路径」和「示例里的占位词」。
//
// 背景：出站格式示例里常写 `[语音:路径]`、`[图片:文件路径]`。如果这类示例被
// 原样发进 QQ，解析器会把它当成真实指令，补发时只看到文件「路径」不存在。
// 这不是变量插值错误，但提示里只写「语音文件不存在：路径」会让人误以为打印了
// 变量名。这里统一给出可读的原因：真实路径照常回显，占位词明确说明是占位符。

const placeholderWord = new Set([
  '路径',
  '文件路径',
  '图片路径',
  '语音路径',
  '音频路径',
  '目录',
  '文件名',
  'path',
  'file',
  'filepath',
  'file_path',
  'url',
  '...',
  '…',
])

/** 值是否像格式示例里的占位词（而不是真实路径）。 */
export function isPlaceholderPath(value) {
  const str = String(value == null ? '' : value).trim()
  if (!str) return false
  if (placeholderWord.has(str.toLowerCase())) return true
  // <路径>、【路径】、(路径) 这类写法也当占位符。
  if (/^[<《\[【（(][^<>《》\[\]【】（）()]{1,20}[>》\]】）)]$/.test(str)) return true
  // 只剩省略号/斜杠的示例片段。
  if (/^(?:[.．。…/\\-]|…)+$/.test(str)) return true
  return false
}

/** 给占位符路径用的明确提示；调用方自己决定前面要不要加类别。 */
export function placeholderPathHint(category, value) {
  const categoryText = String(category == null ? '' : category).trim()
  const prefix = categoryText && categoryText !== '文件' ? categoryText : ''
  const valueText = String(value == null ? '' : value).trim()
  return `${prefix}文件路径是占位符「${valueText}」，请填写真实的本机文件路径`
}
