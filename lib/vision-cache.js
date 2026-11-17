// 入站图片的识别缓存策略：先按指纹查收图图库，按设置决定「直接用描述 / 借表情库描述 /
// 第一次只登记 / 本地识图补描述 / 原图交给模型」。
//
// 这一层只做判断，不碰磁盘细节（图库负责存取），也不格式化消息正文
// （bridge 把 desc + note 拼进正文）。结果分五种：
//
//   cache    收图图库命中且有描述：只用旧描述，不附原图；正文标明来自收图图库、第几次见到、首次识别时间。
//   sticker  收图图库没有可用描述，但表情库里同一张图带描述：借那条描述，并写回收图图库，
//            下次这张图再来就是 cache。表情库是另一套存储，这里只读它，不写它。
//   deferred 已登记、这次先不识别：第一次见到（只登记），或本地识图关着且缺描述。
//            desc 为空，原图照旧交给会话；描述等这张图再出现时由本地识图补。
//   local    本地识图成功：第二次及以后见到缺描述的图，把描述补写进库，这次只给描述。
//   none     这次拿不到描述：本地识图失败，或图库/输入不可用而退回原图。
//            识图失败时图库条目仍在（这次已记一次命中），下次再出现会重试。
//
// 计数口径：每次「见到」恰好让 hits 或 misses 其中之一 +1。
//   - 图库里还没有这张图（真正第一次见）：记 misses，只登记、不识别；
//   - 之后每次见到：记 hits（命中复用）。已有描述直接用是 hits，缺描述等下次再识别也是 hits；
//   - 例外是表情库兜底：第一次见就借到描述时，描述当场可用，这一次算 hits。
//   于是 hits + misses 从 1 开始、每见到一次 +1，就是「第几次见到」；界面「命中 N 次」读 hits，
//   等于真实复用次数（第一次见到不算命中）。
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
   * @param {object} [options.stickers] 表情库（StickerStore）：收图图库缺描述时按同一 sha256 借它的描述
   * @param {() => object} [options.getConfig]
   * @param {object} [options.logger]
   */
  constructor({ library, ai = null, stickers = null, getConfig = () => ({}), logger = null } = {}) {
    this.library = library
    this.ai = ai
    this.stickers = stickers
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
   * 表情库兜底：同一张图如果早被存成表情包，表情库里可能带着它的描述。
   * 只读、只认有描述的条目；表情库没注入、没有 bySha 或抛错，一律当「没有」——
   * 那是另一套存储，它出问题不该影响收消息。
   * @returns {string} 描述正文；没有就是空串
   */
  stickerDescription(sha256) {
    const stickers = this.stickers
    if (!stickers || typeof stickers.bySha !== 'function') return ''
    try {
      return text(stickers.bySha(sha256)?.desc)
    } catch (error) {
      this.logger?.debug?.(`表情库查询失败（本次按没有描述处理，不影响收消息）：${String(error?.message || error)}`)
      return ''
    }
  }

  /**
   * 决定这张入站图片怎么递进会话。
   *
   * 第一次见到只登记、不识别；同一张图第二次出现时才按设置补描述。收图大多不会反复用，
   * 这样不用为每张新图都付一次识图成本，描述也只在真正复用时才产生。
   *
   * @param {object} input
   * @param {Buffer} input.buffer 图片字节（算指纹、入库都要）
   * @param {string} input.path inbox 里的本机路径（本地识图要用）
   * @param {string} [input.mime]
   * @param {string} [input.ext]
   * @param {boolean} input.localVision 本地识图是否开着（由 bridge 按设置算好）
   * @param {string} [input.prompt] 识图提示词
   * @returns {Promise<{source:'cache'|'sticker'|'deferred'|'local'|'none', desc:string, note:string, sha256:string}>}
   *   desc 为空表示这次只能把原图交给模型；note 是要拼进正文的一句说明（可为空），
   *   其中会写明描述来自收图图库还是表情库。
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

    // ① 命中且有描述：直接用，不附原图。这也是一张图被复用的标准路径。
    if (entry && cachedDesc) {
      const hit = this.safe(() => library.noteHit(sha256), null) || entry
      const at = formatSeenAt(hit.descFirstAt || hit.descAt)
      const note = `来自收图图库（缓存），第 ${Math.max(1, seenCount(hit))} 次见到${at ? `，首次识别于 ${at}` : ''}`
      return { source: 'cache', desc: cachedDesc, note, sha256 }
    }

    // ② 收图图库没有可用描述（未命中，或命中但描述为空）：先看表情库有没有同一张图。
    // 表情库是收藏语义的另一套存储，条目里也可能带描述；借它省一次识图，
    // 并把这描述（连同原图）写回收图图库，下次这张图再来就直接命中缓存。
    const stickerText = this.stickerDescription(sha256)
    if (stickerText) {
      const cached = this.safe(() => library.remember({
        sha256,
        buffer,
        path,
        mime,
        ext,
        desc: stickerText,
        descSource: 'sticker',
      }), null)
      const hit = this.safe(() => library.noteHit(sha256), null) || cached
      const times = Math.max(1, seenCount(hit))
      const written = cached ? (entry ? '；描述已写回收图图库' : '，已收入收图图库') : ''
      return {
        source: 'sticker',
        desc: stickerText,
        note: `来自表情库（这张图已存为表情包），第 ${times} 次见到${written}`,
        sha256,
      }
    }

    // ③ 第一次见到：只登记原图与指纹，这次不识别、不写描述、不要求补描述。
    // 同一张图再出现时才会走到下面的识图分支。
    if (!entry) {
      this.safe(() => library.remember({
        sha256,
        buffer,
        path,
        mime,
        ext,
        desc: '',
        descSource: 'deferred',
      }), null)
      this.safe(() => library.noteMiss(sha256), null)
      return {
        source: 'deferred',
        desc: '',
        note: localVision
          ? '这张图第一次见到，已登记；这次先不识别，同一张图再出现时会自动识别并写描述'
          : '这张图第一次见到，已登记；这次直接看图',
        sha256,
      }
    }

    // ④ 第二次及以后见到、图库里还没有描述：这次算复用，记一次命中。
    // 描述只在本地识图开着时补；关着就把原图交给会话，不要求补描述。
    const hit = this.safe(() => library.noteHit(sha256), null) || entry
    const times = Math.max(2, seenCount(hit))
    if (!localVision) {
      return {
        source: 'deferred',
        desc: '',
        note: `这张图第 ${times} 次见到，收图图库还没有描述；这次直接看图`,
        sha256,
      }
    }
    const described = await this.describe(path, prompt)
    if (described.ok) {
      this.safe(() => library.setDesc(sha256, described.text, { descSource: 'local' }), null)
      return {
        source: 'local',
        desc: described.text,
        note: `这张图第 ${times} 次见到，收图图库已自动补上描述`,
        sha256,
      }
    }
    return {
      source: 'none',
      desc: '',
      note: described.hint
        ? `这张图第 ${times} 次见到，本地识图没成功（${described.hint}），这次直接看图；下次再出现会重新识别`
        : `这张图第 ${times} 次见到，本地识图没成功，这次直接看图；下次再出现会重新识别`,
      sha256,
    }
  }
}
