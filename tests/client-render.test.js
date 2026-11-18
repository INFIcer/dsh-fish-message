// 客户端冒烟测试：设置页 Section + 设置内图库弹窗。
//
// client.js 是 DSH 的浏览器端插件，平时只能在 Web 客户端里跑。这里用假的
// window.__ModuleLoader__ / React / slots 把它加载起来、真的跑一遍渲染，
// 专门抓「页面一打开就抛异常」的问题（例如 TDZ：const 声明写在使用之后，
// node --check 只查语法，查不出来），以及注册面、设置内弹窗与统一交互。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function depsChanged(previous, next) {
  if (previous === undefined || next === undefined) return true
  if (previous.length !== next.length) return true
  return previous.some((value, index) => !Object.is(value, next[index]))
}

/**
 * 迷你 React 运行时：支持 useState / useRef / useEffect（含依赖比较与清理），
 * 每次状态变化后重跑整棵树，够测「点一下按钮界面真的变了」。
 * effects=false 时只占位不执行，避免设置页的轮询/请求干扰断言。
 */
function makeRuntime() {
  const records = new Map()
  const presets = new Map()
  let rootType = null
  let rootProps = {}
  let tree = null
  let current = null
  let index = 0
  let pending = false
  let effectQueue = []
  let effectsEnabled = true
  let focusCalls = 0

  function expand(node, path, visited) {
    if (Array.isArray(node)) return node.map((child, i) => expand(child, path + '/' + i, visited))
    if (node === null || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      const name = node.type.name || 'Anonymous'
      // 模拟 React 的 key：key 变了就是卸载重挂，状态不继承。
      const key = path + '@' + name + (node.props && node.props.key !== undefined ? '#' + String(node.props.key) : '')
      let record = records.get(key)
      if (!record) {
        record = { name, hooks: [] }
        records.set(key, record)
      }
      visited.add(key)
      const previousRecord = current
      const previousIndex = index
      current = record
      index = 0
      const output = node.type(node.props)
      current = previousRecord
      index = previousIndex
      return expand(output, key, visited)
    }
    const expanded = { ...node, children: (node.children || []).map((child, i) => expand(child, path + '/' + i, visited)) }
    // 迷你运行时没有真实 DOM：给 ref 挂一个可调用的假节点，用来验证弹窗打开时确实聚焦了面板。
    if (node.props && node.props.ref && node.props.ref.current == null) {
      node.props.ref.current = {
        focus() { focusCalls += 1 },
        click() {},
      }
    }
    return expanded
  }

  function render() {
    effectQueue = []
    const visited = new Set()
    const result = expand({ type: rootType, props: rootProps, children: [] }, '', visited)
    tree = result
    for (const [key, record] of [...records.entries()]) {
      if (visited.has(key)) continue
      for (const hook of record.hooks) {
        if (hook && hook.kind === 'effect' && typeof hook.cleanup === 'function') {
          try { hook.cleanup() } catch { /* 清理失败不影响测试 */ }
        }
      }
      records.delete(key)
    }
    return result
  }

  function flush() {
    let guard = 0
    while (guard < 20) {
      guard += 1
      if (effectQueue.length) {
        const queue = effectQueue
        effectQueue = []
        for (const item of queue) {
          if (typeof item.old === 'function') {
            try { item.old() } catch { /* 清理失败不影响测试 */ }
          }
          const cleanup = item.fn()
          item.hook.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        }
      }
      if (!pending) break
      pending = false
      tree = render()
    }
    return tree
  }

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const merged = { ...(props || {}) }
      if (children.length) merged.children = children.length === 1 ? children[0] : children
      return { type, props: merged, children }
    },
    useState(initialValue) {
      const record = current
      const i = index
      index += 1
      if (!record.hooks[i]) {
        const preset = presets.get(record.name)
        const value = preset && i < preset.length && preset[i] !== undefined
          ? preset[i]
          : (typeof initialValue === 'function' ? initialValue() : initialValue)
        record.hooks[i] = { kind: 'state', value }
      }
      const hook = record.hooks[i]
      return [hook.value, (next) => {
        const value = typeof next === 'function' ? next(hook.value) : next
        if (!Object.is(value, hook.value)) {
          hook.value = value
          pending = true
        }
      }]
    },
    useRef(initialValue) {
      const record = current
      const i = index
      index += 1
      if (!record.hooks[i]) record.hooks[i] = { kind: 'ref', value: { current: initialValue } }
      return record.hooks[i].value
    },
    useEffect(fn, deps) {
      const record = current
      const i = index
      index += 1
      let hook = record.hooks[i]
      if (!hook) {
        hook = { kind: 'effect', deps: undefined, cleanup: undefined, first: true }
        record.hooks[i] = hook
      }
      const changed = hook.first || depsChanged(hook.deps, deps)
      hook.first = false
      if (!changed) return
      hook.deps = deps
      const old = hook.cleanup
      hook.cleanup = undefined
      if (effectsEnabled) effectQueue.push({ hook, fn, old })
    },
    useMemo(compute) { return compute() },
    useCallback(callback) { return callback },
  }

  function mount(type, props = {}) {
    // 每次 mount 都是一次全新挂载：清掉上一次的组件状态与副作用，相当于刷新页面。
    for (const record of records.values()) {
      for (const hook of record.hooks) {
        if (hook && hook.kind === 'effect' && typeof hook.cleanup === 'function') {
          try { hook.cleanup() } catch { /* 清理失败不影响测试 */ }
        }
      }
    }
    records.clear()
    pending = false
    effectQueue = []
    rootType = type
    rootProps = props
    tree = render()
    return flush()
  }

  return {
    React,
    mount,
    flush,
    /** 换根 props 重新渲染（同一个组件实例，hooks 保留）：用来测「会话切换」这类 props 变化。 */
    setProps(next) {
      rootProps = { ...rootProps, ...(next || {}) }
      pending = true
      return flush()
    },
    presetFor(name, values) { presets.set(name, values || []) },
    setEffects(enabled) { effectsEnabled = !!enabled },
    focusCount() { return focusCalls },
  }
}

/** 遍历渲染结果，收集所有字符串内容（含 props 里的文字）。 */
function collectText(node, result = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return result
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

/** 深度优先找出所有满足条件的元素。 */
function findAll(node, predicate, output = []) {
  if (node === null || typeof node !== 'object') return output
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, output)
    return output
  }
  if (predicate(node)) output.push(node)
  for (const child of node.children || []) findAll(child, predicate, output)
  return output
}

/** 按按钮里的可见文字找按钮（props 里的 type 等属性不算）。 */
function findButton(root, text) {
  return findAll(root, (node) => node.type === 'button' && collectText(node.children).join('') === text)
}

/** 按 aria-label 找元素（关闭按钮、确认框等）。 */
function findByLabel(root, label) {
  return findAll(root, (node) => node.props && node.props['aria-label'] === label)
}

function textOf(node) {
  return collectText(node).join('\n')
}

/** 一条足够渲染整页的 /state 快照。 */
function fullState() {
  return {
    ok: true,
    version: '0.2.3',
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
      inboundEditWindowMs: 15000,
      outboxPerMessageDelayMs: 2000,
      outboxPerCharDelayMs: 100,
      historyCount: 100,
      maxImageMB: 10,
      maxVoiceMB: 20,
      requestTimeoutMs: 15000,
      stickerDir: 'C:/tmp/stickers',
      autoSaveStickers: false,
      stickerMaxCount: 2000,
      stickerMaxMB: 1024,
      stickerMaxFileMB: 64,
      sayVoice: 'dafeiyu',
      saySpeed: 1,
      transcribeInbound: true,
      asrLanguage: 'auto',
      describeInboundImages: 'inherit',
      inboundImagePrompt: '',
      memoryExtension: false,
      memoryCompareImages: true,
      memoryCompareVoices: true,
      imageLibraryEnabled: true,
      imageLibraryMaxItems: 1000,
      imageLibraryMaxMB: 512,
      imageLibraryKeepFiles: true,
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
    imageDir: 'C:/tmp/fish-message-images',
    images: { count: 0, withDesc: 0, hits: 0, sizeMB: 0 },
    logs: [],
  }
}

/** 一条收图图库条目：既有原图也有描述。 */
function imageEntry() {
  return {
    sha256: 'a'.repeat(64),
    file: 'img/aa/x.png',
    path: 'C:/tmp/fish-message-images/img/aa/x.png',
    desc: '一只猫',
    descSource: 'local',
    bytes: 1024,
    width: 10,
    height: 20,
    hits: 2,
    firstSeenAt: '2026-11-16T12:00:00',
  }
}

/** 一条表情库条目。 */
function stickerEntry() {
  return {
    id: 'abcdef012345',
    file: 'gif/cat.gif',
    path: 'C:/tmp/stickers/gif/cat.gif',
    desc: '打哈欠的猫',
    tags: ['睡觉', '猫'],
    width: 100,
    height: 100,
    size_kb: 12,
    used_count: 3,
    added_at: '2026-11-15T10:00:00',
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
    const address = pathToFileURL(join(repoRoot, 'client.js')).href + '?client-render=' + Date.now()
    await import(address)
  } finally {
    delete globalThis.window
  }
  assert.ok(captured, 'client.js 应该调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-fish-message')

  const runtime = makeRuntime()
  const module = captured.factory((name) => {
    assert.equal(name, 'react')
    return runtime.React
  })
  return { ...runtime, module }
}

/** 注册 slot，返回可渲染设置页与弹窗组件的测试环境。 */
async function setupPlugin() {
  const env = await loadClient()
  const bySlot = new Map()
  const slots = {
    inject(name, registrar) {
      assert.ok(typeof registrar === 'function', name + ' 需要注册函数')
      registrar()
    },
    register(mod, component) {
      assert.ok(mod && typeof mod.name === 'string', 'slot 注册要有 name')
      const list = bySlot.get(mod.name) || []
      list.push({ mod, component })
      bySlot.set(mod.name, list)
      return () => {}
    },
  }
  env.module.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  const section = (bySlot.get('settings.section') || [])[0]?.component
  return {
    ...env,
    bySlot,
    section,
    renderSection(values) {
      env.presetFor('Section', values)
      env.setEffects(false)
      return env.mount(section, {})
    },
    renderComponent(component, props, presets = {}) {
      for (const [name, values] of Object.entries(presets)) env.presetFor(name, values)
      env.setEffects(false)
      return env.mount(component, props)
    },
  }
}

test('客户端设置页：加载态、完整状态、缺 defaults 都能渲染，不抛异常', async () => {
  const env = await setupPlugin()

  // a) 还没拉到 /state 的加载态。
  assert.doesNotThrow(() => env.renderSection([null]))

  // b) 完整状态：整页渲染一遍，并确认关键文案确实在输出里。
  let complete
  assert.doesNotThrow(() => { complete = env.renderSection([fullState()]) })
  const plainText = textOf(complete)
  assert.match(plainText, /长任务提醒提示词/)
  assert.match(plainText, /消息通道提醒提示词/)
  assert.match(plainText, /防失联/)
  assert.match(plainText, /记忆扩展/)
  assert.match(plainText, /比对图像/)
  assert.match(plainText, /比对声纹/)
  assert.match(plainText, /记忆服务：未检测到（需要安装并启用记忆插件）/)
  assert.match(plainText, /本地 AI：可用/)
  assert.match(plainText, /收图先查图库/)
  // 入站编辑窗口与出站节奏两个新设置项要渲染出来。
  assert.match(plainText, /编辑窗口（秒）/)
  assert.match(plainText, /发送间隔（毫秒）/)
  assert.match(plainText, /按字数追加间隔（毫秒）/)

  // 老版本 /state 没有 memory 字段：状态行退回 ai.online，不炸。
  const noMemory = fullState()
  delete noMemory.memory
  assert.doesNotThrow(() => env.renderSection([noMemory]))

  // c) 老版本 /state 没有 defaults：占位文字为空也不能炸。
  const noDefault = fullState()
  delete noDefault.defaults
  assert.doesNotThrow(() => env.renderSection([noDefault]))

  // 配置里未设置的提醒提示词走空串分支；默认文案缺失时也不能抛。
  const emptyCopy = fullState()
  emptyCopy.defaults = {}
  emptyCopy.config.guardStuckPrompt = '自定义长任务'
  assert.doesNotThrow(() => env.renderSection([emptyCopy]))
})

test('注册：设置分区 + 模型选择器左侧渠道按钮，不再有主面板与侧边栏入口', async () => {
  const env = await setupPlugin()
  assert.deepEqual(env.module.inject, ['slots'])

  const settings = env.bySlot.get('settings.section') || []
  assert.equal(settings.length, 1)
  assert.equal(settings[0].mod.id, 'fish-message')
  assert.equal(settings[0].mod.order, 56)
  assert.equal(typeof settings[0].mod.label, 'function')
  assert.equal(settings[0].mod.label(), '鱼讯')
  assert.equal(typeof settings[0].component, 'function')

  // 模型选择器左侧：order 取大值排在这一簇末尾，每个会话一个收发渠道入口。
  const inputRight = env.bySlot.get('conversation.input.right') || []
  assert.equal(inputRight.length, 1)
  assert.equal(inputRight[0].mod.id, 'fish-bind')
  assert.equal(inputRight[0].mod.order, 200)
  assert.equal(typeof inputRight[0].mod.label, 'function')
  assert.equal(inputRight[0].mod.label(), '收发渠道')
  assert.equal(typeof inputRight[0].component, 'function')

  assert.equal(env.bySlot.get('main'), undefined, '不应再注册 main 主面板')
  assert.equal(env.bySlot.get('sidebar.panellist'), undefined, '不应再注册侧边栏入口')
  assert.deepEqual([...env.bySlot.keys()].sort(), ['conversation.input.right', 'settings.section'])

  // package.json 的客户端注入声明必须与代码一致。
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.dsh.client.inject, ['slots'])
})

/** 输入框旁渠道按钮的假 fetch：只回 /state 与 /bindings/assign；成功的绑定会更新后续 /state。 */
function stubBindFetch({ bindings = [], onAssign } = {}) {
  const calls = []
  const original = globalThis.fetch
  let state = bindings
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url)
    calls.push({ url: address, options: options })
    if (address.endsWith('/state')) {
      return { json: async () => ({ ok: true, bindings: state, sessions: [] }) }
    }
    if (address.endsWith('/bindings/assign')) {
      const body = JSON.parse(options.body || '{}')
      const result = onAssign ? await onAssign(body) : { ok: true, bindings: state }
      if (result && result.ok && Array.isArray(result.bindings)) state = result.bindings
      return { json: async () => result }
    }
    return { json: async () => ({ ok: false, error: 'unexpected' }) }
  }
  return {
    calls,
    restore() { globalThis.fetch = original },
  }
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 渠道胶囊按钮（输入框旁唯一带 fish-bind-trigger 的按钮）。 */
function channelTrigger(tree) {
  return findAll(tree, (node) => node.type === 'button' && node.props && node.props.className === 'fish-bind-trigger')[0]
}

/** 向上弹出的菜单；关着时为 undefined。 */
function channelMenu(tree) {
  return findAll(tree, (node) => node.props && node.props.role === 'listbox')[0]
}

/** 菜单里的选项（按渲染顺序：不绑定在最前）。 */
function channelOptions(tree) {
  const menu = channelMenu(tree)
  return menu ? findAll(menu, (node) => node.props && node.props.role === 'option') : []
}

/** 只取节点里真正显示的文字，不把 className/title 之类的属性算进来。 */
function visibleText(node, result = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return result
  if (typeof node === 'string' || typeof node === 'number') {
    result.push(String(node))
    return result
  }
  if (Array.isArray(node)) {
    for (const child of node) visibleText(child, result)
    return result
  }
  if (typeof node === 'object') {
    for (const child of node.children || []) visibleText(child, result)
  }
  return result
}

/** 按钮上可见的文字：当前选中项（称呼 + QQ），没有静态标题。 */
function channelTriggerText(tree) {
  const trigger = channelTrigger(tree)
  if (!trigger) return ''
  return findAll(trigger, (node) => node.type === 'span' && /fish-bind-(title|current)/.test(String((node.props || {}).className || '')))
    .map((node) => visibleText(node.children).join(''))
    .join(' ')
}

/** 选项的可见文字（不看 aria/title 这类属性）。 */
function channelOptionLabel(node) {
  const text = findAll(node, (child) => child.props && child.props.className === 'fish-bind-item-text')[0]
  return text ? visibleText(text.children).join('') : ''
}

/** 挂上组件并等 /state 回来，返回渲染结果。 */
async function mountBindChannel(env, props) {
  const { BindChannel } = env.module.__test
  env.setEffects(true)
  env.mount(BindChannel, props)
  await nextTick()
  return env.flush()
}

/** 点触发按钮打开菜单，并等打开时那次 /state 校准回来。 */
async function openChannelMenu(env) {
  channelTrigger(env.flush()).props.onClick({})
  env.flush()
  await nextTick()
  return env.flush()
}

/** 点菜单里可见文字等于 label 的那一项。 */
function pickChannel(tree, label) {
  const option = channelOptions(tree).find((node) => channelOptionLabel(node) === label)
  assert.ok(option, '菜单里应该有「' + label + '」')
  option.props.onClick({})
}

/** 最小 document 假体：只记录全局监听，用来验证点外部关闭与收起/卸载时解绑。 */
function stubDocument() {
  const listeners = new Map()
  const original = globalThis.document
  const add = (type, fn) => {
    const list = listeners.get(type) || []
    list.push(fn)
    listeners.set(type, list)
  }
  globalThis.document = {
    addEventListener(type, fn) { add(type, fn) },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || []
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
  }
  return {
    fire(type, event) {
      for (const fn of [...(listeners.get(type) || [])]) fn(event)
    },
    count(type) { return (listeners.get(type) || []).length },
    restore() {
      if (original === undefined) delete globalThis.document
      else globalThis.document = original
    },
  }
}

test('渠道按钮：没有会话上下文时返回 null，不渲染', async () => {
  const env = await setupPlugin()
  assert.equal(typeof env.module.__test.BindChannel, 'function')
  assert.equal(env.renderComponent(env.module.__test.BindChannel, {}), null)
  assert.equal(env.renderComponent(env.module.__test.BindChannel, { sessionId: '' }), null)
})

test('渠道按钮：胶囊显示当前会话绑定的渠道，只列启用的渠道，已绑定的禁用渠道仍可见', async () => {
  const env = await setupPlugin()
  const bindings = [
    { qq: '10001', session: 'session-test-0001', name: '主人', enabled: false },
    { qq: '10002', session: '', name: '小号', enabled: true },
    { qq: '10003', session: 'session-other', name: '别人', enabled: false },
  ]
  const stub = stubBindFetch({ bindings })
  try {
    let tree = await mountBindChannel(env, { sessionId: 'session-test-0001' })
    const trigger = channelTrigger(tree)
    assert.ok(trigger, '有会话时要渲染胶囊按钮')
    const shown = channelTriggerText(tree)
    assert.doesNotMatch(shown, /收发渠道/, '按钮上不再有「收发渠道」静态标题')
    assert.equal(shown, '主人 QQ', '只有一条绑定时显示称呼 + 通道')
    assert.doesNotMatch(shown, /10001/, '胶囊上不显示完整号码')
    const currentName = findAll(trigger, (node) => node.props && node.props.className === 'fish-bind-name')
      .map((node) => collectText(node.children).join(''))
    const currentChannel = findAll(trigger, (node) => node.props && node.props.className === 'fish-bind-channel')
      .map((node) => collectText(node.children).join(''))
    assert.deepEqual(currentName, ['主人'], '称呼用亮色（fish-bind-name）')
    assert.deepEqual(currentChannel, ['QQ'], '通道用次要色（fish-bind-channel）')
    assert.equal(trigger.props['aria-label'], '收发渠道：主人 QQ。')
    assert.equal(trigger.props['aria-haspopup'], 'listbox')
    assert.equal(trigger.props['aria-expanded'], 'false')
    assert.equal(channelMenu(tree), undefined, '默认不展开菜单')
    assert.equal(stub.calls.filter((call) => call.url.endsWith('/state')).length, 1, '挂载时只拉一次状态，不做轮询')

    tree = await openChannelMenu(env)
    assert.equal(channelTrigger(tree).props['aria-expanded'], 'true', '展开后 aria-expanded 同步')
    const menu = channelMenu(tree)
    assert.ok(menu, '点按钮要展开菜单')
    assert.equal(menu.props['aria-label'], '收发渠道')
    assert.equal(menu.props['aria-multiselectable'], 'true', '菜单是多选')
    const options = channelOptions(tree)
    // 顺序按配置：已绑在这间会话的禁用渠道也要留着（否则勾选项会凭空消失）；最后是动作项。
    assert.deepEqual(options.map(channelOptionLabel), ['主人 QQ', '小号 QQ', '全部解绑'])
    assert.deepEqual(
      options.map((node) => node.props.title),
      ['QQ 10001', 'QQ 10002', '只解除这间会话的绑定，渠道仍保留在设置页'],
    )
    assert.deepEqual(options.map((node) => node.props['aria-selected']), ['true', 'false', 'false'])
    assert.equal(findAll(options[0], (node) => node.type === 'svg' && node.props.className === 'fish-bind-check').length, 1, '勾选项右侧有对勾')
    assert.equal(findAll(options[1], (node) => node.props.className === 'fish-bind-check').length, 0)
    assert.equal(stub.calls.filter((call) => call.url.endsWith('/state')).length, 2, '打开菜单时再校准一次，不多拉')
  } finally {
    env.mount(() => null)
    stub.restore()
  }
})

test('渠道按钮：点外部、按 Esc 都能关闭菜单，收起后解绑全局监听', async () => {
  const env = await setupPlugin()
  const doc = stubDocument()
  const stub = stubBindFetch({ bindings: [{ qq: '10001', session: 'session-test-0001', name: '主人', enabled: true }] })
  try {
    let tree = await mountBindChannel(env, { sessionId: 'session-test-0001' })
    tree = await openChannelMenu(env)
    assert.ok(channelMenu(tree))
    assert.equal(doc.count('pointerdown'), 1, '展开时挂一份点外部的监听')
    assert.equal(doc.count('mousedown'), 1)
    assert.equal(doc.count('keydown'), 1)

    // 点在组件外面：菜单关闭，监听一并解绑。
    doc.fire('pointerdown', { target: { tagName: 'BODY' } })
    tree = env.flush()
    assert.equal(channelMenu(tree), undefined, '点外部要收起菜单')
    assert.equal(channelTrigger(tree).props['aria-expanded'], 'false')
    assert.equal(doc.count('pointerdown'), 0)
    assert.equal(doc.count('keydown'), 0)

    // Esc 同理：菜单开着时只关菜单，不再传给宿主输入框。
    tree = await openChannelMenu(env)
    assert.ok(channelMenu(tree))
    let prevented = 0
    doc.fire('keydown', { key: 'Escape', preventDefault() { prevented += 1 }, stopPropagation() {} })
    tree = env.flush()
    assert.equal(channelMenu(tree), undefined, 'Esc 要收起菜单')
    assert.equal(prevented, 1)
    assert.equal(doc.count('pointerdown'), 0)

    // 展开状态下直接卸载：不能留下监听。
    tree = await openChannelMenu(env)
    assert.equal(doc.count('pointerdown'), 1)
    env.mount(() => null)
    assert.equal(doc.count('pointerdown'), 0, '卸载时解绑全局监听')
    assert.equal(doc.count('keydown'), 0)
  } finally {
    env.mount(() => null)
    doc.restore()
    stub.restore()
  }
})

test('渠道按钮：键盘 Enter / 空格打开菜单，其它按键不理会', async () => {
  const env = await setupPlugin()
  const stub = stubBindFetch({ bindings: [{ qq: '10001', session: 'session-test-0001', name: '主人', enabled: true }] })
  try {
    let tree = await mountBindChannel(env, { sessionId: 'session-test-0001' })
    let prevented = 0
    channelTrigger(tree).props.onKeyDown({ key: 'Enter', preventDefault() { prevented += 1 } })
    tree = env.flush()
    await nextTick()
    tree = env.flush()
    assert.ok(channelMenu(tree), 'Enter 要展开菜单')
    assert.equal(prevented, 1, '挡掉按钮自己的默认激活，避免连开带关')

    // 再点一次按钮收起；空格同样能打开。
    channelTrigger(tree).props.onClick({})
    tree = env.flush()
    assert.equal(channelMenu(tree), undefined)
    channelTrigger(tree).props.onKeyDown({ key: ' ', preventDefault() {} })
    tree = env.flush()
    await nextTick()
    tree = env.flush()
    assert.ok(channelMenu(tree), '空格要展开菜单')

    // 普通按键不改变开合状态。
    channelTrigger(tree).props.onClick({})
    tree = env.flush()
    channelTrigger(tree).props.onKeyDown({ key: 'a' })
    tree = env.flush()
    assert.equal(channelMenu(tree), undefined)
  } finally {
    env.mount(() => null)
    stub.restore()
  }
})

test('渠道按钮：勾选一条即提交整组绑定，菜单保持展开可继续勾', async () => {
  const env = await setupPlugin()
  const before = [
    { qq: '10001', session: 'session-test-0001', name: '主人', enabled: true },
    { qq: '10002', session: '', name: '小号', enabled: true },
  ]
  const after = [
    { qq: '10001', session: 'session-test-0001', name: '主人', enabled: true },
    { qq: '10002', session: 'session-test-0001', name: '小号', enabled: true },
  ]
  const stub = stubBindFetch({ bindings: before, onAssign: () => ({ ok: true, bindings: after }) })
  try {
    let tree = await mountBindChannel(env, { sessionId: 'session-test-0001' })
    tree = await openChannelMenu(env)
    pickChannel(tree, '小号 QQ')
    tree = env.flush()
    await nextTick()
    tree = env.flush()

    const call = stub.calls.find((item) => item.url.endsWith('/bindings/assign'))
    assert.ok(call, '勾选渠道要提交 /bindings/assign')
    assert.equal(call.options.method, 'POST')
    assert.deepEqual(JSON.parse(call.options.body), {
      sessionId: 'session-test-0001',
      bindings: [
        { channel: 'qq', peer: '10001' },
        { channel: 'qq', peer: '10002' },
      ],
    })
    assert.ok(channelMenu(tree), '多选要能连着勾，勾一条不关菜单')
    assert.equal(channelTriggerText(tree), '2 条渠道', '多条时胶囊只报数量')
    assert.deepEqual(channelOptions(tree).map((node) => node.props['aria-selected']), ['true', 'true', 'false'])
  } finally {
    env.mount(() => null)
    stub.restore()
  }
})

test('渠道按钮：取消勾选只解绑、不删渠道；「全部解绑」一次清空本会话', async () => {
  const env = await setupPlugin()
  const before = [{ qq: '10001', session: 'session-test-0001', name: '主人', enabled: true }]
  let current = before.map((binding) => ({ ...binding }))
  // 假后端按集合语义改绑定：列出的挂到本会话，本会话里没列出的回未绑定。
  const stub = stubBindFetch({
    bindings: before,
    onAssign: (body) => {
      const wanted = new Set((body.bindings || []).map((item) => item.channel + ':' + item.peer))
      current = current.map((binding) => {
        const key = (binding.channel || 'qq') + ':' + (binding.peer || binding.qq)
        if (wanted.has(key)) return { ...binding, session: body.sessionId }
        if (binding.session === body.sessionId) return { ...binding, session: '' }
        return binding
      })
      return { ok: true, bindings: current }
    },
  })
  try {
    let tree = await mountBindChannel(env, { sessionId: 'session-test-0001' })
    tree = await openChannelMenu(env)
    pickChannel(tree, '主人 QQ')
    await nextTick()
    tree = env.flush()

    let call = stub.calls.find((item) => item.url.endsWith('/bindings/assign'))
    assert.ok(call)
    assert.deepEqual(JSON.parse(call.options.body), { sessionId: 'session-test-0001', bindings: [] })
    assert.match(channelTriggerText(tree), /不绑定/, '解绑后回落到「不绑定」')
    // 菜单里渠道仍在，只是回到未勾选；没有勾选项时不显示「全部解绑」。
    assert.deepEqual(channelOptions(tree).map(channelOptionLabel), ['主人 QQ'])
    assert.equal(channelOptions(tree)[0].props['aria-selected'], 'false')

    // 勾回来，再点「全部解绑」：只清本会话的绑定，渠道仍在设置页。
    pickChannel(tree, '主人 QQ')
    await nextTick()
    tree = env.flush()
    assert.match(channelTriggerText(tree), /主人 QQ/)
    tree = env.flush()
    pickChannel(tree, '全部解绑')
    await nextTick()
    tree = env.flush()
    call = stub.calls.filter((item) => item.url.endsWith('/bindings/assign')).pop()
    assert.deepEqual(JSON.parse(call.options.body), { sessionId: 'session-test-0001', bindings: [] })
    assert.match(channelTriggerText(tree), /不绑定/)
  } finally {
    env.mount(() => null)
    stub.restore()
  }
})

test('渠道按钮：请求失败时退回原勾选并提示原因，菜单不消失', async () => {
  const env = await setupPlugin()
  const bindings = [
    { qq: '10001', session: 'session-test-0001', name: '主人', enabled: true },
    { qq: '10002', session: '', name: '小号', enabled: true },
  ]
  const stub = stubBindFetch({
    bindings,
    onAssign: () => ({ ok: false, error: '没有 QQ 10002 的收发渠道，请先在设置页添加。' }),
  })
  try {
    let tree = await mountBindChannel(env, { sessionId: 'session-test-0001' })
    tree = await openChannelMenu(env)
    pickChannel(tree, '小号 QQ')
    await nextTick()
    tree = env.flush()

    assert.ok(channelTrigger(tree), '失败后按钮不能消失')
    assert.match(channelTriggerText(tree), /主人 QQ/, '失败要退回原勾选')
    assert.ok(channelMenu(tree), '失败后菜单仍开着，方便重试')
    assert.match(textOf(tree), /没有 QQ 10002 的收发渠道，请先在设置页添加。/)
    assert.equal(findAll(tree, (node) => node.props && node.props.role === 'status').length, 1, '错误用 status 播报')

    // 连不上宿主时给一句人话，不把网络报错直接甩给用户。
    globalThis.fetch = async () => { throw new Error('Failed to fetch') }
    pickChannel(env.flush(), '小号 QQ')
    await nextTick()
    tree = env.flush()
    assert.match(channelTriggerText(tree), /主人 QQ/)
    assert.match(textOf(tree), /没能切换收发渠道，请稍后重试。/)
    assert.doesNotMatch(textOf(tree), /Failed to fetch/)
  } finally {
    env.mount(() => null)
    stub.restore()
  }
})

test('渠道按钮：提交期间禁用，完成后恢复', async () => {
  const env = await setupPlugin()
  const before = [
    { qq: '10001', session: 'session-test-0001', name: '主人', enabled: true },
    { qq: '10002', session: '', name: '小号', enabled: true },
  ]
  const after = [
    { qq: '10001', session: 'session-test-0001', name: '主人', enabled: true },
    { qq: '10002', session: 'session-test-0001', name: '小号', enabled: true },
  ]
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const stub = stubBindFetch({ bindings: before, onAssign: () => gate.then(() => ({ ok: true, bindings: after })) })
  try {
    let tree = await mountBindChannel(env, { sessionId: 'session-test-0001' })
    tree = await openChannelMenu(env)
    pickChannel(tree, '小号 QQ')
    tree = env.flush()
    assert.equal(channelTrigger(tree).props.disabled, true, '请求在跑时禁用按钮')

    release()
    await nextTick()
    tree = env.flush()
    assert.equal(channelTrigger(tree).props.disabled, false)
    assert.equal(channelTriggerText(tree), '2 条渠道')
  } finally {
    env.mount(() => null)
    stub.restore()
  }
})

test('渠道按钮：同一实例切换会话后按新会话刷新选中', async () => {
  const env = await setupPlugin()
  const bindings = [
    { qq: '10001', session: 'session-a', name: '主人', enabled: true },
    { qq: '10002', session: 'session-b', name: '小号', enabled: true },
  ]
  const stub = stubBindFetch({ bindings })
  try {
    let tree = await mountBindChannel(env, { sessionId: 'session-a' })
    assert.match(channelTriggerText(tree), /主人 QQ/)

    tree = env.setProps({ sessionId: 'session-b' })
    await nextTick()
    tree = env.flush()
    assert.match(channelTriggerText(tree), /小号 QQ/, '会话变了要按新会话的绑定显示')
    assert.equal(stub.calls.filter((call) => call.url.endsWith('/state')).length, 2, '会话变化要重新拉一次状态')
  } finally {
    env.mount(() => null)
    stub.restore()
  }
})

/** 找到弹窗面板（可按 aria-label 指定是哪个库）。 */
function dialogOf(root, title) {
  const dialogs = findAll(root, (node) => node.props && node.props.role === 'dialog')
  return title ? dialogs.find((node) => node.props['aria-label'] === title) : dialogs[0]
}

/** 找到弹窗遮罩。 */
function overlayOf(root) {
  return findAll(root, (node) => node.props && node.props['data-gallery-overlay'] !== undefined)[0]
}

test('设置页：两个库的块相邻，各开各的独立弹窗，互不显示对方', async () => {
  const env = await setupPlugin()
  const page = env.renderSection([fullState()])
  const blocks = Array.isArray(page.children) ? page.children : []
  const stickerAt = blocks.findIndex((node) => /保存位置/.test(textOf(node)))
  const imageAt = blocks.findIndex((node) => /收图先查图库/.test(textOf(node)))
  assert.ok(stickerAt >= 0, '设置页应该有表情包块')
  assert.ok(imageAt >= 0, '设置页应该有收图图库块')
  assert.equal(imageAt, stickerAt + 1, '表情包与收图图库两块必须相邻')

  const stickerButton = findButton(blocks[stickerAt], '打开图库管理')
  const imageButton = findButton(blocks[imageAt], '打开图库管理')
  assert.equal(stickerButton.length, 1)
  assert.equal(imageButton.length, 1)

  // 配置项仍在各自块里，弹窗不接管配置。
  assert.match(textOf(blocks[stickerAt]), /保存位置/)
  assert.match(textOf(blocks[stickerAt]), /收到图片时自动存入表情包/)
  assert.match(textOf(blocks[imageAt]), /图库条数上限/)
  assert.match(textOf(blocks[imageAt]), /在图库里存原图/)

  // 表情包块只开表情库弹窗：有表情库的操作，没有收图图库的操作，也没有页签。
  const trigger = { focused: 0, focus() { this.focused += 1 } }
  stickerButton[0].props.onClick({ currentTarget: trigger })
  let tree = env.flush()
  const stickerDialog = dialogOf(tree, '表情库')
  assert.ok(stickerDialog, '表情包块应该打开表情库弹窗')
  assert.equal(dialogOf(tree).props['aria-label'], '表情库')
  assert.equal(dialogOf(tree, '收图图库'), undefined, '同时只能有一个图库弹窗')
  const stickerText = textOf(stickerDialog)
  assert.match(stickerText, /上传图片/)
  assert.match(stickerText, /打开表情库文件夹/)
  assert.match(stickerText, /删除未使用/)
  assert.match(stickerText, /清理重复/)
  assert.doesNotMatch(stickerText, /清空图库/, '表情库弹窗不能出现收图图库的操作')
  assert.equal(findButton(stickerDialog, '表情库').length, 0, '弹窗里不应再有表情库页签')
  assert.equal(findButton(stickerDialog, '收图图库').length, 0, '弹窗里不应再有收图图库页签')

  // 关闭后焦点回到触发按钮。
  findByLabel(stickerDialog, '关闭表情库')[0].props.onClick()
  tree = env.flush()
  assert.equal(findAll(tree, (node) => node.props && node.props.role === 'dialog').length, 0)
  assert.equal(trigger.focused, 1)

  // 收图图库块只开收图图库弹窗。
  const reopen = findButton(tree, '打开图库管理')
  assert.equal(reopen.length, 2)
  reopen[1].props.onClick({ currentTarget: { focus() {} } })
  tree = env.flush()
  const imageDialog = dialogOf(tree, '收图图库')
  assert.ok(imageDialog, '收图图库块应该打开收图图库弹窗')
  assert.equal(dialogOf(tree).props['aria-label'], '收图图库')
  assert.equal(dialogOf(tree, '表情库'), undefined, '同时只能有一个图库弹窗')
  const imageText = textOf(imageDialog)
  assert.match(imageText, /清空图库/)
  assert.match(imageText, /打开图库文件夹/)
  assert.doesNotMatch(imageText, /上传图片/, '收图图库弹窗不能出现表情库的操作')
  assert.doesNotMatch(imageText, /删除未使用/)
  assert.equal(findButton(imageDialog, '表情库').length, 0)
  assert.equal(findButton(imageDialog, '收图图库').length, 0)
})

test('两个弹窗的详情：进入、返回，各自的动作不串库', async () => {
  const env = await setupPlugin()
  const { StickerGalleryModal, ImageGalleryModal } = env.module.__test
  const sticker = stickerEntry()
  const entry = imageEntry()

  // 表情库：工具条 + 卡片 + 详情。
  let tree = env.renderComponent(StickerGalleryModal, { open: true, onClose() {}, bindings: [] }, {
    StickerGallery: [{ items: [sticker], total: 1, stats: {} }, '', false, false, '', null, {}, {}],
  })
  let dialog = dialogOf(tree, '表情库')
  assert.ok(dialog)
  assert.match(textOf(dialog), /打哈欠的猫/)
  assert.match(textOf(dialog), /#睡觉/)
  let card = findAll(dialog, (node) => node.props && node.props.role === 'button')[0]
  assert.ok(card, '表情库网格卡片要能点击')
  card.props.onClick()
  tree = env.flush()
  dialog = dialogOf(tree, '表情库')
  assert.match(textOf(dialog), /返回/)
  assert.match(textOf(dialog), /保存描述与标签/)
  assert.match(textOf(dialog), /复制路径/)
  assert.match(textOf(dialog), /发送/)
  assert.match(textOf(dialog), /删除/)
  assert.doesNotMatch(textOf(dialog), /存为表情/, '表情库详情不出现收图图库的「存为表情」')
  assert.doesNotMatch(textOf(dialog), /打开原图/)
  findButton(dialog, '返回')[0].props.onClick()
  tree = env.flush()
  dialog = dialogOf(tree, '表情库')
  assert.match(textOf(dialog), /打哈欠的猫/, '返回后回到网格')
  assert.doesNotMatch(textOf(dialog), /保存描述与标签/)

  // 收图图库：工具条 + 卡片 + 详情。
  tree = env.renderComponent(ImageGalleryModal, { open: true, onClose() {}, imageDir: 'C:/tmp/images' }, {
    ImageGallery: [{ entries: [entry], total: 1, stats: { count: 1 } }, '', false, false, '', null, {}],
  })
  dialog = dialogOf(tree, '收图图库')
  assert.ok(dialog)
  assert.match(textOf(dialog), /本地识图/, '卡片要写明描述来源')
  card = findAll(dialog, (node) => node.props && node.props.role === 'button')[0]
  assert.ok(card, '收图图库网格卡片要能点击')
  card.props.onClick()
  tree = env.flush()
  dialog = dialogOf(tree, '收图图库')
  assert.match(textOf(dialog), /返回/)
  assert.match(textOf(dialog), /保存描述/)
  assert.match(textOf(dialog), /存为表情/)
  assert.match(textOf(dialog), /打开原图/)
  assert.doesNotMatch(textOf(dialog), /保存描述与标签/, '收图图库详情不出现表情库的动作')
  assert.doesNotMatch(textOf(dialog), /复制路径/)
  findButton(dialog, '返回')[0].props.onClick()
  tree = env.flush()
  dialog = dialogOf(tree, '收图图库')
  assert.match(textOf(dialog), /命中 2 次/)

  // 没有原图的条目：打开原图与存为表情都不可用。
  const noFile = { ...entry, file: '', path: '' }
  tree = env.renderComponent(ImageGalleryModal, { open: true, onClose() {}, imageDir: 'C:/tmp/images' }, {
    ImageGallery: [{ entries: [noFile], total: 1, stats: { count: 1 } }, '', false, false, '', noFile, {}],
  })
  dialog = dialogOf(tree, '收图图库')
  assert.equal(findButton(dialog, '打开原图')[0].props.disabled, true)
  assert.equal(findButton(dialog, '存为表情')[0].props.disabled, true)
})

test('二次确认：两个弹窗都在弹窗内确认，不用 window.confirm', async () => {
  const env = await setupPlugin()
  const { StickerGalleryModal, ImageGalleryModal } = env.module.__test
  const sticker = stickerEntry()
  const entry = imageEntry()

  let confirmCalls = 0
  const originalWindow = globalThis.window
  globalThis.window = { confirm() { confirmCalls += 1; return true } }
  try {
    // 表情库：详情删除 → 确认框；取消后回到详情。
    let tree = env.renderComponent(StickerGalleryModal, { open: true, onClose() {}, bindings: [] }, {
      StickerGallery: [{ items: [sticker], total: 1, stats: {} }, '', false, false, '', sticker, {}, {}],
    })
    let dialog = dialogOf(tree, '表情库')
    findButton(dialog, '删除')[0].props.onClick()
    tree = env.flush()
    dialog = dialogOf(tree, '表情库')
    assert.equal(findByLabel(dialog, '删除这个表情？').length, 1, '删除表情要先弹确认框')
    assert.match(textOf(findByLabel(dialog, '删除这个表情？')[0]), /无法撤销/)
    findButton(dialog, '取消')[0].props.onClick()
    tree = env.flush()
    dialog = dialogOf(tree, '表情库')
    assert.equal(findByLabel(dialog, '删除这个表情？').length, 0, '取消后确认框关闭')
    assert.match(textOf(dialog), /保存描述与标签/, '取消后仍在详情页')

    // 表情库：库级「删除未使用」→ 确认框；确认按钮带对象。
    findButton(dialog, '删除未使用')[0].props.onClick()
    tree = env.flush()
    dialog = dialogOf(tree, '表情库')
    assert.equal(findByLabel(dialog, '删除未使用的表情？').length, 1)
    assert.equal(findButton(dialog, '删除未使用').length, 2, '工具条与确认框各一个')
    findButton(dialog, '取消').length === 1 ? findButton(dialog, '取消')[0].props.onClick() : null
    tree = env.flush()

    // 收图图库：清空图库 → 确认框；取消不执行。
    tree = env.renderComponent(ImageGalleryModal, { open: true, onClose() {}, imageDir: 'C:/tmp/images' }, {
      ImageGallery: [{ entries: [entry], total: 1, stats: { count: 1 } }, '', false, false, '', null, {}],
    })
    dialog = dialogOf(tree, '收图图库')
    findButton(dialog, '清空图库')[0].props.onClick()
    tree = env.flush()
    dialog = dialogOf(tree, '收图图库')
    assert.equal(findByLabel(dialog, '清空收图图库？').length, 1)
    assert.match(textOf(findByLabel(dialog, '清空收图图库？')[0]), /无法撤销/)
    findButton(dialog, '取消')[0].props.onClick()
    tree = env.flush()
    dialog = dialogOf(tree, '收图图库')
    assert.equal(findByLabel(dialog, '清空收图图库？').length, 0)
    assert.ok(findButton(dialog, '清空图库').length >= 1)
    assert.equal(confirmCalls, 0, '图库里的危险操作不能再用 window.confirm')
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})

test('Esc：只关当前弹窗，确认框打开时只关确认框，不关设置页', async () => {
  const env = await setupPlugin()
  const listeners = []
  const originalDocument = globalThis.document
  globalThis.document = {
    addEventListener(type, fn, capture) { if (type === 'keydown' && capture) listeners.push(fn) },
    removeEventListener(type, fn, capture) {
      const at = listeners.indexOf(fn)
      if (at >= 0) listeners.splice(at, 1)
    },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    json: async () => ({ ok: true, items: [], entries: [], total: 0, stats: {}, tags: [] }),
  })
  const esc = () => ({
    key: 'Escape',
    defaultPrevented: 0,
    propagationStopped: 0,
    immediateStopped: 0,
    preventDefault() { this.defaultPrevented += 1 },
    stopPropagation() { this.propagationStopped += 1 },
    stopImmediatePropagation() { this.immediateStopped += 1 },
  })
  try {
    // 用设置页真实入口打开弹窗；设置页自身的请求不跑，只有弹窗的监听生效。
    let tree = env.renderSection([fullState()])
    env.setEffects(true)

    const focusBefore = env.focusCount()
    findButton(tree, '打开图库管理')[0].props.onClick({ currentTarget: { focus() {} } })
    tree = env.flush()
    assert.ok(env.focusCount() > focusBefore, '打开弹窗时焦点要进入面板')
    assert.ok(dialogOf(tree, '表情库'))
    assert.ok(listeners.length >= 1, '打开弹窗时要注册 document 捕获阶段 keydown 监听')
    let event = esc()
    listeners[listeners.length - 1](event)
    tree = env.flush()
    assert.equal(findAll(tree, (node) => node.props && node.props.role === 'dialog').length, 0, 'Esc 关掉表情库弹窗')
    assert.match(textOf(tree), /鱼讯/, '设置页不能被一起关掉')
    assert.equal(event.defaultPrevented, 1)
    assert.equal(event.propagationStopped, 1)
    assert.equal(event.immediateStopped, 1)

    // 收图图库弹窗同样只关自己。
    findButton(tree, '打开图库管理')[1].props.onClick({ currentTarget: { focus() {} } })
    tree = env.flush()
    assert.ok(dialogOf(tree, '收图图库'))
    event = esc()
    listeners[listeners.length - 1](event)
    tree = env.flush()
    assert.equal(findAll(tree, (node) => node.props && node.props.role === 'dialog').length, 0)
    assert.match(textOf(tree), /鱼讯/)

    // 确认框打开时：第一次 Esc 只关确认框，弹窗还在；第二次才关弹窗。
    findButton(tree, '打开图库管理')[0].props.onClick({ currentTarget: { focus() {} } })
    tree = env.flush()
    findButton(tree, '删除未使用')[0].props.onClick()
    tree = env.flush()
    assert.equal(findByLabel(tree, '删除未使用的表情？').length, 1)
    event = esc()
    listeners[listeners.length - 1](event)
    tree = env.flush()
    assert.equal(findByLabel(tree, '删除未使用的表情？').length, 0, 'Esc 先关确认框')
    assert.ok(dialogOf(tree, '表情库'), '确认框关掉后弹窗还在')
    event = esc()
    listeners[listeners.length - 1](event)
    tree = env.flush()
    assert.equal(findAll(tree, (node) => node.props && node.props.role === 'dialog').length, 0)
  } finally {
    env.mount(() => null)
    globalThis.fetch = originalFetch
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})

test('遮罩：两个弹窗都能点遮罩关闭', async () => {
  const env = await setupPlugin()
  const { StickerGalleryModal, ImageGalleryModal } = env.module.__test

  let closed = 0
  let tree = env.renderComponent(StickerGalleryModal, { open: true, onClose() { closed += 1 }, bindings: [] }, {
    StickerGallery: [{ items: [], total: 0, stats: {} }, '', false, false, '', null, {}, {}],
  })
  let overlay = overlayOf(tree)
  assert.ok(overlay, '表情库弹窗要有遮罩')
  overlay.props.onClick({ target: overlay, currentTarget: overlay })
  assert.equal(closed, 1, '点遮罩关闭表情库弹窗')

  closed = 0
  tree = env.renderComponent(ImageGalleryModal, { open: true, onClose() { closed += 1 }, imageDir: '' }, {
    ImageGallery: [{ entries: [], total: 0, stats: {} }, '', false, false, '', null, {}],
  })
  overlay = overlayOf(tree)
  assert.ok(overlay, '收图图库弹窗要有遮罩')
  overlay.props.onClick({ target: overlay, currentTarget: overlay })
  assert.equal(closed, 1, '点遮罩关闭收图图库弹窗')
})

test('空态/加载态：两个独立弹窗各自显示统一文案', async () => {
  const env = await setupPlugin()
  const { StickerGalleryModal, ImageGalleryModal } = env.module.__test

  let tree = env.renderComponent(StickerGalleryModal, { open: true, onClose() {} }, {
    StickerGallery: [{ items: [], total: 0, stats: {} }, '', true, false, '', null, {}, {}],
  })
  assert.match(textOf(dialogOf(tree, '表情库')), /正在读取图库…/)
  tree = env.renderComponent(StickerGalleryModal, { open: true, onClose() {} }, {
    StickerGallery: [{ items: [], total: 0, stats: {} }, '', false, false, '', null, {}, {}],
  })
  assert.match(textOf(dialogOf(tree, '表情库')), /图库是空的。/)

  tree = env.renderComponent(ImageGalleryModal, { open: true, onClose() {}, imageDir: '' }, {
    ImageGallery: [{ entries: [], total: 0, stats: {} }, '', true, false, '', null, {}],
  })
  assert.match(textOf(dialogOf(tree, '收图图库')), /正在读取图库…/)
  tree = env.renderComponent(ImageGalleryModal, { open: true, onClose() {}, imageDir: '' }, {
    ImageGallery: [{ entries: [], total: 0, stats: {} }, '', false, false, '', null, {}],
  })
  assert.match(textOf(dialogOf(tree, '收图图库')), /图库是空的。/)
})

test('收图图库：存为表情用原图绝对路径与 qq-inbox 来源', async () => {
  const env = await setupPlugin()
  const { ImageGalleryModal } = env.module.__test
  const entry = imageEntry()
  const tree = env.renderComponent(ImageGalleryModal, { open: true, onClose() {}, imageDir: 'C:/tmp/images' }, {
    ImageGallery: [{ entries: [entry], total: 1, stats: { count: 1 } }, '', false, false, '', entry, {}],
  })
  const buttons = findButton(tree, '存为表情')
  assert.equal(buttons.length, 1)

  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return { json: async () => ({ ok: true, created: true }) }
  }
  try {
    await buttons[0].props.onClick()
  } finally {
    globalThis.fetch = originalFetch
  }

  const save = calls.find((call) => call.url.endsWith('/stickers/save'))
  assert.ok(save, '应该调用 /stickers/save')
  const body = JSON.parse(save.options.body)
  assert.equal(body.path, entry.path, 'path 必须是图库条目的原图绝对路径')
  assert.equal(body.source, 'qq-inbox', 'source 必须是 qq-inbox')
  assert.equal(body.desc, '一只猫')
})

test('页签与 GALLERIES 清单已不存在，弹窗骨架只有一份实现', async () => {
  const env = await setupPlugin()
  const { __test } = env.module
  assert.equal(__test.GALLERIES, undefined)
  assert.equal(typeof __test.GalleryModal, 'function', '模板应该保留')
  assert.equal(typeof __test.StickerGalleryModal, 'function')
  assert.equal(typeof __test.ImageGalleryModal, 'function')
  assert.equal(typeof __test.StickerGallery, 'function', '表情库变体应该保留')
  assert.equal(typeof __test.ImageGallery, 'function', '收图图库变体应该保留')

  const source = readFileSync(join(repoRoot, 'client.js'), 'utf8')
  assert.doesNotMatch(source, /GALLERIES/, '不应再有 GALLERIES 描述表')
  assert.doesNotMatch(source, /initialTab|setTab|S\.modalTabs|S\.segment/, '不应再有页签与页签样式')
  assert.equal((source.match(/role: 'dialog'/g) || []).length, 1, '弹窗骨架只应由模板渲染一次')
  assert.equal((source.match(/role: 'alertdialog'/g) || []).length, 1, '确认框只应由模板渲染一次')
  assert.match(source, /function GalleryModal/, '模板落在 GalleryModal')
  assert.match(source, /function StickerGalleryModal/, '表情库入口弹窗落在 StickerGalleryModal')
  assert.match(source, /function ImageGalleryModal/, '收图图库入口弹窗落在 ImageGalleryModal')
})

test('客户端设置页：默认文案常量声明在第一次使用之前（防 TDZ 白屏）', () => {
  const source = readFileSync(join(repoRoot, 'client.js'), 'utf8').split(/\r?\n/)
  for (const name of ['defaultLongTaskReminder', 'defaultMessageChannelReminder', 'defaultImagePrompt']) {
    const declare = source.findIndex((row) => row.includes('const ' + name + ' ='))
    assert.ok(declare >= 0, name + ' 应该有 const 声明')
    const firstSaveReference = source.findIndex((row, i) => i !== declare && row.includes(name))
    assert.ok(firstSaveReference >= 0, name + ' 应该被用到')
    assert.ok(
      declare < firstSaveReference,
      name + ' 在第 ' + (declare + 1) + ' 行声明，但第 ' + (firstSaveReference + 1) + ' 行就用了；这会在打开设置页时抛 TDZ、整页白屏',
    )
  }
})

// ---------------- 微信通道（扫码登录 + 绑定区通道选择） ----------------

const WX = 'o9cq800kum_4g8Py8Qw5G0a@im.wechat'
// 真机 iLink 返回的原样内容：qrcode_img_content 是待编码的 https 链接，不是图片地址。
const WX_QR_LINK = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=e97a70cd49f5ece52933a1b03b1b9a3d&bot_type=3'
// 同一段文本的模块矩阵指纹：oracle 由公开实现（dsh-im-wechat 的 qr.js）算出，只用于钉住编码器。
const WX_QR_DIGEST = 'fe55f4f73cf97704e0535fccdd537d5bfffc1302e716ede9b990b2f45c8fce2c'

/** 绑定行里的通道下拉：选项值只会是 qq / wechat。 */
function channelSelects(tree) {
  return findAll(tree, (node) => node.type === 'select'
    && (node.children || []).some((child) => child && child.props && (child.props.value === 'qq' || child.props.value === 'wechat')))
}

/** 通道下拉里的可见选项文字（条件渲染的 null 槽位跳过）。 */
function channelOptionTexts(select) {
  return (select.children || [])
    .filter((child) => child && typeof child === 'object')
    .map((child) => visibleText(child.children).join(''))
}

/** 绑定行里的会话下拉：第一个选项是「（选择会话）」即未绑定。 */
function sessionSelects(tree) {
  return findAll(tree, (node) => node.type === 'select'
    && (node.children || []).some((child) => child && child.props && child.props.value === ''
      && visibleText(child.children).join('') === '（选择会话）'))
}

/** 某个 placeholder 的输入框（绑定行里的对端输入）。 */
function inputsWithPlaceholder(tree, placeholder) {
  return findAll(tree, (node) => node.type === 'input' && node.props && node.props.placeholder === placeholder)
}

test('设置页：微信未启用时绑定区不给微信选项，启用后才出现', async () => {
  const env = await setupPlugin()

  const off = fullState()
  off.config.wechatEnabled = false
  const tree = env.renderSection([off])
  assert.equal(findButton(tree, '添加微信渠道').length, 0, '未启用时不出现「添加微信渠道」')
  assert.deepEqual(channelSelects(tree).map(channelOptionTexts), [['QQ']], '通道下拉只有 QQ')
  // 启用入口本身要一直在，否则没法打开这个通道。
  assert.match(textOf(tree), /微信通道/)
  assert.match(textOf(tree), /启用微信通道/)

  const on = fullState()
  on.config.wechatEnabled = true
  on.wechat = { enabled: true, status: { state: 'confirmed', connected: true }, qrcode: {} }
  const enabledTree = env.renderSection([on])
  assert.equal(findButton(enabledTree, '添加微信渠道').length, 1)
  assert.deepEqual(channelSelects(enabledTree).map(channelOptionTexts), [['QQ', '微信']])

  // 已经存下的微信渠道即使开关关着，也要显示成微信，不能被改成 QQ。
  const legacy = fullState()
  legacy.config.wechatEnabled = false
  legacy.config.bindings = [{ channel: 'wechat', peer: WX, session: 'session-test-0001', name: '小号', enabled: true }]
  const legacyTree = env.renderSection([legacy])
  const legacySelect = channelSelects(legacyTree)[0]
  assert.equal(legacySelect.props.value, 'wechat')
  assert.deepEqual(channelOptionTexts(legacySelect), ['QQ', '微信'])
})

test('设置页：微信没登录时点添加微信渠道只提示先扫码，不新增条目', async () => {
  const env = await setupPlugin()
  const state = fullState()
  state.config.wechatEnabled = true
  let tree = env.renderSection([state])
  const add = findButton(tree, '添加微信渠道')
  assert.equal(add.length, 1)
  add[0].props.onClick({})
  tree = env.flush()
  assert.match(textOf(tree), /先在上面扫码登录，再添加渠道。/)
  assert.equal(channelSelects(tree).length, 1, '没登录时不新增绑定行')
})

test('设置页：微信已登录时可添加微信渠道，微信对端保留字母与 @，QQ 仍只收数字', async () => {
  const env = await setupPlugin()
  const state = fullState()
  state.config.wechatEnabled = true
  state.wechat = { enabled: true, status: { state: 'confirmed', connected: true }, qrcode: {} }
  let tree = env.renderSection([state])

  findButton(tree, '添加微信渠道')[0].props.onClick({})
  tree = env.flush()
  assert.equal(channelSelects(tree).length, 2, '新增一条绑定')
  assert.equal(channelSelects(tree)[1].props.value, 'wechat', '新条目的通道是微信')

  const wechatPeer = inputsWithPlaceholder(tree, 'wxid 或 @im.wechat 结尾的 id')
  assert.equal(wechatPeer.length, 1)
  wechatPeer[0].props.onChange({ target: { value: WX } })
  tree = env.flush()
  assert.equal(inputsWithPlaceholder(tree, 'wxid 或 @im.wechat 结尾的 id')[0].props.value, WX, '微信对端原样保留')

  const qqPeer = inputsWithPlaceholder(tree, '1696117435')[0]
  qqPeer.props.onChange({ target: { value: '12ab34' } })
  tree = env.flush()
  assert.equal(inputsWithPlaceholder(tree, '1696117435')[0].props.value, '1234', 'QQ 对端仍只留数字')
})

test('设置页：保存设置时 wechatEnabled 随 config 一起提交', async () => {
  const env = await setupPlugin()
  const state = fullState()
  state.config.wechatEnabled = true
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url)
    calls.push({ url: address, options: options })
    return { json: async () => (address.endsWith('/save') ? { ok: true } : state) }
  }
  try {
    const tree = env.renderSection([state])
    findButton(tree, '保存设置')[0].props.onClick({})
    await nextTick()
    env.flush()
    const save = calls.find((call) => call.url.endsWith('/save'))
    assert.ok(save, '应该调用 /save')
    assert.equal(save.options.method, 'POST')
    assert.equal(JSON.parse(save.options.body).config.wechatEnabled, true)
  } finally {
    env.mount(() => null)
    globalThis.fetch = original
  }
})

test('设置页：新增渠道默认不占会话，同一会话的两条绑定都渲染出来、可单独删除', async () => {
  const env = await setupPlugin()
  const state = fullState()
  state.config.wechatEnabled = true
  state.wechat = { enabled: true, status: { state: 'confirmed', connected: true }, qrcode: {} }
  state.config.bindings = [
    { channel: 'qq', qq: '10001', session: 'session-test-0001', name: '主人', enabled: true },
    { channel: 'wechat', peer: WX, qq: WX, session: 'session-test-0001', name: '小号', enabled: true },
  ]
  let tree = env.renderSection([state])

  // 列表按行展示同会话的多条绑定，不是合并成一条。
  assert.equal(sessionSelects(tree).length, 2, '两条绑定各占一行')
  assert.deepEqual(sessionSelects(tree).map((node) => node.props.value), ['session-test-0001', 'session-test-0001'])
  assert.equal(findButton(tree, '删除').length, 2, '每条都能单独删除')

  // 新增的渠道不默认抢占会话：会话留空，绑哪间交给「收发渠道」选择器。
  findButton(tree, '添加微信渠道')[0].props.onClick({})
  tree = env.flush()
  assert.equal(sessionSelects(tree).length, 3)
  assert.equal(sessionSelects(tree)[2].props.value, '', '新增渠道的会话是空串')
  assert.equal(channelSelects(tree)[2].props.value, 'wechat')

  // 单独解绑一条：把它的会话改回「（选择会话）」，另一条不受影响。
  sessionSelects(tree)[0].props.onChange({ target: { value: '' } })
  tree = env.flush()
  assert.deepEqual(sessionSelects(tree).map((node) => node.props.value), ['', 'session-test-0001', ''])
})

test('设置页：对端没填时本地拦下，不发 /save 并指出哪一条', async () => {
  const env = await setupPlugin()
  const state = fullState()
  state.config.wechatEnabled = true
  state.wechat = { enabled: true, status: { state: 'confirmed', connected: true }, qrcode: {} }
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { json: async () => state }
  }
  try {
    let tree = env.renderSection([state])
    findButton(tree, '添加微信渠道')[0].props.onClick({})
    tree = env.flush()
    findButton(tree, '保存设置')[0].props.onClick({})
    await nextTick()
    tree = env.flush()

    assert.equal(calls.some((url) => url.endsWith('/save')), false, '有问题的绑定不能提交')
    assert.match(textOf(tree), /有 1 条渠道没保存/)
    assert.match(textOf(tree), /第 2 条渠道（微信）的对端没填/)
  } finally {
    env.mount(() => null)
    globalThis.fetch = original
  }
})

test('设置页：保存后把后端丢掉的原因逐条说出来，不静默消失', async () => {
  const env = await setupPlugin()
  const state = fullState()
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const address = String(url)
    calls.push(address)
    if (address.endsWith('/save')) {
      return {
        json: async () => ({
          ok: true,
          dropped: [{ channel: 'wechat', peer: WX, reason: '这个对端已经有一条渠道了' }],
        }),
      }
    }
    return { json: async () => state }
  }
  try {
    const tree = env.renderSection([state])
    findButton(tree, '保存设置')[0].props.onClick({})
    await nextTick()
    const after = env.flush()

    assert.equal(calls.some((url) => url.endsWith('/save')), true, '正常绑定照常提交')
    const text = textOf(after)
    assert.match(text, /设置已保存，但有 1 条渠道没保存/)
    assert.match(text, /这个对端已经有一条渠道了（微信 o9cq/)
    assert.match(text, /没保存/)
  } finally {
    env.mount(() => null)
    globalThis.fetch = original
  }
})

test('微信卡片：登录状态文案与按钮', async () => {
  const env = await setupPlugin()
  const { WechatChannel, wechatStateText } = env.module.__test

  // 文案映射本身先对一遍：未知状态按未登录处理。
  assert.equal(wechatStateText('stopped'), '未登录')
  assert.equal(wechatStateText('connecting'), '正在获取二维码…')
  assert.equal(wechatStateText('waiting_scan'), '等待扫码')
  assert.equal(wechatStateText('scaned'), '已扫码，请在手机上确认。')
  assert.equal(wechatStateText('expired'), '二维码过期了。')
  assert.equal(wechatStateText('error'), '登录失败')
  assert.equal(wechatStateText('confirmed'), '已登录')
  assert.equal(wechatStateText('nonsense'), '未登录')

  const mount = (state, extra = {}) => env.renderComponent(WechatChannel, {
    config: { wechatEnabled: true },
    change: () => {},
    initial: { enabled: true, status: { state, ...(extra.status || {}) }, qrcode: extra.qrcode || {} },
  })

  let tree = mount('stopped')
  assert.match(textOf(tree), /未登录/)
  assert.equal(findButton(tree, '扫码登录').length, 1)

  tree = mount('connecting')
  assert.match(textOf(tree), /正在获取二维码…/)
  assert.equal(findButton(tree, '扫码登录').length, 0, '取二维码期间不再给登录按钮')

  tree = mount('scaned')
  assert.match(textOf(tree), /已扫码，请在手机上确认/)

  tree = mount('expired')
  assert.match(textOf(tree), /二维码过期了。/)
  assert.equal(findButton(tree, '重新获取二维码').length, 1)

  tree = mount('error', { status: { lastError: '登录凭证失效' } })
  assert.match(textOf(tree), /登录失败：登录凭证失效/)
  assert.equal(findButton(tree, '重新登录').length, 1)

  tree = mount('confirmed', { status: { connected: true, botId: 'ilink-bot-123456' } })
  assert.match(textOf(tree), /已登录/)
  assert.match(textOf(tree), /账号尾号 123456/)
  assert.equal(findButton(tree, '退出登录').length, 1)
  const sendTest = findButton(tree, '发送微信测试消息')
  assert.equal(sendTest.length, 1)
  // 还没有微信渠道时不能瞎发：按钮置灰并说清下一步。
  assert.equal(sendTest[0].props.disabled, true)
  assert.match(textOf(tree), /先在下面的「私聊绑定」里添加一条微信渠道，才能发测试消息。/)
})

test('微信卡片：开关写 wechatEnabled，未启用时不显示登录区', async () => {
  const env = await setupPlugin()
  const { WechatChannel } = env.module.__test
  const changes = []
  const tree = env.renderComponent(WechatChannel, {
    config: { wechatEnabled: false },
    change: (key, value) => changes.push([key, value]),
    initial: { enabled: false, status: { state: 'stopped' }, qrcode: {} },
  })
  assert.match(textOf(tree), /打开开关后可以扫码登录。/)
  assert.equal(findButton(tree, '扫码登录').length, 0, '未启用时没有登录按钮')
  const box = findAll(tree, (node) => node.type === 'input' && node.props && node.props.type === 'checkbox')[0]
  assert.ok(box, '需要有启用开关')
  box.props.onChange({ target: { checked: true } })
  assert.deepEqual(changes, [['wechatEnabled', true]])
})

/** 页面里的二维码 SVG（role="img" 的那个）。 */
function qrSvgOf(tree) {
  return findAll(tree, (node) => node.type === 'svg' && node.props && node.props.role === 'img')
}

test('微信卡片：二维码由 imgContent 编成，矩阵与公开实现逐格一致', async () => {
  const env = await setupPlugin()
  const { encodeQr, qrGeometry } = env.module.__test

  const code = encodeQr(WX_QR_LINK)
  assert.equal(code.version, 6, '真实登录链接落在版本 6')
  assert.equal(code.size, 41)
  const flat = code.modules.map((row) => row.map((cell) => (cell ? '1' : '0')).join('')).join('\n')
  assert.equal(createHash('sha256').update(flat).digest('hex'), WX_QR_DIGEST, '矩阵要和公开实现一致，不能只是「看起来像二维码」')

  // 结构自检：三个角有定位图案，第 6 行是定时图案。
  assert.equal(code.modules[0][0], true)
  assert.equal(code.modules[0][code.size - 1], true)
  assert.equal(code.modules[code.size - 1][0], true)
  assert.equal(code.modules[1][1], false)
  assert.equal(code.modules[3][3], true)
  assert.equal(code.modules[6][8], true)
  assert.equal(code.modules[6][9], false)

  // 几何：41 个模块 + 两侧各 4 个模块静区；左上角第一个黑块从静区外开始。
  const geometry = qrGeometry(code)
  assert.equal(geometry.dimension, 49)
  assert.match(geometry.path, /^M4 4h1v1h-1z/)

  // 超出版本 10 的容量要明确报错，而不是产出一张坏码。
  assert.throws(() => encodeQr('x'.repeat(400)), /版本 10/)
})

test('微信卡片：waiting_scan 画内联 SVG 二维码，并给打开与复制两条兜底', async () => {
  const env = await setupPlugin()
  const { WechatChannel } = env.module.__test
  const mount = (initial) => env.renderComponent(WechatChannel, {
    config: { wechatEnabled: true },
    change: () => {},
    initial,
  })

  let tree = mount({ enabled: true, status: { state: 'waiting_scan' }, qrcode: { qrcode: 'e97a70cd', imgContent: WX_QR_LINK } })
  const svg = qrSvgOf(tree)
  assert.equal(svg.length, 1, '要有二维码')
  assert.equal(svg[0].props.viewBox, '0 0 49 49')
  assert.equal(findAll(tree, (node) => node.type === 'img').length, 0, '不把链接当图片地址塞进 img')
  assert.equal(findAll(svg[0], (node) => node.type === 'path').length, 1, '黑块合并成一条 path')
  assert.match(textOf(tree), /等待扫码/)
  assert.match(textOf(tree), /用手机微信扫码确认。/)
  const link = findAll(tree, (node) => node.type === 'a' && node.props && node.props.href === WX_QR_LINK)[0]
  assert.ok(link, '「在浏览器打开」要有链接')
  assert.equal(link.props.target, '_blank')
  assert.equal(link.props.rel, 'noreferrer noopener')
  assert.deepEqual(visibleText(link.children), ['在浏览器打开'])
  assert.equal(findButton(tree, '复制链接').length, 1, '「复制链接」按钮要一直在')

  // 已登录：即使状态里还留着上一张二维码的内容，也不再画码。
  tree = mount({ enabled: true, status: { state: 'confirmed', connected: true, botId: 'ilink-bot-1' }, qrcode: { qrcode: '', imgContent: WX_QR_LINK } })
  assert.equal(qrSvgOf(tree).length, 0, '已登录不出二维码')
  assert.match(textOf(tree), /已登录/)
  assert.equal(findButton(tree, '复制链接').length, 0, '已登录不显示链接兜底')

  // 二维码还没出来：给一句可等的提示，不画空框里的假码。
  tree = mount({ enabled: true, status: { state: 'waiting_scan' }, qrcode: { qrcode: 'token', imgContent: '' } })
  assert.equal(findAll(tree, (node) => node.type === 'svg').length, 0)
  assert.match(textOf(tree), /二维码还没出来，请稍候…/)
})

test('微信卡片：复制链接写到剪贴板，没有剪贴板时给可操作的提示', async () => {
  const env = await setupPlugin()
  const { WechatChannel } = env.module.__test
  const mount = () => env.renderComponent(WechatChannel, {
    config: { wechatEnabled: true },
    change: () => {},
    initial: { enabled: true, status: { state: 'waiting_scan' }, qrcode: { qrcode: 'token', imgContent: WX_QR_LINK } },
  })

  // 测试环境没有 navigator.clipboard（Node 默认如此）：要说明复制失败，别静默。
  let tree = mount()
  findButton(tree, '复制链接')[0].props.onClick({})
  await nextTick()
  tree = env.flush()
  assert.match(textOf(tree), /复制失败，请手动选中链接复制。/)

  // 有剪贴板时写入的就是 imgContent 原串。
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const written = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text) => { written.push(text) } } },
  })
  try {
    tree = mount()
    findButton(tree, '复制链接')[0].props.onClick({})
    await nextTick()
    tree = env.flush()
    assert.deepEqual(written, [WX_QR_LINK])
    assert.match(textOf(tree), /链接已复制。/)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
    else delete globalThis.navigator
  }
})

test('微信卡片：扫码登录、退出登录、测试消息各打对接口', async () => {
  const env = await setupPlugin()
  const { WechatChannel } = env.module.__test
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options: options })
    return { json: async () => ({ ok: true, enabled: true, status: { state: 'connecting' }, qrcode: {} }) }
  }
  try {
    let tree = env.renderComponent(WechatChannel, {
      config: { wechatEnabled: true },
      change: () => {},
      initial: { enabled: true, status: { state: 'stopped' }, qrcode: {} },
    })
    findButton(tree, '扫码登录')[0].props.onClick({})
    await nextTick()
    tree = env.flush()
    const login = calls.find((call) => call.url.endsWith('/wechat/login'))
    assert.ok(login, '要调 /wechat/login')
    assert.equal(login.options.method, 'POST')
    assert.match(textOf(tree), /正在获取二维码…/, '按返回状态刷新')

    calls.length = 0
    tree = env.renderComponent(WechatChannel, {
      config: { wechatEnabled: true },
      change: () => {},
      initial: { enabled: true, status: { state: 'confirmed', connected: true }, qrcode: {} },
      testPeer: WX,
    })
    findButton(tree, '发送微信测试消息')[0].props.onClick({})
    await nextTick()
    tree = env.flush()
    const testSend = calls.find((call) => call.url.endsWith('/test-send'))
    assert.ok(testSend, '要调 /test-send')
    assert.deepEqual(JSON.parse(testSend.options.body), { channel: 'wechat', qq: WX })
    assert.match(textOf(tree), /已发送微信测试消息/)

    calls.length = 0
    tree = env.renderComponent(WechatChannel, {
      config: { wechatEnabled: true },
      change: () => {},
      initial: { enabled: true, status: { state: 'confirmed', connected: true }, qrcode: {} },
    })
    findButton(tree, '退出登录')[0].props.onClick({})
    await nextTick()
    env.flush()
    assert.ok(calls.some((call) => call.url.endsWith('/wechat/logout')), '要调 /wechat/logout')
  } finally {
    env.mount(() => null)
    globalThis.fetch = original
  }
})

test('微信卡片：登录中每 2 秒轮询，登录完成后停，卸载清理定时器', async () => {
  const env = await setupPlugin()
  const { WechatChannel } = env.module.__test
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const originalFetch = globalThis.fetch
  const timers = []
  const cleared = []
  const calls = []
  globalThis.setTimeout = (fn, ms) => {
    timers.push({ fn, ms })
    return timers.length
  }
  globalThis.clearTimeout = (id) => { cleared.push(id) }
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { json: async () => ({ ok: true, enabled: true, status: { state: 'confirmed', connected: true }, qrcode: {} }) }
  }
  try {
    env.setEffects(true)
    env.mount(WechatChannel, {
      config: { wechatEnabled: true },
      change: () => {},
      initial: { enabled: true, status: { state: 'waiting_scan' }, qrcode: { qrcode: 'q', imgContent: '' } },
    })
    assert.equal(timers.length, 1, '等待扫码时排一次轮询')
    assert.equal(timers[0].ms, 2000, '轮询间隔 2 秒')

    // 定时器到点：拉一次登录接口，拿到已登录状态。
    await timers[0].fn()
    const tree = env.flush()
    assert.ok(calls.some((url) => url.endsWith('/wechat/login')), '轮询要调登录接口')
    assert.equal(timers.length, 1, '登录完成后不再排下一次')
    assert.match(visibleText(tree).join(''), /已登录/)
    assert.deepEqual(cleared, [1], '状态变化时清掉上一个定时器')

    // 已登录、未启用两种情况下都不轮询。
    timers.length = 0
    env.mount(WechatChannel, {
      config: { wechatEnabled: true },
      change: () => {},
      initial: { enabled: true, status: { state: 'confirmed', connected: true }, qrcode: {} },
    })
    assert.equal(timers.length, 0, '已登录不轮询')
    env.mount(WechatChannel, {
      config: { wechatEnabled: false },
      change: () => {},
      initial: { enabled: false, status: { state: 'waiting_scan' }, qrcode: {} },
    })
    assert.equal(timers.length, 0, '未启用不轮询')

    // 卸载：登录中挂着的定时器要清掉。
    timers.length = 0
    cleared.length = 0
    env.mount(WechatChannel, {
      config: { wechatEnabled: true },
      change: () => {},
      initial: { enabled: true, status: { state: 'connecting' }, qrcode: {} },
    })
    assert.equal(timers.length, 1)
    env.mount(() => null)
    assert.deepEqual(cleared, [1], '卸载时清定时器')
  } finally {
    env.mount(() => null)
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    globalThis.fetch = originalFetch
  }
})

test('渠道按钮：微信渠道显示「微信」前缀，提交 /bindings/assign 时带 channel', async () => {
  const env = await setupPlugin()
  const bindings = [
    { channel: 'wechat', peer: WX, qq: WX, session: '', name: '小号', enabled: true },
    { channel: 'qq', qq: '10001', session: 'session-test-0002', name: '主人', enabled: true },
  ]
  // 假的 /bindings/assign：按提交的整组把两条都挂到当前会话。
  const stub = stubBindFetch({
    bindings,
    onAssign: (body) => ({
      ok: true,
      bindings: bindings.map((binding) => {
        const peer = binding.peer || binding.qq
        const channel = binding.channel || 'qq'
        const picked = (body.bindings || []).some((item) => item.channel === channel && item.peer === peer)
        return { ...binding, session: picked ? body.sessionId : '' }
      }),
    }),
  })
  try {
    let tree = await mountBindChannel(env, { sessionId: 'session-test-0002' })
    assert.equal(channelTriggerText(tree), '主人 QQ')

    tree = await openChannelMenu(env)
    assert.deepEqual(channelOptions(tree).map(channelOptionLabel), ['小号 微信', '主人 QQ', '全部解绑'])
    assert.deepEqual(
      channelOptions(tree).map((node) => node.props.title),
      ['微信 ' + WX, 'QQ 10001', '只解除这间会话的绑定，渠道仍保留在设置页'],
      '完整账号放 title，微信的字母与 @ 不删',
    )

    pickChannel(tree, '小号 微信')
    tree = env.flush()
    await nextTick()
    tree = env.flush()
    const call = stub.calls.find((item) => item.url.endsWith('/bindings/assign'))
    assert.ok(call, '勾选微信渠道要提交 /bindings/assign')
    assert.deepEqual(JSON.parse(call.options.body), {
      sessionId: 'session-test-0002',
      bindings: [
        { channel: 'wechat', peer: WX },
        { channel: 'qq', peer: '10001' },
      ],
    })
    assert.equal(channelTriggerText(tree), '2 条渠道')
  } finally {
    env.mount(() => null)
    stub.restore()
  }
})
