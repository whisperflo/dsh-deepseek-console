window.__ModuleLoader__.load({ id: '@local/dsh-deepseek-console', factory: (require) => {
var module = { exports: {} }
var exports = module.exports
const React = require('react')
function insertStyle(css) {
  const tag = document.createElement('style')
  tag.textContent = css
  document.head.appendChild(tag)
  return () => { if (tag.parentNode) tag.parentNode.removeChild(tag) }
}
const ROUTES = {
  'ds/account': ['GET', '/api/deepseek/account'],
  'ds/refresh': ['POST', '/api/deepseek/refresh'],
  'ds/usage': ['GET', '/api/deepseek/usage'],
  'ds/hud': ['GET', '/api/deepseek/hud'],
  'ds/config': ['GET', '/api/deepseek/config'],
  'ds/saveConfig': ['POST', '/api/deepseek/saveConfig'],
  'ds/saveKey': ['POST', '/api/deepseek/saveKey'],
  'ds/test': ['POST', '/api/deepseek/test'],
  'ds/models': ['GET', '/api/deepseek/models']
}
async function rpc(method, args) {
  const entry = ROUTES[method]
  let url = entry[1]
  const opts = {}
  if (entry[0] === 'GET') {
    opts.method = 'GET'
    if (args && typeof args === 'object') {
      const qs = Object.keys(args).filter((k) => args[k] !== undefined && args[k] !== null).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(args[k]))).join('&')
      if (qs) url += '?' + qs
    }
  } else {
    opts.method = 'POST'
    opts.headers = { 'content-type': 'application/json' }
    opts.body = JSON.stringify(args || {})
  }
  const res = await fetch(url, opts)
  let json = null
  try { json = await res.json() } catch (e) { json = null }
  if (!json || json.code !== 0) throw new Error((json && json.message) || ('DeepSeek 请求失败（HTTP ' + res.status + '）'))
  return json
}
module.exports = (() => {
// ============================================================================
// DeepSeek 账户控制台 —— Client 半（浏览器端）· UI/UX 重构版
// 信息架构：概览 / 模型 / 连接 / 高级设置 四个 Tab；账户数据与开发配置分离。
// 视觉：继承 DSH 主题变量（--dsw-alias-* / --dsh-font-mono），弱边框、留白、
//      字号与字重建立层级；橙色仅用于警告类状态；主按钮用原生 Primary。
// 数据：仅经同源 fetch（/api/deepseek/*）走后端；全局悬浮 HUD + 设置页共用 DeepSeekUsageStore。
// ============================================================================

return {
  inject: ['timer', 'slots'],
  apply(ctx) {
    insertStyle(`
.ds-scope{color:var(--dsw-alias-label-primary);font-family:inherit;}
.ds-scope *{box-sizing:border-box;}
.ds-tabs{display:flex;gap:2px;margin-bottom:20px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.ds-tab{appearance:none;background:transparent;border:none;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;padding:8px 12px 10px;cursor:pointer;margin-bottom:-1px;}
.ds-tab:hover{color:var(--dsw-alias-label-primary);}
.ds-tab.on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);}
.ds-panel{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:18px;}
.ds-panel+.ds-panel{margin-top:14px;}
.ds-panel-hd{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;}
.ds-panel-hd .t{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary);}
.ds-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#999);line-height:1.6;}
.ds-mono{font-family:var(--dsh-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);}
.ds-num{font-variant-numeric:tabular-nums;}
.ds-dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:0 0 auto;}
.ds-dot-ok{background:var(--dsw-alias-state-success-primary,#2f9e63);}
.ds-dot-err{background:var(--dsw-alias-state-error-primary,#e5484d);}
.ds-dot-warn{background:var(--dsw-alias-state-warn-primary,#d97706);}
.ds-dot-idle{background:var(--dsw-alias-label-tertiary,#999);}
.ds-pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:999px;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05));}
.ds-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:500;background:var(--dsw-alias-state-success-tertiary,rgba(47,158,99,.15));color:var(--dsw-alias-state-success-primary,#2f9e63);}
.ds-badge.warn{background:var(--dsw-alias-state-warn-tertiary,rgba(217,119,6,.15));color:var(--dsw-alias-state-warn-primary,#d97706);}
.ds-badge.err{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,72,77,.15));color:var(--dsw-alias-state-error-primary,#e5484d);}
.ds-budget-line{display:flex;align-items:center;gap:4px;margin-top:14px;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.04));}
.ds-budget-line.err{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,72,77,.12));}

/* 概览 hero */
.ds-hero{display:flex;flex-direction:column;gap:0;}
.ds-hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}
.ds-brand .name{font-size:16px;font-weight:600;}
.ds-brand .sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#999);margin-top:2px;}
.ds-balance{margin-top:18px;font-size:34px;font-weight:600;letter-spacing:-.5px;line-height:1;font-variant-numeric:tabular-nums;}
.ds-balance-label{margin-top:6px;font-size:12px;color:var(--dsw-alias-label-tertiary,#999);}
.ds-subbal{display:flex;gap:22px;margin-top:12px;font-size:12.5px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap;}
.ds-subbal .v{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;margin-left:5px;font-weight:500;}
.ds-divider{border-top:1px solid var(--dsw-alias-border-l1);margin:16px 0 14px;}
.ds-stats{display:flex;gap:30px;flex-wrap:wrap;}
.ds-stat .l{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);}
.ds-stat .v{margin-top:3px;font-size:15px;font-weight:500;font-variant-numeric:tabular-nums;}

/* 当前任务 */
.ds-task .model{font-family:var(--dsh-font-mono,ui-monospace,monospace);font-size:13px;font-weight:600;}
.ds-task .metrics{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-family:var(--dsh-font-mono,ui-monospace,monospace);font-size:12.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.ds-task .metrics b{color:var(--dsw-alias-label-primary);font-weight:600;}
.ds-task .metrics .in{color:var(--dsw-alias-label-primary);}
.ds-task .metrics .cost{color:var(--dsw-alias-state-warn-primary,#d97706);}

/* 表格 */
.ds-table{width:100%;border-collapse:collapse;font-size:13px;}
.ds-table th{text-align:left;color:var(--dsw-alias-label-tertiary,#999);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.ds-table td{padding:9px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums;}
.ds-table tr:last-child td{border-bottom:none;}
.ds-table td.num{text-align:right;}
.ds-table th.num{text-align:right;}
.ds-row-click{cursor:pointer;}
.ds-row-click:hover td{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.04));}
.ds-expand{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.02));}

/* 历史 / 调用 列表 */
.ds-list{display:flex;flex-direction:column;}
.ds-line{display:flex;align-items:center;gap:10px;padding:7px 0;font-size:12.5px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.ds-line:last-child{border-bottom:none;}
.ds-line .t{color:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums;min-width:64px;}
.ds-line .d{font-weight:600;font-variant-numeric:tabular-nums;min-width:82px;text-align:right;}
.ds-line .r{flex:1;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.ds-up{color:var(--dsw-alias-state-success-primary,#2f9e63);}
.ds-down{color:var(--dsw-alias-state-error-primary,#e5484d);}

/* 表单 */
.ds-form{display:flex;flex-direction:column;gap:14px;}
.ds-field{display:flex;flex-direction:column;gap:6px;}
.ds-field label{font-size:12px;color:var(--dsw-alias-label-secondary);}
.ds-field .h{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);}
.ds-input,.ds-select{width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;}
.ds-input:focus,.ds-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}
.ds-row{display:flex;gap:10px;align-items:center;}
.ds-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.ds-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;}

/* 按钮 */
.ds-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;font-weight:500;height:32px;padding:0 14px;border-radius:8px;cursor:pointer;}
.ds-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}
.ds-btn:disabled{opacity:.5;cursor:not-allowed;}
.ds-btn-p{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;}
.ds-btn-p:hover:not(:disabled){color:#fff;opacity:.88;}
.ds-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary);}
.ds-btn-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05));}

/* 提示条 */
.ds-banner{border-radius:10px;padding:10px 13px;font-size:12.5px;margin-bottom:14px;display:flex;gap:8px;align-items:flex-start;line-height:1.5;}
.ds-banner-ok{background:var(--dsw-alias-state-success-tertiary,rgba(47,158,99,.15));color:var(--dsw-alias-state-success-primary,#2f9e63);}
.ds-banner-warn{background:var(--dsw-alias-state-warn-tertiary,rgba(217,119,6,.15));color:var(--dsw-alias-state-warn-primary,#d97706);}
.ds-banner-err{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,72,77,.15));color:var(--dsw-alias-state-error-primary,#e5484d);}

/* 数据来源 tooltip */
.ds-info{position:relative;display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);cursor:help;}
.ds-info .tip{display:none;position:absolute;right:0;top:calc(100% + 8px);width:260px;z-index:50;background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay,#222));border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.3));padding:10px 12px;font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);cursor:default;}
.ds-info:hover .tip{display:block;}

.ds-loading{padding:60px 0;text-align:center;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;}
.ds-empty{padding:18px 0;text-align:center;color:var(--dsw-alias-label-tertiary,#999);font-size:12.5px;}
@media (max-width:760px){.ds-grid2,.ds-grid3{grid-template-columns:1fr;}}
`)

    const h = React.createElement

    // ─────────────────────────── 全局实时 Store ───────────────────────────
    const LS_KEY = 'dsh.deepseek-hud'
    const loadPref = () => { try { if (typeof localStorage === 'undefined') return {}; const v = localStorage.getItem(LS_KEY); return v ? JSON.parse(v) : {} } catch (e) { return {} } }
    const savePref = (p) => { try { if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(p)) } catch (e) {} }

    function createDeepSeekStore() {
      let state = { task: null, requesting: false, balance: null, cash: null, granted: null, apiStatus: 'idle', lastSyncAt: null, lastError: null, keyConfigured: false, today: null }
      const listeners = new Set()
      let timer = null
      const set = (p) => { state = Object.assign({}, state, p); for (const l of Array.from(listeners)) { try { l(state) } catch (e) {} } }
      const poll = async () => {
        try {
          const res = await rpc('ds/hud', null)
          if (res && res.code === 0 && res.data) set(res.data)
        } catch (e) { /* 静默 */ }
      }
      // 强制同步：POST /api/deepseek/refresh 使宿主绕过缓存直连官方 API，
      // 成功后立即重取 hud 摘要（与「控制台 → 同步」同一路径）。
      const refresh = async () => {
        try {
          await rpc('ds/refresh', {})
          await poll()
        } catch (e) { /* 静默（下次轮询会重试） */ }
      }
      const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
      const start = () => { if (!timer) { poll(); timer = ctx.interval(poll, 2000) } }
      const stop = () => { if (timer) { timer(); timer = null } }
      return { get: () => state, subscribe, start, stop, poll, refresh }
    }
    const dsStore = createDeepSeekStore()
    const useDeepSeek = () => {
      const [s, setS] = React.useState(dsStore.get())
      React.useEffect(() => dsStore.subscribe(setS), [])
      return s
    }
    ctx.effect(() => { dsStore.start(); return () => dsStore.stop() })

    // ─────────────────────────── 格式化 ───────────────────────────
    const fmtMoney = (n, d = 2) => (n === null || n === undefined || Number.isNaN(Number(n))) ? '—' : '¥' + Number(n).toFixed(d)
    const fmtInt = (n) => (n === null || n === undefined) ? '—' : Number(n).toLocaleString('zh-CN')
    const fmtTokens = (n) => {
      if (n === null || n === undefined || Number.isNaN(Number(n))) return '—'
      const v = Number(n)
      if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
      if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
      return String(v)
    }
    const fmtTime = (iso) => { if (!iso) return '—'; const d = new Date(iso); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0') }
    const fmtMs = (ms) => (ms === null || ms === undefined) ? '—' : (ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s')
    const statusText = (s) => ({ ok: '已同步', error: '同步异常', idle: '未同步' }[s] || s || '—')
    const changeText = (t) => ({ increase: '余额增加', decrease: '余额减少', first: '初始记录' }[t] || t || '')

    // ─────────────────────────── 原语 ───────────────────────────
    const Dot = (props) => h('span', { className: 'ds-dot ds-dot-' + (props.tone || 'idle') })
    const Pill = (props) => h('span', { className: 'ds-pill' }, h(Dot, { tone: props.tone }), props.children)
    const Panel = (props) => h('div', { className: 'ds-panel' },
      props.title ? h('div', { className: 'ds-panel-hd' }, h('span', { className: 't' }, props.title), props.extra || null) : null,
      props.children)
    const Field = (props) => h('div', { className: 'ds-field' },
      props.label ? h('label', null, props.label) : null,
      props.children,
      props.hint ? h('span', { className: 'h' }, props.hint) : null)

    function DataSourceInfo() {
      return h('span', { className: 'ds-info' }, 'ⓘ 数据来源',
        h('span', { className: 'tip' },
          h('div', null, '余额 — DeepSeek 官方 API'),
          h('div', null, '模型 — DeepSeek 官方 API'),
          h('div', null, 'Token / 请求 — 本机 DSH 实时统计'),
          h('div', null, '费用 — 按模型价格本地估算')))
    }

    // ─────────────────────────── 概览 ───────────────────────────
    // 预算告警行：仅当配置了预算时渲染；超限红色、未超绿色提示。
    function budgetLine(props) {
      const b = props.account && props.account.budget ? props.account.budget : null
      if (!b || (b.dailyBudget === null || b.dailyBudget === undefined) && (b.sessionBudget === null || b.sessionBudget === undefined)) return null
      const exceeded = b.dailyExceeded || b.sessionExceeded
      const lines = []
      if (b.dailyBudget !== null && b.dailyBudget !== undefined) lines.push('每日 ' + fmtMoney(b.dailyBudget) + ' · 已用 ' + fmtMoney(b.todayCost) + (b.dailyExceeded ? ' · 已超支' : ''))
      if (b.sessionBudget !== null && b.sessionBudget !== undefined) lines.push('会话 ' + fmtMoney(b.sessionBudget) + ' · 已用 ' + fmtMoney(b.todayCost) + (b.sessionExceeded ? ' · 已超支' : ''))
      return h('div', { className: 'ds-budget-line' + (exceeded ? ' err' : '') },
        h('span', { className: 'ds-badge ' + (exceeded ? 'err' : '') }, exceeded ? '⚠ 预算超支' : '预算内'),
        h('span', { className: 'ds-hint', style: { marginLeft: 8 } }, lines.join('　·　')))
    }

    function Overview(props) {
      const { account, stats, history, lastChange, ds, onRefresh, syncing, down, latencyMs } = props
      const today = stats ? stats.today : null
      const month = stats ? stats.month : null
      const t = ds.task
      const deltaTone = (d) => (d === null || d === undefined) ? '' : (d > 0 ? 'ds-up' : (d < 0 ? 'ds-down' : ''))
      const deltaText = (d) => (d === null || d === undefined) ? '—' : (d > 0 ? '+' + d.toFixed(2) : d.toFixed(2))

      return h('div', { className: 'ds-scope' },
        h(Panel, null,
          h('div', { className: 'ds-hero' },
            h('div', { className: 'ds-hero-top' },
              h('div', { className: 'ds-brand' },
                h('div', { className: 'name' }, 'DeepSeek'),
                h('div', { className: 'sub' }, '官方 API · 本地安全代理')),
              h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
                h(Pill, { tone: syncing ? 'warn' : (down ? 'err' : (account && account.syncStatus === 'ok' ? 'ok' : 'idle')) },
                  syncing ? '同步中' : statusText(account ? account.syncStatus : 'idle') + ' ' + fmtTime(account ? account.lastSyncAt : null)),
                h('button', { className: 'ds-btn', disabled: syncing, onClick: onRefresh }, '刷新'))),
            h('div', { className: 'ds-balance' }, fmtMoney(account ? account.balance : null)),
            h('div', { className: 'ds-balance-label' }, '当前余额'),
            h('div', { className: 'ds-subbal' },
              h('span', null, '现金余额', h('span', { className: 'v' }, fmtMoney(account ? account.cash : null))),
              h('span', null, '赠送余额', h('span', { className: 'v' }, fmtMoney(account ? account.granted : null))),
              lastChange ? h('span', null, '较上次', h('span', { className: 'v ' + deltaTone(lastChange.delta) }, deltaText(lastChange.delta))) : null),
            h('div', { className: 'ds-divider' }),
            h('div', { className: 'ds-stats' },
              h('div', { className: 'ds-stat' }, h('div', { className: 'l' }, '今日消费'), h('div', { className: 'v' }, fmtMoney(today ? today.cost : null))),
              h('div', { className: 'ds-stat' }, h('div', { className: 'l' }, '本月消费'), h('div', { className: 'v' }, fmtMoney(month ? month.cost : null))),
              h('div', { className: 'ds-stat' }, h('div', { className: 'l' }, '本月 Token'), h('div', { className: 'v' }, fmtTokens(month ? month.totalTokens : null))),
              h('div', { className: 'ds-stat' }, h('div', { className: 'l' }, '接口延迟'), h('div', { className: 'v' }, fmtMs(latencyMs)))),
            budgetLine(props))),
        h(Panel, { title: '当前任务', extra: h('span', { className: 'ds-badge' + (ds.requesting ? ' warn' : '') }, ds.requesting ? '实时' : '空闲') },
          h('div', { className: 'ds-task' },
            t && t.total > 0
              ? h('div', null,
                  h('div', { className: 'model' }, t.model || '—'),
                  h('div', { className: 'metrics' },
                    h('span', { className: 'in' }, '↓ ' + fmtTokens(t.input)),
                    h('span', null, '↑ ' + fmtTokens(t.output)),
                    h('span', null, h('b', null, fmtTokens(t.total)), ' Token'),
                    h('span', null, t.requests + ' requests'),
                    h('span', { className: 'cost' }, t.cost !== null && t.cost !== undefined ? fmtMoney(t.cost) : '未计价')))
              : h('div', { className: 'ds-empty' }, '暂无任务。开始一次对话后，此处会实时累计本次任务的 Token 与费用。'))),
        h(Panel, { title: '余额变化' },
          (history && history.length)
            ? h('div', { className: 'ds-list' }, history.slice(0, 8).map((e) =>
                h('div', { key: e.ts + '-' + e.newBalance, className: 'ds-line' },
                  h('span', { className: 't' }, fmtTime(e.at)),
                  h('span', { className: 'd ' + deltaTone(e.delta) }, deltaText(e.delta)),
                  h('span', { className: 'r' }, fmtMoney(e.oldBalance) + ' → ' + fmtMoney(e.newBalance) + ' · ' + changeText(e.changeType)))))
            : h('div', { className: 'ds-empty' }, '暂无余额变化记录')))
    }

    // ─────────────────────────── 模型 ───────────────────────────
    function ModelsView(props) {
      const { models, priceTier } = props
      const [open, setOpen] = React.useState(null)
      const list = (models && models.data && models.data.models) ? models.data.models : []
      const tierText = (priceTier === 'peak' ? '高峰' : priceTier === 'off' ? '空闲' : '平均') + '价'
      return h('div', { className: 'ds-scope' },
        h(Panel, { title: '可用模型', extra: h('span', { className: 'ds-hint' }, '来自官方 GET /models · ' + tierText + '估算基准') },
          h('table', { className: 'ds-table' },
            h('thead', null, h('tr', null,
              h('th', null, '模型'), h('th', null, '状态'), h('th', { className: 'num' }, '上下文'), h('th', { className: 'num' }, '价格 输入/输出'))),
            h('tbody', null, list.map((m) => {
              const expanded = open === m.id
              return h(React.Fragment, { key: m.id },
                h('tr', { className: 'ds-row-click', onClick: () => setOpen(expanded ? null : m.id) },
                  h('td', { className: 'ds-mono' }, m.id),
                  h('td', null, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, h(Dot, { tone: 'ok' }), '可用')),
                  h('td', { className: 'num' }, m.contextWindow ? fmtTokens(m.contextWindow) : '—'),
                  h('td', { className: 'num ds-mono' }, m.cacheMissIn !== null ? '¥' + Number(m.cacheMissIn).toFixed(0) + ' / ¥' + Number(m.out).toFixed(0) : '—')),
                expanded ? h('tr', { className: 'ds-expand' },
                  h('td', { colSpan: 4, style: { padding: '12px 10px' } },
                    h('div', { style: { display: 'flex', gap: 24, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', flexWrap: 'wrap' } },
                      h('span', null, '输入·缓存命中 ' + (m.cacheHitIn !== null ? '¥' + Number(m.cacheHitIn).toFixed(2) : '—') + '/M'),
                      h('span', null, '输入·缓存未命中 ' + (m.cacheMissIn !== null ? '¥' + Number(m.cacheMissIn).toFixed(2) : '—') + '/M'),
                      h('span', null, '输出 ' + (m.out !== null ? '¥' + Number(m.out).toFixed(2) : '—') + '/M'),
                      h('span', null, '空闲时段 = 高峰 × 0.5')))) : null)
            })))))
    }

    // ─────────────────────────── 连接 ───────────────────────────
    function ConnectionView(props) {
      const { account, cfgKey, keyVal, setKeyVal, saveKey, test, testBusy, runTest, cfgForm, setCfg, saveCfg } = props
      return h('div', { className: 'ds-scope' },
        h(Panel, { title: 'DeepSeek API' },
          h('div', { className: 'ds-form' },
            h(Field, { label: 'API Key' + (cfgKey && cfgKey.configured ? '　已配置 ' + (account ? account.keyMasked : '') + ' · 来源 ' + (cfgKey.source || '—') + (cfgKey.writable ? '' : ' · 只读') : '　未配置'), hint: 'Key 仅存本机后端凭证库，绝不发送到浏览器存储' },
              h('div', { className: 'ds-row' },
                h('input', { className: 'ds-input', type: 'password', placeholder: 'sk-…', value: keyVal, onChange: (e) => setKeyVal(e.target.value), style: { flex: 1 } }),
                h('button', { className: 'ds-btn ds-btn-p', onClick: saveKey }, '保存并验证'))),
            h(Field, { label: 'API Base URL' },
              h('input', { className: 'ds-input ds-mono', value: cfgForm ? cfgForm.baseURL : '', onChange: (e) => setCfg('baseURL', e.target.value) })),
            h('div', { className: 'ds-row' },
              h('button', { className: 'ds-btn', disabled: testBusy, onClick: runTest }, testBusy ? '测试中…' : '测试连接'),
              h('button', { className: 'ds-btn', onClick: saveCfg }, '保存连接配置'),
              test && test.data && test.data.status === 'ok' ? h('span', { className: 'ds-hint', style: { color: 'var(--dsw-alias-state-success-primary)' } }, '● 已连接 · ' + fmtMs(test.data.latencyMs)) : null,
              test && test.data && test.data.status === 'error' ? h('span', { className: 'ds-hint', style: { color: 'var(--dsw-alias-state-error-primary)' } }, '! ' + (test.data.message || '连接失败')) : null))))
    }

    // ─────────────────────────── 高级设置 ───────────────────────────
    function AdvancedView(props) {
      const { cfgForm, setCfg, saveCfg, setPrice } = props
      return h('div', { className: 'ds-scope' },
        h(Panel, { title: '同步与请求' },
          h('div', { className: 'ds-grid3' },
            h(Field, { label: '轮询间隔（秒）' }, h('input', { className: 'ds-input', type: 'number', min: 5, max: 300, value: cfgForm ? cfgForm.pollIntervalSec : 15, onChange: (e) => setCfg('pollIntervalSec', Number(e.target.value)) })),
            h(Field, { label: '余额缓存 TTL（秒）' }, h('input', { className: 'ds-input', type: 'number', min: 0, max: 60, value: cfgForm ? cfgForm.cacheTtlSec : 5, onChange: (e) => setCfg('cacheTtlSec', Number(e.target.value)) })),
            h(Field, { label: '请求超时（秒）' }, h('input', { className: 'ds-input', type: 'number', min: 3, max: 60, value: cfgForm ? cfgForm.timeoutSec : 10, onChange: (e) => setCfg('timeoutSec', Number(e.target.value)) })))),
        h(Panel, { title: '预算告警', extra: h('span', { className: 'ds-hint' }, '费用超阈值时 HUD 与概览页告警（估算口径）') },
          h('div', { className: 'ds-form' },
            h(Field, { label: '每日费用预算（元）', hint: '留空 = 不告警；今日消费超过该值时显示「超日预算」' },
              h('input', { className: 'ds-input', type: 'number', min: 0, step: '0.01', placeholder: '如 20', value: cfgForm && cfgForm.dailyBudget !== null && cfgForm.dailyBudget !== undefined ? String(cfgForm.dailyBudget) : '', onChange: (e) => setCfg('dailyBudget', e.target.value === '' ? null : Number(e.target.value)) })),
            h(Field, { label: '单次会话费用预算（元）', hint: '留空 = 不告警；会话（今日累计）超过该值时显示「超会话预算」' },
              h('input', { className: 'ds-input', type: 'number', min: 0, step: '0.01', placeholder: '如 5', value: cfgForm && cfgForm.sessionBudget !== null && cfgForm.sessionBudget !== undefined ? String(cfgForm.sessionBudget) : '', onChange: (e) => setCfg('sessionBudget', e.target.value === '' ? null : Number(e.target.value)) })),
            h('div', null,
              h('button', { className: 'ds-btn ds-btn-p', onClick: saveCfg }, '保存设置')))),
        h(Panel, { title: '计价策略' },
          h('div', { className: 'ds-form' },
            h(Field, { label: '费用估算基准档位', hint: '空闲 = 高峰 × 0.5；平均 = 0.75 × 高峰' },
              h('select', { className: 'ds-select', value: cfgForm ? cfgForm.priceTier : 'peak', onChange: (e) => setCfg('priceTier', e.target.value) },
                h('option', { value: 'peak' }, '高峰价（保守上界）'),
                h('option', { value: 'off' }, '空闲价（高峰一半）'),
                h('option', { value: 'avg' }, '平均价（0.75×高峰）'))),
            h('div', null,
              h('button', { className: 'ds-btn ds-btn-p', onClick: saveCfg }, '保存设置')))),
        h(Panel, { title: '模型价格表（元 / 百万 tokens）', extra: h('span', { className: 'ds-hint' }, '官方定价 2026-08-17 · 可覆盖') },
          h('table', { className: 'ds-table' },
            h('thead', null, h('tr', null, h('th', null, '模型'), h('th', { className: 'num' }, '缓存命中'), h('th', { className: 'num' }, '缓存未命中'), h('th', { className: 'num' }, '输出'))),
            h('tbody', null, (cfgForm && cfgForm.pricing ? Object.keys(cfgForm.pricing) : []).map((m) =>
              h('tr', { key: m },
                h('td', { className: 'ds-mono' }, m),
                h('td', { className: 'num' }, h('input', { className: 'ds-input', style: { width: 90, textAlign: 'right', height: 26 }, type: 'number', step: '0.01', min: 0, value: cfgForm.pricing[m].cacheHitIn, onChange: (e) => setPrice(m, 'cacheHitIn', e.target.value) })),
                h('td', { className: 'num' }, h('input', { className: 'ds-input', style: { width: 90, textAlign: 'right', height: 26 }, type: 'number', step: '0.01', min: 0, value: cfgForm.pricing[m].cacheMissIn, onChange: (e) => setPrice(m, 'cacheMissIn', e.target.value) })),
                h('td', { className: 'num' }, h('input', { className: 'ds-input', style: { width: 90, textAlign: 'right', height: 26 }, type: 'number', step: '0.01', min: 0, value: cfgForm.pricing[m].out, onChange: (e) => setPrice(m, 'out', e.target.value) }))))))))
    }

    // ─────────────────────────── 主容器（Tab） ───────────────────────────
    function Dashboard() {
      const [tab, setTab] = React.useState('overview')
      const [view, setView] = React.useState({ loading: true, data: null, error: null, syncing: false })
      const [models, setModels] = React.useState(null)
      const [cfgForm, setCfgForm] = React.useState(null)
      const [cfgKey, setCfgKey] = React.useState(null)
      const [keyVal, setKeyVal] = React.useState('')
      const [test, setTest] = React.useState(null)
      const [testBusy, setTestBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const ds = useDeepSeek()

      const load = React.useCallback(async (force) => {
        setView((v) => Object.assign({}, v, { syncing: true }))
        try {
          const res = await rpc(force ? 'ds/refresh' : 'ds/account', {})
          setView({ loading: false, data: res, error: null, syncing: false })
        } catch (e) {
          setView((v) => Object.assign({}, v, { loading: false, syncing: false, error: String((e && e.message) || e) }))
        }
      }, [])
      const loadModels = React.useCallback(async () => { try { setModels(await rpc('ds/models', {})) } catch (e) {} }, [])
      const loadConfig = React.useCallback(async () => {
        try {
          const res = await rpc('ds/config', {})
          setCfgForm({ baseURL: res.data.config.baseURL, pollIntervalSec: res.data.config.pollIntervalSec, cacheTtlSec: res.data.config.cacheTtlSec, timeoutSec: res.data.config.timeoutSec, priceTier: res.data.config.priceTier, pricing: JSON.parse(JSON.stringify(res.data.config.pricing)) })
          setCfgKey(res.data.key)
        } catch (e) {}
      }, [])

      React.useEffect(() => { load(false); loadConfig(); loadModels() }, [])

      const pollSec = (view.data && view.data.data && view.data.data.account && view.data.data.account.pollIntervalSec) || 15
      React.useEffect(() => {
        const dispose = ctx.interval(() => { load(false) }, pollSec * 1000)
        return () => { if (dispose) dispose() }
      }, [pollSec])

      const runTest = async () => { setTestBusy(true); setTest(null); try { setTest(await rpc('ds/test', {})) } catch (e) { setTest({ status: 'error', message: String((e && e.message) || e) }) } setTestBusy(false) }
      const saveKey = async () => {
        if (!keyVal) { setMsg('请输入 API Key'); return }
        try { await rpc('ds/saveKey', { key: keyVal }); setKeyVal(''); setMsg('API Key 已保存并通过验证'); load(false); loadConfig() } catch (e) { setMsg('保存失败：' + String((e && e.message) || e)) }
      }
      const saveCfg = async () => {
        try { const res = await rpc('ds/saveConfig', { patch: cfgForm }); setMsg('配置已保存'); setCfgForm(res.data.config); load(false) } catch (e) { setMsg('保存失败：' + String((e && e.message) || e)) }
      }
      const setCfg = (k, v) => setCfgForm((f) => Object.assign({}, f, { [k]: v }))
      const setPrice = (model, k, v) => setCfgForm((f) => {
        const pricing = JSON.parse(JSON.stringify(f.pricing || {}))
        pricing[model] = Object.assign({}, pricing[model] || {}, { [k]: Number(v) || 0 })
        return Object.assign({}, f, { pricing })
      })

      if (view.loading) return h('div', { className: 'ds-scope' }, h('div', { className: 'ds-loading' }, '加载 DeepSeek 账户数据…'))

      const data = view.data && view.data.data
      const account = data ? data.account : null
      const stats = data ? data.stats : null
      const history = data ? data.history : null
      const lastChange = data ? data.lastChange : null
      const down = account && account.syncStatus === 'error'

      const tabs = [['overview', '概览'], ['models', '模型'], ['connection', '连接'], ['advanced', '高级设置']]

      return h('div', { className: 'ds-scope' },
        view.error ? h('div', { className: 'ds-banner ds-banner-err' }, '宿主服务不可达：' + view.error) : null,
        down ? h('div', { className: 'ds-banner ds-banner-warn' }, 'DeepSeek 服务暂时不可用 · 展示最后一次缓存数据' + (account && account.lastError ? '（' + account.lastError + '）' : '')) : null,
        msg ? h('div', { className: 'ds-banner ds-banner-ok' }, msg) : null,
        h('div', { className: 'ds-tabs' }, tabs.map(([id, label]) =>
          h('button', { key: id, className: 'ds-tab' + (tab === id ? ' on' : ''), onClick: () => setTab(id) }, label))),
        tab === 'overview' ? h(Overview, { account, stats, history, lastChange, ds, onRefresh: () => load(true), syncing: view.syncing, down, latencyMs: account ? account.latencyMs : null }) : null,
        tab === 'models' ? h(ModelsView, { models, priceTier: models && models.data ? models.data.priceTier : 'peak' }) : null,
        tab === 'connection' ? h(ConnectionView, { account, cfgKey, keyVal, setKeyVal, saveKey, test, testBusy, runTest, cfgForm, setCfg, saveCfg }) : null,
        tab === 'advanced' ? h(AdvancedView, { cfgForm, setCfg, saveCfg, setPrice }) : null,
        tab === 'overview' ? h('div', { style: { marginTop: 14, display: 'flex', justifyContent: 'flex-end' } }, h(DataSourceInfo)) : null)
    }

    // ─────────────────────────── 全局 Mini HUD ───────────────────────────
    insertStyle(`
.dshud{position:fixed;z-index:2147483000;pointer-events:auto;font-family:inherit;}
.dshud.snap{transition:left .18s ease,top .18s ease;}
.dshud.dragging{transition:none;}
.dshud-area{display:flex;flex-direction:column;align-items:flex-end;}
.dshud-ball{display:flex;align-items:center;gap:7px;height:38px;padding:0 14px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv3,0 4px 16px rgba(0,0,0,.2));font-size:12.5px;line-height:1;color:var(--dsw-alias-label-primary);cursor:grab;user-select:none;white-space:nowrap;touch-action:none;}
.dshud-ball:active{cursor:grabbing;}
.dshud-name{font-weight:600;letter-spacing:.3px;}
.dshud-bal{font-weight:600;font-variant-numeric:tabular-nums;}
.dshud-flash{font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;}
.dshud-flash.up{color:var(--dsw-alias-state-success-primary,#2f9e63);}
.dshud-flash.down{color:var(--dsw-alias-state-error-primary,#e5484d);}
.dshud-panel{position:static;margin:0 0 6px;width:280px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay,#222));border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 12px 36px rgba(0,0,0,.3));padding:14px 16px;font-size:12.5px;color:var(--dsw-alias-label-primary);}
.dshud-panel .t{font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;}
.dshud-row{display:flex;justify-content:space-between;padding:4px 0;font-variant-numeric:tabular-nums;}
.dshud-row .k{color:var(--dsw-alias-label-secondary);}
.dshud-row .v{font-weight:500;}
.dshud-divider{border-top:1px solid var(--dsw-alias-border-l1);margin:8px 0 6px;}
.dshud-btns{display:flex;gap:8px;margin-top:12px;}
.dshud-btn{flex:1;height:28px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;font-size:12px;cursor:pointer;}
.dshud-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}
.dshud-btn-p{flex:1;height:28px;border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff;border-radius:8px;font-size:12px;cursor:pointer;}
.dshud-btn-p:hover{opacity:.88;}
.dshud-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);margin-top:8px;line-height:1.5;}
.dshud-backdrop{position:fixed;inset:0;z-index:2147482999;}
@keyframes dshud-pulse{0%,100%{opacity:1}50%{opacity:.5}}
.dshud-pulse{animation:dshud-pulse 1.2s ease-in-out infinite;}
`)

    // —— Cordis 动态插件面板压缩（类名来自 dsh-client-ui-cordis 构建，前缀稳定） ——
    insertStyle(`
.Nqubda_header{min-height:34px!important;padding:6px 12px!important;}
.Nqubda_body{padding:0 10px 8px!important;}
.Nqubda_group{margin:2px 0!important;font-size:10px!important;line-height:14px!important;}
.Nqubda_rows{gap:6px!important;}
.Nqubda_row{padding:9px 10px 7px!important;gap:4px!important;}
.Nqubda_rowHead{gap:6px!important;}
.Nqubda_rowStatus{height:18px!important;padding:0 5px!important;font-size:10px!important;line-height:18px!important;}
.Nqubda_rowDetail{gap:5px!important;min-height:22px!important;}
.Nqubda_versionPicker{gap:4px!important;font-size:11px!important;}
.Nqubda_versionPicker select{flex:none!important;width:96px!important;height:22px!important;font-size:11px!important;padding:0 6px!important;border-radius:6px!important;}
.Nqubda_rowPurpose{font-size:11px!important;line-height:16px!important;}
.Nqubda_rowActions{gap:3px!important;}
.Nqubda_transition{gap:4px!important;font-size:10px!important;}
.Nqubda_transitionActions{gap:4px!important;}
.Nqubda_transitionActions button{height:22px!important;padding:0 8px!important;font-size:11px!important;}
.Nqubda_actionButton{width:24px!important;height:24px!important;}
.Nqubda_rowError{font-size:11px!important;}
`)

    function FloatingWidget() {
      const ds = useDeepSeek()
      // 初始位置：有持久化则用保存的位置；否则默认右下角。
      // 一律用 left/top 锚定——若用 right/bottom 锚定，hover 展开面板
      // 使容器变高时会带动球整体位移（底部锚定导致容器向上长），
      // 鼠标移开面板收起又弹回，表现为「悬停时球位置变化」。
      const [pos, setPos] = React.useState(() => {
        const saved = clampPos((loadPref() || {}).pos)
        if (saved) return saved
        const W = window.innerWidth || 800
        const H = window.innerHeight || 600
        return { x: Math.max(8, W - 120 - 16), y: Math.max(8, H - 46 - 16) }
      })
      const [open, setOpen] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      const [dragging, setDragging] = React.useState(false)
      const [flash, setFlash] = React.useState(null)
      const prevBal = React.useRef(null)
      const rootRef = React.useRef(null)
      const showT = React.useRef(null)
      const hideT = React.useRef(null)
      const clickT = React.useRef(null)
      const dragRef = React.useRef(null)

      // 函数声明（提升），供 useState 初始化器调用
      function clampPos(p) {
        if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null
        const W = window.innerWidth || 800
        const H = window.innerHeight || 600
        return { x: Math.max(8, Math.min(W - 120 - 8, Math.round(p.x))), y: Math.max(8, Math.min(H - 46 - 8, Math.round(p.y))) }
      }

      React.useEffect(() => {
        if (ds.balance === null || ds.balance === undefined) return
        const p = prevBal.current
        if (p !== null && p !== undefined && Math.abs(ds.balance - p) > 1e-9) {
          const delta = Math.round((ds.balance - p) * 100) / 100
          setFlash({ up: delta > 0, delta })
          const t = ctx.timeout(() => setFlash(null), 2500)
          return () => { if (t) t() }
        }
        prevBal.current = ds.balance
      }, [ds.balance])

      // 窗口 resize 后校正位置，避免拖出视口
      React.useEffect(() => {
        const onResize = () => {
          setPos((p) => {
            if (!p) return p
            const c = clampPos(p)
            if (c.x === p.x && c.y === p.y) return p
            savePref({ pos: c })
            return c
          })
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // 一步直达 设置 → DeepSeek（既有逻辑，保持不变）
      const openConsole = () => {
        setOpen(false)
        setHover(false)
        try {
          const trigger = document.querySelector('[aria-haspopup="dialog"]')
          if (trigger && typeof trigger.click === 'function') trigger.click()
        } catch (e) { /* 忽略 */ }
        let tries = 0
        const find = () => {
          tries += 1
          let target = null
          try {
            target = Array.from(document.querySelectorAll('button')).find((b) => {
              if (!b.offsetParent) return false
              return (b.textContent || '').trim() === 'DeepSeek'
            }) || null
          } catch (e) { target = null }
          if (target) { try { target.click() } catch (e) {} return }
          if (tries < 20) clickT.current = ctx.timeout(find, 120)
        }
        find()
      }

      // hover：250ms 延迟展开（快速掠过的鼠标不会立刻弹面板），离开 300ms 延迟收起
      const cancelShow = () => { if (showT.current) { showT.current(); showT.current = null } }
      const cancelHide = () => { if (hideT.current) { hideT.current(); hideT.current = null } }
      const onAreaEnter = () => {
        if (dragging) return
        cancelHide()
        if (!showT.current) showT.current = ctx.timeout(() => { showT.current = null; setHover(true) }, 250)
      }
      const onAreaLeave = () => {
        cancelShow()
        cancelHide()
        hideT.current = ctx.timeout(() => { hideT.current = null; setHover(false) }, 300)
      }

      // —— 真实拖拽：window 级 pointermove/up（必然收到）+ setPointerCapture 双保险 + <5px 点击区分 ——
      const onBallPointerDown = (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        e.preventDefault()
        cancelShow()
        cancelHide()
        setHover(false)
        const rect = rootRef.current ? rootRef.current.getBoundingClientRect() : { left: 0, top: 0 }
        const drag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, baseX: rect.left, baseY: rect.top, moved: false }
        dragRef.current = drag
        setDragging(true)
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) { /* 忽略 */ }
        const W = window.innerWidth || 800
        const H = window.innerHeight || 600
        const onWinMove = (ev) => {
          if (ev.pointerId !== drag.pointerId) return
          const dx = ev.clientX - drag.startX
          const dy = ev.clientY - drag.startY
          if (!drag.moved && Math.sqrt(dx * dx + dy * dy) < 5) return
          drag.moved = true
          const el = rootRef.current
          const w = el ? el.offsetWidth : 110
          const h = el ? el.offsetHeight : 38
          const x = Math.max(8, Math.min(W - w - 8, drag.baseX + dx))
          const y = Math.max(8, Math.min(H - h - 8, drag.baseY + dy))
          setPos({ x, y })
        }
        const onWinEnd = (ev) => {
          if (ev.pointerId !== drag.pointerId) return
          window.removeEventListener('pointermove', onWinMove)
          window.removeEventListener('pointerup', onWinEnd)
          window.removeEventListener('pointercancel', onWinEnd)
          if (dragRef.current === drag) dragRef.current = null
          setDragging(false)
          if (!drag.moved) { setOpen((o) => !o); return }   // 点击（移动 <5px）
          // 拖拽：按中心点吸附最近边缘，保留 Y，保存位置
          const el = rootRef.current
          const w = el ? el.offsetWidth : 110
          const h = el ? el.offsetHeight : 38
          const dx = ev.clientX - drag.startX
          const dy = ev.clientY - drag.startY
          const rawX = Math.max(8, Math.min(W - w - 8, drag.baseX + dx))
          const rawY = Math.max(8, Math.min(H - h - 8, drag.baseY + dy))
          const snapX = (rawX + w / 2) < W / 2 ? 12 : W - w - 12
          const next = { x: snapX, y: rawY }
          setPos(next)
          savePref({ pos: next })
        }
        window.addEventListener('pointermove', onWinMove)
        window.addEventListener('pointerup', onWinEnd)
        window.addEventListener('pointercancel', onWinEnd)
      }

      const status = ds.apiStatus
      const dot = ds.requesting ? 'warn dshud-pulse' : (status === 'ok' ? 'ok' : status === 'error' ? 'err' : 'idle')
      const t = ds.task
      const today = ds.today
      const balText = fmtMoney(ds.balance)

      // 悬浮球：状态点 + DS + 余额（38px 高小胶囊，默认不占空间）
      const ball = [
        h('span', { className: 'ds-dot ds-dot-' + dot }),
        h('span', { className: 'dshud-name' }, 'DS'),
        h('span', { className: 'dshud-bal' }, balText),
        flash ? h('span', { className: 'dshud-flash ' + (flash.up ? 'up' : 'down') }, (flash.up ? '+' : '') + flash.delta.toFixed(2)) : null
      ]

      const showPanel = open || hover
      const bgt = ds.budget
      const budgetBadge = bgt && (bgt.dailyBudget !== null && bgt.dailyBudget !== undefined || bgt.sessionBudget !== null && bgt.sessionBudget !== undefined)
        ? h('span', { className: 'ds-badge ' + (bgt.dailyExceeded || bgt.sessionExceeded ? 'err' : ''), style: { marginLeft: 6 } },
            bgt.dailyExceeded ? '超日预算' : (bgt.sessionExceeded ? '超会话预算' : '预算内'))
        : null
      const panel = h(React.Fragment, null,
        h('div', { className: 't' }, h('span', { className: 'ds-dot ds-dot-' + dot }), h('span', null, 'DeepSeek'), budgetBadge, ds.requesting ? h('span', { className: 'ds-badge warn', style: { marginLeft: 'auto' } }, '生成中') : null),
        h('div', { className: 'dshud-divider' }),
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '账户余额'), h('span', { className: 'v' }, balText)),
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '当前任务'), h('span', { className: 'v' }, t && t.cost !== null && t.cost !== undefined ? fmtMoney(t.cost) : '—')),
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '本次 Token'), h('span', { className: 'v' }, t ? fmtTokens(t.total) : '—')),
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '请求次数'), h('span', { className: 'v' }, t ? t.requests : '—')),
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '模型'), h('span', { className: 'v ds-mono' }, t && t.model ? t.model : '—')),
        h('div', { className: 'dshud-divider' }),
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '今日消费'), h('span', { className: 'v' }, today ? fmtMoney(today.cost) : '—')),
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '今日 Token'), h('span', { className: 'v' }, today ? fmtTokens(today.totalTokens) : '—')),
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '最后同步'), h('span', { className: 'v' }, fmtTime(ds.lastSyncAt))),
        h('div', { className: 'dshud-btns' },
          h('button', { className: 'dshud-btn', onClick: () => dsStore.refresh() }, '刷新'),
          h('button', { className: 'dshud-btn-p', onClick: openConsole }, '打开控制台 →')))

      // 恒用 left/top 锚定：容器左上角固定，hover 展开的面板向上弹出，
      // 球本身不移动（之前无 pos 时用 right/bottom，面板弹出会带动球位移）。
      const rootStyle = { left: pos.x, top: pos.y }

      return h('div', { className: 'dshud ' + (dragging ? 'dragging' : 'snap'), style: rootStyle, ref: rootRef },
        open ? h('div', { className: 'dshud-backdrop', onClick: () => setOpen(false) }) : null,
        h('div', { className: 'dshud-area', onMouseEnter: onAreaEnter, onMouseLeave: onAreaLeave },
          showPanel ? h('div', { className: 'dshud-panel' }, panel) : null,
          h('div', { className: 'dshud-ball', onPointerDown: onBallPointerDown }, ball)))
    }

    function SelfPanel(props) {
      const ds = useDeepSeek()
      const tone = ds.requesting ? 'warn' : (ds.apiStatus === 'ok' ? 'ok' : ds.apiStatus === 'error' ? 'err' : 'idle')
      return h('div', { style: { fontSize: 13, lineHeight: 1.8, color: 'var(--dsw-alias-label-primary)', display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', null, h('span', { className: 'ds-dot ds-dot-' + tone, style: { marginRight: 7, display: 'inline-block' } }), 'DeepSeek Account'),
        ds.balance !== null && ds.balance !== undefined ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '余额 ' + fmtMoney(ds.balance) + ' · 本次 ' + fmtMoney(ds.task && ds.task.cost !== null ? ds.task.cost : 0)) : null,
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#999)' } }, '完整面板：设置 → DeepSeek 账户控制台'))
    }

    // ─────────────────────────── 注册 UI ───────────────────────────
    const slots = ctx.slots
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'deepseek-hud', order: 50, label: 'DeepSeek 用量 HUD' },
      (props) => h(FloatingWidget)
    ))
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'deepseek-console', order: 25, label: 'DeepSeek' },
      (props) => h(Dashboard)
    ))
    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      (props) => h(SelfPanel, { packageId: props.packageId })
    ))
  }
}

})()
return module.exports
}})
