// 长语音切段：只按句子把文本切成若干段，不改写任何内容。
//
// 朗读化（数字、单位、日期、符号、技术标识符清洗）统一由 fish.service 的 tts
// 入口负责：鱼讯只决定一条语音切成几段发，避免同一规则在插件里再写一套。
// 纯函数：不读配置、不碰网络、不引外部依赖；同一输入永远得到同一输出。

/** 单段语音的默认字数上限：远低于服务端 5000 字上限，长文本听起来才不噎。 */
export const voiceSegmentMaxLength = 200

/**
 * 把长文本按句子切成若干段，每段不超过上限。
 *
 * 切分优先级：句末标点 > 逗号/顿号/冒号 > 硬切。这样合成出来是几句完整的话，
 * 不会在半句话中间断气；接口一次只合成一段，调用方按返回顺序发送即可。
 *
 * @param {string} text 原始文本（不做朗读化，原样切分）
 * @param {number} maxLength 单段最大字数
 * @returns {string[]} 非空段落；空文本返回空数组
 */
export function splitVoiceText(text, maxLength = voiceSegmentMaxLength) {
  const fullText = String(text ?? '')
  if (!fullText) return []
  const limit = Math.max(1, Math.floor(Number(maxLength)) || voiceSegmentMaxLength)
  if (fullText.length <= limit) return [fullText]

  const sentences = fullText.match(/[^。！？!?；;…]+[。！？!?；;…]*|[。！？!?；;…]+/g) || [fullText]
  const segments = []
  let current = ''

  const finish = () => {
    const clean = current.trim()
    if (clean) segments.push(clean)
    current = ''
  }

  for (const sentence of sentences) {
    if (sentence.length > limit) {
      // 单句就超限：先按逗号类停顿切，仍超限才硬切。
      finish()
      const clauses = sentence.match(/[^，,、：:]+[，,、：:]*|[，,、：:]+/g) || [sentence]
      for (const clause of clauses) {
        if (clause.length > limit) {
          finish()
          for (let i = 0; i < clause.length; i += limit) segments.push(clause.slice(i, i + limit))
        } else if (current.length + clause.length > limit) {
          finish()
          current = clause
        } else {
          current += clause
        }
      }
      continue
    }
    if (current.length + sentence.length > limit) finish()
    current += sentence
  }
  finish()
  return segments
}
