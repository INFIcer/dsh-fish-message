// 客户端设置页的冒烟测试。
//
// client.js 是 DSH 的浏览器端插件，平时只能在设置面板里跑。这里用假的
// window.__ModuleLoader__ / React / slots 把它加载起来、真的跑一遍 Section
// 渲染，专门抓「页面一打开就抛异常」的问题（例如 TDZ：const 声明写在使用之后，
// node --check 只查语法，查不出来）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const 仓库根 = fileURLToPath(new URL('..', import.meta.url))

/** 只够 client.js 用的假 React：createElement 返回普通对象，hooks 不执行副作用。 */
function 造React() {
  let 预设 = []
  let 序 = 0
  const 未设 = Symbol('未设')
  const 空函数 = () => {}

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(初值) {
      const i = 序
      序 += 1
      if (i < 预设.length && 预设[i] !== 未设) return [预设[i], 空函数]
      return [typeof 初值 === 'function' ? 初值() : 初值, 空函数]
    },
    useEffect() {},
    useMemo(计算) { return 计算() },
    useCallback(回调) { return 回调 },
    useRef(初值) { return { current: 初值 } },
  }

  return {
    React,
    /** 给第 n 个 useState 预设值；不传就按组件自己的初值渲染。 */
    设预设(值们) { 预设 = 值们 || []; 序 = 0 },
  }
}

/** 遍历假 React 的渲染结果，收集所有字符串内容（含 props 里的文字）。 */
function 收集文字(节点, 结果 = []) {
  if (节点 == null || typeof 节点 === 'boolean') return 结果
  if (typeof 节点 === 'string' || typeof 节点 === 'number') {
    结果.push(String(节点))
    return 结果
  }
  if (Array.isArray(节点)) {
    for (const 子 of 节点) 收集文字(子, 结果)
    return 结果
  }
  if (typeof 节点 === 'object') {
    const { props = {}, children = [] } = 节点
    for (const [键, 值] of Object.entries(props)) {
      if (键 === 'children' || 键 === 'style') continue
      if (typeof 值 === 'string' || typeof 值 === 'number') 结果.push(String(值))
      else if (Array.isArray(值)) 值.forEach((项) => 收集文字(项, 结果))
    }
    收集文字(children, 结果)
  }
  return 结果
}

/** 一条足够渲染整页的 /state 快照。 */
function 完整状态() {
  return {
    ok: true,
    version: '0.1.0',
    config: {
      napcatBaseUrl: 'http://127.0.0.1:3000',
      napcatToken: '***已设置***',
      wsEnabled: false,
      wsUrl: '',
      bindings: [{ qq: '10001', session: 'session-test-0001', name: '主人', enabled: true }],
      onlyInsideMarkers: true,
      forwardPaused: false,
      guardEnabled: true,
      guardStuckSeconds: 600,
      guardQqRemindTurns: 3,
      guardStuckPrompt: '',
      guardQqPrompt: '',
      backfillWindowHours: 24,
      outboxTtlHours: 24,
      outboxDedupMinutes: 10,
      outboxFlushIntervalMs: 10000,
      pollIntervalMs: 2000,
      historyIntervalMs: 60000,
      reorderBufferMs: 1500,
      historyCount: 100,
      maxImageMB: 10,
      maxVoiceMB: 20,
      requestTimeoutMs: 15000,
      stickerDir: 'C:/tmp/stickers',
      autoSaveStickers: false,
      stickerMaxCount: 2000,
      stickerMaxMB: 1024,
      sayVoice: 'dafeiyu',
      saySpeed: 1,
      transcribeInbound: true,
      asrLanguage: 'auto',
      describeInboundImages: 'inherit',
      inboundImagePrompt: '',
      logLevel: 'info',
    },
    defaults: {
      inboundImagePrompt: '描述这张图片',
      guardStuckPrompt: '默认长任务提醒',
      guardQqPrompt: '默认消息通道提醒',
    },
    bridge: {
      running: true,
      lastSyncAt: Date.now(),
      stats: {
        received: 3, delivered: 3, skippedOld: 0, errors: 0, lastError: '',
      },
      forward: { paused: false, pending: 0 },
    },
    transport: { online: true, mode: 'ws', lastError: '' },
    guard: {
      enabled: true,
      bound: 1,
      alerts: [],
      deniedTools: ['ask_user_question', 'wait_agent'],
      degraded: [],
    },
    outbox: {
      pending: 0, oldestAgeSec: 0, sentTotal: 1, failedTotal: 0, droppedTotal: 0, lastError: '',
    },
    sessions: [{ id: 'session-test-0001', title: '测试会话' }],
    stickers: { items: [], total: 0, stats: {}, tags: [] },
    ai: { installed: true, online: true, tts: true, asr: true, vision: true },
    stickerDir: 'C:/tmp/stickers',
    stickerDirExists: true,
    logs: [],
  }
}

/** 加载 client.js：先伪造 window.__ModuleLoader__.load，再拿 factory 调出来。 */
async function 加载客户端() {
  let 捕获 = null
  globalThis.window = {
    __ModuleLoader__: {
      load(定义) { 捕获 = 定义 },
    },
  }
  try {
    // 加查询串避开 ESM 模块缓存，保证每次测试都重新执行一遍 client.js。
    const 地址 = pathToFileURL(join(仓库根, 'client.js')).href + `?client-render=${Date.now()}`
    await import(地址)
  } finally {
    delete globalThis.window
  }
  assert.ok(捕获, 'client.js 应该调用 window.__ModuleLoader__.load')
  assert.equal(捕获.id, 'dsh-fish-message')

  const 假 = 造React()
  const 模块 = 捕获.factory((名字) => {
    assert.equal(名字, 'react')
    return 假.React
  })
  return { ...假, 模块 }
}

test('客户端设置页：加载态、完整状态、缺 defaults 都能渲染，不抛异常', async () => {
  const { React, 设预设, 模块 } = await 加载客户端()
  const 注册们 = []
  const slots = {
    inject(名, 注册器) { assert.equal(名, 'settings.section'); 注册器() },
    register(元, 组件) { 注册们.push({ 元, 组件 }); return () => {} },
  }

  assert.equal(typeof 模块.apply, 'function')
  模块.apply({ get: (名) => (名 === 'slots' ? slots : undefined) })
  assert.equal(注册们.length, 1, '应该注册一个设置区块')
  const 组件 = 注册们[0].组件

  const 渲染 = (态) => {
    设预设([态])
    return 组件()
  }

  // a) 还没拉到 /state 的加载态。
  assert.doesNotThrow(() => 渲染(null))

  // b) 完整状态：整页渲染一遍，并确认新加的两行文案确实在输出里。
  let 完整
  assert.doesNotThrow(() => { 完整 = 渲染(完整状态()) })
  const 文字 = 收集文字(完整).join('\n')
  assert.match(文字, /长任务提醒提示词/)
  assert.match(文字, /消息通道提醒提示词/)
  assert.match(文字, /防失联/)

  // c) 老版本 /state 没有 defaults：占位文字为空也不能炸。
  const 无默认 = 完整状态()
  delete 无默认.defaults
  assert.doesNotThrow(() => 渲染(无默认))

  // 配置里未设置的提醒提示词走空串分支；默认文案缺失时也不能抛。
  const 空文案 = 完整状态()
  空文案.defaults = {}
  空文案.config.guardStuckPrompt = '自定义长任务'
  assert.doesNotThrow(() => 渲染(空文案))
})

test('客户端设置页：默认文案常量声明在第一次使用之前（防 TDZ 白屏）', () => {
  const 源 = readFileSync(join(仓库根, 'client.js'), 'utf8').split(/\r?\n/)
  for (const 名 of ['默认长任务提醒', '默认消息通道提醒', '默认识图提示词']) {
    const 声明 = 源.findIndex((行) => 行.includes(`const ${名} =`))
    assert.ok(声明 >= 0, `${名} 应该有 const 声明`)
    const 首次引用 = 源.findIndex((行, i) => i !== 声明 && 行.includes(名))
    assert.ok(首次引用 >= 0, `${名} 应该被用到`)
    assert.ok(
      声明 < 首次引用,
      `${名} 在第 ${声明 + 1} 行声明，但第 ${首次引用 + 1} 行就用了；这会在打开设置页时抛 TDZ、整页白屏`,
    )
  }
})
