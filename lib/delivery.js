// DSH 会话投递：把一条 QQ 消息变成 agent.followup，让会话照常开一轮。
//
// 这里严格照旧桥在 DSH 0.2.2 上验证过的用法：
//   ctx.agents.get(id) → agent.followup({ id, role:'user', content, source })
// 图片先交给 ctx.attachments.admitPromptContent()，拿不到附件服务就只发文字（文字里已有本地路径）。

import { randomUUID } from 'node:crypto'

const 会话键 = (id) => {
  const s = String(id == null ? '' : id).trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

export class Delivery {
  constructor({ ctx, logger }) {
    this.ctx = ctx
    this.logger = logger
  }

  findAgent(sessionId) {
    const 原 = String(sessionId == null ? '' : sessionId).trim()
    if (!原) return undefined
    const 候选 = [原]
    if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
    else 候选.push(`session-${原}`)
    for (const id of 候选) {
      try {
        const a = this.ctx?.agents?.get?.(id)
        if (a !== undefined) return a
      } catch {
        // 换下一个写法。
      }
    }
    return undefined
  }

  /** 取 assistant 图片块在本机的真实路径（回发时用）。 */
  async attachmentPath(block) {
    const 附件 = this.ctx?.attachments || this.ctx?.get?.('attachments')
    if (!附件 || typeof 附件.imageHostPath !== 'function') return ''
    try {
      return String(附件.imageHostPath(block?.attachment) || '')
    } catch {
      return ''
    }
  }

  /**
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async deliver({ sessionId, text, images = [], meta = {} }) {
    const agent = this.findAgent(sessionId)
    if (!agent) {
      return { ok: false, error: `会话 ${会话键(sessionId)} 现在没活着` }
    }
    const 正文 = String(text == null ? '' : text).trim()
    const 图们 = Array.isArray(images) ? images.filter((x) => x && x.base64) : []
    if (!正文 && !图们.length) return { ok: false, error: '消息是空的' }

    let content = [{ type: 'text', text: 正文 || '（收到一条消息）' }]
    if (图们.length) {
      const 附件 = this.ctx?.attachments || this.ctx?.get?.('attachments')
      if (附件 && typeof 附件.admitPromptContent === 'function') {
        try {
          const 待 = content.concat(图们.map((x, i) => ({
            type: 'image',
            data: x.base64,
            mediaType: x.mime || 'image/jpeg',
            name: x.name || `qq-${i + 1}.jpg`,
          })))
          content = await 附件.admitPromptContent(待)
        } catch (error) {
          this.logger?.warn(`图片交给 DSH 附件服务失败，只发文字：${String(error?.message || error)}`)
          content = [{ type: 'text', text: 正文 || '（收到图片，但附件服务没接住）' }]
        }
      }
    }

    try {
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content,
        source: {
          kind: 'qq',
          platform: 'qq',
          bridge: 'fish-message',
          ...(meta?.messageId ? { messageId: String(meta.messageId) } : {}),
        },
      })
      try {
        if (this.ctx?.sessions && typeof this.ctx.sessions.flush === 'function' && agent.session) {
          await this.ctx.sessions.flush(agent.session)
        }
      } catch {
        // flush 失败不影响 followup 已经受理。
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: `followup 失败：${String(error?.message || error)}` }
    }
  }
}

export { 会话键 }
