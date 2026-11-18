// 通道与对端标识：所有「这条消息属于谁」的键都从这里出。
//
// 对端键统一成 `${channel}:${peer}`：同一段对端字符串在 QQ 渠道和微信渠道下是两个人，
// 排队、去重、水位、绑定索引都按这个键分桶，避免跨通道串聊或互相去重。
//
// 各通道的对端形态不同，所以规整（normalize）与校验（problem）都按通道走：
//   qq     —— 纯数字的 QQ 渠道号，老行为是剥掉所有非数字；
//   wechat —— iLink 的 wxid / openid 形如 wxid_xxx、o9cq...@im.wechat，含字母、@、.、_，
//             只 trim、保留原串；长度与字符显式校验，不认识的值给明确原因，而不是清成空串。

export const DEFAULT_CHANNEL = 'qq'
export const PEER_CHANNELS = Object.freeze(['qq', 'wechat'])

/** 微信对端上限：wxid/openid 远短于此，留足余量但不接受粘贴整段文本。 */
export const WECHAT_PEER_MAX_LENGTH = 128

// 可见 ASCII、不含空格：wxid/openid 都是这个形态。排除空白与控制字符后，
// 键、日志、URL 里都不会出现需要转义的内容。
const WECHAT_PEER_PATTERN = /^[\x21-\x7e]+$/

const text = (value) => String(value == null ? '' : value)

/**
 * 宽松通道规整：认不出的值按默认通道处理。
 * 用在「已经落盘或来自外部、但必须尽量救回来」的地方（历史队列条目、传输事件）。
 */
export function normalizeChannel(value) {
  const raw = text(value).trim().toLowerCase()
  return PEER_CHANNELS.includes(raw) ? raw : DEFAULT_CHANNEL
}

/**
 * 严格通道解析：空值 = 默认通道；明确写了但不认识 → null，由调用方决定报错还是丢弃。
 * 配置里写错通道不能猜成 qq：猜错会把微信对端剥成空串，整条绑定被静默吞掉。
 */
export function parseChannel(value) {
  const raw = text(value).trim().toLowerCase()
  if (!raw) return DEFAULT_CHANNEL
  return PEER_CHANNELS.includes(raw) ? raw : null
}

/** 按通道规整对端：qq 只留数字（保持老行为），微信只 trim（保留字母与 @ . _）。 */
export function normalizePeer(channel, value) {
  const raw = text(value)
  if (normalizeChannel(channel) === 'wechat') return raw.trim()
  return raw.replace(/[^\d]/g, '')
}

/** 规整后的对端是否可用；不可用时返回一句能直接展示的原因。 */
export function peerProblem(channel, peer) {
  const ch = normalizeChannel(channel)
  const value = text(peer)
  if (!value) {
    return ch === 'wechat'
      ? '微信对端不能为空（形如 o9cq...@im.wechat 或 wxid_xxx）'
      : 'QQ 渠道的对端不能为空（只能是数字）'
  }
  if (ch === 'wechat') {
    if (value.length > WECHAT_PEER_MAX_LENGTH) {
      return `微信对端太长（${value.length} 个字符，最多 ${WECHAT_PEER_MAX_LENGTH}）`
    }
    if (!WECHAT_PEER_PATTERN.test(value)) {
      return '微信对端只能是不含空格的可见 ASCII 字符（形如 o9cq...@im.wechat 或 wxid_xxx）'
    }
  }
  return ''
}

/** 统一对端键：同一段 peer 字符串在不同通道下必须是不同的键。 */
export function peerKey(channel, peer) {
  const ch = normalizeChannel(channel)
  return `${ch}:${normalizePeer(ch, peer)}`
}

/** 键 → {channel, peer}；没有通道前缀的旧键按 qq 读。 */
export function splitPeerKey(key) {
  const raw = text(key)
  const at = raw.indexOf(':')
  if (at < 0) return { channel: DEFAULT_CHANNEL, peer: raw }
  return { channel: normalizeChannel(raw.slice(0, at)), peer: raw.slice(at + 1) }
}

/**
 * 状态文件里的水位键：qq 用裸对端串，其它通道用对端键。
 *
 * 老状态文件的水位就是裸 QQ 渠道号。升级后若改成带前缀的键，老用户会读不到「看到哪儿了」，
 * 启动时新建的基线会把离线期间的消息当旧历史静默跳过；qq 是默认通道，裸键等价于隐式通道，
 * 而微信的键带 `wechat:` 前缀，两个通道不会共用同一格。
 */
export function watermarkKey(channel, peer) {
  const ch = normalizeChannel(channel)
  return ch === DEFAULT_CHANNEL ? normalizePeer(ch, peer) : peerKey(ch, peer)
}

/** 两个对端是否是同一个人；空串永远不算同一个人（老实现里 '' === '' 会放行任何人）。 */
export function samePeer(channel, a, b) {
  const ch = normalizeChannel(channel)
  const left = normalizePeer(ch, a)
  if (!left) return false
  return left === normalizePeer(ch, b)
}

/**
 * 私聊入站过滤：只认对方发来的私聊，过滤掉自己发出去的回声。
 * 过滤口径按通道走：qq 两侧都剥非数字，微信精确比较。
 */
export function isInboundMessage(message, channel, peer) {
  if (!message || typeof message !== 'object') return false
  if (message.message_type && message.message_type !== 'private') return false
  if (!samePeer(channel, message.user_id, peer)) return false
  if (message.self_id && samePeer(channel, message.self_id, message.user_id)) return false
  return true
}

/** 日志与错误提示里的通道名。 */
export function channelLabel(channel) {
  return normalizeChannel(channel) === 'wechat' ? '微信' : 'QQ'
}
