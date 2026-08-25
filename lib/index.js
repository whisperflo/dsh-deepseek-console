// ============================================================================
// DeepSeek 账户控制台 —— Host 半（在 DSH 宿主进程内运行）
// ----------------------------------------------------------------------------
// 职责：
//  1. DeepSeekClient：统一通过 subprocess+curl 访问 DeepSeek 官方 API，
//     支持超时、指数退避重试（1s/2s/4s，最多 3 次）、401/403 不重试、429/5xx
//     重试、错误分类、日志脱敏（绝不打印完整 API Key）。
//  2. 余额服务：官方 GET /user/balance（total_balance / granted_balance /
//     topped_up_balance），带 5s 默认缓存、强制刷新、余额变化检测与历史记录。
//  3. 用量统计：监听 llm/stream 瀑布事件，统计每次模型调用的 token 与耗时，
//     汇总到每日流水，估算费用（价格来自可配置 pricing 表）。
//  4. 持久化：~/.dsh/storages/deepseek-console.json（storage 的 json 后端，
//     无需 zod schema），进程重启后历史仍可恢复。
//  5. HTTP 路由（webServer /api/deepseek/*，页面同源 fetch；POST 有 CSRF 校验）
//     + 一个只读动态工具 deepseek_usage_report。
//  6. 余额监控：页面活跃期间（90s 内有 /api/deepseek/* 请求）按 pollIntervalSec 后台同步。
// ----------------------------------------------------------------------------
// 安全：API Key 只经 credentials 服务读取（DEEPSEEK_API_KEY 凭证），
// 永不写入前端、日志只输出 sk-****末4位。
// ============================================================================

module.exports = {
  name: 'deepseek-console',
  inject: ['timer', 'tools', 'webServer'],
  apply(ctx) {
    const fs = require('node:fs')
    const path = require('node:path')
    const os = require('node:os')
    const PLUGIN_NAME = '@hzjjxc/dsh-deepseek-console'
    let LOCAL_PACKAGE = { name: PLUGIN_NAME, version: '0.0.0' }
    try { LOCAL_PACKAGE = require('../package.json') } catch (e) {}
    const LOCAL_VERSION = String(LOCAL_PACKAGE.version || '0.0.0')

    // ─────────────────────────── 状态与工具函数 ───────────────────────────
    const STATE = { config: null, lastGood: null, lastAttempt: null, history: [], calls: [], daily: {} }
    const MAX_HISTORY = 500
    const MAX_CALLS = 300
    const MAX_DAILY_DAYS = 400   // daily 按 YYYY-MM-DD 键只增不减，定期裁剪避免落盘无限膨胀
    // 保留最近 keepDays 天的 daily 记录（按 key 字符串排序即可，YYYY-MM-DD 可字典序比较）
    const pruneDaily = () => {
      const keys = Object.keys(STATE.daily)
      if (keys.length <= MAX_DAILY_DAYS) return
      for (const k of keys.sort().slice(0, keys.length - MAX_DAILY_DAYS)) delete STATE.daily[k]
    }
    let saveTimer = null
    let saveChain = Promise.resolve()
    let unit = null
    let refreshing = false
    // 页面活跃信号：最后一次 /api/deepseek/* 请求时间。余额监控只在页面打开期间
    // （90s 内有请求）后台轮询，关页即停。HUD 2s 轮询会持续刷新此值。
    let lastSeen = Date.now()

    // ─────────────────────────── 插件更新 ───────────────────────────
    // 版本检查只访问 npm 元数据与包内 CHANGELOG，不把更新请求放到浏览器，
    // 也不把任何用户凭证发送出去。检查结果在进程内缓存，默认每 6 小时刷新一次。
    const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000
    const UPDATE_REGISTRY_URL = 'https://registry.npmjs.org/@hzjjxc%2Fdsh-deepseek-console/latest'
    const UPDATE_CHANGELOG_URL = 'https://unpkg.com/@hzjjxc/dsh-deepseek-console@latest/CHANGELOG.md'
    const changelogUrlFor = (version) => `https://unpkg.com/@hzjjxc/dsh-deepseek-console@${encodeURIComponent(version)}/CHANGELOG.md`
    const githubChangelogUrlFor = (version) => `https://raw.githubusercontent.com/whisperflo/dsh-deepseek-console/v${encodeURIComponent(version)}/CHANGELOG.md`
    const updateState = { checkedAt: 0, data: null, checking: null, installing: false }

    const versionParts = (v) => {
      const clean = String(v || '').trim().replace(/^v/i, '').split('+')[0]
      const m = clean.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/)
      if (!m) return null
      return { nums: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)], pre: m[4] ? m[4].split('.') : [] }
    }
    const compareVersions = (a, b) => {
      const aa = versionParts(a); const bb = versionParts(b)
      if (!aa || !bb) return 0
      for (let i = 0; i < 3; i++) if (aa.nums[i] !== bb.nums[i]) return aa.nums[i] > bb.nums[i] ? 1 : -1
      if (!aa.pre.length && bb.pre.length) return 1
      if (aa.pre.length && !bb.pre.length) return -1
      for (let i = 0; i < Math.max(aa.pre.length, bb.pre.length); i++) {
        if (aa.pre[i] === undefined) return -1
        if (bb.pre[i] === undefined) return 1
        if (aa.pre[i] === bb.pre[i]) continue
        const an = /^\d+$/.test(aa.pre[i]); const bn = /^\d+$/.test(bb.pre[i])
        if (an && bn) return Number(aa.pre[i]) > Number(bb.pre[i]) ? 1 : -1
        if (an !== bn) return an ? -1 : 1
        return aa.pre[i] > bb.pre[i] ? 1 : -1
      }
      return 0
    }
    const parseChangelog = (text) => {
      const sections = []; let current = null
      for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim()
        const heading = line.match(/^##\s+\[?([^\]\s]+)\]?(?:\s+-\s+(.+))?$/)
        if (heading && versionParts(heading[1])) {
          current = { version: heading[1], date: heading[2] || null, notes: [] }
          sections.push(current)
          continue
        }
        if (current && line) {
          const note = line.replace(/^[-*+]\s+/, '').replace(/^###\s+/, '')
          if (note && !/^<!--/.test(note)) current.notes.push(note)
        }
      }
      return sections.map((s) => Object.assign({}, s, { notes: s.notes.slice(0, 30) }))
    }
    const profileDir = () => path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'web')
    const installationMode = () => {
      try {
        const packagePath = path.join(profileDir(), 'package.json')
        const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
        const spec = manifest.dependencies && manifest.dependencies[PLUGIN_NAME]
        if (typeof spec === 'string' && /^(?:link|file):/i.test(spec)) return 'link'
        if (spec) return 'package'
      } catch (e) {}
      return 'unknown'
    }
    const installedVersion = () => {
      try {
        const packagePath = require.resolve(PLUGIN_NAME + '/package.json')
        return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version || null
      } catch (e) { return null }
    }
    const updateSnapshot = (extra) => Object.assign({
      status: 'idle', currentVersion: LOCAL_VERSION, installedVersion: installedVersion(),
      latestVersion: null, available: false, checkedAt: updateState.checkedAt || null,
      installation: installationMode(), restartRequired: false, release: null,
      changelogUrl: UPDATE_CHANGELOG_URL
    }, extra || {})

    // ─────────────────────────── 任务级统计状态 ───────────────────────────
    // “当前任务”= 一次 agent 运行周期（agent/status：idle→running 开始，running→idle 结束）。
    // 该周期内所有 DeepSeek 模型调用累计为一个任务（含子代理并发调用）。
    let activeCount = 0        // 正在运行的 agent 数量
    let streamingCount = 0     // 正在流式生成的模型调用数量
    let taskSeq = 0
    let currentTask = null
    const newTask = () => ({ id: 'task-' + (++taskSeq) + '-' + Date.now(), status: 'running', model: null, provider: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, requests: 0, startTs: Date.now(), endTs: null, lastCallAt: null })
    const startTask = () => { currentTask = newTask() }
    const finishTask = () => { if (currentTask && currentTask.status === 'running') { currentTask.status = 'done'; currentTask.endTs = Date.now() } }
    ctx.on('agent/status', (payload) => {
      const s = payload && payload.status
      if (s === 'running') {
        if (activeCount === 0) startTask()
        activeCount += 1
      } else if (s === 'idle') {
        activeCount = Math.max(0, activeCount - 1)
        if (activeCount === 0) finishTask()
      }
    })

    const isoNow = () => new Date().toISOString()
    // ── 请求来源推断：不重构业务代码，从 options 现有字段尽量识别 ──
    // agent 运行期内的调用 = agent；空闲期按场景分 internal（标题/摘要类）/ chat；识别不出 = unknown
    let downgradeCount = 0   // 成本保护累计降级次数（进程级，诊断用途）
    const inferSource = (options) => {
      try {
        if (activeCount > 0) return 'agent'
        const o = options || {}
        if (typeof o.source === 'string' && o.source) return o.source
        if (o.internal === true || o.background === true) return 'internal'
        const s = String(o.purpose || o.kind || '')
        if (/title|summar|embed/i.test(s)) return 'internal'
        return 'chat'
      } catch (e) { return 'unknown' }
    }
    const dkey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
    const nOr = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? (lo === undefined ? n : clamp(n, lo, hi)) : d }
    const r2 = (n) => Math.round(n * 100) / 100
    const maskKey = (k) => (typeof k === 'string' && k.length > 8) ? `${k.slice(0, 3)}****${k.slice(-4)}` : (k ? '已配置' : '')

    // ─────────────────────────── 默认配置 ───────────────────────────
    // 价格默认值：DeepSeek 官方 2026-08-17 调价后的高峰价（元/百万 tokens），
    // 空闲时段 = 高峰 × 0.5。来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
    const DEFAULTS = {
      pollIntervalSec: 15,
      cacheTtlSec: 5,
      timeoutSec: 10,
      baseURL: 'https://api.deepseek.com',
      priceTier: 'peak', // peak | off | avg
      dailyBudget: null,   // 每日费用预算（元），超出后告警
      sessionBudget: null, // 单次会话费用预算（元），超出后告警
      dailyLimit: null,    // 每日消费限额金额（元）。是否生效由 hardLimitEnabled 决定；关闭时保留金额不删
      hardLimitEnabled: false, // 每日消费硬限制总开关：false = 完全不限制（旧配置缺字段时的默认）
      // ── 余额预警（账户还剩多少钱；与预算告警"今天花了多少"分开）──
      balanceWarningEnabled: false,
      balanceWarningThreshold: 20, // 元
      // ── 成本保护：达到限额百分比后自动降级到低成本模型 ──
      costProtectionEnabled: false,
      costProtectionThreshold: 80,  // %（相对每日硬限额 dailyLimit）
      fallbackModel: 'deepseek-v4-flash',
      // ── 请求保护（本期仅存储配置+展示，并发/限速执行待后续接入发送层）──
      requestProtectionEnabled: false,
      maxConcurrentRequests: 3,
      maxRequestsPerMinute: 60,
      // ── 模型本地启用控制（键=模型名，值=true 表示已禁用；仅本地，不动官方账户）──
      disabledModels: {},
      pricing: {
        'deepseek-v4-flash': { cacheHitIn: 0.10, cacheMissIn: 3.0, out: 9.0, contextWindow: 1048576 },
        'deepseek-v4-pro':   { cacheHitIn: 0.30, cacheMissIn: 9.0, out: 27.0, contextWindow: 1048576 },
        'deepseek-chat':     { cacheHitIn: 0.10, cacheMissIn: 3.0, out: 9.0, contextWindow: 131072 },
        'deepseek-reasoner': { cacheHitIn: 0.30, cacheMissIn: 9.0, out: 27.0, contextWindow: 131072 }
      }
    }
    const cfg = () => {
      const c = STATE.config || {}
      const pricing = (c.pricing && typeof c.pricing === 'object') ? c.pricing : DEFAULTS.pricing
      return {
        pollIntervalSec: nOr(c.pollIntervalSec, 15, 5, 300),
        cacheTtlSec: nOr(c.cacheTtlSec, 5, 0, 60),
        timeoutSec: nOr(c.timeoutSec, 10, 3, 60),
        baseURL: (typeof c.baseURL === 'string' && c.baseURL) ? c.baseURL : 'https://api.deepseek.com',
        priceTier: (c.priceTier === 'off' || c.priceTier === 'avg') ? c.priceTier : 'peak',
        dailyBudget: (c.dailyBudget === null || c.dailyBudget === undefined || c.dailyBudget === '') ? null : Math.max(0, Number(c.dailyBudget)),
        sessionBudget: (c.sessionBudget === null || c.sessionBudget === undefined || c.sessionBudget === '') ? null : Math.max(0, Number(c.sessionBudget)),
        dailyLimit: (c.dailyLimit === null || c.dailyLimit === undefined || c.dailyLimit === '') ? null : Math.max(0, Number(c.dailyLimit)),
        // 旧配置兼容：无 hardLimitEnabled 字段时，设过 dailyLimit 的视为开启（沿用旧行为），否则关闭
        hardLimitEnabled: (c.hardLimitEnabled === undefined) ? (c.dailyLimit !== null && c.dailyLimit !== undefined && c.dailyLimit !== '') : !!c.hardLimitEnabled,
        balanceWarningEnabled: c.balanceWarningEnabled === undefined ? false : !!c.balanceWarningEnabled,
        balanceWarningThreshold: nOr(c.balanceWarningThreshold, 20, 0.01, 1e6),
        costProtectionEnabled: c.costProtectionEnabled === undefined ? false : !!c.costProtectionEnabled,
        costProtectionThreshold: nOr(c.costProtectionThreshold, 80, 1, 100),
        fallbackModel: (typeof c.fallbackModel === 'string' && c.fallbackModel) ? c.fallbackModel : 'deepseek-v4-flash',
        requestProtectionEnabled: c.requestProtectionEnabled === undefined ? false : !!c.requestProtectionEnabled,
        maxConcurrentRequests: nOr(c.maxConcurrentRequests, 3, 1, 32),
        maxRequestsPerMinute: nOr(c.maxRequestsPerMinute, 60, 1, 6000),
        disabledModels: (c.disabledModels && typeof c.disabledModels === 'object' && !Array.isArray(c.disabledModels)) ? c.disabledModels : {},
        pricing
      }
    }
    const tierFactor = () => { const t = cfg().priceTier; return t === 'off' ? 0.5 : t === 'avg' ? 0.75 : 1 }
    // 预估费用（元）。价格未配置的模型返回 null（表示"官方未定价/未配置，不计费"）。
    const estimateCost = (model, input, output, cacheRead) => {
      const pr = cfg().pricing[model]
      if (!pr) return null
      const miss = Math.max(0, input - (cacheRead || 0))
      return r2((((cacheRead || 0) * pr.cacheHitIn + miss * pr.cacheMissIn + output * pr.out) * tierFactor()) / 1e6)
    }

    // ─────────────────────────── 统一请求日志（SQLite 优先，内存降级） ───────────────────────────
    // 所有 DeepSeek 请求统计的唯一事实源：llm/stream record() 写入，
    // 趋势/模型/来源/明细/健康等全部聚合查询都从这里读，不另建数据集。
    // node:sqlite (Node 22.5+) DatabaseSync 同步 API：写入量小（每次调用 1 行），
    // 异步落盘由 scheduleSave 之外的独立节流控制。
    const classifyErrorType = (code, message) => {
      const m = String(message || '')
      if (code === 4292) return 'hard_limit'           // 本地业务拦截，非 API 失败
      if (code === 1002) return 'auth_error'
      if (code === 1004 || /429|rate.?limit|限流/i.test(m)) return 'rate_limit'
      if (code === 1006 || /timeout|超时/i.test(m)) return 'timeout'
      if (code === 1005 || /network|网络|curl exit/i.test(m)) return 'network_error'
      if (code === 1003 || /5\d\d|服务端|server/i.test(m)) return 'server_error'
      if (code === 4293) return 'model_unavailable'
      return 'unknown'
    }
    const RequestLog = (() => {
      let db = null
      let mem = null // 降级：内存数组（SQLite 不可用时）
      let writeCount = 0
      const init = () => {
        try {
          const { DatabaseSync } = require('node:sqlite')
          const path = require('node:path')
          const os = require('node:os')
          const dir = path.join(os.homedir(), '.dsh', 'storages')
          try { require('node:fs').mkdirSync(dir, { recursive: true }) } catch (e) {}
          db = new DatabaseSync(path.join(dir, 'deepseek_requests.db'))
          db.exec(`
            CREATE TABLE IF NOT EXISTS deepseek_requests (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts INTEGER NOT NULL, date TEXT NOT NULL, hour INTEGER NOT NULL,
              model TEXT NOT NULL, source TEXT NOT NULL,
              input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
              cache_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0,
              cost REAL DEFAULT 0, latency INTEGER DEFAULT 0,
              status TEXT NOT NULL, http_status INTEGER, error_type TEXT, error_message TEXT,
              downgraded_from TEXT, task_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_req_date ON deepseek_requests(date);
            CREATE INDEX IF NOT EXISTS idx_req_ts ON deepseek_requests(ts);
            CREATE INDEX IF NOT EXISTS idx_req_model_date ON deepseek_requests(model, date);
            CREATE INDEX IF NOT EXISTS idx_req_source_date ON deepseek_requests(source, date);
            CREATE INDEX IF NOT EXISTS idx_req_status_ts ON deepseek_requests(status, ts);
          `)
          return true
        } catch (e) {
          console.warn('deepseek-console: node:sqlite 不可用，请求日志降级为内存模式（重启丢失）:', e && e.message)
          db = null
          mem = []
          return false
        }
      }
      const push = (r) => {
        // r: { ts, model, source, input, output, cacheRead, total, cost, latencyMs, status, httpStatus, errorType, errorMessage, downgradedFrom, taskId }
        const d = new Date(r.ts)
        const date = dkey(d)
        const hour = d.getHours()
        if (db) {
          try {
            db.prepare('INSERT INTO deepseek_requests (ts,date,hour,model,source,input_tokens,output_tokens,cache_tokens,total_tokens,cost,latency,status,http_status,error_type,error_message,downgraded_from,task_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
              .run(r.ts, date, hour, r.model || 'unknown', r.source || 'unknown', r.input || 0, r.output || 0, r.cacheRead || 0, r.total || 0, r.cost == null ? 0 : r.cost, r.latencyMs == null ? 0 : Math.round(r.latencyMs), r.status || 'success', r.httpStatus == null ? null : r.httpStatus, r.errorType || null, r.errorMessage ? String(r.errorMessage).slice(0, 300) : null, r.downgradedFrom || null, r.taskId || null)
            writeCount += 1
            // 轻量保留策略：每 500 次写入清一次 90 天前的旧记录
            if (writeCount % 500 === 0) { try { db.exec(`DELETE FROM deepseek_requests WHERE ts < ${Date.now() - 90 * 86400 * 1000}`) } catch (e) {} }
            return
          } catch (e) { console.warn('deepseek-console: 请求日志写入失败', e && e.message) }
        }
        mem.push(Object.assign({ date, hour }, r))
        if (mem.length > 2000) mem.splice(0, mem.length - 2000)
      }
      const rangeDates = (range) => {
        const out = []
        const now = new Date()
        if (range === 'today') { out.push(dkey(now)); return out }
        const n = range === '30d' ? 30 : 7
        for (let i = n - 1; i >= 0; i--) { const d = new Date(now); d.setDate(now.getDate() - i); out.push(dkey(d)) }
        return out
      }
      const query = ({ status, model, source, range, limit, offset }) => {
        // 统一 WHERE 构造（date IN (...) 天级过滤；今天额外按 ts 截断到零点）
        const dates = rangeDates(range || '7d')
        const where = [`date IN (${dates.map(() => '?').join(',')})`]
        const args = dates.slice()
        if (status && status !== 'all') { where.push('status = ?'); args.push(status) }
        if (model && model !== 'all') { where.push('model = ?'); args.push(model) }
        if (source && source !== 'all') { where.push('source = ?'); args.push(source) }
        const w = where.join(' AND ')
        if (db) {
          try {
            const lim = Math.min(Number(limit) || 50, 500)
            const off = Math.max(0, Number(offset) || 0)
            const rows = db.prepare(`SELECT * FROM deepseek_requests WHERE ${w} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...args, lim, off)
            const total = db.prepare(`SELECT COUNT(*) AS c FROM deepseek_requests WHERE ${w}`).get(...args).c
            return { rows, total, mode: 'sqlite' }
          } catch (e) { return { rows: [], total: 0, mode: 'sqlite-error' } }
        }
        // 内存降级：全量过滤
        let rows = mem.filter((r) => dates.includes(r.date))
        if (status && status !== 'all') rows = rows.filter((r) => r.status === status)
        if (model && model !== 'all') rows = rows.filter((r) => r.model === model)
        if (source && source !== 'all') rows = rows.filter((r) => r.source === source)
        rows.sort((a, b) => b.ts - a.ts)
        const total = rows.length
        const lim = Math.min(Number(limit) || 50, 500)
        const off = Math.max(0, Number(offset) || 0)
        return { rows: rows.slice(off, off + lim).map((r) => ({ ...r, latency: r.latencyMs })), total, mode: 'memory' }
      }
      const trend = (range) => {
        const dates = rangeDates(range)
        if (range === 'today') {
          // 24 小时桶
          if (db) {
            try {
              const rows = db.prepare(`SELECT hour, SUM(cost) AS cost, SUM(total_tokens) AS tokens, COUNT(*) AS n FROM deepseek_requests WHERE date = ? GROUP BY hour`).all(dates[0])
              return { range, buckets: rows.map((r) => ({ key: String(r.hour).padStart(2, '0') + ':00', cost: r2(r.cost || 0), tokens: r.tokens || 0, requests: r.n || 0 })), mode: 'sqlite' }
            } catch (e) { return { range, buckets: [], mode: 'sqlite-error' } }
          }
          const byHour = {}
          for (const r of mem.filter((x) => x.date === dates[0])) {
            const k = String(r.hour).padStart(2, '0') + ':00'
            byHour[k] = byHour[k] || { key: k, cost: 0, tokens: 0, requests: 0 }
            byHour[k].cost = r2(byHour[k].cost + (r.cost || 0)); byHour[k].tokens += r.total || 0; byHour[k].requests += 1
          }
          return { range, buckets: Object.values(byHour), mode: mem ? 'memory' : 'none' }
        }
        if (db) {
          try {
            const rows = db.prepare(`SELECT date, SUM(cost) AS cost, SUM(total_tokens) AS tokens, COUNT(*) AS n FROM deepseek_requests WHERE date IN (${dates.map(() => '?').join(',')}) GROUP BY date`).all(...dates)
            const map = new Map(rows.map((r) => [r.date, r]))
            return { range, buckets: dates.map((d) => ({ key: d, cost: r2((map.get(d) || {}).cost || 0), tokens: (map.get(d) || {}).tokens || 0, requests: (map.get(d) || {}).n || 0 })), mode: 'sqlite' }
          } catch (e) { return { range, buckets: [], mode: 'sqlite-error' } }
        }
        const byDate = {}
        for (const r of mem) { if (dates.includes(r.date)) { byDate[r.date] = byDate[r.date] || { key: r.date, cost: 0, tokens: 0, requests: 0 }; byDate[r.date].cost = r2(byDate[r.date].cost + (r.cost || 0)); byDate[r.date].tokens += r.total || 0; byDate[r.date].requests += 1 } }
        return { range, buckets: dates.map((d) => byDate[d] || { key: d, cost: 0, tokens: 0, requests: 0 }), mode: 'memory' }
      }
      const groupBy = (dimension, range) => {
        const dates = rangeDates(range)
        const dl = dates.map(() => '?').join(',')
        if (db) {
          try {
            const col = dimension === 'model' ? 'model' : 'source'
            const rows = db.prepare(`SELECT ${col} AS k, SUM(cost) AS cost, SUM(total_tokens) AS tokens, COUNT(*) AS requests, AVG(latency) AS avgLatency, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS ok FROM deepseek_requests WHERE date IN (${dl}) GROUP BY ${col} ORDER BY cost DESC`).all(...dates)
            return rows.map((r) => ({ key: r.k, cost: r2(r.cost || 0), tokens: r.tokens || 0, requests: r.requests || 0, avgLatencyMs: r.avgLatency ? Math.round(r.avgLatency) : null, ok: r.ok || 0, failed: (r.requests || 0) - (r.ok || 0) }))
          } catch (e) { return [] }
        }
        const agg = {}
        for (const r of mem.filter((x) => dates.includes(x.date))) {
          const k = dimension === 'model' ? r.model : r.source
          agg[k] = agg[k] || { key: k, cost: 0, tokens: 0, requests: 0, latencySum: 0, ok: 0 }
          const a = agg[k]
          a.cost = r2(a.cost + (r.cost || 0)); a.tokens += r.total || 0; a.requests += 1; a.latencySum += r.latencyMs || 0
          if (r.status === 'success') a.ok += 1
        }
        return Object.values(agg).map((a) => ({ key: a.key, cost: a.cost, tokens: a.tokens, requests: a.requests, avgLatencyMs: a.requests ? Math.round(a.latencySum / a.requests) : null, ok: a.ok, failed: a.requests - a.ok })).sort((x, y) => y.cost - x.cost)
      }
      // 最近 24h 健康/错误统计
      const health24 = () => {
        const since = Date.now() - 86400 * 1000
        if (db) {
          try {
            const total = db.prepare('SELECT COUNT(*) AS c FROM deepseek_requests WHERE ts >= ?').get(since).c
            const ok = db.prepare("SELECT COUNT(*) AS c FROM deepseek_requests WHERE ts >= ? AND status = 'success'").get(since).c
            const errs = db.prepare("SELECT error_type, COUNT(*) AS n FROM deepseek_requests WHERE ts >= ? AND status != 'success' AND error_type != 'hard_limit' GROUP BY error_type ORDER BY n DESC").all(since)
            const blocked = db.prepare("SELECT COUNT(*) AS c FROM deepseek_requests WHERE ts >= ? AND error_type = 'hard_limit'").get(since).c
            const p95 = db.prepare("SELECT latency FROM deepseek_requests WHERE ts >= ? AND status='success' ORDER BY latency DESC").all(since)
            const lat = p95.map((r) => r.latency)
            return { total, ok, failed: total - ok, blocked, errors: errs, avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null, p95LatencyMs: lat.length ? lat[Math.floor(lat.length * 0.05)] : null }
          } catch (e) { return { total: 0, ok: 0, failed: 0, blocked: 0, errors: [], avgLatencyMs: null, p95LatencyMs: null } }
        }
        const rows = mem.filter((r) => r.ts >= since)
        const ok = rows.filter((r) => r.status === 'success')
        const errAgg = {}
        for (const r of rows.filter((x) => x.status !== 'success' && x.errorType !== 'hard_limit')) errAgg[r.errorType || 'unknown'] = (errAgg[r.errorType || 'unknown'] || 0) + 1
        const lat = ok.map((r) => r.latencyMs || 0)
        return { total: rows.length, ok: ok.length, failed: rows.length - ok.length, blocked: rows.filter((r) => r.errorType === 'hard_limit').length, errors: Object.entries(errAgg).map(([type, n]) => ({ error_type: type, n })), avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null, p95LatencyMs: null }
      }
      const lastError = () => {
        if (db) { try { return db.prepare("SELECT * FROM deepseek_requests WHERE status != 'success' AND error_type != 'hard_limit' ORDER BY ts DESC LIMIT 1").get() || null } catch (e) { return null } }
        const rows = mem.filter((r) => r.status !== 'success' && r.errorType !== 'hard_limit')
        return rows.length ? rows[rows.length - 1] : null
      }
      const info = () => ({ mode: db ? 'sqlite' : (mem ? 'memory' : 'none'), file: db ? '~/.dsh/storages/deepseek_requests.db' : null })
      init()
      return { push, query, trend, groupBy, health24, lastError, info }
    })()


    // 单元名必须匹配 /^[a-z][a-z0-9_]*$/（仅小写字母数字下划线，不能用连字符）
    const persistNow = () => {
      if (!unit) return Promise.resolve()
      const payload = { v: 1, config: STATE.config, lastGood: STATE.lastGood, lastAttempt: STATE.lastAttempt, history: STATE.history, calls: STATE.calls, daily: STATE.daily }
      const run = saveChain.then(() => unit.putRecord('state', 'main', payload).catch((e) => console.error('deepseek-console: 保存失败', e && e.message)))
      saveChain = run.catch(() => {})
      return run
    }
    const scheduleSave = () => {
      if (saveTimer) return
      saveTimer = ctx.timeout(() => { saveTimer = null; persistNow() }, 800)
    }
    const openStore = async () => {
      try {
        const storage = ctx.get('storage')
        const backend = storage && storage.backend && storage.backend.get('json')
        if (!backend || !backend.kv) {
          console.error('deepseek-console: storage 服务不可用，持久化关闭（内存模式）')
          return
        }
        unit = await backend.kv.open({ name: 'deepseek_console', version: 1, tables: ['state'], hasGlobal: false })
        const all = await unit.loadAll()
        const rec = (all.tables && all.tables.state && all.tables.state.main) || null
        if (rec && typeof rec === 'object') {
          if (rec.config) STATE.config = rec.config
          if (rec.lastGood) STATE.lastGood = rec.lastGood
          if (rec.lastAttempt) STATE.lastAttempt = rec.lastAttempt
          if (Array.isArray(rec.history)) STATE.history = rec.history
          if (Array.isArray(rec.calls)) STATE.calls = rec.calls
          if (rec.daily && typeof rec.daily === 'object') { STATE.daily = rec.daily; pruneDaily() }
        }
        console.log('deepseek-console: 持久化已启用（~/.dsh/storages/deepseek_console.json）')
      } catch (e) {
        console.error('deepseek-console: 持久化不可用，降级为内存模式', e && e.message)
        unit = null
      }
    }

    // ─────────────────────────── 凭据 / 基础 URL ───────────────────────────
    // 与 llm-deepseek 适配器同一把钥匙：credentials 服务里的 DEEPSEEK_API_KEY 凭证
    // （环境变量 > ~/.dsh/.credentials.yaml > .env）。每次请求重新解析，改 Key 即时生效。
    const resolveKey = async () => {
      const creds = ctx.get('credentials')
      if (!creds) return undefined
      try {
        const r = await creds.resolve('DEEPSEEK_API_KEY')
        return r ? r.value : undefined
      } catch { return undefined }
    }
    // keyFacts 带 10s 进程内缓存：HUD 每 2s 轮询一次，不必每次都打 credentials 服务
    // （大概率是文件访问）。saveKey 成功后主动失效，保证配置状态即时反映。
    let keyFactsCache = { at: 0, value: null }
    const keyFacts = async () => {
      if (keyFactsCache.value && Date.now() - keyFactsCache.at < 10000) return keyFactsCache.value
      const creds = ctx.get('credentials')
      if (!creds) return { configured: false, source: null, writable: false }
      try {
        const info = await creds.describe('DEEPSEEK_API_KEY')
        keyFactsCache = { at: Date.now(), value: { configured: !!info.configured, source: info.source || null, writable: !!info.writable } }
        return keyFactsCache.value
      } catch { return { configured: false, source: null, writable: false } }
    }
    const resolveBaseURL = async () => {
      try {
        const settings = ctx.get('settings')
        const ns = settings && settings.get('llm-deepseek')
        if (ns && typeof ns.baseURL === 'string' && ns.baseURL) return ns.baseURL
      } catch {}
      return cfg().baseURL
    }

    // ─────────────────────────── DeepSeekClient（HTTP 层） ───────────────────────────
    // 宿主动态沙箱禁用了全局 fetch，统一走 subprocess + curl：
    //   - 超时：--connect-timeout 5 + -m <timeoutSec>
    //   - 输出：-w 追加状态码标记，正文按标记切分
    const curlOnce = async ({ method, url, headers, body, timeoutSec, label }) => {
      const subprocess = ctx.get('subprocess')
      const subject = label || 'DeepSeek API'
      if (!subprocess) throw { code: 1005, message: '子进程服务不可用，无法访问 ' + subject }
      const sp = ctx.get('sandboxPolicy')
      const cwd = (sp && sp.workspaceRoot) || '/'
      const argv = ['curl', '-sS', '--connect-timeout', '5', '-m', String(timeoutSec || 10), '-X', method || 'GET', '-w', '\n__DSHTTP__%{http_code}']
      for (const k of Object.keys(headers || {})) argv.push('-H', `${k}: ${headers[k]}`)
      if (body) argv.push('--data-binary', body)
      argv.push(url)
      const handle = subprocess.spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4 * 1024 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
        graceMs: 5000
      })
      const outcome = await handle.done
      const outText = (handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : '') || ''
      const errText = (handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : '') || ''
      if (outcome.exitCode !== 0) {
        if (outcome.exitCode === 28) throw { code: 1006, message: `${subject} 请求超时（${timeoutSec}s）` }
        throw { code: 1005, message: `${subject} 网络错误（curl exit ${outcome.exitCode}）${errText ? ' · ' + errText.slice(0, 120) : ''}` }
      }
      const marker = '\n__DSHTTP__'
      const idx = outText.lastIndexOf(marker)
      const text = idx >= 0 ? outText.slice(0, idx) : outText
      const status = idx >= 0 ? (parseInt(outText.slice(idx + marker.length).trim(), 10) || 0) : 200
      return { status, text }
    }

    const checkForUpdates = async (force = false) => {
      if (!force && updateState.data && Date.now() - updateState.checkedAt < UPDATE_CHECK_MS) return updateState.data
      if (updateState.checking) return updateState.checking
      updateState.checking = (async () => {
        try {
          const response = await curlOnce({
            method: 'GET', url: UPDATE_REGISTRY_URL,
            headers: { accept: 'application/json' }, timeoutSec: 8, label: 'npm 更新服务'
          })
          if (response.status < 200 || response.status >= 300) throw { code: 1005, message: `npm 更新服务返回 HTTP ${response.status}` }
          const latest = JSON.parse(response.text || '{}')
          const latestVersion = String(latest.version || '')
          if (!versionParts(latestVersion)) throw { code: 1005, message: 'npm 更新服务返回了无效版本号' }

          let releases = []
          // 优先读取“目标版本”自己的日志，避免 @latest 缓存或 CDN 更新延迟导致
          // 找不到对应版本；GitHub raw 作为 npm CDN 的备用来源。
          const changelogUrls = [changelogUrlFor(latestVersion), githubChangelogUrlFor(latestVersion), UPDATE_CHANGELOG_URL]
          for (const url of changelogUrls) {
            try {
              const changelog = await curlOnce({
                method: 'GET', url,
                headers: { accept: 'text/plain' }, timeoutSec: 8, label: '更新日志服务'
              })
              if (changelog.status >= 200 && changelog.status < 300) {
                releases = parseChangelog(changelog.text)
                if (releases.some((item) => item.version === latestVersion)) break
              }
            } catch (e) {}
          }
          const release = releases.find((item) => item.version === latestVersion) || {
            version: latestVersion, date: null, notes: ['该版本已发布，详细变更记录暂不可用。']
          }
          updateState.checkedAt = Date.now()
          updateState.data = updateSnapshot({
            status: 'ok', latestVersion, available: compareVersions(latestVersion, LOCAL_VERSION) > 0,
            checkedAt: updateState.checkedAt, release, installation: installationMode(),
            installedVersion: installedVersion()
          })
          return updateState.data
        } catch (e) {
          updateState.checkedAt = Date.now()
          updateState.data = updateSnapshot({ status: 'error', checkedAt: updateState.checkedAt, message: (e && e.message) || String(e) })
          return updateState.data
        } finally {
          updateState.checking = null
        }
      })()
      return updateState.checking
    }

    const runPluginUpdate = async () => {
      const info = await checkForUpdates(true)
      if (!info.available) return info
      if (info.installation === 'link') {
        throw { code: 4092, message: '当前是本地 link 开发模式，请直接修改源码并刷新/重启 DSH；本地 link 不应覆盖更新。' }
      }
      const subprocess = ctx.get('subprocess')
      if (!subprocess) throw { code: 1005, message: '子进程服务不可用，无法执行插件更新' }
      const cwd = profileDir()
      if (!fs.existsSync(path.join(cwd, 'package.json'))) {
        throw { code: 4093, message: '找不到 web profile，无法执行插件更新。请先启动一次 dsh web。' }
      }
      updateState.installing = true
      try {
        const handle = subprocess.spawn({
          argv: ['pnpm', 'update', '--latest', PLUGIN_NAME], cwd,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
          graceMs: 5000
        })
        const outcome = await handle.done
        const stdout = (handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : '') || ''
        const stderr = (handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : '') || ''
        if (outcome.exitCode !== 0) {
          throw { code: 4094, message: `插件更新失败（pnpm exit ${outcome.exitCode}）${stderr ? ' · ' + stderr.slice(-300) : ''}` }
        }
        const installed = installedVersion()
        updateState.data = updateSnapshot({
          status: 'installed', latestVersion: info.latestVersion, available: false,
          checkedAt: Date.now(), installedVersion: installed || info.latestVersion,
          installation: installationMode(), restartRequired: true,
          release: info.release, output: stdout.slice(-1000)
        })
        updateState.checkedAt = Date.now()
        return updateState.data
      } finally {
        updateState.installing = false
      }
    }

    // GET + 指数退避重试：第一次失败等 1s，第二次 2s，第三次 4s（共最多 3 次重试）。
    // 401/403 不重试；429 / 5xx / 超时 / 网络错误重试。
    const apiGet = async (path, opts) => {
      const to = (opts && opts.timeoutSec) || cfg().timeoutSec
      const key = await resolveKey()
      if (!key) throw { code: 1001, message: '未配置 DeepSeek API Key（DEEPSEEK_API_KEY）。请在本页“配置”中填写，或在 ~/.dsh/.credentials.yaml 中设置。' }
      const base = await resolveBaseURL()
      const url = base.replace(/\/+$/, '') + path
      const headers = { authorization: 'Bearer ' + key, accept: 'application/json' }
      let lastErr = { code: 1003, message: 'DeepSeek API 错误' }
      for (let attempt = 0; attempt <= 3; attempt++) {
        let resp = null
        try {
          resp = await curlOnce({ method: 'GET', url, headers, timeoutSec: to })
        } catch (e) {
          lastErr = e
          if (attempt < 3) await ctx.timeout(1000 * Math.pow(2, attempt))
          continue
        }
        const st = resp.status
        if (st >= 200 && st < 300) return resp.text
        if (st === 401 || st === 403) throw { code: 1002, message: `DeepSeek API 认证失败（HTTP ${st}），请检查 API Key`, status: st }
        if (st === 429) lastErr = { code: 1004, message: 'DeepSeek API 限流（HTTP 429）', status: st }
        else if (st >= 500) lastErr = { code: 1003, message: `DeepSeek API 服务端错误（HTTP ${st}）`, status: st }
        else lastErr = { code: 1003, message: `DeepSeek API 错误（HTTP ${st}）`, status: st }
        if (attempt < 3) await ctx.timeout(1000 * Math.pow(2, attempt))
      }
      throw lastErr
    }

    // ─────────────────────────── 余额服务 ───────────────────────────
    const parseBalance = (text) => {
      const data = JSON.parse(text)
      const info = (Array.isArray(data.balance_infos) && data.balance_infos[0]) || {}
      return {
        available: data.is_available !== false,
        currency: info.currency || 'CNY',
        balance: Number(info.total_balance) || 0,
        granted: Number(info.granted_balance) || 0,
        cash: Number(info.topped_up_balance) || 0
      }
    }

    const fetchBalance = async ({ force = false } = {}) => {
      const c = cfg()
      const good = STATE.lastGood
      // 缓存：TTL 内直接返回（方案 C），force=true 跳过缓存（方案 D）
      if (!force && good && good.fetchedAt && (Date.now() - good.fetchedAt < c.cacheTtlSec * 1000)) {
        return Object.assign({}, STATE.lastAttempt || good, { cached: true })
      }
      if (refreshing) return Object.assign({}, STATE.lastAttempt || good || {}, { cached: true })
      refreshing = true
      try {
        const t0 = Date.now()
        const text = await apiGet('/user/balance')
        const b = parseBalance(text)
        const attempt = {
          status: 'ok', available: b.available, currency: b.currency,
          balance: b.balance, cash: b.cash, granted: b.granted,
          fetchedAt: Date.now(), latencyMs: Date.now() - t0, lastError: null, lastErrorCode: null, cached: false
        }
        // 余额变化检测：increase（充值/赠送到账）与 decrease（消费）
        if (good && Math.abs(good.balance - b.balance) > 1e-9) {
          const delta = r2(b.balance - good.balance)
          STATE.history.unshift({
            at: isoNow(), ts: Date.now(),
            oldBalance: good.balance, newBalance: b.balance, delta,
            changeType: delta > 0 ? 'increase' : 'decrease',
            balance: b.balance, cash: b.cash, granted: b.granted, currency: b.currency
          })
          if (STATE.history.length > MAX_HISTORY) STATE.history.length = MAX_HISTORY
        } else if (!good) {
          STATE.history.unshift({
            at: isoNow(), ts: Date.now(), oldBalance: null, newBalance: b.balance, delta: 0,
            changeType: 'first', balance: b.balance, cash: b.cash, granted: b.granted, currency: b.currency
          })
        }
        STATE.lastGood = Object.assign({}, attempt)
        STATE.lastAttempt = Object.assign({}, attempt)
        scheduleSave()
        return attempt
      } catch (e) {
        const attempt = {
          status: 'error', available: good ? good.available : false,
          currency: good ? good.currency : 'CNY',
          balance: good ? good.balance : null,
          cash: good ? good.cash : null,
          granted: good ? good.granted : null,
          fetchedAt: Date.now(), latencyMs: null,
          lastError: (e && e.message) || String(e),
          lastErrorCode: (e && e.code) || 0,
          cached: false
        }
        STATE.lastAttempt = attempt
        scheduleSave()
        return attempt
      } finally {
        refreshing = false
      }
    }

    // ─────────────────────────── 用量统计（llm/stream 埋点） ───────────────────────────
    // 不记录任何 Prompt/回复内容，只记录 token 数与状态（隐私安全）。
    // 监听器必须同步返回 AsyncIterable（llm/stream 是 cordis 瀑布，结果不会被 await）。
    ctx.on('llm/stream', (options, next) => {
      const started = Date.now()
      // 硬限制拦截：今日估算费用已达 dailyLimit 时拒绝新的 DeepSeek 调用。
      // 不调用 next() 就不会发出真实请求；进行中的流不受影响；其他 provider 不拦。
      const isDeepSeek = (p, m) => {
        const s = String(p || '') + ' ' + String(m || '')
        return /deepseek/i.test(s)
      }
      const lim = limitStatus()
      if (lim.enabled && lim.exceeded && isDeepSeek(options && options.provider, options && options.model)) {
        if (limitState.day === dkey(new Date())) limitState.blockedCount += 1
        const msg = `今日 DeepSeek 消费已达到 ¥${lim.dailyLimit.toFixed(2)} 限额（已消费 ¥${lim.todayCost.toFixed(2)}），本次调用未发出。` +
          `可调整每日限额或关闭硬限制后继续使用（设置 → DeepSeek → 高级设置）。`
        console.warn('deepseek-console: ' + msg)
        // 本地拦截也记入请求日志（error_type=hard_limit，与 API 失败分开统计）
        RequestLog.push({ ts: Date.now(), model: (options && options.model) || 'unknown', source: inferSource(options), input: 0, output: 0, cacheRead: 0, total: 0, cost: 0, latencyMs: 0, status: 'blocked', httpStatus: null, errorType: 'hard_limit', errorMessage: msg, downgradedFrom: null, taskId: currentTask ? currentTask.id : null })
        return (async function* () { throw { code: 4292, message: msg } })()
      }

      // ── 模型本地禁用 + 成本保护自动降级（发送前改写 options；硬限制优先级更高，已在上方拦截）──
      let downgradedFrom = null
      const origModel = (options && options.model) || 'unknown'
      if (isDeepSeek(options && options.provider, origModel)) {
        const c = cfg()
        // 本地禁用的模型：不能被调用（仅本地控制，不影响 DeepSeek 官方账户权限）
        if (c.disabledModels && c.disabledModels[origModel]) {
          const msg = `模型 ${origModel} 已在本地禁用（设置 → DeepSeek → 模型页可重新启用）。此为插件本地控制，不影响 DeepSeek 官方账户。`
          RequestLog.push({ ts: Date.now(), model: origModel, source: inferSource(options), input: 0, output: 0, cacheRead: 0, total: 0, cost: 0, latencyMs: 0, status: 'blocked', httpStatus: null, errorType: 'model_unavailable', errorMessage: msg, downgradedFrom: null, taskId: currentTask ? currentTask.id : null })
          return (async function* () { throw { code: 4293, message: msg } })()
        }
        // 成本保护：今日消费达到限额的 costProtectionThreshold% 后切到 fallbackModel
        if (c.costProtectionEnabled && c.fallbackModel && c.fallbackModel !== origModel &&
            lim.enabled && lim.dailyLimit > 0 && (lim.todayCost / lim.dailyLimit) * 100 >= c.costProtectionThreshold) {
          if (!(c.disabledModels && c.disabledModels[c.fallbackModel])) {
            downgradedFrom = origModel
            try { options.model = c.fallbackModel } catch (e) { downgradedFrom = null }
            if (downgradedFrom) downgradeCount += 1
          }
        }
      }
      streamingCount += 1
      const streamPromise = Promise.resolve().then(() => next())
      return (async function* () {
        let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, settled = false
        const record = (status, errDetail) => {
          if (settled) return
          settled = true
          streamingCount = Math.max(0, streamingCount - 1)
          const model = (options && options.model) || 'unknown'
          const provider = (options && options.provider) || 'unknown'
          const source = inferSource(options)
          const call = {
            at: isoNow(), ts: Date.now(), provider, model, source,
            input, output, cacheRead, cacheWrite, total: input + output,
            latencyMs: Date.now() - started, status,
            cost: estimateCost(model, input, output, cacheRead),
            downgradedFrom
          }
          // 统一请求日志：成功/失败/取消都记（失败含分类与消息，不含任何认证信息）
          RequestLog.push({
            ts: call.ts, model, source, input, output, cacheRead, total: call.total, cost: call.cost,
            latencyMs: call.latencyMs, status: status === 'success' ? 'success' : 'failed',
            httpStatus: (errDetail && errDetail.status) || null,
            errorType: status === 'success' ? null : classifyErrorType(errDetail && errDetail.code, errDetail && errDetail.message),
            errorMessage: status === 'success' ? null : ((errDetail && errDetail.message) || status),
            downgradedFrom, taskId: currentTask ? currentTask.id : null
          })
          // 任务级累计：把本次调用并入“当前任务”
          if (!currentTask) currentTask = newTask()
          const task = currentTask
          if (model && model !== 'unknown') task.model = model
          if (provider) task.provider = provider
          task.input += input
          task.output += output
          task.cacheRead += cacheRead
          task.cacheWrite += cacheWrite
          task.total += input + output
          if (call.cost != null) task.cost = r2((task.cost || 0) + call.cost)
          task.requests += 1
          task.lastCallAt = Date.now()
          if (activeCount === 0) finishTask() // 非 agent 主动调用（如标题生成）即时收尾

          STATE.calls.unshift(call)
          if (STATE.calls.length > MAX_CALLS) STATE.calls.length = MAX_CALLS
          const k = dkey(new Date())
          const day = STATE.daily[k] || (STATE.daily[k] = { date: k, requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0, cost: 0, models: {} })
          day.requests += 1
          day.promptTokens += input
          day.completionTokens += output
          day.totalTokens += input + output
          day.cacheReadTokens += cacheRead
          if (call.cost != null) day.cost = r2((day.cost || 0) + call.cost)
          const m = day.models[model] || (day.models[model] = { requests: 0, tokens: 0, cost: 0 })
          m.requests += 1
          m.tokens += input + output
          if (call.cost != null) m.cost = r2((m.cost || 0) + call.cost)
          pruneDaily()
          scheduleSave()
        }
        try {
          const stream = await streamPromise
          for await (const chunk of stream) {
            if (chunk && chunk.type === 'usage' && chunk.usage) {
              input = chunk.usage.inputTokens ?? input
              output = chunk.usage.outputTokens ?? output
              cacheRead = chunk.usage.cacheReadTokens ?? cacheRead
              cacheWrite = chunk.usage.cacheWriteTokens ?? cacheWrite
            }
            yield chunk
          }
          record('success')
        } catch (e) {
          record('error', e)
          throw e
        } finally {
          record('cancelled')
        }
      })()
    })

    // ─────────────────────────── 统计聚合 ───────────────────────────
    const dayStats = (k) => {
      const d = STATE.daily[k]
      return d
        ? { date: k, requests: d.requests, promptTokens: d.promptTokens, completionTokens: d.completionTokens, totalTokens: d.totalTokens, cacheReadTokens: d.cacheReadTokens || 0, cost: d.cost || 0 }
        : { date: k, requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0, cost: 0 }
    }
    // 预算状态：dailyBudget / sessionBudget 未配置时返回 null（不告警）。
    // session 费用 = 今日累计（进程级会话近似；跨日按当日重新起算）。
    const budgetStatus = () => {
      const d = cfg().dailyBudget
      const s = cfg().sessionBudget
      const todayCost = dayStats(dkey(new Date())).cost || 0
      const dailyExceeded = d !== null && d !== undefined && todayCost > d
      const sessionExceeded = s !== null && s !== undefined && todayCost > s
      return {
        dailyBudget: d, sessionBudget: s, todayCost,
        dailyExceeded: !!dailyExceeded, sessionExceeded: !!sessionExceeded
      }
    }
    // 硬限制状态（始终返回完整对象；UI 与拦截共用同一事实源）：
    //   enabled   = hardLimitEnabled 且 dailyLimit > 0
    //   exceeded  = enabled && todayCost >= dailyLimit —— 纯动态计算，不落盘。
    // 由此跨日（todayCost 归零）、调高限额、关开关都自动恢复，无需清理任何持久状态。
    // blockedCount 仅统计当日被拒调用次数，跨日自动清零（诊断用途，不影响判断）。
    let limitState = { day: null, blockedCount: 0 }
    const limitStatus = () => {
      const c = cfg()
      const lim = c.dailyLimit
      const enabled = !!c.hardLimitEnabled && lim !== null && lim !== undefined && lim > 0
      const k = dkey(new Date())
      if (limitState.day !== k) limitState = { day: k, blockedCount: 0 }
      const todayCost = dayStats(k).cost || 0
      const exceeded = enabled && todayCost >= lim
      return { enabled, dailyLimit: lim, todayCost, remaining: enabled ? Math.max(0, r2(lim - todayCost)) : null, exceeded, blockedCount: exceeded ? limitState.blockedCount : 0 }
    }
    // ── 余额预警：账户余额低于阈值时告警（与预算告警分开；只提醒一次，恢复后重置）──
    let balanceWarned = false
    const balanceWarningStatus = () => {
      const c = cfg()
      const good = STATE.lastGood
      if (!c.balanceWarningEnabled || !good || good.balance === null || good.balance === undefined) return null
      const low = good.balance < c.balanceWarningThreshold
      if (!low) { balanceWarned = false; return { enabled: true, threshold: c.balanceWarningThreshold, balance: good.balance, low: false, justNow: false } }
      const justNow = !balanceWarned
      balanceWarned = true
      return { enabled: true, threshold: c.balanceWarningThreshold, balance: good.balance, low: true, justNow }
    }

    // ── 财务推算：runway（余额可撑几天）、今日费用预测、消费异常检测 ──
    // 数据不足（近期无消费）时返回 null 并在 UI 显示"数据不足"，不硬算。
    const financeEstimates = () => {
      const good = STATE.lastGood
      const balance = good ? good.balance : null
      const out = { runwayDays: null, avgDaily7: null, todayForecast: null, forecastOverBudget: false, anomaly: null }
      // 近 7 天日均（含今天，跳过完全无消费的天会高估，因此按 7 天自然跨度平均）
      let sum7 = 0
      const now = new Date()
      for (let i = 0; i < 7; i++) { const d = new Date(now); d.setDate(now.getDate() - i); sum7 += dayStats(dkey(d)).cost || 0 }
      const avgDaily7 = sum7 / 7
      if (avgDaily7 > 0.005) out.avgDaily7 = r2(avgDaily7)
      if (balance !== null && balance !== undefined && out.avgDaily7) {
        out.runwayDays = Math.floor(balance / out.avgDaily7)
      }
      // 今日预测：按今天已过时间外推（下午 3 点的 6 元 ≈ 全天 9.6 元）；前 1 小时不预测（样本太少）
      const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
      const todayCost = dayStats(dkey(new Date())).cost || 0
      if (nowMin >= 60) {
        out.todayForecast = r2(todayCost * (1440 / nowMin))
        const c = cfg()
        if (c.dailyBudget !== null && c.dailyBudget !== undefined && out.todayForecast > c.dailyBudget) out.forecastOverBudget = true
      }
      // 消费异常：最近 5 分钟消费 > 近 7 天日均的 3 倍 且 > ¥1（简单规则，防 Agent 失控场景）
      const fiveMinAgo = Date.now() - 5 * 60 * 1000
      let recent = 0
      for (const call of STATE.calls) { if (call.ts >= fiveMinAgo) recent += (call.cost || 0); else break }
      if (out.avgDaily7 && recent > 1 && recent > (out.avgDaily7 / 288) * 3 * 5) out.anomaly = { recent5Min: r2(recent), avgDaily: out.avgDaily7 }
      return out
    }

    const rangeDays = (range) => {
      const now = new Date()
      const days = []
      const push = (d) => days.push(dayStats(dkey(d)))
      if (range === 'today') { push(now); return days }
      if (range === 'month') {
        const y = now.getFullYear(), m = now.getMonth()
        for (let day = 1; day <= now.getDate(); day++) push(new Date(y, m, day))
        return days
      }
      const n = range === '30d' ? 30 : 7
      for (let i = n - 1; i >= 0; i--) { const d = new Date(now); d.setDate(now.getDate() - i); push(d) }
      return days
    }
    const rangeTotals = (days) => {
      let requests = 0, promptTokens = 0, completionTokens = 0, totalTokens = 0, cacheReadTokens = 0, cost = 0
      const byModel = {}
      for (const day of days) {
        requests += day.requests
        promptTokens += day.promptTokens
        completionTokens += day.completionTokens
        totalTokens += day.totalTokens
        cacheReadTokens += day.cacheReadTokens
        cost += day.cost
        const d = STATE.daily[day.date]
        if (d && d.models) {
          for (const mk of Object.keys(d.models)) {
            const mv = d.models[mk]
            const agg = byModel[mk] || (byModel[mk] = { model: mk, requests: 0, tokens: 0, cost: 0 })
            agg.requests += mv.requests
            agg.tokens += mv.tokens
            agg.cost += mv.cost
          }
        }
      }
      return { requests, promptTokens, completionTokens, totalTokens, cacheReadTokens, cost: r2(cost), byModel: Object.values(byModel).sort((a, b) => b.tokens - a.tokens) }
    }

    // ─────────────────────────── 服务函数 ───────────────────────────
    const accountData = async () => {
      const good = STATE.lastGood
      const att = STATE.lastAttempt
      const kf = await keyFacts()
      const today = dayStats(dkey(new Date()))
      const month = rangeTotals(rangeDays('month'))
      return {
        account: {
          available: good ? good.available : null,
          balance: good ? good.balance : null,
          cash: good ? good.cash : null,
          granted: good ? good.granted : null,
          currency: good ? good.currency : 'CNY',
          lastSyncAt: good ? good.fetchedAt : null,
          syncStatus: att ? att.status : 'idle',
          lastError: att ? att.lastError : null,
          lastErrorCode: att ? att.lastErrorCode : null,
          latencyMs: att ? att.latencyMs : null,
          keyConfigured: kf.configured,
          keyMasked: kf.configured ? maskKey(await resolveKey()) : '',
          keySource: kf.source,
          keyWritable: kf.writable,
          baseURL: await resolveBaseURL(),
          pollIntervalSec: cfg().pollIntervalSec,
          cacheTtlSec: cfg().cacheTtlSec,
          timeoutSec: cfg().timeoutSec,
          priceTier: cfg().priceTier,
          persistence: unit ? 'disk' : 'memory'
        },
        stats: {
          today,
          month: { requests: month.requests, promptTokens: month.promptTokens, completionTokens: month.completionTokens, totalTokens: month.totalTokens, cost: month.cost }
        },
        budget: budgetStatus(),
        limit: limitStatus(),
        balanceWarning: balanceWarningStatus(),
        finance: financeEstimates(),
        history: STATE.history.slice(0, 10),
        lastChange: STATE.history[0] || null
      }
    }

    const testConnection = async () => {
      const kf = await keyFacts()
      const base = await resolveBaseURL()
      const key = await resolveKey()
      const masked = kf.configured ? maskKey(key) : ''
      if (!kf.configured) {
        return { status: 'error', latencyMs: null, message: '未配置 API Key（DEEPSEEK_API_KEY）', keyConfigured: false, keyMasked: '', baseURL: base }
      }
      const to = cfg().timeoutSec
      const t0 = Date.now()
      try {
        // 单次直连、不走缓存、不重试，用于真实延迟测量
        const resp = await curlOnce({
          method: 'GET',
          url: base.replace(/\/+$/, '') + '/user/balance',
          headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
          timeoutSec: to
        })
        const latencyMs = Date.now() - t0
        if (resp.status >= 200 && resp.status < 300) return { status: 'ok', latencyMs, message: '连接正常，API Key 有效', keyConfigured: true, keyMasked: masked, baseURL: base }
        if (resp.status === 401 || resp.status === 403) return { status: 'error', latencyMs, message: `认证失败（HTTP ${resp.status}）：API Key 无效或已过期`, keyConfigured: true, keyMasked: masked, baseURL: base }
        return { status: 'error', latencyMs, message: `DeepSeek API 返回 HTTP ${resp.status}`, keyConfigured: true, keyMasked: masked, baseURL: base }
      } catch (e) {
        return { status: 'error', latencyMs: Date.now() - t0, message: (e && e.message) || String(e), keyConfigured: true, keyMasked: masked, baseURL: base }
      }
    }

    // ── API 健康状态：连接页常驻卡片数据（不打官方接口，纯汇总既有状态）──
    const healthData = async () => {
      const kf = await keyFacts()
      const att = STATE.lastAttempt
      const h24 = RequestLog.health24()
      return {
        auth: kf.configured ? (att && att.lastErrorCode === 1002 ? 'error' : 'ok') : 'unset',
        balanceApi: att ? (att.status === 'ok' ? 'ok' : (att.lastErrorCode === 1002 ? 'error' : 'degraded')) : 'unknown',
        modelsApi: modelsCache.data ? 'ok' : 'unknown',
        latencyMs: att ? att.latencyMs : null,
        lastSuccessAt: att && att.status === 'ok' ? att.fetchedAt : null,
        lastError: RequestLog.lastError(),
        stats24: h24,
        logMode: RequestLog.info().mode
      }
    }
    // ── 运行诊断：逐步检查并在失败处停止，输出具体原因（全部无费用：网络/认证/models/balance）──
    // 注：Chat Completion 检测会产生真实费用，本诊断不做该项；以 models+balance 两个真实接口代替。
    const runDiagnose = async () => {
      const steps = []
      const add = (name, ok, detail) => { steps.push({ name, ok, detail: detail || null }); return ok }
      const base = await resolveBaseURL()
      // 1. 网络/Base URL：用一次无鉴权请求区分 DNS/连通性 vs 认证问题
      try {
        const resp = await curlOnce({ method: 'GET', url: base.replace(/\/+$/, '') + '/models', headers: { accept: 'application/json' }, timeoutSec: Math.min(cfg().timeoutSec, 8) })
        if (resp.status === 0 || resp.status >= 500) return add('network', false, `DeepSeek 服务不可达（HTTP ${resp.status}）`), { steps, ok: false }
        add('network', true, `${base}（HTTP ${resp.status}${resp.status === 401 ? '，未带 Key 属预期' : ''}）`)
      } catch (e) {
        return add('network', false, (e && e.message) || '网络错误'), { steps, ok: false }
      }
      // 2. API Key 验证：带鉴权重放 models
      const key = await resolveKey()
      if (!key) { add('auth', false, '未配置 API Key（DEEPSEEK_API_KEY）'); return { steps, ok: false } }
      try {
        const resp = await curlOnce({ method: 'GET', url: base.replace(/\/+$/, '') + '/models', headers: { authorization: 'Bearer ' + key, accept: 'application/json' }, timeoutSec: cfg().timeoutSec })
        if (resp.status === 401 || resp.status === 403) { add('auth', false, `认证失败（HTTP ${resp.status}）：API Key 无效或已过期`); return { steps, ok: false } }
        add('auth', true, 'API Key 有效')
        // 3. models 接口
        let modelsOk = false
        try { JSON.parse(resp.text); modelsOk = add('models', resp.status >= 200 && resp.status < 300, `GET /models → HTTP ${resp.status}`) } catch (e) { add('models', false, '响应不是合法 JSON') }
        // 4. 余额接口
        try {
          const r2 = await curlOnce({ method: 'GET', url: base.replace(/\/+$/, '') + '/user/balance', headers: { authorization: 'Bearer ' + key, accept: 'application/json' }, timeoutSec: cfg().timeoutSec })
          if (r2.status >= 200 && r2.status < 300) { const b = parseBalance(r2.text); add('balance', true, `余额 ¥${b.balance.toFixed(2)}（现金 ¥${b.cash.toFixed(2)} / 赠送 ¥${b.granted.toFixed(2)}）`) }
          else add('balance', false, `GET /user/balance → HTTP ${r2.status}`)
        } catch (e) { add('balance', false, (e && e.message) || '余额接口错误') }
        // 5. Chat Completion：跳过（会产生真实费用），明确标注
        add('chat_completion', true, '跳过（该项检测会产生实际费用；以 models/balance 真实调用代替验证）', )
        return { steps, ok: steps.every((s) => s.ok) }
      } catch (e) {
        add('auth', false, (e && e.message) || '验证请求失败')
        return { steps, ok: false }
      }
    }

    // 模型列表 5 分钟缓存（毫秒时间戳 + 列表），与 keyFactsCache 同款模式
    let modelsCache = { at: 0, data: null }
    const fetchModels = async () => {
      if (modelsCache.data && Date.now() - modelsCache.at < 300000) return modelsCache.data
      try {
        const text = await apiGet('/models')
        const data = JSON.parse(text)
        const list = Array.isArray(data.data) ? data.data.map((m) => ({ id: m.id, ownedBy: m.owned_by || '' })) : []
        modelsCache = { at: Date.now(), data: list }
        return list
      } catch (e) {
        if (modelsCache.data) return modelsCache.data
        throw e
      }
    }
    const modelsData = async () => {
      const list = await fetchModels()
      const pricing = cfg().pricing
      const disabled = cfg().disabledModels || {}
      // 今日模型维度统计（来自统一请求日志）
      const todayStats = RequestLog.groupBy('model', 'today')
      const statsMap = new Map(todayStats.map((s) => [s.key, s]))
      return {
        models: list.map((m) => {
          const pr = pricing[m.id] || null
          const st = statsMap.get(m.id)
          return {
            id: m.id, ownedBy: m.ownedBy,
            available: !disabled[m.id],           // 本地启用状态（false = 本地已禁用）
            locallyDisabled: !!disabled[m.id],
            contextWindow: pr ? pr.contextWindow : null,
            cacheHitIn: pr ? pr.cacheHitIn : null,
            cacheMissIn: pr ? pr.cacheMissIn : null,
            out: pr ? pr.out : null,
            priced: !!pr,
            today: st ? { requests: st.requests, tokens: st.tokens, cost: st.cost, avgLatencyMs: st.avgLatencyMs } : { requests: 0, tokens: 0, cost: 0, avgLatencyMs: null }
          }
        }),
        pricing,
        priceTier: cfg().priceTier,
        source: '模型列表：官方 GET /models 实时获取；价格：本模块配置（DeepSeek 官方定价文档 2026-08-17 调价）'
      }
    }

    const saveConfig = (patch) => {
      if (!patch || typeof patch !== 'object') throw { code: 4001, message: '配置格式错误' }
      const next = Object.assign({}, STATE.config || {})
      if (patch.pollIntervalSec !== undefined) next.pollIntervalSec = nOr(patch.pollIntervalSec, 15, 5, 300)
      if (patch.cacheTtlSec !== undefined) next.cacheTtlSec = nOr(patch.cacheTtlSec, 5, 0, 60)
      if (patch.timeoutSec !== undefined) next.timeoutSec = nOr(patch.timeoutSec, 10, 3, 60)
      if (patch.baseURL !== undefined) next.baseURL = (typeof patch.baseURL === 'string' && patch.baseURL) ? String(patch.baseURL).replace(/\/+$/, '') : DEFAULTS.baseURL
      if (patch.priceTier !== undefined) next.priceTier = (patch.priceTier === 'off' || patch.priceTier === 'avg' || patch.priceTier === 'peak') ? patch.priceTier : 'peak'
      if (patch.dailyBudget !== undefined) next.dailyBudget = (patch.dailyBudget === null || patch.dailyBudget === '' || patch.dailyBudget === undefined) ? null : Math.max(0, Number(patch.dailyBudget))
      if (patch.sessionBudget !== undefined) next.sessionBudget = (patch.sessionBudget === null || patch.sessionBudget === '' || patch.sessionBudget === undefined) ? null : Math.max(0, Number(patch.sessionBudget))
      if (patch.dailyLimit !== undefined) next.dailyLimit = (patch.dailyLimit === null || patch.dailyLimit === '' || patch.dailyLimit === undefined) ? null : Math.max(0, Number(patch.dailyLimit))
      if (patch.hardLimitEnabled !== undefined) next.hardLimitEnabled = !!patch.hardLimitEnabled
      if (patch.balanceWarningEnabled !== undefined) next.balanceWarningEnabled = !!patch.balanceWarningEnabled
      if (patch.balanceWarningThreshold !== undefined) next.balanceWarningThreshold = nOr(patch.balanceWarningThreshold, 20, 0.01, 1e6)
      if (patch.costProtectionEnabled !== undefined) next.costProtectionEnabled = !!patch.costProtectionEnabled
      if (patch.costProtectionThreshold !== undefined) next.costProtectionThreshold = nOr(patch.costProtectionThreshold, 80, 1, 100)
      if (patch.fallbackModel !== undefined) next.fallbackModel = (typeof patch.fallbackModel === 'string' && patch.fallbackModel) ? patch.fallbackModel : 'deepseek-v4-flash'
      if (patch.requestProtectionEnabled !== undefined) next.requestProtectionEnabled = !!patch.requestProtectionEnabled
      if (patch.maxConcurrentRequests !== undefined) next.maxConcurrentRequests = nOr(patch.maxConcurrentRequests, 3, 1, 32)
      if (patch.maxRequestsPerMinute !== undefined) next.maxRequestsPerMinute = nOr(patch.maxRequestsPerMinute, 60, 1, 6000)
      if (patch.disabledModels !== undefined && patch.disabledModels && typeof patch.disabledModels === 'object' && !Array.isArray(patch.disabledModels)) next.disabledModels = patch.disabledModels
      if (patch.pricing !== undefined && patch.pricing && typeof patch.pricing === 'object') {
        const pricing = {}
        for (const k of Object.keys(patch.pricing)) {
          const p = patch.pricing[k]
          if (p && typeof p === 'object') {
            pricing[k] = {
              cacheHitIn: nOr(p.cacheHitIn, 0, 0, 1e6),
              cacheMissIn: nOr(p.cacheMissIn, 0, 0, 1e6),
              out: nOr(p.out, 0, 0, 1e6),
              contextWindow: nOr(p.contextWindow, 1048576, 1, 1e9)
            }
          }
        }
        if (Object.keys(pricing).length) next.pricing = pricing
      }
      STATE.config = next
      scheduleSave()
      armMonitor()
      return cfg()
    }
    const saveKey = async (key) => {
      if (!key || typeof key !== 'string') throw { code: 4001, message: 'API Key 不能为空' }
      const creds = ctx.get('credentials')
      if (!creds) throw { code: 5002, message: '凭据服务不可用' }
      try {
        await creds.set('DEEPSEEK_API_KEY', key.trim())
        keyFactsCache = { at: 0, value: null } // 写入成功，立即失效缓存
      } catch (e) {
        throw { code: 5002, message: '保存 API Key 失败：' + ((e && e.message) || String(e)) }
      }
      // 已写入凭证库；立即用新 Key 验证并同步一次，把真实结果带回前端。
      // fetchBalance 不抛错（错误记录在 lastAttempt），所以这里读状态判断。
      STATE.lastGood = null
      await fetchBalance({ force: true })
      const att = STATE.lastAttempt
      if (!att || att.status !== 'ok') {
        throw { code: 1002, message: 'Key 已保存，但验证失败：' + ((att && att.lastError) || '未知错误') + '。请检查 Key 是否正确，或稍后在「连接」页重试。' }
      }
      return { saved: true, verified: true }
    }
    // 预留：DeepSeek 官方当前没有余额 Webhook；若未来提供，在此接入事件。
    const handleWebhook = async () => {
      return { accepted: true, note: 'DeepSeek 官方当前未提供余额 Webhook，本接口为预留扩展点。' }
    }

    // ─────────────────────────── HUD 数据（RPC 与 HTTP 共用，避免双份漂移） ───────────────────────────
    const hudData = async () => {
      const kf = await keyFacts()
      return {
        task: currentTask ? {
          id: currentTask.id, status: currentTask.status, model: currentTask.model, provider: currentTask.provider,
          input: currentTask.input, output: currentTask.output, cacheRead: currentTask.cacheRead,
          total: currentTask.total, cost: currentTask.cost, requests: currentTask.requests,
          startTs: currentTask.startTs, endTs: currentTask.endTs, lastCallAt: currentTask.lastCallAt
        } : null,
        requesting: streamingCount > 0,
        balance: STATE.lastGood ? STATE.lastGood.balance : null,
        cash: STATE.lastGood ? STATE.lastGood.cash : null,
        granted: STATE.lastGood ? STATE.lastGood.granted : null,
        currency: STATE.lastGood ? STATE.lastGood.currency : 'CNY',
        apiStatus: STATE.lastAttempt ? STATE.lastAttempt.status : 'idle',
        lastSyncAt: STATE.lastGood ? STATE.lastGood.fetchedAt : null,
        lastError: STATE.lastAttempt ? STATE.lastAttempt.lastError : null,
        keyConfigured: kf.configured,
        today: dayStats(dkey(new Date())),
        budget: budgetStatus(),
        limit: limitStatus(),
        balanceWarning: balanceWarningStatus(),
        // 统一状态机：idle | requesting | warning | hard_limit_reached | api_error | offline
        phase: (() => {
          const lim = limitStatus()
          if (!kf.configured) return 'offline'
          if (lim && lim.exceeded) return 'hard_limit_reached'
          if (streamingCount > 0) return 'requesting'
          const att = STATE.lastAttempt
          if (att && att.status === 'error') return 'api_error'
          const bw = balanceWarningStatus()
          if (bw && bw.low) return 'warning'
          return 'idle'
        })(),
        downgrade: { count: downgradeCount, active: (() => { const c = cfg(); const lim = limitStatus(); return !!(c.costProtectionEnabled && lim.enabled && lim.dailyLimit > 0 && (lim.todayCost / lim.dailyLimit) * 100 >= c.costProtectionThreshold) })() }
      }
    }

    // ─────────────────────────── 统一响应包装 ───────────────────────────
    const ok = (data) => ({ code: 0, message: 'success', data })
    const fail = (code, message) => ({ code, message, data: null })

    // ─────────────────────────── 统计/健康/诊断 API（页面同源 fetch 直调） ───────────────────────────
    const statsApi = {
      requests: (a) => RequestLog.query({ status: a.status, model: a.model, source: a.source, range: a.range, limit: a.limit, offset: a.offset }),
      trend: (a) => RequestLog.trend((a && a.range) || 'today'),
      modelStats: (a) => ({ range: (a && a.range) || 'month', models: RequestLog.groupBy('model', (a && a.range) || 'month') }),
      sourceStats: (a) => ({ range: (a && a.range) || 'today', sources: RequestLog.groupBy('source', (a && a.range) || 'today') }),
      health: async () => healthData(),
      diagnose: async () => runDiagnose(),
      toggleModel: async (a) => {
        const model = a && a.model
        if (!model || typeof model !== 'string') throw { code: 4001, message: '缺少 model 参数' }
        const next = Object.assign({}, STATE.config || {})
        const dm = Object.assign({}, next.disabledModels || {})
        if (a.disable) dm[model] = true
        else delete dm[model]
        next.disabledModels = dm
        STATE.config = next
        scheduleSave()
        return { model, disabled: !!dm[model], note: '本地控制：仅本插件拦截调用，不修改 DeepSeek 官方账户权限' }
      }
    }

    // ─────────────────────────── 真实 HTTP 后端接口（webServer） ───────────────────────────
    const registerRoutes = () => {
      const ws = ctx.get('webServer')
      if (!ws) return
      // 清理历史孤儿路由：仅当目标路径当前已被（旧版本）占用时删除，
      // 避免重复 apply 时误删自己刚注册的路由。此清理幂等，只删 /api/deepseek/*。
      const routeDisposers = []
      const json = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }
      // CSRF 防护：浏览器跨站请求（恶意网页打 localhost）必带 Origin 头且不等于本机源；
      // 同源 fetch 的 Origin 与 Host 一致，curl 则不带 Origin。写操作据此拦截。
      const sameOrigin = (req) => {
        const origin = req.headers.origin
        if (!origin) return true // 非浏览器客户端（curl 等）
        let host = req.headers.host
        try { host = host || new URL(origin).host } catch (e) {}
        try { return new URL(origin).host === host } catch (e) { return false }
      }
      const readBody = (req) => new Promise((resolve) => {
        let data = ''
        let done = false
        const finish = (v) => { if (!done) { done = true; resolve(v) } }
        req.on('data', (c) => { data += c; if (data.length > 1e6) { req.destroy(); finish('') } })
        req.on('end', () => finish(data))
        req.on('error', () => finish(''))
        req.on('close', () => finish('')) // destroy 后 'end' 不触发，兜底 resolve 避免挂死
      })
      const queryOf = (url) => {
        const qi = url.indexOf('?')
        const q = qi >= 0 ? url.slice(qi + 1) : ''
        const out = {}
        if (!q) return out
        for (const pair of q.split('&')) {
          const i = pair.indexOf('=')
          const k = i >= 0 ? decodeURIComponent(pair.slice(0, i)) : pair
          const v = i >= 0 ? decodeURIComponent(pair.slice(i + 1)) : ''
          if (k) out[k] = v
        }
        return out
      }
      // 立即注册路由（不依赖 ctx.effect 的惰性调度，apply 执行时即生效）；
      // disposer 收集到 routeDisposers，由下方 fiber 生命周期 effect 统一清理。
      const route = (method, path, fn) => {
        try {
          const dispose = ws.register({
            kind: 'exact',
            path,
            handler: async (req, res) => {
              if (req.method !== method) {
                res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
                return res.end(JSON.stringify(fail(4001, `需要 ${method}`)))
              }
              if (method === 'POST' && !sameOrigin(req)) {
                return json(res, fail(4031, '跨站请求已拦截：写操作仅允许同源或本机客户端'))
              }
              lastSeen = Date.now()
              try {
                const q = queryOf(req.url || '')
                let body = {}
                if (req.method === 'POST') {
                  const raw = await readBody(req)
                  if (raw) {
                    try { body = JSON.parse(raw) } catch { return json(res, fail(4001, '请求体不是合法 JSON')) }
                  }
                }
                const merged = Object.assign({}, q, (typeof body === 'object' && body) ? body : {})
                const data = await fn(merged)
                return json(res, ok(data))
              } catch (e) {
                return json(res, fail((e && e.code) || 5002, (e && e.message) || String(e)))
              }
            }
          })
          if (typeof dispose === 'function') routeDisposers.push(dispose)
        } catch (e) {
          console.error('deepseek-console: HTTP 路由注册失败（跳过）', e && e.message)
        }
      }
      const q = (a, k, d) => (a && a[k] !== undefined && a[k] !== '') ? a[k] : d
      route('GET', '/api/deepseek/account', async () => accountData())
      route('GET', '/api/deepseek/balance', async (a) => ({ balance: await fetchBalance({ force: q(a, 'refresh', '') === 'true' }) }))
      route('POST', '/api/deepseek/refresh', async () => { await fetchBalance({ force: true }); return accountData() })
      route('POST', '/api/deepseek/test', async () => testConnection())
      route('GET', '/api/deepseek/usage', async (a) => { const range = q(a, 'range', '7d'); const days = rangeDays(range); return { range, days, totals: rangeTotals(days) } })
      route('GET', '/api/deepseek/history', async (a) => {
        const limit = nOr(Number(q(a, 'limit', 50)), 50, 1, 200)
        const offset = Math.max(0, Number(q(a, 'offset', 0)) || 0)
        return { entries: STATE.history.slice(offset, offset + limit), total: STATE.history.length }
      })
      route('GET', '/api/deepseek/calls', async (a) => ({ calls: STATE.calls.slice(0, nOr(Number(q(a, 'limit', 20)), 20, 1, 100)) }))
      route('GET', '/api/deepseek/models', async () => modelsData())
      route('GET', '/api/deepseek/config', async () => ({ config: cfg(), key: await keyFacts(), persistence: unit ? 'disk' : 'memory' }))
      route('GET', '/api/deepseek/update', async (a) => checkForUpdates(q(a, 'force', '') === 'true'))
      route('POST', '/api/deepseek/installUpdate', async () => runPluginUpdate())
      route('POST', '/api/deepseek/saveKey', async (a) => saveKey(a.key))
      route('POST', '/api/deepseek/saveConfig', async (a) => ({ config: saveConfig(a && a.patch) }))
      route('POST', '/api/deepseek/webhook', async (a) => handleWebhook(a.payload))
      route('GET', '/api/deepseek/hud', async () => hudData())
      // ── 统计/健康/诊断 ──
      route('GET', '/api/deepseek/requests', async (a) => statsApi.requests(a))
      route('GET', '/api/deepseek/trend', async (a) => statsApi.trend(a))
      route('GET', '/api/deepseek/modelStats', async (a) => statsApi.modelStats(a))
      route('GET', '/api/deepseek/sourceStats', async (a) => statsApi.sourceStats(a))
      route('GET', '/api/deepseek/health', async () => statsApi.health())
      route('POST', '/api/deepseek/diagnose', async () => statsApi.diagnose())
      route('POST', '/api/deepseek/toggleModel', async (a) => statsApi.toggleModel(a))
      // 由 fiber 生命周期持有路由 disposer：插件停止/更新时统一移除。
      ctx.effect(() => () => {
        for (const d of routeDisposers.splice(0)) { try { d() } catch (e) {} }
      })
    }
    registerRoutes()

    // ─────────────────────────── 只读动态工具（供 Agent 查询余额等） ───────────────────────────


    // ─────────────────────────── 余额监控 + 生命周期 ───────────────────────────
    let monitorDispose = null
    const armMonitor = () => {
      if (monitorDispose) { monitorDispose(); monitorDispose = null }
      const sec = cfg().pollIntervalSec
      monitorDispose = ctx.interval(async () => {
        // 页面打开期间才保持后台同步（距最后一次 RPC 90s 内），关页即停
        if (Date.now() - lastSeen > 90000) return
        if (refreshing) return
        try { await fetchBalance({ force: false }) } catch (e) { /* 已记录到 lastAttempt */ }
      }, 1000 * sec)
    }

    // ─────────────────────────── 只读模型工具（usage_report） ───────────────────────────
    // 供 Agent 会话中直接查询：余额、今日用量与费用、预算状态、当前任务。
    // 注册失败（无 tools 服务 / schema 冲突）只告警，不影响插件其他功能。
    let toolDispose = null
    try {
      const tools = ctx.get('tools')
      if (tools && typeof tools.register === 'function') {
        toolDispose = tools.register({
          name: 'deepseek_usage_report',
          description: '查询 DeepSeek 账户余额、今日/本月 Token 用量与估算费用、预算状态、当前任务费用。只读，不修改任何状态。',
          parameters: { type: 'object', properties: {} },
          output: {
            // dsh-tools 要求：output 必须声明 { schema, render, presentationMeta? }
            // 原始通道（非 defineTool DSL）的 schema 必须直接属于白名单子集：
            // type 只能是 object/array/string/number/integer/boolean/null，
            // object 还须显式声明 additionalProperties。
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
          },
          execute: async () => {
            const today = dayStats(dkey(new Date()))
            const month = rangeTotals(rangeDays('month'))
            const task = currentTask
            return {
              balance: STATE.lastGood ? { balance: STATE.lastGood.balance, cash: STATE.lastGood.cash, granted: STATE.lastGood.granted, currency: STATE.lastGood.currency, lastSyncAt: STATE.lastGood.fetchedAt } : null,
              today: { cost: today.cost, totalTokens: today.totalTokens, requests: today.requests },
              month: { cost: month.cost, totalTokens: month.totalTokens },
              budget: budgetStatus(),
              limit: limitStatus(),
              currentTask: task ? { status: task.status, model: task.model, input: task.input, output: task.output, total: task.total, cost: task.cost, requests: task.requests } : null
            }
          }
        })
      }
    } catch (error) {
      console.warn('[deepseek-console] usage_report 工具注册失败:', error && error.message ? error.message : error)
    }

    ctx.effect(() => () => {
      if (toolDispose) { toolDispose(); toolDispose = null }
      if (monitorDispose) { monitorDispose(); monitorDispose = null }
      if (saveTimer) { saveTimer(); saveTimer = null }
      if (unit) { unit.close().catch(() => {}) }
    })

    ;(async () => {
      await openStore()
      armMonitor()
      // 启动时后台检查一次；失败只记录在更新状态中，不影响账户控制台。
      ctx.timeout(async () => { try { await checkForUpdates(false) } catch (e) {} }, 1500)
      ctx.interval(async () => { try { await checkForUpdates(true) } catch (e) {} }, UPDATE_CHECK_MS)
      // 启动后延迟一次初始同步（有 Key 才真正请求）
      ctx.timeout(async () => {
        try { await fetchBalance({ force: true }) } catch (e) { /* 已记录到 lastAttempt */ }
      }, 500)
    })()
  }
}
