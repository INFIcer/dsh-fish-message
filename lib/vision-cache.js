// 入站图片的识别缓存策略：先按指纹查图库，按设置决定「直接用描述 / 本地识图 / 交给模型看」。
//
// 这一层只做判断，不碰磁盘细节（图库负责存取），也不格式化消息正文
// （bridge 把 desc + note 拼进正文）。四种结果：
//
//   cache  命中且有描述：只用旧描述，不附原图；正文标明来自图库、第几次见到、首次识别时间。
//   local  识图成功：未命中 -> 原图 + 描述入库；命中但描述为空 -> 把描述补写进库。
//   api    本地识图关着（或没装）：把原图交给模型看，只记「见过」，正文提醒模型写完回填。
//   none   本地识图失败：退回原图，不写库（下次重试），不伪装成命中。
//
// 图库按缓存语义工作：满了淘汰最久没见的，不报错、不提示。

import { hashBuffer } from './image-library.js'

const text = (value, fallback = '') => (value == null ? fallback : String(value).trim())

/** 首次识别时间的展示串；解析不出来就不写（正文里少一段话，不写错时间）。 */
export function formatSeenAt(value) {
  const stamp = text(value)
  if (!stamp) return ''
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return date.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return ''
  }
}

/** 图库里这张图第几次出现：命中次数 + 没见过描述的次数。 */
const seenCount = (entry) => Math.max(0, Number(entry?.hits) || 0) + Math.max(0, Number(entry?.misses) || 0)

export class VisionCache {
  /**
   * @param {object} options
   * @param {import('./image-library.js').ImageLibrary} options.library
   * @param {object} [options.ai] AiService（可选；没有就只能走缓存与原图）
   * @param {() => object} [options.getConfig]
   * @param {object} [options.logger]
   */
  constructor({ library, ai = null, getConfig = () => ({}), logger = null } = {}) {
    this.library = library
    this.ai = ai
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({})
    this.logger = logger
  }

  /** 总开关：关掉时调用方完全走旧行为（每次按设置识图、不写库）。 */
  enabled() {
    if (!this.library) return false
    try {
      return this.getConfig()?.imageLibraryEnabled !== false
    } catch {
      return true
    }
  }

  /** 本地识图是否可用（没装本地 AI 时 ai.describeImage 自己会返回失败，这里只判空）。 */
  async describe(path, prompt) {
    if (!this.ai || typeof this.ai.describeImage !== 'function') {
      return { ok: false, code: 'service_not_installed', hint: '本地 AI 插件没装或没启动。' }
    }
    try {
      const result = await this.ai.describeImage(path, { mode: 'caption', prompt })
      if (result?.ok && text(result.text)) return { ok: true, text: text(result.text) }
      return { ok: false, code: text(result?.code) || 'vision_failed', hint: text(result?.hint) }
    } catch (error) {
      this.logger?.debug?.(`入站图片识图失败（改为直接发图）：${String(error?.message || error)}`)
      return { ok: false, code: 'vision_failed', hint: String(error?.message || error) }
    }
  }

  /** 图库操作一律兜住：缓存出问题只降级成本次不缓存，不能让收消息失败。 */
  safe(fn, fallback = null) {
    try {
      return fn()
    } catch (error) {
      this.logger?.warn?.(`图库操作失败（本次按不复用处理，不影响收消息）：${String(error?.message || error)}`)
      return fallback
    }
  }

  /**
   * 决定这张入站图片怎么递进会话。
   *
   * @param {object} input
   * @param {Buffer} input.buffer 图片字节（算指纹、入库都要）
   * @param {string} input.path inbox 里的本机路径（本地识图要用）
   * @param {string} [input.mime]
   * @param {string} [input.ext]
   * @param {boolean} input.localVision 本地识图是否开着（由 bridge 按设置算好）
   * @param {string} [input.prompt] 识图提示词
   * @returns {Promise<{source:'cache'|'local'|'api'|'none', desc:string, note:string, sha256:string}>}
   *   desc 为空表示这次只能把原图交给模型；note 是要拼进正文的一句说明（可为空）。
   */
  async resolve({ buffer, path, mime = '', ext = '', localVision = false, prompt = '' } = {}) {
    const library = this.library
    if (!library || !this.enabled() || !Buffer.isBuffer(buffer) || !buffer.length) {
      return { source: 'none', desc: '', note: '', sha256: '' }
    }

    let sha256 = ''
    try {
      sha256 = hashBuffer(buffer)
    } catch (error) {
      this.logger?.debug?.(`入站图片算指纹失败（本次不查图库）：${String(error?.message || error)}`)
      return { source: 'none', desc: '', note: '', sha256: '' }
    }

    const entry = this.safe(() => library.lookup(sha256), null)
    const cachedDesc = text(entry?.desc)

    // ① 命中且有描述：直接用，不附原图。
    if (entry && cachedDesc) {
      const hit = this.safe(() => library.noteHit(sha256), null) || entry
      const at = formatSeenAt(hit.descFirstAt || hit.descAt)
      const note = `来自图库，第 ${Math.max(1, seenCount(hit))} 次见到${at ? `，首次识别于 ${at}` : ''}`
      return { source: 'cache', desc: cachedDesc, note, sha256 }
    }

    // ② 命中但描述为空：上次模型/识图没留下描述，下次这张图再来要重新认并提醒补写。
    if (entry && !cachedDesc) {
      if (localVision) {
        const described = await this.describe(path, prompt)
        if (described.ok) {
          const updated = this.safe(() => library.setDesc(sha256, described.text, { descSource: 'local' }), null)
          this.safe(() => library.noteMiss(sha256), null)
          const times = seenCount(updated || entry)
          return {
            source: 'local',
            desc: described.text,
            note: `这张图之前没有描述，已补上${times > 1 ? `（第 ${times} 次见到）` : ''}`,
            sha256,
          }
        }
      }
      this.safe(() => library.noteMiss(sha256), null)
      return {
        source: localVision ? 'none' : 'api',
        desc: '',
        note: '这张图之前没有描述；请看完后用 fish_image_note 把描述补上',
        sha256,
      }
    }

    // ③ 未命中：按设置识图，成功就把「原图 + 描述」入库。
    if (localVision) {
      const described = await this.describe(path, prompt)
      if (described.ok) {
        this.safe(() => library.remember({
          sha256,
          buffer,
          path,
          mime,
          ext,
          desc: described.text,
          descSource: 'local',
        }), null)
        this.safe(() => library.noteMiss(sha256), null)
        return { source: 'local', desc: described.text, note: '已收入图库（首次识别）', sha256 }
      }
      // 识图失败：退回原图，不写库，下次这张图还会重新识图。
      return {
        source: 'none',
        desc: '',
        note: described.hint ? `本地识图没成功（${described.hint}），这次直接看图；下次这张图会重新识图` : '本地识图没成功，这次直接看图；下次这张图会重新识图',
        sha256,
      }
    }

    // ④ 未命中且本地识图关着：把原图交给模型看，只记「见过」，描述等模型用工具回填。
    this.safe(() => library.remember({ sha256, buffer, path, mime, ext, desc: '', descSource: 'api' }), null)
    this.safe(() => library.noteMiss(sha256), null)
    return {
      source: 'api',
      desc: '',
      note: '这张图还没进图库；请看完后用 fish_image_note 把描述写回图库',
      sha256,
    }
  }
}
