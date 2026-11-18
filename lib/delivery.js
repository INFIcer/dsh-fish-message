// DSH 会话投递：把一条入站消息变成 agent.followup，让会话照常开一轮。
//
// 这里严格照旧桥在 DSH 0.2.2 上验证过的用法：
//   ctx.agents.get(id) → agent.followup({ id, role:'user', content, source })
// 图片先交给 ctx.attachments.admitPromptContent()，拿不到附件服务就只发文字（文字里已有本地路径）。

import { randomUUID } from 'node:crypto'
import { DEFAULT_CHANNEL, normalizeChannel } from './peer.js'

const sessionKey = (id) => {
  const s = String(id == null ? '' : id).trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

export class Delivery {
  constructor({ ctx, logger }) {
    this.ctx = ctx
    this.logger = logger
  }

  findAgent(sessionId) {
    const original = String(sessionId == null ? '' : sessionId).trim()
    if (!original) return undefined
    const candidate = [original]
    if (original.startsWith('session-')) candidate.push(original.slice('session-'.length))
    else candidate.push(`session-${original}`)
    for (const id of candidate) {
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
    const attachment = this.ctx?.attachments || this.ctx?.get?.('attachments')
    if (!attachment || typeof attachment.imageHostPath !== 'function') return ''
    try {
      return String(attachment.imageHostPath(block?.attachment) || '')
    } catch {
      return ''
    }
  }

  /**
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async deliver({ sessionId, text, images = [], meta = {}, channel = DEFAULT_CHANNEL }) {
    const agent = this.findAgent(sessionId)
    if (!agent) {
      return { ok: false, error: `会话 ${sessionKey(sessionId)} 现在没活着` }
    }
    const ch = normalizeChannel(channel)
    const bodyText = String(text == null ? '' : text).trim()
    const imageList = Array.isArray(images) ? images.filter((x) => x && x.base64) : []
    if (!bodyText && !imageList.length) return { ok: false, error: '消息是空的' }

    let content = [{ type: 'text', text: bodyText || '（收到一条消息）' }]
    if (imageList.length) {
      const attachment = this.ctx?.attachments || this.ctx?.get?.('attachments')
      if (attachment && typeof attachment.admitPromptContent === 'function') {
        try {
          const pending = content.concat(imageList.map((x, i) => ({
            type: 'image',
            data: x.base64,
            mediaType: x.mime || 'image/jpeg',
            name: x.name || `${ch}-${i + 1}.jpg`,
          })))
          content = await attachment.admitPromptContent(pending)
        } catch (error) {
          this.logger?.warn(`图片交给 DSH 附件服务失败，只发文字：${String(error?.message || error)}`)
          content = [{ type: 'text', text: bodyText || '（收到图片，但附件服务没接住）' }]
        }
      }
    }

    try {
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content,
        source: {
          // 来源按通道区分：微信会话看到的是 wechat，不是 qq。
          kind: ch,
          platform: ch,
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

export { sessionKey }
