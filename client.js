// dsh-fish-message · 设置页（DSH Web 客户端插件）
//
// 纯原生 JS + React（DSH 平台自带），没有 npm、没有 CDN、没有构建步骤。
// 挂载方式照 dsh-qq-bridge 的 client.js：window.__ModuleLoader__.load → slots.register。
// 只注册 settings.section；图库管理是设置页里的弹窗，不注册主面板与侧边栏入口。
// 这里只读写宿主路由，不直接碰 QQ / 会话。

window.__ModuleLoader__.load({
  id: 'dsh-fish-message',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const inject = ['slots']
    const h = React.createElement
    const B = '/dsh-fish-message'

    const get = (path) => fetch(B + path, { cache: 'no-store' })
      .then((r) => r.json())
      .catch(() => null)
    const post = (path, body) => fetch(B + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json()).catch((error) => ({ ok: false, error: String(error?.message || error) }))
    const postForm = (path, form) => fetch(B + path, { method: 'POST', body: form })
      .then((r) => r.json())
      .catch((error) => ({ ok: false, error: String(error?.message || error) }))
    const imageUrl = (entry) => `${B}/stickers/file?path=${encodeURIComponent(entry?.file || '')}`
    // 收图图库按指纹出图：前端不传路径，后端自己按索引找文件。
    const cachedImageUrl = (entry) => `${B}/images/file?sha256=${encodeURIComponent(entry?.sha256 || '')}`
    // 图库条目的描述来源：识图结果来自本地模型、API 路径、手动填写，或从表情库借来。
    const descSourceText = (source) => ({
      local: '本地识图',
      api: '模型',
      manual: '手动填写',
      sticker: '表情库',
    })[source] || '未标注'
    const timeText = (value) => {
      const stamp = String(value || '')
      if (!stamp) return '未知'
      const date = new Date(stamp)
      if (Number.isNaN(date.getTime())) return stamp
      return date.toLocaleString('zh-CN', { hour12: false })
    }

    const S = {
      wrap: {
        padding: '12px 14px 28px',
        fontSize: 13,
        lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.94))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: 12,
      },
      // 页面级操作条：吸在设置面板滚动区顶部，滚到哪儿都能保存、返回或刷新。
      bar: {
        position: 'sticky',
        top: 0,
        zIndex: 5,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 14px',
        margin: '-12px -14px 10px',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: '12px 12px 0 0',
      },
      barRow: { display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' },
      barActions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      h: { fontSize: 15, fontWeight: 650, margin: '16px 0 8px' },
      h1: { fontSize: 17, fontWeight: 700, margin: '0 0 4px' },
      dim: { opacity: 0.62, fontSize: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
        padding: '10px 12px',
        marginBottom: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap' },
      lab: { minWidth: 190, paddingTop: 3, fontSize: 12.5 },
      ctl: { flex: '1 1 280px', minWidth: 220 },
      hint: { opacity: 0.58, fontSize: 11.5, marginTop: 2 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        boxSizing: 'border-box',
      },
      small: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: 150,
        boxSizing: 'border-box',
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 12px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      btnOn: {
        border: '1px solid var(--dsw-alias-state-business-primary)',
        borderRadius: 6,
        padding: '4px 12px',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
        fontSize: 12,
        cursor: 'pointer',
      },
      danger: { color: '#c0392b', fontSize: 12 },
      ok: { color: 'var(--dsw-alias-state-business-primary)', fontSize: 12 },
      badge: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 20,
        fontSize: 11.5,
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      bindGrid: {
        display: 'grid',
        gridTemplateColumns: '120px 1fr 110px 52px 40px',
        gap: 6,
        alignItems: 'center',
        marginBottom: 6,
      },
      th: { fontSize: 11.5, opacity: 0.6 },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(172px, 1fr))',
        gap: 10,
        marginTop: 8,
      },
      thumb: {
        width: '100%',
        height: 128,
        objectFit: 'contain',
        background: 'rgba(0,0,0,.05)',
        borderRadius: 6,
      },
      chip: {
        display: 'inline-block',
        padding: '0 6px',
        marginRight: 4,
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l2)',
        fontSize: 11,
        opacity: 0.8,
      },
      log: {
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: 11.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        height: 260,
        overflow: 'auto',
        background: 'rgba(0,0,0,.06)',
        borderRadius: 6,
        padding: 8,
      },
      // 图库弹窗：遮罩固定定位，面板限高、内部滚动。
      btnDanger: {
        border: '1px solid #c0392b',
        borderRadius: 6,
        padding: '4px 12px',
        background: '#c0392b',
        color: '#fff',
        fontSize: 12,
        cursor: 'pointer',
      },
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: 'rgba(0,0,0,.45)',
      },
      dialog: {
        width: 'min(880px, 100%)',
        maxHeight: '84vh',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1))',
        borderRadius: 14,
        boxShadow: '0 18px 50px rgba(0,0,0,.35)',
        overflow: 'hidden',
        outline: 'none',
      },
      modalHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '12px 16px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
      },
      modalTitle: { fontSize: 16, fontWeight: 700 },
      modalClose: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 8,
        width: 28,
        height: 28,
        lineHeight: 1,
        fontSize: 16,
        cursor: 'pointer',
        padding: 0,
      },
      modalTabs: { display: 'flex', padding: '10px 16px 0' },
      segment: {
        display: 'inline-flex',
        padding: 3,
        gap: 2,
        borderRadius: 9,
        background: 'rgba(0,0,0,.06)',
      },
      segmentOn: {
        border: 'none',
        borderRadius: 7,
        padding: '4px 16px',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
        fontSize: 12.5,
        cursor: 'pointer',
      },
      segmentOff: {
        border: 'none',
        borderRadius: 7,
        padding: '4px 16px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        cursor: 'pointer',
      },
      modalBody: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' },
      galleryBody: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' },
      toolbarRow: {
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '10px 16px 0',
      },
      search: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: 240,
        boxSizing: 'border-box',
      },
      content: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '12px 16px' },
      galleryCard: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: 'var(--dsw-alias-bg-layer-1)',
        cursor: 'pointer',
        textAlign: 'left',
      },
      cardName: {
        fontSize: 11.5,
        opacity: 0.7,
        wordBreak: 'break-all',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      cardDesc: {
        fontSize: 12,
        lineHeight: 1.5,
        opacity: 0.85,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        minHeight: '2.9em',
      },
      cardMeta: { fontSize: 11, opacity: 0.55 },
      thumbFallback: {
        width: '100%',
        height: 128,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,.05)',
        borderRadius: 6,
        fontSize: 11,
        opacity: 0.6,
      },
      detailHead: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
      detailTitle: { fontSize: 13.5, fontWeight: 600, wordBreak: 'break-all' },
      detailBody: { display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' },
      detailPreview: {
        flex: '0 1 320px',
        minWidth: 200,
        background: 'rgba(0,0,0,.05)',
        borderRadius: 10,
        padding: 8,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 160,
      },
      detailImage: { maxWidth: '100%', maxHeight: '46vh', objectFit: 'contain' },
      detailFields: { flex: '1 1 300px', minWidth: 240, display: 'flex', flexDirection: 'column', gap: 8 },
      detailField: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 },
      detailActions: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 },
      status: {
        minHeight: 32,
        padding: '8px 16px',
        borderTop: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        fontSize: 12,
      },
      loaderBox: { padding: '40px 0', textAlign: 'center', opacity: 0.6, fontSize: 12.5 },
      confirmMask: {
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: 'rgba(0,0,0,.3)',
      },
      confirmPanel: {
        width: 'min(420px, 100%)',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        padding: 16,
        boxShadow: '0 12px 36px rgba(0,0,0,.3)',
      },
      confirmTitle: { fontSize: 14, fontWeight: 650, marginBottom: 8 },
      confirmDesc: { fontSize: 12.5, opacity: 0.8, lineHeight: 1.7, whiteSpace: 'pre-wrap' },
      confirmActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
    }

    const hint = (text) => h('div', { style: S.hint }, text)
    const questionMark = (note) => h('span', {
      title: note,
      'aria-label': note,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 14,
        height: 14,
        marginLeft: 4,
        borderRadius: '50%',
        border: '1px solid var(--dsw-alias-border-l2)',
        fontSize: 10,
        lineHeight: 1,
        opacity: 0.65,
        cursor: 'help',
        verticalAlign: 'middle',
      },
    }, '?')

    const row = (tags, widget, note, supplement) => h('div', { style: S.row },
      h('div', { style: S.lab }, tags, supplement ? questionMark(supplement) : null),
      h('div', { style: S.ctl }, widget, note ? hint(note) : null))

    // 状态数字旁边的小问号：只有确实需要解释的指标才带。
    const metric = (text, note) => h('span', { style: { marginRight: 12, whiteSpace: 'nowrap' } },
      text, note ? questionMark(note) : null)

    // 提示文案的错误分级：失败、无法、不可用这类按错误色显示，其余按成功提示。
    const isError = (text) => /失败|无法|错误|不可用|不能|没打开/.test(String(text || ''))

    function input(value, onChange, placeholder = '', disabled = false) {
      return h('input', {
        style: S.input,
        value: value == null ? '' : String(value),
        placeholder: placeholder,
        disabled: !!disabled,
        onChange: (e) => onChange(e.target.value),
      })
    }

    function flag(value, onChange, disabled = false) {
      return h('input', { type: 'checkbox', checked: !!value, disabled: !!disabled, onChange: (e) => onChange(e.target.checked) })
    }

    // 路径输入 +「打开文件夹」：地址不存在时按钮置灰，越界等校验在宿主路由。
    function pathInput(value, onChange, placeholder, canOpen, onOpen) {
      return h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
        h('div', { style: { flex: '1 1 200px', minWidth: 160 } }, input(value, onChange, placeholder)),
        h('button', {
          type: 'button', style: S.btn, disabled: !canOpen, onClick: onOpen,
        }, '打开文件夹'))
    }

    // ---------------- 图库管理（设置内弹窗） ----------------
    // 两个库共用同一份基础组件：Toolbar / CardGrid / DetailShell / ConfirmDialog /
    // StatusLine / EmptyState / LoadingState，差异只通过参数注入（库级操作、详情动作），
    // 基础交互的改动集中在这里，不需要每个库各改一遍。
    //
    // 弹窗盖在设置页之上：固定定位的遮罩 + 限高面板，内容区自己滚动。
    // 宿主的设置弹窗也监听 Esc，所以这里在 document 捕获阶段拦下 Esc 并停止传播，
    // 保证只关本弹窗；二次确认打开时 Esc 只关确认框。
    const GALLERIES = [
      {
        id: 'stickers',
        label: '表情库',
        description: '长期收藏的表情包，不会自动删除。',
      },
      {
        id: 'images',
        label: '收图图库',
        description: '按内容指纹缓存的收图，超过上限会淘汰最久没见到的图。',
      },
    ]

    /** 空态：两个库用同一句文案，具体提示交给库级说明。 */
    function EmptyState({ text = '图库是空的。' }) {
      return h('div', { style: S.loaderBox }, text)
    }

    /** 加载态：与空态共用位置和字号，避免切换时跳动。 */
    function LoadingState({ text = '正在读取图库…' }) {
      return h('div', { style: S.loaderBox }, text)
    }

    /** 底部状态行：成功/失败各一句；失败时页面与列表保持原样。 */
    function StatusLine({ text }) {
      if (!text) return h('div', { style: S.status })
      return h('div', { style: { ...S.status, ...(isError(text) ? S.danger : S.ok) } }, text)
    }

    /**
     * 工具条：左搜索、右刷新与本库的库级操作。
     * actions 由各库注入；children 放上传这类需要额外元素的入口。
     */
    function Toolbar({ query, onQuery, onRefresh, busy, actions = [], children }) {
      return h('div', { style: S.toolbarRow },
        h('input', {
          style: S.search,
          value: query,
          placeholder: '搜索名称、描述或标签',
          onChange: (e) => onQuery(e.target.value),
        }),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginLeft: 'auto' } },
          children,
          h('button', { type: 'button', style: S.btn, onClick: onRefresh, disabled: busy }, '刷新'),
          actions.map((action) => h('button', {
            key: action.key || action.label,
            type: 'button',
            style: action.danger ? S.btnDanger : S.btn,
            onClick: action.onClick,
            disabled: busy || !!action.disabled,
          }, action.label))))
    }

    /** 卡片内容：缩略图、名称、两行描述、标签。两个库的卡片都用它。 */
    function CardBody({ src, alt, name, desc, tags = [], meta, noImageText }) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
        src
          ? h('img', { src, alt: alt || name, loading: 'lazy', style: S.thumb })
          : h('div', { style: S.thumbFallback }, noImageText || '没有预览图'),
        h('div', { style: S.cardName, title: name }, name),
        h('div', { style: S.cardDesc }, desc || '还没有描述。'),
        tags.length
          ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
            tags.map((tag) => h('span', { key: tag, style: S.chip }, tag)))
          : null,
        meta ? h('div', { style: S.cardMeta }, meta) : null)
    }

    /** 网格：统一加载态/空态与卡片点击，具体卡片内容由 renderCard 决定。 */
    function CardGrid({ items, loading, emptyText, keyOf, onOpen, renderCard }) {
      if (loading) return h(LoadingState)
      if (!items.length) return h(EmptyState, { text: emptyText })
      return h('div', { style: S.grid }, items.map((item) => h('div', {
        key: keyOf(item),
        style: S.galleryCard,
        role: 'button',
        tabIndex: 0,
        onClick: () => onOpen(item),
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen(item)
          }
        },
      }, renderCard(item))))
    }

    /** 详情外壳：左上返回、标题、预览与字段区，动作按钮由各库注入。 */
    function DetailShell({ title, onBack, preview, actions, children }) {
      return h('div', null,
        h('div', { style: S.detailHead },
          h('button', { type: 'button', style: S.btn, onClick: onBack }, '返回'),
          h('div', { style: S.detailTitle }, title)),
        h('div', { style: S.detailBody },
          h('div', { style: S.detailPreview }, preview),
          h('div', { style: S.detailFields }, children)),
        actions ? h('div', { style: S.detailActions }, actions) : null)
    }

    /** 详情里的带标签字段。 */
    const field = (label, control) => h('label', { style: S.detailField },
      h('span', { style: { opacity: 0.7 } }, label),
      control)

    /** 危险操作的二次确认：与弹窗同源样式，明确「取消 / 确认」。 */
    function ConfirmDialog({ title, description, confirmLabel = '确认', cancelLabel = '取消', busy, onCancel, onConfirm }) {
      const focusRef = React.useRef(null)
      React.useEffect(() => {
        try { focusRef.current?.focus?.() } catch { /* 聚焦失败不影响确认 */ }
      }, [])
      return h('div', {
        style: S.confirmMask,
        onClick: (e) => { if (e.target === e.currentTarget) onCancel() },
      },
        h('div', { style: S.confirmPanel, role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
          h('div', { style: S.confirmTitle }, title),
          description ? h('div', { style: S.confirmDesc }, description) : null,
          h('div', { style: S.confirmActions },
            h('button', { type: 'button', style: S.btn, onClick: onCancel, disabled: busy }, cancelLabel),
            h('button', {
              type: 'button', style: S.btnDanger, ref: focusRef, onClick: onConfirm, disabled: busy,
            }, busy ? '正在处理…' : confirmLabel))))
    }

    /**
     * 图库弹窗：标题、页签、内容区与底部状态行。
     * 页签内容由两个库组件提供，弹窗只负责壳、Esc、遮罩与二次确认的挂载。
     */
    function GalleryModal({ open, initialTab = 'stickers', onClose, imageDir = '', bindings = [] }) {
      const [tab, setTab] = React.useState(initialTab)
      const [confirm, setConfirm] = React.useState(null)
      const [confirmBusy, setConfirmBusy] = React.useState(false)
      const panelRef = React.useRef(null)

      // 每次打开都回到触发入口对应的页签，并把焦点移进面板。
      React.useEffect(() => {
        if (!open) return undefined
        setTab(initialTab)
        try { panelRef.current?.focus?.() } catch { /* 聚焦失败不影响弹窗 */ }
        return undefined
      }, [open, initialTab])

      // 捕获阶段拦 Esc：阻止宿主设置弹窗也跟着关；确认框打开时只关确认框。
      React.useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          try { event.stopImmediatePropagation?.() } catch { /* 老浏览器没有这个方法 */ }
          if (confirm !== null) {
            // 正在处理的确认框不关，避免请求还在跑时失去反馈。
            if (!confirmBusy) setConfirm(null)
          } else onClose()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [open, confirm, confirmBusy, onClose])

      if (!open) return null
      const current = GALLERIES.find((item) => item.id === tab) || GALLERIES[0]
      const askConfirm = (options) => setConfirm(options)
      const runConfirm = async () => {
        const action = confirm && confirm.run
        if (!action) {
          setConfirm(null)
          return
        }
        setConfirmBusy(true)
        try { await action() } finally {
          setConfirmBusy(false)
          setConfirm(null)
        }
      }
      const body = current.id === 'stickers'
        ? h(StickerGallery, { bindings, askConfirm })
        : h(ImageGallery, { imageDir, askConfirm })

      return h('div', {
        style: S.overlay,
        onClick: (e) => {
          if (confirm === null && e.target === e.currentTarget) onClose()
        },
      },
        h('div', {
          style: S.dialog,
          ref: panelRef,
          tabIndex: -1,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '图库管理',
          // 兜底：焦点留在面板内时，Esc 也不往宿主冒泡。
          onKeyDown: (e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
            }
          },
        },
          h('div', { style: S.modalHead },
            h('div', { style: S.modalTitle }, '图库管理'),
            h('button', {
              type: 'button', style: S.modalClose, 'aria-label': '关闭图库管理', onClick: onClose,
            }, '×')),
          h('div', { style: S.modalTabs },
            h('div', { style: S.segment },
              GALLERIES.map((item) => h('button', {
                key: item.id,
                type: 'button',
                style: item.id === current.id ? S.segmentOn : S.segmentOff,
                'aria-pressed': item.id === current.id,
                onClick: () => setTab(item.id),
              }, item.label)))),
          h('div', { style: S.modalBody }, body),
          confirm
            ? h(ConfirmDialog, {
              title: confirm.title,
              description: confirm.description,
              confirmLabel: confirm.confirmLabel || '确认',
              busy: confirmBusy,
              onCancel: () => { if (!confirmBusy) setConfirm(null) },
              onConfirm: runConfirm,
            })
            : null))
    }

    // ---------------- 表情库页签 ----------------
    // 长期收藏：搜索、上传、清理是库级操作；改标签与描述、发送、删除在详情里做。
    function StickerGallery({ bindings = [], askConfirm }) {
      const [list, setList] = React.useState({ items: [], total: 0, stats: {}, tags: [] })
      const [q, setQ] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [say, setSay] = React.useState('')
      const [selected, setSelected] = React.useState(null)
      const [edits, setEdits] = React.useState({})
      const [object, setObject] = React.useState({})
      const fileRef = React.useRef(null)

      const error = (r) => String((r && (r.error || r.message)) || '没有收到服务响应。')

      const load = async () => {
        setLoading(true)
        const p = new URLSearchParams()
        p.set('limit', '200')
        p.set('sort', 'used')
        if (q.trim()) p.set('q', q.trim())
        const r = await get('/stickers?' + p.toString())
        setLoading(false)
        if (r && r.ok) setList(r)
        else if (r && r.error) setSay('无法读取表情库：' + error(r))
      }
      React.useEffect(() => { load() }, [])
      React.useEffect(() => {
        const t = setTimeout(load, 300)
        return () => clearTimeout(t)
      }, [q])

      const upload = async (files) => {
        const array = Array.from(files || []).filter((f) => f && f.size)
        if (!array.length) return
        setBusy(true)
        setSay('正在上传 ' + array.length + ' 张图片…')
        const form = new FormData()
        for (const f of array) form.append('file', f, f.name)
        const r = await postForm('/stickers/save', form)
        setBusy(false)
        if (!r || !r.ok) setSay('上传失败：' + error(r))
        else {
          setSay('上传完成：成功 ' + (r.count || 0) + ' 张' + (r.failed ? '，失败 ' + r.failed + ' 张' : '') + '。')
          await load()
        }
      }

      const openStoreFolder = async () => {
        setBusy(true)
        setSay('正在打开表情库文件夹…')
        const r = await post('/stickers/open-folder', {})
        setBusy(false)
        setSay(r && r.ok ? '已在资源管理器中打开表情库文件夹。' : '没打开文件夹：' + error(r))
      }

      // 库级危险操作统一走弹窗内二次确认。
      const cleanup = (mode) => {
        const copy = {
          unused: '删除所有未使用过的表情及其图片文件？此操作无法撤销。',
          dedupe: '删除内容重复的表情，只保留使用次数最多的一份？此操作无法撤销。',
        }[mode]
        askConfirm({
          title: mode === 'unused' ? '删除未使用的表情？' : '清理重复的表情？',
          description: copy,
          confirmLabel: mode === 'unused' ? '删除未使用' : '清理重复',
          run: async () => {
            setBusy(true)
            setSay('正在清理…')
            const r = await post('/stickers/cleanup', { mode })
            setBusy(false)
            setSay(r && r.ok
              ? '清理完成：删除 ' + (r.removed || 0) + ' 个，释放 ' + (r.freedMB || 0) + 'MB。'
              : '清理失败：' + error(r))
            await load()
          },
        })
      }

      const cards = Array.isArray(list.items) ? list.items : []
      const current = selected ? (cards.find((item) => item.id === selected.id) || selected) : null
      const valueOf = (entry) => edits[entry.id] || {
        tags: (entry.tags || []).join('，'),
        desc: entry.desc || '',
      }
      const setValue = (entry, patch) => setEdits((prev) => ({
        ...prev,
        [entry.id]: { ...(prev[entry.id] || valueOf(entry)), ...patch },
      }))

      const save = async (entry) => {
        const value = valueOf(entry)
        setBusy(true)
        const r = await post('/stickers/update', { id: entry.id, tags: value.tags, desc: value.desc })
        setBusy(false)
        if (r && r.ok) {
          setSay('标签与描述已保存。')
          setEdits((prev) => {
            const next = { ...prev }
            delete next[entry.id]
            return next
          })
          await load()
        } else setSay('保存失败：' + error(r))
      }

      const remove = (entry) => askConfirm({
        title: '删除这个表情？',
        description: '删除「' + entry.file + '」及其图片文件，无法撤销。',
        confirmLabel: '删除',
        run: async () => {
          setBusy(true)
          const r = await post('/stickers/delete', { id: entry.id })
          setBusy(false)
          if (r && r.ok) {
            setSay('已删除。')
            setSelected(null)
          } else setSay('删除失败：' + error(r))
          await load()
        },
      })

      const copyPath = async (entry) => {
        try {
          await navigator.clipboard.writeText(entry.path)
          setSay('路径已复制：' + entry.path)
        } catch {
          setSay('复制失败，路径为：' + entry.path)
        }
      }

      const send = async (entry) => {
        const qq = object[entry.id] || (bindings[0] && bindings[0].qq) || ''
        if (!qq) {
          setSay('尚未配置 QQ 绑定，请先在「私聊绑定」中添加。')
          return
        }
        setBusy(true)
        setSay('正在向 QQ ' + qq + ' 发送 ' + entry.file + '…')
        const r = await post('/stickers/send', { qq, name: entry.id })
        setBusy(false)
        if (!r || !r.ok) setSay('发送失败：' + error(r))
        else if (r.queued) setSay('QQ 当前无法发送，消息已加入待发列表（积压 ' + (r.pending || 0) + ' 条）。')
        else setSay('已发送至 QQ ' + (r.qq || qq) + '。')
        await load()
      }

      const toolbar = h(Toolbar, {
        query: q,
        onQuery: setQ,
        onRefresh: load,
        busy,
        actions: [
          { label: '打开表情库文件夹', onClick: openStoreFolder },
          { label: '删除未使用', onClick: () => cleanup('unused') },
          { label: '清理重复', onClick: () => cleanup('dedupe') },
        ],
      },
        h('button', {
          type: 'button', style: S.btn, disabled: busy,
          onClick: () => { try { fileRef.current?.click?.() } catch { /* 无文件选择器时忽略 */ } },
        }, '上传图片'),
        h('input', {
          ref: fileRef,
          type: 'file',
          multiple: true,
          accept: 'image/*',
          style: { display: 'none' },
          onChange: (e) => { upload(e.target.files); e.target.value = '' },
        }))

      const grid = h(CardGrid, {
        items: cards,
        loading,
        emptyText: '图库是空的。',
        keyOf: (entry) => entry.id,
        onOpen: (entry) => setSelected(entry),
        renderCard: (entry) => h(CardBody, {
          src: imageUrl(entry),
          alt: entry.desc || entry.file,
          name: entry.file,
          desc: entry.desc,
          tags: (entry.tags || []).map((tag) => '#' + tag),
          meta: (entry.width || 0) + '×' + (entry.height || 0) + '｜' + (entry.size_kb || 0) + 'KB｜已使用 ' + (entry.used_count || 0) + ' 次',
        }),
      })

      const detail = current ? (() => {
        const value = valueOf(current)
        const qq = object[current.id] || (bindings[0] && bindings[0].qq) || ''
        return h(DetailShell, {
          title: current.file || current.id,
          onBack: () => setSelected(null),
          preview: h('img', {
            src: imageUrl(current), alt: current.desc || current.file, style: S.detailImage,
          }),
          actions: [
            h('button', { key: 'save', type: 'button', style: S.btnOn, onClick: () => save(current), disabled: busy }, '保存描述与标签'),
            h('button', { key: 'copy', type: 'button', style: S.btn, onClick: () => copyPath(current) }, '复制路径'),
            h('select', {
              key: 'qq',
              style: { ...S.btn, minWidth: 150 },
              value: qq,
              onChange: (e) => setObject((prev) => ({ ...prev, [current.id]: e.target.value })),
            },
              bindings.length === 0 ? h('option', { value: '' }, '（暂无绑定）') : null,
              bindings.map((b) => h('option', { key: b.qq, value: b.qq }, '发送至 ' + b.qq + (b.name ? '（' + b.name + '）' : '')))),
            h('button', { key: 'send', type: 'button', style: S.btn, onClick: () => send(current), disabled: busy || !qq }, '发送'),
            h('button', { key: 'delete', type: 'button', style: S.btnDanger, onClick: () => remove(current), disabled: busy }, '删除'),
          ],
        },
          h('div', { style: S.dim },
            (current.width || 0) + '×' + (current.height || 0) + '｜' + (current.size_kb || 0) + 'KB｜已使用 ' + (current.used_count || 0) + ' 次｜加入 ' + timeText(current.added_at)),
          field('标签（逗号分隔）', input(value.tags, (v) => setValue(current, { tags: v }), '标签，以逗号分隔')),
          field('描述', input(value.desc, (v) => setValue(current, { desc: v }), '描述（可选）')))
      })() : null

      return h('div', {
        style: S.galleryBody,
        onDragOver: (e) => { e.preventDefault() },
        onDrop: (e) => { e.preventDefault(); upload(e.dataTransfer && e.dataTransfer.files) },
      }, toolbar, h('div', { style: S.content }, detail || grid), h(StatusLine, { text: say }))
    }

    // ---------------- 收图图库页签 ----------------
    // 缓存语义：浏览、改描述、存为表情、打开原图；清空与打开文件夹是库级操作。
    function ImageGallery({ imageDir = '', askConfirm }) {
      const [list, setList] = React.useState({ entries: [], total: 0, stats: {} })
      const [q, setQ] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [say, setSay] = React.useState('')
      const [selected, setSelected] = React.useState(null)
      const [edits, setEdits] = React.useState({})

      const error = (r) => String((r && (r.error || r.message)) || '没有收到服务响应。')

      const load = async () => {
        setLoading(true)
        const p = new URLSearchParams()
        p.set('limit', '200')
        if (q.trim()) p.set('q', q.trim())
        const r = await get('/images?' + p.toString())
        setLoading(false)
        if (r && r.ok) setList(r)
        else if (r && r.error) setSay('无法读取收图图库：' + error(r))
      }
      React.useEffect(() => { load() }, [])
      React.useEffect(() => {
        const t = setTimeout(load, 300)
        return () => clearTimeout(t)
      }, [q])

      const entries = Array.isArray(list.entries) ? list.entries : []
      const current = selected
        ? (entries.find((item) => item.sha256 === selected.sha256) || selected)
        : null
      const descOf = (entry) => (edits[entry.sha256] === undefined ? (entry.desc || '') : edits[entry.sha256])
      const setDesc = (entry, value) => setEdits((prev) => ({ ...prev, [entry.sha256]: value }))

      const saveDesc = async (entry) => {
        setBusy(true)
        const r = await post('/images/note', { sha256: entry.sha256, desc: descOf(entry) })
        setBusy(false)
        if (!r || !r.ok) setSay('保存描述失败：' + error(r))
        else {
          setSay('描述已保存。')
          setEdits((prev) => {
            const next = { ...prev }
            delete next[entry.sha256]
            return next
          })
          await load()
        }
      }

      // 存为表情：path 必须是图库条目的原图绝对路径；source 标成 qq-inbox，
      // 这样表情库里能看出它来自收到的图片，而不是手动上传。
      const saveAsSticker = async (entry) => {
        setBusy(true)
        const r = await post('/stickers/save', {
          path: entry.path,
          desc: descOf(entry),
          source: 'qq-inbox',
        })
        setBusy(false)
        if (!r || !r.ok) setSay('存为表情失败：' + error(r))
        else setSay(r.created ? '已存为表情' : '已存为表情：这张图已在表情库里，描述已合并。')
      }

      const openOriginal = async (entry) => {
        setBusy(true)
        const r = await post('/images/open', { sha256: entry.sha256 })
        setBusy(false)
        setSay(r && r.ok ? '已在本机打开原图。' : '打不开原图：' + error(r))
      }

      const openImageFolder = async () => {
        if (!imageDir) return
        setBusy(true)
        const r = await post('/open-folder', { path: imageDir })
        setBusy(false)
        setSay(r && r.ok ? '已在资源管理器中打开图库文件夹。' : '打开失败：' + error(r))
      }

      const clearLibrary = () => {
        const n = Number(list.stats?.count) || 0
        askConfirm({
          title: '清空收图图库？',
          description: n > 0
            ? '将删除图库里的 ' + n + ' 张图；同一张图再来会重新识图。此操作无法撤销。'
            : '将清空收图图库；同一张图再来会重新识图。此操作无法撤销。',
          confirmLabel: '清空图库',
          run: async () => {
            setBusy(true)
            setSay('正在清空收图图库…')
            const r = await post('/images/clear', {})
            setBusy(false)
            setSay(r && r.ok
              ? '已清空 ' + (r.removed || 0) + ' 张，释放 ' + Math.round((r.freedBytes || 0) / 1048576 * 10) / 10 + 'MB。'
              : '清空失败：' + error(r))
            setSelected(null)
            await load()
          },
        })
      }

      const actions = [{ label: '清空图库', danger: true, onClick: clearLibrary }]
      if (imageDir) actions.push({ label: '打开图库文件夹', onClick: openImageFolder })

      const toolbar = h(Toolbar, {
        query: q,
        onQuery: setQ,
        onRefresh: load,
        busy,
        actions,
      })

      const grid = h(CardGrid, {
        items: entries,
        loading,
        emptyText: '图库是空的。',
        keyOf: (entry) => entry.sha256,
        onOpen: (entry) => setSelected(entry),
        renderCard: (entry) => h(CardBody, {
          src: entry.file && entry.path ? cachedImageUrl(entry) : '',
          alt: entry.desc || entry.sha256,
          name: entry.file || String(entry.sha256 || '').slice(0, 16),
          desc: entry.desc,
          tags: [descSourceText(entry.descSource)],
          meta: (entry.width || 0) + '×' + (entry.height || 0) + '｜' + Math.round((entry.bytes || 0) / 102.4) / 10 + 'KB｜命中 ' + (entry.hits || 0) + ' 次',
          noImageText: '没有存原图',
        }),
      })

      const detail = current ? (() => {
        const hasFile = Boolean(current.file && current.path)
        return h(DetailShell, {
          title: current.file || String(current.sha256 || '').slice(0, 16),
          onBack: () => setSelected(null),
          preview: hasFile
            ? h('img', {
              src: cachedImageUrl(current), alt: current.desc || current.sha256, style: S.detailImage,
            })
            : h('div', { style: S.dim }, '没有存原图'),
          actions: [
            h('button', { key: 'save', type: 'button', style: S.btnOn, onClick: () => saveDesc(current), disabled: busy }, '保存描述'),
            h('button', {
              key: 'sticker', type: 'button', style: S.btn, onClick: () => saveAsSticker(current), disabled: busy || !hasFile,
            }, '存为表情'),
            h('button', {
              key: 'open', type: 'button', style: S.btn, onClick: () => openOriginal(current), disabled: busy || !hasFile,
            }, '打开原图'),
          ],
        },
          h('div', { style: S.dim },
            (current.width || 0) + '×' + (current.height || 0) + '｜' + Math.round((current.bytes || 0) / 102.4) / 10 + 'KB｜命中 ' + (current.hits || 0) + ' 次'),
          h('div', { style: S.dim },
            '描述来自' + descSourceText(current.descSource) + '｜加入 ' + timeText(current.firstSeenAt)),
          field('描述', input(descOf(current), (v) => setDesc(current, v), '描述')))
      })() : null

      return h('div', { style: S.galleryBody },
        toolbar,
        h('div', { style: S.content }, detail || grid),
        h(StatusLine, { text: say }))
    }

    /**
     * 设置页里的表情包入口：配置项、统计与一个「打开图库管理」主按钮。
     * 图库内容在设置内弹窗里，不再注册主面板或侧边栏入口。
     */
    function stickerSettings({ config, change, onOpen, savedDir = '', dirExists = false }) {
      const [stats, setStats] = React.useState({})
      const [say, setSay] = React.useState('')
      const [error, setError] = React.useState(false)
      React.useEffect(() => {
        let valid = true
        get('/stickers?limit=1').then((r) => {
          if (valid && r && r.ok) setStats(r.stats || {})
        })
        return () => { valid = false }
      }, [])

      const amount = Number(stats.count) || 0
      const path = String(config.stickerDir || '').trim()
      const saved = String(savedDir || '').trim()
      // 只认宿主确认存在、且与输入框一致的目录；改了路径要先保存才能打开。
      const canOpen = Boolean(saved && dirExists) && path === saved
      const openFolder = async () => {
        const r = await post('/open-folder', { path: path })
        if (!r || !r.ok) {
          setError(true)
          setSay(String((r && (r.error || r.hint)) || '打开失败，请稍后重试。'))
        } else {
          setError(false)
          setSay('已在资源管理器中打开。')
        }
      }

      return h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '表情包'),
        h('div', { style: S.dim }, '长期收藏的表情包，可上传、改标签与描述、直接发送；不会自动删除。'),
        row('保存位置', pathInput(config.stickerDir, (v) => change('stickerDir', v), '使用默认位置', canOpen, openFolder),
          null,
          '更换后只读取新目录，原有图片不会迁移。'),
        row('收到图片时自动存入表情包', flag(config.autoSaveStickers, (v) => change('autoSaveStickers', v)),
          null,
          '开启后收到的图片自动入库，表情包会增长较快。'),
        row('数量上限', h('input', {
          style: S.small, type: 'number', min: 1, max: 10000, value: config.stickerMaxCount ?? 2000,
          onChange: (e) => change('stickerMaxCount', Number(e.target.value)),
        }), null,
        '达到上限后无法新增，已有表情不受影响。'),
        row('占用空间上限（MB）', h('input', {
          style: S.small, type: 'number', min: 1, max: 10240, value: config.stickerMaxMB ?? 1024,
          onChange: (e) => change('stickerMaxMB', Number(e.target.value)),
        })),
        row('单张文件上限（MB）', h('input', {
          style: S.small, type: 'number', min: 1, max: 1024, value: config.stickerMaxFileMB ?? 64,
          onChange: (e) => change('stickerMaxFileMB', Number(e.target.value)),
        }), null, '入库前先按文件大小挡掉超大文件，避免整读进内存；超过这个值会提示换小图。'),
        h('div', { style: { ...S.dim, marginTop: 8 } },
          '共 ' + amount + ' 个（上限 ' + (config.stickerMaxCount ?? 2000) + '）｜占用 ' + (stats.sizeMB || 0) + 'MB（上限 ' + (config.stickerMaxMB ?? 1024) + 'MB）｜已使用 ' + (stats.used || 0) + ' 个｜未使用 ' + (stats.unused || 0) + ' 个'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 } },
          h('button', {
            type: 'button', style: S.btnOn, onClick: (e) => onOpen('stickers', e),
          }, '打开图库管理')),
        say ? h('div', { style: { ...(error ? S.danger : S.ok), marginTop: 6 } }, say) : null)
    }

    // 原生表单控件在浅色/深色弹层下会出现「白字白底」：统一给 select/option 与 input 配成对颜色。
    // 只注入一次，跟 DSH 客户端包自己的做法一样。
    const widgetStyle = `
      .fish-msg-settings select,
      .fish-msg-settings input,
      .fish-msg-settings textarea {
        background-color: var(--dsw-alias-bg-layer-1, #ffffff);
        color: var(--dsw-alias-label-primary, #1f1f1f);
      }
      .fish-msg-settings select { color-scheme: dark; }
      .fish-msg-settings select option,
      .fish-msg-settings select optgroup {
        background-color: var(--dsw-alias-bg-layer-1, #2b2b2b);
        color: var(--dsw-alias-label-primary, #f2f2f2);
      }
      .fish-msg-settings select option:checked {
        background-color: var(--dsw-alias-state-business-primary, #2f6fed);
        color: #ffffff;
      }
      .fish-msg-settings input::placeholder,
      .fish-msg-settings textarea::placeholder { color: var(--dsw-alias-label-secondary, #888); opacity: 1; }
      .fish-msg-settings input[type="checkbox"] { accent-color: var(--dsw-alias-state-business-primary, #2f6fed); }
    `

    function injectWidgetStyle() {
      try {
        if (typeof document === 'undefined') return
        if (document.querySelector('style[data-fish-message="controls"]')) return
        const node = document.createElement('style')
        node.dataset.fishMessage = 'controls'
        node.textContent = widgetStyle
        document.head.appendChild(node)
      } catch { /* 注入失败只影响外观 */ }
    }

    function Section() {
      const [state, setState] = React.useState(null)
      const [dirty, setDirty] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      // 当前正在执行的动作，用来让吸顶条上的按钮显示「正在保存…」这类状态。
      const [action, setAction] = React.useState('')
      const [say, setSay] = React.useState('')
      // 发送音色下拉：只在本地 AI 的语音能力可用时拉一次；失败就退回文本输入。
      const [voices, setVoices] = React.useState(null)
      const [voiceHint, setVoiceHint] = React.useState('')
      // 图库管理是设置页里的弹窗：值存当前页签，null 表示关闭。
      const [gallery, setGallery] = React.useState(null)
      // 弹窗关闭后把焦点还给触发它的按钮。
      const galleryTrigger = React.useRef(null)
      const canFetchVoices = Boolean(state && state.ai && state.ai.tts)
      React.useEffect(() => {
        if (!canFetchVoices) return undefined
        let valid = true
        get('/ai/voices').then((r) => {
          if (!valid) return
          if (r && r.ok && Array.isArray(r.voices) && r.voices.length) setVoices(r.voices)
          else {
            setVoices(null)
            setVoiceHint(String((r && r.hint) || '暂时读不到音色列表，可直接填写音色名。'))
          }
        })
        return () => { valid = false }
      }, [canFetchVoices])

      const fetch = async () => {
        const s = await get('/state')
        if (s) setState(s)
      }
      // 手动刷新：和自动轮询共用一个拉取函数，但要让按钮显示正在做事。
      const refresh = async () => {
        setBusy(true); setAction('刷新'); setSay('正在刷新状态…')
        await fetch()
        setBusy(false); setAction(''); setSay('')
      }
      React.useEffect(() => { fetch() }, [])
      React.useEffect(() => {
        if (dirty) return undefined
        const t = setInterval(fetch, 5000)
        return () => clearInterval(t)
      }, [dirty])

      const config = (state && state.config) || {}
      const change = (key, value) => {
        setState((prev) => (prev ? { ...prev, config: { ...(prev.config || {}), [key]: value } } : prev))
        setDirty(true)
      }
      const bindings = () => (Array.isArray(config.bindings) ? config.bindings : [])
      const changeBinding = (i, patch) => change('bindings', bindings().map((x, j) => (j === i ? { ...x, ...patch } : x)))
      const addBinding = () => {
        const firstSession = (state && state.sessions && state.sessions[0] && state.sessions[0].id) || ''
        change('bindings', [...bindings(), { qq: '', session: firstSession, name: '主人', enabled: true }])
      }
      const deleteBinding = (i) => change('bindings', bindings().filter((_, j) => j !== i))

      // 打开图库弹窗：记住触发按钮，关闭时把焦点还回去。
      const openGallery = (tab, event) => {
        galleryTrigger.current = (event && event.currentTarget) || null
        setGallery(tab === 'images' ? 'images' : 'stickers')
      }
      const closeGallery = () => {
        setGallery(null)
        const trigger = galleryTrigger.current
        if (trigger && typeof trigger.focus === 'function') {
          try { trigger.focus() } catch { /* 焦点回不去不影响关闭 */ }
        }
      }

      const store = async () => {
        setBusy(true); setAction('保存'); setSay('正在保存…')
        const r = await post('/save', { config: config })
        setBusy(false); setAction('')
        if (r && r.ok) {
          setDirty(false)
          setSay('设置已保存。')
          await fetch()
        } else {
          setSay('保存失败：' + String((r && (r.error || r.message)) || '没有收到服务响应，请稍后重试。'))
        }
      }
      const testPlainText = async () => {
        setBusy(true); setAction('测试'); setSay('正在发送测试消息…')
        const r = await post('/test-send', {})
        setBusy(false); setAction('')
        if (!r || !r.ok) setSay('测试失败：' + String((r && r.error) || '没有收到服务响应，请稍后重试。'))
        else if (r.queued) setSay(`QQ 当前无法发送，测试消息已加入待发列表（积压 ${r.pending ?? '?'} 条），恢复后将自动补发。`)
        else setSay(`已发送至 QQ ${r.qq}`)
      }
      const immediateResend = async () => {
        setBusy(true); setSay('正在重试待发消息…')
        const r = await post('/outbox/flush', {})
        setBusy(false)
        if (!r || !r.ok) setSay('重试失败：' + String((r && r.error) || '没有收到服务响应，请稍后重试。'))
        else setSay(`重试结束：成功 ${r.sent || 0} 条，失败 ${r.failed || 0} 条，丢弃 ${r.dropped || 0} 条，剩余 ${r.pending || 0} 条。`)
        await fetch()
      }
      const clearEmptyQueue = async () => {
        const outbound = (state && state.bridge && state.bridge.outbox) || {}
        const n = Number(outbound.pending) || 0
        if (n > 0 && typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm(`确定清空待发消息中的 ${n} 条记录？清空后将不再补发。`)) return
        setBusy(true); setSay('正在清空待发消息…')
        const r = await post('/outbox/clear', {})
        setBusy(false)
        setSay(r && r.ok ? `已清空 ${r.cleared || 0} 条。` : '清空失败：' + String((r && r.error) || '没有收到服务响应，请稍后重试。'))
        await fetch()
      }

      if (!state) return h('div', { className: 'fish-msg-settings', style: S.wrap }, h('div', { style: S.h1 }, '鱼讯 QQ'), h('div', { style: S.dim }, '正在读取当前状态…'))

      const bridge = state.bridge || {}
      const pass = bridge.transport || {}
      // HTTP 轮询模式下 transport.connected 一直是 false，用宿主算好的在线状态。
      const online = Boolean(pass.online)
      const chain = online ? (pass.mode === 'ws' ? '在线·实时' : '在线·轮询') : '离线'
      const offlineReason = String(pass.lastError || bridge.lastSyncError || bridge.stats?.lastError || '').trim().replace(/[。！？.!?]+$/, '')
      const forward = bridge.forward || {}
      const pauseForward = Boolean(config.forwardPaused)
      const sessionList = Array.isArray(state.sessions) ? state.sessions : []

      const bindingPage = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '私聊绑定'),
        h('div', { style: { ...S.bindGrid, marginTop: 10 } },
          h('div', { style: S.th }, 'QQ 号'),
          h('div', { style: S.th }, 'DSH 会话'),
          h('div', { style: S.th }, '称呼'),
          h('div', { style: S.th }, '启用'),
          h('div', { style: S.th }, '')),
        ...bindings().map((b, i) => h('div', { key: i, style: S.bindGrid },
          h('input', {
            style: S.input, value: b.qq || '', placeholder: '1696117435',
            onChange: (e) => changeBinding(i, { qq: e.target.value.replace(/[^\d]/g, '') }),
          }),
          h('select', {
            style: S.input, value: b.session || '',
            onChange: (e) => changeBinding(i, { session: e.target.value }),
          },
            h('option', { value: '' }, '（选择会话）'),
            sessionList.map((s) => h('option', { key: s.id, value: s.id }, s.title || s.id)),
            b.session && !sessionList.some((s) => s.id === b.session)
              ? h('option', { key: b.session, value: b.session }, `（会话当前不可用）${b.session}`)
              : null),
          h('input', {
            style: S.input, value: b.name || '',
            onChange: (e) => changeBinding(i, { name: e.target.value }),
          }),
          h('div', null, flag(b.enabled !== false, (v) => changeBinding(i, { enabled: v }))),
          h('button', { type: 'button', style: S.btn, onClick: () => deleteBinding(i) }, '删除'))),
        bindings().length === 0 ? h('div', { style: S.dim, margin: '8px 0' }, '还没有绑定。添加一条后，QQ 私聊才会转进 DSH 会话。') : null,
        h('div', { style: { marginTop: 8 } }, h('button', { type: 'button', style: S.btn, onClick: addBinding }, '添加绑定')))

      const connectPage = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '连接设置'),
        h('div', { style: S.dim }, '消息经本机运行的 QQ 服务收发，使用前请先启动该服务。'),
        row('QQ 服务地址', input(config.napcatBaseUrl, (v) => change('napcatBaseUrl', v), '留空使用默认地址')),
        row('访问令牌（可选）', input(config.napcatToken, (v) => change('napcatToken', v), '未设置时留空'),
          null,
          '服务端开启鉴权时才需要填写。'),
        row('优先实时接收', flag(config.wsEnabled, (v) => change('wsEnabled', v)),
          null,
          '开启后消息更及时；不可用时自动改为定时查询。'),
        row('实时接收地址', input(config.wsUrl, (v) => change('wsUrl', v), '留空自动生成')))

      const behaviorPage = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '消息处理'),
        h('div', { style: S.dim }, '控制 QQ 与 DSH 之间的消息如何转发。'),
        row('暂停转发到会话', flag(config.forwardPaused, (v) => change('forwardPaused', v)),
          '暂停期间仍会收到 QQ 消息，恢复后按顺序补发；停放太久已过期的消息不再补发。'),
        pauseForward ? h('div', { style: { ...S.hint, marginBottom: 6 } }, `待转发 ${forward.pending || 0} 条`) : null,
        row('仅发送 [QQ] 标记内的内容', flag(config.onlyInsideMarkers, (v) => change('onlyInsideMarkers', v)),
          null,
          '开启时只发标记内的部分；关闭时整条发送，标记会被去掉。'))

      // 默认文案都由宿主 /state 下发，前端不另写一份（原文只在 lib/config.js 一处）。
      const defaultImagePrompt = String((state.defaults && state.defaults.inboundImagePrompt) || '')
      const defaultLongTaskReminder = String((state.defaults && state.defaults.guardStuckPrompt) || '')
      const defaultMessageChannelReminder = String((state.defaults && state.defaults.guardQqPrompt) || '')
      const guard = state.guard || {}
      const guardAlarm = Array.isArray(guard.alerts) ? guard.alerts : []
      const guardPage = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '防失联'),
        h('div', { style: S.dim }, '让绑定的消息能持续收发；注意调整会话权限设置，权限过低可能因授权问题被中断。'),
        row('保持绑定会话能收发', flag(config.guardEnabled, (v) => change('guardEnabled', v)),
          '开启后，绑定的会话内禁用会导致会话中断的工具'),
        row('长任务监控（秒）', h('input', {
          style: S.small, type: 'number', min: 1, max: 7200, value: config.guardStuckSeconds ?? 600,
          onChange: (e) => change('guardStuckSeconds', Number(e.target.value)),
        }), '主会话单轮执行过久时提醒智能体'),
        row('长任务提醒提示词', h('div', null,
          h('textarea', {
            style: {
              ...S.input, minHeight: 64, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit',
            },
            rows: 3,
            maxLength: 4000,
            value: config.guardStuckPrompt || '',
            placeholder: defaultLongTaskReminder,
            onChange: (e) => change('guardStuckPrompt', e.target.value),
          }),
          config.guardStuckPrompt
            ? h('div', { style: { marginTop: 6 } },
              h('button', {
                type: 'button', style: S.btn,
                onClick: () => change('guardStuckPrompt', ''),
              }, '恢复默认'))
            : null),
        '留空时使用内置默认提示词。'),
        row('消息通道监控（轮）', h('input', {
          style: S.small, type: 'number', min: 1, max: 50, value: config.guardQqRemindTurns ?? 3,
          onChange: (e) => change('guardQqRemindTurns', Number(e.target.value)),
        }), '主会话多轮没有使用鱼讯回复内容时提醒智能体'),
        row('消息通道提醒提示词', h('div', null,
          h('textarea', {
            style: {
              ...S.input, minHeight: 64, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit',
            },
            rows: 3,
            maxLength: 4000,
            value: config.guardQqPrompt || '',
            placeholder: defaultMessageChannelReminder,
            onChange: (e) => change('guardQqPrompt', e.target.value),
          }),
          config.guardQqPrompt
            ? h('div', { style: { marginTop: 6 } },
              h('button', {
                type: 'button', style: S.btn,
                onClick: () => change('guardQqPrompt', ''),
              }, '恢复默认'))
            : null),
        '留空时使用内置默认提示词。'),
        guardAlarm.length
          ? h('div', { style: { ...S.danger, marginTop: 4 } },
            `正在提醒：${guardAlarm.map((a) => `${a.title}（已运行 ${a.seconds} 秒）`).join('、')}`)
          : null)

      const aiCapabilities = state.ai || {}
      const aiOnline = Boolean(aiCapabilities.online)
      const voiceAvailable = Boolean(aiCapabilities.tts)
      const transcribeAvailable = Boolean(aiCapabilities.asr)
      const imageDescriptionAvailable = Boolean(aiCapabilities.vision)
      const serviceHint = aiCapabilities.installed
        ? (aiCapabilities.hint || '本地 AI 插件没启动，语音和识图暂不可用。')
        : '本地 AI 插件没装或没启动，语音和识图暂不可用。'
      const voiceValue = config.sayVoice || 'dafeiyu'
      const voiceWidget = (Array.isArray(voices) && voices.length)
        ? h('select', {
          style: S.input, value: voiceValue, disabled: !voiceAvailable,
          onChange: (e) => change('sayVoice', e.target.value),
        },
          voices.includes(voiceValue) ? null : h('option', { value: voiceValue }, voiceValue),
          voices.map((name) => h('option', { key: name, value: name }, name)))
        : input(voiceValue, (v) => change('sayVoice', v), 'dafeiyu', !voiceAvailable)

      const voicePage = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '本地 AI 服务'),
        aiOnline ? null : h('div', { style: { ...S.hint, marginBottom: 8 } }, serviceHint),
        (aiOnline && !voiceAvailable) ? h('div', { style: { ...S.hint, marginBottom: 8 } }, '本地 AI 的语音合成暂不可用。') : null,
        row('发送语音音色', h('div', null,
          voiceWidget,
          (!Array.isArray(voices) && voiceHint && voiceAvailable) ? h('div', { style: S.hint }, voiceHint) : null),
        '用于把 [语音] 文字[/语音] 合成为语音条。', null),
        row('发送语音语速', h('input', {
          style: S.small, type: 'number', min: 0.5, max: 2, step: 0.1,
          value: config.saySpeed ?? 1, disabled: !voiceAvailable,
          onChange: (e) => change('saySpeed', Number(e.target.value)),
        }), null, '数值越大语速越快；范围 0.5 到 2，默认 1。'),
        (aiOnline && !transcribeAvailable) ? h('div', { style: { ...S.hint, marginBottom: 8 } }, '本地 AI 的语音识别暂不可用。') : null,
        row('收到语音后自动分析', flag(config.transcribeInbound, (v) => change('transcribeInbound', v), !transcribeAvailable),
          '会识别文字和情感；不勾选只把语音文件路径递进会话。', null),
        row('语音分析语言', h('select', {
          style: S.input, value: config.asrLanguage || 'auto', disabled: !transcribeAvailable || config.transcribeInbound === false,
          onChange: (e) => change('asrLanguage', e.target.value),
        },
          h('option', { value: 'auto' }, '自动识别'),
          h('option', { value: 'zh' }, '中文'),
          h('option', { value: 'en' }, '英语'),
          h('option', { value: 'ja' }, '日语'),
          h('option', { value: 'ko' }, '韩语'),
          h('option', { value: 'yue' }, '粤语'))),
        row('收到图片后先在本地识图', h('select', {
          style: S.input, value: config.describeInboundImages || 'inherit', disabled: !aiCapabilities.installed,
          onChange: (e) => change('describeInboundImages', e.target.value),
        },
          h('option', { value: 'inherit' }, '继承本地 AI 插件'),
          h('option', { value: 'on' }, '开'),
          h('option', { value: 'off' }, '关')),
        aiCapabilities.installed ? '选「继承」时跟随本地 AI 插件的识图开关。' : '需先安装本地 AI 插件。'),
        (aiOnline && !imageDescriptionAvailable) ? h('div', { style: { ...S.hint, marginTop: 2 } }, '本地 AI 的识图能力暂不可用。') : null,
        row('图片识别提示词', h('div', null,
          h('textarea', {
            style: {
              ...S.input, minHeight: 64, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit',
            },
            rows: 3,
            maxLength: 4000,
            value: config.inboundImagePrompt || '',
            placeholder: defaultImagePrompt,
            disabled: !aiCapabilities.installed,
            onChange: (e) => change('inboundImagePrompt', e.target.value),
          }),
          config.inboundImagePrompt
            ? h('div', { style: { marginTop: 6 } },
              h('button', {
                type: 'button', style: S.btn, disabled: !aiCapabilities.installed,
                onClick: () => change('inboundImagePrompt', ''),
              }, '恢复默认'))
            : null),
        '留空时使用内置默认提示词。'))

      // 收图图库：缓存的只是「原图 + 描述」，关掉总开关就退回每次都识图的老行为。
      // 清空图库与打开图库文件夹移到弹窗的工具条，二次确认也在弹窗内完成。
      const imageStats = state.images || {}
      const imageLibraryPage = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '收图图库'),
        h('div', { style: S.dim }, '把收到的图片按内容指纹存下来，并记住上次识别出的描述；同一张图再来就直接用描述，不再识图。'),
        row('收图先查图库', flag(config.imageLibraryEnabled !== false, (v) => change('imageLibraryEnabled', v)),
          null,
          '关掉后每次按「收到图片后先在本地识图」的设置重新识别，不查库也不写库。'),
        row('图库条数上限', h('input', {
          style: S.small, type: 'number', min: 1, max: 100000, value: config.imageLibraryMaxItems ?? 1000,
          onChange: (e) => change('imageLibraryMaxItems', Number(e.target.value)),
        }), null, '超过上限时淘汰最久没见到的图；图库是缓存，淘汰不提示。'),
        row('原图占用上限（MB）', h('input', {
          style: S.small, type: 'number', min: 1, max: 102400, value: config.imageLibraryMaxMB ?? 512,
          onChange: (e) => change('imageLibraryMaxMB', Number(e.target.value)),
        }), null, '只算图库自己存的那些原图。'),
        row('在图库里存原图', flag(config.imageLibraryKeepFiles !== false, (v) => change('imageLibraryKeepFiles', v)),
          null,
          '关掉只留描述与尺寸；入站缓存被清理后就没法回看图库里的原图。'),
        h('div', { style: { ...S.dim, marginTop: 8 } },
          `共 ${imageStats.count || 0} 张（上限 ${config.imageLibraryMaxItems ?? 1000}）｜有描述 ${imageStats.withDesc || 0} 张｜命中 ${imageStats.hits || 0} 次｜占用 ${imageStats.sizeMB || 0}MB（上限 ${config.imageLibraryMaxMB ?? 512}MB）`),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h('button', {
            type: 'button', style: S.btnOn, onClick: (e) => openGallery('images', e),
          }, '打开图库管理')))

      // 记忆扩展：紧挨收图图库，只影响入站消息的附注，不参与任何缓存。
      // 状态数据由 /state 的 memory 字段下发；老版本 /state 没有它时退回 ai.online。
      const memoryState = state.memory || {}
      const memoryConnected = Boolean(memoryState.service)
      const memoryExtensionOn = config.memoryExtension === true
      const localAIOnline = memoryState.localAI === undefined ? aiOnline : Boolean(memoryState.localAI)
      const memoryPage = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '记忆扩展'),
        h('div', { style: S.dim },
          '装了记忆插件后开启：收到的图片、语音会与记忆库比对，把识别结果附在消息上。'),
        row('开启记忆扩展', flag(config.memoryExtension === true, (v) => change('memoryExtension', v))),
        row('比对图像', flag(config.memoryCompareImages !== false, (v) => change('memoryCompareImages', v), !memoryExtensionOn),
          memoryExtensionOn
            ? '与记忆图库按内容指纹比对，只算内容指纹、不发图。'
            : '需先开启记忆扩展。'),
        row('比对声纹', flag(config.memoryCompareVoices !== false, (v) => change('memoryCompareVoices', v), !memoryExtensionOn),
          memoryExtensionOn
            ? '与声纹库按声音认人；需要本地 AI 服务在运行。'
            : '需先开启记忆扩展。'),
        h('div', { style: { ...S.dim, marginTop: 8 } },
          `记忆服务：${memoryConnected ? '已连接' : '未检测到（需要安装并启用记忆插件）'}`),
        h('div', { style: { ...S.dim, marginTop: 2 } },
          `本地 AI：${localAIOnline ? '可用' : '未运行（声纹比对将跳过）'}`))

      const backfillPage = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '同步与补发'),
        row('离线消息补发范围（小时）', h('input', {
          style: S.small, type: 'number', min: 0, max: 168, value: config.backfillWindowHours ?? 24,
          onChange: (e) => change('backfillWindowHours', Number(e.target.value)),
        }), '离线期间的消息在此范围内逐条补发，超出只提示数量。'),
        row('定时查询间隔（毫秒）', h('input', {
          style: S.small, type: 'number', min: 500, max: 30000, value: config.pollIntervalMs ?? 2000,
          onChange: (e) => change('pollIntervalMs', Number(e.target.value)),
        }), null,
        '实时接收不可用时才使用；间隔越短越及时。'),
        row('定期核对间隔（毫秒）', h('input', {
          style: S.small, type: 'number', min: 5000, max: 600000, value: config.historyIntervalMs ?? 60000,
          onChange: (e) => change('historyIntervalMs', Number(e.target.value)),
        }), '每隔这么久和 QQ 核对一次最近消息，防止漏收。'),
        row('消息排序等待（毫秒）', h('input', {
          style: S.small, type: 'number', min: 0, max: 5000, value: config.reorderBufferMs ?? 1500,
          onChange: (e) => change('reorderBufferMs', Number(e.target.value)),
        }), '收到消息后先等这么久再按时间排序，避免先后颠倒。'),
        row('每次读取条数', h('input', {
          style: S.small, type: 'number', min: 10, max: 500, value: config.historyCount ?? 100,
          onChange: (e) => change('historyCount', Number(e.target.value)),
        }), null, '一次最多读这么多条；取太小可能分多次读取。'),
        row('待发消息保留时长（小时）', h('input', {
          style: S.small, type: 'number', min: 1, max: 720, value: config.outboxTtlHours ?? 24,
          onChange: (e) => change('outboxTtlHours', Number(e.target.value)),
        }), '超过此时间不再补发，以免恢复后集中发送过期内容。'),
        row('入站缓存保留天数', h('input', {
          style: S.small, type: 'number', min: 1, max: 365, value: config.inboxTtlDays ?? 14,
          onChange: (e) => change('inboxTtlDays', Number(e.target.value)),
        }), null, '收到的图片和语音在本机最多留这么久，到期自动清理；表情库不受影响。'),
        row('重复消息合并窗口（分钟）', h('input', {
          style: S.small, type: 'number', min: 0, max: 1440, value: config.outboxDedupMinutes ?? 10,
          onChange: (e) => change('outboxDedupMinutes', Number(e.target.value)),
        }), null,
        '相同内容只发一条，避免重试造成重复；0 表示不合并。'))

      const outbound = bridge.outbox || {}
      const outboxPage = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '待发消息'),
        h('div', { style: S.dim },
          metric(`待发 ${outbound.pending || 0} 条`),
          metric(`最早等待 ${outbound.oldestAgeSec || 0} 秒`),
          metric(`已补发 ${outbound.sentTotal || 0} 条`),
          metric(`失败 ${outbound.failedTotal || 0} 条`),
          metric(`已丢弃 ${outbound.droppedTotal || 0} 条`)),
        h('div', { style: S.hint }, 'QQ 暂时不可用时先存本机，恢复后按时间顺序补发。'),
        outbound.lastError && !online ? h('div', { style: { ...S.danger, marginTop: 4 } }, `最近一次发送失败：${outbound.lastError}`) : null,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h('button', {
            type: 'button', style: S.btn, onClick: immediateResend, disabled: busy,
          }, '立即重试'),
          h('button', {
            type: 'button', style: S.btn, onClick: clearEmptyQueue, disabled: busy || !(outbound.pending > 0),
          }, '清空待发')))

      const log = Array.isArray(state.logs) ? state.logs.join('\n') : ''
      // 吸顶操作条：标题、在线状态和页面级按钮都收在这里，内容在它下面滚动。
      const actionBar = h('div', { style: S.bar },
        h('div', { style: S.barRow },
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 } },
            h('div', { style: { ...S.h1, margin: 0 } }, '鱼讯 QQ'),
            h('span', {
              style: { ...S.badge, ...(online ? S.ok : S.danger) },
              title: online ? (pass.mode === 'ws' ? '按实时连接接收消息' : '按定时查询接收消息') : '暂时连不上 QQ 服务',
            }, chain),
            h('span', { style: S.dim }, `v${state.version || '?'}`)),
          h('div', { style: S.barActions },
            h('button', {
              type: 'button', style: S.btnOn, onClick: store, disabled: busy,
            }, busy && action === '保存' ? '正在保存…' : '保存设置'),
            h('button', {
              type: 'button', style: S.btn, onClick: testPlainText, disabled: busy,
            }, busy && action === '测试' ? '正在发送…' : '发送测试消息'),
            h('button', {
              type: 'button', style: S.btn, onClick: refresh, disabled: busy,
            }, busy && action === '刷新' ? '正在刷新…' : '刷新状态'))),
        h('div', { style: S.dim }, '在 QQ 与 DSH 之间互传私聊消息。'),
        say ? h('div', { style: { ...(isError(say) ? S.danger : S.ok), marginTop: 2 } }, say) : null)
      return h('div', { className: 'fish-msg-settings', style: S.wrap },
        actionBar,
        h('div', { style: S.card },
          h('div', { style: S.dim },
            metric(`待发 ${outbound.pending || 0} 条`),
            metric(`最近同步 ${bridge.lastSyncAt ? new Date(bridge.lastSyncAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}`),
            metric(`已收到 ${bridge.stats?.received || 0} 条`),
            metric(`已转达 ${bridge.stats?.delivered || 0} 条`, '已送入 DSH 会话。'),
            metric(`已跳过 ${bridge.stats?.skippedOld || 0} 条`, '早于补发范围的旧消息。'),
            metric(`出错 ${bridge.stats?.errors || 0} 次`, '历史累计，不代表当前状态。')),
          !online && offlineReason
            ? h('div', { style: { ...S.danger, marginTop: 4 } },
              `离线原因：${offlineReason}。请检查 QQ 服务是否已启动、地址是否正确。`)
            : null),
        connectPage, bindingPage, behaviorPage, guardPage, voicePage,
        // 表情包（收藏）与收图图库（缓存）相邻：两块各有「打开图库管理」，直接落到对应页签。
        h(stickerSettings, {
          config,
          change,
          onOpen: openGallery,
          savedDir: state.stickerDir || '',
          dirExists: Boolean(state.stickerDirExists),
        }),
        imageLibraryPage,
        memoryPage, backfillPage, outboxPage,
        h('div', { style: { ...S.h, marginTop: 14 } }, '最近日志'),
        h('pre', { style: S.log }, log || '暂无日志。'),
        // 图库弹窗盖在设置页之上；只有两个库的入口在设置页里。
        h(GalleryModal, {
          // key 随入口页签变化：每次打开都重新挂载，页签、二次确认与滚动位置都从头开始。
          key: gallery || 'closed',
          open: gallery !== null,
          initialTab: gallery || 'stickers',
          onClose: closeGallery,
          imageDir: String(state.imageDir || ''),
          bindings: bindings(),
        }))
    }

    function apply(ctx) {
      injectWidgetStyle()
      const slots = ctx.get('slots')
      if (slots === undefined) return
      // 只注册设置分区；图库管理是设置页里的弹窗，不占主面板与侧边栏。
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'fish-message', order: 56, label: () => '鱼讯 QQ' },
        Section,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    // 测试用：弹窗与共享组件的内部面；生产代码只经设置页按钮使用。
    exports.__test = {
      GALLERIES,
      GalleryModal,
      StickerGallery,
      ImageGallery,
      ConfirmDialog,
      CardBody,
      CardGrid,
      DetailShell,
      Toolbar,
      StatusLine,
      EmptyState,
      LoadingState,
    }
    return module.exports
  },
})
