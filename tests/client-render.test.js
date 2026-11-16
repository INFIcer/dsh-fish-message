// 客户端冒烟测试：设置页 Section + 图库管理主面板 GalleryPage。
//
// client.js 是 DSH 的浏览器端插件，平时只能在 Web 客户端里跑。这里用假的
// window.__ModuleLoader__ / React / slots / layout 把它加载起来、真的跑一遍渲染，
// 专门抓「页面一打开就抛异常」的问题（例如 TDZ：const 声明写在使用之后，
// node --check 只查语法，查不出来），以及面板注册与跨面板切页签的参数。

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
  const named = new Map()
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
    /**
     * 展开某个函数组件前调用：按组件名取它自己的预设，没有就按初值渲染。
     * 假 React 的 useState 按调用顺序取预设，不按组件隔离会串到父组件的预设上。
     */
    resetOrder(type) {
      const name = typeof type === 'function' ? type.name : ''
      preset = name && named.has(name) ? named.get(name) : []
      order = 0
    },
    /** 给某个函数组件单独预设 useState 初值（展开子组件时用）。 */
    presetFor(name, values) { named.set(name, values || []) },
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

/** 展开函数组件：假 React 的 createElement 只生成元素对象、不执行子组件。 */
function expandTree(node, fake) {
  if (node == null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((child) => expandTree(child, fake))
  if (typeof node.type === 'function') {
    fake.resetOrder(node.type)
    return expandTree(node.type(node.props), fake)
  }
  return { ...node, children: (node.children || []).map((child) => expandTree(child, fake)) }
}

/** 深度优先找出所有满足条件的元素。 */
function findAll(node, predicate, output = []) {
  if (node == null || typeof node !== 'object') return output
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

/** 一条足够渲染整页的 /state 快照。 */
function fullState() {
  return {
    ok: true,
    version: '0.2.1',
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
    imageDir: 'C:/tmp/fish-message-images',
    images: { count: 0, keepFiles: true, maxItems: 1000, maxMB: 512 },
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

/** 注册全部 slot，返回可反复渲染设置页 / 图库主面板的测试环境。 */
async function setupPlugin() {
  const fake = await loadClient()
  const bySlot = new Map()
  const selected = []
  const layout = { selectPanel(id) { selected.push(id) } }
  const slots = {
    inject(name, registrar) {
      assert.ok(typeof registrar === 'function', `${name} 需要注册函数`)
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
  fake.module.apply({
    get: (name) => (name === 'slots' ? slots : name === 'layout' ? layout : undefined),
    layout,
  })
  const componentOf = (slot) => (bySlot.get(slot) || [])[0]?.component
  return {
    ...fake,
    bySlot,
    selected,
    section: componentOf('settings.section'),
    main: componentOf('main'),
    icon: componentOf('sidebar.panellist'),
    renderSection(values) {
      fake.setPreset(values)
      return componentOf('settings.section')()
    },
    renderMain(values) {
      fake.setPreset(values)
      return componentOf('main')()
    },
  }
}

test('客户端设置页：加载态、完整状态、缺 defaults 都能渲染，不抛异常', async () => {
  const env = await setupPlugin()
  const render = (state) => {
    env.setPreset([state])
    return env.section()
  }

  // a) 还没拉到 /state 的加载态。
  assert.doesNotThrow(() => render(null))

  // b) 完整状态：整页渲染一遍，并确认关键文案确实在输出里。
  let complete
  assert.doesNotThrow(() => { complete = render(fullState()) })
  const plainText = collectText(complete).join('\n')
  assert.match(plainText, /长任务提醒提示词/)
  assert.match(plainText, /消息通道提醒提示词/)
  assert.match(plainText, /防失联/)
  // 记忆扩展卡片仍在设置页（入站比对是鱼讯自己的能力，不属于图库页面）。
  assert.match(plainText, /记忆扩展/)
  assert.match(plainText, /比对图像/)
  assert.match(plainText, /比对声纹/)
  assert.match(plainText, /记忆服务：未检测到（需要安装并启用记忆插件）/)
  assert.match(plainText, /本地 AI：可用/)
  // 收图图库配置项仍在设置页（表情包块的配置在下面的相邻性测试里展开检查）。
  assert.match(plainText, /收图先查图库/)

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

test('注册：设置页、图库主面板、侧边栏入口与 layout 依赖', async () => {
  const env = await setupPlugin()
  assert.deepEqual(env.module.inject, ['slots', 'layout'])

  const settings = env.bySlot.get('settings.section') || []
  assert.equal(settings.length, 1)
  assert.equal(settings[0].mod.id, 'fish-message')
  assert.equal(typeof settings[0].component, 'function')

  const main = env.bySlot.get('main') || []
  assert.equal(main.length, 1)
  assert.deepEqual(main[0].mod, { name: 'main', key: 'fish-gallery' })
  assert.equal(typeof main[0].component, 'function')

  const panels = env.bySlot.get('sidebar.panellist') || []
  assert.equal(panels.length, 1)
  assert.equal(panels[0].mod.id, 'fish-gallery')
  assert.equal(panels[0].mod.order, 20)
  assert.equal(panels[0].mod.label(), '图库')
  const icon = panels[0].component({ size: 16, active: true })
  assert.equal(icon.type, 'svg', '侧边栏入口要渲染一个图标')

  // package.json 的客户端注入声明必须与代码一致，否则 layout 取不到。
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.dsh.client.inject, ['slots', 'layout'])
})

test('图库主面板：只有表情库与收图图库两个页签，不残留记忆页签', async () => {
  const env = await setupPlugin()
  const page = env.renderMain(['stickers', fullState()])
  const tree = expandTree(page, env)
  const text = collectText(tree).join('\n')

  assert.match(text, /图库管理/)
  assert.match(text, /表情库/)
  assert.match(text, /收图图库/)
  assert.doesNotMatch(text, /记忆图库/)
  assert.doesNotMatch(text, /声纹库/)
  assert.doesNotMatch(text, /记忆插件未启用/)
  assert.doesNotMatch(text, /返回设置/, '主面板是整页，不需要返回设置')
  // 主面板的标题、页签与内容区都渲染出来。
  assert.ok(findButton(tree, '表情库').length >= 1)
  assert.ok(findButton(tree, '收图图库').length >= 1)
  assert.match(text, /暂无表情/)

  const imagePage = env.renderMain(['images', fullState()])
  const imageTree = expandTree(imagePage, env)
  const imageText = collectText(imageTree).join('\n')
  assert.match(imageText, /缓存图片/)
  assert.match(imageText, /清空图库/)
  assert.match(imageText, /打开图库文件夹/)
  // 配置项留在设置页，主面板不再重复一份。
  assert.doesNotMatch(imageText, /收图图库设置/)
})

test('设置页：两块相邻，入口先记页签再切主面板', async () => {
  const env = await setupPlugin()
  const sectionPage = env.renderSection([fullState()])
  const page = expandTree(sectionPage, env)
  const blocks = Array.isArray(page.children) ? page.children : []
  const textOf = (node) => collectText(node).join('\n')
  const stickerAt = blocks.findIndex((node) => /保存位置/.test(textOf(node)))
  const imageAt = blocks.findIndex((node) => /收图先查图库/.test(textOf(node)))
  assert.ok(stickerAt >= 0, '设置页应该有表情包块')
  assert.ok(imageAt >= 0, '设置页应该有收图图库块')
  assert.equal(imageAt, stickerAt + 1, '表情包与收图图库两块必须相邻')

  const stickerButton = findButton(blocks[stickerAt], '打开图库管理')
  const imageButton = findButton(blocks[imageAt], '打开图库管理')
  assert.equal(stickerButton.length, 1)
  assert.equal(imageButton.length, 1)

  stickerButton[0].props.onClick()
  assert.deepEqual(env.selected, ['fish-gallery'], '点击入口要切到图库主面板')
  assert.equal(env.module.__test.galleryStore.get(), 'stickers')

  imageButton[0].props.onClick()
  assert.deepEqual(env.selected, ['fish-gallery', 'fish-gallery'])
  assert.equal(env.module.__test.galleryStore.get(), 'images')
})

test('图库主面板：已经在该面板时也能切页签', async () => {
  const env = await setupPlugin()
  const store = env.module.__test.galleryStore
  const seen = []
  const off = store.subscribe((tab) => seen.push(tab))

  // 设置页入口走的是同一条模块级 store：面板已挂载时靠订阅切页签。
  env.module.__test.openGallery('images')
  assert.deepEqual(seen, ['images'])
  assert.equal(store.get(), 'images')
  assert.deepEqual(env.selected, ['fish-gallery'])

  // 下一次挂载（或重新打开主面板）也读得到同一个页签。
  const page = env.renderMain([])
  const tree = expandTree(page, env)
  assert.match(collectText(tree).join('\n'), /缓存图片/)

  off()
  store.set('stickers')
  assert.deepEqual(seen, ['images'], '取消订阅后不再收到通知')
})

test('收图图库：存为表情用原图绝对路径与 qq-inbox 来源', async () => {
  const env = await setupPlugin()
  const entry = {
    sha256: 'a'.repeat(64),
    file: 'img/aa/x.png',
    path: 'C:/tmp/fish-message-images/img/aa/x.png',
    desc: '一只猫',
    descSource: 'local',
    bytes: 100,
    width: 1,
    height: 1,
    hits: 2,
    firstSeenAt: '2026-11-16T12:00:00',
  }
  // 收图页签的第一个 useState 是列表；给一条缓存条目，按钮才会渲染出来。
  env.presetFor('imageTab', [{ entries: [entry], total: 1, stats: { count: 1 } }])
  const page = env.renderMain(['images', fullState()])
  const expanded = expandTree(page, env)
  const buttons = findButton(expanded, '存为表情')
  assert.equal(buttons.length, 1)

  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return { json: async () => ({ ok: true, created: true }) }
  }
  try {
    await buttons[0].props.onClick()
  } finally {
    delete globalThis.fetch
  }

  const save = calls.find((call) => call.url.endsWith('/stickers/save'))
  assert.ok(save, '应该调用 /stickers/save')
  const body = JSON.parse(save.options.body)
  assert.equal(body.path, entry.path, 'path 必须是图库条目的原图绝对路径')
  assert.equal(body.source, 'qq-inbox', 'source 必须是 qq-inbox')
  assert.equal(body.desc, '一只猫')
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
