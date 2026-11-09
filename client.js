// dsh-fish-message · 设置页（DSH Web 客户端插件）
//
// 纯原生 JS + React（DSH 平台自带），没有 npm、没有 CDN、没有构建步骤。
// 挂载方式照 dsh-qq-bridge 的 client.js：window.__ModuleLoader__.load → slots.register('settings.section')。
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
    const postForm = (path, 表单) => fetch(B + path, { method: 'POST', body: 表单 })
      .then((r) => r.json())
      .catch((error) => ({ ok: false, error: String(error?.message || error) }))
    const 图地址 = (条目) => `${B}/stickers/file?path=${encodeURIComponent(条目?.file || '')}`
    const 最近图地址 = (名字) => `${B}/stickers/recent/file?name=${encodeURIComponent(名字 || '')}`

    const S = {
      wrap: {
        padding: '12px 14px 28px',
        fontSize: 13,
        lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.94))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: 12,
      },
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
      stickerCard: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: 'var(--dsw-alias-bg-layer-1)',
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
      日志: {
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: 11.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        maxHeight: 280,
        overflow: 'auto',
        background: 'rgba(0,0,0,.06)',
        borderRadius: 6,
        padding: 8,
      },
    }

    const 提示 = (文本) => h('div', { style: S.hint }, 文本)
    const 行 = (标签, 控件, 说明) => h('div', { style: S.row },
      h('div', { style: S.lab }, 标签),
      h('div', { style: S.ctl }, 控件, 说明 ? 提示(说明) : null))

    function 输入(值, onChange, 占位 = '') {
      return h('input', {
        style: S.input,
        value: 值 == null ? '' : String(值),
        placeholder: 占位,
        onChange: (e) => onChange(e.target.value),
      })
    }

    function 开关(值, onChange) {
      return h('input', { type: 'checkbox', checked: !!值, onChange: (e) => onChange(e.target.checked) })
    }

    // ---------------- 表情包分区 ----------------
    // 一个纯前端组件：所有读写都走宿主路由 /dsh-fish-message/stickers*。
    // 预览直接用 <img> 指向 library 原图，GIF 会自己动；loading="lazy" 做惰性加载。
    function 表情包({ 配置, 改, 绑定们 }) {
      const [列表, 设列表] = React.useState({ items: [], total: 0, stats: {}, tags: [] })
      const [最近, 设最近] = React.useState([])
      const [q, 设q] = React.useState('')
      const [标签, 设标签] = React.useState('')
      const [排序, 设排序] = React.useState('used')
      const [编辑, 设编辑] = React.useState({})
      const [最近编辑, 设最近编辑] = React.useState({})
      const [对象, 设对象] = React.useState({})
      const [忙, 设忙] = React.useState(false)
      const [说, 设说] = React.useState('')

      const 错 = (r) => String((r && (r.error || r.message)) || '未知错误')

      const 拉 = async () => {
        const p = new URLSearchParams()
        p.set('limit', '200')
        p.set('sort', 排序)
        if (q.trim()) p.set('q', q.trim())
        if (标签) p.set('tag', 标签)
        const r = await get('/stickers?' + p.toString())
        if (r && r.ok) 设列表(r)
        else if (r && r.error) 设说('读表情库失败：' + 错(r))
      }
      const 拉最近 = async () => {
        const r = await get('/stickers/recent')
        if (r && r.ok) 设最近(Array.isArray(r.items) ? r.items : [])
      }
      React.useEffect(() => { 拉(); 拉最近() }, [])
      React.useEffect(() => {
        const t = setTimeout(拉, 300)
        return () => clearTimeout(t)
      }, [q, 标签, 排序])

      const 上传 = async (文件们) => {
        const 数组 = Array.from(文件们 || []).filter((f) => f && f.size)
        if (!数组.length) return
        设忙(true); 设说(`正在上传 ${数组.length} 张图片…`)
        const 表单 = new FormData()
        for (const f of 数组) 表单.append('file', f, f.name)
        const r = await postForm('/stickers/save', 表单)
        设忙(false)
        if (!r || !r.ok) 设说('上传失败：' + 错(r))
        else {
          设说(`上传完成：成功 ${r.count || 0} 张${r.failed ? `，失败 ${r.failed} 张` : ''}。`)
          await 拉()
        }
      }

      const 导入 = async () => {
        if (!window.confirm('从默认表情库导入？内容相同的图片将合并标签，不会重复保存。')) return
        设忙(true); 设说('正在导入…')
        const r = await post('/stickers/import', {})
        设忙(false)
        if (!r || !r.ok) 设说('导入失败：' + 错(r))
        else {
          const 错们 = Array.isArray(r.errors) && r.errors.length ? `；${r.errors[0].error}` : ''
          设说(`导入完成：新增 ${r.imported || 0} 条，合并 ${r.merged || 0} 条，跳过 ${r.skipped || 0} 条${错们}`)
          await 拉()
        }
      }

      const 清理 = async (mode) => {
        const 文案 = {
          unused: '删除所有未使用过的表情及其图片文件？此操作无法撤销。',
          dedupe: '删除内容重复的表情，仅保留使用次数最多的一份？',
          inbox: '清空最近收到的图片？此操作不影响表情库及其它文件。',
        }[mode]
        if (!window.confirm(文案)) return
        设忙(true); 设说('正在清理…')
        const r = await post('/stickers/cleanup', { mode })
        设忙(false)
        设说(r && r.ok ? `清理完成：删除 ${r.removed || 0} 个，释放 ${r.freedMB || 0}MB。` : '清理失败：' + 错(r))
        await 拉(); await 拉最近()
      }

      const 取值 = (条目) => 编辑[条目.id] || {
        tags: (条目.tags || []).join('，'),
        desc: 条目.desc || '',
      }
      const 设值 = (条目, 补丁) => 设编辑((旧) => ({
        ...旧,
        [条目.id]: { ...(旧[条目.id] || 取值(条目)), ...补丁 },
      }))

      const 保存卡片 = async (条目) => {
        const v = 取值(条目)
        设忙(true)
        const r = await post('/stickers/update', { id: 条目.id, tags: v.tags, desc: v.desc })
        设忙(false)
        if (r && r.ok) {
          设说('标签与描述已保存。')
          设编辑((旧) => { const 新 = { ...旧 }; delete 新[条目.id]; return 新 })
          await 拉()
        } else 设说('保存失败：' + 错(r))
      }

      const 删除 = async (条目) => {
        if (!window.confirm(`删除表情「${条目.file}」及其图片文件？此操作无法撤销。`)) return
        设忙(true)
        const r = await post('/stickers/delete', { id: 条目.id })
        设忙(false)
        设说(r && r.ok ? '已删除。' : '删除失败：' + 错(r))
        await 拉()
      }

      const 复制路径 = async (条目) => {
        try {
          await navigator.clipboard.writeText(条目.path)
          设说('路径已复制：' + 条目.path)
        } catch {
          设说('复制失败，路径为：' + 条目.path)
        }
      }

      const 发送 = async (条目) => {
        const qq = 对象[条目.id] || (绑定们[0] && 绑定们[0].qq) || ''
        if (!qq) { 设说('尚未配置 QQ 绑定，请先在「私聊绑定」中添加。'); return }
        设忙(true); 设说(`正在向 QQ ${qq} 发送 ${条目.file}…`)
        const r = await post('/stickers/send', { qq, name: 条目.id })
        设忙(false)
        if (!r || !r.ok) 设说('发送失败：' + 错(r))
        else if (r.queued) 设说(`QQ 当前无法发送，消息已加入待发列表（积压 ${r.pending || 0} 条）。`)
        else 设说(`已发送至 QQ ${r.qq || qq}。`)
        await 拉()
      }

      const 存最近 = async (图片) => {
        const v = 最近编辑[图片.name] || { tags: '', desc: '' }
        const r = await post('/stickers/save', {
          path: 图片.path,
          tags: v.tags,
          desc: v.desc,
          source: 'qq-inbox',
        })
        if (r && r.ok) {
          设说(r.created ? '已存为表情。' : '该表情已存在，标签已合并。')
          await 拉()
        } else 设说('存为表情失败：' + 错(r))
      }

      const 统计 = 列表.stats || {}
      const 卡片们 = Array.isArray(列表.items) ? 列表.items : []

      const 配置块 = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '表情包'),
        h('div', { style: S.dim }, '表情按内容去重；达到上限时提示清理，不会自动删除。'),
        行('表情库目录', 输入(配置.stickerDir, (v) => 改('stickerDir', v), '默认 ~/.dsh/fish-message-stickers'),
          '表情图片的保存位置；修改后保存即可生效。'),
        行('收到图片时自动存入表情库', 开关(配置.autoSaveStickers, (v) => 改('autoSaveStickers', v)),
          '开启后，收到的图片会自动存入表情库。'),
        行('表情数量上限', h('input', {
          style: S.small, type: 'number', min: 1, max: 10000, value: 配置.stickerMaxCount ?? 2000,
          onChange: (e) => 改('stickerMaxCount', Number(e.target.value)),
        }), '达到上限后将无法继续添加，并提示清理。'),
        行('占用空间上限（MB）', h('input', {
          style: S.small, type: 'number', min: 1, max: 10240, value: 配置.stickerMaxMB ?? 1024,
          onChange: (e) => 改('stickerMaxMB', Number(e.target.value)),
        }), '按表情库实际占用的空间计算。'))

      const 工具条 = h('div', { style: S.card },
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('input', {
            type: 'file', multiple: true, accept: 'image/*', disabled: 忙,
            onChange: (e) => { 上传(e.target.files); e.target.value = '' },
          }),
          h('button', { type: 'button', style: S.btn, onClick: 导入, disabled: 忙 }, '从默认表情库导入'),
          h('button', { type: 'button', style: S.btn, onClick: () => 清理('unused'), disabled: 忙 }, '删除未使用'),
          h('button', { type: 'button', style: S.btn, onClick: () => 清理('dedupe'), disabled: 忙 }, '去重'),
          h('button', { type: 'button', style: S.btn, onClick: () => 清理('inbox'), disabled: 忙 }, '清空最近图片'),
          h('button', { type: 'button', style: S.btn, onClick: 拉, disabled: 忙 }, '刷新')),
        h('div', { style: S.hint }, '可一次选择多张图片，也可直接拖入此区域。'),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 } },
          h('input', {
            style: { ...S.input, width: 200 },
            value: q, placeholder: '搜索标签、描述或文件名',
            onChange: (e) => 设q(e.target.value),
          }),
          h('select', { style: S.small, value: 标签, onChange: (e) => 设标签(e.target.value) },
            h('option', { value: '' }, '全部标签'),
            (列表.tags || []).map((t) => h('option', { key: t.tag, value: t.tag }, `#${t.tag}（${t.count}）`))),
          h('select', { style: S.small, value: 排序, onChange: (e) => 设排序(e.target.value) },
            h('option', { value: 'used' }, '按用量'),
            h('option', { value: 'recent' }, '按加入时间'),
            h('option', { value: 'name' }, '按文件名'))),
        h('div', { style: { ...S.dim, marginTop: 6 } },
          `共 ${统计.count || 0} 条（上限 ${统计.maxCount || '?'}）｜占用 ${统计.sizeMB || 0}MB（上限 ${统计.maxMB || '?'}MB）｜已使用 ${统计.used || 0}｜未使用 ${统计.unused || 0}`),
        说 ? h('div', { style: { ...(String(说).includes('失败') ? S.danger : S.ok), marginTop: 4 } }, 说) : null)

      const 网格 = h('div', { style: { ...S.card } },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, `表情（${列表.total ?? 卡片们.length} 条）`),
        卡片们.length === 0
          ? h('div', { style: S.dim }, '暂无表情。可上传图片，或从默认表情库导入。')
          : h('div', { style: S.grid }, 卡片们.map((条目) => {
            const v = 取值(条目)
            const qq = 对象[条目.id] || (绑定们[0] && 绑定们[0].qq) || ''
            return h('div', { key: 条目.id, style: S.stickerCard },
              h('img', { src: 图地址(条目), loading: 'lazy', alt: 条目.desc || 条目.file, style: S.thumb }),
              h('div', { style: { fontSize: 11, opacity: 0.65, wordBreak: 'break-all' } }, 条目.file),
              h('div', { style: { fontSize: 11, opacity: 0.6 } },
                `${条目.width || 0}×${条目.height || 0}｜${条目.size_kb || 0}KB｜用 ${条目.used_count || 0} 次`),
              h('div', null, (条目.tags || []).map((t) => h('span', { key: t, style: S.chip }, `#${t}`))),
              h('input', {
                style: S.input, value: v.tags, placeholder: '标签，以逗号分隔',
                onChange: (e) => 设值(条目, { tags: e.target.value }),
              }),
              h('input', {
                style: S.input, value: v.desc, placeholder: '描述（可选）',
                onChange: (e) => 设值(条目, { desc: e.target.value }),
              }),
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                h('button', { type: 'button', style: S.btn, onClick: () => 保存卡片(条目), disabled: 忙 }, '保存'),
                h('button', { type: 'button', style: S.btn, onClick: () => 复制路径(条目) }, '复制路径'),
                h('button', { type: 'button', style: S.btn, onClick: () => 删除(条目), disabled: 忙 }, '删除')),
              h('div', { style: { display: 'flex', gap: 6 } },
                h('select', {
                  style: S.input, value: qq,
                  onChange: (e) => 设对象((旧) => ({ ...旧, [条目.id]: e.target.value })),
                },
                  绑定们.length === 0 ? h('option', { value: '' }, '（暂无绑定）') : null,
                  绑定们.map((b) => h('option', { key: b.qq, value: b.qq }, `发送至 ${b.qq}${b.name ? `（${b.name}）` : ''}`))),
                h('button', { type: 'button', style: S.btn, onClick: () => 发送(条目), disabled: 忙 || !qq }, '发送')),
            )
          })))

      const 最近块 = h('div', { style: { ...S.card } },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, `最近收到的图片（${最近.length}）`),
        h('div', { style: S.hint }, '最近收到的图片不会自动存入表情库。填写标签或描述后可存为表情；如无需保留，可清空最近图片。'),
        最近.length === 0
          ? h('div', { style: { ...S.dim, marginTop: 8 } }, '暂无图片。')
          : h('div', { style: S.grid }, 最近.map((图片) => {
            const v = 最近编辑[图片.name] || { tags: '', desc: '' }
            return h('div', { key: 图片.name, style: S.stickerCard },
              h('img', { src: 最近图地址(图片.name), loading: 'lazy', alt: 图片.name, style: S.thumb }),
              h('div', { style: { fontSize: 11, opacity: 0.65, wordBreak: 'break-all' } }, 图片.name),
              h('div', { style: { fontSize: 11, opacity: 0.6 } },
                `${图片.type || ''}｜${Math.round((图片.size || 0) / 102.4) / 10}KB`),
              h('input', {
                style: S.input, value: v.tags, placeholder: '标签，以逗号分隔',
                onChange: (e) => 设最近编辑((旧) => ({
                  ...旧, [图片.name]: { ...(旧[图片.name] || v), tags: e.target.value },
                })),
              }),
              h('input', {
                style: S.input, value: v.desc, placeholder: '描述（可选）',
                onChange: (e) => 设最近编辑((旧) => ({
                  ...旧, [图片.name]: { ...(旧[图片.name] || v), desc: e.target.value },
                })),
              }),
              h('button', { type: 'button', style: S.btn, onClick: () => 存最近(图片) }, '存为表情'))
          })))

      return h('div', {
        onDragOver: (e) => { e.preventDefault() },
        onDrop: (e) => { e.preventDefault(); 上传(e.dataTransfer && e.dataTransfer.files) },
      }, 配置块, 工具条, 网格, 最近块)
    }

    // 原生表单控件在浅色/深色弹层下会出现「白字白底」：统一给 select/option 与 input 配成对颜色。
    // 只注入一次，跟 DSH 客户端包自己的做法一样。
    const 控件样式 = `
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
      .fish-msg-settings input::placeholder { color: var(--dsw-alias-label-secondary, #888); opacity: 1; }
      .fish-msg-settings input[type="checkbox"] { accent-color: var(--dsw-alias-state-business-primary, #2f6fed); }
    `

    function 注入控件样式() {
      try {
        if (typeof document === 'undefined') return
        if (document.querySelector('style[data-fish-message="controls"]')) return
        const 节点 = document.createElement('style')
        节点.dataset.fishMessage = 'controls'
        节点.textContent = 控件样式
        document.head.appendChild(节点)
      } catch { /* 注入失败只影响外观 */ }
    }

    function Section() {
      const [态, 设态] = React.useState(null)
      const [脏, 设脏] = React.useState(false)
      const [忙, 设忙] = React.useState(false)
      const [说, 设说] = React.useState('')

      const 拉 = async () => {
        const s = await get('/state')
        if (s) 设态(s)
      }
      React.useEffect(() => { 拉() }, [])
      React.useEffect(() => {
        if (脏) return undefined
        const t = setInterval(拉, 5000)
        return () => clearInterval(t)
      }, [脏])

      const 配置 = (态 && 态.config) || {}
      const 改 = (键, 值) => {
        设态((旧) => (旧 ? { ...旧, config: { ...(旧.config || {}), [键]: 值 } } : 旧))
        设脏(true)
      }
      const 绑定们 = () => (Array.isArray(配置.bindings) ? 配置.bindings : [])
      const 改绑定 = (i, 补丁) => 改('bindings', 绑定们().map((x, j) => (j === i ? { ...x, ...补丁 } : x)))
      const 加绑定 = () => {
        const 第一个会话 = (态 && 态.sessions && 态.sessions[0] && 态.sessions[0].id) || ''
        改('bindings', [...绑定们(), { qq: '', session: 第一个会话, name: '主人', enabled: true }])
      }
      const 删绑定 = (i) => 改('bindings', 绑定们().filter((_, j) => j !== i))

      const 存 = async () => {
        设忙(true); 设说('保存中…')
        const r = await post('/save', { config: 配置 })
        设忙(false)
        if (r && r.ok) {
          设脏(false)
          设说('设置已保存。')
          await 拉()
        } else {
          设说('保存失败：' + String((r && (r.error || r.message)) || '未知错误'))
        }
      }
      const 测试文字 = async () => {
        设忙(true); 设说('正在发送测试消息…')
        const r = await post('/test-send', {})
        设忙(false)
        if (!r || !r.ok) 设说('测试失败：' + String((r && r.error) || '未知错误'))
        else if (r.queued) 设说(`QQ 当前无法发送，测试消息已加入待发列表（积压 ${r.pending ?? '?'} 条），恢复后将自动补发。`)
        else 设说(`已发送至 QQ ${r.qq}`)
      }
      const 立即补发 = async () => {
        设忙(true); 设说('正在重试待发消息…')
        const r = await post('/outbox/flush', {})
        设忙(false)
        if (!r || !r.ok) 设说('重试失败：' + String((r && r.error) || '未知错误'))
        else 设说(`重试结束：成功 ${r.sent || 0} 条，失败 ${r.failed || 0} 条，丢弃 ${r.dropped || 0} 条，剩余 ${r.pending || 0} 条。`)
        await 拉()
      }
      const 清空队列 = async () => {
        const 出站 = (态 && 态.bridge && 态.bridge.outbox) || {}
        const n = Number(出站.pending) || 0
        if (n > 0 && typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm(`确定清空待发消息中的 ${n} 条记录？清空后将不再补发。`)) return
        设忙(true); 设说('正在清空待发消息…')
        const r = await post('/outbox/clear', {})
        设忙(false)
        设说(r && r.ok ? `已清空 ${r.cleared || 0} 条。` : '清空失败：' + String((r && r.error) || '未知错误'))
        await 拉()
      }

      if (!态) return h('div', { className: 'fish-msg-settings', style: S.wrap }, h('div', { style: S.h1 }, '鱼讯 QQ'), h('div', { style: S.dim }, '正在加载…'))

      const 桥 = 态.bridge || {}
      const 传 = 桥.transport || {}
      const 在线 = Boolean(传.connected)
      const 会话列表 = Array.isArray(态.sessions) ? 态.sessions : []

      const 绑定页 = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '私聊绑定'),
        h('div', { style: S.dim }, '每行对应一个 QQ 号与一间 DSH 会话，目前仅支持私聊。'),
        h('div', { style: { ...S.bindGrid, marginTop: 10 } },
          h('div', { style: S.th }, 'QQ 号'),
          h('div', { style: S.th }, 'DSH 会话'),
          h('div', { style: S.th }, '称呼'),
          h('div', { style: S.th }, '启用'),
          h('div', { style: S.th }, '')),
        ...绑定们().map((b, i) => h('div', { key: i, style: S.bindGrid },
          h('input', {
            style: S.input, value: b.qq || '', placeholder: '1696117435',
            onChange: (e) => 改绑定(i, { qq: e.target.value.replace(/[^\d]/g, '') }),
          }),
          h('select', {
            style: S.input, value: b.session || '',
            onChange: (e) => 改绑定(i, { session: e.target.value }),
          },
            h('option', { value: '' }, '（选会话）'),
            会话列表.map((s) => h('option', { key: s.id, value: s.id }, s.title || s.id)),
            b.session && !会话列表.some((s) => s.id === b.session)
              ? h('option', { key: b.session, value: b.session }, `（当前不可用）${b.session}`)
              : null),
          h('input', {
            style: S.input, value: b.name || '',
            onChange: (e) => 改绑定(i, { name: e.target.value }),
          }),
          h('div', null, 开关(b.enabled !== false, (v) => 改绑定(i, { enabled: v }))),
          h('button', { type: 'button', style: S.btn, onClick: () => 删绑定(i) }, '删除'))),
        绑定们().length === 0 ? h('div', { style: S.dim, margin: '8px 0' }, '尚未添加绑定。点击「加一条」并选择会话。') : null,
        h('div', { style: { marginTop: 8 } }, h('button', { type: 'button', style: S.btn, onClick: 加绑定 }, '加一条')))

      const 连接页 = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '连接设置'),
        行('NapCat 服务地址', 输入(配置.napcatBaseUrl, (v) => 改('napcatBaseUrl', v), 'http://127.0.0.1:3000'),
          '填写 NapCat 服务地址，结尾不要带斜杠。'),
        行('访问令牌', 输入(配置.napcatToken, (v) => 改('napcatToken', v), '没有就留空'),
          '仅在 NapCat 启用鉴权时填写；显示 ***已设置*** 表示已保存，不修改将保留原值。'),
        行('优先使用长连接', 开关(配置.wsEnabled, (v) => 改('wsEnabled', v)),
          '长连接不可用时，将自动改用轮询。'),
        行('长连接地址', 输入(配置.wsUrl, (v) => 改('wsUrl', v), '留空自动生成'),
          '一般无需填写；留空时将根据服务地址自动生成。'))

      const 行为页 = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '消息处理'),
        行('仅发送 [QQ]…[/QQ] 标记内的内容', 开关(配置.onlyInsideMarkers, (v) => 改('onlyInsideMarkers', v)),
          '关闭后整条回复都会发送，标记本身会被移除。'),
        h('div', { style: S.hint },
          '语音识别与合成由「鱼操作集」提供；本插件负责在 QQ 与 DSH 之间传输文字、图片和语音文件。'))

      const 补投页 = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '同步与补发'),
        行('离线补发窗口（小时）', h('input', {
          style: S.small, type: 'number', min: 0, max: 168, value: 配置.backfillWindowHours ?? 24,
          onChange: (e) => 改('backfillWindowHours', Number(e.target.value)),
        }), '超出此时长的离线消息将只发送一条数量摘要。'),
        行('轮询间隔（毫秒）', h('input', {
          style: S.small, type: 'number', min: 500, max: 30000, value: 配置.pollIntervalMs ?? 2000,
          onChange: (e) => 改('pollIntervalMs', Number(e.target.value)),
        }), '仅在长连接不可用时使用。'),
        行('历史同步间隔（毫秒）', h('input', {
          style: S.small, type: 'number', min: 5000, max: 600000, value: 配置.historyIntervalMs ?? 60000,
          onChange: (e) => 改('historyIntervalMs', Number(e.target.value)),
        }), '定期读取历史消息，避免遗漏。'),
        行('消息排序等待（毫秒）', h('input', {
          style: S.small, type: 'number', min: 0, max: 5000, value: 配置.reorderBufferMs ?? 1500,
          onChange: (e) => 改('reorderBufferMs', Number(e.target.value)),
        }), '收到消息后稍作等待，再按时间顺序处理。'),
        行('每次同步条数', h('input', {
          style: S.small, type: 'number', min: 10, max: 500, value: 配置.historyCount ?? 100,
          onChange: (e) => 改('historyCount', Number(e.target.value)),
        })),
        行('待发消息保留时长（小时）', h('input', {
          style: S.small, type: 'number', min: 1, max: 720, value: 配置.outboxTtlHours ?? 24,
          onChange: (e) => 改('outboxTtlHours', Number(e.target.value)),
        }), '超出此时长的待发消息将被丢弃并记录。'),
        行('重复消息合并窗口（分钟）', h('input', {
          style: S.small, type: 'number', min: 0, max: 1440, value: 配置.outboxDedupMinutes ?? 10,
          onChange: (e) => 改('outboxDedupMinutes', Number(e.target.value)),
        }), '同一联系人、相同内容的重复消息在窗口内只保留一条。'))

      const 出站 = 桥.outbox || {}
      const 出站页 = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '待发消息'),
        h('div', { style: S.dim },
          `待发 ${出站.pending || 0} 条｜最早等待 ${出站.oldestAgeSec || 0} 秒｜已补发 ${出站.sentTotal || 0} 条｜失败 ${出站.failedTotal || 0} 条｜已丢弃 ${出站.droppedTotal || 0} 条`),
        h('div', { style: S.hint }, 'QQ 暂时无法发送的消息会先保存在本机，恢复后按时间顺序补发。'),
        出站.lastError ? h('div', { style: { ...S.danger, marginTop: 4 } }, `最近发送错误：${出站.lastError}`) : null,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h('button', { type: 'button', style: S.btn, onClick: 立即补发, disabled: 忙 }, '立即重试'),
          h('button', { type: 'button', style: S.btn, onClick: 清空队列, disabled: 忙 || !(出站.pending > 0) }, '清空待发')))

      const 日志 = Array.isArray(态.logs) ? 态.logs.join('\n') : ''
      return h('div', { className: 'fish-msg-settings', style: S.wrap },
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' } },
          h('div', { style: S.h1 }, '鱼讯 QQ'),
          h('span', { style: { ...S.badge, ...(在线 ? S.ok : S.danger) } }, 在线 ? '在线' : '离线'),
          h('span', { style: S.dim }, `v${态.version || '?'}`)),
        h('div', { style: S.dim }, 'QQ 与 DSH 双向传递消息，目前仅支持私聊。'),
        h('div', { style: { ...S.card, marginTop: 10 } },
          h('div', { style: S.dim },
            `待发 ${出站.pending || 0} 条｜最近同步 ${桥.lastSyncAt ? new Date(桥.lastSyncAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}｜`
            + `已接收 ${桥.stats?.received || 0} 条 / 已转达 ${桥.stats?.delivered || 0} 条 / 跳过 ${桥.stats?.skippedOld || 0} 条 / 错误 ${桥.stats?.errors || 0} 条`),
          (桥.lastSyncError || 桥.stats?.lastError) ? h('div', { style: { ...S.danger, marginTop: 4 } }, `最近错误：${桥.lastSyncError || 桥.stats.lastError}`) : null),
        连接页, 绑定页, 行为页, 补投页, h(表情包, { 配置, 改, 绑定们: 绑定们() }), 出站页,
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' } },
          h('button', { type: 'button', style: S.btnOn, onClick: 存, disabled: 忙 }, 忙 ? '处理中…' : '保存设置'),
          h('button', { type: 'button', style: S.btn, onClick: 测试文字, disabled: 忙 }, '发测试文字'),
          h('button', { type: 'button', style: S.btn, onClick: 拉, disabled: 忙 }, '刷新')),
        说 ? h('div', { style: 说.includes('失败') ? S.danger : S.ok }, 说) : null,
        h('div', { style: { ...S.h, marginTop: 14 } }, '最近日志'),
        h('pre', { style: S.日志 }, 日志 || '（暂无日志）'))
    }

    function apply(ctx) {
      注入控件样式()
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'fish-message', order: 56, label: () => '鱼讯 QQ' },
        Section,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
