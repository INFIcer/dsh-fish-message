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
        height: 260,
        overflow: 'auto',
        background: 'rgba(0,0,0,.06)',
        borderRadius: 6,
        padding: 8,
      },
    }

    const 提示 = (文本) => h('div', { style: S.hint }, 文本)
    const 问号 = (说明) => h('span', {
      title: 说明,
      'aria-label': 说明,
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

    const 行 = (标签, 控件, 说明, 补充) => h('div', { style: S.row },
      h('div', { style: S.lab }, 标签, 补充 ? 问号(补充) : null),
      h('div', { style: S.ctl }, 控件, 说明 ? 提示(说明) : null))

    // 状态数字旁边的小问号：只有确实需要解释的指标才带。
    const 指标 = (文本, 说明) => h('span', { style: { marginRight: 12, whiteSpace: 'nowrap' } },
      文本, 说明 ? 问号(说明) : null)

    // 提示文案的错误分级：失败、无法、不可用这类按错误色显示，其余按成功提示。
    const 是错误 = (文本) => /失败|无法|错误|不可用|不能|没打开/.test(String(文本 || ''))

    function 输入(值, onChange, 占位 = '', 禁用 = false) {
      return h('input', {
        style: S.input,
        value: 值 == null ? '' : String(值),
        placeholder: 占位,
        disabled: !!禁用,
        onChange: (e) => onChange(e.target.value),
      })
    }

    function 开关(值, onChange, 禁用 = false) {
      return h('input', { type: 'checkbox', checked: !!值, disabled: !!禁用, onChange: (e) => onChange(e.target.checked) })
    }

    // 路径输入 +「打开文件夹」：地址不存在时按钮置灰，越界等校验在宿主路由。
    function 路径输入(值, onChange, 占位, 可打开, on打开) {
      return h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
        h('div', { style: { flex: '1 1 200px', minWidth: 160 } }, 输入(值, onChange, 占位)),
        h('button', {
          type: 'button', style: S.btn, disabled: !可打开, onClick: on打开,
        }, '打开文件夹'))
    }

    // ---------------- 表情包管理视图 ----------------
    // 网格占用的面积大、条目可能很多，所以从设置页拆出来单独一页；
    // 所有读写仍走宿主路由 /dsh-fish-message/stickers*。
    // 预览直接用 <img> 指向库中原图，GIF 会自己动；loading="lazy" 做惰性加载。
    function 表情包页({ 绑定们, 返回设置 }) {
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

      const 错 = (r) => String((r && (r.error || r.message)) || '没有收到服务响应。')

      const 拉 = async () => {
        const p = new URLSearchParams()
        p.set('limit', '200')
        p.set('sort', 排序)
        if (q.trim()) p.set('q', q.trim())
        if (标签) p.set('tag', 标签)
        const r = await get('/stickers?' + p.toString())
        if (r && r.ok) 设列表(r)
        else if (r && r.error) 设说('无法读取表情包：' + 错(r))
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

      // 只开插件自己的库目录，路径由后端按配置决定，前端不传。
      const 打开库文件夹 = async () => {
        设忙(true); 设说('正在打开表情库文件夹…')
        const r = await post('/stickers/open-folder', {})
        设忙(false)
        if (!r || !r.ok) 设说('没打开文件夹：' + 错(r))
        else 设说('已在资源管理器中打开表情库文件夹。')
      }

      const 清理 = async (mode) => {
        const 文案 = {
          unused: '删除所有未使用过的表情及其图片文件？此操作无法撤销。',
          dedupe: '删除内容重复的表情，只保留使用次数最多的一份？此操作无法撤销。',
          inbox: '清空最近收到的图片？这不会影响表情包中已保存的表情。',
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

      // 吸顶操作条：返回、标题和整排操作按钮都在这里，滚动时始终可见。
      const 操作条 = h('div', { style: S.bar },
        h('div', { style: S.barRow },
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 } },
            h('button', { type: 'button', style: S.btn, onClick: 返回设置 }, '返回设置'),
            h('div', { style: { ...S.h1, margin: 0 } }, '表情包管理')),
          h('div', { style: S.barActions },
            h('button', { type: 'button', style: S.btn, onClick: 拉, disabled: 忙 }, '刷新'))),
        h('div', { style: S.barActions },
          h('input', {
            type: 'file', multiple: true, accept: 'image/*', disabled: 忙,
            onChange: (e) => { 上传(e.target.files); e.target.value = '' },
          }),
          h('button', {
            type: 'button', style: S.btn, onClick: 打开库文件夹, disabled: 忙,
          }, '打开表情库文件夹'),
          h('button', {
            type: 'button', style: S.btn, onClick: () => 清理('unused'), disabled: 忙,
          }, '删除未使用'),
          h('button', {
            type: 'button', style: S.btn, onClick: () => 清理('dedupe'), disabled: 忙,
          }, '清理重复'),
          h('button', {
            type: 'button', style: S.btn, onClick: () => 清理('inbox'), disabled: 忙,
          }, '清空最近图片')),
        说 ? h('div', { style: { ...(是错误(说) ? S.danger : S.ok), marginTop: 2 } }, 说) : null)

      // 搜索、标签、排序和统计不常用到必须一直可见，放在操作条下面跟着内容滚。
      const 筛选条 = h('div', { style: S.card },
        h('div', { style: S.hint }, '可一次选多张，也可以把图片直接拖进本页。'),
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
          `共 ${统计.count || 0} 个（上限 ${统计.maxCount || '?'}）｜占用 ${统计.sizeMB || 0}MB（上限 ${统计.maxMB || '?'}MB）｜已使用 ${统计.used || 0} 个｜未使用 ${统计.unused || 0} 个`))

      const 网格 = h('div', { style: { ...S.card } },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, `表情（${列表.total ?? 卡片们.length} 个）`),
        卡片们.length === 0
          ? h('div', { style: S.dim }, '暂无表情。可以上传图片，或把图片拖进本页。')
          : h('div', { style: S.grid }, 卡片们.map((条目) => {
            const v = 取值(条目)
            const qq = 对象[条目.id] || (绑定们[0] && 绑定们[0].qq) || ''
            return h('div', { key: 条目.id, style: S.stickerCard },
              h('img', { src: 图地址(条目), loading: 'lazy', alt: 条目.desc || 条目.file, style: S.thumb }),
              h('div', { style: { fontSize: 11, opacity: 0.65, wordBreak: 'break-all' } }, 条目.file),
              h('div', { style: { fontSize: 11, opacity: 0.6 } },
                `${条目.width || 0}×${条目.height || 0}｜${条目.size_kb || 0}KB｜已使用 ${条目.used_count || 0} 次`),
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
                h('button', {
                  type: 'button', style: S.btn, onClick: () => 复制路径(条目),
                }, '复制路径'),
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
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, `最近收到的图片（${最近.length} 张）`),
        h('div', { style: S.hint }, '不会自动存入表情包；填写标签或描述后可存为表情。'),
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
      }, 操作条, 筛选条, 网格, 最近块)
    }

    /** 设置页里的表情包入口：只放统计与入口按钮。 */
    function 表情设置({ 配置, 改, 打开, 已保存目录 = '', 目录存在 = false }) {
      const [统计, 设统计] = React.useState({})
      const [说, 设说] = React.useState('')
      const [错, 设错] = React.useState(false)
      React.useEffect(() => {
        let 有效 = true
        get('/stickers?limit=1').then((r) => {
          if (有效 && r && r.ok) 设统计(r.stats || {})
        })
        return () => { 有效 = false }
      }, [])

      const 数量 = Number(统计.count) || 0
      const 路径 = String(配置.stickerDir || '').trim()
      const 已保存 = String(已保存目录 || '').trim()
      // 只认宿主确认存在、且与输入框一致的目录；改了路径要先保存才能打开。
      const 可打开 = Boolean(已保存 && 目录存在) && 路径 === 已保存
      const 开文件夹 = async () => {
        const r = await post('/open-folder', { path: 路径 })
        if (!r || !r.ok) {
          设错(true)
          设说(String((r && (r.error || r.hint)) || '打开失败，请稍后重试。'))
        } else {
          设错(false)
          设说('已在资源管理器中打开。')
        }
      }

      return h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '表情包'),
        行('保存位置', 路径输入(配置.stickerDir, (v) => 改('stickerDir', v), '使用默认位置', 可打开, 开文件夹),
          null,
          '更换后只读取新目录，原有图片不会迁移。'),
        行('收到图片时自动存入表情包', 开关(配置.autoSaveStickers, (v) => 改('autoSaveStickers', v)),
          null,
          '开启后收到的图片自动入库，表情包会增长较快。'),
        行('数量上限', h('input', {
          style: S.small, type: 'number', min: 1, max: 10000, value: 配置.stickerMaxCount ?? 2000,
          onChange: (e) => 改('stickerMaxCount', Number(e.target.value)),
        }), null,
        '达到上限后无法新增，已有表情不受影响。'),
        行('占用空间上限（MB）', h('input', {
          style: S.small, type: 'number', min: 1, max: 10240, value: 配置.stickerMaxMB ?? 1024,
          onChange: (e) => 改('stickerMaxMB', Number(e.target.value)),
        })),
        h('div', { style: { ...S.dim, marginTop: 8 } },
          `共 ${数量} 个（上限 ${配置.stickerMaxCount ?? 2000}）｜占用 ${统计.sizeMB || 0}MB（上限 ${配置.stickerMaxMB ?? 1024}MB）｜已使用 ${统计.used || 0} 个｜未使用 ${统计.unused || 0} 个`),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 } },
          h('button', { type: 'button', style: S.btn, onClick: 打开 }, '管理表情包')),
        说 ? h('div', { style: { ...(错 ? S.danger : S.ok), marginTop: 6 } }, 说) : null)
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
      .fish-msg-settings input::placeholder,
      .fish-msg-settings textarea::placeholder { color: var(--dsw-alias-label-secondary, #888); opacity: 1; }
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
      // 当前正在执行的动作，用来让吸顶条上的按钮显示「正在保存…」这类状态。
      const [动作, 设动作] = React.useState('')
      const [说, 设说] = React.useState('')
      // 表情包的网格占用面积大，放在独立视图里，设置页只留入口。
      const [视图, 设视图] = React.useState('main')
      // 发送音色下拉：只在本地 AI 的语音能力可用时拉一次；失败就退回文本输入。
      const [音色们, 设音色们] = React.useState(null)
      const [音色提示, 设音色提示] = React.useState('')
      const 可拉音色 = Boolean(态 && 态.ai && 态.ai.tts)
      React.useEffect(() => {
        if (!可拉音色) return undefined
        let 有效 = true
        get('/ai/voices').then((r) => {
          if (!有效) return
          if (r && r.ok && Array.isArray(r.voices) && r.voices.length) 设音色们(r.voices)
          else {
            设音色们(null)
            设音色提示(String((r && r.hint) || '暂时读不到音色列表，可直接填写音色名。'))
          }
        })
        return () => { 有效 = false }
      }, [可拉音色])

      const 拉 = async () => {
        const s = await get('/state')
        if (s) 设态(s)
      }
      // 手动刷新：和自动轮询共用一个拉取函数，但要让按钮显示正在做事。
      const 刷新 = async () => {
        设忙(true); 设动作('刷新'); 设说('正在刷新状态…')
        await 拉()
        设忙(false); 设动作(''); 设说('')
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
        设忙(true); 设动作('保存'); 设说('正在保存…')
        const r = await post('/save', { config: 配置 })
        设忙(false); 设动作('')
        if (r && r.ok) {
          设脏(false)
          设说('设置已保存。')
          await 拉()
        } else {
          设说('保存失败：' + String((r && (r.error || r.message)) || '没有收到服务响应，请稍后重试。'))
        }
      }
      const 测试文字 = async () => {
        设忙(true); 设动作('测试'); 设说('正在发送测试消息…')
        const r = await post('/test-send', {})
        设忙(false); 设动作('')
        if (!r || !r.ok) 设说('测试失败：' + String((r && r.error) || '没有收到服务响应，请稍后重试。'))
        else if (r.queued) 设说(`QQ 当前无法发送，测试消息已加入待发列表（积压 ${r.pending ?? '?'} 条），恢复后将自动补发。`)
        else 设说(`已发送至 QQ ${r.qq}`)
      }
      const 立即补发 = async () => {
        设忙(true); 设说('正在重试待发消息…')
        const r = await post('/outbox/flush', {})
        设忙(false)
        if (!r || !r.ok) 设说('重试失败：' + String((r && r.error) || '没有收到服务响应，请稍后重试。'))
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
        设说(r && r.ok ? `已清空 ${r.cleared || 0} 条。` : '清空失败：' + String((r && r.error) || '没有收到服务响应，请稍后重试。'))
        await 拉()
      }

      if (!态) return h('div', { className: 'fish-msg-settings', style: S.wrap }, h('div', { style: S.h1 }, '鱼讯 QQ'), h('div', { style: S.dim }, '正在读取当前状态…'))

      if (视图 === 'stickers') {
        return h('div', { className: 'fish-msg-settings', style: { ...S.wrap, minHeight: '62vh' } },
          h(表情包页, { 绑定们: 绑定们(), 返回设置: () => 设视图('main') }))
      }

      const 桥 = 态.bridge || {}
      const 传 = 桥.transport || {}
      // HTTP 轮询模式下 transport.connected 一直是 false，用宿主算好的在线状态。
      const 在线 = Boolean(传.online)
      const 链路 = 在线 ? (传.mode === 'ws' ? '在线·实时' : '在线·轮询') : '离线'
      const 离线原因 = String(传.lastError || 桥.lastSyncError || 桥.stats?.lastError || '').trim().replace(/[。！？.!?]+$/, '')
      const 转发 = 桥.forward || {}
      const 暂停转发 = Boolean(配置.forwardPaused)
      const 会话列表 = Array.isArray(态.sessions) ? 态.sessions : []

      const 绑定页 = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '私聊绑定'),
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
            h('option', { value: '' }, '（选择会话）'),
            会话列表.map((s) => h('option', { key: s.id, value: s.id }, s.title || s.id)),
            b.session && !会话列表.some((s) => s.id === b.session)
              ? h('option', { key: b.session, value: b.session }, `（会话当前不可用）${b.session}`)
              : null),
          h('input', {
            style: S.input, value: b.name || '',
            onChange: (e) => 改绑定(i, { name: e.target.value }),
          }),
          h('div', null, 开关(b.enabled !== false, (v) => 改绑定(i, { enabled: v }))),
          h('button', { type: 'button', style: S.btn, onClick: () => 删绑定(i) }, '删除'))),
        绑定们().length === 0 ? h('div', { style: S.dim, margin: '8px 0' }, '还没有绑定。添加一条后，QQ 私聊才会转进 DSH 会话。') : null,
        h('div', { style: { marginTop: 8 } }, h('button', { type: 'button', style: S.btn, onClick: 加绑定 }, '添加绑定')))

      const 连接页 = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '连接设置'),
        h('div', { style: S.dim }, '消息经本机运行的 QQ 服务收发，使用前请先启动该服务。'),
        行('QQ 服务地址', 输入(配置.napcatBaseUrl, (v) => 改('napcatBaseUrl', v), '留空使用默认地址')),
        行('访问令牌（可选）', 输入(配置.napcatToken, (v) => 改('napcatToken', v), '未设置时留空'),
          null,
          '服务端开启鉴权时才需要填写。'),
        行('优先实时接收', 开关(配置.wsEnabled, (v) => 改('wsEnabled', v)),
          null,
          '开启后消息更及时；不可用时自动改为定时查询。'),
        行('实时接收地址', 输入(配置.wsUrl, (v) => 改('wsUrl', v), '留空自动生成')))

      const 行为页 = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '消息处理'),
        h('div', { style: S.dim }, '控制 QQ 与 DSH 之间的消息如何转发。'),
        行('暂停转发到会话', 开关(配置.forwardPaused, (v) => 改('forwardPaused', v)),
          '暂停期间仍会收到 QQ 消息，恢复后按顺序补发；停放太久已过期的消息不再补发。'),
        暂停转发 ? h('div', { style: { ...S.hint, marginBottom: 6 } }, `待转发 ${转发.pending || 0} 条`) : null,
        行('仅发送 [QQ] 标记内的内容', 开关(配置.onlyInsideMarkers, (v) => 改('onlyInsideMarkers', v)),
          null,
          '开启时只发标记内的部分；关闭时整条发送，标记会被去掉。'))

      // 默认文案都由宿主 /state 下发，前端不另写一份（原文只在 lib/config.js 一处）。
      const 默认识图提示词 = String((态.defaults && 态.defaults.inboundImagePrompt) || '')
      const 默认长任务提醒 = String((态.defaults && 态.defaults.guardStuckPrompt) || '')
      const 默认消息通道提醒 = String((态.defaults && 态.defaults.guardQqPrompt) || '')
      const 守护 = 态.guard || {}
      const 守护告警 = Array.isArray(守护.alerts) ? 守护.alerts : []
      const 防失联页 = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '防失联'),
        h('div', { style: S.dim }, '让绑定的消息能持续收发；注意调整会话权限设置，权限过低可能因授权问题被中断。'),
        行('保持绑定会话能收发', 开关(配置.guardEnabled, (v) => 改('guardEnabled', v)),
          '开启后，绑定的会话内禁用会导致会话中断的工具'),
        行('长任务监控（秒）', h('input', {
          style: S.small, type: 'number', min: 1, max: 7200, value: 配置.guardStuckSeconds ?? 600,
          onChange: (e) => 改('guardStuckSeconds', Number(e.target.value)),
        }), '主会话单轮执行过久时提醒智能体'),
        行('长任务提醒提示词', h('div', null,
          h('textarea', {
            style: {
              ...S.input, minHeight: 64, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit',
            },
            rows: 3,
            maxLength: 4000,
            value: 配置.guardStuckPrompt || '',
            placeholder: 默认长任务提醒,
            onChange: (e) => 改('guardStuckPrompt', e.target.value),
          }),
          配置.guardStuckPrompt
            ? h('div', { style: { marginTop: 6 } },
              h('button', {
                type: 'button', style: S.btn,
                onClick: () => 改('guardStuckPrompt', ''),
              }, '恢复默认'))
            : null),
        '留空时使用内置默认提示词。'),
        行('消息通道监控（轮）', h('input', {
          style: S.small, type: 'number', min: 1, max: 50, value: 配置.guardQqRemindTurns ?? 3,
          onChange: (e) => 改('guardQqRemindTurns', Number(e.target.value)),
        }), '主会话多轮没有使用鱼讯回复内容时提醒智能体'),
        行('消息通道提醒提示词', h('div', null,
          h('textarea', {
            style: {
              ...S.input, minHeight: 64, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit',
            },
            rows: 3,
            maxLength: 4000,
            value: 配置.guardQqPrompt || '',
            placeholder: 默认消息通道提醒,
            onChange: (e) => 改('guardQqPrompt', e.target.value),
          }),
          配置.guardQqPrompt
            ? h('div', { style: { marginTop: 6 } },
              h('button', {
                type: 'button', style: S.btn,
                onClick: () => 改('guardQqPrompt', ''),
              }, '恢复默认'))
            : null),
        '留空时使用内置默认提示词。'),
        守护告警.length
          ? h('div', { style: { ...S.danger, marginTop: 4 } },
            `正在提醒：${守护告警.map((a) => `${a.title}（已运行 ${a.seconds} 秒）`).join('、')}`)
          : null)

      const AI能力 = 态.ai || {}
      const AI在线 = Boolean(AI能力.online)
      const 语音可用 = Boolean(AI能力.tts)
      const 转写可用 = Boolean(AI能力.asr)
      const 识图可用 = Boolean(AI能力.vision)
      const 服务提示 = AI能力.installed
        ? (AI能力.hint || '本地 AI 插件没启动，语音和识图暂不可用。')
        : '本地 AI 插件没装或没启动，语音和识图暂不可用。'
      const 音色值 = 配置.sayVoice || 'dafeiyu'
      const 音色控件 = (Array.isArray(音色们) && 音色们.length)
        ? h('select', {
          style: S.input, value: 音色值, disabled: !语音可用,
          onChange: (e) => 改('sayVoice', e.target.value),
        },
          音色们.includes(音色值) ? null : h('option', { value: 音色值 }, 音色值),
          音色们.map((名) => h('option', { key: 名, value: 名 }, 名)))
        : 输入(音色值, (v) => 改('sayVoice', v), 'dafeiyu', !语音可用)

      const 语音页 = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '本地 AI 服务'),
        AI在线 ? null : h('div', { style: { ...S.hint, marginBottom: 8 } }, 服务提示),
        (AI在线 && !语音可用) ? h('div', { style: { ...S.hint, marginBottom: 8 } }, '本地 AI 的语音合成暂不可用。') : null,
        行('发送语音音色', h('div', null,
          音色控件,
          (!Array.isArray(音色们) && 音色提示 && 语音可用) ? h('div', { style: S.hint }, 音色提示) : null),
        '用于把 [语音] 文字[/语音] 合成为语音条。', null),
        行('发送语音语速', h('input', {
          style: S.small, type: 'number', min: 0.5, max: 2, step: 0.1,
          value: 配置.saySpeed ?? 1, disabled: !语音可用,
          onChange: (e) => 改('saySpeed', Number(e.target.value)),
        }), null, '数值越大语速越快；范围 0.5 到 2，默认 1。'),
        (AI在线 && !转写可用) ? h('div', { style: { ...S.hint, marginBottom: 8 } }, '本地 AI 的语音识别暂不可用。') : null,
        行('收到语音后自动分析', 开关(配置.transcribeInbound, (v) => 改('transcribeInbound', v), !转写可用),
          '会识别文字和情感；不勾选只把语音文件路径递进会话。', null),
        行('语音分析语言', h('select', {
          style: S.input, value: 配置.asrLanguage || 'auto', disabled: !转写可用 || 配置.transcribeInbound === false,
          onChange: (e) => 改('asrLanguage', e.target.value),
        },
          h('option', { value: 'auto' }, '自动识别'),
          h('option', { value: 'zh' }, '中文'),
          h('option', { value: 'en' }, '英语'),
          h('option', { value: 'ja' }, '日语'),
          h('option', { value: 'ko' }, '韩语'),
          h('option', { value: 'yue' }, '粤语'))),
        行('收到图片后先在本地识图', h('select', {
          style: S.input, value: 配置.describeInboundImages || 'inherit', disabled: !AI能力.installed,
          onChange: (e) => 改('describeInboundImages', e.target.value),
        },
          h('option', { value: 'inherit' }, '继承本地 AI 插件'),
          h('option', { value: 'on' }, '开'),
          h('option', { value: 'off' }, '关')),
        AI能力.installed ? '选「继承」时跟随本地 AI 插件的识图开关。' : '需先安装本地 AI 插件。'),
        (AI在线 && !识图可用) ? h('div', { style: { ...S.hint, marginTop: 2 } }, '本地 AI 的识图能力暂不可用。') : null,
        行('图片识别提示词', h('div', null,
          h('textarea', {
            style: {
              ...S.input, minHeight: 64, resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit',
            },
            rows: 3,
            maxLength: 4000,
            value: 配置.inboundImagePrompt || '',
            placeholder: 默认识图提示词,
            disabled: !AI能力.installed,
            onChange: (e) => 改('inboundImagePrompt', e.target.value),
          }),
          配置.inboundImagePrompt
            ? h('div', { style: { marginTop: 6 } },
              h('button', {
                type: 'button', style: S.btn, disabled: !AI能力.installed,
                onClick: () => 改('inboundImagePrompt', ''),
              }, '恢复默认'))
            : null),
        '留空时使用内置默认提示词。'))

      const 补投页 = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '同步与补发'),
        行('离线消息补发范围（小时）', h('input', {
          style: S.small, type: 'number', min: 0, max: 168, value: 配置.backfillWindowHours ?? 24,
          onChange: (e) => 改('backfillWindowHours', Number(e.target.value)),
        }), '离线期间的消息在此范围内逐条补发，超出只提示数量。'),
        行('定时查询间隔（毫秒）', h('input', {
          style: S.small, type: 'number', min: 500, max: 30000, value: 配置.pollIntervalMs ?? 2000,
          onChange: (e) => 改('pollIntervalMs', Number(e.target.value)),
        }), null,
        '实时接收不可用时才使用；间隔越短越及时。'),
        行('定期核对间隔（毫秒）', h('input', {
          style: S.small, type: 'number', min: 5000, max: 600000, value: 配置.historyIntervalMs ?? 60000,
          onChange: (e) => 改('historyIntervalMs', Number(e.target.value)),
        }), '每隔这么久和 QQ 核对一次最近消息，防止漏收。'),
        行('消息排序等待（毫秒）', h('input', {
          style: S.small, type: 'number', min: 0, max: 5000, value: 配置.reorderBufferMs ?? 1500,
          onChange: (e) => 改('reorderBufferMs', Number(e.target.value)),
        }), '收到消息后先等这么久再按时间排序，避免先后颠倒。'),
        行('每次读取条数', h('input', {
          style: S.small, type: 'number', min: 10, max: 500, value: 配置.historyCount ?? 100,
          onChange: (e) => 改('historyCount', Number(e.target.value)),
        }), null, '一次最多读这么多条；取太小可能分多次读取。'),
        行('待发消息保留时长（小时）', h('input', {
          style: S.small, type: 'number', min: 1, max: 720, value: 配置.outboxTtlHours ?? 24,
          onChange: (e) => 改('outboxTtlHours', Number(e.target.value)),
        }), '超过此时间不再补发，以免恢复后集中发送过期内容。'),
        行('重复消息合并窗口（分钟）', h('input', {
          style: S.small, type: 'number', min: 0, max: 1440, value: 配置.outboxDedupMinutes ?? 10,
          onChange: (e) => 改('outboxDedupMinutes', Number(e.target.value)),
        }), null,
        '相同内容只发一条，避免重试造成重复；0 表示不合并。'))

      const 出站 = 桥.outbox || {}
      const 出站页 = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '待发消息'),
        h('div', { style: S.dim },
          指标(`待发 ${出站.pending || 0} 条`),
          指标(`最早等待 ${出站.oldestAgeSec || 0} 秒`),
          指标(`已补发 ${出站.sentTotal || 0} 条`),
          指标(`失败 ${出站.failedTotal || 0} 条`),
          指标(`已丢弃 ${出站.droppedTotal || 0} 条`)),
        h('div', { style: S.hint }, 'QQ 暂时不可用时先存本机，恢复后按时间顺序补发。'),
        出站.lastError && !在线 ? h('div', { style: { ...S.danger, marginTop: 4 } }, `最近一次发送失败：${出站.lastError}`) : null,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h('button', {
            type: 'button', style: S.btn, onClick: 立即补发, disabled: 忙,
          }, '立即重试'),
          h('button', {
            type: 'button', style: S.btn, onClick: 清空队列, disabled: 忙 || !(出站.pending > 0),
          }, '清空待发')))

      const 日志 = Array.isArray(态.logs) ? 态.logs.join('\n') : ''
      // 吸顶操作条：标题、在线状态和页面级按钮都收在这里，内容在它下面滚动。
      const 操作条 = h('div', { style: S.bar },
        h('div', { style: S.barRow },
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 } },
            h('div', { style: { ...S.h1, margin: 0 } }, '鱼讯 QQ'),
            h('span', {
              style: { ...S.badge, ...(在线 ? S.ok : S.danger) },
              title: 在线 ? (传.mode === 'ws' ? '按实时连接接收消息' : '按定时查询接收消息') : '暂时连不上 QQ 服务',
            }, 链路),
            h('span', { style: S.dim }, `v${态.version || '?'}`)),
          h('div', { style: S.barActions },
            h('button', {
              type: 'button', style: S.btnOn, onClick: 存, disabled: 忙,
            }, 忙 && 动作 === '保存' ? '正在保存…' : '保存设置'),
            h('button', {
              type: 'button', style: S.btn, onClick: 测试文字, disabled: 忙,
            }, 忙 && 动作 === '测试' ? '正在发送…' : '发送测试消息'),
            h('button', {
              type: 'button', style: S.btn, onClick: 刷新, disabled: 忙,
            }, 忙 && 动作 === '刷新' ? '正在刷新…' : '刷新状态'))),
        h('div', { style: S.dim }, '在 QQ 与 DSH 之间互传私聊消息。'),
        说 ? h('div', { style: { ...(是错误(说) ? S.danger : S.ok), marginTop: 2 } }, 说) : null)
      return h('div', { className: 'fish-msg-settings', style: S.wrap },
        操作条,
        h('div', { style: S.card },
          h('div', { style: S.dim },
            指标(`待发 ${出站.pending || 0} 条`),
            指标(`最近同步 ${桥.lastSyncAt ? new Date(桥.lastSyncAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}`),
            指标(`已收到 ${桥.stats?.received || 0} 条`),
            指标(`已转达 ${桥.stats?.delivered || 0} 条`, '已送入 DSH 会话。'),
            指标(`已跳过 ${桥.stats?.skippedOld || 0} 条`, '早于补发范围的旧消息。'),
            指标(`出错 ${桥.stats?.errors || 0} 次`, '历史累计，不代表当前状态。')),
          !在线 && 离线原因
            ? h('div', { style: { ...S.danger, marginTop: 4 } },
              `离线原因：${离线原因}。请检查 QQ 服务是否已启动、地址是否正确。`)
            : null),
        连接页, 绑定页, 行为页, 防失联页, 语音页, 补投页, h(表情设置, {
          配置,
          改,
          打开: () => 设视图('stickers'),
          已保存目录: 态.stickerDir || '',
          目录存在: Boolean(态.stickerDirExists),
        }), 出站页,
        h('div', { style: { ...S.h, marginTop: 14 } }, '最近日志'),
        h('pre', { style: S.日志 }, 日志 || '暂无日志。'))
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
