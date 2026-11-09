// dsh-fish-message · 宿主入口
//
// 这个文件只做四件事：
//   1. 读配置、状态、日志，组装 transport / voice / delivery / bridge；
//   2. 挂 DSH 的 session/event 监听（出站）和 webServer 路由（设置页 / 诊断）；
//   3. 提供 /dsh-fish-message/state、/health、/save、/test-send、/test-voice；
//   4. 把生命周期挂到 ctx.effect 上，插件卸载时干净停掉。
//
// 所有真正的逻辑都在 lib/ 里，宿主层保持薄，方便单测。

import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigStore, buildConfigSchema, publicConfig } from './config.js'
import { Logger } from './logger.js'
import { StateStore } from './storage.js'
import { Outbox } from './outbox.js'
import { NapCatOneBotTransport } from './transport/napcat-onebot.js'
import { VoiceService } from './voice.js'
import { Delivery } from './delivery.js'
import { Bridge } from './bridge.js'

const 包根 = join(dirname(fileURLToPath(import.meta.url)), '..')
const 家目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 路由前缀 = '/dsh-fish-message'

export const name = 'fish-message'
export const inject = ['agents', 'sessions', 'sessionTitle', 'webServer', 'workspaceRegistry', 'attachments']

const 版本 = (() => {
  try {
    return String(JSON.parse(readFileSync(join(包根, 'package.json'), 'utf8')).version || '0.1.0')
  } catch {
    return '0.1.0'
  }
})()

// schemastery 是可选依赖：拿不到时 Config 为 undefined，插件照常加载（配置仍走 json）。
let schemastery = null
try {
  schemastery = (await import('@deepseek-ai/schemastery')).default
} catch {
  // 不打印错误：这是正常的降级路径。
}
export const Config = schemastery ? buildConfigSchema(schemastery) : undefined

const 会话键 = (id) => {
  const s = String(id == null ? '' : id).trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

function 读体(req) {
  return new Promise((resolve) => {
    let 文 = ''
    let 超 = false
    req.on('data', (块) => {
      if (超) return
      文 += 块
      if (文.length > 2 * 1024 * 1024) {
        超 = true
        resolve({})
      }
    })
    req.on('end', () => {
      if (超) return
      try { resolve(JSON.parse(文 || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function 查询(req) {
  try {
    return new URL(String(req?.url || '/'), 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function 要方法(req, res, 方法) {
  const 来 = String(req?.method || 'GET').toUpperCase()
  if (来 === 方法) return true
  回(res, 405, { ok: false, error: 'method_not_allowed', detail: `这个接口只支持 ${方法}` })
  return false
}

function 回(res, code, data) {
  try {
    res.statusCode = code
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.end?.(JSON.stringify(data))
  } catch {
    // 客户端已经断开就算了。
  }
}

function 安全文本(v, 最大 = 300) {
  return String(v == null ? '' : v).slice(0, 最大)
}

export function apply(ctx, pluginConfig) {
  mkdirSync(家目录, { recursive: true })

  const 配置文件 = join(家目录, 'fish-message-config.json')
  const 状态文件 = join(家目录, 'fish-message-state.json')
  const 日志文件 = join(家目录, 'fish-message.log')
  const 出站文件 = join(家目录, 'fish-message-outbox.json')
  const 收件箱 = join(家目录, 'fish-message-inbox')
  const 发件箱 = join(家目录, 'fish-message-outbox')
  const 旧配置 = join(家目录, 'qq-bridge-config.json')
  const 旧状态 = join(家目录, 'qq-bridge-state.json')

  const configStore = new ConfigStore({ homeDir: 家目录, legacyPath: 旧配置 })
  let config = configStore.load(pluginConfig)
  const logger = new Logger({ filePath: 日志文件, level: config.logLevel })
  const store = new StateStore({ homeDir: 家目录, legacyStatePath: 旧状态 })
  const outbox = new Outbox({ homeDir: 家目录, getConfig: () => config, logger, store })

  // 如果是从旧桥切过来：把旧桥的「看到哪儿了」和已转 id 搬过来。
  // 旧文件只读，不删不改，方便回滚。
  for (const b of config.bindings) {
    try {
      const 迁移 = store.migrateLegacy(b.qq)
      if (迁移.timestamp || 迁移.ids) {
        logger.info(`从旧桥搬到 ${b.qq} 的水位：${迁移.timestamp || '无'}，已转 id ${迁移.ids} 个`)
      }
    } catch (error) {
      logger.warn(`搬旧桥状态失败（不影响启动）：${安全文本(error?.message || error)}`)
    }
  }

  const transport = new NapCatOneBotTransport({ getConfig: () => config, logger })
  const voice = new VoiceService({ getConfig: () => config, logger, transport, inboxDir: 收件箱, outboxDir: 发件箱 })
  const delivery = new Delivery({ ctx, logger })
  const bridge = new Bridge({ getConfig: () => config, transport, store, logger, voice, delivery, outbox })

  logger.info(`dsh-fish-message v${版本} 正在启动｜配置：${配置文件}｜绑定 ${config.bindings.length} 条`)

  // 生命周期：启动桥；卸载时停 WS / 定时器。
  const 生命 = ctx.effect(() => {
    void bridge.start().catch((error) => logger.error(`桥启动失败：${安全文本(error?.message || error)}`))
    return () => { void bridge.stop() }
  }, 'fish-message: 启停 QQ 私聊桥')

  // 出站：盯绑定会话的 assistant 消息和 turn/end。
  const 摘监听 = ctx.effect(() => {
    const 摘 = ctx.on('session/event', (session, event) => {
      try {
        bridge.onSessionEvent(session, event)
      } catch (error) {
        logger.warn(`处理会话事件出错：${安全文本(error?.message || error)}`)
      }
    })
    return () => {
      try { if (typeof 摘 === 'function') 摘() } catch { /* 忽略 */ }
    }
  }, 'fish-message: 盯绑定会话的回复')

  /** 现在活着的会话（设置页挑绑定用）。 */
  function 会话清单() {
    const 出 = []
    try {
      const 服务 = ctx.get('sessions')
      const 标题服务 = ctx.get('sessionTitle')
      const 登记 = ctx.get('workspaceRegistry')
      const 归档 = new Set(((登记 && 登记.archivedSessionIds) || []).map(String))
      const 列表 = 服务 && typeof 服务.list === 'function' ? 服务.list() : []
      for (const s of 列表 || []) {
        const id = String(s?.id || s?.sessionId || '')
        if (!id || 归档.has(id) || 归档.has(会话键(id))) continue
        let 标题 = ''
        try {
          const 快照 = 标题服务 && typeof 标题服务.get === 'function' ? 标题服务.get(s) : undefined
          标题 = 快照 && 快照.title ? String(快照.title) : ''
        } catch { /* 没标题就空着 */ }
        出.push({ id, title: 标题 || `…${id.slice(-8)}` })
      }
    } catch (error) {
      logger.debug(`读会话清单失败：${安全文本(error?.message || error)}`)
    }
    return 出
  }

  function 状态() {
    const 清单 = 会话清单()
    const 标题表 = new Map(清单.map((x) => [会话键(x.id), x.title]))
    const b = bridge.state()
    return {
      ok: true,
      version: 版本,
      configFile: 配置文件,
      stateFile: 状态文件,
      outboxFile: 出站文件,
      logFile: 日志文件,
      inboxDir: 收件箱,
      config: publicConfig(config),
      bridge: b,
      transport: b.transport,
      bindings: (config.bindings || []).map((x) => ({
        ...x,
        会话标题: 标题表.get(会话键(x.session)) || '',
        活着: 清单.some((y) => 会话键(y.id) === 会话键(x.session)),
      })),
      sessions: 清单,
      logs: logger.recent(200),
      ts: Date.now(),
    }
  }

  async function 重启桥() {
    await bridge.stop()
    await bridge.start()
  }

  const 路线 = (路径, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: 路径,
    handler: async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        logger.error(`路由 ${路径} 出错：${安全文本(error?.message || error, 500)}`)
        回(res, 500, { ok: false, error: 安全文本(error?.message || error, 500) })
      }
    },
  }), `fish-message: ${路径}`)

  // 前缀路由：DELETE /outbox/{id} 这种带路径参数的接口用。
  const 前缀路线 = (路径, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: 路径,
    handler: async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        logger.error(`路由 ${路径}* 出错：${安全文本(error?.message || error, 500)}`)
        回(res, 500, { ok: false, error: 安全文本(error?.message || error, 500) })
      }
    },
  }), `fish-message: ${路径}*`)

  路线(`${路由前缀}/state`, async (_req, res) => {
    回(res, 200, 状态())
  })

  路线(`${路由前缀}/health`, async (_req, res) => {
    const 桥 = bridge.state()
    const 在 = Boolean(桥?.running)
    回(res, 在 ? 200 : 503, {
      ok: 在,
      version: 版本,
      transport: 桥?.transport || null,
      bindings: (config.bindings || []).length,
      queueSize: 桥?.queueSize || 0,
      outboxPending: 桥?.outbox?.pending || 0,
      lastSyncAt: 桥?.lastSyncAt || 0,
      lastError: 桥?.lastSyncError || 桥?.stats?.lastError || '',
    })
  })

  路线(`${路由前缀}/save`, async (req, res) => {
    const 来 = await 读体(req)
    const 补丁 = 来 && typeof 来.config === 'object' ? 来.config : 来
    const 旧 = config
    const 合并 = { ...config, ...(补丁 && typeof 补丁 === 'object' ? 补丁 : {}) }
    // 设置页显示的是打码后的令牌；原样提交回来时保留旧令牌。
    if (合并.napcatToken === '***已设置***') 合并.napcatToken = 旧.napcatToken

    const 保存 = configStore.save(合并)
    if (!保存) {
      回(res, 500, { ok: false, error: `写不进配置文件：${配置文件}` })
      return
    }
    const 连接变了 = 保存.napcatBaseUrl !== 旧.napcatBaseUrl
      || 保存.wsUrl !== 旧.wsUrl
      || 保存.napcatToken !== 旧.napcatToken
      || 保存.wsEnabled !== 旧.wsEnabled
      || 保存.pollIntervalMs !== 旧.pollIntervalMs
    config = 保存
    logger.setLevel(config.logLevel)
    logger.info(`设置已保存：绑定 ${config.bindings.length} 条｜只发标记内 ${config.onlyInsideMarkers ? '开' : '关'}｜补投窗口 ${config.backfillWindowHours} 小时`)
    if (连接变了) {
      logger.info('连接参数变了，正在重启传输层…')
      await 重启桥()
    } else {
      bridge.updateConfig()
    }
    回(res, 200, { ok: true, message: '保存好了', ...状态() })
  })

  路线(`${路由前缀}/test-send`, async (req, res) => {
    const 来 = await 读体(req)
    try {
      const 结果 = await bridge.testSend(来.qq)
      回(res, 200, { ok: true, ...结果 })
    } catch (error) {
      回(res, 400, { ok: false, error: 安全文本(error?.message || error, 500) })
    }
  })

  路线(`${路由前缀}/test-voice`, async (req, res) => {
    const 来 = await 读体(req)
    try {
      const 结果 = await bridge.testVoice(来.qq)
      回(res, 200, { ok: true, ...结果 })
    } catch (error) {
      回(res, 400, { ok: false, error: 安全文本(error?.message || error, 500) })
    }
  })

  路线(`${路由前缀}/logs`, async (_req, res) => {
    回(res, 200, { ok: true, logs: logger.recent(200) })
  })

  // ---------------- 出站队列接口 ----------------

  路线(`${路由前缀}/outbox`, async (req, res) => {
    if (!要方法(req, res, 'GET')) return
    const 限制 = Number(查询(req).get('limit')) || 50
    回(res, 200, { ok: true, ...bridge.listOutbox({ limit: 限制 }) })
  })

  路线(`${路由前缀}/outbox/flush`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    const 结果 = await bridge.flushOutbox('manual', { force: true })
    回(res, 结果.ok ? 200 : 503, 结果)
  })

  路线(`${路由前缀}/outbox/clear`, async (req, res) => {
    if (!要方法(req, res, 'POST')) return
    回(res, 200, { ok: true, ...bridge.clearOutbox() })
  })

  前缀路线(`${路由前缀}/outbox/`, async (req, res) => {
    if (!要方法(req, res, 'DELETE')) return
    let 标识 = ''
    try {
      标识 = decodeURIComponent(new URL(String(req.url || '/'), 'http://127.0.0.1').pathname.slice(`${路由前缀}/outbox/`.length))
    } catch {
      标识 = ''
    }
    if (!标识 || 标识.includes('/')) {
      回(res, 404, { ok: false, error: 'not_found', detail: '没有这个出站队列条目' })
      return
    }
    const 结果 = bridge.dropOutbox(标识)
    if (!结果.deleted) {
      回(res, 404, { ok: false, error: 'not_found', detail: `出站队列里没有 ${标识}` })
      return
    }
    回(res, 200, { ok: true, ...结果 })
  })

  // 启动完成后把状态打进日志，方便没有设置页时也能从文件排查。
  setTimeout(() => {
    try {
      const 状 = bridge.state()
      logger.info(`连接状态：${状.transport?.mode || '未知'}｜在线 ${状.transport?.connected ? '是' : '否'}｜收件队列 ${状.queueSize}｜出站积压 ${状.outbox?.pending || 0}`)
    } catch { /* 忽略 */ }
  }, 1500)

  return { bridge, outbox, logger, configStore, store, transport, voice, delivery, 停: async () => {
    try { 生命?.() } catch { /* 忽略 */ }
    try { 摘监听?.() } catch { /* 忽略 */ }
    await bridge.stop()
  } }
}

export { 版本 as version, 路由前缀 }
