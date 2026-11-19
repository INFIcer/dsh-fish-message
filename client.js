// dsh-fish-message · 设置页（DSH Web 客户端插件）
//
// 纯原生 JS + React（DSH 平台自带），没有 npm、没有 CDN、没有构建步骤。
// 挂载方式照 dsh-qq-bridge 的 client.js：window.__ModuleLoader__.load → slots.register。
// 注册 settings.section（设置页，含表情库与收图图库两个设置内弹窗）与 conversation.input.right
// （模型选择器左侧的收发渠道胶囊按钮）；两者都只读写宿主路由，不直接碰 QQ / 会话。
// 不注册主面板与侧边栏入口。

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
    // 图库条目的描述来源：本地识图、待识别（第一次只登记，还没描述）、手动填写，或从表情库借来。
    // api 是旧版本存下的值，只为读老索引保留。
    const descSourceText = (source) => ({
      local: '本地识图',
      deferred: '待识别',
      manual: '手动填写',
      sticker: '表情库',
      api: '模型',
    })[source] || '未标注'
    const timeText = (value) => {
      const stamp = String(value || '')
      if (!stamp) return '未知'
      const date = new Date(stamp)
      if (Number.isNaN(date.getTime())) return stamp
      return date.toLocaleString('zh-CN', { hour12: false })
    }

    // ---------------- 通道：qq / wechat ----------------
    // 绑定条目是 { channel, peer, name, session }：channel 缺省 qq（老配置没有这个字段），
    // peer 是对方 id；老配置把它存在 qq 字段里，两者等值，前端两个都读、两个都写。
    const isWechatChannel = (channel) => String(channel || '').trim().toLowerCase() === 'wechat'
    const channelLabel = (channel) => (isWechatChannel(channel) ? '微信' : 'QQ')
    const bindingChannel = (binding) => (isWechatChannel(binding && binding.channel) ? 'wechat' : 'qq')
    // 微信 id 带字母、@ 和下划线，必须原样展示，不能像 QQ 那样剥掉非数字。
    const bindingPeer = (binding) => String((binding && (binding.peer || binding.qq)) || '').trim()
    // 同一串 id 在 qq 与 wechat 里可能是两个人：菜单选中与去重都按通道拼出来的键。
    const channelKey = (channel, peer) => (isWechatChannel(channel) ? 'wechat' : 'qq') + ':' + String(peer || '')

    /**
     * 保存前的本地自查：口径与后端 normalizeBindings 对齐，只拦「提交后会被静默丢掉」的两类问题
     * （对端为空、通道非法），让用户点保存时就地看到哪一条不对。
     * 同一间会话挂多条绑定是正常用法，不在这里拦。
     * 返回可直接展示的中文句子；空数组表示可以提交。
     * 对端重复、条数超上限等更少见的冲突仍由后端丢弃，原因走 /save 响应的 dropped。
     */
    const bindingProblems = (list) => {
      const items = Array.isArray(list) ? list : []
      const problems = []
      items.forEach((item, index) => {
        const no = index + 1
        const raw = String(item && item.channel != null ? item.channel : '').trim().toLowerCase()
        if (raw && raw !== 'qq' && raw !== 'wechat') {
          problems.push(`第 ${no} 条渠道的通道只能填 qq 或 wechat（现在是「${raw}」）`)
          return
        }
        const channel = raw === 'wechat' ? 'wechat' : 'qq'
        // 与后端同口径：QQ 对端存盘前只留数字，纯字母等于空；微信对端只 trim。
        const peer = channel === 'wechat'
          ? String((item && (item.peer || item.qq)) || '').trim()
          : String((item && (item.peer || item.qq)) || '').replace(/[^\d]/g, '')
        if (!peer) {
          problems.push(`第 ${no} 条渠道（${channelLabel(channel)}）的对端没填`)
        }
      })
      return problems
    }

    /** 后端 dropped 条目 → 一条清单：「原因（微信 id）」，逐条用分号拼起来。 */
    const droppedText = (list) => (Array.isArray(list) ? list : []).map((item) => {
      const who = [channelLabel(item && item.channel), String((item && item.peer) || '').trim()].filter(Boolean).join(' ')
      const reason = String((item && item.reason) || '').trim()
      if (reason && who) return `${reason}（${who}）`
      return reason || who
    }).filter(Boolean).join('；')

    /** 相对时间：只说到「多久以前」，用来判断最近跟谁说过话。 */
    const sinceText = (value) => {
      const stamp = Number(value) || 0
      if (!stamp) return '时间未知'
      const diff = Date.now() - stamp
      if (diff < 60e3) return '刚刚'
      if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前'
      if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前'
      return Math.floor(diff / 86400e3) + ' 天前'
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
      // 二维码容器：固定方形、白底，深浅色主题下都能扫；内容溢出时自己滚。
      qrBox: {
        width: 176,
        height: 176,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 8,
        background: '#fff',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        overflow: 'auto',
      },
      qrSvg: { width: '100%', height: '100%', display: 'block' },
      // 退化成字符串时的等宽框：白底容器里配深色字，避免跟随主题变成白字白底。
      qrRaw: {
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: 11,
        lineHeight: 1.5,
        color: '#1f1f1f',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      },
      // 一条绑定一行：通道、对端、会话、称呼、启用、删除。
      bindGrid: {
        display: 'grid',
        gridTemplateColumns: '76px 1fr 1.4fr 80px 40px 44px',
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
    // 文案级启发式：说「没保存」的也是坏消息，保存提示要用警告色。
    const isError = (text) => /失败|无法|错误|不可用|不能|没打开|没保存/.test(String(text || ''))

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

    // ---------------- 图库弹窗（模板 + 变体） ----------------
    // 模板层承担所有库共有的交互：GalleryModal 管弹窗壳、二次确认、Esc、遮罩与焦点，
    // Toolbar / CardGrid / CardBody / DetailShell / GalleryBody / StatusLine / EmptyState / LoadingState
    // 管工具条、卡片网格、卡片内容、详情壳、正文骨架、状态行与空态/加载态；基础交互只有这一处实现。
    // 两个变体只提供自己的数据、卡片字段、详情字段与库级操作，不复制模板代码。
    // 每个库各自是一个弹窗：没有页签，也不显示另一个库。
    //
    // 弹窗盖在设置页之上：固定定位的遮罩 + 限高面板，内容区自己滚动。
    // 宿主的设置弹窗也监听 Esc，所以这里在 document 捕获阶段拦下 Esc 并停止传播，
    // 保证只关本弹窗；二次确认打开时 Esc 只关确认框。

    /** 空态：两个库用同一句文案，具体提示交给库级说明。 */
    function EmptyState({ text = '图库是空的。' }) {
      return h('div', { style: S.loaderBox }, text)
    }

    /** 加载态：与空态共用位置和字号，避免切换时跳动。 */
    function LoadingState({ text = '正在读取图库…' }) {
      return h('div', { style: S.loaderBox }, text)
    }

    /** 变体正文骨架：工具条、可滚动内容区与底部状态行；两个变体共用这一层，不各拼一遍。 */
    function GalleryBody({ toolbar, content, say, ...rest }) {
      return h('div', { style: S.galleryBody, ...rest },
        toolbar,
        h('div', { style: S.content }, content),
        h(StatusLine, { text: say }))
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
     * 图库弹窗模板：遮罩与限高面板、标题与关闭、二次确认，以及 Esc、遮罩点击与焦点。
     * 正文由变体通过 children({ askConfirm }) 提供；工具条、网格、详情与状态行
     * 由模板层的基础组件负责，模板本身不认识具体是哪个库。
     */
    function GalleryModal({ open, title = '图库管理', closeLabel, onClose = () => {}, children }) {
      const [confirm, setConfirm] = React.useState(null)
      const [confirmBusy, setConfirmBusy] = React.useState(false)
      const panelRef = React.useRef(null)

      // 打开时把焦点移进面板；关闭后由设置页把焦点还给触发按钮。
      React.useEffect(() => {
        if (!open) return undefined
        try { panelRef.current?.focus?.() } catch { /* 聚焦失败不影响弹窗 */ }
        return undefined
      }, [open])

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
      const body = typeof children === 'function' ? children({ askConfirm }) : children

      return h('div', {
        style: S.overlay,
        'data-gallery-overlay': 'true',
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
          'aria-label': title,
          // 兜底：焦点留在面板内时，Esc 也不往宿主冒泡。
          onKeyDown: (e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
            }
          },
        },
          h('div', { style: S.modalHead },
            h('div', { style: S.modalTitle }, title),
            h('button', {
              type: 'button',
              style: S.modalClose,
              'aria-label': closeLabel || ('关闭' + title),
              onClick: onClose,
            }, '×')),
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

    // ---------------- 表情库变体 ----------------
    // 只写表情库特有的部分：数据、卡片字段、详情与库级操作；弹窗骨架由 GalleryModal 提供。
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
          setSay('尚未配置渠道绑定，请先在「私聊绑定」中添加。')
          return
        }
        setBusy(true)
        setSay('正在向 ' + qq + ' 发送 ' + entry.file + '…')
        const r = await post('/stickers/send', { qq, name: entry.id })
        setBusy(false)
        if (!r || !r.ok) setSay('发送失败：' + error(r))
        else if (r.queued) setSay('当前无法发送，消息已加入待发列表（积压 ' + (r.pending || 0) + ' 条）。')
        else setSay('已发送至 ' + (r.qq || qq) + '。')
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

      return h(GalleryBody, {
        toolbar,
        content: detail || grid,
        say,
        onDragOver: (e) => { e.preventDefault() },
        onDrop: (e) => { e.preventDefault(); upload(e.dataTransfer && e.dataTransfer.files) },
      })
    }

    // ---------------- 收图图库变体 ----------------
    // 只写收图图库特有的部分：数据、卡片字段、详情与库级操作；弹窗骨架由 GalleryModal 提供。
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
            ? '将删除图库里的 ' + n + ' 张图；同一张图再来会重新登记。此操作无法撤销。'
            : '将清空收图图库；同一张图再来会重新登记。此操作无法撤销。',
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

      return h(GalleryBody, { toolbar, content: detail || grid, say })
    }

    // ---------------- 两个独立弹窗 ----------------
    // 变体只交出自己的正文；标题、关闭、Esc、遮罩、确认框与焦点都留在模板里。
    // 每个入口只挂自己那个弹窗，两个弹窗没有页签，也不能互相跳转。

    /** 表情库弹窗：只显示表情库。 */
    function StickerGalleryModal({ open = false, onClose, bindings = [] }) {
      return h(GalleryModal, {
        open,
        title: '表情库',
        closeLabel: '关闭表情库',
        onClose,
        children: ({ askConfirm }) => h(StickerGallery, { bindings, askConfirm }),
      })
    }

    /** 收图图库弹窗：只显示收图图库。 */
    function ImageGalleryModal({ open = false, onClose, imageDir = '' }) {
      return h(GalleryModal, {
        open,
        title: '收图图库',
        closeLabel: '关闭收图图库',
        onClose,
        children: ({ askConfirm }) => h(ImageGallery, { imageDir, askConfirm }),
      })
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

    // ---------------- 模型选择器左侧：收发渠道胶囊按钮 + 多选菜单 ----------------
    // 「渠道」= 配置里的一条绑定（通道 + 对端 + 称呼 + 启用）：session 为空表示渠道保留、暂不绑定会话。
    // 一条渠道只能绑一个会话，但一间会话可以挂多条：菜单做成多选，提交的是整组，不是单条切换。
    // 这里只调 /bindings/assign；设置页的保存语义与界面都不经过这里。

    /** 会话 id 的两种写法（带不带 session- 前缀）视为同一间会话。 */
    const stripSessionPrefix = (id) => {
      const s = String(id == null ? '' : id).trim()
      return s.startsWith('session-') ? s.slice('session-'.length) : s
    }

    /** 当前会话绑着哪些渠道：返回 [{ channel, peer }]，一间会话可以有多条。 */
    function boundChannels(bindings, sessionId) {
      const key = stripSessionPrefix(sessionId)
      if (!key) return []
      const list = []
      for (const b of Array.isArray(bindings) ? bindings : []) {
        const peer = bindingPeer(b)
        if (!peer || stripSessionPrefix(b.session) !== key) continue
        list.push({ channel: bindingChannel(b), peer: peer })
      }
      return list
    }

    /**
     * 菜单选项：已启用的渠道，按「通道 + 对端」去重。
     * 当前会话已勾选的渠道即使被禁用也要留下，否则勾选项会凭空消失。
     */
    function channelChoices(bindings, selectedKeys) {
      const selected = new Set(Array.isArray(selectedKeys) ? selectedKeys : [])
      const list = []
      const seen = new Set()
      for (const b of Array.isArray(bindings) ? bindings : []) {
        const peer = bindingPeer(b)
        if (!peer) continue
        const channel = bindingChannel(b)
        const key = channelKey(channel, peer)
        if (seen.has(key)) continue
        if (b.enabled === false && !selected.has(key)) continue
        seen.add(key)
        // 胶囊/菜单只显示「称呼 通道」：称呼用主文字色，通道用次要色（与模型选择器的亮暗搭配一致）。
        // 具体账号放到每个选项的 title 上，悬停能看到，不占横向空间。
        const name = String(b.name || '主人')
        const label = channelLabel(channel)
        list.push({ key: key, channel: channel, peer: peer, name: name, label: `${name} ${label}`, title: `${label} ${peer}` })
      }
      return list
    }

    /** 勾选状态里的一串键 → 要提交的 { channel, peer } 列表（按配置里的顺序，方便后端对账）。 */
    function pickedTargets(bindings, keys) {
      const wanted = new Set(Array.isArray(keys) ? keys : [])
      const list = []
      for (const b of Array.isArray(bindings) ? bindings : []) {
        const peer = bindingPeer(b)
        if (!peer) continue
        const channel = bindingChannel(b)
        if (!wanted.has(channelKey(channel, peer))) continue
        list.push({ channel: channel, peer: peer })
        wanted.delete(channelKey(channel, peer))
      }
      return list
    }

    /** 失败提示只说人话：宿主写好的中文提示直接透出，网络层报错换成一句可操作的提示。 */
    function assignErrorText(result) {
      const raw = String((result && result.error) || '').trim()
      if (raw && /[\u4e00-\u9fa5]/.test(raw)) return raw
      return '没能切换收发渠道，请稍后重试。'
    }

    /** 菜单开合的小箭头：10px，颜色跟随文字，展开时整体旋转 180°。 */
    function chevronIcon() {
      return h('svg', {
        className: 'fish-bind-chevron',
        width: 10,
        height: 10,
        viewBox: '0 0 10 10',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', {
        d: 'M2 3.5 L5 6.5 L8 3.5',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    /** 当前选中项右侧的对勾。 */
    function checkIcon() {
      return h('svg', {
        className: 'fish-bind-check',
        width: 12,
        height: 12,
        viewBox: '0 0 12 12',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', {
        d: 'M2.5 6.5 L5 9 L9.5 3.5',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    /**
     * 会话级收发渠道：一枚胶囊按钮 + 自定义多选菜单。
     * 一间会话可以挂多条绑定（多个渠道 / 多个对端），勾上几条就一起收；取消勾选 = 解绑。
     * 一条渠道只能绑一个会话：绑到别的会话等于把渠道移过去，原会话自动少一条。
     * 数据只来自 GET /state（挂载、会话切换、打开菜单各拉一次），不轮询、不弹窗。
     */
    function BindChannel(props) {
      const sessionId = String(props?.sessionId || '').trim()
      const [bindings, setBindings] = React.useState(null)
      const [selected, setSelected] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      // 菜单开合只影响外观；打开时顺手校准一次状态。
      const [open, setOpen] = React.useState(false)
      // 每次拉取领一个号：提交会作废之前发出的拉取，避免旧状态盖掉刚做的切换。
      const pullToken = React.useRef(0)
      // 组件根节点：判断鼠标按下的位置在不在组件内，用来关闭菜单。
      const rootRef = React.useRef(null)

      const applyState = (s) => {
        if (!s || !Array.isArray(s.bindings)) return false
        setBindings(s.bindings)
        setSelected(boundChannels(s.bindings, sessionId).map((item) => channelKey(item.channel, item.peer)))
        // 重新拉到状态说明页面还活着：上一次的失败提示不必一直挂着。
        setNote('')
        return true
      }

      // 挂载与会话切换：拉一次当前绑定，选中项跟着会话走。
      React.useEffect(() => {
        if (!sessionId) return undefined
        const token = ++pullToken.current
        get('/state').then((s) => {
          if (token !== pullToken.current) return
          applyState(s)
        })
        return () => { pullToken.current += 1 }
      }, [sessionId])

      // 菜单展开期间才挂全局监听：点外部或按 Esc 关闭，卸载/收起时一律解绑。
      React.useEffect(() => {
        if (!open) return undefined
        if (typeof document === 'undefined') return undefined
        const onPointerDown = (event) => {
          const node = rootRef.current
          const target = event && event.target
          // 真实 DOM 才有 contains；测试与降级环境下没有节点时按「外部」处理。
          if (node && target && typeof node.contains === 'function' && node.contains(target)) return
          setOpen(false)
        }
        // 捕获阶段拦 Esc：菜单开着时只关菜单，不再传给宿主输入框。
        const onKeyDown = (event) => {
          if (!event || event.key !== 'Escape') return
          if (typeof event.preventDefault === 'function') event.preventDefault()
          if (typeof event.stopPropagation === 'function') event.stopPropagation()
          setOpen(false)
        }
        // pointerdown 与 mousedown 各挂一份：老宿主可能不派发 pointer 事件。
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      if (!sessionId) return null

      // 打开菜单时再对一次：多开两个会话时，另一侧可能刚改过绑定。
      const refresh = async () => {
        if (busy) return
        const token = ++pullToken.current
        const s = await get('/state')
        if (token !== pullToken.current) return
        applyState(s)
      }

      /**
       * 提交整组勾选结果：/bindings/assign 的集合语义是「这间会话就该绑这些」，
       * 所以勾选一条、取消一条都发同一份完整清单，后端一次写完；取消勾选只解绑，渠道保留。
       */
      const submitSelection = async (nextKeys) => {
        if (busy) return
        const previous = selected
        // 先本地反映，再用返回的状态校准；失败就退回原选中并给一次轻提示。
        pullToken.current += 1
        setSelected(nextKeys)
        setBusy(true)
        setNote('')
        const r = await post('/bindings/assign', {
          sessionId: sessionId,
          bindings: pickedTargets(bindings, nextKeys),
        })
        setBusy(false)
        if (r && r.ok) {
          const list = Array.isArray(r.bindings) ? r.bindings : null
          if (list) setBindings(list)
          setSelected(list ? boundChannels(list, sessionId).map((item) => channelKey(item.channel, item.peer)) : nextKeys)
          return
        }
        setSelected(previous)
        setNote(assignErrorText(r))
      }

      // 勾选 / 取消一条：菜单保持展开，方便连着勾几条。
      const toggleItem = (item) => {
        if (!item || !item.key) return
        const next = selected.indexOf(item.key) >= 0
          ? selected.filter((key) => key !== item.key)
          : selected.concat([item.key])
        submitSelection(next)
      }

      // 全部解绑：只清本会话的绑定，渠道留在设置页。
      const clearAll = () => {
        setOpen(false)
        if (selected.length) submitSelection([])
      }

      // 点按钮开合；打开的那一次才去校准状态，省掉每回聚焦都发请求。
      const toggle = () => {
        if (busy) return
        const next = !open
        setOpen(next)
        if (next) refresh()
      }

      // 原生按钮会自己把回车/空格转成 click；这里的 preventDefault 挡掉重复触发，
      // 同时保证拿不到 click 的宿主也能用键盘打开。
      const onTriggerKeyDown = (event) => {
        const key = event && event.key
        if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        toggle()
      }

      const choices = channelChoices(bindings, selected)
      const selectedSet = new Set(selected)
      // 勾选状态里可能留着配置里已经删掉的渠道：只按菜单里真实存在的那几项算当前摘要。
      const currentItems = choices.filter((item) => selectedSet.has(item.key))
      // 摘要：一条时显示「称呼 通道」，多条只报数量（横向空间有限，明细在菜单和 title 里）。
      const summary = currentItems.length === 0
        ? '不绑定'
        : (currentItems.length === 1 ? currentItems[0].label : `${currentItems.length} 条渠道`)
      const summaryDetail = currentItems.length
        ? currentItems.map((item) => item.title).join('、')
        : '不绑定'
      return h('div', {
        className: 'fish-bind',
        ref: rootRef,
        'data-open': open ? '1' : '0',
      },
        h('button', {
          type: 'button',
          className: 'fish-bind-trigger',
          title: `收发渠道：${summaryDetail}。可以勾选多条；同一个渠道只能绑定一个会话。`,
          'aria-label': `收发渠道：${summary}。`,
          'aria-haspopup': 'listbox',
          'aria-expanded': open ? 'true' : 'false',
          disabled: busy,
          onClick: toggle,
          onKeyDown: onTriggerKeyDown,
        },
          h('span', { className: 'fish-bind-current' },
            currentItems.length === 1
              ? [h('span', { className: 'fish-bind-name' }, currentItems[0].name), ' ', h('span', { className: 'fish-bind-channel' }, channelLabel(currentItems[0].channel))]
              : summary),
          chevronIcon()),
        open
          ? h('div', {
            className: 'fish-bind-menu',
            role: 'listbox',
            'aria-label': '收发渠道',
            'aria-multiselectable': 'true',
          }, choices.map((item) => h('div', {
            key: item.key,
            role: 'option',
            'aria-selected': selectedSet.has(item.key) ? 'true' : 'false',
            className: 'fish-bind-item',
            title: item.title,
            onClick: () => toggleItem(item),
          },
            h('span', { className: 'fish-bind-item-text' },
              h('span', { className: 'fish-bind-name' }, item.name), ' ', h('span', { className: 'fish-bind-channel' }, channelLabel(item.channel))),
            selectedSet.has(item.key) ? checkIcon() : null))
            .concat(currentItems.length
              ? [h('div', {
                key: '__clear',
                className: 'fish-bind-item fish-bind-clear',
                role: 'option',
                'aria-selected': 'false',
                title: '只解除这间会话的绑定，渠道仍保留在设置页',
                onClick: clearAll,
              }, h('span', { className: 'fish-bind-item-text' }, '全部解绑'))]
              : []))
          : null,
        note ? h('span', { className: 'fish-bind-note', role: 'status', title: note }, note) : null)
    }

    // 输入框旁的胶囊按钮 + 向上弹出的菜单：颜色全走 DSH 变量，深浅色主题都不另配。
    const bindStyle = `
      .fish-bind {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        max-width: 230px;
        font-size: 12px;
        line-height: 1.2;
        white-space: nowrap;
      }
      .fish-bind-trigger {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        max-width: 100%;
        height: 24px;
        margin: 0;
        padding: 0 6px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--dsw-alias-label-secondary, #666);
        font: inherit;
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
      }
      .fish-bind-trigger:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06));
      }
      .fish-bind-trigger[disabled] { opacity: .55; cursor: default; }
      .fish-bind-current { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      /* 与模型选择器同口径：称呼取 label-secondary（同模型名），通道（QQ / 微信）取
         label-caption（同档位 High 与箭头），所以两者的明暗差和旁边那枚按钮完全一致。
         具体账号只在 title 里给。 */
      .fish-bind-name { color: var(--dsw-alias-label-secondary, inherit); }
      .fish-bind-channel { color: var(--dsw-alias-label-caption, #888); }
      .fish-bind-chevron { flex: 0 0 auto; color: var(--dsw-alias-label-caption, #888); transition: transform .12s ease; }
      .fish-bind[data-open="1"] .fish-bind-chevron { transform: rotate(180deg); }
      .fish-bind-menu {
        position: absolute;
        bottom: calc(100% + 6px);
        left: 0;
        z-index: 60;
        box-sizing: border-box;
        min-width: 180px;
        max-width: 260px;
        max-height: 260px;
        overflow-y: auto;
        padding: 4px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16));
        border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1, #fff);
        box-shadow: 0 10px 30px rgba(0,0,0,.18);
      }
      .fish-bind-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        height: 30px;
        padding: 0 8px;
        border-radius: 6px;
        color: var(--dsw-alias-label-primary, #1f1f1f);
        font-size: 12.5px;
        line-height: 1;
        white-space: nowrap;
        cursor: pointer;
      }
      .fish-bind-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
      /* 菜单项文字沿用菜单自己的 label-primary，只让通道标签保持次要色。 */
      .fish-bind-item .fish-bind-name { color: inherit; }
      .fish-bind-item[aria-selected="true"] { color: var(--dsw-alias-state-business-primary, #2f6fed); }
      .fish-bind-item-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      /* 「全部解绑」是动作不是渠道：用一条分隔线把它和上面的勾选项分开，颜色也压暗。 */
      .fish-bind-clear {
        margin-top: 4px;
        border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
        border-radius: 0 0 6px 6px;
        color: var(--dsw-alias-label-caption, #888);
        justify-content: flex-start;
      }
      .fish-bind-check { flex: 0 0 auto; }
      .fish-bind-note {
        color: var(--dsw-alias-state-danger, #c0392b);
        max-width: 130px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `

    function injectBindStyle() {
      try {
        if (typeof document === 'undefined') return
        if (document.querySelector('style[data-fish-message="bind"]')) return
        const node = document.createElement('style')
        node.dataset.fishMessage = 'bind'
        node.textContent = bindStyle
        document.head.appendChild(node)
      } catch { /* 注入失败只影响外观 */ }
    }

    // ---------------- 二维码编码器（零依赖，单文件内联） ----------------
    // iLink 的登录二维码里编码的是 qrcode_img_content：一个待编码的 https 链接，
    // 不是图片地址也不是 data URI。这里只做「文本 → 模块矩阵」，渲染交给内联 SVG。
    // 只实现字节模式、纠错级别 M、版本 1–10：登录链接一两百字节，版本 10 约 213 字节够用。
    //
    // 移植并精简自 dsh-im-wechat 的 lib/src/shared/qr.js（https://github.com/xbzbing/dsh-im-wechat）：
    //
    // MIT License
    //
    // Copyright (c) 2026 xbzbing
    //
    // Permission is hereby granted, free of charge, to any person obtaining a copy
    // of this software and associated documentation files (the "Software"), to deal
    // in the Software without restriction, including without limitation the rights
    // to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    // copies of the Software, and to permit persons to whom the Software is
    // furnished to do so, subject to the following conditions:
    //
    // The above copyright notice and this permission notice shall be included in all
    // copies or substantial portions of the Software.
    //
    // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    // IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    // FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    // AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    // LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    // OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    // SOFTWARE.

    /** 版本上限：表只覆盖到这里。 */
    const QR_MAX_VERSION = 10
    /** 纠错级别 M 的分块参数（ISO/IEC 18004 表 9）：[纠错码字数, [[块数, 每块数据码字数], …]]。 */
    const QR_ECC_M = {
      1: [10, [[1, 16]]],
      2: [16, [[1, 28]]],
      3: [26, [[1, 44]]],
      4: [18, [[2, 32]]],
      5: [24, [[2, 43]]],
      6: [16, [[4, 27]]],
      7: [18, [[4, 31]]],
      8: [22, [[2, 38], [2, 39]]],
      9: [22, [[3, 36], [2, 37]]],
      10: [26, [[4, 43], [1, 44]]],
    }
    /** 校准图案中心坐标（版本 1 没有校准图案）。 */
    const QR_ALIGNMENT = {
      1: [],
      2: [6, 18],
      3: [6, 22],
      4: [6, 26],
      5: [6, 30],
      6: [6, 34],
      7: [6, 22, 38],
      8: [6, 24, 42],
      9: [6, 26, 46],
      10: [6, 28, 50],
    }

    // GF(256) 的对数/指数表：乘 0x11d 生成，用来算 Reed-Solomon 纠错。
    const QR_GF_EXP = new Uint8Array(512)
    const QR_GF_LOG = new Uint8Array(256)
    {
      let value = 1
      for (let index = 0; index < 255; index += 1) {
        QR_GF_EXP[index] = value
        QR_GF_LOG[value] = index
        value <<= 1
        if (value & 0x100) value ^= 0x11d
      }
      for (let index = 255; index < 512; index += 1) QR_GF_EXP[index] = QR_GF_EXP[index - 255]
    }

    const qrMultiply = (a, b) => (a === 0 || b === 0 ? 0 : QR_GF_EXP[QR_GF_LOG[a] + QR_GF_LOG[b]])

    /** 生成多项式 (x − α^0)…(x − α^(degree−1))，首项系数为 1。 */
    function qrGenerator(degree) {
      let polynomial = [1]
      for (let index = 0; index < degree; index += 1) {
        const next = new Array(polynomial.length + 1).fill(0)
        for (let at = 0; at < polynomial.length; at += 1) {
          next[at] ^= polynomial[at]
          next[at + 1] ^= qrMultiply(polynomial[at], QR_GF_EXP[index])
        }
        polynomial = next
      }
      return polynomial
    }

    /** 纠错码字：data·x^degree mod generator。 */
    function qrRemainder(data, degree) {
      const generator = qrGenerator(degree)
      const remainder = new Array(degree).fill(0)
      for (let at = 0; at < data.length; at += 1) {
        const factor = data[at] ^ remainder[0]
        remainder.shift()
        remainder.push(0)
        if (factor !== 0) {
          for (let index = 0; index < degree; index += 1) remainder[index] ^= qrMultiply(generator[index + 1], factor)
        }
      }
      return remainder
    }

    /** 追加若干位（高位在前）。 */
    function qrPushBits(bits, value, length) {
      for (let shift = length - 1; shift >= 0; shift -= 1) bits.push((value >>> shift) & 1)
    }

    /** 字节模式下的字符计数位数：版本 10 及以上是 16 位。 */
    const qrCountBits = (version) => (version <= 9 ? 8 : 16)

    const qrDataCodewords = (version) => QR_ECC_M[version][1].reduce((sum, group) => sum + group[0] * group[1], 0)

    /** 按字节数挑最小版本：4 位模式 + 计数字段 + 数据本身要放进数据码字容量。 */
    function qrPickVersion(byteLength) {
      for (let version = 1; version <= QR_MAX_VERSION; version += 1) {
        const capacityBits = qrDataCodewords(version) * 8
        const neededBits = 4 + qrCountBits(version) + byteLength * 8
        if (neededBits <= capacityBits) return version
      }
      throw new RangeError('内容太长，超出二维码版本 ' + QR_MAX_VERSION + ' 的容量')
    }

    /** 字节模式编码 + 补齐到数据码字（补 0 位与 0xEC/0x11 填充字节）。 */
    function qrEncodeData(bytes, version) {
      const bits = []
      qrPushBits(bits, 0b0100, 4)
      qrPushBits(bits, bytes.length, qrCountBits(version))
      for (const byte of bytes) qrPushBits(bits, byte, 8)
      const capacityBits = qrDataCodewords(version) * 8
      qrPushBits(bits, 0, Math.min(4, capacityBits - bits.length))
      while (bits.length % 8 !== 0) bits.push(0)
      const codewords = []
      for (let at = 0; at < bits.length; at += 8) {
        let value = 0
        for (let index = 0; index < 8; index += 1) value = (value << 1) | bits[at + index]
        codewords.push(value)
      }
      for (let pad = 0xec; codewords.length < capacityBits / 8; pad ^= 0xec ^ 0x11) codewords.push(pad)
      return codewords
    }

    /** 分块算纠错码，再按标准交织（数据在前、纠错在后）。 */
    function qrInterleave(codewords, version) {
      const [eccLength, groups] = QR_ECC_M[version]
      const blocks = []
      let offset = 0
      for (const [count, perBlock] of groups) {
        for (let index = 0; index < count; index += 1) {
          blocks.push(codewords.slice(offset, offset + perBlock))
          offset += perBlock
        }
      }
      const eccBlocks = blocks.map((block) => qrRemainder(block, eccLength))
      const result = []
      const maxDataLength = Math.max(...blocks.map((block) => block.length))
      for (let at = 0; at < maxDataLength; at += 1) {
        for (const block of blocks) {
          if (at < block.length) result.push(block[at])
        }
      }
      for (let at = 0; at < eccLength; at += 1) {
        for (const block of eccBlocks) result.push(block[at])
      }
      return result
    }

    const qrCreateMatrix = (size) => ({
      size: size,
      modules: Array.from({ length: size }, () => new Array(size).fill(false)),
      isFunction: Array.from({ length: size }, () => new Array(size).fill(false)),
    })

    function qrSet(matrix, row, col, dark) {
      matrix.modules[row][col] = dark
      matrix.isFunction[row][col] = true
    }

    /** 三个角上的定位图案（含一圈分隔带）。 */
    function qrFinderPatterns(matrix) {
      const corners = [[0, 0], [0, matrix.size - 7], [matrix.size - 7, 0]]
      for (const corner of corners) {
        for (let dy = -1; dy <= 7; dy += 1) {
          for (let dx = -1; dx <= 7; dx += 1) {
            const y = corner[0] + dy
            const x = corner[1] + dx
            if (y < 0 || y >= matrix.size || x < 0 || x >= matrix.size) continue
            const inRing = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6
            const dark = inRing && (dy === 0 || dy === 6 || dx === 0 || dx === 6
              || (dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4))
            qrSet(matrix, y, x, dark)
          }
        }
      }
    }

    /** 定时图案：第 6 行与第 6 列的交替模块。 */
    function qrTimingPatterns(matrix) {
      for (let at = 8; at < matrix.size - 8; at += 1) {
        const dark = at % 2 === 0
        if (!matrix.isFunction[6][at]) qrSet(matrix, 6, at, dark)
        if (!matrix.isFunction[at][6]) qrSet(matrix, at, 6, dark)
      }
    }

    /** 校准图案：跳过会盖住三个定位图案的位置。 */
    function qrAlignmentPatterns(matrix, version) {
      const positions = QR_ALIGNMENT[version] || []
      for (let rowIndex = 0; rowIndex < positions.length; rowIndex += 1) {
        for (let colIndex = 0; colIndex < positions.length; colIndex += 1) {
          const last = positions.length - 1
          if ((rowIndex === 0 && colIndex === 0) || (rowIndex === 0 && colIndex === last)
            || (rowIndex === last && colIndex === 0)) continue
          const row = positions[rowIndex]
          const col = positions[colIndex]
          for (let dy = -2; dy <= 2; dy += 1) {
            for (let dx = -2; dx <= 2; dx += 1) {
              qrSet(matrix, row + dy, col + dx, Math.max(Math.abs(dy), Math.abs(dx)) !== 1)
            }
          }
        }
      }
    }

    /** 先占住格式信息与版本信息的位置，掩码选完再写真实值。 */
    function qrReserveFormat(matrix, version) {
      const size = matrix.size
      for (let at = 0; at <= 8; at += 1) {
        if (!matrix.isFunction[at][8]) qrSet(matrix, at, 8, false)
        if (!matrix.isFunction[8][at]) qrSet(matrix, 8, at, false)
      }
      for (let at = 0; at < 8; at += 1) {
        if (!matrix.isFunction[8][size - 1 - at]) qrSet(matrix, 8, size - 1 - at, false)
        if (!matrix.isFunction[size - 1 - at][8]) qrSet(matrix, size - 1 - at, 8, false)
      }
      if (version >= 7) {
        for (let at = 0; at < 18; at += 1) {
          const a = size - 11 + (at % 3)
          const b = Math.floor(at / 3)
          if (!matrix.isFunction[b][a]) qrSet(matrix, b, a, false)
          if (!matrix.isFunction[a][b]) qrSet(matrix, a, b, false)
        }
      }
    }

    /** 数据按「从右下角向上、两列一组」的蛇形填进去。 */
    function qrDrawData(matrix, codewords) {
      const bits = codewords.flatMap((byte) => [byte >>> 7, (byte >>> 6) & 1, (byte >>> 5) & 1, (byte >>> 4) & 1,
        (byte >>> 3) & 1, (byte >>> 2) & 1, (byte >>> 1) & 1, byte & 1])
      let bitIndex = 0
      let upward = true
      for (let right = matrix.size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5
        for (let vertical = 0; vertical < matrix.size; vertical += 1) {
          const row = upward ? matrix.size - 1 - vertical : vertical
          for (let offset = 0; offset < 2; offset += 1) {
            const col = right - offset
            if (matrix.isFunction[row][col]) continue
            matrix.modules[row][col] = bitIndex < bits.length ? bits[bitIndex] === 1 : false
            bitIndex += 1
          }
        }
        upward = !upward
      }
    }

    /** 八种掩码的数据位取反规则。 */
    function qrMaskBit(mask, row, col) {
      switch (mask) {
        case 0: return (row + col) % 2 === 0
        case 1: return row % 2 === 0
        case 2: return col % 3 === 0
        case 3: return (row + col) % 3 === 0
        case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
        case 5: return ((row * col) % 2) + ((row * col) % 3) === 0
        case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
        default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
      }
    }

    function qrApplyMask(matrix, mask) {
      for (let row = 0; row < matrix.size; row += 1) {
        for (let col = 0; col < matrix.size; col += 1) {
          if (!matrix.isFunction[row][col] && qrMaskBit(mask, row, col)) matrix.modules[row][col] = !matrix.modules[row][col]
        }
      }
    }

    function qrBchRemainder(value, polynomial, degree) {
      let remainder = value
      for (let at = degree; at >= 0; at -= 1) {
        if ((remainder >>> (at + 10)) & 1) remainder ^= polynomial << at
      }
      return remainder
    }

    /** 15 位格式信息：2 位纠错级别 + 3 位掩码 + BCH 校验，最后异或固定值。 */
    function qrFormatBits(mask) {
      // 纠错级别 M 的两位编码是 00，所以数据位只剩掩码号。
      const data = mask
      const remainder = qrBchRemainder(data << 10, 0x537, 4)
      return ((data << 10) | remainder) ^ 0x5412
    }

    function qrDrawFormat(matrix, mask) {
      const bits = qrFormatBits(mask)
      const size = matrix.size
      const bit = (index) => ((bits >>> index) & 1) === 1
      for (let at = 0; at <= 5; at += 1) qrSet(matrix, at, 8, bit(at))
      qrSet(matrix, 7, 8, bit(6))
      qrSet(matrix, 8, 8, bit(7))
      qrSet(matrix, 8, 7, bit(8))
      for (let at = 9; at < 15; at += 1) qrSet(matrix, 8, 14 - at, bit(at))
      for (let at = 0; at < 8; at += 1) qrSet(matrix, 8, size - 1 - at, bit(at))
      for (let at = 8; at < 15; at += 1) qrSet(matrix, size - 15 + at, 8, bit(at))
      // 固定的黑模块。
      qrSet(matrix, size - 8, 8, true)
    }

    function qrDrawVersionInfo(matrix, version) {
      if (version < 7) return
      let remainder = version
      for (let at = 0; at < 12; at += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
      const bits = (version << 12) | remainder
      for (let at = 0; at < 18; at += 1) {
        const dark = ((bits >>> at) & 1) === 1
        const a = matrix.size - 11 + (at % 3)
        const b = Math.floor(at / 3)
        qrSet(matrix, b, a, dark)
        qrSet(matrix, a, b, dark)
      }
    }

    /** 标准的四条罚分规则：用来在八种掩码里挑最不容易看错的。 */
    function qrPenalty(matrix) {
      const size = matrix.size
      let score = 0
      // 规则 1：行/列上连续 5 个以上同色。
      for (let row = 0; row < size; row += 1) {
        let runLength = 1
        for (let col = 1; col < size; col += 1) {
          if (matrix.modules[row][col] === matrix.modules[row][col - 1]) runLength += 1
          else {
            if (runLength >= 5) score += 3 + (runLength - 5)
            runLength = 1
          }
        }
        if (runLength >= 5) score += 3 + (runLength - 5)
      }
      for (let col = 0; col < size; col += 1) {
        let runLength = 1
        for (let row = 1; row < size; row += 1) {
          if (matrix.modules[row][col] === matrix.modules[row - 1][col]) runLength += 1
          else {
            if (runLength >= 5) score += 3 + (runLength - 5)
            runLength = 1
          }
        }
        if (runLength >= 5) score += 3 + (runLength - 5)
      }
      // 规则 2：2x2 同色块。
      for (let row = 0; row < size - 1; row += 1) {
        for (let col = 0; col < size - 1; col += 1) {
          const color = matrix.modules[row][col]
          if (color === matrix.modules[row][col + 1] && color === matrix.modules[row + 1][col]
            && color === matrix.modules[row + 1][col + 1]) score += 3
        }
      }
      // 规则 3：1:1:3:1:1 的定位图案前后带 4 个白模块；按 11 位窗口匹配。
      const finderA = 0x5d0
      const finderB = 0x05d
      for (let line = 0; line < size; line += 1) {
        let rowBits = 0
        let colBits = 0
        for (let at = 0; at < size; at += 1) {
          rowBits = ((rowBits << 1) & 0x7ff) | (matrix.modules[line][at] ? 1 : 0)
          colBits = ((colBits << 1) & 0x7ff) | (matrix.modules[at][line] ? 1 : 0)
          if (at >= 10 && (rowBits === finderA || rowBits === finderB)) score += 40
          if (at >= 10 && (colBits === finderA || colBits === finderB)) score += 40
        }
      }
      // 规则 4：黑色占比偏离 50%。与标准一致：以 5% 为步长向上取整后再比。
      let dark = 0
      for (const line of matrix.modules) {
        for (const cell of line) if (cell) dark += 1
      }
      const steps = Math.abs(Math.ceil((dark * 100) / (size * size) / 5) - 10)
      return score + steps * 10
    }

    /** 文本 → 二维码模块矩阵（字节模式、纠错 M、自动挑最小版本与掩码）。 */
    function encodeQr(text) {
      const bytes = new TextEncoder().encode(String(text == null ? '' : text))
      const version = qrPickVersion(bytes.length)
      const codewords = qrInterleave(qrEncodeData(bytes, version), version)
      const size = 17 + 4 * version
      const template = qrCreateMatrix(size)
      qrFinderPatterns(template)
      qrTimingPatterns(template)
      qrAlignmentPatterns(template, version)
      qrReserveFormat(template, version)
      qrDrawData(template, codewords)
      qrDrawVersionInfo(template, version)
      let best = null
      let bestMask = 0
      let bestScore = Number.POSITIVE_INFINITY
      for (let mask = 0; mask < 8; mask += 1) {
        const candidate = qrCreateMatrix(size)
        for (let row = 0; row < size; row += 1) {
          candidate.modules[row] = [...template.modules[row]]
          candidate.isFunction[row] = [...template.isFunction[row]]
        }
        qrApplyMask(candidate, mask)
        qrDrawFormat(candidate, mask)
        const score = qrPenalty(candidate)
        if (score < bestScore) {
          bestScore = score
          best = candidate
          bestMask = mask
        }
      }
      const chosen = best || template
      qrDrawFormat(chosen, bestMask)
      return { version: version, size: size, modules: chosen.modules }
    }

    /** 矩阵 → 内联 SVG 用的几何：每个黑块一个 1×1 方块，四周留 4 个模块的静区。 */
    function qrGeometry(code) {
      const margin = 4
      const dimension = code.size + margin * 2
      const commands = []
      for (let row = 0; row < code.size; row += 1) {
        for (let col = 0; col < code.size; col += 1) {
          if (!code.modules[row][col]) continue
          commands.push('M' + (col + margin) + ' ' + (row + margin) + 'h1v1h-1z')
        }
      }
      return { dimension: dimension, path: commands.join('') }
    }
    // ---------------- 微信通道（iLink 扫码登录） ----------------
    // 微信只能单聊、不能主动开会话、也没有历史消息，所以设置页只做三件事：
    // 启用开关、扫码登录/退出、登录后发一条测试消息。绑定列表与 QQ 共用「私聊绑定」。
    // 扫码期间由本组件自己按 2 秒轮询登录接口：宿主的 /state 是 5 秒节奏，扫码反馈太慢。

    const WECHAT_POLL_MS = 2000

    /** 登录状态 → 一句话；未知状态按未登录处理，宁可让用户多点一次登录。 */
    function wechatStateText(state) {
      return ({
        stopped: '未登录',
        connecting: '正在获取二维码…',
        waiting_scan: '等待扫码',
        scaned: '已扫码，请在手机上确认。',
        confirmed: '已登录',
        expired: '二维码过期了。',
        error: '登录失败',
      })[state] || '未登录'
    }

    /** 登录接口的响应统一成 { enabled, status, qrcode }；连状态都没有就当这次没成功。 */
    function wechatPayload(result) {
      if (!result || typeof result !== 'object') return null
      if (!result.status && !result.qrcode) return null
      return {
        enabled: result.enabled === true,
        status: result.status || {},
        qrcode: result.qrcode || {},
      }
    }

    /** 动作失败时的提示：宿主写好的中文直接透出，其余给一句能照着做的话。 */
    function wechatActionError(result) {
      const raw = String((result && (result.error || result.hint)) || '').trim()
      if (raw && /[\u4e00-\u9fa5]/.test(raw)) return raw
      return '没拿到登录状态，请稍后重试。'
    }

    function WechatChannel({ config = {}, change, initial = null, onUpdate, testPeer = '' }) {
      const [login, setLogin] = React.useState(initial)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [testSay, setTestSay] = React.useState('')
      // 复制二维码链接的结果提示：复制成功与否都要说一句。
      const [copySay, setCopySay] = React.useState('')
      const enabled = config.wechatEnabled === true
      const status = (login && login.status) || {}
      const state = String(status.state || 'stopped')
      const lastError = String(status.lastError || '').trim()
      // 带上次凭证重启时可能只有 connected，没有 confirmed：两种都算登录有效。
      const loggedIn = state === 'confirmed' || status.connected === true

      // 拿到新状态就往下传一份：绑定区要用它判断「能不能加微信渠道」。
      const apply = (payload) => {
        setLogin(payload)
        // 登录接口会把 wechatEnabled 打开：本地配置跟着变，否则一保存又把登录关掉了。
        if (payload && payload.enabled && config.wechatEnabled !== true) change('wechatEnabled', true)
        if (onUpdate) onUpdate(payload)
      }

      // 扫码期间短轮询：状态离开这三个值就不再排下一次；卸载或状态变化时清掉定时器。
      React.useEffect(() => {
        const polling = state === 'connecting' || state === 'waiting_scan' || state === 'scaned'
        if (!enabled || !polling) return undefined
        let alive = true
        const timer = setTimeout(async () => {
          const result = await get('/wechat/login')
          if (!alive) return
          const payload = wechatPayload(result)
          if (payload) apply(payload)
        }, WECHAT_POLL_MS)
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [enabled, login])

      const startLogin = async () => {
        if (busy) return
        setBusy(true); setNote('')
        const result = await post('/wechat/login', {})
        setBusy(false)
        const payload = wechatPayload(result)
        if (payload) apply(payload)
        else setNote(wechatActionError(result))
      }
      const logout = async () => {
        if (busy) return
        setBusy(true); setNote('')
        const result = await post('/wechat/logout', {})
        setBusy(false)
        const payload = wechatPayload(result)
        if (payload) apply(payload)
        else setNote(wechatActionError(result))
      }
      const sendTest = async () => {
        if (busy) return
        // 对端要明确给：后台在没给对端时只会挑第一条启用的绑定，不一定是微信。
        if (!testPeer) {
          setTestSay('先在下面添加一条微信渠道，才能发测试消息。')
          return
        }
        setBusy(true); setTestSay('')
        const result = await post('/test-send', { channel: 'wechat', qq: testPeer })
        setBusy(false)
        if (!result || !result.ok) setTestSay('发送失败：' + String((result && result.error) || '没有收到服务响应，请稍后重试。'))
        else if (result.queued) setTestSay('微信当前无法发送，测试消息已加入待发列表，恢复后会补发。')
        else setTestSay('已发送微信测试消息。')
      }

      // 二维码编码的是 imgContent：协议给的是待编码的 https 链接，不是图片地址，
      // 所以这里自己编成矩阵再画成 SVG。链接本身也留着当兜底（官方实现也这么提示）。
      const qrcode = (login && login.qrcode) || {}
      const imgContent = String(qrcode.imgContent || '').trim()
      const linkLike = /^https?:\/\//i.test(imgContent)
      let qrCode = null
      let qrError = ''
      if (state === 'waiting_scan' && imgContent) {
        try {
          qrCode = encodeQr(imgContent)
        } catch (error) {
          // 只有内容超出版本 10 的容量才会走到这里：说清原因，别把异常丢给页面。
          qrError = '二维码内容太长，没能生成。'
        }
      }
      const qrSvg = qrCode ? (() => {
        const geometry = qrGeometry(qrCode)
        return h('svg', {
          viewBox: '0 0 ' + geometry.dimension + ' ' + geometry.dimension,
          style: S.qrSvg,
          role: 'img',
          'aria-label': '微信登录二维码',
          shapeRendering: 'crispEdges',
        },
          h('rect', { width: geometry.dimension, height: geometry.dimension, fill: '#ffffff' }),
          h('path', { d: geometry.path, fill: '#000000' }))
      })() : null
      const copyQrLink = async () => {
        try {
          await navigator.clipboard.writeText(imgContent)
          setCopySay('链接已复制。')
        } catch {
          setCopySay('复制失败，请手动选中链接复制。')
        }
      }
      const qrActions = imgContent
        ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 } },
          linkLike
            ? h('a', {
              href: imgContent,
              target: '_blank',
              rel: 'noreferrer noopener',
              style: { ...S.btn, textDecoration: 'none', display: 'inline-block' },
            }, '在浏览器打开')
            : null,
          h('button', { type: 'button', style: S.btn, onClick: copyQrLink }, '复制链接'))
        : null

      const pieces = []
      if (loggedIn) {
        const botId = String(status.botId || '').trim()
        pieces.push(h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: S.ok }, '已登录'),
          botId ? h('span', { style: S.dim }, '账号尾号 ' + botId.slice(-6)) : null,
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: logout }, '退出登录')))
        pieces.push(h('div', { style: { marginTop: 8 } },
          h('button', { type: 'button', style: S.btn, disabled: busy || !testPeer, onClick: sendTest }, '发送微信测试消息'),
          testPeer ? null : h('div', { style: S.hint }, '先在下面的「私聊绑定」里添加一条微信渠道，才能发测试消息。')))
        if (testSay) pieces.push(h('div', { style: { ...(isError(testSay) ? S.danger : S.ok), marginTop: 4 } }, testSay))
      } else if (state === 'waiting_scan') {
        // 三条路都要说清：有码扫码，没码就用链接，链接也还没有就再等等。
        const qrHint = qrSvg
          ? '用手机微信扫码确认。'
          : (imgContent ? '二维码没能生成，可以用下面的「在浏览器打开」完成确认。' : '')
        pieces.push(h('div', null,
          h('div', { style: { ...S.dim, marginBottom: 6 } }, wechatStateText(state)),
          h('div', { style: S.qrBox },
            qrSvg || h('div', { style: { ...S.qrRaw, fontSize: 12 } }, qrError || '二维码还没出来，请稍候…')),
          qrHint ? h('div', { style: S.hint }, qrHint) : null,
          qrActions,
          copySay ? h('div', { style: S.hint }, copySay) : null))
      } else if (state === 'expired') {
        pieces.push(h('div', null,
          h('div', { style: { ...S.dim, marginBottom: 6 } }, wechatStateText(state)),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: startLogin }, '重新获取二维码')))
      } else if (state === 'error') {
        pieces.push(h('div', null,
          h('div', { style: S.danger }, lastError ? wechatStateText(state) + '：' + lastError : wechatStateText(state) + '。'),
          h('div', { style: { marginTop: 6 } },
            h('button', { type: 'button', style: S.btn, disabled: busy, onClick: startLogin }, '重新登录'))))
      } else if (state === 'connecting' || state === 'scaned') {
        pieces.push(h('div', { style: S.dim }, wechatStateText(state)))
      } else {
        pieces.push(h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: S.dim }, wechatStateText(state)),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: startLogin }, '扫码登录')))
      }
      if (note) pieces.push(h('div', { style: { ...S.danger, marginTop: 6 } }, note))

      return h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '微信通道'),
        h('div', { style: S.dim }, '扫码登录后，微信私聊也能接进 DSH 会话。微信只能单聊，也没有历史消息，登录后才收得到新消息。'),
        row('启用微信通道', flag(enabled, (v) => change('wechatEnabled', v)), null,
          '关闭后不再收发微信消息，已有的渠道仍保留。'),
        enabled ? row('登录状态', h('div', null, pieces)) : hint('打开开关后可以扫码登录。'))
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
      // 图库弹窗是设置页里的独立界面：值存当前打开的是哪个库，null 表示关闭。
      const [gallery, setGallery] = React.useState(null)
      // 微信通道：登录状态由微信卡片自己轮询，这里留一份最新结果，供绑定区判断能不能加微信渠道。
      const [wechatLive, setWechatLive] = React.useState(null)
      // 最近跟这个微信说过话的人：添加微信渠道时当候选，省得手抄 id。
      const [wechatPeers, setWechatPeers] = React.useState([])
      // 绑定区的轻提示，例如微信还没登录就点了添加。
      const [bindNote, setBindNote] = React.useState('')
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
      // 微信通道：开关与其它配置一起保存；登录状态优先用微信卡片轮询到的最新结果。
      const wechatEnabled = config.wechatEnabled === true
      const wechatStatus = (wechatLive && wechatLive.status)
        || (state && state.wechat && state.wechat.status) || {}
      const wechatConnected = wechatStatus.state === 'confirmed' || wechatStatus.connected === true
      const change = (key, value) => {
        setState((prev) => (prev ? { ...prev, config: { ...(prev.config || {}), [key]: value } } : prev))
        setDirty(true)
      }
      const bindings = () => (Array.isArray(config.bindings) ? config.bindings : [])
      const changeBinding = (i, patch) => change('bindings', bindings().map((x, j) => (j === i ? { ...x, ...patch } : x)))
      /** 改对端 id：qq 与 peer 同值写下去（老配置读 qq，新配置读 peer）。 */
      const setPeer = (i, value) => {
        const channel = bindingChannel(bindings()[i])
        // QQ 对端只收数字；微信 id 带字母和 @，原样保留。
        const peer = channel === 'wechat' ? value.trim() : value.replace(/[^\d]/g, '')
        changeBinding(i, { channel: channel, peer: peer, qq: peer })
      }
      // 换通道等于换一个人：对端清空，免得把 QQ 号当微信号存下来。
      const changeChannel = (i, channel) => changeBinding(i, { channel: channel, peer: '', qq: '' })
      // 添加渠道：微信没登录时先不添加，没有能对话的对端，加了也收不到消息。
      const addBinding = (channel) => {
        if (channel === 'wechat' && !wechatConnected) {
          setBindNote('先在上面扫码登录，再添加渠道。')
          return
        }
        setBindNote('')
        // 新渠道不占任何会话：一条渠道只能绑一个会话，默认抢占会把已有渠道从这间会话挤掉。
        // 具体绑哪间交给会话输入框旁的「收发渠道」多选菜单（/bindings/assign），
        // 那里按「这间会话就该绑这些」整组提交。
        change('bindings', [...bindings(), {
          channel: channel === 'wechat' ? 'wechat' : 'qq',
          peer: '',
          qq: '',
          session: '',
          name: '主人',
          enabled: true,
        }])
      }
      const deleteBinding = (i) => change('bindings', bindings().filter((_, j) => j !== i))

      // 打开图库弹窗：记住触发按钮，关闭时把焦点还回去。
      const openGallery = (name, event) => {
        galleryTrigger.current = (event && event.currentTarget) || null
        setGallery(name === 'images' ? 'images' : 'stickers')
      }
      const closeGallery = () => {
        setGallery(null)
        const trigger = galleryTrigger.current
        if (trigger && typeof trigger.focus === 'function') {
          try { trigger.focus() } catch { /* 焦点回不去不影响关闭 */ }
        }
      }

      const store = async () => {
        // 后端对没填对端 / 通道写错 / 对端重复的条目是「丢掉」；先本地自查，把问题说清楚。
        const problems = bindingProblems(bindings())
        if (problems.length) {
          setSay(`有 ${problems.length} 条渠道没保存，这次没有提交：${problems.join('；')}。`)
          return
        }
        setBusy(true); setAction('保存'); setSay('正在保存…')
        const r = await post('/save', { config: config })
        setBusy(false); setAction('')
        if (r && r.ok) {
          setDirty(false)
          // 本地没拦住的冲突（对端重复、条数超上限）由后端丢掉：原因在 dropped 里，逐条说给用户。
          const dropped = Array.isArray(r.dropped) ? r.dropped : []
          setSay(dropped.length
            ? `设置已保存，但有 ${dropped.length} 条渠道没保存：${droppedText(dropped)}。`
            : '设置已保存。')
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
        else if (r.queued) setSay(`当前无法发送，测试消息已加入待发列表（积压 ${r.pending ?? '?'} 条），恢复后将自动补发。`)
        else setSay(`已发送至 ${channelLabel(r.channel)} 渠道 ${r.qq}`)
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

      // 微信候选对端只在启用后拉一次，用来在「添加微信渠道」时选人；拉不到不影响手填。
      React.useEffect(() => {
        if (!wechatEnabled) return undefined
        let alive = true
        get('/wechat/peers').then((result) => {
          if (alive && result && result.ok && Array.isArray(result.peers)) setWechatPeers(result.peers)
        })
        return () => { alive = false }
      }, [wechatEnabled])

      // 登录成功后清掉「先扫码登录」的提示，不让它一直挂在那儿。
      React.useEffect(() => {
        if (wechatConnected) setBindNote('')
      }, [wechatConnected])

      if (!state) return h('div', { className: 'fish-msg-settings', style: S.wrap }, h('div', { style: S.h1 }, '鱼讯'), h('div', { style: S.dim }, '正在读取当前状态…'))

      const bridge = state.bridge || {}
      const pass = bridge.transport || {}
      // HTTP 轮询模式下 transport.connected 一直是 false，用宿主算好的在线状态。
      const online = Boolean(pass.online)
      const chain = online ? (pass.mode === 'ws' ? '在线·实时' : '在线·轮询') : '离线'
      const offlineReason = String(pass.lastError || bridge.lastSyncError || bridge.stats?.lastError || '').trim().replace(/[。！？.!?]+$/, '')
      const forward = bridge.forward || {}
      const pauseForward = Boolean(config.forwardPaused)
      const sessionList = Array.isArray(state.sessions) ? state.sessions : []

      // 微信候选对端：datalist 让对端输入框自带下拉，选中填原串，也能直接手填。
      const wechatPeerOptions = wechatPeers.length
        ? h('datalist', { id: 'fish-wechat-peers' },
          wechatPeers.map((item) => h('option', {
            key: String(item.peer),
            value: String(item.peer),
          }, sinceText(item.lastActiveAt))))
        : null

      const bindingPage = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '私聊绑定'),
        // 绑定模型：一条 = 一个渠道（对端），对端唯一；会话那一列入同一间会话可以重复出现。
        h('div', { style: S.dim }, '同一间会话可以挂多条渠道；一个对端只能绑一间会话。想绑哪间会话，用会话输入框旁的「收发渠道」勾选。'),
        h('div', { style: { ...S.bindGrid, marginTop: 10 } },
          h('div', { style: S.th }, '通道'),
          h('div', { style: S.th }, '对端账号'),
          h('div', { style: S.th }, 'DSH 会话'),
          h('div', { style: S.th }, '称呼'),
          h('div', { style: S.th }, '启用'),
          h('div', { style: S.th }, '')),
        ...bindings().map((b, i) => {
          const channel = bindingChannel(b)
          return h('div', { key: i, style: S.bindGrid },
            h('select', {
              style: S.input, value: channel,
              onChange: (e) => changeChannel(i, e.target.value),
            },
              h('option', { value: 'qq' }, 'QQ'),
              // 微信未启用时不给这个选项；已经存下的微信渠道仍要能显示成微信。
              (wechatEnabled || channel === 'wechat') ? h('option', { value: 'wechat' }, '微信') : null),
            h('input', {
              style: S.input,
              value: bindingPeer(b),
              placeholder: channel === 'wechat' ? 'wxid 或 @im.wechat 结尾的 id' : '对方的 QQ 号',
              list: channel === 'wechat' && wechatPeers.length ? 'fish-wechat-peers' : undefined,
              onChange: (e) => setPeer(i, e.target.value),
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
            h('button', { type: 'button', style: S.btn, onClick: () => deleteBinding(i) }, '删除'))
        }),
        bindings().length === 0 ? h('div', { style: S.dim, margin: '8px 0' }, '还没有绑定。添加一条后，私聊才会转进 DSH 会话。') : null,
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 } },
          h('button', { type: 'button', style: S.btn, onClick: () => addBinding('qq') }, '添加 QQ 渠道'),
          wechatEnabled ? h('button', { type: 'button', style: S.btn, onClick: () => addBinding('wechat') }, '添加微信渠道') : null,
          bindNote ? h('span', { style: S.danger }, bindNote) : null),
        wechatPeerOptions)

      const connectPage = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '连接设置'),
        h('div', { style: S.dim }, '消息经本机运行的 QQ 渠道服务收发，使用前请先启动该服务。'),
        row('QQ 渠道服务地址', input(config.napcatBaseUrl, (v) => change('napcatBaseUrl', v), '留空使用默认地址')),
        row('访问令牌（可选）', input(config.napcatToken, (v) => change('napcatToken', v), '未设置时留空'),
          null,
          '服务端开启鉴权时才需要填写。'),
        row('优先实时接收', flag(config.wsEnabled, (v) => change('wsEnabled', v)),
          null,
          '开启后消息更及时；不可用时自动改为定时查询。'),
        row('实时接收地址', input(config.wsUrl, (v) => change('wsUrl', v), '留空自动生成（一般是 HTTP 地址）'),
          null,
          'QQ 渠道服务的 WebSocket 服务端通常另开端口（例如 ws://127.0.0.1:3001）；要识别好友撤回，需要填这个地址并开启「优先实时接收」。'))

      // 微信通道紧挨绑定区：先登录，再在下面添加渠道；未启用时只留一个开关。
      // 测试消息要指定对端：取第一条启用的微信渠道。
      const wechatTestBinding = bindings().find((b) => bindingChannel(b) === 'wechat' && b.enabled !== false)
      const wechatPage = h(WechatChannel, {
        config,
        change,
        initial: (state && state.wechat) || null,
        onUpdate: setWechatLive,
        testPeer: wechatTestBinding ? bindingPeer(wechatTestBinding) : '',
      })

      const behaviorPage = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '消息处理'),
        h('div', { style: S.dim }, '控制消息渠道与 DSH 之间的消息如何转发。'),
        row('暂停转发到会话', flag(config.forwardPaused, (v) => change('forwardPaused', v)),
          '暂停期间仍会收到消息，恢复后按顺序补发；停放太久已过期的消息不再补发。'),
        pauseForward ? h('div', { style: { ...S.hint, marginBottom: 6 } }, `待转发 ${forward.pending || 0} 条`) : null,
        row('仅发送 [MSG] 标记内的内容', flag(config.onlyInsideMarkers, (v) => change('onlyInsideMarkers', v)),
          null,
          '开启时只发标记内的部分；关闭时整条发送，标记会被去掉。'),
        row('发送间隔（毫秒）', h('input', {
          style: S.small, type: 'number', min: 0, max: 60000, value: config.outboxPerMessageDelayMs ?? 2000,
          onChange: (e) => change('outboxPerMessageDelayMs', Number(e.target.value)),
        }), '与上一条消息发出的最小间隔；不够才等，空闲之后再发第一条不等；0 表示不间隔。'),
        row('按字数追加间隔（毫秒）', h('input', {
          style: S.small, type: 'number', min: 0, max: 5000, value: config.outboxPerCharDelayMs ?? 100,
          onChange: (e) => change('outboxPerCharDelayMs', Number(e.target.value)),
        }), '在固定间隔之上按字数再加：中文每字算 1，英文一个单词算 1，标点、空格算 0.2，图片、文件和语音文件不算字。'))

      // 计价与余额：可选 fish-token（context 服务 fish.token）。没装时两块都不可用，收发照旧。
      const tokenState = state.token || {}
      const tokenOnline = Boolean(tokenState.service)
      const tokenPeriod = !tokenOnline ? '' : (tokenState.peak === true ? '峰时' : (tokenState.peak === false ? '谷时' : '时段未知'))
      const defaultPeakNotice = String((state.defaults && state.defaults.peakNoticeTemplate) || '')
      const defaultBalanceAlert = String((state.defaults && state.defaults.balanceAlertTemplate) || '')
      // 余额提醒是两个独立开关：文字默认开、表情默认关；状态里缺键时按宿主下发的默认值显示。
      const balanceDefaults = state.defaults || {}
      const balanceMessageOn = config.balanceAlertMessageEnabled === undefined
        ? balanceDefaults.balanceAlertMessageEnabled !== false
        : Boolean(config.balanceAlertMessageEnabled)
      const balanceStickerOn = config.balanceAlertStickerEnabled === undefined
        ? balanceDefaults.balanceAlertStickerEnabled === true
        : Boolean(config.balanceAlertStickerEnabled)
      const tokenPage = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '计价与余额'),
        h('div', { style: S.dim },
          '接上 fish-token 后：峰时收到的消息先收进非紧要任务队列，谷时再处理；余额偏低时往当前渠道回一条提醒。没装这个插件时两项都不生效，收发照旧。'),
        row('峰时转入任务队列', flag(config.peakDeferEnabled !== false, (v) => change('peakDeferEnabled', v), !tokenOnline),
          '峰时先收着、谷时再处理；以【紧要】开头的消息仍立刻送进会话。',
          '关掉或服务不可用时，消息照常直接送进会话。'),
        row('峰时提醒文案', h('div', null,
          h('textarea', {
            style: {
              ...S.input, minHeight: 64, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit',
            },
            rows: 3,
            maxLength: 1000,
            value: config.peakNoticeTemplate || '',
            placeholder: defaultPeakNotice,
            onChange: (e) => change('peakNoticeTemplate', e.target.value),
          }),
          config.peakNoticeTemplate
            ? h('div', { style: { marginTop: 6 } },
              h('button', {
                type: 'button', style: S.btn,
                onClick: () => change('peakNoticeTemplate', ''),
              }, '恢复默认'))
            : null),
        '留空用内置默认；{offPeakStart}、{offPeakEnd} 会填成下一段谷时的起止时刻（由 fish-token 提供）。'),
        row('提醒冷却（分钟）', h('input', {
          style: S.small, type: 'number', min: 0, max: 1440, value: config.peakNoticeCooldownMinutes ?? 30,
          onChange: (e) => change('peakNoticeCooldownMinutes', Number(e.target.value)),
        }), '同一渠道这么久只提醒一次；0 表示每次都提醒。'),
        h('div', { style: { ...S.hint, marginBottom: 6 } },
          '两个开关可以同时打开：同时开启时先发文字、再发表情；两个都关等于不提醒。表情发不出去时，文字开着就只发文字。'),
        row('发送文字提醒', flag(balanceMessageOn, (v) => change('balanceAlertMessageEnabled', v)),
          '余额跌破提醒阈值时，往当前渠道发一条文字。'),
        row('发送表情提醒', flag(balanceStickerOn, (v) => change('balanceAlertStickerEnabled', v)),
          '在文字之外再发一张表情。'),
        row('余额提醒文案', h('div', null,
          h('textarea', {
            style: {
              ...S.input, minHeight: 64, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit',
            },
            rows: 3,
            maxLength: 1000,
            value: config.balanceAlertTemplate || '',
            placeholder: defaultBalanceAlert,
            disabled: !balanceMessageOn,
            onChange: (e) => change('balanceAlertTemplate', e.target.value),
          }),
          config.balanceAlertTemplate
            ? h('div', { style: { marginTop: 6 } },
              h('button', {
                type: 'button', style: S.btn, disabled: !balanceMessageOn,
                onClick: () => change('balanceAlertTemplate', ''),
              }, '恢复默认'))
            : null),
        '留空用内置默认；{balance} 会换成两位小数的余额。'),
        row('余额提醒表情', input(config.balanceAlertSticker, (v) => change('balanceAlertSticker', v), '表情名字或 #标签', !balanceStickerOn),
          '填表情名字、#标签 或 id；留空时不发这张表情。'),
        h('div', { style: { ...S.dim, marginTop: 8 } },
          `计价服务：${tokenOnline ? `已连接（当前${tokenPeriod}）` : '未检测到（需要安装并启用 fish-token 插件）'}`))

      // 默认文案都由宿主 /state 下发，前端不另写一份（原文只在 lib/config.js 一处）。
      const defaultImagePrompt = String((state.defaults && state.defaults.inboundImagePrompt) || '')
      const defaultGuardSystemPrompt = String((state.defaults && state.defaults.guardSystemPrompt) || '')
      const defaultLongTaskReminder = String((state.defaults && state.defaults.guardStuckPrompt) || '')
      const defaultMessageChannelReminder = String((state.defaults && state.defaults.guardQqPrompt) || '')
      const guard = state.guard || {}
      const guardAlarm = Array.isArray(guard.alerts) ? guard.alerts : []
      const guardPage = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '防失联'),
        h('div', { style: S.dim }, '让绑定的消息能持续收发；注意调整会话权限设置，权限过低可能因授权问题被中断。'),
        row('保持绑定会话能收发', flag(config.guardEnabled, (v) => change('guardEnabled', v)),
          '开启后，绑定的会话内禁用会导致会话中断的工具'),
        row('系统提示词', h('div', null,
          h('textarea', {
            style: {
              ...S.input, minHeight: 64, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit',
            },
            rows: 3,
            maxLength: 4000,
            value: config.guardSystemPrompt || '',
            placeholder: defaultGuardSystemPrompt,
            onChange: (e) => change('guardSystemPrompt', e.target.value),
          }),
          config.guardSystemPrompt
            ? h('div', { style: { marginTop: 6 } },
              h('button', {
                type: 'button', style: S.btn,
                onClick: () => change('guardSystemPrompt', ''),
              }, '恢复默认'))
            : null),
        '注入到绑定会话的约定；留空用内置默认。'),
        row('长任务监控（秒）', h('input', {
          style: S.small, type: 'number', min: 1, max: 7200, value: config.guardStuckSeconds ?? 600,
          onChange: (e) => change('guardStuckSeconds', Number(e.target.value)),
        }), '主会话单轮执行过久时，提醒智能体'),
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
        }), '主会话多轮没有使用鱼讯回复内容时，提醒智能体'),
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
            ? '与声纹库按声音认人；认不出标为陌生人。需要本地 AI 服务在运行。'
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
        }), '每隔这么久和 QQ 渠道核对一次最近消息，防止漏收。'),
        row('消息排序等待（毫秒）', h('input', {
          style: S.small, type: 'number', min: 0, max: 5000, value: config.reorderBufferMs ?? 1500,
          onChange: (e) => change('reorderBufferMs', Number(e.target.value)),
        }), '收到消息后先等这么久再按时间排序，避免先后颠倒。'),
        row('编辑窗口（秒）', h('input', {
          style: S.small, type: 'number', min: 0, max: 120, value: Math.round((config.inboundEditWindowMs ?? 15000) / 1000),
          onChange: (e) => change('inboundEditWindowMs', Math.round(Number(e.target.value) * 1000)),
        }), '这段时间里只要还有新消息就继续等，静默到点才把这一批合并成一条递进会话；期间撤回的消息不会送进会话。0 表示不合并、逐条递进。'),
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
        h('div', { style: S.hint }, 'QQ 渠道暂时不可用时先存本机，恢复后按时间顺序补发。'),
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
            h('div', { style: { ...S.h1, margin: 0 } }, '鱼讯'),
            h('span', {
              style: { ...S.badge, ...(online ? S.ok : S.danger) },
              title: online ? (pass.mode === 'ws' ? '按实时连接接收消息' : '按定时查询接收消息') : '暂时连不上 QQ 渠道服务',
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
        h('div', { style: S.dim }, '在 QQ / 微信渠道与 DSH 之间互传私聊消息。'),
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
              `离线原因：${offlineReason}。请检查 QQ 渠道服务是否已启动、地址是否正确。`)
            : null),
        connectPage, wechatPage, bindingPage, behaviorPage, tokenPage, guardPage, voicePage,
        // 表情包（收藏）与收图图库（缓存）相邻：两块各有「打开图库管理」，各开各的弹窗。
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
        // 只在打开时挂载对应的那个弹窗：关闭即卸载，下次打开是全新状态。
        // 同一时间只有一个 gallery 值，两个弹窗不会同时出现。
        gallery === 'stickers'
          ? h(StickerGalleryModal, {
            open: true,
            onClose: closeGallery,
            bindings: bindings(),
          })
          : gallery === 'images'
            ? h(ImageGalleryModal, {
              open: true,
              onClose: closeGallery,
              imageDir: String(state.imageDir || ''),
            })
            : null)
    }

    function apply(ctx) {
      injectWidgetStyle()
      injectBindStyle()
      const slots = ctx.get('slots')
      if (slots === undefined) return
      // 设置分区与图库弹窗都在设置页之内，不占主面板与侧边栏。
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'fish-message', order: 56, label: () => '鱼讯' },
        Section,
      ))
      // 模型选择器左侧：收发渠道胶囊按钮。order 取大值排在这一簇末尾，紧挨模型选择器；
      // 旧宿主没有这个槽位时只少一个入口，整个插件照常加载。
      try {
        slots.inject('conversation.input.right', () => slots.register(
          { name: 'conversation.input.right', id: 'fish-bind', order: 200, label: () => '收发渠道' },
          BindChannel,
        ))
      } catch (error) {
        try { console.warn('[dsh-fish-message] 注册模型选择器左侧槽位失败', error) } catch { /* 忽略 */ }
      }
    }

    exports.apply = apply
    exports.inject = inject
    // 测试用：模板、两个变体与共享组件的内部面；生产代码只经设置页按钮使用。
    exports.__test = {
      // 保存前的本地校验与 dropped 文案：设置页保存用，测试单独覆盖文案。
      bindingProblems,
      droppedText,
      BindChannel,
      WechatChannel,
      wechatStateText,
      // 二维码编码器的内部面：测试里拿它和公开实现比矩阵。
      encodeQr,
      qrGeometry,
      GalleryModal,
      StickerGalleryModal,
      ImageGalleryModal,
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
