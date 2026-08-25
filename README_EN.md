# dsh-deepseek-console — DeepSeek Account Console

[中文](README.md) · [English](README_EN.md)

[![dshfind](https://dshfind.com/api/badge/whisperflo/dsh-deepseek-console?lang=en)](https://dshfind.com/zh/plugins/whisperflo/dsh-deepseek-console?ref=badge)

> A **DeepSeek account console** for the DeepSeek Harness Web GUI: real-time balance monitoring against the official API, local usage/cost statistics, and a global floating HUD.

Every model thought moves your balance — this plugin lets you always see what it costs. It syncs your balance (cash/granted separated) through the DeepSeek **official** `GET /user/balance` endpoint, tallies tokens and costs from local model calls, and keeps a draggable floating ball in the corner of the UI.

Shipped as the official DSH plugin shape (Cordis bundle: host half + client half in one package), auto-loaded when `dsh web` starts.

## ✨ Features

| Feature | Description |
|---|---|
| Real-time balance | Official `GET /user/balance`, cash / granted balance shown separately, 5s cache + forced refresh |
| Balance history | Every balance change (increase / decrease / first) recorded and viewable |
| Local usage stats | Listens to `llm/stream`, accumulates per-task and per-day tokens (in/out/cache-read) and cost |
| Global floating HUD | Draggable ball `● DS ¥xx.xx` in the corner showing balance and current-task cost; hover to expand, click to open the console |
| Per-task cost | Accumulates the current conversation's tokens and estimated cost in real time |
| Budget alerts | Configure daily/session budgets; HUD badge + Overview red alert when exceeded (advisory only, calls unaffected) |
| Daily spend limit (hard) | Independent toggle. When on, new DeepSeek calls are **rejected** once the day's estimated cost hits the cap (in-flight streams unaffected, other providers untouched); when off, no limiting at all and the amount is retained; auto-resets next day. On limit reached the HUD shows a banner with one-click jump to Advanced settings |
| Spend trend chart | Today (hourly) / 7d / 30d SVG line chart with hover details |
| Model spend share | Per-model cost / tokens / calls / share (today / month) |
| Request log | Unified request log with status/model/range filters; click to expand full details incl. error types |
| Source stats | Spend by entry point (Chat / Agent / internal) to spot what is consuming |
| Balance warning | One-time HUD alert + overview badge when balance drops below threshold (separate from budget alerts) |
| Finance estimates | Runway days (7-day average), today's cost extrapolation, spend-rate anomaly detection; hidden when data is insufficient |
| Cost protection | Auto-downgrade to a cheaper model at N% of the daily limit (hard limit takes precedence) |
| Per-model local toggle | Enable/disable a model locally (blocked by this plugin only; official account untouched) |
| API health | 24h success/error stats by class + step-by-step diagnose (network→auth→models→balance, zero cost) |
| Unified request log | `~/.dsh/storages/deepseek_requests.db` (node:sqlite, auto-fallback to memory) |
| Model tool | `deepseek_usage_report` — agents can query balance/usage/budget directly in-session |
| Official model list | Fetches `GET /models`, shows context window and price tiers |
| Key never exposed | API key lives only in the local credentials store (`~/.dsh/.credentials.yaml`); the browser only ever sees `sk-****last4` |
| No third-party deps | Backend uses `subprocess + curl` straight to the official API — no SDKs, no proxies |

## 📊 Data sources

- **Balance**: DeepSeek official `GET /user/balance` (`total_balance` / `granted_balance` / `topped_up_balance`), exponential backoff retry (1s/2s/4s, max 3), 401/403 never retried.
- **Usage / cost**: Listens to the Harness `llm/stream` waterfall, tallies tokens and latency per call; cost is estimated from the built-in price table (official peak pricing, fixed in UI).
- **Model list**: Official `GET /models`.

> DeepSeek's official API has **no** usage/billing/log query endpoints — usage and cost here are **local estimates**, so they may differ slightly from the official bill (price tier, cache billing semantics).

## 🏗 Architecture

```
┌────────────────────── Browser (Client half lib/client.js) ──────────────────────┐
│  4-tab console (Overview/Models/Connection/Advanced) · floating HUD · Cordis card │
│        │ same-origin fetch (/api/deepseek/*)                                     │
└────────▼─────────────────────────────────────────────────────────────────────────┘
┌────────────────────── Host process (Host half lib/index.js) ────────────────────┐
│  DeepSeekClient ── subprocess + curl ──▶ Official API (/user/balance, /models)   │
│  balance cache (5s) · history · per-task/per-day token & cost · persistence      │
│  webServer routes /api/deepseek/* (plain HTTP for the browser, no RPC)           │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Data flow

1. The client half polls `GET /api/deepseek/hud` every 2s (current task + balance summary) so the ball stays fresh.
2. The Overview tab calls `GET /api/deepseek/account` (today/month totals) and `GET /api/deepseek/usage?range=7d`.
3. The host half listens to `agent/status` (task boundaries) and `llm/stream` (token/cost accumulation), rolling into daily ledgers.
4. History and config persist to `~/.dsh/storages/deepseek_console.json` — survives restarts.

## 🔌 Install

### Option 1: npm (recommended, auto-enabled on boot)

```sh
dsh plugin --profile web add @hzjjxc/dsh-deepseek-console

# Restart the dsh web process
# (Ctrl+C then run dsh web again, or however you start it)
```

### Update the plugin

#### Version 1.5.0 and later

Open Settings → DeepSeek. The plugin checks for updates automatically:

1. Click “Check for updates” to query the latest npm version.
2. If an update is available, click “View changes” to read the summary.
3. Click “Update now” and confirm the installation.
4. Restart `dsh web` after installation so the new Host / Client code is loaded.

You can also update from the terminal:

```sh
dsh plugin --profile web update @hzjjxc/dsh-deepseek-console
```

#### Versions before 1.5.0

Older versions do not have the update center. Upgrade once from the terminal:

```sh
dsh plugin --profile web update @hzjjxc/dsh-deepseek-console
```

After upgrading to 1.5.0 or later, future updates can be installed from the Settings panel. Existing credentials, balance history, and local usage data are preserved.

For `link:` development installs, edit the source directly and refresh the page; restart `dsh web` when Host code changes.

### Option 2: GitHub / local development

```sh
# Install directly from GitHub
dsh plugin --profile web add github:whisperflo/dsh-deepseek-console

# Or local link mode (code changes need no reinstall)
dsh plugin --profile web add link:/path/to/deepseek-console-plugin/composition
```

After installing, **restart `dsh web`** — the plugin loads with the process; the floating ball appears at the bottom-right and 设置 → DeepSeek shows the console. In link mode, `node --check` + refresh the page after a code change; no reinstall needed.

### Option 3: Manual composition row

Merge `cordis.patch.yml` into `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: deepseek-console
      name: '@hzjjxc/dsh-deepseek-console'
```

Make sure the package is resolvable from the profile's `node_modules` (e.g. `~/.dsh/profiles/web/node_modules/@hzjjxc/dsh-deepseek-console/`), then restart.

> ⚠️ Use only ONE option — using both double-mounts the plugin (two host halves, two route registrations).

## 🖥 Usage

- **Floating ball** (bottom-right): shows `● DS ¥xx.xx`; hover to expand (balance / current-task cost / budget status), click to open the console; drag to reposition (edge-snapping, position persisted). Click 刷新 (Refresh) to force a live balance sync (same path as the console's sync button).
- **设置 → DeepSeek**:
  - **概览 Overview**: big balance number + cash/granted breakdown, today/month spend, current-task tokens & cost, budget alert status, daily-limit remaining, balance-change history.
  - **模型 Models**: official model list (context window, price tiers).
  - **连接 Connection**: API key (written to the local credentials store only), Base URL, connection test.
  - **高级设置 Advanced**: poll interval, cache TTL, timeout, daily spend limit (hard: toggle + amount + today progress bar), daily/session budgets (advisory).

### Query in-session

Agents can call the read-only `deepseek_usage_report` tool to fetch balance, today/month usage & cost, budget status, and the current task — e.g. ask "how much have I spent on DeepSeek today?"

## 🔑 API key

Stored in the local credentials store (`~/.dsh/.credentials.yaml`, `DEEPSEEK_API_KEY`), or entered in the Connection tab. The key never leaves the host process; logs and the browser only see `sk-****last4`.

## 🔐 Security model

- The API key is read only through the `credentials` service — never written to the frontend, logs are masked.
- `/api/deepseek/*` routes bind only to the local webServer (loopback), same-origin browser access.
- Retries follow official rate-limit semantics: 401/403 fail immediately, 429/5xx/timeout back off.
- Persisted files inherit the DSH storage directory permissions.

## 🔧 Development

```sh
node --check lib/index.js     # host syntax
node --check lib/client.js    # client syntax
```

- Host half: CJS, `module.exports = { name, inject, apply }`, optional services via `ctx.get('webServer'/'storage'/'credentials'/'subprocess')`.
- Client half: `window.__ModuleLoader__.load` format, `require('react')`, same-origin `fetch` to `/api/deepseek/*`, `inject: ['timer', 'slots']`.
- Refresh the page after edits (client-modules re-scans incrementally, rev changes automatically).

## 🧾 Backend API

| Method | Path | Description |
|---|---|---|
| GET | `/api/deepseek/account` | Account summary (balance / usage / sync status / key facts) |
| GET | `/api/deepseek/balance?refresh=true` | Balance (cached; force with refresh) |
| POST | `/api/deepseek/refresh` | Force-refresh balance |
| GET | `/api/deepseek/usage?range=7d` | Per-day usage and totals (7d/30d/90d) |
| GET | `/api/deepseek/history?limit=50` | Balance-change history |
| GET | `/api/deepseek/calls?limit=20` | Recent model calls |
| GET | `/api/deepseek/models` | Official model list + prices |
| GET | `/api/deepseek/config` | Current config and key facts |
| POST | `/api/deepseek/saveConfig` | Save config (poll/TTL/timeout/price tier) |
| POST | `/api/deepseek/saveKey` | Save API key |
| POST | `/api/deepseek/test` | Connection test |
| GET | `/api/deepseek/hud` | HUD data (task + balance) |

All responses use `{ code: 0, message: 'success', data: ... }`.

## ⚖️ License

[MIT](LICENSE)
