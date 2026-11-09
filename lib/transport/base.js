// 传输层适配器接口。
//
// v1 只实现 `napcat-onebot`；以后接别的 IM（微信、Discord、Telegram…）时，
// 新写一个同形状的类，Bridge 不用改。详细扩展点见 docs/ARCHITECTURE.md。
//
// 约定：
//   - start() 只负责「开始连」，不阻塞到连上；连不上就降级/重试，并通过 onStatus 汇报。
//   - onEvent(event) 收 OneBot 11 事件原样对象；Bridge 自己过滤私聊、去重、排序。
//   - sendMessage(peer, segments) 的 segments 是 OneBot 消息段数组。
//   - fetchHistory(peer, options) 返回按任意顺序的消息数组，Bridge 会自己排序。

export class Transport {
  /** 适配器名字，例如 napcat-onebot */
  get name() {
    return 'base'
  }

  /**
   * @param {{onEvent: (event: object) => void, onStatus: (status: object) => void}} handlers
   */
  async start(_handlers) {
    throw new Error('Transport.start() 未实现')
  }

  async stop() {
    throw new Error('Transport.stop() 未实现')
  }

  /**
   * 注册入站事件回调（也可以直接在 start({ onEvent }) 里传）。
   * @param {(event: object) => void} _handler
   */
  onEvent(_handler) {
    throw new Error('Transport.onEvent() 未实现')
  }

  /**
   * @param {string|number} _peer 私聊对象（QQ 号）
   * @param {Array<object>} _segments OneBot 消息段
   * @returns {Promise<object>} OneBot data
   */
  async sendMessage(_peer, _segments) {
    throw new Error('Transport.sendMessage() 未实现')
  }

  /**
   * @param {string|number} _peer
   * @param {{count?: number, beforeSeq?: number|string}} _options
   * @returns {Promise<Array<object>>}
   */
  async fetchHistory(_peer, _options = {}) {
    throw new Error('Transport.fetchHistory() 未实现')
  }

  /** 当前连接状态（给 /state 和设置页看）。 */
  getStatus() {
    return { name: this.name, connected: false, mode: 'unknown' }
  }
}

/** 测试/扩展时用来确认一个对象是不是完整实现了接口。 */
export function assertTransport(transport) {
  const 必须 = ['start', 'stop', 'sendMessage', 'fetchHistory']
  for (const 名 of 必须) {
    if (!transport || typeof transport[名] !== 'function') {
      throw new Error(`Transport 缺少 ${名}()`)
    }
  }
  return true
}
