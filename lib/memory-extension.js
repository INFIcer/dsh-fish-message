// 记忆扩展：把入站图片、语音与记忆插件提供的图库 / 声纹库比对。
//
// 记忆插件不是硬依赖，宿主只传一个惰性取值函数（形如 () => ctx.get('memory.library')）：
// 没装、抛错、超时都只当「这次没比对」，不影响消息收发。
// 契约见记忆插件 v0.1：
//   images.match({ buffer }) -> { hit, sha256, entry? }
//   voices.identify({ wavPath }) -> { ok, best?: { name, score, tags }, matches }
//
// 本模块只读：不写记忆库，也不碰鱼讯自己的收图图库与表情库。

/** 单次比对的等待上限：本地 AI 算声纹可能要几秒，但不能把消息卡太久。 */
export const memoryTimeoutMs = 5000

const toText = (value) => (value == null ? '' : String(value).trim())

/** 标签 → 顿号分隔文本；兼容数组与单个字符串，去空去重。 */
export function tagText(tags) {
  const list = Array.isArray(tags) ? tags : (typeof tags === 'string' ? tags.split(/[,，、]/) : [])
  const out = []
  for (const item of list) {
    const tag = toText(item)
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out.join('、')
}

/** 图片命中且有描述：`（记忆：描述｜标签：a、b）`；没有标签时省略标签段。 */
export function formatImageNote(entry) {
  const desc = toText(entry?.desc)
  const tags = tagText(entry?.tags)
  if (desc) return tags ? `（记忆：${desc}｜标签：${tags}）` : `（记忆：${desc}）`
  return tags
    ? `（记忆：这张图在图库里〔标签：${tags}〕，还没写描述）`
    : '（记忆：这张图在图库里，还没写描述）'
}

/** 声纹认不出（低于阈值、没有匹配）：正文照样标身份，避免把陌生人当成熟人。 */
export const strangerVoiceNote = '（记忆：声音没认出来，标为陌生人）'

/** 声纹认人：`（记忆：声音来自名字，相似度 0.83）`；拿不到分数就只说名字。 */
export function formatVoiceNote(best) {
  const name = toText(best?.name)
  if (!name) return ''
  const score = Number(best?.score)
  return Number.isFinite(score)
    ? `（记忆：声音来自${name}，相似度 ${score.toFixed(2)}）`
    : `（记忆：声音来自${name}）`
}

export class MemoryExtension {
  constructor({ getService, getConfig, logger, timeoutMs = memoryTimeoutMs } = {}) {
    this.getService = typeof getService === 'function' ? getService : () => undefined
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({})
    this.logger = logger
    this.timeoutMs = Math.max(1, Number(timeoutMs) || memoryTimeoutMs)
    // 服务缺失只记一次 debug：否则每收一条消息就刷一条。
    this.unavailableLogged = false
  }

  /** 总开关与子开关都在这里判；关掉时连取值函数都不调用。 */
  enabled(feature) {
    try {
      const config = this.getConfig() || {}
      if (config.memoryExtension !== true) return false
      return feature === 'images'
        ? config.memoryCompareImages !== false
        : config.memoryCompareVoices !== false
    } catch {
      return false
    }
  }

  /** 惰性取服务；取不到返回 null。插件晚加载也能在下次消息时取到。 */
  service() {
    let service
    try {
      service = this.getService()
    } catch (error) {
      service = null
      if (!this.unavailableLogged) {
        this.unavailableLogged = true
        this.logger?.debug?.(`读取记忆服务失败（跳过记忆比对）：${String(error?.message || error)}`)
      }
    }
    if (!service) {
      if (!this.unavailableLogged) {
        this.unavailableLogged = true
        this.logger?.debug?.('记忆服务不可用，跳过记忆比对；收发不受影响。')
      }
      return null
    }
    return service
  }

  /** 统一加超时：服务不响应时不再等，正文回到现状。 */
  withTimeout(promise, action) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`记忆服务${action}超时（${this.timeoutMs}ms）`)),
        this.timeoutMs,
      )
      timer.unref?.()
      Promise.resolve(promise).then(
        (value) => { clearTimeout(timer); resolve(value) },
        (error) => { clearTimeout(timer); reject(error) },
      )
    })
  }

  /**
   * 图片：只把字节交给 match 算指纹，不发图。
   * @returns {Promise<string>} 要追加到正文的一行；没有就空串。
   */
  async imageNote(buffer) {
    if (!this.enabled('images') || !Buffer.isBuffer(buffer) || !buffer.length) return ''
    const service = this.service()
    if (!service) return ''
    if (typeof service.images?.match !== 'function') {
      this.logger?.debug?.('记忆图库没有 match 方法，跳过图片比对。')
      return ''
    }
    try {
      const result = await this.withTimeout(service.images.match({ buffer }), '图片比对')
      if (!result || result.hit !== true) {
        this.logger?.debug?.('记忆图库未命中')
        return ''
      }
      this.logger?.debug?.(`记忆图库命中：${toText(result.entry?.file) || toText(result.sha256)}`)
      return formatImageNote(result.entry)
    } catch (error) {
      this.logger?.debug?.(`记忆图片比对失败（跳过）：${String(error?.message || error)}`)
      return ''
    }
  }

  /**
   * 语音：把已落盘的音频路径交给声纹库认人。
   * @returns {Promise<string>} 要追加到正文的一行；认不出标为陌生人，比对没做成（服务不可用等）就空串。
   */
  async voiceNote(wavPath) {
    if (!this.enabled('voices')) return ''
    const path = toText(wavPath)
    if (!path) return ''
    const service = this.service()
    if (!service) return ''
    if (typeof service.voices?.identify !== 'function') {
      this.logger?.debug?.('记忆声纹库没有 identify 方法，跳过语音比对。')
      return ''
    }
    try {
      const result = await this.withTimeout(service.voices.identify({ wavPath: path }), '声纹比对')
      // ok:false 是「这次没法比」（服务没跑、读不了音频），不是「比了但不像」——不标身份。
      if (!result || result.ok !== true) {
        this.logger?.debug?.(`记忆声纹比对没做成（${toText(result?.code) || '没有结果'}），本次不标身份`)
        return ''
      }
      if (!result.best) {
        // 认不出时要能看出差多少：最高分、阈值、最像的人，否则只写「没有匹配」没法判断该不该调阈值。
        const top = Array.isArray(result.matches) ? result.matches[0] : null
        const detail = top && Number.isFinite(Number(top.score))
          ? `最高分 ${Number(top.score)}，阈值 ${toText(result.threshold) || '未知'}，最像 ${toText(top.name) || '无名'}`
          : '没有候选'
        this.logger?.debug?.(`记忆声纹没认出来（${detail}），标为陌生人`)
        return strangerVoiceNote
      }
      const note = formatVoiceNote(result.best)
      if (note) this.logger?.debug?.(`记忆声纹认出：${toText(result.best.name)}`)
      return note
    } catch (error) {
      this.logger?.debug?.(`记忆声纹比对失败（跳过）：${String(error?.message || error)}`)
      return ''
    }
  }
}
