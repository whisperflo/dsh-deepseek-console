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
//  5. RPC（harness.handle）+ 真实 HTTP 路由（webServer /api/deepseek/*）
//     + 一个只读动态工具 deepseek_console。
//  6. 余额监控：页面打开期间（lastSeen < 90s）按 pollIntervalSec 后台同步。
// ----------------------------------------------------------------------------
// 安全：API Key 只经 credentials 服务读取（DEEPSEEK_API_KEY 凭证），
// 永不写入前端、日志只输出 sk-****末4位。
// ============================================================================

module.exports = {
  name: 'deepseek-console',
  inject: ['timer', 'tools', 'webServer'],
  apply(ctx) {
    // ─────────────────────────── 状态与工具函数 ───────────────────────────
    const STATE = { config: null, lastGood: null, lastAttempt: null, history: [], calls: [], daily: {} }
    const MAX_HISTORY = 500
    const MAX_CALLS = 300
    let lastSeen = Date.now()
    let saveTimer = null
    let saveChain = Promise.resolve()
    let unit = null
    let refreshing = false

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

    const touch = () => { lastSeen = Date.now() }
    const isoNow = () => new Date().toISOString()
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

    // ─────────────────────────── 持久化（kv 单元） ───────────────────────────
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
          if (rec.daily && typeof rec.daily === 'object') STATE.daily = rec.daily
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
    const keyFacts = async () => {
      const creds = ctx.get('credentials')
      if (!creds) return { configured: false, source: null, writable: false }
      try {
        const info = await creds.describe('DEEPSEEK_API_KEY')
        return { configured: !!info.configured, source: info.source || null, writable: !!info.writable }
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
    const curlOnce = async ({ method, url, headers, body, timeoutSec }) => {
      const subprocess = ctx.get('subprocess')
      if (!subprocess) throw { code: 1005, message: '子进程服务不可用，无法访问 DeepSeek API' }
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
        if (outcome.exitCode === 28) throw { code: 1006, message: `DeepSeek API 请求超时（${timeoutSec}s）` }
        throw { code: 1005, message: `DeepSeek API 网络错误（curl exit ${outcome.exitCode}）${errText ? ' · ' + errText.slice(0, 120) : ''}` }
      }
      const marker = '\n__DSHTTP__'
      const idx = outText.lastIndexOf(marker)
      const text = idx >= 0 ? outText.slice(0, idx) : outText
      const status = idx >= 0 ? (parseInt(outText.slice(idx + marker.length).trim(), 10) || 0) : 200
      return { status, text }
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
      streamingCount += 1
      const streamPromise = Promise.resolve().then(() => next())
      return (async function* () {
        let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, settled = false
        const record = (status) => {
          if (settled) return
          settled = true
          streamingCount = Math.max(0, streamingCount - 1)
          const model = (options && options.model) || 'unknown'
          const provider = (options && options.provider) || 'unknown'
          const call = {
            at: isoNow(), ts: Date.now(), provider, model,
            input, output, cacheRead, cacheWrite, total: input + output,
            latencyMs: Date.now() - started, status,
            cost: estimateCost(model, input, output, cacheRead)
          }
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
          record('error')
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
      return {
        models: list.map((m) => {
          const pr = pricing[m.id] || null
          return {
            id: m.id, ownedBy: m.ownedBy, available: true,
            contextWindow: pr ? pr.contextWindow : null,
            cacheHitIn: pr ? pr.cacheHitIn : null,
            cacheMissIn: pr ? pr.cacheMissIn : null,
            out: pr ? pr.out : null,
            priced: !!pr
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
        // 立即用新 Key 验证并同步一次
        STATE.lastGood = null
        await fetchBalance({ force: true })
        return { saved: true }
      } catch (e) {
        throw { code: 5002, message: '保存 API Key 失败：' + ((e && e.message) || String(e)) }
      }
    }
    // 预留：DeepSeek 官方当前没有余额 Webhook；若未来提供，在此接入事件。
    const handleWebhook = async () => {
      return { accepted: true, note: 'DeepSeek 官方当前未提供余额 Webhook，本接口为预留扩展点。' }
    }

    // ─────────────────────────── RPC 处理器 ───────────────────────────
    const handlers = {
      'ds/account': async () => accountData(),
      'ds/balance': async (a) => ({ balance: await fetchBalance({ force: !!(a && a.refresh) }) }),
      'ds/refresh': async () => { await fetchBalance({ force: true }); return accountData() },
      'ds/test': async () => testConnection(),
      'ds/usage': async (a) => { const range = (a && a.range) || '7d'; const days = rangeDays(range); return { range, days, totals: rangeTotals(days) } },
      'ds/history': async (a) => ({ entries: STATE.history.slice(0, nOr((a && a.limit), 50, 1, 200)) }),
      'ds/calls': async (a) => ({ calls: STATE.calls.slice(0, nOr((a && a.limit), 20, 1, 100)) }),
      'ds/models': async () => modelsData(),
      'ds/config': async () => ({ config: cfg(), defaults: DEFAULTS, key: await keyFacts(), persistence: unit ? 'disk' : 'memory' }),
      'ds/saveConfig': async (a) => ({ config: saveConfig(a && a.patch) }),
      'ds/saveKey': async (a) => saveKey(a && a.key),
      'ds/webhook': async (a) => handleWebhook(a && a.payload),
      'ds/hud': async () => {
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
          today: dayStats(dkey(new Date()))
        }
      }
    }
    const ok = (data) => ({ code: 0, message: 'success', data })
    const fail = (code, message) => ({ code, message, data: null })
    const invoke = async (name, args) => {
      touch()
      const fn = handlers[name]
      if (!fn) return fail(4001, `未知方法: ${name}`)
      try {
        return ok(await fn(args || {}))
      } catch (e) {
        return fail((e && e.code) || 5002, (e && e.message) || String(e))
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
      const readBody = (req) => new Promise((resolve) => {
        let data = ''
        req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy() })
        req.on('end', () => resolve(data))
        req.on('error', () => resolve(''))
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
      route('GET', '/api/deepseek/history', async (a) => ({ entries: STATE.history.slice(0, nOr(Number(q(a, 'limit', 50)), 50, 1, 200)) }))
      route('GET', '/api/deepseek/calls', async (a) => ({ calls: STATE.calls.slice(0, nOr(Number(q(a, 'limit', 20)), 20, 1, 100)) }))
      route('GET', '/api/deepseek/models', async () => modelsData())
      route('GET', '/api/deepseek/config', async () => ({ config: cfg(), key: await keyFacts(), persistence: unit ? 'disk' : 'memory' }))
      route('POST', '/api/deepseek/saveKey', async (a) => saveKey(a.key))
      route('POST', '/api/deepseek/saveConfig', async (a) => ({ config: saveConfig(a && a.patch) }))
      route('POST', '/api/deepseek/webhook', async (a) => handleWebhook(a.payload))
      route('GET', '/api/deepseek/hud', async () => {
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
          budget: budgetStatus()
        }
      })
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
        const budget = budgetStatus()
        toolDispose = tools.register({
          name: 'deepseek_usage_report',
          description: '查询 DeepSeek 账户余额、今日/本月 Token 用量与估算费用、预算状态、当前任务费用。只读，不修改任何状态。',
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            const today = dayStats(dkey(new Date()))
            const month = rangeTotals(rangeDays('month'))
            const task = currentTask
            return {
              balance: STATE.lastGood ? { balance: STATE.lastGood.balance, cash: STATE.lastGood.cash, granted: STATE.lastGood.granted, currency: STATE.lastGood.currency, lastSyncAt: STATE.lastGood.fetchedAt } : null,
              today: { cost: today.cost, totalTokens: today.totalTokens, requests: today.requests },
              month: { cost: month.cost, totalTokens: month.totalTokens },
              budget: budgetStatus(),
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
      // 启动后延迟一次初始同步（有 Key 才真正请求）
      ctx.timeout(async () => {
        try { await fetchBalance({ force: true }) } catch (e) { /* 已记录到 lastAttempt */ }
      }, 500)
    })()
  }
}
