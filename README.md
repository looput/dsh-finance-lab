# DSH Finance

> 让 DeepSeek Harness 从“查一条行情”走向“看懂市场、管理组合、组织研究”。

[English README](./README.en.md) · [MIT License](./package.json)

DSH Finance 是一个面向 DeepSeek Harness 的金融插件：它把 A 股、港股、美股、基金、宏观数据和财经新闻接入模型，同时提供一个可停靠的本地金融面板。行情通过公开 HTTP 接口直连，持仓和自选股保存在本地 JSON 中，适合个人研究、组合复盘和多智能体协作。

<img width="1331" height="804" alt="DSH Finance panel" src="https://github.com/user-attachments/assets/3fa063b1-22ef-404b-8fb9-1d230b7e66c0" />

## 个人投资首页（MVP）

新增建档 → 投资理由/验证指标/证伪条件 → 有来源的周复盘 → 用户复核流程。持仓导入和观点修改须到首页预览确认；面板任务先明确选择目标会话。收益按原币展示，缺汇率不合并。当前周复盘需主动触发，尚非后台自动调度。

面板导航现分为「我的工作台 / 市场研究 / 数据与设置」，首页采用概览、档案与判断、每周复盘、待确认四个分区。正确性回归可运行 `npm run test:personal`、`npm run test:regressions` 和 `npm run test:offline`；交付边界与验证说明见 [个人首页说明](docs/personal-home-mvp.md)。

**安全变更：** API默认仅本机访问。远程部署需认证代理、受保护的后端端口及 `DSH_FINANCE_TRUSTED_ORIGIN` 配置；不能将Origin检查当作登录鉴权。详见[实现范围、指标定义与验收边界](docs/personal-home-mvp.md)。以下旧功能说明中的直接写入和跨币种模拟，以此处新约束为准。

## 成长（规划·学习·复盘）

Agent 驱动的成长闭环：不设课程目录、不设打卡关卡——学什么、什么时候学、先修什么，全部由诊断引擎从你自己的数据里得出，再由 Agent 在对话里执行。

- **规划先于投资**：家庭财务健康度（应急金/储蓄率/负债收入比/保障/目标可行性）输出排序后的修复项，未完成规划不讲选股课；`family_plan_update` 由 Agent 对话式访谈逐项写入（一次一题、先说明用途），敏感数据仅保存在本机 `data/growth.json`。
- **证据 → 诊断 → 对话**：`growth_diagnose` 基于本地持仓、观点指标、复盘覆盖率与决策日记，输出带证据的缺口清单（≤8 条、按优先级）；面板首页「成长」区只读展示四柱评分、连续周与 Agent 诊断出的下一步卡片，点击即回到对话执行。
- **微课一次一节**：内置 6 大轨道 23 节要点式教材（`lesson_get` 取材，3 要点 + 1 检验题），`lesson_complete` 判分 ≥80 记 mastered；讲完回到投资主线，绝不打断。
- **过程型激励**：只统计遵循计划、复盘覆盖、证伪条件等过程指标——不评价收益、不鼓励交易、不承诺回报。四柱评分（认知/规划/纪律/资产）与等级仅作 Agent 记忆，驱动每月成长复盘（产出正文落资料库 kind=review 后 `growth_review_mark` 记连续周）。

回归覆盖见 `npm run test:offline` 批次19（教材完整性、判分边界、健康度阈值、等级边界、诊断规则与档案存储）。

## 你可以用它做什么

- **跨市场看行情**：A 股、港股、美股和公募基金的报价、K 线、列表与代码解析。
- **快**：行情优先走本地 WeStock CLI——批量取（一次调用拿多只标的）、并行调用、结果缓存与陈旧复用、失败即熔断；HTTP 源保留串行间隔做回落。面板首屏从「逐只串行 + 死等超时」降到秒级。
- **从数据到判断**：本地计算 MA、MACD、RSI、KDJ；查询财务指标、市场指数和行业板块。
- **跟踪市场叙事**：读取中国 CPI/PPI/PMI/GDP/M2、市场电报、个股新闻，并通过 DuckDuckGo 免费搜索网页。
- **读券商研报**：经 WeStock CLI（腾讯自选股，免鉴权）拉取个股研报列表与正文（机构、评级、时间）。
- **沉淀投研过程**：研报、财报、资讯与个人观点统一进「投研资料库」，必带来源与时间、可关联标的与观点，支持持续收集、追加批注与归档；决策日记、学习笔记与月度复盘也可按 `decision`/`learn`/`review` 类型入库。
- **让 Agent 规划你的成长**：新手教学、家庭财务体检、每月成长复盘都由 Agent 从证据诊断后在对话里推进——`growth_state`/`growth_diagnose`/`lesson_get`/`lesson_complete`/`family_plan_*`/`growth_review_mark` 七个工具支撑。
- **让 Agent 替你盯披露**：跟踪机构 13F（SEC EDGAR 官方）、美国国会申报（Bargo 免费档 + Disclosed Capitol 备用）、A 股名私募十大流通股东——`follow_*` 八个工具完成建档、拉取、两期 diff、与我对比、纸面复刻与简报；新披露由 6 小时一次的后台检查按披露主键去重入队，解读仍在会话里做。
- **资料与本地文件双向联动**：正文是工作区里的 Markdown（`<vault>/<年>/<id>-<slug>.md`），目录被实时监听——在编辑器/文件工具里新建或改动文件会自动回灌索引，面板里改正文也会写回同一个文件。
- **对话 ↔ 面板打通**：对话里收集/产出的资料自动落库并实时出现在「资料」页（顶部回执 + 标「对话」来源）；资料详情的「问 Agent」「让 Agent 整理」会把上下文拼成提问直接发进当前会话，Agent 再用 `add_research_note` / `update_research` 回写资料库，形成「对话收集 → 资料沉淀 → 面板维护 → 继续追问」闭环。
- **管理自己的组合**：维护持仓和自选股，计算市值、盈亏、资产类型/市场分布，以及 top1、top3 和 HHI 集中度。
- **用研究团队拆解问题**：内置行情、基本面、宏观、基金、消息和风险管理 playbook，可交给 DSH subagent 并行研究后汇总。

## 核心体验

### 一个面板，十二个视角

从侧边栏打开 **📈 金融面板**，可在以下标签页之间切换：

| 标签页 | 内容 |
| --- | --- |
| 面板宽度 | 默认 480px，左边缘可拖动（360–820），自动记忆 |
| 行情 | 指数、自选股走势、迷你 K 线和实时刷新 |
| 市场 | 领涨/领跌行业板块，快速定位当日风险 |
| 持仓 | 持仓盈亏、组合市值、股票/基金配置和集中度；穿透体检（基金重仓展开成真实个股暴露，HHI/有效个股/重复暴露排行，伪分散一目了然） |
| 基金 | 开放式基金排行（近1月/3月/6月/1年/3年/今年来周期排序）、净值与净值日期（T+1 标注）和加入自选 |
| K线 | 本地历史库日 K 线，财报/分红/自定义事件标记 |
| 宏观 | CPI、PPI、PMI、GDP、货币供应量及趋势 |
| 快讯 | 全球财经电报，以及按持仓/自选筛选的个股新闻 |
| 资料 | 投研资料库：按时间/标的分组浏览，按类型/状态/标的/关键词检索；详情为「元数据 + 正文」双栏，可编辑正文并写回本地文件、追加带时间戳的观点、归档；顶部显示本地目录与监听状态，可一键同步 |
| 深度 | 个股深度档案：一致预期/评分/ESG/机构评级/资金流向/融资融券/龙虎榜/股东/分红回购/风险事件/公告/产业链，一次并发取回；基金深度档案（面板可切换个股/基金）：基金经理/资产配置/规模申赎/同类排名/重仓持仓/本地风险指标/基准对比 |
| 发现 | 市场情绪与注意力：涨跌分布、热搜股票/热门板块、机构龙虎榜（WeStock） |
| 数据源 | 按 capability 选择 provider，选择顺序即调用优先级 |
| 技能 | 本地 playbook 与盈米金融场景 skill 的启停管理 |
| 接口 | 数据源健康状态与当前 provider、数据源性能（缓存命中率/平均耗时/各源成败与耗时/熔断列表）、MCP 外部源开关 |
| 顶部铃铛 | 观点触发式提醒：行情异动（默认 ±5%）与「观点需复核」（默认 ±8%），点击直达 AI 解读 |

面板开关（`panelOpen` / `panelDocked`）是 volatile 配置：优先写回 profile；若当前 profile 不可写（本版本 `configForms.set` 会返回不可写），客户端自动退回 localStorage（`dsh-finance:panelPrefs`），并在面板顶部提示，保证面板打得开、刷新后状态保留。默认以**浮层抽屉**打开（`dev_web.sh` 生成 `panelDocked: false`；停靠页需要宿主 dock 容器，未选择工作区时可能不渲染），可在面板内一键切换为停靠。

持仓截图也可以交给 Agent 识别，再通过 `import_holdings` 批量写入本地文件；面板会自动刷新。点击持仓或自选中的股票/基金即可打开完整 AI 解读，首次主动点击后才生成，报告会缓存到本地并支持重新生成。插件只修改本地持仓数据，不执行真实交易。

### 面板与对话双向通道

面板与模型之间是双向实时的：

- **面板 → 对话**：点击持仓/自选触发解读时，面板把任务注入当前 Harness 会话；首页各卡片的「交给对话执行 / 在对话中复盘」把带证据的指令直接发进对话（投递失败会明示并回退剪贴板）。
- **面板 → Agent 上下文**：面板把用户当前所看（标签页 + 聚焦代码）实时上报（`POST api/panel-focus`，内存态），模型用 `panel_state` 读取——回答「我该看哪」或引导导航前先对齐用户实际视图。
- **对话 → 面板**：工具对持仓、自选、解读缓存、数据源策略、技能开关、成长档案的修改，经服务端事件总线（`GET api/events`，SSE）即时推送到面板，无需等待轮询；`panel_navigate` 支持 `note`（面板顶部一句话解释这次导航）与 `anchor`（页内锚点：首页 growth/journal/reviews/approvals、持仓 lookthrough 滚动到位）。
- **Agent 活动可见**：每次工具调用的开始/结束经总线推送，面板头部显示「Agent · 正在做什么」胶囊；Agent 改了成长档案/落了资料，对应分区即时刷新并给出回执（不在首页时由顶部回执承接，一键跳转）。
- **任务会话可区分**：会话选择器不再罗列裸 id——按宿主标题展示（无标题回退目录名/短 id），按「今天 / 昨天 / 近 7 天 / 更早」归类分组、支持标题/ID/目录搜索，运行中会话带状态点，子代理单列在末尾；每次成功投递在本机记一笔（行内显示「已投递 N 次」），绑定选择跨刷新持久化（均只存 localStorage，不出本机）。
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
| 基金 | `get_fund_quote` · `get_fund_kline` · `get_fund_rank` · `get_fund_holdings` | 净值（含净值日期/T+1 说明）、历史走势、周期排序与分页的分类排行、重仓持仓 |
| 基金研究 | `fund_dossier` · `calculate_fund_metrics` · `compare_funds` · `analyze_fund_overlap` | 基金深度档案（经理/规模申赎/同类排名/重仓/风险/基准对比）、收益与风险指标（年化/波动/回撤/夏普/卡玛 + 超额/Beta/相关/跟踪误差）、多基金相关性、持仓重叠穿透 |
| ETF | `get_etf_overview` · `get_etf_nav` · `get_etf_holdings` | 场内 ETF 折溢价与规模、净值历史、重仓持仓（WeStock 能力） |
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
| 穿透 | `portfolio_lookthrough` · `check_new_position` | 全组合穿透体检（HHI/有效个股/重复暴露排行，伪分散检测）；买入前边际检查（前后对比 + 重叠明细，回答「是分散还是同一个赌注」） |
| 模拟 | `simulate_rebalance` | What-if 再平衡推演（交易列表或目标权重），前后权重/HHI/分币种对比 |
| 成长 | `growth_state` · `growth_diagnose` · `lesson_get` · `lesson_complete` · `family_plan_get` · `family_plan_update` · `growth_review_mark` | 证据驱动的成长闭环：状态装载、带证据的缺口清单、微课取材与判分、家庭财务规划读写（全本地）、月度复盘标记 |
| 面板 | `panel_navigate` · `panel_state` | 对话中把金融面板切到指定标签页、聚焦代码或打开 AI 解读（note 一句话解释 + anchor 页内锚点滚动，含追踪页 targets/jobs/briefs/shadow）；读取用户当前所看的焦点视图 |
| 追踪 | `follow_list` · `follow_add` · `follow_remove` · `follow_fetch` · `follow_diff` · `follow_vs_holdings` · `follow_replicate` · `follow_note` | 本地追踪档案：名字解析建档（EDGAR CIK / 国会成员 slug / 受控别名）、拉取最新披露并生成两期 diff、与我的持仓对比（未映射如实计数）、纸面复刻（纯模拟）、简报落库与资料库同步 |
| 自选 | `add_watchlist` · `remove_watchlist` · `get_portfolio_file` | 自选股/基金和本地文件管理 |
| 运维 | `probe_finance_sources` | 串行探测端点并生成 provider 降级顺序 |

## 快速开始

### 1. 安装并构建

需要 Node.js `^22.19`、`>=24.2`（dsh 的 `bin` 依赖 `import.meta.main`，24.0/24.1 会让 CLI 静默退出）：

```bash
cd dsh-finance-lab
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

将当前项目目录注册到 `web` profile（`dsh plugin` 在 profile 目录里执行 pnpm；CLI 版本需与插件依赖一致，对本仓库即 `0.2.0-rc.2`）：

```bash
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin \
  --profile web add /absolute/path/to/dsh-finance-lab
npx @deepseek-ai/dsh@0.2.0-rc.2 web
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
④ 生成 `$DSH_HOME/dsh-finance.overlay.yml`（**插件依赖、dataDir、数据源与 LLM provider 一律写在 profile 层**，经 `--patch` 应用）→
⑤ `dsh plugin add` 后启动。

WeStock CLI 未安装时，行情/财报/资讯会回落到 HTTP 源，仅研报不可用；安装（pinned + SHA256 校验）：

```bash
npm run westock:install        # → <repo>/.dsh-home/bin/westock，脚本自动识别
```

如果需要使用开发期的绝对路径 overlay（只挂载宿主半，不含面板客户端 bundle）：

```bash
npx @deepseek-ai/dsh@0.2.0-rc.2 web --patch ./cordis.dev.yml
```

注册插件后，从 Harness 左下角的 **📈 金融面板** 打开 UI；模型工具会自动出现在工具列表中。

## 配置与数据

默认配置位于 `cordis.patch.yml`：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `cacheTtlSec` | `300` | provider 缓存时间 |
| `requestGapMs` | `3000` | 相邻公开请求的间隔 |
| `httpTimeoutMs` | `30000` | 单次请求超时 |
| `logLevel` | `info` | 日志级别（`debug`/`info`/`warn`/`error`）；结构化日志写入 `<dataDir>/logs/dsh-finance.jsonl`，可在面板接口页/`/api/logs` 查看 |
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

`panelOpen` / `panelDocked` 在 Config schema 中声明为 **volatile**：dsh 0.2.0 的配置面板只暴露 volatile 字段，并把它们的值写到 profile 用户层（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）。面板开关按钮经 `ctx.configForms` 读写该条目，因此重启后开关状态仍然保留；其余字段属于组合配置，改动后由 Loader 重新应用条目。

## 可用性测试

测试分两层：**功能正确性**（离线、可重复，必须全绿）与**数据源可用性**（真实网络，允许失败但标注原因）。

```bash
npm run build
npm run test:offline    # 离线功能正确性：解析/映射/持久化/校验/日志/registry/能力目录/K线数学/请求校验
npm run test:quant      # 量化金样本：确定性回测/稳健性/搜索/策略库/分币种采样（手工推演基准）
npm run test:personal   # 个人工作台：档案、观点版本、每周证据任务
npm run test:regressions # 跨模块回归（总线/确认/历史/分析引用契约等）
npm run test:ui         # UI 冒烟（真实浏览器）：无浏览器/无 DSH_UI_URL 时诚实 SKIPPED
npm run test:westock    # WeStock 可用性（真实网络）：精选用例 + 能力全量扫描
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

## 命令行方式使用 WeStock

插件内部就是「spawn `westock` 二进制 + 解析 Markdown 表格」，因此可以直接在终端/Agent bash 里敲：

```bash
./scripts/westock.sh quote sh600519              # 透传原生子命令（输出 CLI 原文）
./scripts/westock.sh kline sh600519 --period day --limit 10
./scripts/westock.sh fund flow sh600519 --json   # 表格解析成 JSON
./scripts/westock.sh --cap consensus --args '{"code":"600519"}'   # 走能力目录：缓存 + 多源回落 + JSON
./scripts/westock.sh --list --group 研究          # 能力目录
./scripts/westock.sh --status                     # 二进制与版本
npm run westock -- quote sh600519                 # 等价写法
```

- 二进制定位：`--bin` / `WESTOCK_BIN` / `<包>/.dsh-home/bin/westock` / `~/.westock/bin/westock`；未安装时提示 `npm run westock:install`。
- 超时用 `WESTOCK_TIMEOUT_MS` 控制（默认 20000）。
- Agent 侧不需要 shell：用工具 `westock_call`（传 `argv` 或 `capability+args`）即可，同样是只读白名单。


## 追踪（机构 13F / 国会申报 / A 股名私募）

对话里的「盯住巴菲特 / 跟着议员买 / 看看冯柳买了什么」由 Agent 用 `follow_*` 系列工具推进；面板新增 **追踪** 页（`tab=follow`，只读展示 + 任务卡投递回对话），数据全存本机 `data/follow.json`（原子写、损坏拒绝覆盖）。

- **默认对象**：首次启动自动预置三个样本——Berkshire Hathaway（13F）、Nancy Pelosi（国会申报）、冯柳（十大流通股东），与提示词示例一致；`seededAt` 一次性标记，**删除后不复活**，已有档案只补标记不注入。
- **数据源**：
  - 机构持仓 → SEC EDGAR 官方（免费，带合规 UA）：`submissions/CIK*.json` 找 13F-HR/13D/13G → information table XML 解析（容忍 `ns1:` 前缀与 putCall 期权行）→ `company_tickers.json` 发行人名→代码唯一映射（歧义留空）；13D/13G 从同一 submissions 里发现（举牌信号）。名字→CIK 走 EDGAR company search（atom），多候选时让 Agent 带 CIK 重试——**没有固定名人表**。
  - 国会申报 → Bargo 免费档（keyless 30 req/日、100 行/日、滚动 3 个月窗口）为主，失败自动试 Disclosed Capitol 备用源（需 `DISCLOSED_CAPITOL_API_KEY`，未配置则明确报不可用）；金额按申报区间展示，不做精确化。
  - A 股名私募 → `get_shareholder` 十大流通股东扫描 + **受控别名表**（冯柳→邻山1号 等公共子串；人物与产品户名非一一对应，命中需人工确认）。
- **SEC 访问合规**：EDGAR 的 User-Agent 必须声明身份与联系方式（否则 403「未声明的自动化工具」）。默认 UA 带仓库地址作联系方式，部署者可用 `DSH_SEC_EDGAR_UA` 覆盖为含邮箱的 UA（SEC 官方格式 `AppName admin@example.com`）；403 的报错信息会直接给出这条修复指引。
- **新鲜度徽标**（按最近披露日计算）：`fresh` / `normal` / `stale` / `none`；阈值 = 披露周期 + 合理延迟（国会 45 天、13F 与名私募 130 天）。所有工具返回都强制携带延迟与覆盖边界（13F ≈45 天、Stock Act 30–45 天、季报股东 1.5–4 个月），解读必须引用具体数字与披露日期。
- **新披露发现**：6 小时一次的后台 tick 只查提交列表（克制请求），按「对象+组+披露主键」幂等入队（`jobs`，只读状态卡，click 投递回会话触发解读，不自动刷屏、不自动聊天）；`follow_fetch` 拉到新期才记快照，重复拉取幂等。
- **纸面复刻**：按最新 13F 市值等比分配本金（≤50 仓），入场价取披露日附近日K（取不到留空不编数），现价一次批量报价；收益只对已定价部分计算并标注缺价行；`stop` 归档。不触达真实账户，不构成投资建议。
- **联动**：档案变更经总线 `kind=follow`（target/snapshot/job/brief/shadow）→ 面板追踪页即时刷新 + 顶部回执；`panel_navigate(tab=follow, anchor=targets|jobs|briefs|shadow)` 页内定位；成功拉取/解读给成长区记一次活动痕迹（`markActivity`，无回执）。
- **验证**：`scripts/test_offline.ts` 批次21（604 项断言，含 8 工具端到端 + `GET /follow` 路由）。
