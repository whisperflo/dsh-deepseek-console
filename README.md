# dsh-deepseek-console — DeepSeek 账户控制台

[中文](README.md) · [English](README_EN.md)

[![dshfind](https://dshfind.com/api/badge/whisperflo/dsh-deepseek-console?lang=zh)](https://dshfind.com/zh/plugins/whisperflo/dsh-deepseek-console?ref=badge)

> 一个为 DeepSeek Harness Web GUI 打造的 **DeepSeek 账户控制台**：官方 API 直连的实时余额监控、本地用量/费用统计、全局悬浮 HUD。

模型每思考一次，余额都在变化——这个插件让你随时看到花了多少钱。它通过 DeepSeek **官方** `GET /user/balance` 接口同步余额（现金/赠送分离），监听本机模型调用统计 Token 与费用，并以一个可拖拽的全局悬浮球常驻界面右下角。

以 **DSH 官方插件形态**（Cordis bundle：host 半 + client 半单包）实现，随 `dsh web` 启动自动加载。

## ✨ 功能一览

| 功能 | 说明 |
|---|---|
| 实时余额监控 | 官方 `GET /user/balance` 直连，现金余额 / 赠送余额分离展示，5s 缓存 + 可强制刷新 |
| 余额历史 | 自动记录每次余额变化（增加 / 减少 / 首次），可回看变化记录 |
| 本地用量统计 | 监听 `llm/stream` 事件，按任务与按日累计 Token（输入/输出/缓存命中）与费用 |
| 全局悬浮 HUD | 右下角可拖拽悬浮球 `● DS ¥xx.xx`，实时显示账户余额与当前任务费用；悬停展开、点击跳转设置页 |
| 任务级费用 | 每次对话累计本次 Token 与估算费用，实时反映当前任务的花费 |
| 预算告警 | 配置每日/会话预算后，费用超阈值时 HUD 徽标 + 概览页红色告警（只提醒，不影响调用） |
| 每日消费限额（硬限制） | 独立开关。开启后当日估算费用达到上限**拒绝新的 DeepSeek 调用**（进行中的不中断，其他模型不拦）；关闭后完全不限制且保留已填金额；跨日自动重算。达限时 HUD 弹出提示并可一键跳转高级设置调整 |
| 消费趋势图 | 今天（按小时）/ 7 天 / 30 天 SVG 折线，hover 显示明细 |
| 模型消费占比 | 按模型聚合费用 / Token / 次数 / 占比（今日 / 本月） |
| 请求明细 | 统一请求日志：状态 / 模型 / 范围筛选，点击展开完整详情（含错误类型） |
| 调用来源统计 | Chat / Agent / 内部任务各自花费，快速定位谁在消耗 |
| 余额预警 | 余额低于阈值时 HUD 提醒一次 + 概览标注（与预算告警独立） |
| 财务推算 | 预计余额可用天数（近 7 日日均）、今日费用外推、消费速度异常检测；数据不足不显示 |
| 成本保护 | 消费达到限额百分比后自动降级到低成本模型（硬限制优先级更高） |
| 模型本地启用开关 | 单模型禁用/启用（本地拦截，不影响官方账户权限） |
| API 健康诊断 | 24h 成功率 / 错误分类统计 + 逐步运行诊断（网络→认证→models→余额，零费用） |
| 统一请求日志 | `~/.dsh/storages/deepseek_requests.db`（node:sqlite，自动降级内存模式） |
| 模型工具 | `deepseek_usage_report` 工具，Agent 会话中可直接查询余额/用量/预算 |
| 官方模型清单 | 拉取 `GET /models`，展示模型上下文窗口与价格档位 |
| Key 零暴露 | API Key 只存本机后端凭证库（`~/.dsh/.credentials.yaml`），浏览器端仅见 `sk-****末4位` |
| 无第三方依赖 | 后端用 `subprocess + curl` 直连官方 API，不引入任何 SDK / 代理 |

## 📊 数据来源

- **余额**：DeepSeek 官方 `GET /user/balance`（`total_balance` / `granted_balance` / `topped_up_balance`），每次请求指数退避重试（1s/2s/4s，最多 3 次），401/403 不重试。
- **用量 / 费用**：监听 Harness 的 `llm/stream` 瀑布事件，统计每次模型调用的 Token 与耗时；费用按内置价格表估算（官方高峰定价，不可在界面修改）。
- **模型列表**：官方 `GET /models`。

> DeepSeek 官方**没有**用量/账单/日志查询 API——本插件的用量与费用均为**本地统计**，与官方账单可能有细微出入（价格档位、缓存计费口径）。

## 🏗 架构

```
┌──────────────────── 浏览器（Client 半 lib/client.js）────────────────────┐
│  4-Tab 控制台（概览/模型/连接/高级设置） · 全局悬浮 HUD · Cordis 面板卡片   │
│        │ 同源 fetch（/api/deepseek/*）                                   │
└────────▼──────────────────────────────────────────────────────────────────┘
┌──────────────────── 宿主进程（Host 半 lib/index.js）─────────────────────┐
│  DeepSeekClient ── subprocess + curl ──▶ 官方 API（/user/balance、/models）│
│  余额缓存（5s） · 余额历史 · 任务/每日 Token 与费用统计 · 持久化           │
│  webServer 路由 /api/deepseek/*（浏览器直接 HTTP 调用，无需 RPC）          │
└──────────────────────────────────────────────────────────────────────────┘
```

### 数据流

1. Client 半启动后每 2s 轮询 `GET /api/deepseek/hud`（当前任务 + 余额摘要），悬浮球实时刷新。
2. 控制台「概览」页调用 `GET /api/deepseek/account`（含当日/当月用量汇总）与 `GET /api/deepseek/usage?range=7d`。
3. Host 半监听 `agent/status`（任务边界）与 `llm/stream`（token/费用累计），写入每日流水。
4. 历史与配置持久化在 `~/.dsh/storages/deepseek_console.json`，重启不丢。

## 🔌 安装

### 方式一：npm 安装（推荐，开机自动启用）

```sh
dsh plugin --profile web add @hzjjxc/dsh-deepseek-console

# 重启 DSH web 进程
# （Ctrl+C 后重新 dsh web，或你的启动方式）
```

### 更新插件

#### 1.5.0 及之后版本

打开「设置 → DeepSeek」后，插件会自动检查更新：

1. 点击「检查更新」获取 npm 上的最新版本。
2. 发现新版本后点击「查看更新」，阅读变更摘要。
3. 点击「立即更新」，确认后插件会自动安装新版本。
4. 安装完成后重启 `dsh web`，新的 Host / Client 代码才会生效。

也可以在终端执行：

```sh
npm exec --yes --package=@deepseek-ai/dsh -- dsh plugin --profile web update --latest @hzjjxc/dsh-deepseek-console
```

#### 1.5.0 之前版本

旧版本没有内置更新中心，因此第一次升级需要手动执行：

```sh
npm exec --yes --package=@deepseek-ai/dsh -- dsh plugin --profile web update --latest @hzjjxc/dsh-deepseek-console
```

升级到 1.5.0 或更高版本后，后续就可以直接使用设置页里的「检查更新」和「立即更新」。

更新不会删除 API Key、余额历史和本地用量数据。

使用 `link:` 本地开发模式时，不要点击包更新；修改源码后刷新页面，涉及 Host 代码时重启 `dsh web` 即可。

### 方式二：GitHub / 本地开发

```sh
# 从 GitHub 直接安装
dsh plugin --profile web add github:whisperflo/dsh-deepseek-console

# 或本地 link 模式（改代码无需重装）
dsh plugin --profile web add link:/path/to/deepseek-console-plugin/composition
```

安装后 **重启 `dsh web`**，插件随进程自动加载；右下角出现悬浮球，设置 → DeepSeek 出现控制台。link 模式下改代码后 `node --check` + 刷新页面即可，无需重装。

### 方式三：手动组合行

把 `cordis.patch.yml` 的内容并入 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: deepseek-console
      name: '@hzjjxc/dsh-deepseek-console'
```

并确保包位于 profile 可解析的 `node_modules` 下（如 `~/.dsh/profiles/web/node_modules/@hzjjxc/dsh-deepseek-console/`），然后重启。

> ⚠️ 两种方式二选一，不要同时使用，否则会双挂载（两套 host 路由）。

## 🖥 使用

- **悬浮球**（右下角）：显示 `● DS ¥xx.xx` 当前余额；悬停展开详情（余额 / 本次费用 / 预算状态），点击打开控制台；按住可拖拽（位置自动吸附边缘并持久化）。点「刷新」强制同步官方余额（与控制台「同步」同路径）。
- **设置 → DeepSeek**：
  - **概览**：账户状态（余额预警/runway/今日预测）→ 当前任务 → 消费趋势 → 模型消费 → 最近请求（筛选+详情）→ 调用来源 → 余额变化。
  - **模型**：官方模型清单（上下文、价格、今日请求/费用统计）+ 本地启用开关。
  - **连接**：API Key / Base URL / 测试 + API 状态卡（24h 请求健康、错误分类）+ 运行诊断。
  - **高级设置**：同步与请求、每日消费硬限制、预算告警、余额预警、成本保护（自动降级）、请求保护（配置预留）。

### Agent 会话中查询

模型可直接调用 `deepseek_usage_report` 工具（只读）查询余额、今日/本月用量与费用、预算状态、当前任务——例如问"我今天 DeepSeek 花了多少钱"。

## 🔑 API Key 配置

Key 存于本机凭证库（`~/.dsh/.credentials.yaml`，`DEEPSEEK_API_KEY`），或直接在「连接」页输入保存。Key 永远只存在于宿主进程内，日志与浏览器只输出 `sk-****末4位`。

## 🔐 安全模型

- API Key 仅经 `credentials` 服务读取，绝不写入前端、日志脱敏。
- `/api/deepseek/*` 路由仅绑定本机 webServer（loopback），同源浏览器访问。
- **CSRF 防护**：所有 POST 写操作（saveKey / saveConfig / refresh / test / webhook）校验 `Origin`——跨站来源（恶意网页向 localhost 发起的表单 POST）返回 `4031` 拦截；curl 等不带 `Origin` 的本机客户端不受影响。防止跨站篡改 `baseURL` 导致 Key 外泄。
- 请求重试遵循官方限流语义：401/403 立即失败不重试，429/5xx/超时退避重试。
- 持久化文件权限默认继承 DSH storage 目录。

## 🔧 开发

```sh
node --check lib/index.js     # host 语法
node --check lib/client.js    # client 语法
```

- Host 半：CJS，`module.exports = { name, inject, apply }`，用 `ctx.get('webServer'/'storage'/'credentials'/'subprocess')` 等可选服务。
- Client 半：`window.__ModuleLoader__.load` 格式，`require('react')`，同源 `fetch` 走 `/api/deepseek/*`，`inject: ['timer', 'slots']`。
- 修改后刷新页面即可（组合插件经 client-modules 增量重扫，rev 自动变化）。

## 🧾 后端 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/deepseek/account` | 账户摘要（余额 / 用量 / 同步状态 / Key 事实） |
| GET | `/api/deepseek/balance?refresh=true` | 余额（带缓存，可强制刷新） |
| POST | `/api/deepseek/refresh` | 强制刷新余额 |
| GET | `/api/deepseek/usage?range=7d` | 按日用量与合计（7d/30d/90d） |
| GET | `/api/deepseek/history?limit=50&offset=0` | 余额变化历史（返回 `entries` 和 `total`） |
| GET | `/api/deepseek/calls?limit=20` | 最近模型调用 |
| GET | `/api/deepseek/models` | 官方模型清单 + 价格 |
| GET | `/api/deepseek/config` | 当前配置与 Key 事实 |
| POST | `/api/deepseek/saveConfig` | 保存配置（轮询/TTL/超时/价格档） |
| POST | `/api/deepseek/saveKey` | 保存 API Key |
| POST | `/api/deepseek/test` | 连接测试 |
| GET | `/api/deepseek/hud` | 悬浮球数据（任务 + 余额 + 预算状态） |

所有响应均为 `{ code: 0, message: 'success', data: ... }`。

## ⚖️ License

[MIT](LICENSE)
