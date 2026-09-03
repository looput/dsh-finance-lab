# DSN Finance 架构分析与金融方向优化建议

> 分析基线：`master @ 4bf3ea5`（2026-08-21）。代码规模：`src/` 约 4,955 行 TypeScript + React，`skills/` 13 个 SKILL 包（756KB），`scripts/` 8 个脚本。

---

## 一、项目定位

DSN Finance 是 **DeepSeek Harness（DSH）的金融插件**，基于 cordis 插件框架，把 A 股 / 港股 / 美股 / 基金 / 宏观 / 新闻数据接入模型工具链，并提供一个可停靠的本地 React 金融面板。核心主张：行情直连公开 HTTP 接口（不依赖 akshare/Python 运行时）、持仓本地 JSON 化、研究流程 Skill 化。

## 二、架构分层

```
┌─────────────────────────────────────────────────────────────┐
│ 客户端 src/client/index.tsx (1098行，单文件 React)            │
│  10 个 Tab：行情/市场/持仓/基金/宏观/快讯/K线/数据源/技能/接口    │
│  通过 slots 注入侧边栏；60s 轮询 /live                        │
├─────────────────────────────────────────────────────────────┤
│ HTTP API src/server-routes.ts                                │
│  /plugins/dsn-finance/api/*（live/market/macro/news/…）       │
│  POST /analysis → agent.followup() 注入解读任务               │
├─────────────────────────────────────────────────────────────┤
│ 模型工具 src/tools/register.ts + src/history/tools.ts         │
│  ~30 个 defineTool：行情/基本面/宏观/新闻/组合CRUD/历史库        │
├─────────────────────────────────────────────────────────────┤
│ 领域服务 src/data/service.ts                                  │
│  市场路由(A/HK/US/基金)、技术指标(MA/MACD/RSI/KDJ)、组合分析    │
├─────────────────────────────────────────────────────────────┤
│ Provider 注册表 src/data/registry.ts                          │
│  capability×provider 矩阵、探测排序、用户 policy、TTL 缓存、限流 │
├─────────────────────────────────────────────────────────────┤
│ 数据提供者 src/data/providers.ts (966行，~27 个 provider)      │
│  东财(em_*) / 腾讯(tx_*) / Yahoo(yahoo_*) / Python搜索(py_*)  │
├─────────────────────────────────────────────────────────────┤
│ 持久化（本地 JSON，原子写）                                     │
│  portfolio.json / analysis-cache.json / history/*.json       │
│  provider-policy.json / skills-policy.json / mcp-secrets.json │
├─────────────────────────────────────────────────────────────┤
│ 扩展面                                                         │
│  Skills：13 个 SKILL.md playbook（ctx.skills 门控加载）         │
│  MCP 桥接：mcp-http / mcp-stdio / cli 三类外部源 + token 热重载  │
└─────────────────────────────────────────────────────────────┘
```

**关键数据流**：
- 面板刷新：`useLive()` 每 60s → `GET /live` → `buildLiveSnapshot()` 对自选+持仓**逐个串行**拉 quote + 60 日 K 线 → 返回快照。
- AI 解读：面板点击标的 → `POST /analysis` → 服务端拼 prompt → `agent.followup()` 注入当前会话 → 模型按 prompt 调工具收集数据 → `save_position_analysis` 落盘 → 面板轮询读取。
- 数据源治理：`probe_finance_sources` 串行探测 → 报告重排 provider 顺序；面板「数据源」页用户手动选择优先于探测结果。

## 三、架构亮点

1. **capability × provider 抽象干净**：20 个 capability、每个独立降级链，探测报告可重排顺序，用户 policy 可覆盖——对不稳定公开源是正确的防御姿态。
2. **零重依赖数据层**：原生 `fetch` + 手写 TTL 缓存/限流，Yahoo 的 cookie/crumb 会话处理（对照 yfinance）说明对上游风控有实战理解。
3. **本地数据治理规范**：原子写（tmp+rename）、secrets/policy/history 全部 gitignore、token 三级解析（env → secrets 文件 → 内联）。
4. **Agent-native 设计**：面板→agent.followup→save_position_analysis 的闭环把"UI 触发 + 模型执行 + 结果回写 UI"做成了完整回路，这是本项目最有特色的资产。
5. **Skills 体系有纵深**：从基金分析、选基、组合诊断到财富体检/目标测算/报告生成，覆盖了投顾业务链，且本地 SKILL 与盈米远端 skill 双轨管理。

## 四、问题与风险（按影响排序）

### 4.1 金融正确性问题（建议最高优先级处理）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| F1 | **组合市值跨币种直接相加**：`analyzePortfolio` 中港股(HKD)、美股(USD)、A股/基金(CNY) 的 `price×quantity` 直接求和得 `totalValue`，盈亏率因此失真 | `src/data/service.ts` `analyzePortfolio`/`computeRisk` | 任何含港美股的组合，总市值、收益率、权重、HHI 全部错误 |
| F2 | **价格未复权**：K 线为原始价格，分红/拆分靠手工 `add_market_event` 记录，不参与指标计算；MA/MACD/回测在除权日会产生假信号 | providers kline 系列 | 技术分析与未来回测的可信度受损 |
| F3 | **数据截断限制分析深度**：`get_stock_kline` 工具层 `slice(-30)`（基金 60），即使 provider 返回更多；`getKline` 默认只取 60 日、美股/港股 120 日 | `tools/register.ts`、`service.ts` | 模型只能看 30 根 K 线，年线(MA250)、年度回撤等都无法计算 |
| F4 | **行情时效未披露**：东财/腾讯/Yahoo 免费源多为延时行情（美股通常 15min），面板与工具输出均无延时标记和数据时间戳 | 全局 | 用户可能把延时价当实时价做决策，合规风险 |
| F5 | **宏观只有中国**：`get_macro_china` 仅 cpi/ppi/pmi/gdp/money_supply 五序列；做全球配置（QDII/美股持仓）缺美债收益率、美元指数、USDCNH 等锚 | `providers.ts` em_macro | 宏观叙事与持仓结构不匹配 |

### 4.2 性能瓶颈（会直接影响体验）

- **全局限流 3s × 串行快照**：`requestGapMs` 默认 3000ms，`buildLiveSnapshot` 对每个标的串行调 quote + kline。10 个自选 ≈ 20 次调用 ≈ **60+ 秒**才返回一次快照，而客户端轮询间隔只有 60s——自选稍多即"永远在刷新中"。
- **sparkline 代价过高**：为一根迷你走势线拉完整 60 日 K 线（还过限流）。
- **`analyzePortfolio` 同样串行**逐持仓取价。
- 东财 clist 类接口本身支持一次请求多 secid 的批量行情，目前完全没用上。

### 4.3 可靠性与工程

- **运行时健康无反馈**：health 只来自 probe 报告；某 provider 运行中连续失败不会被降权或熔断，每次调用仍从它开始试。无 429 退避（Yahoo 已有会话重试，东财/腾讯没有）。
- **TTL 缓存无上限无清扫**：长期运行的 Harness 进程中 Map 只增不减；且缓存纯内存，重启即失效。
- **无自动化测试**：只有依赖外网的 `test_availability`/`smoke` 脚本；`calculateMA/MACD/RSI/KDJ`、`computeRisk`、`normalizeCode/stripMarketSuffix` 这类纯函数零覆盖，也无 CI。
- **单文件巨石**：client `index.tsx` 1098 行、`server-routes.ts` 300 行 if/else 链，继续加 Tab/路由会越来越难维护。
- **文档漂移**：README 说"七个视角"，实际已是 10 个 Tab。
- 类型层面多处 `as never`/`unknown` 断言；`POST /mutate` 等本地 API 无鉴权（单机场景可接受，但值得注释边界）。

## 五、金融方向优化建议

### P0 — 正确性与速度（先修）

1. **币种归一（F1）**：给每条持仓引入 `currency` 与汇率折算（东财有 USDCNH/HKDCNY 行情接口，或固定汇率+可配置），`computeRisk`/面板盈亏全部以 CNY 口径输出，同时保留原币展示。
2. **批量行情 + 并发分组**：`/live` 改为按市场批量取价（东财 `push2` clist/secids 批量、腾讯 `qt.gtimg.cn` 支持多代码拼接），限流器从"全局串行"改为"按源分桶"；sparkline 改用已有的本地 history 库或 quote 附带的分时字段。目标：10 标的快照 < 5s。
3. **运行时熔断**：registry 记录 provider 滚动失败率，连续失败 N 次短路该 provider（冷却期后半开探测）；对 429/5xx 指数退避。
4. **放开 K 线深度（F3）**：工具返回条数参数化（如 `limit`，默认 120、可选全量），`sync_history` 支持 `start_date` 回溯抓取，让本地历史库真正能积累出年级别数据。
5. **数据时间戳与延时标记（F4）**：所有 quote/kline 输出带 `asOf`（数据源时间而非抓取时间）与市场状态（盘前/盘中/休市），面板统一显示"延时≈15min"角标。

### P1 — 风险与组合能力升级（差异化核心）

6. **组合风险指标扩展**：当前只有集中度（HHI/top-N/分布）。基于本地 K 线库补上：
   - 组合层：日收益波动率（年化）、最大回撤、Sharpe/Sortino、对沪深300的 Beta 与跟踪误差、历史 VaR(95%)；
   - 持仓层：两两相关系数矩阵（发现"伪分散"）、单票回撤；
   - 输出为 `analyze_portfolio` 的 `risk` 字段扩展 + 面板持仓页可视化。
7. **基金深度指标本地化**：用 `fund_kline` 净值序列计算年化收益、波动、回撤、卡玛比率；同类分位来自 `fund_rank`。盈米 MCP 缺 token 时面板仍有基础分析能力。
8. **基准对比**：指数 quote 已有（000300 等），给组合加"跑赢/跑输沪深300 X pct"的时间序列对比，这是复盘场景最刚需的一张图。
9. **宏观面扩围（F5）**：增加美债 10Y、美元指数、USDCNH、黄金序列（东财 datacenter 均有对应接口），与 QDII/美股持仓的解读闭环。

### P2 — 场景纵深（锦上添花）

10. **本地轻量回测**：数据（history 库）+ 指标（service.ts）都已就位，补一个事件驱动回测内核（MA 交叉/再平衡示例策略），portfolio-doctor skill 中提到的蒙特卡洛即可本地兑现，不再强依赖外部 MCP。
11. **提醒与日历**：价格阈值提醒（面板本地轮询即可触发）、财报日（已有事件库）与宏观发布日历。
12. **新闻降噪**：`get_market_news` 结果对持仓/自选做关键词相关性打分与去重，"与我的组合相关"比"全量电报"更有价值。
13. **AI 解读增强**：`analysisPrompt` 中加入组合上下文（该持仓权重、币种、盈亏状态）与"数据失败时降级声明"的结构化要求；解读报告增加 promptVersion 失效提示（数据过期 N 天建议重生成）。

### 工程配套

14. **测试**：为纯函数（指标、风险、代码归一、缓存/限流）补单测（vitest 即可，无外网依赖），availability 脚本保持独立标签；加最小 CI（build + unit）。
15. **拆分**：client 按 Tab 拆模块；server-routes 改为路由表。这两处是后续所有面板功能的落点，先拆后建。
16. **合规层**：面板页脚固定"数据延时/不构成投资建议"声明；README 的 Tab 数量等描述与现状对齐。

## 六、一句话总结

> 这个项目的**骨架是对的**——capability/provider 降级、本地 JSON 数据面、Agent 闭环解读、Skill 化研究流程都是金融数据插件的正确形态；当前最该补的是**金融正确性**（币种、复权、数据深度、延时披露）与**吞吐**（批量行情、按源限流、运行时熔断）。先把 P0 五项修掉，P1 的组合风险指标会立刻让它从"行情面板"升级为"组合研究台"。
