// 客户端冒烟测试：设置页 Section + 设置内图库弹窗。
//
// client.js 是 DSH 的浏览器端插件，平时只能在 Web 客户端里跑。这里用假的
// window.__ModuleLoader__ / React / slots 把它加载起来、真的跑一遍渲染，
// 专门抓「页面一打开就抛异常」的问题（例如 TDZ：const 声明写在使用之后，
// node --check 只查语法，查不出来），以及注册面、设置内弹窗与统一交互。

import test from 'node:test'
import assert from 'node:assert/strict'
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

test('注册：设置分区 + 会话输入框渠道下拉，不再有主面板与侧边栏入口', async () => {
  const env = await setupPlugin()
  assert.deepEqual(env.module.inject, ['slots'])

  const settings = env.bySlot.get('settings.section') || []
  assert.equal(settings.length, 1)
  assert.equal(settings[0].mod.id, 'fish-message')
  assert.equal(settings[0].mod.order, 56)
  assert.equal(typeof settings[0].mod.label, 'function')
  assert.equal(settings[0].mod.label(), '鱼讯 QQ')
  assert.equal(typeof settings[0].component, 'function')

  // 会话输入框左侧：与本地 AI 插件的开关同一排，每个会话一个收发渠道入口。
  const inputLeft = env.bySlot.get('conversation.input.left') || []
  assert.equal(inputLeft.length, 1)
  assert.equal(inputLeft[0].mod.id, 'fish-bind')
  assert.equal(inputLeft[0].mod.order, 46)
  assert.equal(typeof inputLeft[0].mod.label, 'function')
  assert.equal(inputLeft[0].mod.label(), 'QQ 收发渠道')
  assert.equal(typeof inputLeft[0].component, 'function')

  assert.equal(env.bySlot.get('main'), undefined, '不应再注册 main 主面板')
  assert.equal(env.bySlot.get('sidebar.panellist'), undefined, '不应再注册侧边栏入口')
  assert.deepEqual([...env.bySlot.keys()].sort(), ['conversation.input.left', 'settings.section'])

  // package.json 的客户端注入声明必须与代码一致。
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.dsh.client.inject, ['slots'])
})

/** 输入框旁渠道下拉的假 fetch：只回 /state 与 /bindings/assign。 */
function stubBindFetch({ bindings = [], onAssign } = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url)
    calls.push({ url: address, options: options })
    if (address.endsWith('/state')) {
      return { json: async () => ({ ok: true, bindings: bindings, sessions: [] }) }
    }
    if (address.endsWith('/bindings/assign')) {
      const body = JSON.parse(options.body || '{}')
      return { json: async () => (onAssign ? onAssign(body) : { ok: true, bindings: bindings }) }
    }
    return { json: async () => ({ ok: false, error: 'unexpected' }) }
  }
  return {
    calls,
    restore() { globalThis.fetch = original },
  }
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 下拉是当前唯一一个 select。 */
function channelSelect(tree) {
  return findAll(tree, (node) => node.type === 'select')[0]
}

/** 挂上组件并等 /state 回来，返回渲染结果。 */
async function mountBindChannel(env, props) {
  const { BindChannel } = env.module.__test
  env.setEffects(true)
  env.mount(BindChannel, props)
  await nextTick()
  return env.flush()
}

test('渠道下拉：没有会话上下文时返回 null，不渲染', async () => {
  const env = await setupPlugin()
  assert.equal(typeof env.module.__test.BindChannel, 'function')
  assert.equal(env.renderComponent(env.module.__test.BindChannel, {}), null)
  assert.equal(env.renderComponent(env.module.__test.BindChannel, { sessionId: '' }), null)
})

test('渠道下拉：选中当前会话绑定的渠道，只列启用的渠道，已绑定的禁用渠道仍可见', async () => {
  const env = await setupPlugin()
  const bindings = [
    { qq: '10001', session: 'session-test-0001', name: '主人', enabled: false },
    { qq: '10002', session: '', name: '小号', enabled: true },
    { qq: '10003', session: 'session-other', name: '别人', enabled: false },
  ]
  const stub = stubBindFetch({ bindings })
  try {
    const tree = await mountBindChannel(env, { sessionId: 'session-test-0001' })
    const select = channelSelect(tree)
    assert.ok(select, '有会话时要渲染下拉')
    assert.equal(select.props.value, '10001', '当前会话绑定的渠道要被选中')
    const labels = findAll(select, (node) => node.type === 'option')
      .map((node) => collectText(node.children).join(''))
    assert.deepEqual(labels, ['不绑定', '主人：QQ-10001', '小号：QQ-10002'])
    const states = stub.calls.filter((call) => call.url.endsWith('/state'))
    assert.equal(states.length, 1, '挂载时只拉一次状态，不做轮询')
  } finally {
    env.mount(() => null)
    stub.restore()
  }
})

test('渠道下拉：切换渠道提交 /bindings/assign，参数是会话 id 与目标 qq', async () => {
  const env = await setupPlugin()
  const before = [
    { qq: '10001', session: 'session-test-0001', name: '主人', enabled: true },
    { qq: '10002', session: '', name: '小号', enabled: true },
  ]
  const after = [
    { qq: '10001', session: '', name: '主人', enabled: true },
    { qq: '10002', session: 'session-test-0001', name: '小号', enabled: true },
  ]
  const stub = stubBindFetch({ bindings: before, onAssign: () => ({ ok: true, bindings: after }) })
  try {
    let tree = await mountBindChannel(env, { sessionId: 'session-test-0001' })
    await channelSelect(tree).props.onChange({ target: { value: '10002' } })
    tree = env.flush()

    const call = stub.calls.find((item) => item.url.endsWith('/bindings/assign'))
    assert.ok(call, '切换渠道要提交 /bindings/assign')
    assert.equal(call.options.method, 'POST')
    assert.deepEqual(JSON.parse(call.options.body), { sessionId: 'session-test-0001', qq: '10002' })
    assert.equal(channelSelect(tree).props.value, '10002', '成功后按返回的状态校准选中项')
  } finally {
    env.mount(() => null)
    stub.restore()
  }
})

test('渠道下拉：选「不绑定」提交空 qq，只解绑不删渠道', async () => {
  const env = await setupPlugin()
  const before = [{ qq: '10001', session: 'session-test-0001', name: '主人', enabled: true }]
  const after = [{ qq: '10001', session: '', name: '主人', enabled: true }]
  const stub = stubBindFetch({ bindings: before, onAssign: () => ({ ok: true, bindings: after }) })
  try {
    let tree = await mountBindChannel(env, { sessionId: 'session-test-0001' })
    await channelSelect(tree).props.onChange({ target: { value: '' } })
    tree = env.flush()

    const call = stub.calls.find((item) => item.url.endsWith('/bindings/assign'))
    assert.ok(call)
    assert.deepEqual(JSON.parse(call.options.body), { sessionId: 'session-test-0001', qq: '' })
    assert.equal(channelSelect(tree).props.value, '', '解绑后回落到「不绑定」')
    assert.match(textOf(channelSelect(tree)), /主人：QQ-10001/, '渠道仍留在选项里')
  } finally {
    env.mount(() => null)
    stub.restore()
  }
})

test('渠道下拉：请求失败时退回原选中并提示原因，下拉不消失', async () => {
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
    await channelSelect(tree).props.onChange({ target: { value: '10002' } })
    tree = env.flush()

    const select = channelSelect(tree)
    assert.ok(select, '失败后下拉不能消失')
    assert.equal(select.props.value, '10001', '失败要退回原选中')
    assert.match(textOf(tree), /没有 QQ 10002 的收发渠道，请先在设置页添加。/)

    // 连不上宿主时给一句人话，不把网络报错直接甩给用户。
    globalThis.fetch = async () => { throw new Error('Failed to fetch') }
    await select.props.onChange({ target: { value: '10002' } })
    tree = env.flush()
    assert.equal(channelSelect(tree).props.value, '10001')
    assert.match(textOf(tree), /没能切换收发渠道，请稍后重试。/)
    assert.doesNotMatch(textOf(tree), /Failed to fetch/)
  } finally {
    env.mount(() => null)
    stub.restore()
  }
})

test('渠道下拉：同一实例切换会话后按新会话刷新选中', async () => {
  const env = await setupPlugin()
  const bindings = [
    { qq: '10001', session: 'session-a', name: '主人', enabled: true },
    { qq: '10002', session: 'session-b', name: '小号', enabled: true },
  ]
  const stub = stubBindFetch({ bindings })
  try {
    let tree = await mountBindChannel(env, { sessionId: 'session-a' })
    assert.equal(channelSelect(tree).props.value, '10001')

    tree = env.setProps({ sessionId: 'session-b' })
    await nextTick()
    tree = env.flush()
    assert.equal(channelSelect(tree).props.value, '10002', '会话变了要按新会话的绑定显示')
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
    assert.match(textOf(tree), /鱼讯 QQ/, '设置页不能被一起关掉')
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
    assert.match(textOf(tree), /鱼讯 QQ/)

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
