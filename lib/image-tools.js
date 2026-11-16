// 收图图库的 Agent 工具：fish_image_get（取原图） / fish_image_note（写回描述）。
//
// 命名与 fish_sticker_* 一致，但语义不同：图库是「这张图见过没有、上次认成什么」的缓存，
// 表情库是「我想留着当表情」的收藏，两边不共用存储。
//
// 取原图优先返回图片附件（宿主工具契约的 render 支持 image 内容块，附件由
// ctx.attachments.saveImage 落成持久引用）；宿主没给附件服务、或者当前模型不能看图时，
// 退回「本机路径 + 提示用 read_image 查看」，不做假动作。

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { hashFile } from './image-library.js'
import { makeTool, outputSchema } from './tools.js'

const isText = (value) => typeof value === 'string'
const text = (value, fallback = '') => (value == null ? fallback : String(value).trim())

/** 工具层失败：结构化 code + 一句人话；makeTool 会把它包成 {ok:false,...}。 */
function fail(code, hint, detail = '') {
  const error = new Error(hint)
  error.code = code
  error.hint = hint
  if (detail) error.detail = String(detail)
  throw error
}

/** 图库错误码 → 工具错误码（库的 code 不适合直接给 Agent 看）。 */
function mapLibraryError(error) {
  const code = String(error?.code || '')
  const hint = String(error?.hint || error?.message || '图库操作失败')
  if (code === 'image_library_io') fail('io', `图库读写失败：${hint}`, error?.detail)
  if (code === 'image_library_bad_request') fail('bad_request', hint, error?.detail)
  fail('image_error', hint, error?.detail)
}

/** 把一次图库调用包起来，统一成工具错误。 */
async function guarded(fn) {
  try {
    return await fn()
  } catch (error) {
    if (error?.code && !String(error.code).startsWith('image_library_')) throw error
    mapLibraryError(error)
  }
}

/** 宿主附件服务接受的图片类型；BMP 等其它格式只能给路径。 */
const attachableTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 从字节嗅探图片类型（宿主附件服务会自己做权威校验，这里只为拿到合法的 mediaType）。 */
function sniffMediaType(data) {
  if (!Buffer.isBuffer(data) || data.length < 3) return ''
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6 && data.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return ''
}

/**
 * 当前调用方的模型路线能不能看图。
 *
 * read_image 的宿主实现对这件事是硬拒绝；这里不硬拒，只是「明明看不了就不必塞图片」，
 * 因为我们的工具还有「给路径」这条退路。拿不到路线信息按未知处理（照常尝试附图）。
 */
async function routeImageCapability(getLlm, exec) {
  try {
    const llm = getLlm?.()
    if (!llm || typeof llm.resolveModelInfo !== 'function') return 'unknown'
    const agent = exec?.agent
    const routed = agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? agent?.options?.provider
    const model = routed?.model ?? agent?.options?.model
    if (!provider || !model) return 'unknown'
    const info = await llm.resolveModelInfo(provider, model, exec?.signal)
    if (Array.isArray(info?.inputModalities)) return info.inputModalities.includes('image') ? 'yes' : 'no'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 入口身份：指纹（8~64 位十六进制）优先，其次本机绝对路径。 */
function identify(args) {
  const sha256 = text(args.sha256).toLowerCase()
  const path = text(args.path)
  if (sha256 && !/^[0-9a-f]{8,64}$/.test(sha256)) {
    fail('bad_request', '参数不对：sha256 只收 8~64 位十六进制（可以是图库条目的指纹前缀）。', `sha256=${sha256}`)
  }
  if (!sha256 && !path) {
    fail('bad_request', '参数不对：sha256（图库指纹）与 path（本机图片路径）至少给一个。')
  }
  return { sha256, path }
}

const imageSchema = {
  type: 'object',
  additionalProperties: false,
  description: '图片附件引用；宿主给了附件服务时才有这个字段。',
  properties: {
    attachmentId: { type: 'string', description: '附件库里的对象 id（图片块引用它）。' },
    mediaType: { type: 'string', description: '图片类型，如 image/png。' },
    bytes: { type: 'number', description: '附件字节数。' },
    width: { type: 'number', description: '像素宽。' },
    height: { type: 'number', description: '像素高。' },
    name: { type: 'string', description: '展示用文件名。' },
  },
}

function renderImageRead(value) {
  const lines = [
    `<path>${value.path}</path>`,
    '<type>image</type>',
    '<content>',
    `图库原图（sha256 ${String(value.sha256 || '').slice(0, 16)}…，${value.width || 0}x${value.height || 0} px，${value.bytes || 0} bytes）`,
    value.desc ? `描述：${value.desc}` : '这张图在图库里没有描述。',
    '</content>',
  ]
  return [
    { type: 'text', text: lines.join('\n') },
    { type: 'image', attachment: value.image },
  ]
}

function renderPlain(value) {
  try {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  } catch {
    return [{ type: 'text', text: String(value) }]
  }
}

export function makeImageGetTool({ api, logger, getConfig, getAttachments, getLlm } = {}) {
  return makeTool({
    name: 'fish_image_get',
    description: '取回收图图库里的原图：按内容指纹（sha256，可用前 8 位以上）或本机图片路径定位。'
      + '收到图片时如果命中图库缓存，正文里只给上次的描述、不附原图；需要亲眼看画面细节时用它取原图。'
      + '会尽量作为图片附件返回（模型直接看图）；宿主没附件服务或当前模型不能看图时，返回本机路径，'
      + '可用 read_image 查看。代价：原图很占上下文，能靠描述判断就别取。不返回 base64。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sha256: { type: 'string', description: '图库条目的内容指纹，可只给前 8~16 位（十六进制）。' },
        path: { type: 'string', description: '本机图片的绝对路径；与 sha256 二选一，都给了以 sha256 为准。' },
      },
    },
    output: outputSchema({
      sha256: { type: 'string', description: '这张图的完整内容指纹。' },
      path: { type: 'string', description: '图库原图在本机的绝对路径（attached=false 时用它配 read_image）。' },
      desc: { type: 'string', description: '图库里存的描述，可能为空串。' },
      descAt: { type: 'string', description: '首次识别时间；没有描述时为空串。' },
      mime: { type: 'string', description: '图片类型。' },
      width: { type: 'number', description: '像素宽（图库没记时可能是 0）。' },
      height: { type: 'number', description: '像素高。' },
      bytes: { type: 'number', description: '原图字节数。' },
      attached: { type: 'boolean', description: 'true=原图已作为图片附件返回；false=只有路径。' },
      image: imageSchema,
    }),
    execute: async (args, exec) => {
      if (!api?.images || typeof api.images.lookup !== 'function') {
        return { ok: false, code: 'unavailable', hint: '收图图库还没准备好（fish.message 服务没有 images）。' }
      }
      const { sha256, path } = identify(args)
      let entry = null
      if (sha256) {
        const found = await guarded(() => api.images.lookup(sha256))
        entry = found?.entry || null
        if (!entry) {
          fail('not_found', `图库里没有指纹 ${sha256} 对应的图；先把它收进图库（fish_image_note）或换完整指纹试试。`)
        }
      } else {
        if (!isAbsolute(path)) fail('bad_path', '参数不对：path 只接受本机绝对路径。', `path=${path}`)
        if (!existsSync(path)) fail('bad_path', `找不到这个文件：${path}`, `path=${path}`)
        const hash = await guarded(async () => hashFile(path))
        const found = await guarded(() => api.images.lookup(hash))
        entry = found?.entry || null
        if (!entry) {
          fail('not_found', '这张图不在图库里；本机图片可以直接用 read_image 看，收进图库请用 fish_image_note。', `path=${path}`)
        }
      }

      if (!entry.file) {
        fail('no_file', '图库这条只存了描述，没有存原图（设置里关掉了「存原图」）。', entry.desc ? `描述：${entry.desc}` : '')
      }
      const absolute = text(entry.path)
      if (!absolute || !existsSync(absolute)) {
        fail('file_missing', '图库里的原图文件不在了（可能被清理或迁移过）。', entry.desc ? `描述仍可用：${entry.desc}` : '')
      }
      let bytes
      try {
        bytes = readFileSync(absolute)
      } catch (error) {
        fail('io', `读不到图库原图：${absolute}`, String(error?.message || error))
      }

      const mime = attachableTypes.has(text(entry.mime)) ? text(entry.mime) : sniffMediaType(bytes)
      let image = null
      let hint = ''
      if (!mime) {
        hint = '这张图的格式本地附件服务不接受，已给本机路径；能打开的图片查看器可以直接看。'
      } else {
        const capability = await routeImageCapability(getLlm, exec)
        if (capability === 'no') {
          hint = '当前模型不支持看图，已给本机路径；换成能看图的模型再取，或先用描述判断。'
        } else {
          const attachments = getAttachments?.()
          if (!attachments || typeof attachments.saveImage !== 'function') {
            hint = '宿主没有附件服务，已给本机路径；可以用 read_image 查看。'
          } else {
            try {
              const ref = await attachments.saveImage({
                data: bytes,
                mediaType: mime,
                name: `image-library-${String(entry.sha256).slice(0, 12)}${text(entry.ext)}`,
              })
              image = {
                attachmentId: String(ref.attachmentId),
                mediaType: String(ref.mediaType),
                bytes: Number(ref.bytes) || bytes.length,
                width: Number(ref.width) || 0,
                height: Number(ref.height) || Number(entry.height) || 0,
              }
              if (ref.name) image.name = String(ref.name)
            } catch (error) {
              hint = `把原图交给附件服务失败（${String(error?.message || error)}），已给本机路径；可以用 read_image 查看。`
            }
          }
        }
      }

      const value = {
        ok: true,
        sha256: entry.sha256,
        path: absolute,
        desc: text(entry.desc),
        descAt: text(entry.descFirstAt || entry.descAt),
        mime: mime || text(entry.mime),
        width: Number(entry.width) || 0,
        height: Number(entry.height) || 0,
        bytes: bytes.length,
        attached: Boolean(image),
        ...(image ? { image } : {}),
        ...(hint ? { hint } : {}),
      }
      return value
    },
    render: (args, value) => (value?.image ? renderImageRead(value) : renderPlain(value)),
    logger,
    getConfig,
  })
}

export function makeImageNoteTool({ api, logger, getConfig } = {}) {
  return makeTool({
    name: 'fish_image_note',
    description: '给收图图库里的某张图写回描述：按内容指纹（sha256，可用前 8 位以上）或本机图片路径定位。'
      + '看完一张还没有描述的图后用它写下描述（主体、表情、动作、画面文字、可能的梗）；下次同一张图再来就直接用这段描述、不再识图。'
      + '不写的话下次还得重新看图。描述是缓存、可随时改：再写一次会覆盖旧描述并在回执里说明。直接覆盖不是追加。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sha256: { type: 'string', description: '图库条目的内容指纹，可只给前 8~16 位；该条目必须已存在。' },
        path: { type: 'string', description: '本机图片的绝对路径；与 sha256 二选一。库里没有就按这张图新建一条。' },
        desc: { type: 'string', description: '描述正文（必填，最多 500 字）。' },
      },
      required: ['desc'],
    },
    output: outputSchema({
      sha256: { type: 'string', description: '这张图的完整内容指纹。' },
      created: { type: 'boolean', description: 'true=按这个路径新建了图库条目（原图已存进图库）。' },
      updated: { type: 'boolean', description: 'true=改动的是已有条目。' },
      replaced: { type: 'boolean', description: 'true=覆盖了旧描述；false=原来没有描述或内容相同。' },
      previousDesc: { type: 'string', description: '旧描述（没有就是空串），方便确认覆盖了什么。' },
      desc: { type: 'string', description: '写入后的描述。' },
    }),
    execute: async (args) => {
      if (!api?.images || typeof api.images.lookup !== 'function') {
        return { ok: false, code: 'unavailable', hint: '收图图库还没准备好（fish.message 服务没有 images）。' }
      }
      if (!isText(args.desc)) fail('bad_request', '参数不对：desc 必须是文本。')
      const desc = text(args.desc)
      if (!desc) fail('bad_request', '参数不对：desc 不能为空。')
      if (desc.length > 500) fail('bad_request', '参数不对：desc 最多 500 字，长描述请精简。', `length=${desc.length}`)

      const { sha256, path } = identify(args)
      let previousDesc = ''
      let created = false
      let fullSha = ''

      if (sha256) {
        const found = await guarded(() => api.images.lookup(sha256))
        if (!found?.entry) {
          fail('not_found', `图库里没有指纹 ${sha256} 对应的图；给 path 可以按本机图片新建条目。`)
        }
        previousDesc = text(found.entry.desc)
        fullSha = found.entry.sha256
        const updated = await guarded(() => api.images.setDesc(fullSha, desc))
        return {
          ok: true,
          sha256: fullSha,
          created: false,
          updated: true,
          replaced: Boolean(previousDesc) && previousDesc !== desc,
          previousDesc,
          desc: text(updated?.entry?.desc) || desc,
        }
      }

      if (!isAbsolute(path)) fail('bad_path', '参数不对：path 只接受本机绝对路径。', `path=${path}`)
      if (!existsSync(path)) fail('bad_path', `找不到这个文件：${path}`, `path=${path}`)
      const hash = await guarded(async () => hashFile(path))
      const found = await guarded(() => api.images.lookup(hash))
      if (found?.entry) {
        previousDesc = text(found.entry.desc)
        fullSha = found.entry.sha256
        const updated = await guarded(() => api.images.setDesc(fullSha, desc))
        return {
          ok: true,
          sha256: fullSha,
          created: false,
          updated: true,
          replaced: Boolean(previousDesc) && previousDesc !== desc,
          previousDesc,
          desc: text(updated?.entry?.desc) || desc,
        }
      }

      const remembered = await guarded(() => api.images.remember(path, { desc, descSource: 'manual' }))
      created = Boolean(remembered?.created)
      fullSha = text(remembered?.entry?.sha256) || hash
      return {
        ok: true,
        sha256: fullSha,
        created,
        updated: !created,
        replaced: false,
        previousDesc: '',
        desc: text(remembered?.entry?.desc) || desc,
      }
    },
    logger,
    getConfig,
  })
}

/** 造两个工具定义（不注册，方便单测）。 */
export function buildImageToolDefinitions({ api, logger, getConfig, getAttachments, getLlm } = {}) {
  return [
    makeImageGetTool({ api, logger, getConfig, getAttachments, getLlm }),
    makeImageNoteTool({ api, logger, getConfig }),
  ]
}

/**
 * 注册到宿主；返回 disposer。宿主没有 ctx.tools 时安静跳过（图库本身照常可用）。
 */
export function registerImageTools(ctx, { api, logger, getConfig, getAttachments, getLlm } = {}) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    logger?.warn?.('宿主没有 ctx.tools，跳过收图图库工具注册（收图缓存本身照常工作）')
    return () => {}
  }
  const detach = []
  for (const definition of buildImageToolDefinitions({ api, logger, getConfig, getAttachments, getLlm })) {
    try {
      const disposer = ctx.tools.register(definition)
      if (typeof disposer === 'function') detach.push(disposer)
    } catch (error) {
      logger?.error?.(`工具 ${definition.name} 注册失败：${error?.message || error}`)
    }
  }
  return () => {
    for (const func of detach.splice(0)) {
      try { func() } catch { /* 已卸载 */ }
    }
  }
}

export const imageToolName = Object.freeze(['fish_image_get', 'fish_image_note'])
