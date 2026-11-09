// 表情库的 Agent 工具：fish_sticker_list / fish_sticker_send。
//
// 注册方式与 dsh-fish-service 的工具一致：ctx.tools.register(定义)，定义里带
// parameters（JSON Schema 子集）+ output.schema（字段写清楚）+ execute。
// 失败不抛裸异常，统一返回 { ok:false, code, hint, detail? }，方便 Agent 解释原因。
// 任何返回值都不含 base64。

const 是文本 = (值) => typeof 值 === 'string'

function 渲染(value) {
  try {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  } catch {
    return [{ type: 'text', text: String(value) }]
  }
}

function 输出Schema(properties = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', description: '是否成功' },
      code: { type: 'string', description: '失败时的错误码' },
      hint: { type: 'string', description: '可直接展示给人看的中文提示' },
      detail: { type: 'string', description: '诊断细节（不含敏感信息）' },
      ...properties,
    },
  }
}

function 造工具({ name, description, parameters, output, execute, logger }) {
  const 安全执行 = async (args) => {
    try {
      return await execute(args || {})
    } catch (error) {
      logger?.warn?.(`工具 ${name} 失败：${error?.code || ''} ${error?.message || error}`)
      return {
        ok: false,
        code: String(error?.code || 'sticker_error'),
        hint: String(error?.hint || error?.message || '表情库操作失败'),
        ...(error?.detail ? { detail: String(error.detail) } : {}),
      }
    }
  }
  return {
    name,
    description,
    parameters: parameters || { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: output || 输出Schema(),
      render: (_args, value) => 渲染(value),
    },
    execute: 安全执行,
  }
}

/** 第一条启用的绑定；没有就返回空串。 */
function 默认QQ(getConfig) {
  try {
    const 绑定 = (getConfig?.()?.bindings || []).filter((b) => b && b.enabled !== false && b.qq)
    return 绑定.length ? String(绑定[0].qq) : ''
  } catch {
    return ''
  }
}

function 要QQ(值, getConfig) {
  const 原 = String(值 == null ? '' : 值).trim()
  if (!原) {
    const 兜底 = 默认QQ(getConfig)
    if (!兜底) {
      throw Object.assign(new Error('没有可用的 QQ 绑定'), {
        code: 'no_binding',
        hint: '没有可用的 QQ 绑定：先在「鱼讯 QQ」设置页加一条绑定，或给 qq 参数。',
      })
    }
    return 兜底
  }
  const 号 = 原.replace(/[^\d]/g, '')
  if (号.length < 5 || 号.length > 12) {
    throw Object.assign(new Error(`qq=${原}`), {
      code: 'bad_request',
      hint: '参数不对：qq 必须是 5~12 位数字。',
      detail: `qq=${原}`,
    })
  }
  return 号
}

function 要名字(值) {
  const 名 = 是文本(值) ? 值.trim() : (值 == null ? '' : String(值).trim())
  if (!名) {
    throw Object.assign(new Error('name 为空'), {
      code: 'bad_request',
      hint: '参数不对：name 不能为空（表情名字 / #标签 / id）。',
    })
  }
  if (名.length > 120) {
    throw Object.assign(new Error('name 太长'), {
      code: 'bad_request',
      hint: '参数不对：name 最多 120 字。',
    })
  }
  return 名
}

function 要整数(值, 兜底, 最小, 最大, 字段) {
  if (值 === undefined || 值 === null || 值 === '') return 兜底
  const n = Number(值)
  if (!Number.isInteger(n) || n < 最小 || n > 最大) {
    throw Object.assign(new Error(`${字段}=${值}`), {
      code: 'bad_request',
      hint: `参数不对：${字段} 必须是 ${最小}~${最大} 的整数。`,
      detail: `${字段}=${值}`,
    })
  }
  return n
}

export function makeStickerListTool({ api, logger, getConfig }) {
  return 造工具({
    name: 'fish_sticker_list',
    description: '搜索/列出表情库：只读，返回条目（id、文件、标签、描述、尺寸、用量），不含 base64。q 搜标签/描述/文件名，tag 精确筛标签，limit 1~100。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: '搜索词：匹配标签、描述、文件名、id。' },
        tag: { type: 'string', description: '只列这个标签；带不带 # 都行。' },
        limit: { type: 'integer', description: '返回条数 1~100，默认 20。' },
        sort: { type: 'string', enum: ['used', 'recent', 'name'], description: '排序：used=按用量（默认）、recent=按加入时间、name=按文件名。' },
      },
    },
    output: 输出Schema({
      count: { type: 'number', description: '本次返回条数' },
      total: { type: 'number', description: '命中总数' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            file: { type: 'string' },
            type: { type: 'string', enum: ['gif', 'img'] },
            tags: { type: 'array', items: { type: 'string' } },
            desc: { type: 'string' },
            size_kb: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
            frames: { type: 'number' },
            duration_s: { type: 'number' },
            used_count: { type: 'number' },
            last_used_at: { type: 'string' },
            added_at: { type: 'string' },
            path: { type: 'string' },
          },
        },
      },
      tags: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { tag: { type: 'string' }, count: { type: 'number' } },
        },
      },
      stats: {
        type: 'object',
        additionalProperties: true,
        properties: {},
        description: '总数/占用/上限等统计',
      },
    }),
    execute: async (args) => {
      if (!api?.stickers || typeof api.stickers.list !== 'function') {
        return { ok: false, code: 'unavailable', hint: '表情库还没准备好（fish.message 服务没有 stickers）。' }
      }
      const limit = 要整数(args.limit, 20, 1, 100, 'limit')
      const r = await api.stickers.list({
        ...(是文本(args.q) && args.q.trim() ? { q: args.q.trim() } : {}),
        ...(是文本(args.tag) && args.tag.trim() ? { tag: args.tag.trim() } : {}),
        ...(是文本(args.sort) ? { sort: args.sort } : {}),
        limit,
      })
      return {
        ok: true,
        count: (r.items || []).length,
        total: Number(r.total) || 0,
        items: r.items || [],
        tags: r.tags || [],
        stats: r.stats || {},
      }
    },
    logger,
    getConfig,
  })
}

export function makeStickerSendTool({ api, logger, getConfig }) {
  return 造工具({
    name: 'fish_sticker_send',
    description: '把表情库里的表情发到 QQ 私聊（图片段，GIF 保留动图）。name 可以是名字、#标签或 id；qq 省略时用第一条绑定；count 1~5。发送成功会计入用量。不返回 base64。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        qq: { type: 'string', description: '对方 QQ 号；省略=第一条启用的绑定。' },
        name: { type: 'string', description: '表情名字 / #标签 / id（大小写不敏感）。' },
        count: { type: 'integer', description: '连发几张，1~5，默认 1；标签命中多个时会轮换。' },
      },
      required: ['name'],
    },
    output: 输出Schema({
      qq: { type: 'string' },
      count: { type: 'number' },
      sent: { type: 'number' },
      queued: { type: 'boolean' },
      pending: { type: 'number' },
      stickers: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            file: { type: 'string' },
            name: { type: 'string' },
            sent: { type: 'boolean' },
            queued: { type: 'boolean' },
            pending: { type: 'number' },
          },
        },
      },
    }),
    execute: async (args) => {
      if (!api?.stickers || typeof api.stickers.send !== 'function') {
        return { ok: false, code: 'unavailable', hint: '表情库还没准备好（fish.message 服务没有 stickers）。' }
      }
      const qq = 要QQ(args.qq, getConfig)
      const name = 要名字(args.name)
      const count = 要整数(args.count, 1, 1, 5, 'count')

      // 先解析一次，拿到 id/文件名；找不到时直接给明确错误。
      let 条目
      try {
        条目 = await api.stickers.get(name)
      } catch (error) {
        throw Object.assign(new Error(String(error?.hint || error?.message || '找不到表情')), {
          code: error?.code || 'sticker_not_found',
          hint: error?.hint || `找不到表情「${name}」。`,
          detail: error?.detail || '',
        })
      }

      const 发出 = []
      for (let i = 0; i < count; i++) {
        const r = await api.stickers.send(qq, name)
        发出.push({
          id: String(条目?.id || ''),
          file: String(条目?.file || ''),
          name: String((条目?.file || '').split(/[\\/]/).pop() || ''),
          sent: Boolean(r?.sent),
          queued: Boolean(r?.queued),
          pending: Number(r?.pending) || 0,
        })
      }
      return {
        ok: true,
        qq,
        count: 发出.length,
        sent: 发出.filter((x) => x.sent).length,
        queued: 发出.some((x) => x.queued),
        pending: 发出.reduce((m, x) => Math.max(m, x.pending), 0),
        stickers: 发出,
      }
    },
    logger,
    getConfig,
  })
}

/** 造两个工具定义（不注册，方便单测）。 */
export function buildStickerToolDefinitions({ api, logger, getConfig } = {}) {
  return [
    makeStickerListTool({ api, logger, getConfig }),
    makeStickerSendTool({ api, logger, getConfig }),
  ]
}

/**
 * 注册到宿主；返回 disposer。宿主没有 ctx.tools 时安静跳过（表情库本身照常可用）。
 */
export function registerStickerTools(ctx, { api, logger, getConfig } = {}) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    logger?.warn?.('宿主没有 ctx.tools，跳过表情工具注册（设置页/服务仍然可用）')
    return () => {}
  }
  const 摘 = []
  for (const 定义 of buildStickerToolDefinitions({ api, logger, getConfig })) {
    try {
      const disposer = ctx.tools.register(定义)
      if (typeof disposer === 'function') 摘.push(disposer)
    } catch (error) {
      logger?.error?.(`工具 ${定义.name} 注册失败：${error?.message || error}`)
    }
  }
  return () => {
    for (const 函数 of 摘.splice(0)) {
      try { 函数() } catch { /* 已卸载 */ }
    }
  }
}

export const 表情工具名 = Object.freeze(['fish_sticker_list', 'fish_sticker_send'])
