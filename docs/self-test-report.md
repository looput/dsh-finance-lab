# dsh-finance 自测报告（WeStock 接入 + 投研资料库）

测试日期：2026-09-27 · 环境：macOS(darwin arm64) · Node 22.22.2（`.nvmrc` 锁定）
隔离：每个应用一个 `$DSH_HOME`（默认 `<repo>/.dsh-home`）、端口默认 `0`（OS 分配）、
插件依赖与 LLM provider 写在 profile 层（`--patch` overlay）。

测试分两层：

* **功能正确性（离线、可重复）**：不依赖网络，断言解析/映射/持久化/校验逻辑，必须 100% 通过。
* **数据源可用性（真实网络，允许失败但标注原因）**：真调上游；失败不算功能缺陷，但必须给出原因。

---

## 1. 功能正确性（离线）

```bash
npm run test:offline     # = npx tsx scripts/test_offline.ts
```

**结果：99 / 99 通过**

| 分组 | 用例要点 | 结果 |
| --- | --- | --- |
| Markdown 表格解析 | 多表格、section 标题、数值保留、空输入 | PASS |
| 代码 → CLI symbol 映射 | A股 `600519→sh600519`、港股 `700/00700→hk00700`、美股 `AAPL→usAAPL`、后缀 `.HK/.SH`、反向解析、kline 参数；**沪深代码段归属**（510300→sh、113050→sh） | PASS |
| WeStock provider（fake CLI） | quote / kline / search / news / report / finance / profile 全字段映射；**K 线统一升序** | PASS |
| 失败路径 | 二进制缺失 → 明确错误；`enabled=false` → 「已停用」错误（不再静默） | PASS |
| **能力目录（表驱动）** | 55 个 spec 逐个断言：CLI argv 前缀与 usage 一致、裸代码映射为带前缀 symbol、每个 spec 都有 provider | PASS |
| **通用 CLI 桥** | 任意 argv 执行与解析；拒绝 `update/upgrade/config/login` 等写操作、拒绝 shell 元字符（`;`/`$`/`|`）、拒绝超长 argv、字符串 argv 解析 | PASS |
| Research Vault | source/date/title 必填校验；按 kind/status/code/tag/query 过滤；时间倒序；limit；追加观点（带时间戳、不覆盖）；归档/恢复/归档时间戳；覆盖式更新；stats；删除；**落盘 Markdown + frontmatter + 重载恢复** | PASS |
| Logger | JSONL 落盘、级别过滤（info 被丢弃）、`recent()` / `recent(level)`、stats | PASS |
| Provider registry | catalog 覆盖 21 个能力；`ws_quote` 为 quote 默认首选；`research_report` 默认 `ws_research`；策略丢弃未知 id 并落盘；能力不可用返回 `ok:false + attempts` 而非抛异常 | PASS |

## 2. 数据源可用性（真实网络）

### 2.1 WeStock 专项

```bash
npm run westock:install          # pinned v0.0.5 + SHA256 校验 → .dsh-home/bin/westock
npm run test:westock             # = npx tsx scripts/test_westock.ts
```

**结果：精选用例 15 / 15 可用 + 能力全量扫描 54 / 55**（全部走真实腾讯自选股网关）

```
[OK] westock CLI 可用性与版本            westock 0.0.5 channel=workbuddy
[OK] quote A股 600519                   贵州茅台(600519) price=1237 -1.14%
[OK] quote 港股 00700                   腾讯控股(00700) price=436.6 -0.41%
[OK] quote 美股 AAPL                    苹果(AAPL) price=341.07 1.53%
[OK] kline A股 600519 (30 根)            bars=30
[OK] kline 港股 00700 / 美股 MSFT        bars=20 × 2
[OK] search 腾讯（跨市场解析）            n=7 top=00700(港股)
[OK] report list 600519（研报）          n=6 top=【诚通证券】… org=诚通证券 2026-09-18
[OK] report detail 研报正文              id=res843401040115 bytes=2023
[OK] news list 600519（资讯）            n=5
[OK] finance 600519（三大报表）          rows=12
[OK] profile 600519（公司简况）          贵州茅台 · 食品饮料
[OK] registry → quote（westock 优先）    provider=ws_quote price=1237
[OK] registry → research_report          provider=ws_research n=4
```

#### 能力全量扫描（遍历 55 个 spec，真实网络）

```
分组汇总：行情 1/1 · 技术 2/2 · 市场 6/6 · 指数 2/2 · 板块 7/7 · 发现 1/1 · 财务 1/1 ·
          资金 6/6 · 公司 3/3 · 研究 4/4 · 资讯 3/3 · 事件 3/4 · ETF 3/3 · 宏观 2/2 ·
          选股 5/5 · 产业链 1/1 · 其他 3/3
能力扫描 54/55 可用
```

唯一失败：`ws_events(stock_events)` —— 上游对贵州茅台/平安/宁德/招行等标的均返回
「数据为空」（CLI 原始输出即是如此），属数据源侧数据缺失，非插件缺陷；provider 已把
上游这句提示原样带进错误信息，便于定位。

注：早期扫描中 `screen_condition`、`screen_*`、`report list` 曾出现上游 `service error`，
已对瞬时故障加了一次重试（400ms 后重试），复跑后全部通过。

### 2.2 全量数据源回归

```bash
WESTOCK_BIN=$PWD/.dsh-home/bin/westock npm run test:avail
```

**结果：26 / 30 可用**，另加资料库 4 项检查全通过。

| 分组 | OK / 总数 | 备注 |
| --- | --- | --- |
| A 股（ashare） | 9 / 9 | 列表/行情/K线/财报/新闻/搜索等 |
| 港股（hk） | 4 / 4 | |
| 美股（us） | 3 / 3 | |
| 工具（tools） | 4 / 4 | 组合表格/曲线对比/组合曲线/相关性 |
| **WeStock（新增）** | **6 / 6** | quote×3、kline、research_report、stock_info |
| 网页搜索（search） | **0 / 4** | ❌ `all providers failed for web_search` |
| 资料库（vault） | 4 项 | 真实收集、去重、stats、落盘路径 |

❌ 失败项原因（**已知、非本次改动引入**）：
`ddg_instantanswer` 依赖的 DuckDuckGo Instant Answer API 已废弃（返回空），
`py_web_search` 依赖 Python `ddgs`，当前环境未安装（`ModuleNotFoundError: No module named 'ddgs'`）。
处理：`scripts/dev_web.sh` 生成的 overlay **默认不再把宿主搜索切到本插件**（原配置会覆盖宿主默认搜索并双双失效），
如需启用请先 `pip install ddgs` 再打开 overlay 中注释掉的 3 行。

### 2.3 资料库真实收集（联网）

```
[OK] collect_research 600519 研报        saved=4 skipped=0
[OK] 重复收集去重                         saved=0 skipped=4
[OK] vault stats                         total=4 byKind={"report":4} topCodes=[{"code":"600519","count":4}]
[OK] 落盘文件 2026/r-20260927-….md · 来源 诚通证券研报 · 时间 2026-09-18 · 标的 600519
```

## 3. 端到端（真实启动 Host + 面板 API）

```bash
./scripts/dev_web.sh     # 自动：独立 DSH_HOME → 选 node → 生成 overlay → plugin add → 启动（port 0）
```

启动日志（节选）——**此前静默的失败现在可见**：

```
node: …/22.22.2-3/bin/node (v22.22.2)  ·  DSH_HOME: <repo>/.dsh-home
overlay: <repo>/.dsh-home/dsh-finance.overlay.yml  ·  westock: <repo>/.dsh-home/bin/westock
2026-… [dsh-finance] WARN yingmi remote-skill list failed { command: 'yingmi-skill-cli', error: 'spawn ENOENT' }
dsh web: http://127.0.0.1:49402/?token=…
```

（端口由 OS 分配，多次启动不冲突；首次 ENOENT 已降为 debug，不刷屏。）

HTTP 验证（均带 Bearer token）：

| 场景 | 请求 | 结果 |
| --- | --- | --- |
| 插件状态 | `GET /api/state` | 200，portfolioPath 指向 `$DSH_HOME/data` |
| WeStock 状态 | `GET /api/westock` | `{"configured":true,"available":true,"version":"westock 0.0.5"}` |
| 能力目录 | `GET /api/westock/capabilities` | 200，`items=55`，分组含 行情/技术/市场/指数/板块/发现/资金/公司/研究/资讯/事件/ETF/宏观/选股/产业链/其他 |
| 通用调用（capability） | `POST /api/westock/call {capability:"consensus",args:{code:"600519"}}` | 200，`provider=ws_consensus`，返回 2027 年 EPS/营收/净利润/PE/PB 预测 |
| 通用调用（argv） | `POST /api/westock/call {argv:["fund","flow","sh600519"]}` | 200，返回主力/超大单净流入等 20 字段 |
| 市场发现 | `GET /api/discover?limit=5` | 200，涨跌分布 + 热搜股票 50 条 + 热门板块 5 + 龙虎榜 5 |
| 数据源目录 | `GET /api/providers` | `quote.selected = ["ws_quote","em_stock_get","em_individual_info"]`，`research_report` 含 `ws_research` |
| 实时快照 | `GET /api/live` | 200，A股报价来自 `ws_quote`，sparkline 正常 |
| 资料校验 | `POST /api/research`（缺 source） | 400 `"source（来源）必填…"` |
| 资料入库 | `POST /api/research` | 200，返回 item + 落盘路径 |
| 批量收集 | `POST /api/research/collect {code,size:3}` | 200 `saved=4 skipped=0` |
| 追加观点 | `POST /api/research/note` | 200，notes 增加、带时间戳 |
| 归档 | `POST /api/research/archive` | 200 `status=archived` + `archivedAt` |
| 面板实时性 | `GET /api/events`(SSE) + 保存资料 | 收到 `data: {"kind":"research","action":"save","id":"r-20260927-…"}` |
| 日志 | `GET /api/logs?limit=5` | 200，返回 JSONL 条目（含 `research saved`、`provider failed` 等） |
| 资料列表 | `GET /api/research?limit=3` | 200，`vault=<dataDir>/research`、`watching=true`、`stats.missing` 可用 |
| 资料详情 | `GET /api/research?id=…&raw=1` | 200，`body` 已剥离 frontmatter，`raw` 为磁盘原文，`mtime`/`exists` 齐备 |
| 手动同步 | `POST /api/research/sync` | 200 `{"scanned":28,"added":0,"updated":0,"missing":0,"changed":[]}`（幂等） |
| 面板改正文 | `POST /api/research/body {id,body}` | 200；本地文件正文已更新，frontmatter 与 `## 观点与批注` 保留 |
| 清理缺失 | `POST /api/research/prune` | 200 `removed=1`（删除索引里文件已不在磁盘的条目） |

### 3.0 性能：数据获取提速（真实环境，同一份持仓/自选：7 持仓 + 9 自选）

| 环节 | 优化前 | 优化后 | 手段 |
| --- | --- | --- | --- |
| `GET /api/live` 首屏 | **70.6 s** | **4.3 s** | 批量行情 + 并发 + 熔断 + 失败缓存 |
| `GET /api/live` 再刷新 | 69.3 s（失败不缓存，每次重等超时） | **0.02 s** | 结果缓存 + 失败短期缓存 |
| 16 只标的行情 | 16 次上游调用（串行 + 3s 间隔） | **1 次** `westock quote a,b,c` | `quotes_batch` capability |
| 指数（市场总览） | 东财 HTTP | **WeStock**（`ws_indices`，0.4–0.7s） | 新增 `ws_indices` provider |
| 美股/ETF 误判 | `sh515080` 被判成美股 → Yahoo 超时 23s×2 | 走 A 股（WeStock ETF 正常） | `routeCode()` 统一市场路由（认前缀/后缀） |
| 探测 `probeAll` | 全串行 | WeStock 并行（限 6）+ HTTP 保留间隔 | 按源分流 |

实现要点：
- `ProviderRegistry`：`ws_*` 走并发闸门（默认 6），HTTP 源走串行间隔（默认 800ms）；
  同 key 并发请求合并成一次（`coalesced`）；缓存过期后 SWR 先出画面再后台刷新；
  失败结果短期缓存（20s）避免每次刷新重新等死源；连续失败 2 次即熔断 60s（`circuitOpen`）。
- `getQuotes(codes)`：一次批量 → 缺的按各自市场（含基金）并发补齐；Agent 侧新增 `get_quotes` 工具。
- 统计外露：`GET /api/stats`（按 provider 的成功/失败/平均耗时、熔断列表）、`/api/live.perf`（命中率/平均耗时）。
- 「接口」页新增「数据源性能」卡片（浏览器实测：`WeStock 0.0.5 · 优先`、`上游调用 25`、`缓存命中 40 (62%)`、`平均 1041.1ms`，
  下面逐 provider 列出 `✓/✗/平均耗时`），性能问题不再靠猜。
- 前端呈现：指数卡片网格、行情卡（涨跌色条 + 迷你走势 + 涨跌幅药丸 + 来源徽标 WeStock/东财）、
  骨架屏、「x 秒前更新」+ 手动刷新、页脚显示缓存命中与平均耗时。

### 3.1 对话 ↔ 面板 打通（真实浏览器 + 真实 Agent 运行）

| 方向 | 验证方式 | 结果 |
| --- | --- | --- |
| 面板 → 对话 | 资料页点「让 Agent 整理」 | 提问被写入当前会话并自动提交：会话标题变为「请整理我的投研资料库：当前共 28 条…」，状态 `Deep diving…`，轨迹里可见 `archive_research`/`update_research` 调用 |
| Agent → 资料库 | 该轮跑完后查 `/api/research` | `byStatus` 由 `inbox 27 / archived 1` 变为 `active 17 / archived 11` —— 对话侧的维护动作确实落在资料库上 |
| 对话 → 面板 | SSE `/api/events` 抓包 | `{"kind":"research","action":"save","id":"r-…","title":"SSE 回执验证","origin":"panel"}`；`origin=chat` 的事件会触发面板顶部回执条（一键跳到「资料」） |
| 面板 → 对话（单条） | 资料详情「问 Agent」 | 把「标题/来源/时间/标的/观点/正文摘录 + 资料 id」拼成提问发进会话，并要求 Agent 用 `add_research_note` 回写 |
| 兜底 | 宿主未提供会话服务时 | 退化为「复制提问」弹窗（剪贴板失败时摊开文本框手抄），面板本身不受影响 |

实现要点：客户端 cordis 需 `inject: ['slots','configForms','conversation','sessions']`；
投递走 `ctx.sessions.scope(当前会话id).conversation.input.for(scope)` 的 `setDraft + submit`
（等价于用户粘贴后回车）。会话 id 通过 `sessions.list.getSnapshot().ids` 中第一个 `scope(id)` 命中的来确定。

### 3.2 本地文件 ↔ 面板 双向联动（真实文件系统）

文件结构定为 **YAML frontmatter（`id/title/kind/source/date/status/codes/tags/url/summary/opinion`）+ 正文 + `## 观点与批注`**，
元数据只在 frontmatter 里存一份，正文不再重复渲染标题/来源块，因此外部编辑正文不会破坏结构。

| 场景 | 操作 | 结果 |
| --- | --- | --- |
| 外部新建（无 id） | 在 vault 目录手写 `2026/手工笔记-联动测试.md` | 3 秒内自动入库；`id` 被回写进文件；再次同步 `added=0/updated=0`（幂等） |
| 外部改正文 | 编辑器里把 `v1` 改成 `v2` | 自动同步，`GET /research?id=…` 的 `body` 立刻是 v2 |
| 外部改元数据 | frontmatter `status: active → archived` | 自动同步，索引 `status` 变为 `archived` |
| 外部写批注 | 文件里手写 `- <ISO> · 我：…` | 自动同步，进入观点时间线（与索引批注合并去重） |
| 面板改正文 | 详情「编辑正文」→ 保存 | 写入同一个 Markdown 文件，frontmatter/批注不动，磁盘内容含新正文 |
| 外部删除 | `rm` 掉正文 | 自动同步标记 `missing: true`，面板显示「文件缺失」并提供「清理」 |
| 面板删除 | 详情「删除」 | 索引与文件一起删除，不会留下下次同步又被重新入库的孤儿文件 |

监听实现：`fs.watch(root, { recursive: true })` + 600ms 防抖，只响应 `.md`（忽略 `index.json` 自触发），
不可用时退化为 15s 轮询；插件卸载时通过 `ctx.effect()` 释放。

客户端（真实浏览器 DOM 快照）：顶部显示本地目录与「已监听 · 改文件自动回灌」+「同步本地文件」按钮；
列表按月/按标的分组（如 `2026-09 15 条`）；详情为双栏——左侧来源/时间/标的/标签/本地文件（复制路径·同步目录·重新载入）+ 观点时间线，
右侧正文渲染，可切「编辑正文 / 查看原文」。控制台 0 error。

## 4. 面板打不开的排查与修复（真实浏览器验证）

现象：侧边栏「金融面板」按钮可见、点击后按钮变 active，但面板内容没有任何渲染，
服务端也无 `/plugins/dsh-finance/api/*` 请求。

用 Playwright 逐步定位（页面内 DOM / 网络 / 控制台）：

1. `GET /plugins/??dsh-finance/client.js&rev=…` → 200（486KB），bundle 正常下发；
2. 点击后 `document.body.children` 仍只有 `script, script, #root`，没有 portal 容器 → 组件未挂载；
3. 按钮内联样式 `background: transparent` → `open` 仍为 `false`；
4. profile 用户层 `profiles/web/cordis.patch.yml` 中没有任何 `panelOpen` 写入。

**根因**：`FootAction` 只信任 `configForms.set('panelOpen', true)`；本版本该写入返回不可写，
值始终为 `false`，因此 `open && docked/!docked` 两个分支都不渲染。

修复：

* 开关状态改为「本地 state 优先 + localStorage（`dsh-finance:panelPrefs`）兜底」，
  profile 可写时仍写回 profile；不可写时顶部提示"开关已存到浏览器本地"。
* `scripts/dev_web.sh` 生成的 overlay 默认 `panelDocked: false`（浮层抽屉），
  避免停靠页依赖宿主 dock 容器、未选工作区时不渲染。

验证（Playwright，真实浏览器）：点击→面板打开；刷新→仍打开；
「发现」页渲染出涨跌分布（上涨 1120 / 下跌 4306 / 涨停 53 / 跌停 16 / 上涨占比 20%）与热搜股票；
「资料」页列出 7 条资料与筛选器；「行情」页渲染指数（上证 3888.37 -1.22%）与自选报价（贵州茅台 1237.00 -1.14%）。
控制台 0 error / 0 warning。

## 5. 已知限制

1. ~~`web_search` 在本环境不可用~~ —— 已通过「回补数据源」修复：新增 Node 原生 Bing RSS 源 `rss_web_search`（免安装，默认首选），Python `ddgs` 降级为可选增强（见 §7）。
2. WeStock 研报正文为 Markdown 原文，尚未做「评级/目标价/盈利预测」结构化抽取。
3. 资料库检索目前是全量扫描 + 子串匹配；资料量大时需引入 FTS5 / 向量索引。
4. `westock` CLI 未安装时 `research_report`、`ws_*` 能力不可用，registry 会回落到 HTTP 源（行情/资讯/财报仍可用）。
5. 资料库同步只认「有 `title` + `source` + `date`」的 Markdown：缺来源或时间的手记文件不会被入库（保持「不做孤岛」的约束）。
6. 递归 `fs.watch` 在网络盘/部分容器上不可用时会退化为 15s 轮询，外部改动最长 15s 后可见。

## 6. 本轮新增的三个能力

### 6.1 观点触发式提醒（reminders）

- 落盘 `.dsh-home/data/reminders.json`，两条规则：
  - `move`：持仓/自选当日涨跌幅超过阈值（默认 ±5%）→ 行情异动提醒；
  - `opinion`：资料库里 `status=active` 且带观点的标的，波动超过阈值（默认 ±8%）→ **观点需要复核**（把 `opinion` 当可验证假设）。
- 去重：同标的同类型 12 小时内只提醒一次；面板铃铛显示未读数，点击直达 AI 解读；支持「全部已读 / 立即检查」。
- 后端每 10 分钟自动扫描（启动后 20 秒先跑一次），Agent 侧有 `check_reminders` / `list_reminders` 两个工具。
- 实测：`/reminders/check` 返回 `scanned 12 / added 14`，提示「中际旭创今日 -9.03%」「腾讯控股：观点需要复核」。

### 6.2 投顾视角（advisor）

- `analysisPrompt()` 注入该标的在资料库里的观点与研报（`advisorMemory()`，最多 6 条 + 最近批注）。
- 报告被要求新增「与我既有观点的对照」一节：逐条说明验证 / 证伪 / 待观察，冲突时明确指出，不再每次从零重写。
- 离线测试覆盖：命中标的含观点、要求对照结论、无关标的返回空。

### 6.3 回补数据源（backfill）

- 新增 `rss_web_search`（Bing `&format=rss`，Node 原生解析，零 pip 依赖）并设为 `web_search` 默认首选；`py_web_search` 保留为可选增强。
- 解析为纯函数 `parseBingRss()`（处理 CDATA 与实体转义），有离线测试。
- 实测：`web_search` 返回 `ok=true provider=rss_web_search`。

### 6.4 面板视觉与交互

- 默认宽度 410 → 480，左边缘可拖动（360–820，写入 localStorage，停靠模式下中栏留白同步）。
- 分组药丸导航（自选/研究/设置三段）、分组大卡、统一空态、hover 反馈、骨架屏。
- 修复：`${BRAND}14` 拼成非法 CSS（`var(...)14`）导致选中态失效；`useAgo` 写在短路表达式里导致 React #310 面板整体崩溃。

## 6. 复现命令

```bash
npm run build
npm run test:offline                 # 功能正确性（离线，158 条）
npm run westock:install              # 安装 pinned WeStock CLI
npm run test:westock                 # WeStock 可用性（真实网络，15 条）
WESTOCK_BIN=$PWD/.dsh-home/bin/westock npm run test:avail   # 全量数据源 + 资料库收集
./scripts/dev_web.sh                 # 端到端启动（独立 home / 独立端口 / profile 层配置）
```

## 7. 品牌更名与布局优化（本轮）

- **更名**：插件 id / 包名 / API 前缀 / 设置页标签 / 面板标题统一 `dsn-*` → `dsh-*`
  （`dsn-finance` → `dsh-finance`，`/plugins/dsh-finance/api`，面板显示「DSH 金融面板」）。
  CSS 类名（`dsn-row` / `dsn-card` / `dsn-tabs` / `dsn-pulse`）保持原名，避免样式失效。
- **布局**：默认宽度 480 → 520；实测并修掉 4 类横向溢出：
  1. 指数卡「价格 + 涨跌幅」同行挤压（改竖排，卡片 min-width 归零）；
  2. 数据源页 capability id（如 `index_constituent`）撑破固定列宽（改竖排 + 省略号）；
  3. input 默认 `content-box`，`width:100%` + padding + border 溢出 20px（改 `border-box`）；
  4. 窄面板（360）行情行与添加区挤破 → 宽度 <460 时自动切换为两行布局。
- 三档宽度（360 / 520 / 820）实测横向溢出均为 0。

## 8. WeStock 深度数据探索（个股档案）

CLI 实际提供 **65 个叶子命令**，插件此前已接入 55 个 capability，但面板只用到其中少数
（行情 / K线 / 财务 / 新闻 / 涨跌分布 / 热榜）。本轮把剩余高价值维度聚合成「个股深度档案」。

### 8.1 新增 `src/data/dossier.ts`

一次并发取回 18 个维度（约 2s，单项失败不影响整体）：

| 分组 | 维度 |
| --- | --- |
| 研究 | 一致预期（目标价 + 三年 EPS/营收/净利/PE/PB/PS）、股票评分（5 维 + 周/月/季变动）、ESG 评级、机构评级 |
| 资金 | 资金流向（主力/超大单/大单）、融资融券、大宗交易、个股龙虎榜、北向资金持仓 |
| 股东与回报 | 股东研究（十大股东/变动）、分红记录、公司回购 |
| 风险与事件 | 个股事件（42 类）、风险事件监控、停复牌 |
| 资讯 | 公司公告、个股新闻 |
| 产业链 | 所属产业链主题 |

实测（600519）：**16/18 有数据，1.97s**，payload 25KB；港股 00700 → 10/18；美股 AAPL → 6/18；基金 110022 → 4/18。

### 8.2 暴露方式

- 面板新增「深度」Tab：输入代码 → 按分组列出维度（状态点 / 条数 / 耗时 / 来源），点击展开为紧凑表格。
- Agent 工具 `stock_dossier`：做深度研究或尽调时一次拿到全部维度，并附可读摘要。
- HTTP：`GET /plugins/dsh-finance/api/dossier?code=600519`。

### 8.3 顺带修掉的数据源 bug

上游以「数据为空 / 区间内未上龙虎榜」表示**正常空结果**，之前被当成失败并抛错，
导致「个股无事件」「区间内未上榜」在面板里显示为错误。现在识别这类措辞，返回空集 + 原因。

## 9. CLI 方式接入 WeStock

插件本来就是 CLI 接入（`runWestock` spawn 二进制 + `parseMarkdownTables` 解析），
本轮把它包装成可直接敲的命令：`scripts/westock.sh` + `scripts/westock-cli.ts`（`npm run westock`）。

三种用法（均已实测）：
1. **原生透传**：`./scripts/westock.sh quote sh600519` / `kline sh600519 --period day --limit 3` —— 输出 CLI 原文；
2. **能力目录**：`--cap consensus --args '{"code":"600519"}'` —— 走 ProviderRegistry，带缓存、多源回落、表格解析，输出 JSON；
3. **元信息**：`--list [--group 研究]`（4 条研究类能力）、`--status`（`westock 0.0.5 channel=workbuddy`）。

细节：
- 二进制定位顺序 `--bin` / `WESTOCK_BIN` / `<包>/.dsh-home/bin/westock` / `~/.westock/bin/westock`；
  显式 `--bin` 指向不存在的文件时直接报错退出（不静默回退）。
- 未找到二进制时输出安装命令而非堆栈。
- system prompt 已告知 Agent 该命令与 `westock_call` 工具两种入口。

## 10. 逐个 Tab 的呈现增强（13 个 Tab）

统一骨架：分组大卡（`S.group` + `groupHead`）+ 空态 + 骨架屏 + hover，全部 13 个 Tab 实测横向溢出 0。

| Tab | 增强内容 |
| --- | --- |
| 行情 | 分组卡、指数卡竖排、窄屏两行自适应（既有） |
| 市场 | 板块改**横向条**（长度=涨跌幅强度）+ 龙头/主力净流入 tooltip；涨跌分布条 |
| 持仓 | 总览大数字（市值/浮盈）+ 成本→市值盈亏条；逐仓卡片含仓位%、盈亏条；Top5 权重条 + 集中度提示 |
| 基金 | 药丸分段筛选；行内近6月涨跌条；骨架屏 + 空态 |
| K线 | 面积填充 + **成交量柱**；新增区间统计（区间涨跌/振幅/最大回撤/最高/最低/最新） |
| 宏观 | 网格卡片；与 12 期前对比（百分比指标用 **pp**，非百分比用 %）；骨架屏 |
| 快讯 | **时间线**布局；关键词过滤；标的药丸（品牌色选中态） |
| 深度 | 18 维度归档（既有） |
| 发现 | 涨跌占比条；热搜/板块/龙虎榜各自分组卡 |
| 技能 | **开关控件**替代「启用/停用」双按钮；启用计数；分组卡 |
| 资料 / 数据源 / 接口 | 既有（双栏编辑、能力竖排、性能面板） |

### 顺带修掉的两个真 bug
1. **领跌榜 = 领涨榜**：`ws_sector_ranking` 的 argv 把 `sector ranking` 写死、忽略 `order`，
   CLI 默认降序 → 「今日风险」展示的其实是涨幅榜。现已传 `--order`，并在服务端按涨跌幅兜底排序。
   实测：领涨 商用车 +3.34%；领跌 非金属材料Ⅱ -8.34%。
2. **板块涨跌幅恒为「—」**：上游字段是 `changePct`（WeStock）而前端读 `changePercent`（东财），
   字段名不匹配。现统一 `sectorPct()` 兼容两种。
3. **宏观 CPI 显示 +300%**：把百分比指标当相对变化算；现按百分点差（pp）显示（实测 +1.2pp）。

验证：13 个 Tab × 520px 宽度，横向溢出 0；离线测试 164 passed / 0 failed。

## 11. 资料编辑器体验 + 深度档案接 AI 解读

**资料 Tab 编辑器**（此前只有一个裸 textarea）
- Markdown 工具条：`H2 / B / • / 1. / > / 表 / —` 一键插入（按整行处理，不破坏缩进）
- 快捷键：`⌘/Ctrl+S` 保存、`Esc` 退出编辑
- 编辑中可切「预览」渲染 Markdown（窄面板并排分栏太挤，用切换代替）
- 未保存状态提示（`● 未保存`）+ 实时字数；保存后同步基线，不再误报
- 实测：点「表」→ textarea 出现 `| 项目 | 数值 |`，字数 18→53，出现「● 未保存」；
  切预览后渲染出 `<table>`，按钮变「继续编辑」

**深度档案接 AI 解读**
- 「深度」Tab 拉取档案后（实测 16/18 维度有数据 · 1924ms）出现「AI 解读」按钮
- 点击直接唤起解读面板（实测读到 600519 的缓存解读，数据截至 2026-09-28T15:00:00）
- 形成闭环：档案（18 维度数据）→ 解读（模型结论）→ 面板回写

验证：离线测试 164 passed / 0 failed；编辑器与解读入口均浏览器实测通过。

