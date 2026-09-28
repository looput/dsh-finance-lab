# DSH Finance

> 让 DeepSeek Harness 从“查一条行情”走向“看懂市场、管理组合、组织研究”。

[English README](./README.en.md) · [MIT License](./package.json)

DSN Finance 是一个面向 DeepSeek Harness 的金融插件：它把 A 股、港股、美股、基金、宏观数据和财经新闻接入模型，同时提供一个可停靠的本地金融面板。行情通过公开 HTTP 接口直连，持仓和自选股保存在本地 JSON 中，适合个人研究、组合复盘和多智能体协作。

<img width="1331" height="804" alt="DSN Finance panel" src="https://github.com/user-attachments/assets/3fa063b1-22ef-404b-8fb9-1d230b7e66c0" />

## 你可以用它做什么

- **跨市场看行情**：A 股、港股、美股和公募基金的报价、K 线、列表与代码解析。
- **快**：行情优先走本地 WeStock CLI——批量取（一次调用拿多只标的）、并行调用、结果缓存与陈旧复用、失败即熔断；HTTP 源保留串行间隔做回落。面板首屏从「逐只串行 + 死等超时」降到秒级。
- **从数据到判断**：本地计算 MA、MACD、RSI、KDJ；查询财务指标、市场指数和行业板块。
- **跟踪市场叙事**：读取中国 CPI/PPI/PMI/GDP/M2、市场电报、个股新闻，并通过 DuckDuckGo 免费搜索网页。
- **读券商研报**：经 WeStock CLI（腾讯自选股，免鉴权）拉取个股研报列表与正文（机构、评级、时间）。
- **沉淀投研过程**：研报、财报、资讯与个人观点统一进「投研资料库」，必带来源与时间、可关联标的与观点，支持持续收集、追加批注与归档。
- **资料与本地文件双向联动**：正文是工作区里的 Markdown（`<vault>/<年>/<id>-<slug>.md`），目录被实时监听——在编辑器/文件工具里新建或改动文件会自动回灌索引，面板里改正文也会写回同一个文件。
- **对话 ↔ 面板打通**：对话里收集/产出的资料自动落库并实时出现在「资料」页（顶部回执 + 标「对话」来源）；资料详情的「问 Agent」「让 Agent 整理」会把上下文拼成提问直接发进当前会话，Agent 再用 `add_research_note` / `update_research` 回写资料库，形成「对话收集 → 资料沉淀 → 面板维护 → 继续追问」闭环。
- **管理自己的组合**：维护持仓和自选股，计算市值、盈亏、资产类型/市场分布，以及 top1、top3 和 HHI 集中度。
- **用研究团队拆解问题**：内置行情、基本面、宏观、基金、消息和风险管理 playbook，可交给 DSH subagent 并行研究后汇总。

## 核心体验

### 一个面板，十二个视角

从侧边栏打开 **📈 金融面板**，可在以下标签页之间切换：

| 标签页 | 内容 |
| --- | --- |
| 行情 | 指数、自选股走势、迷你 K 线和实时刷新 |
| 市场 | 领涨/领跌行业板块，快速定位当日风险 |
| 持仓 | 持仓盈亏、组合市值、股票/基金配置和集中度 |
| 基金 | 开放式基金排行、净值和加入自选 |
| K线 | 本地历史库日 K 线，财报/分红/自定义事件标记 |
| 宏观 | CPI、PPI、PMI、GDP、货币供应量及趋势 |
| 快讯 | 全球财经电报，以及按持仓/自选筛选的个股新闻 |
| 资料 | 投研资料库：按时间/标的分组浏览，按类型/状态/标的/关键词检索；详情为「元数据 + 正文」双栏，可编辑正文并写回本地文件、追加带时间戳的观点、归档；顶部显示本地目录与监听状态，可一键同步 |
| 发现 | 市场情绪与注意力：涨跌分布、热搜股票/热门板块、机构龙虎榜（WeStock） |
| 数据源 | 按 capability 选择 provider，选择顺序即调用优先级 |
| 技能 | 本地 playbook 与盈米金融场景 skill 的启停管理 |
| 接口 | 数据源健康状态与当前 provider、MCP 外部源开关 |

面板开关（`panelOpen` / `panelDocked`）是 volatile 配置：优先写回 profile；若当前 profile 不可写（本版本 `configForms.set` 会返回不可写），客户端自动退回 localStorage（`dsn-finance:panelPrefs`），并在面板顶部提示，保证面板打得开、刷新后状态保留。默认以**浮层抽屉**打开（`dev_web.sh` 生成 `panelDocked: false`；停靠页需要宿主 dock 容器，未选择工作区时可能不渲染），可在面板内一键切换为停靠。

持仓截图也可以交给 Agent 识别，再通过 `import_holdings` 批量写入本地文件；面板会自动刷新。点击持仓或自选中的股票/基金即可打开完整 AI 解读，首次主动点击后才生成，报告会缓存到本地并支持重新生成。插件只修改本地持仓数据，不执行真实交易。

### 面板与对话双向通道

面板与模型之间是双向实时的：

- **面板 → 对话**：点击持仓/自选触发解读时，面板把任务注入当前 Harness 会话。
- **对话 → 面板**：工具对持仓、自选、解读缓存、数据源策略、技能开关的修改，经服务端事件总线（`GET api/events`，SSE）即时推送到面板，无需等待轮询；模型还可以调用 `panel_navigate` 把面板切到指定标签页、聚焦某只股票的 K 线，或直接打开 AI 解读。
- 60 秒轮询保留为兜底；SSE 断线时 EventSource 自动重连。

### What-if 再平衡模拟

`simulate_rebalance` 基于本地持仓做**纯模拟**推演，不修改持仓文件、不下单：

- **trades 模式**：给定买卖列表（先卖后买、现金约束、超卖自动截断）；
- **targets 模式**：给定目标权重（占「持仓市值 + 可用现金」的百分比），自动折算为交易；
- 输出前后对比：总市值、现金、权重、top1/top3、HHI、分币种敞口，以及全部警告与口径说明（按最新价成交、不计滑点费用、跨币种未折算汇率等）。

### 面向模型的金融工具

| 领域 | 工具 | 能力 |
| --- | --- | --- |
| A 股 | `get_realtime_quote` · `get_stock_kline` · `search_stock` · `get_stock_list` | 行情、日/周/月 K 线、列表搜索 |
| A 股 | `get_market_overview` · `get_financial_indicators` · `get_sector_board` | 指数、财务指标、行业板块 |
| 港股 | `get_hk_quote` · `get_hk_kline` · `get_hk_list` | 港股报价、K 线和列表样本 |
| 美股 | `get_us_quote` · `get_us_kline` | Yahoo 优先、东财兜底的报价与 K 线 |
| 基金 | `get_fund_quote` · `get_fund_kline` · `get_fund_rank` | 净值、历史走势和分类排行 |
| 通用 | `search_symbol` · `get_stock_info` | 跨市场代码解析、个股档案与市值 |
| 研究 | `calculate_technical_indicators` · `get_macro_china` | MA/MACD/RSI/KDJ 与中国宏观序列 |
| 新闻 | `get_market_news` · `get_stock_news` · `web_search` | 市场快讯、个股新闻、免费网页搜索 |
| 研报 | `get_research_reports` · `get_research_report_detail` | 券商研报列表（机构/评级/时间）与正文 |
| 资料 | `save_research` · `list_research` · `get_research` · `update_research` · `add_research_note` · `archive_research` · `collect_research` · `sync_research` · `research_overview` | 投研资料库：入库、检索、追加观点、归档、从数据源批量收集、扫描本地文件同步、总览 |
| 资金/股东 | `get_money_flow` · `get_margin_trade` · `get_dragon_tiger` · `get_north_holding` · `get_shareholder` · `get_dividend` · `get_buyback` | 主力资金流、两融、龙虎榜、北向持仓、十大股东、分红、回购 |
| 研究 | `get_consensus` · `get_institution_rating` · `get_stock_score` · `get_chip_distribution` | 一致预期/目标价、机构评级、综合评分、筹码分布 |
| 事件/公告 | `get_stock_events` · `get_risk_events` · `get_disclosure_calendar` · `get_notice_list` · `get_market_calendar` | 个股事件、风险事件、财报披露日历、公告、新股/停复牌/交易日历 |
| 市场/选股 | `get_market_breadth` · `get_hot_rank` · `screen_stocks` · `get_minute_data` | 涨跌分布、热搜榜、智能选股（排行/条件/策略/标签/事件）、分时 |
| 通用 | `westock_capabilities` · `westock_call` | 列出 55 个 WeStock 能力；按 capability 或直接给 CLI argv 调用（只读白名单） |
| 组合 | `get_portfolio` · `analyze_portfolio` · `upsert_holding` · `import_holdings` · `remove_holding` · `save_position_analysis` | 持仓 CRUD、批量导入、盈亏、风险分析和解读缓存 |
| 模拟 | `simulate_rebalance` | What-if 再平衡推演（交易列表或目标权重），前后权重/HHI/分币种对比 |
| 面板 | `panel_navigate` | 对话中把金融面板切到指定标签页、聚焦代码或打开 AI 解读 |
| 自选 | `add_watchlist` · `remove_watchlist` · `get_portfolio_file` | 自选股/基金和本地文件管理 |
| 运维 | `probe_finance_sources` | 串行探测端点并生成 provider 降级顺序 |

## 快速开始

### 1. 安装并构建

需要 Node.js `^22.19`、`>=24.2`（dsh 的 `bin` 依赖 `import.meta.main`，24.0/24.1 会让 CLI 静默退出）：

```bash
cd dsn-finance-lab
npm install
npm run build
```

安装必须解析 peer 依赖：dsh 把服务定义包（`dsh-jobs`、`dsh-attachment`、`dsh-session-persistence` …）声明为实现包的 peer。仓库内 `.npmrc` 显式设置 `legacy-peer-deps=false`，否则本地安装不是完整的 dsh 运行时，profile 中每个条目都会 `failed to import`。

### 2. 先探测公开数据源

东财、腾讯、Yahoo 和 DuckDuckGo 都是公开源，可能受到网络波动、风控或限流影响。首次运行建议先探测，插件启动时会读取报告并优先使用健康的 provider：

```bash
npm run probe

# 指定输出和请求间隔
npx tsx scripts/probe_sources.ts \
  --out data/probe-report.json \
  --gap-sec 3

# 只探测某个 capability.provider
npx tsx scripts/probe_sources.ts --only kline.em_kline
```

报告默认写入 `data/probe-report.json`。全部公开源不可用时，行情工具会返回不可用信息；本地持仓 CRUD 仍然可以使用。

### 3. 接入 DeepSeek Harness

将当前项目目录注册到 `web` profile（`dsh plugin` 在 profile 目录里执行 pnpm；CLI 版本需与插件依赖一致，对本仓库即 `0.1.7-rc.2`）：

```bash
npx @deepseek-ai/dsh@0.1.7-rc.2 plugin \
  --profile web add /absolute/path/to/dsn-finance-lab
npx @deepseek-ai/dsh@0.1.7-rc.2 web
```

`dsh web` 等价于 `dsh --profile web`；profile 由第一个位置参数选择，其余参数转发给应用。

本地开发也可以直接运行（`scripts/dev_web.sh`，**多应用并行安全**）：

```bash
bash scripts/dev_web.sh
# 可选环境变量：DSH_HOME（默认 <repo>/.dsh-home）、DSH_PORT（默认 0 = OS 分配）、
#               DSH_PROFILE（默认 web）、DSH_NODE、WESTOCK_BIN、LLM_BASE_URL/LLM_MODEL
```

该脚本按顺序保证隔离：① 每个应用独立 `$DSH_HOME`（profile/session/存储/数据互不干扰）→
② 挑选支持 `import.meta.main` 的 Node（读 `.nvmrc`，挑不到直接报错而不是静默退出）→
③ 端口默认 `0` 由 OS 分配（避免与其他插件应用抢端口）→
④ 生成 `$DSH_HOME/dsn-finance.overlay.yml`（**插件依赖、dataDir、数据源与 LLM provider 一律写在 profile 层**，经 `--patch` 应用）→
⑤ `dsh plugin add` 后启动。

WeStock CLI 未安装时，行情/财报/资讯会回落到 HTTP 源，仅研报不可用；安装（pinned + SHA256 校验）：

```bash
npm run westock:install        # → <repo>/.dsh-home/bin/westock，脚本自动识别
```

如果需要使用开发期的绝对路径 overlay（只挂载宿主半，不含面板客户端 bundle）：

```bash
npx @deepseek-ai/dsh@0.1.7-rc.2 web --patch ./cordis.dev.yml
```

注册插件后，从 Harness 左下角的 **📈 金融面板** 打开 UI；模型工具会自动出现在工具列表中。

## 配置与数据

默认配置位于 `cordis.patch.yml`：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `cacheTtlSec` | `300` | provider 缓存时间 |
| `requestGapMs` | `3000` | 相邻公开请求的间隔 |
| `httpTimeoutMs` | `30000` | 单次请求超时 |
| `logLevel` | `info` | 日志级别（`debug`/`info`/`warn`/`error`）；结构化日志写入 `<dataDir>/logs/dsn-finance.jsonl`，可在面板接口页/`/api/logs` 查看 |
| `westock.enabled` | `true` | 是否启用 WeStock CLI 数据源（腾讯自选股，免鉴权） |
| `westock.binPath` | 空 → 自动探测 | CLI 路径（`$WESTOCK_BIN` → PATH → 常见安装位置） |
| `westock.timeoutMs` | `20000` | 单次 CLI 调用超时 |
| `westock.autoUpgrade` | `false` | 允许 CLI 自升级（默认关闭，保持 pinned 版本可复现） |
| `research.enabled` | `true` | 是否启用投研资料库 |
| `research.dir` | 空 → `<dataDir>/research` | 资料库根目录；正文落盘为 `<年>/<id>-<slug>.md`，可被宿主文件工具直接读写 |
| `dataDir` | `data` | 插件全部落盘数据的根目录（持仓/自选、探测报告、分析缓存、历史库、资料库、日志、provider/skill 策略、MCP 密钥） |
| `probeReportPath` | 空 → `<dataDir>/probe-report.json` | provider 探测报告 |
| `portfolioPath` | 空 → `<dataDir>/portfolio.json` | 本地持仓/自选文件 |
| `mcpSources` | 预置 妙想 / 盈米 | 外部 MCP 数据源列表（见「多来源数据」） |
| `panelOpen` | 未设置 | 是否打开金融面板（volatile，见下） |
| `panelDocked` | 未设置 | 是否默认停靠为侧栏页（volatile，见下） |

`dataDir` 的相对路径以插件包目录为基准。同一份源码被注册进多个 dsh profile 时，请在 profile 层把 `dataDir` 指到各自的目录（或给 `portfolioPath` / `probeReportPath` 绝对路径），否则几个 profile 会共用同一份数据。这些文件属于本地运行数据，不会被提交。

`panelOpen` / `panelDocked` 在 Config schema 中声明为 **volatile**：dsh 0.1.7 的配置面板只暴露 volatile 字段，并把它们的值写到 profile 用户层（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）。面板开关按钮经 `ctx.configForms` 读写该条目，因此重启后开关状态仍然保留；其余字段属于组合配置，改动后由 Loader 重新应用条目。

## 可用性测试

测试分两层：**功能正确性**（离线、可重复，必须全绿）与**数据源可用性**（真实网络，允许失败但标注原因）。

```bash
npm run build
npm run test:offline    # 离线功能正确性：解析/映射/持久化/校验/日志/registry/能力目录（99 条）
npm run test:westock    # WeStock 可用性（真实网络）：精选用例 15 条 + 能力全量扫描 55 项
npm run test:avail      # 全量数据源 + 资料库真实收集

# 只测试某个分组
npm run test:avail -- --group westock
# 可选分组：ashare、hk、us、tools、westock、search
```

详细结果与已知限制见 [docs/self-test-report.md](./docs/self-test-report.md)；优化方向见 [docs/analysis-report.md](./docs/analysis-report.md)。

## 数据源与边界

- 运行时不依赖 Python `akshare`；接口形状参考 [AkShare](https://github.com/akfamily/akshare) 源码，并在 `src/data/providers.ts` 中保留来源注释。
- A 股、港股、基金、宏观和新闻主要使用东方财富，部分行情使用腾讯；美股优先使用 Yahoo Finance，并以东方财富兜底；网页搜索使用 DuckDuckGo。
- WeStock（腾讯自选股 CLI，免鉴权）提供 A/港/美行情与 K 线、**券商研报**和公司简况，默认优先级高于东财；CLI 未安装时自动回落到 HTTP 源。
- 除上述能力外，WeStock 另接入 **55 个能力**（资金流、两融、龙虎榜、北向/南向、卖空、股东、分红、回购、一致预期、评级、评分、ESG、公告、事件、风险、停复牌、ETF、宏观、指数/板块、产业链、智能选股、期货、外汇、可转债…），见「WeStock 扩展能力」。
- provider 会按 capability 独立降级。公开源并不承诺稳定性或完整覆盖，返回结果应结合时间、市场状态和来源健康度解读。
- 本项目用于研究和组合记录，不构成投资建议；不连接券商，也不执行下单。

## 多来源数据（MCP）

除公开免费源外，可通过 `mcpSources` 接入需要凭证的外部数据源，其工具会被桥接进模型工具集，并显示在金融面板「接口」标签页。支持三类：

| kind | 说明 | 桥接后的工具名 |
| --- | --- | --- |
| `mcp-http` | Streamable HTTP MCP Server | `mcp__<name>__*` |
| `mcp-stdio` | 子进程 stdio MCP Server | `mcp__<name>__*` |
| `cli` | 遵循 `<command> mcp list/schema/call` 约定的 CLI | `<name>_list` / `_schema` / `_call` |

默认预置两个（需自备 token）：

- **妙想数据**（`mx`，`mcp-http`，东方财富）：A股/港股/美股/基金/债券/指数板块/宏观/新闻/公告的自然语言查询。
- **盈米**（`yingmi`，`cli`）：基金详情、风险与资产配置等能力，依赖全局安装的 `yingmi-skill-cli`。

Token 解析优先级：环境变量（`apiKeyEnv`，如 `EM_API_KEY`）→ 本地 `data/mcp-secrets.json`（不提交，见 `data/mcp-secrets.example.json`）→ 配置内联 `apiKey`。也可在面板「接口」页点 🔑 直接填写 token：写入 `data/mcp-secrets.json` 并**即时热重载**（断开旧连接、重新桥接工具，无需重启）。

## WeStock 扩展能力（腾讯自选股 CLI）

CLI 自带 40+ 子命令。为避免"插件设计把数据源用窄了"，这里用**表驱动的 capability 目录**
（`src/data/westock-capabilities.ts`）成建制接入，再加一个**通用 CLI 桥**兜底：

| 分组 | 能力（capability） |
| --- | --- |
| 行情 / 技术 | `minute` 分时 · `technical` 指标 · `chip` 筹码分布 |
| 市场 | `market_breadth` 涨跌分布 · `market_summary` 总览画像 · `market_lhb` 龙虎榜 · `ipo_calendar` 新股 · `connect_list` 陆股通 · `trade_calendar` 交易日历 |
| 指数 / 板块 | `index_list` · `index_constituent` · `sector_constituent` · `sector_valuation` · `sector_finance` · `sector_forecast` · `sector_oper` · `sector_info` |
| 资金 | `money_flow` · `margin_trade` · `block_trade` · `dragon_tiger` · `north_holding` · `south_holding` · `short_selling` · `disclosure_calendar` |
| 公司 / 研究 | `shareholder` · `dividend` · `buyback` · `consensus` · `institution_rating` · `stock_score` · `esg` |
| 资讯 / 事件 | `news_detail` · `notice_list` · `notice_detail` · `stock_events` · `risk_events` · `invest_calendar` · `suspension` |
| ETF / 宏观 / 其他 | `etf_overview` · `etf_nav` · `etf_holdings` · `macro_catalog` · `macro_indicator` · `industry_chain` · `futures_detail` · `forex_list` · `bond_detail` |
| 智能选股 | `screen_ranking` · `screen_condition` · `screen_strategy` · `screen_label` · `screen_event` |

* **新增一个能力 = 加一行 spec**：registry 目录、面板数据源页、能力目录、HTTP 路由、测试扫描全部自动生效。
* **不受目录限制**：`westock_call` 可直接执行任意只读 CLI 参数（如 `["fund","flow","sh600519"]`），
  白名单拒绝 `update/upgrade/config/login` 等写操作与 shell 元字符。
* **可用性**：`npm run test:westock` 会遍历整个目录真实调用（55 项），输出分组通过率与失败原因。
* **面板**：「发现」页展示涨跌分布、热搜股票/板块、机构龙虎榜。

典型投研链路：`screen_stocks` 初筛 → `get_realtime_quote`/`get_stock_kline` → `get_consensus`/`get_financial_indicators`
→ `get_money_flow`/`get_north_holding` → `collect_research` 沉淀研报 → `add_research_note` 记录观点。

## 数据源选择（多来源策略）

面板「数据源」页可按 capability 选择使用哪些 provider（`quote`/`kline`/`hk_*`/`us_*`/`web_search` 等常有多个来源共存）：多选、点击顺序即调用优先级，绿点=探测可用。选择保存到本地 `data/provider-policy.json` 并即时生效（用户选择优先于探测顺序）。妙想/盈米作为整体数据源在「接口」页开关。

## 本地历史库与 K 线事件

面板「K线」页可把日 K 线与事件落地到本地库并追加更新（`data/history/<code>.json`）：

- `sync_history`（工具）/ `POST api/history/sync`：抓取日 K 线（A股/港股/美股/基金）并按日期去重合并，股票同时把财报日期存为事件。
- `add_market_event` / `get_history` / `list_history`：追加分红/公告等自定义事件、读取、列出。
- K 线图上以虚线标注事件（财报=蓝、分红=绿），下方列出事件时间。

## 技能管理

面板「技能」页统一管理技能（类似工具）：本插件 playbook 技能可启用/停用（进入系统提示）；盈米的 11 个金融场景 skill（标准 SKILL.md）可勾选可见范围，写入 `remote-skill scope`。选择保存到 `data/skills-policy.json`。

## 项目结构

```text
src/                  插件服务、provider、模型工具和金融面板
src/panel-bus.ts      面板 ↔ 对话双向通道的事件总线（SSE 推送）
src/rebalance.ts      What-if 再平衡模拟引擎（纯函数，不改持仓）
src/mcp/              外部 MCP 数据源桥接（妙想 HTTP / 盈米 CLI）+ token 热重载
src/history/          本地历史库（K线/财报/分红）与同步
src/log.ts            结构化日志（JSONL，级别可配，替代原先静默的 catch）
src/data/westock.ts   WeStock CLI 数据源（Markdown 表格解析、symbol 映射、研报、通用 CLI 桥）
src/data/westock-capabilities.ts  WeStock 能力目录（表驱动）+ provider 工厂
src/tools/westock.ts  WeStock 工具集（资金/股东/研究/事件/选股 + westock_call 通用调用）
src/research/         投研资料库（Markdown 落盘 + 索引 + 收集/观点/归档）
skills/               财务分析、组合、策略、风控与研究团队 playbook
scripts/              provider 探测、可用性测试和本地 Web 启动脚本
cordis.patch.yml      Harness 插件注册与默认配置
```
