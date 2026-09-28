# dsn-finance 优化分析报告（金融 + Agent 方向）

目标：把 `dsn-finance` 从「能拉行情的插件」升级为**服务个人投资者的投研 / 投顾超级应用**——
数据接得进来、过程留得下来、结论沉淀得住、且能被 Agent 持续调用与迭代。

---

## 1. 现状盘点

| 层 | 现有能力 | 主要问题 |
| --- | --- | --- |
| 数据接入 | HTTP JSONP 三大家族（东财 / 腾讯 / Yahoo）、DuckDuckGo 搜索、Yingmi MCP 数据源 | ① 只有「行情 + 新闻 + 基本面」三板斧，**缺券商研报**；② 东财单点故障即整条能力不可用；③ 无 CLI/本地数据源通道 |
| 可观测性 | 无 | **零日志**：`catch {}` 遍地，状态文件损坏、provider 失败、路由 500 全部静默；排障靠猜 |
| 状态与资产 | 持仓/自选 JSON、历史 K 线、分析缓存、技能策略 | 落 `<packageRoot>/data`（多 profile 共用一份），**多应用并行会互相污染** |
| 交互 | 面板 9 个 tab + 8 个 Agent 工具 | 「研报/财报/观点」这类**过程资料无处安放**，Agent 每次会话从零开始 |
| 运行环境 | `restart_web.sh` 固定 3080、用系统 node | 本机多个 dsh 插件应用并行时：端口冲突、profile 共用、node 版本不一致（24.0/24.1 会静默退出） |

结论：数据链路与交互链路都还停留在「查询型工具」，没有形成**资料 → 观点 → 决策 → 复盘**的闭环。

---

## 2. 面向目标的优化方向

### P0 — 先让系统可信（本次已完成）

1. **日志先行**：`src/log.ts` 结构化 JSONL 日志（`<dataDir>/logs/dsn-finance.jsonl`），级别可配，附 scope/字段/堆栈；
   所有原 `catch {}` 改为「打日志 + 明确错误」，路由 500、provider 失败、状态文件损坏、Yingmi CLI 缺失全部留痕。
   —— 这是后续一切优化的前提：没有日志就无法判断"数据源挂了"还是"代码错了"。
2. **锁 Node 版本**：`.nvmrc`(22.22.2) + `engines` + `dev_web.sh` 自动挑选支持 `import.meta.main` 的 node，挑不到就**报错退出**而不是静默。
3. **多应用隔离**：每个应用各自 `$DSH_HOME`（默认 `<repo>/.dsh-home`）、各自端口（默认 `0` = OS 分配）、
   `dataDir` 指向 `$DSH_HOME/data`、插件依赖与 LLM provider 一律写在 profile 层（`--patch` 生成的 overlay）。

### P1 — 数据接入：新增 WeStock（本次已完成）

`westock` 是腾讯自选股的开源 Go CLI（免鉴权、公开网关），补齐了现有 HTTP 源的三大缺口：

| 能力 | 新增 provider | 说明 |
| --- | --- | --- |
| `quote` / `hk_quote` / `us_quote` | `ws_quote` / `ws_hk_quote` / `ws_us_quote` | A/港/美统一行情，**默认优先级置于东财之前**（东财失败自动回落） |
| `kline` / `hk_kline` / `us_kline` | `ws_*` | 日/周/月线，返回时间统一升序（东财/Yahoo 口径一致，避免 sparkline 反向） |
| **`research_report`（新增能力）** | `ws_research` | **券商研报列表**（标题/机构/评级/时间/ID）+ 正文，投研资料库的主素材 |
| `stock_news` | `ws_news` | 个股资讯 |
| `financials` / `stock_info` / `symbol_search` | `ws_financials` / `ws_profile` / `ws_search` | 三大报表、公司简况、跨市场代码解析 |

设计取舍：CLI 输出是 Markdown 表格 → 写了 `parseMarkdownTables()` 作为唯一解析入口（可单测）；
二进制版本 **pinned + SHA256 校验 + 关闭自升级**，保证可复现；未安装时 provider **fail fast**，registry 自动回落 HTTP 源。

#### 不止"补几个接口"：成建制接入 CLI 的 55 个能力

第一轮只用了 10 个命令（行情/K线/研报/资讯/财报/简况/搜索），而 CLI 实际提供 40+ 子命令。
为避免"插件设计把数据源用窄了"，改为**表驱动能力目录**（`src/data/westock-capabilities.ts`）：

| 分组 | 能力 |
| --- | --- |
| 行情/技术 | `minute` 分时 · `technical` 指标 · `chip` 筹码 |
| 市场 | `market_breadth` 涨跌分布 · `market_summary` 画像 · `market_lhb` 龙虎榜 · `ipo_calendar` · `connect_list` 陆股通 · `trade_calendar` |
| 指数/板块 | `index_list/constituent` · `sector_constituent/valuation/finance/forecast/oper/info` |
| 资金 | `money_flow` · `margin_trade` · `block_trade` · `dragon_tiger` · `north_holding` · `south_holding` · `short_selling` · `disclosure_calendar` |
| 公司/研究 | `shareholder` · `dividend` · `buyback` · `consensus` · `institution_rating` · `stock_score` · `esg` |
| 资讯/事件 | `news_detail` · `notice_list/detail` · `stock_events` · `risk_events` · `invest_calendar` · `suspension` |
| ETF/宏观/其他 | `etf_overview/nav/holdings` · `macro_catalog/indicator` · `industry_chain` · `futures_detail` · `forex_list` · `bond_detail` |
| 智能选股 | `screen_ranking/condition/strategy/label/event` |

* **新增能力 = 加一行 spec**：registry 目录、面板数据源页、能力目录、HTTP 路由、可用性扫描自动生效。
* **通用 CLI 桥 `westock_call`**：目录外的子命令也能直接执行（只读白名单，拒绝 `update/config/login` 与 shell 元字符），
  保证"CLI 升级了新命令，插件不会被卡住"。
* 面板新增「发现」页：涨跌分布（情绪温度）+ 热搜股票/板块 + 机构龙虎榜。
* 对上游瞬时故障（`service error`/超时）加一次重试；空结果带上游原因（如"区间内未上龙虎榜"）。

### P2 — 投研过程资料管理（本次已完成）

`src/research/store.ts`（Research Vault）+ 9 个 Agent 工具（含 `sync_research`）+ 面板「资料」tab：

* **不做孤岛**：`source`（来源）与 `occurredAt`（资料时间）**必填**；可关联 `codes`（标的）、`opinion`（一句话观点）、`tags`。
* **落在工作区**：正文是 `<vault>/<年>/<id>-<slug>.md`，
  结构固定为「YAML frontmatter（id/title/source/date/status/codes/tags/summary/opinion）+ 正文 + `## 观点与批注`」，
  `index.json` 只是可重建索引 —— 宿主的 file/grep 技能、用户手动编辑都能直接参与，**不被插件锁死**。
* **双向联动（本次补强）**：目录递归监听 + 防抖，`syncFromDisk()` 把外部新建/编辑/删除的 Markdown 合并回索引
  （无 id 的文件认领后回写 id，保证幂等）；面板「编辑正文」写回同一文件；删除条目连文件一起删，不留孤儿。
  面板「资料」tab 因此从「只读索引」变成「工作区文件的读写视图」。
* **性能：以 WeStock 为主干（本次补强）**
  - 批量优先：`quotes_batch` 一次 CLI 调用拿 N 只标的（面板首屏 16 只 → 1 次调用）；
    指数改走 `ws_indices`，研报/资讯/技术/资金等本来就是 WeStock 能力。
  - 分源调度：WeStock 是本地子进程 → 并发闸门（默认 6）；HTTP 源 → 串行间隔（默认 800ms，原 3s）。
  - 缓存与容错：结果缓存 + 过期后 SWR（先出画面后刷新）→ 同 key 并发合并 → 失败短期缓存 → 连续失败熔断。
    三项叠加把「首屏 70s（大半在等不可达的 Yahoo 超时）」降到 4.3s，二次刷新 0.02s。
  - 统一市场路由 `routeCode()`：`sh515080` 这类带前缀代码此前被判成美股，直接打到不通的 Yahoo；
    现在按前缀/后缀/位数判定，ETF 走 A 股、基金走基金源。
  - 可观测：`/api/stats` 给出每个 provider 的成功/失败/平均耗时与熔断列表，面板页脚显示命中率与平均耗时。
* **对话 ↔ 面板闭环（本次补强）**：
  - 对话侧：每轮系统提示动态注入「资料库现状」（总数/状态分布/来源渠道/最近 10 条含 id 与观点），Agent 知道已沉淀什么，
    直接按 id 续维护；规则要求对话里收集/产出的内容必须落库并回一句落库路径。
  - 面板侧：Agent 落库经 SSE 推送（`origin=chat`）后顶部出现回执条，可一键跳到「资料」。
  - 反向：资料详情的「问 Agent」/ 顶部「让 Agent 整理」把上下文拼成提问，经宿主会话服务（`sessions` + `conversation`）
    直接发进当前会话，Agent 再用 `add_research_note` / `update_research` 回写资料库。
  - 每条资料带 `origin`（chat / panel / file），能区分「对话沉淀」「我手动存」「外部文件同步」。
* **持续收集整理**：`collect_research`（研报/资讯批量入库，按「标题+时间」去重）、
  `add_research_note`（带时间戳追加观点，不覆盖历史）、`archive_research`（inbox → active → archived 归档流）。
* **可扩展**：kind 开放枚举（report/filing/note/news/other），tags 自由，未来接 PDF 解析、估值模型、预警规则都不需要改结构。
* **人机交互**：面板可筛选/搜索/查看详情/追加观点/归档；Agent 侧保存/收集后通过 SSE **实时刷新面板**。

### P3 — 后续建议（本次未做，按 ROI 排序）

1. **研报正文结构化**：`ws_research` 已能拿到正文，下一步抽「评级/目标价/盈利预测/风险提示」字段，供估值与对比。
2. **标的维度聚合视图**：以 `codes` 为轴自动汇总「行情 + 财报 + 研报 + 我的观点时间线」，形成个股投研档案（vault 已有数据基础）。
3. **观点触发式提醒**：把 `opinion` 变成可验证假设（如「库存周期见底」），用历史/财报数据定期校验并回写 note。
4. **自动归档规则**：`inbox` 超 N 天未整理 → 提示归档；按标的/时间自动打标签。
5. **检索增强**：资料量上来后加全文索引（SQLite FTS5）或向量检索，避免每次 `list` 全量扫。
6. **投顾视角**：在持仓分析里引入 vault 中该标的的观点与研报，让「解读」带记忆、可迭代。
7. **回补数据源**：`web_search` 目前不可用（DuckDuckGo Instant Answer 已废弃、Python `ddgs` 未安装），
   建议 `pip install ddgs` 启用 `py_web_search`，或接入新的合规检索源。

---

## 3. 架构影响（改动落点）

```
src/log.ts                  # P0 结构化日志（新增）
src/data/westock.ts         # P1 WeStock CLI 接入 + Markdown 表格解析 + 通用 CLI 桥（新增）
src/data/westock-capabilities.ts  # P1 55 个能力的表驱动目录与 provider 工厂（新增）
src/tools/westock.ts        # P1 WeStock 工具集：资金/股东/研究/事件/选股 + westock_call（新增）
src/research/store.ts       # P2 资料库（新增）
src/research/tools.ts       # P2 Agent 工具 + 收集逻辑（新增，HTTP 路由复用同一函数）
src/data/{providers,registry,service}.ts   # 注册新能力/优先级/日志
src/server-routes.ts        # /research*、/westock、/logs 路由
src/client/index.tsx        # 「资料」tab（筛选/详情/观点/归档/收集）
scripts/{dev_web.sh,install_westock.sh,restart_web.sh}  # 隔离 + 版本锁 + CLI 安装
scripts/test_{offline,westock,availability}.ts          # 分层自测
```

兼容性：不改动既有 provider 的对外行为；`dataDir` 仍可通过配置覆盖；其他 dsh 应用不受 `$DSH_HOME` / 端口影响。
