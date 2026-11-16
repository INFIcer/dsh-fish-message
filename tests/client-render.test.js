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

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** 只够 client.js 用的假 React：createElement 返回普通对象，hooks 不执行副作用。 */
function makeReact() {
  let preset = []
  let order = 0
  const unset = Symbol('未设')
  const emptyFunc = () => {}

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initialValue) {
      const i = order
      order += 1
      if (i < preset.length && preset[i] !== unset) return [preset[i], emptyFunc]
      return [typeof initialValue === 'function' ? initialValue() : initialValue, emptyFunc]
    },
    useEffect() {},
    useMemo(compute) { return compute() },
    useCallback(callback) { return callback },
    useRef(initialValue) { return { current: initialValue } },
  }

  return {
    React,
    /** 给第 n 个 useState 预设值；不传就按组件自己的初值渲染。 */
    setPreset(values) { preset = values || []; order = 0 },
  }
}

/** 遍历假 React 的渲染结果，收集所有字符串内容（含 props 里的文字）。 */
function collectText(node, result = []) {
  if (node == null || typeof node === 'boolean') return result
  if (typeof node === 'string' || typeof node === 'number') {
    result.push(String(node))
    return result
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, result)
    return result
  }
  if (typeof node === 'object') {
    const { props = {}, children = [] } = node
    for (const [key, value] of Object.entries(props)) {
      if (key === 'children' || key === 'style') continue
      if (typeof value === 'string' || typeof value === 'number') result.push(String(value))
      else if (Array.isArray(value)) value.forEach((item) => collectText(item, result))
    }
    collectText(children, result)
  }
  return result
}

/** 一条足够渲染整页的 /state 快照。 */
function fullState() {
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
      memoryExtension: false,
      memoryCompareImages: true,
      memoryCompareVoices: true,
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
    memory: { service: false, localAI: true },
    stickerDir: 'C:/tmp/stickers',
    stickerDirExists: true,
    logs: [],
  }
}

/** 加载 client.js：先伪造 window.__ModuleLoader__.load，再拿 factory 调出来。 */
async function loadClient() {
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) { captured = definition },
    },
  }
  try {
    // 加查询串避开 ESM 模块缓存，保证每次测试都重新执行一遍 client.js。
    const address = pathToFileURL(join(repoRoot, 'client.js')).href + `?client-render=${Date.now()}`
    await import(address)
  } finally {
    delete globalThis.window
  }
  assert.ok(captured, 'client.js 应该调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-fish-message')

  const fake = makeReact()
  const module = captured.factory((name) => {
    assert.equal(name, 'react')
    return fake.React
  })
  return { ...fake, module }
}

test('客户端设置页：加载态、完整状态、缺 defaults 都能渲染，不抛异常', async () => {
  const { React, setPreset, module } = await loadClient()
  const registrations = []
  const slots = {
    inject(name, registrar) { assert.equal(name, 'settings.section'); registrar() },
    register(mod, component) { registrations.push({ mod, component }); return () => {} },
  }

  assert.equal(typeof module.apply, 'function')
  module.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  assert.equal(registrations.length, 1, '应该注册一个设置区块')
  const component = registrations[0].component

  const render = (state) => {
    setPreset([state])
    return component()
  }

  // a) 还没拉到 /state 的加载态。
  assert.doesNotThrow(() => render(null))

  // b) 完整状态：整页渲染一遍，并确认新加的两行文案确实在输出里。
  let complete
  assert.doesNotThrow(() => { complete = render(fullState()) })
  const plainText = collectText(complete).join('\n')
  assert.match(plainText, /长任务提醒提示词/)
  assert.match(plainText, /消息通道提醒提示词/)
  assert.match(plainText, /防失联/)
  // 记忆扩展卡片：三个开关与两条状态行都要渲染出来。
  assert.match(plainText, /记忆扩展/)
  assert.match(plainText, /比对图像/)
  assert.match(plainText, /比对声纹/)
  assert.match(plainText, /记忆服务：未检测到（需要安装并启用记忆插件）/)
  assert.match(plainText, /本地 AI：可用/)

  // 老版本 /state 没有 memory 字段：状态行退回 ai.online，不炸。
  const noMemory = fullState()
  delete noMemory.memory
  assert.doesNotThrow(() => render(noMemory))

  // c) 老版本 /state 没有 defaults：占位文字为空也不能炸。
  const noDefault = fullState()
  delete noDefault.defaults
  assert.doesNotThrow(() => render(noDefault))

  // 配置里未设置的提醒提示词走空串分支；默认文案缺失时也不能抛。
  const emptyCopy = fullState()
  emptyCopy.defaults = {}
  emptyCopy.config.guardStuckPrompt = '自定义长任务'
  assert.doesNotThrow(() => render(emptyCopy))
})

test('客户端设置页：默认文案常量声明在第一次使用之前（防 TDZ 白屏）', () => {
  const source = readFileSync(join(repoRoot, 'client.js'), 'utf8').split(/\r?\n/)
  for (const name of ['defaultLongTaskReminder', 'defaultMessageChannelReminder', 'defaultImagePrompt']) {
    const declare = source.findIndex((row) => row.includes(`const ${name} =`))
    assert.ok(declare >= 0, `${name} 应该有 const 声明`)
    const firstSaveReference = source.findIndex((row, i) => i !== declare && row.includes(name))
    assert.ok(firstSaveReference >= 0, `${name} 应该被用到`)
    assert.ok(
      declare < firstSaveReference,
      `${name} 在第 ${declare + 1} 行声明，但第 ${firstSaveReference + 1} 行就用了；这会在打开设置页时抛 TDZ、整页白屏`,
    )
  }
})
