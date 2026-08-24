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
  if (!entry) throw new Error('未知方法: ' + method)
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

/* 每日消费硬限制 */
.ds-switch{position:relative;display:inline-flex;align-items:center;width:36px;height:20px;flex:none;cursor:pointer;}
.ds-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;pointer-events:none;}
.ds-switch .knob{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(125,125,135,.35));transition:background .15s ease;pointer-events:none;}
.ds-switch .knob::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .15s ease;}
.ds-switch input:checked + .knob{background:var(--dsw-alias-brand-primary,#086cff);}
.ds-switch input:checked + .knob::after{transform:translateX(16px);}
.ds-switch input:focus-visible + .knob{outline:2px solid var(--dsw-alias-brand-primary,#086cff);outline-offset:2px;}
.ds-switch-state{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.ds-limit-progress{margin-top:6px;}
.ds-limit-progress .hd{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.ds-limit-progress .hd .amt{color:var(--dsw-alias-label-primary);font-weight:500;}
.ds-limit-progress .hd .pct{margin-left:8px;color:var(--dsw-alias-label-tertiary,#999);}
.ds-limit-progress .hd .pct.warn{color:var(--dsw-alias-state-warn-primary,#d97706);}
.ds-limit-progress .hd .pct.err{color:var(--dsw-alias-state-error-primary,#e5484d);}
.ds-limit-bar{margin-top:6px;height:6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(125,125,135,.2));overflow:hidden;}
.ds-limit-bar .fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,#086cff);transition:width .25s ease;}
.ds-limit-bar .fill.warn{background:var(--dsw-alias-state-warn-primary,#d97706);}
.ds-limit-bar .fill.err{background:var(--dsw-alias-state-error-primary,#e5484d);}
.ds-limit-note{margin-top:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);line-height:1.6;}
.ds-limit-note.err{color:var(--dsw-alias-state-error-primary,#e5484d);}
.ds-confirm-mask{position:fixed;inset:0;z-index:2147483100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4);}
.ds-confirm{width:360px;max-width:calc(100vw - 48px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay,#222));border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.3);padding:18px;}
.ds-confirm .t{font-size:14px;font-weight:600;margin-bottom:8px;}
.ds-confirm .d{font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.7;margin-bottom:16px;}
.ds-confirm .btns{display:flex;gap:10px;justify-content:flex-end;}
@keyframes ds-panel-flash{0%{box-shadow:0 0 0 3px rgba(8,108,255,.35);background:rgba(8,108,255,.08);}100%{box-shadow:none;background:transparent;}}
.ds-panel.flash{animation:ds-panel-flash 1.8s ease;}

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
      let state = { task: null, requesting: false, balance: null, cash: null, granted: null, apiStatus: 'idle', lastSyncAt: null, lastError: null, keyConfigured: false, today: null, limit: null }
      const listeners = new Set()
      let timer = null
      let goSeq = 0
      // 跳转信号：HUD / 其他入口请求打开 设置→DeepSeek→高级设置 并定位到限额卡片。
      // goSeq 递增保证重复点击也能重新触发 useEffect。
      let goListeners = new Set()
      const go = () => { goSeq += 1; for (const l of Array.from(goListeners)) { try { l(goSeq) } catch (e) {} } }
      const onGo = (fn) => { goListeners.add(fn); return () => goListeners.delete(fn) }
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
      return { get: () => state, subscribe, start, stop, poll, refresh, go, onGo }
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
    const Panel = (props) => h('div', { className: 'ds-panel', id: props.panelId || null },
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
    // 硬限制行：仅在开关开启时显示（关闭 = 完全不限制，不打扰）。
    function limitLine(props) {
      const lim = props.account && props.account.limit ? props.account.limit : null
      if (!lim || !lim.enabled) return null
      return h('div', { className: 'ds-budget-line' + (lim.exceeded ? ' err' : '') },
        h('span', { className: 'ds-badge ' + (lim.exceeded ? 'err' : 'warn') }, lim.exceeded ? '⛔ 已达限额' : '硬限制'),
        h('span', { className: 'ds-hint', style: { marginLeft: 8 } },
          '限额 ' + fmtMoney(lim.dailyLimit) + ' · 今日已用 ' + fmtMoney(lim.todayCost) +
          ' · 剩余 ' + fmtMoney(lim.remaining) +
          (lim.blockedCount > 0 ? ' · 今日已拦截 ' + lim.blockedCount + ' 次调用' : '') +
          (lim.exceeded ? ' · 新的 DeepSeek 调用已暂停' : '')))
    }

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
            limitLine(props),
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
    // 每日消费硬限制卡片：开关即时保存（只 patch hardLimitEnabled，不打断金额编辑）；
    // 金额与预算一起走「保存设置」。达限时开关需确认（避免误操作解除限制）。
    function HardLimitPanel(props) {
      const { cfgForm, setCfg, saveCfg, limit, toggleHardLimit, pendingToggle, confirmToggle, cancelToggle } = props
      const on = !!(cfgForm && cfgForm.hardLimitEnabled)
      const limVal = cfgForm && cfgForm.dailyLimit !== null && cfgForm.dailyLimit !== undefined ? String(cfgForm.dailyLimit) : ''
      const live = limit || {}
      const exceeded = !!live.exceeded
      const pct = live.enabled && live.dailyLimit > 0 ? Math.round((live.todayCost / live.dailyLimit) * 100) : 0
      const showPct = Math.min(100, pct)
      const tone = pct >= 100 ? 'err' : pct >= 80 ? 'warn' : ''
      // 开关点击：label onClick 手动翻转（部分宿主环境下 label→input 隐式转发不可靠）；
      // preventDefault 阻止隐式转发，避免双触发；input 保留 onChange 兜底 + 键盘可达性。
      const switchAria = '每日消费硬限制开关，当前' + (on ? '已启用' : '未启用')
      return h(Panel, { title: '每日消费限额（硬限制）', panelId: 'ds-hard-limit', extra: h('div', { className: 'ds-switch-state', role: 'switch', 'aria-checked': on, 'aria-label': switchAria, tabIndex: 0,
          onClick: (e) => { e.preventDefault(); toggleHardLimit(!on) },
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHardLimit(!on) } } },
          h('span', { className: 'ds-switch' },
            h('input', { type: 'checkbox', checked: on, onChange: (e) => toggleHardLimit(e.target.checked) }),
            h('span', { className: 'knob' })),
          on ? '已启用 ●' : '未启用 ○') },
        h('div', { className: 'ds-form' },
          h('span', { className: 'ds-hint' }, on ? '达到限额后，将暂停新的 DeepSeek 调用。' : '硬限制当前未启用，DeepSeek 调用不会受到消费金额限制。'),
          on && exceeded ? h('div', { className: 'ds-banner ds-banner-err', style: { margin: 0 } }, '⚠ 今日限额已达到') : null,
          on ? h('div', { className: 'ds-limit-progress' },
            h('div', { className: 'hd' },
              h('span', null, '今日消费 ', h('span', { className: 'amt' }, fmtMoney(live.todayCost || 0) + ' / ' + fmtMoney(live.dailyLimit))),
              h('span', { className: 'pct' + (tone ? ' ' + tone : '') }, showPct + '%')),
            h('div', { className: 'ds-limit-bar' },
              h('div', { className: 'fill' + (tone ? ' ' + tone : ''), style: { width: showPct + '%' } })),
            exceeded ? h('div', { className: 'ds-limit-note err' }, '新的 DeepSeek 调用已暂停。') : null) : null,
          h(Field, { label: '每日最多消费（元）', hint: on ? '费用为调用后统计口径，单次大调用可能小幅超出；次日自动恢复。' : null },
            h('input', {
              className: 'ds-input', type: 'number', min: 0, step: '0.01', placeholder: '如 10', value: limVal, disabled: !on,
              style: !on ? { opacity: .55, cursor: 'not-allowed' } : null,
              onChange: (e) => setCfg('dailyLimit', e.target.value === '' ? null : Number(e.target.value))
            })),
          on ? h('div', null, h('button', { className: 'ds-btn ds-btn-p', onClick: saveCfg }, '保存设置')) : null,
          h('span', { className: 'ds-hint' }, '与「预算告警」的区别：硬限制达到金额后强制阻止新的 DeepSeek 调用；预算告警达到金额后仅提醒，不阻止调用。')),
        pendingToggle !== null ? h('div', { className: 'ds-confirm-mask', onClick: cancelToggle },
          h('div', { className: 'ds-confirm', onClick: (e) => e.stopPropagation() },
            h('div', { className: 't' }, '关闭每日消费硬限制？'),
            h('div', { className: 'd' }, '关闭后，DeepSeek 调用将立即恢复，今日消费将不再受到当前每日限额限制。'),
            h('div', { className: 'btns' },
              h('button', { className: 'ds-btn', onClick: cancelToggle }, '取消'),
              h('button', { className: 'ds-btn ds-btn-p', onClick: confirmToggle }, '确认关闭')))) : null)
    }

    function AdvancedView(props) {
      const { cfgForm, setCfg, saveCfg, limit, toggleHardLimit, pendingToggle, confirmToggle, cancelToggle } = props
      return h('div', { className: 'ds-scope' },
        h(Panel, { title: '同步与请求' },
          h('div', { className: 'ds-grid3' },
            h(Field, { label: '轮询间隔（秒）' }, h('input', { className: 'ds-input', type: 'number', min: 5, max: 300, value: cfgForm ? cfgForm.pollIntervalSec : 15, onChange: (e) => setCfg('pollIntervalSec', Number(e.target.value)) })),
            h(Field, { label: '余额缓存 TTL（秒）' }, h('input', { className: 'ds-input', type: 'number', min: 0, max: 60, value: cfgForm ? cfgForm.cacheTtlSec : 5, onChange: (e) => setCfg('cacheTtlSec', Number(e.target.value)) })),
            h(Field, { label: '请求超时（秒）' }, h('input', { className: 'ds-input', type: 'number', min: 3, max: 60, value: cfgForm ? cfgForm.timeoutSec : 10, onChange: (e) => setCfg('timeoutSec', Number(e.target.value)) })))),
        h(HardLimitPanel, { cfgForm, setCfg, saveCfg, limit, toggleHardLimit, pendingToggle, confirmToggle, cancelToggle }),
        h(Panel, { title: '预算告警', extra: h('span', { className: 'ds-hint' }, '达到金额仅提醒，不阻止调用') },
          h('div', { className: 'ds-form' },
            h(Field, { label: '每日费用预算（元）', hint: '留空 = 不告警；今日消费超过该值时显示「超日预算」' },
              h('input', { className: 'ds-input', type: 'number', min: 0, step: '0.01', placeholder: '如 20', value: cfgForm && cfgForm.dailyBudget !== null && cfgForm.dailyBudget !== undefined ? String(cfgForm.dailyBudget) : '', onChange: (e) => setCfg('dailyBudget', e.target.value === '' ? null : Number(e.target.value)) })),
            h(Field, { label: '单次会话费用预算（元）', hint: '留空 = 不告警；会话（今日累计）超过该值时显示「超会话预算」' },
              h('input', { className: 'ds-input', type: 'number', min: 0, step: '0.01', placeholder: '如 5', value: cfgForm && cfgForm.sessionBudget !== null && cfgForm.sessionBudget !== undefined ? String(cfgForm.sessionBudget) : '', onChange: (e) => setCfg('sessionBudget', e.target.value === '' ? null : Number(e.target.value)) })),
            h('div', null,
              h('button', { className: 'ds-btn ds-btn-p', onClick: saveCfg }, '保存设置')))))
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
          setCfgForm({
            baseURL: res.data.config.baseURL, pollIntervalSec: res.data.config.pollIntervalSec, cacheTtlSec: res.data.config.cacheTtlSec,
            timeoutSec: res.data.config.timeoutSec, priceTier: res.data.config.priceTier,
            dailyBudget: res.data.config.dailyBudget !== undefined ? res.data.config.dailyBudget : null,
            sessionBudget: res.data.config.sessionBudget !== undefined ? res.data.config.sessionBudget : null,
            dailyLimit: res.data.config.dailyLimit !== undefined ? res.data.config.dailyLimit : null,
            hardLimitEnabled: res.data.config.hardLimitEnabled !== undefined ? !!res.data.config.hardLimitEnabled : false,
            pricing: JSON.parse(JSON.stringify(res.data.config.pricing))
          })
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
        try {
          await rpc('ds/saveKey', { key: keyVal })
          setKeyVal('')
          setMsg('API Key 已保存并通过验证')
          load(false); loadConfig()
        } catch (e) {
          // Key 已写入凭证库但验证失败：保留输入内容方便修改，红色提示
          setMsg('__ERR__' + String((e && e.message) || e))
          loadConfig()
        }
      }
      const saveCfg = async () => {
        try {
          const res = await rpc('ds/saveConfig', { patch: cfgForm })
          setMsg('配置已保存')
          setCfgForm(res.data.config)
          load(false)
          dsStore.poll() // 立即刷新 HUD 限额状态（调高限额后即时恢复调用）
        } catch (e) { setMsg('保存失败：' + String((e && e.message) || e)) }
      }
      const setCfg = (k, v) => setCfgForm((f) => Object.assign({}, f, { [k]: v }))

      // 硬限制开关：只 patch hardLimitEnabled，不动金额（保留用户未保存的编辑）。
      // 已达限额时先弹确认框；确认/开启即时生效并立即拉取限额状态。
      const [pendingToggle, setPendingToggle] = React.useState(null) // null | 'off' | 'on'
      const applyToggle = async (next) => {
        try {
          const res = await rpc('ds/saveConfig', { patch: { hardLimitEnabled: next } })
          setCfgForm((f) => Object.assign({}, f, { hardLimitEnabled: next }))
          load(false); loadConfig(); dsStore.poll()
        } catch (e) { setMsg('保存失败：' + String((e && e.message) || e)) }
      }
      const toggleHardLimit = (next) => {
        const lim = dsStore.get().limit
        if (!next && lim && lim.exceeded) { setPendingToggle('off'); return } // 达限关闭需确认
        applyToggle(next)
      }
      const confirmToggle = () => { setPendingToggle(null); applyToggle(false) }
      const cancelToggle = () => setPendingToggle(null)

      // 跳转信号：切到高级设置 Tab 并定位到限额卡片（1.8s 高亮）
      React.useEffect(() => dsStore.onGo(() => {
        setTab('advanced')
        ctx.timeout(() => {
          const el = document.getElementById('ds-hard-limit')
          if (!el) return
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash')
          ctx.timeout(() => el.classList.remove('flash'), 2000)
        }, 60)
      }), [])

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
        msg ? h('div', { className: 'ds-banner ' + (msg.indexOf('__ERR__') === 0 ? 'ds-banner-err' : 'ds-banner-ok') }, msg.indexOf('__ERR__') === 0 ? msg.slice(7) : msg) : null,
        h('div', { className: 'ds-tabs' }, tabs.map(([id, label]) =>
          h('button', { key: id, className: 'ds-tab' + (tab === id ? ' on' : ''), onClick: () => setTab(id) }, label))),
        tab === 'overview' ? h(Overview, { account, stats, history, lastChange, ds, onRefresh: () => load(true), syncing: view.syncing, down, latencyMs: account ? account.latencyMs : null }) : null,
        tab === 'models' ? h(ModelsView, { models, priceTier: models && models.data ? models.data.priceTier : 'peak' }) : null,
        tab === 'connection' ? h(ConnectionView, { account, cfgKey, keyVal, setKeyVal, saveKey, test, testBusy, runTest, cfgForm, setCfg, saveCfg }) : null,
        tab === 'advanced' ? h(AdvancedView, { cfgForm, setCfg, saveCfg, limit: (dsStore.get().limit || (view.data && view.data.data && view.data.data.limit) || null), toggleHardLimit, pendingToggle, confirmToggle, cancelToggle }) : null,
        tab === 'overview' ? h('div', { style: { marginTop: 14, display: 'flex', justifyContent: 'flex-end' } }, h(DataSourceInfo)) : null)
    }

    // ─────────────────────────── 全局 Mini HUD ───────────────────────────
    insertStyle(`
.dshud{position:fixed;z-index:2147483000;pointer-events:auto;font-family:inherit;width:max-content;}
.dshud.snap{transition:left .18s ease,top .18s ease;}
.dshud.dragging{transition:none;}
.dshud-ball{display:flex;align-items:center;gap:7px;height:38px;padding:0 14px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv3,0 4px 16px rgba(0,0,0,.2));font-size:12.5px;line-height:1;color:var(--dsw-alias-label-primary);cursor:grab;user-select:none;white-space:nowrap;touch-action:none;}
.dshud-ball:active{cursor:grabbing;}
.dshud.hidden-ball .dshud-ball{opacity:0;visibility:hidden;pointer-events:none;}
.dshud-name{font-weight:600;letter-spacing:.3px;}
.dshud-bal{font-weight:600;font-variant-numeric:tabular-nums;}
.dshud-flash{font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;}
.dshud-flash.up{color:var(--dsw-alias-state-success-primary,#2f9e63);}
.dshud-flash.down{color:var(--dsw-alias-state-error-primary,#e5484d);}
.dshud-pop{position:fixed;z-index:2147483001;width:300px;max-width:340px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay,#222));border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 12px 36px rgba(0,0,0,.3));padding:16px 18px;font-size:12.5px;color:var(--dsw-alias-label-primary);animation:dshud-pop-in .14s ease;}
@keyframes dshud-pop-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.dshud-pop .t{font-weight:600;font-size:13px;display:flex;align-items:center;gap:7px;}
.dshud-pop .t .ds-mono{max-width:150px;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);font-weight:400;}
.dshud-row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-variant-numeric:tabular-nums;}
.dshud-row .k{color:var(--dsw-alias-label-secondary);}
.dshud-row .v{font-weight:500;min-width:0;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;margin-left:12px;}
.dshud-divider{border-top:1px solid var(--dsw-alias-border-l1);margin:8px 0 6px;}
.dshud-btns{display:flex;gap:8px;margin-top:12px;}
.dshud-btn{flex:1;height:28px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;font-size:12px;cursor:pointer;}
.dshud-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}
.dshud-btn-p{flex:1;height:28px;border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff;border-radius:8px;font-size:12px;cursor:pointer;}
.dshud-btn-p:hover{opacity:.88;}
.dshud-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);margin-top:8px;line-height:1.5;}
.dshud-backdrop{position:fixed;inset:0;z-index:2147482999;}
.dshud-limit{position:fixed;z-index:2147483002;width:280px;max-width:calc(100vw - 24px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay,#222));border:1px solid var(--dsw-alias-state-error-primary,#e5484d);border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.3);padding:12px 14px;font-size:12.5px;color:var(--dsw-alias-label-primary);animation:dshud-pop-in .14s ease;}
.dshud-limit .t{display:flex;align-items:center;gap:7px;font-weight:600;font-size:12.5px;color:var(--dsw-alias-state-error-primary,#e5484d);}
.dshud-limit .d{margin-top:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.6;}
.dshud-limit .btns{display:flex;gap:8px;margin-top:10px;align-items:center;}
.dshud-limit .close{margin-left:auto;background:none;border:none;color:var(--dsw-alias-label-tertiary,#999);font-size:14px;cursor:pointer;padding:2px 4px;line-height:1;}
@keyframes dshud-pulse{0%,100%{opacity:1}50%{opacity:.5}}
.dshud-pulse{animation:dshud-pulse 1.2s ease-in-out infinite;}
`)

    // —— Cordis 动态插件面板压缩（类名来自 dsh-client-ui-cordis 构建，前缀稳定） ——
    // 目标：IDE 风格紧凑插件条目。行结构 = [名称+状态] / [描述+版本+操作] / [动作区]
    insertStyle(`
.Nqubda_panel{width:420px;max-width:calc(100vw - 24px);}
.Nqubda_header{min-height:30px!important;padding:5px 12px!important;}
.Nqubda_header .Nqubda_title{font-size:12px!important;line-height:18px!important;font-weight:500!important;}
.Nqubda_body{padding:0 10px 10px!important;}
.Nqubda_group{margin:3px 0 2px!important;font-size:10px!important;line-height:14px!important;color:var(--dsw-alias-label-caption)!important;text-transform:uppercase!important;letter-spacing:.04em!important;}
.Nqubda_rows{gap:6px!important;}
.Nqubda_row{padding:10px 12px!important;gap:6px!important;border-radius:8px!important;border:1px solid var(--dsw-alias-border-l2)!important;position:relative!important;}
.Nqubda_rowHead{gap:6px!important;padding-right:100px!important;}   /* 给右上角版本选择器让位 */
.Nqubda_rowId{display:none!important;}
.Nqubda_rowName{font-size:12.5px!important;font-weight:500!important;line-height:18px!important;flex:1!important;min-width:0!important;}
.Nqubda_rowStatus{height:17px!important;padding:0 6px!important;font-size:10px!important;line-height:17px!important;flex:none!important;border-radius:9px!important;}
.Nqubda_rowDetail{display:flex!important;align-items:center!important;gap:8px!important;min-height:22px!important;flex-wrap:nowrap!important;}
.Nqubda_versionPicker{gap:2px!important;font-size:10px!important;line-height:14px!important;margin:0!important;position:absolute!important;top:10px!important;right:12px!important;}
.Nqubda_versionPicker > span{display:none!important;}   /* 隐藏「版本」文字前缀 */
.Nqubda_versionPicker select{flex:none!important;width:96px!important;height:20px!important;font-size:10px!important;line-height:20px!important;padding:0 4px!important;border-radius:5px!important;border:1px solid var(--dsw-alias-border-l2)!important;color:var(--dsw-alias-label-secondary)!important;background:0 0!important;}
.Nqubda_rowPurpose{font-size:11px!important;line-height:16px!important;color:var(--dsw-alias-label-tertiary,#999)!important;flex:1!important;min-width:0!important;text-overflow:ellipsis!important;overflow:hidden!important;white-space:nowrap!important;}
.Nqubda_rowActions{gap:2px!important;flex:none!important;}
.Nqubda_transition{display:flex!important;align-items:center!important;gap:4px!important;font-size:10px!important;line-height:14px!important;}
.Nqubda_transitionActions{gap:4px!important;margin-left:auto!important;}
.Nqubda_transitionActions button{height:20px!important;padding:0 7px!important;font-size:10px!important;border-radius:999px!important;}
.Nqubda_actionButton{width:22px!important;height:22px!important;}
.Nqubda_actionButton svg{width:13px!important;height:13px!important;}
.Nqubda_rowError{font-size:10px!important;line-height:14px!important;margin-top:2px!important;}
.Nqubda_note{font-size:10px!important;line-height:14px!important;}
.Nqubda_activeVersion{font-size:10px!important;line-height:14px!important;}
`)

    function FloatingWidget() {
      const ds = useDeepSeek()
      // ── 位置状态：一律 left/top 锚定（拖拽/持久化/展开都不改变球的位置） ──
      const [pos, setPos] = React.useState(() => {
        const saved = clampPos((loadPref() || {}).pos)
        if (saved) return saved
        const W = window.innerWidth || 800
        const H = window.innerHeight || 600
        return { x: Math.max(8, W - 120 - 16), y: Math.max(8, H - 46 - 16) }
      })
      // ── 交互状态 ──
      const [expanded, setExpanded] = React.useState(false)   // 详情 Popover 是否展开
      const [dragging, setDragging] = React.useState(false)   // 是否正在拖拽
      const [popPos, setPopPos] = React.useState(null)        // Popover 计算后的 {left, top, dir}
      const [flash, setFlash] = React.useState(null)
      const prevBal = React.useRef(null)
      const rootRef = React.useRef(null)   // HUD 容器（ball）
      const popRef = React.useRef(null)    // Popover 容器
      const showT = React.useRef(null)
      const hideT = React.useRef(null)
      const clickT = React.useRef(null)
      const dragRef = React.useRef(null)

      function clampPos(p) {
        if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null
        const W = window.innerWidth || 800
        const H = window.innerHeight || 600
        return { x: Math.max(8, Math.min(W - 120 - 8, Math.round(p.x))), y: Math.max(8, Math.min(H - 46 - 8, Math.round(p.y))) }
      }

      // 余额变化闪烁
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

      // resize 后校正位置（不越界），并重算 Popover 锚点
      React.useEffect(() => {
        const onResize = () => {
          setPos((p) => {
            if (!p) return p
            const c = clampPos(p)
            if (c.x === p.x && c.y === p.y) return p
            savePref({ pos: c })
            return c
          })
          if (expanded) computePopover()
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [expanded])

      // 一步直达 设置 → DeepSeek（既有逻辑）；tab 可选直达后切到哪个 Tab
      const openConsole = (tab) => {
        setExpanded(false)
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
          if (target) {
            try { target.click() } catch (e) {}
            // 设置面板挂载需要一点时间；高级设置 Tab 定位信号延迟发出
            if (tab === 'advanced') ctx.timeout(() => dsStore.go(), 350)
            return
          }
          if (tries < 20) clickT.current = ctx.timeout(find, 120)
        }
        find()
      }

      // 达到限额 → 发送 go 信号（Dashboard 若已挂载则直接定位，无需打开设置）
      const goSettings = () => { dsStore.go() }

      // ── Popover 定位：以 ball 真实位置为锚点，方向智能选择，永不越界 ──
      const computePopover = () => {
        const el = rootRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const VW = window.innerWidth || 800
        const VH = window.innerHeight || 600
        const PW = 300, PH = 300           // Popover 预估尺寸（用于方向判断）
        const GAP = 10                     // 与 ball 的间距
        const M = 12                       // viewport 安全边距
        // 方向优先级：水平方向看左右空间，垂直方向看上下空间
        const spaceRight = VW - (rect.right + GAP + M)
        const spaceLeft = rect.left - GAP - M
        const spaceDown = VH - (rect.bottom + GAP + M)
        const spaceUp = rect.top - GAP - M
        // 水平优先：哪边空间大选哪边；垂直再判断（放不下就换向）
        let dir, left, top
        const preferRight = rect.left < VW / 2   // ball 在左半边 → 向右展开
        if (preferRight && spaceRight >= 0) { dir = 'right'; left = rect.right + GAP }
        else if (!preferRight && spaceLeft >= 0) { dir = 'left'; left = rect.left - GAP - PW }
        else if (spaceLeft >= 0) { dir = 'left'; left = rect.left - GAP - PW }
        else { dir = 'right'; left = rect.right + GAP }
        // 垂直：优先向上（ball 通常在底部）；顶部空间不足则向下
        if (spaceUp >= 0) { top = rect.top + rect.height / 2 - PH / 2 }
        else if (spaceDown >= 0) { top = rect.top + rect.height / 2 - PH / 2 }
        else { top = rect.top + rect.height / 2 - PH / 2 }
        // 垂直 clamp
        top = Math.max(M, Math.min(VH - PH - M, top))
        // 水平 clamp（方向决定后仍要保证不越界）
        if (dir === 'right') left = Math.max(M, Math.min(VW - PW - M, left))
        else left = Math.max(M, Math.min(VW - PW - M, left))
        // 用实际渲染后尺寸精修一次
        setPopPos({ left, top, dir })
        requestAnimationFrame(() => {
          const pop = popRef.current
          if (!pop) return
          const r = pop.getBoundingClientRect()
          let fx = r.left, fy = r.top
          if (r.right > VW - M) fx = VW - r.width - M
          if (r.left < M) fx = M
          if (r.bottom > VH - M) fy = VH - r.height - M
          if (r.top < M) fy = M
          setPopPos({ left: fx, top: fy, dir })
        })
      }

      // ── Hover：展开 Popover 前先算锚点，ball 隐藏 ──
      const cancelShow = () => { if (showT.current) { showT.current(); showT.current = null } }
      const cancelHide = () => { if (hideT.current) { hideT.current(); hideT.current = null } }
      const onBallEnter = () => {
        if (dragging) return
        cancelHide()
        if (!showT.current) showT.current = ctx.timeout(() => { showT.current = null; setExpanded(true) }, 200)
      }
      const onBallLeave = () => {
        cancelShow()
        cancelHide()
        hideT.current = ctx.timeout(() => { hideT.current = null; setExpanded(false) }, 300)
      }
      // 从 ball 移到 Popover 时取消关闭（同一 hover region）
      const onPopEnter = () => { cancelHide() }
      const onPopLeave = () => {
        cancelShow()
        cancelHide()
        hideT.current = ctx.timeout(() => { hideT.current = null; setExpanded(false) }, 300)
      }
      // 展开后立即计算锚点
      React.useEffect(() => {
        if (expanded) computePopover()
      }, [expanded])

      // ── 拖拽：真实 pointer 事件，ball 是唯一手柄，Popover 不参与 ──
      const onBallPointerDown = (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        e.preventDefault()
        cancelShow()
        cancelHide()
        setExpanded(false)                 // 拖拽立即关闭 Popover
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
          const x = Math.max(12, Math.min(W - w - 12, drag.baseX + dx))
          const y = Math.max(12, Math.min(H - h - 12, drag.baseY + dy))
          setPos({ x, y })
        }
        const onWinEnd = (ev) => {
          if (ev.pointerId !== drag.pointerId) return
          window.removeEventListener('pointermove', onWinMove)
          window.removeEventListener('pointerup', onWinEnd)
          window.removeEventListener('pointercancel', onWinEnd)
          if (dragRef.current === drag) dragRef.current = null
          setDragging(false)
          if (!drag.moved) return          // 点击（<5px）：不打开 Popover，避免误触
          const el = rootRef.current
          const w = el ? el.offsetWidth : 110
          const h = el ? el.offsetHeight : 38
          const dx = ev.clientX - drag.startX
          const dy = ev.clientY - drag.startY
          const rawX = Math.max(12, Math.min(W - w - 12, drag.baseX + dx))
          const rawY = Math.max(12, Math.min(H - h - 12, drag.baseY + dy))
          const snapX = (rawX + w / 2) < W / 2 ? 12 : W - w - 12   // 按中心吸边
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

      const ball = [
        h('span', { className: 'ds-dot ds-dot-' + dot }),
        h('span', { className: 'dshud-name' }, 'DS'),
        h('span', { className: 'dshud-bal' }, balText),
        flash ? h('span', { className: 'dshud-flash ' + (flash.up ? 'up' : 'down') }, (flash.up ? '+' : '') + flash.delta.toFixed(2)) : null
      ]

      const bgt = ds.budget
      const lim = ds.limit
      // 状态语义：enabled=false 完全不限制（不显示）；enabled 才有 剩余/达限 两态
      const limitBadge = lim && lim.enabled
        ? h('span', { className: 'ds-badge ' + (lim.exceeded ? 'err' : 'warn'), style: { marginLeft: 6 } },
            lim.exceeded ? '⛔ 限额已用尽' : '限额剩 ' + fmtMoney(lim.remaining))
        : null
      const budgetBadge = bgt && (bgt.dailyBudget !== null && bgt.dailyBudget !== undefined || bgt.sessionBudget !== null && bgt.sessionBudget !== undefined)
        ? h('span', { className: 'ds-badge ' + (bgt.dailyExceeded || bgt.sessionExceeded ? 'err' : ''), style: { marginLeft: 6 } },
            bgt.dailyExceeded ? '超日预算' : (bgt.sessionExceeded ? '超会话预算' : '预算内'))
        : null
      const panel = h(React.Fragment, null,
        h('div', { className: 't' }, h('span', { className: 'ds-dot ds-dot-' + dot }), h('span', null, 'DeepSeek'), limitBadge, budgetBadge, ds.requesting ? h('span', { className: 'ds-badge warn', style: { marginLeft: 'auto' } }, '生成中') : null),
        h('div', { className: 'dshud-divider' }),
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '账户余额'), h('span', { className: 'v' }, balText)),
        lim && lim.enabled ? h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '今日限额'), h('span', { className: 'v' }, fmtMoney(lim.todayCost) + ' / ' + fmtMoney(lim.dailyLimit) + (lim.blockedCount > 0 ? ' · 拦截 ' + lim.blockedCount + ' 次' : ''))) : null,
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '当前任务'), h('span', { className: 'v' }, t && t.cost !== null && t.cost !== undefined ? fmtMoney(t.cost) : '—')),
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '本次 Token'), h('span', { className: 'v' }, t ? fmtTokens(t.total) : '—')),
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '请求次数'), h('span', { className: 'v' }, t ? t.requests : '—')),
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '模型'), h('span', { className: 'v ds-mono', title: t && t.model ? t.model : '' }, t && t.model ? t.model : '—')),
        h('div', { className: 'dshud-divider' }),
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '今日消费'), h('span', { className: 'v' }, today ? fmtMoney(today.cost) : '—')),
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '今日 Token'), h('span', { className: 'v' }, today ? fmtTokens(today.totalTokens) : '—')),
        h('div', { className: 'dshud-row' }, h('span', { className: 'k' }, '最后同步'), h('span', { className: 'v' }, fmtTime(ds.lastSyncAt))),
        h('div', { className: 'dshud-btns' },
          h('button', { className: 'dshud-btn', onClick: () => dsStore.refresh() }, '刷新'),
          lim && lim.exceeded
            ? h('button', { className: 'dshud-btn-p', onClick: () => openConsole('advanced') }, '前往高级设置')
            : h('button', { className: 'dshud-btn-p', onClick: () => openConsole() }, '打开控制台 →')))

      const rootStyle = { left: pos.x, top: pos.y }
      // 达限横幅：锚定 ball 上方；可手动关闭，但 exceeded 状态翻转（重新触发/恢复）会再出现
      const limitDismissedRef = React.useRef(false)
      const [limitShown, setLimitShown] = React.useState(false)
      const exceededNow = !!(lim && lim.exceeded)
      React.useEffect(() => {
        if (exceededNow) {
          if (!limitDismissedRef.current) setLimitShown(true)
        } else {
          limitDismissedRef.current = false // 状态恢复后重置，下次达限重新弹出
          setLimitShown(false)
        }
      }, [exceededNow])
      const limitBanner = limitShown && lim ? h('div', { className: 'dshud-limit', style: { left: Math.max(8, Math.min((window.innerWidth || 800) - 296, pos.x - 80)), top: Math.max(8, pos.y - 132) } },
        h('div', { className: 't' }, '⛔ 今日 DeepSeek 消费已达到 ' + fmtMoney(lim.dailyLimit) + ' 限额'),
        h('div', { className: 'd' }, '已消费 ' + fmtMoney(lim.todayCost) + '。可调整每日限额或关闭硬限制后继续使用。'),
        h('div', { className: 'btns' },
          h('button', { className: 'dshud-btn-p', onClick: () => openConsole('advanced') }, '前往高级设置'),
          h('button', { className: 'close', title: '关闭提示', onClick: () => { limitDismissedRef.current = true; setLimitShown(false) } }, '×'))) : null

      return h(React.Fragment, null,
        // 容器：唯一拖拽手柄；展开时隐藏 ball（保留占位避免跳动）
        h('div', {
          className: 'dshud ' + (dragging ? 'dragging' : 'snap') + (expanded ? ' hidden-ball' : ''),
          style: rootStyle, ref: rootRef,
          onMouseEnter: onBallEnter, onMouseLeave: onBallLeave
        },
          h('div', { className: 'dshud-ball', onPointerDown: onBallPointerDown }, ball)),
        // Popover：独立 fixed 层，锚定 ball 位置；与 ball 同属一个 hover region
        expanded && popPos ? h('div', {
          className: 'dshud-pop', style: { left: popPos.left, top: popPos.top },
          ref: popRef, onMouseEnter: onPopEnter, onMouseLeave: onPopLeave
        }, panel) : null,
        limitBanner)
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
