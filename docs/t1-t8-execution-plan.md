# T1–T8 分析与执行计划

日期：2026-10-01

范围：对当前仓库做增量规划；本轮未实施业务代码，也未重新运行构建或测试。文档中的接口、目录、阈值均为实施建议，不代表已具备的能力。

## 一、结论与默认边界

这不是八个独立页面，而是两条共享底座的产品链路：

1. **投资判断闭环**：投资者档案 → 原判断 → 证据 → Agent 对照报告 → 用户决定 → 预览确认修订。
2. **策略实验闭环**：结构化规则 → 固化历史数据 → 确定性回测 → 样本外验证 → 有限搜索 → 策略版本与低频跟踪。

默认采用现有 TypeScript/React 架构，不整体迁移框架，不接自动交易。东财 F10 首版限 A 股；港股、美股通过已支持的数据源返回可用维度，基金沿用基金画像，不套用 A 股 F10。

建议先补写入确认与数据可靠性，再增加数据和展示，最后做回测与搜索。T8 是贯穿全过程的工程工作，不能留到最后补测试。

## 二、仓库现状与差距

| 任务 | 已核实的现状 | 实施差距 |
|---|---|---|
| T1 | `src/personal.ts` 已有投资者档案、自由文本理由/验证指标/证伪条件、观点修订历史、证据卡、Agent 报告与人工决定；按 UTC 周一分周去重 | 目前手动/工具触发，不是自动周调度；验证指标尚非机器可检查结构；未系统引用上次报告和 F10 证据 |
| T2 | `src/confirmations.ts` 已有 15 分钟内存队列、before/after、一次消费、串行确认与冲突检查；持仓导入/新增修改、已有资料 opinion 修改已有预览 | `remove_holding` 工具与面板删除仍直接写入；Service/Store 仍有直接写入方法；外部 Markdown 同步可采纳已在磁盘上的修改，不是权限隔离 |
| T3 | `src/panel-bus.ts` 为 EventEmitter；`/events` 使用 SSE；客户端共享 EventSource | 无 seq、事件 id、时间戳和重放；自动重连不能补回断线期间消息；导航无时效 |
| T4 | 已有 provider registry、顺序策略、缓存、限流、熔断、探活，以及部分东财财务/公司数据 | 需逐维度接入 F10、规范数据时间与单位；同行比较、估值分位的实际接口/计算口径待核实 |
| T5 | `src/data/dossier.ts` 已聚合 18 个研究、资金、股东、事件等维度，单项失败可返回；已有深度页和 `stock_dossier` 工具 | 未包含全部目标基本面维度；AI 分析入口未强制先读 dossier；未完整关联结构化理由和上次报告；`AnalysisStore` 主要保留最新报告 |
| T6 | `src/client/index.tsx` 已有收盘折线、量能及事件标记 | 不是专业 OHLC 蜡烛图；缺多周期、MA 叠加、十字光标、缩放/平移与深度页整合 |
| T7 | 已有按标的存储的本地日线和市场事件，以及分币种估值基础 | 无策略引擎和搜索体系；历史文件仅按 code 键控，缺市场/复权/来源元数据、固化快照、可靠并发写入；财报标记使用报告期，不能当作信息可得日 |
| T8 | 已有离线、个人流程、回归、WeStock、源可用性脚本；HTTP 已有本机/可信 Origin 边界、JSON 和正文大小限制 | 需补业务级参数校验、统一导航目标、任务预算、量化与 UI 测试；既有文档测试数字不完全一致，需重新建立基线 |

重点代码：`src/index.ts`、`src/server-routes.ts`、`src/tools/register.ts`、`src/personal-tools.ts`、`src/research/store.ts`、`src/data/{registry,providers,westock,westock-capabilities,dossier}.ts`、`src/history/{store,sync}.ts`、`src/client/{index,personal-home}.tsx`。

## 三、依赖与实施阶段

```text
P0 基线与公共契约（T8）
 └─ P1 确认写入、版本和存储可靠性（T2 + T8）
     ├─ P2 面板消息恢复（T3）
     ├─ P3 F10 与数据契约（T4）
     ├─ P4 档案/周任务基础（T1），与 P3 并行；证据增强等待 P3
     └─ P6 历史数据治理（T7-A），可与 P3 并行
P3 + P4 → P5 深度档案与 AI 对照（T5）
P5 + 历史契约 → P5b 专业 K 线（T6）
P6 → P7 确定性回测 → P8 稳健性验证 → P9 有限搜索与策略跟踪（T7）
每阶段执行 T8；最终做集成验收和文档回填
```

**关键路径**：历史数据口径核实 → 固化数据集 → 成交/权益引擎 → 样本外验证 → 搜索。图表和 Agent 文案不能替代这条路径的验收。

### P0：基线与技术核实

- 保存当前构建、离线、个人、回归测试结果；真实数据源可用性单独记录，不混入功能正确性分母。
- 列出所有 HTTP 路由、工具、面板动作、文件同步的读写入口；形成“写入矩阵”和确认覆盖清单。
- 统一标的身份：`market + assetType + canonicalCode`，避免同代码股票/基金、指数/股票及跨市场混用。
- 明确 schemaVersion、错误类型、UTC 存储时间、报告期/公告时间/获取时间，以及 null/0/空数组的区别。
- 核实宿主 Agent 会话提交、任务生命周期、取消和接受回执能力；若不可用，不能承诺无人值守自动生成报告。
- 核实 WeStock 当前锁定版本、help、参数与输出；建立字段映射和兼容性 fixture。镜像文档的 skill 版本不能直接当作二进制版本。
- 交付：现状基线、契约草案、外部依赖风险表和首批离线 fixture。

### P1：T2 统一确认写入与可靠持久化

1. 将持仓导入、新增、数量/成本修改、删除/清空、已有资料观点替换/清空全部归入同一提议服务。工具只能提议，确认由明确的用户操作完成。
2. 预览返回 operation、目标、baseRevision、before、after、字段级 diff、createdAt、expiresAt、来源；导入明确整表替换或合并模式，默认避免悄悄清空。
3. 内存队列沿用当前语义：重启失效，不持久化 apply 闭包；确认失败需重新预览。若以后需要持久队列，改存声明式命令并重新校验，不序列化函数。
4. 底层提交方法仅供确认事务及受控系统写入使用；逐个审计 FinanceDataService、HTTP、工具与 UI，避免包装了预览但仍暴露旁路。
5. 确认时在同一写队列内重验版本和文件状态；串行原子写盘成功后才更新内存、追加审计并发事件。多文件写入说明回滚与崩溃一致性边界，不假装一个 rename 能保证整个资料事务原子性。
6. 优先加固将被自动任务并发写入的历史/分析存储，提供 schema 校验、损坏文件拒绝覆盖、临时文件原子替换与进程内写入队列；有崩溃持久性要求时增加 fsync/目录同步。
7. 外部文件边界：应用入口保证“未确认不修改业务状态”。拥有文件写权限的 Agent 已经可以改磁盘；要实现字面意义上全入口未确认不落盘，必须限制宿主权限或使用独立 staging 工作区。单靠确认队列不能做到。外部文件中的 opinion 变更建议隔离为待确认候选，不自动采纳为有效观点。

**验收**：全部受控变更入口在确认前业务文件与有效状态不变；删除也有 diff；重复确认、过期、并发确认、外部文件冲突、写盘失败均不产生错误提交；取消无副作用；原判断历史不丢失。允许新增资料、追加注释等现有行为，但必须在写入矩阵中明确其不属于覆盖既有观点。

### P2：T3 可恢复面板总线

- 消息信封：`{ version, epoch, seq, emittedAt, event }`，seq 在进程 epoch 内单调增长，SSE 使用 `id: epoch:seq`；内存缓冲按条数、字节数和保留时间设上限。
- 首次连接、自动重连分别支持 `Last-Event-ID` 和显式 `since`；建立订阅与重放交接水位，避免读完缓冲到挂载订阅之间漏事件。
- 客户端只处理连续的新序号，去重；遇到 epoch 改变、游标超前、缓冲淘汰或缺口，执行 resync，不能假装完整重放。
- resync 采用带水位的状态快照/状态版本；加载期间缓存增量，成功后只处理水位之后消息。对只需重取的视图使用失效通知，避免把旧的 portfolio payload 当作当前状态。
- 导航带 commandId、issuedAt、expiresAt；推荐短 TTL（例如 15 秒，可配置）。过期导航即使重放也不跳转，同时正常推进消费游标；批量重放中避免连续执行多个旧导航。
- 统一面板 TABS、服务端允许列表与工具 enum。当前工具允许列表未包含深度页，需一起修复并让 code 真正聚焦目标标的。
- 确认队列变化和个人档案变化发对应事件；epoch 切换清除客户端过期确认项。保留心跳、断线反馈和周期刷新兜底；处理慢客户端的背压与连接释放。

**验收**：短断线恢复不漏不重；超缓冲与服务重启可全量恢复；快照刷新期间持续变更最终一致；过期导航不抢页面；连接数/缓冲量不会无限增长。内存重放不承诺跨进程历史恢复。

### P3：T4 东财 F10 七维接入

实施时先对 SH/SZ 多个行业样本探活和保存脱敏 fixture，再做规范化，不从页面标签猜字段。

| 目标维度 | 初始核实入口 | 规范化重点 |
|---|---|---|
| 公司概况 | CompanySurvey/PageAjax | 公司身份、行业、主营描述、上市日期、来源 |
| 主营构成 | BusinessAnalysis/PageAjax | 产品/地区/行业分组、报告期、收入与利润金额/占比、单位 |
| 主要财务指标 | RPT_F10_FINANCE_MAINFINADATA | 报告期、公告日（可得时）、EPS/ROE/现金流/增长率及计算口径 |
| 核心题材 | CoreConception/PageAjax | 题材名称、入选理由、来源时间；不等同于主营收入贡献 |
| 股东户数 | ShareholderResearch/PageAjax | 户数、统计截止日、公告日、环比基期 |
| 估值分位 | RPT_VALUEANALYSIS_DET | PE/PB 定义、采样日期、历史窗口、样本数、负值/缺失处理 |
| 同行比较 | 从 F10 同行比较页面核实真实请求 | 同行业分类版本、可比标的、同口径指标和同报告期 |

- 对 stock_info/financials 等已重叠能力优先复用；新增语义不同的 business_composition、core_concepts、shareholder_count、valuation_history/percentile、peer_comparison 等能力，最终名称在 P0 固化。
- 接入 Capability、默认顺序、provider 清单、probe、数据源设置 UI、FinanceDataService 和工具，而不是 dossier 中直接绕开 registry 发 HTTP。
- F10 专属能力可默认东财优先；已有通用能力保留现有默认，用户显式优先级必须最高。当前 preferWestock 会自动提权，需按能力明确例外规则，而非随意全局修改。
- PageAjax 多维数据共享同一次上游请求/缓存；慢变基本面与行情使用不同 TTL；返回 stale 状态和真实数据时间。
- 所有结构保留 provider、sourceUrl/endpointRef、retrievedAt、reportPeriod、publishedAt/asOf、currency/unit、missing。不能把获取时间冒充数据时间。
- 如果上游仅给估值序列而不给分位，使用确定性本地算法，并披露窗口、有效样本、并列值排名、负 PE 的排除规则。样本不足返回不可计算，不伪造百分位。
- 同行接口未核实前不宣称七维完成；若改用本地比较，明确“本地计算”、可比池和同期间条件，不能冒充上游结果。

**验收**：七维 fixture 覆盖解析、空值、空数组、单位、分页、接口错误；显式策略有效；一个维度失败不拖垮整体；港美/基金明确 unsupported 或相应源回退；线上样本与来源页抽样对照。公开可访问不等于有 SLA 或无限再分发授权，不绕过登录/风控。

### P4：T1 档案与每周证据闭环

- 对现有 Thesis 做兼容扩展：指标数组支持 id、metricKey、定义、比较符、阈值、单位、观察周期、截止日、适用来源；证伪条件同样支持结构化规则。保留自由文本和原始版本，不将无法解析文本自动变成可计算策略。
- 保留 immutable thesis revision、修改理由和生效时间；证据卡锁定原判断 revision，并引用上次已保存报告/决定。同一周修订后的原卡不覆盖，可显式创建补充卡并说明关系。
- 周任务拆为“证据采集”和“Agent 解读”两个阶段：使用 week + thesisId + cardType 的持久幂等键，状态 pending/running/ready/failed，租约、有限重试、超时、取消与重启恢复。
- 首版默认保留现有 UTC 周定义，展示本地日期；如加入可配置时区，版本化 week 规则，不能悄悄迁移历史卡片。
- 插件运行时每周生成证据；停机期间不能运行，启动后按策略补本周任务，未成功的周标记缺口，不生成伪历史证据。
- 自动 Agent 报告只在用户已授权并绑定有效宿主会话/执行上下文时提交；无可用上下文则标记待解读并提醒。会话未打开、拒绝/未确认接受、模型超时均有清晰状态，不误投其他会话。
- 证据结合行情、新闻、投研资料和 T4 基本面，按指标建立支持/反证/缺失索引；每个事实标注时间和来源。Agent 区分事实、推断和未知；价格上涨不等于理由成立。
- 用户独立选择维持/修正/暂缓并写理由；“修正”只生成 T2 提议，不自动改观点；已人工复核卡不可覆盖。

**验收**：多入口/重启触发不会重复卡片；指标无法计算时明确缺失；上次报告可追溯；调度失败可见可重试；Agent 不能替用户决策；用户决定后报告和原判断快照不可静默改写。

### P5：T5 深度档案和 AI 对照

- 扩展现有 DossierSection：以 ready/empty/stale/unsupported/error 区分状态，携带原始来源、单位、数据时间和覆盖区间；不要用一个 ok 掩盖过期和不支持。
- 聚合基本面、WeStock 增强维度、持仓、有效理由与证伪条件、上次报告和用户决定；事实、个人观点、模型判断分区显示。
- 增加 dossier snapshotId/hash，报告保存引用 snapshotId、thesisRevision、previousReportId、promptVersion；保存报告修订历史，兼容当前最新报告读取接口。
- 更新 stock_dossier、分析请求 prompt、系统提示词及深度页“问 Agent”：先获取档案，再针对缺失项补源，逐项输出“原判断—新证据—验证/反证/待观察—与上次变化—待确认修订建议”。
- 对提示词要求同时做保存时契约校验：记录档案引用是否存在、观点版本是否匹配、证据索引是否有效。只能证明引用有效，不能宣称自动验证了语义真实性。
- 从工具参数到 UI 目标统一标的身份，取消过期请求，防止快速切换标的后旧请求覆盖新页面。

**验收**：七维可见、缺失清楚；AI 上下文包含当前理由与上次报告；保存报告有可追溯来源与版本；股票、基金路径不混用；模型生成可读报告不能替代服务端结构验证。

### P5b：T6 自包含专业 K 线

- 从超大的 `src/client/index.tsx` 抽出 `src/client/components/kline-chart.tsx` 和纯计算模块；接收 bars/events/period/adjustment，数据获取在外部完成。首版选 Canvas 主图与 DOM 信息层，不依赖远程 CDN 或外部行情终端。
- 绘制 OHLC 蜡烛、MA5/10/20/60、量能、价格轴/时间轴和图例；支持日/周/月、缩放、平移、复位、十字光标与 OHLC/量/MA 提示。
- 周/月由同口径日线聚合：首开、末收、最高、最低、量求和；按市场交易日期分组，说明未完结周期。
- 对空数据、单根、价格恒定、MA 不足、停牌、零量、非有限数、窄屏、触控和 DPR 做处理；颜色和键盘交互不只依赖红绿辨识。
- 深度页直接嵌入，保留独立 K 线入口；报告中的观察窗口可定位图表，引用的是相同快照/复权口径。
- 财报图标优先画公告时间，报告期另标；缺公告日的报告期图标不用于“当时已知”的推断。

**验收**：聚合和 MA 的固定输入输出一致；十字信息与对应 bar 一致；图表切换和缩放后不串标的；完成真实浏览器截图、键盘/触控和空态检查。构建成功不等于 UI 验收通过。

### P6–P9：T7 分阶段交付

#### T7-A 历史数据治理（回测前置门槛）

- 存储键包含 market、assetType、code、period、adjustment、provider；保留 fetchedAt、覆盖范围、交易日历、来源/CLI 版本、单位和 schemaVersion。
- 旧历史迁移为可读取但 adjustment=unknown 的数据，不猜复权方式，不直接纳入正式回测。
- 修复 provider 将缺失 OHLC 自动变为 0 的行为；价格必须有限且满足 OHLC 关系，真实零成交量可保留并标注不可交易，缺失量不等于零量。不要用成本价/前值填充出可成交 bar。
- 核实 WeStock 日期范围、条数上限、分页/分段及复权支持；现有默认约 60 条、上限 800 条不等于拥有完整长期历史库。
- 固化 dataset manifest 与内容 hash，标注缺口、上市/退市覆盖和历史标的池；同一快照可复现，后续增量不改变旧实验输入。
- 财报 period 不是 availableAt，最新 F10 不能灌入历史因子；缺公告时点及历史版本的基本面首版不参与历史回测。

**准入条件**：标的身份明确、价格口径已知、期间覆盖满足实验、无未解释的数据异常、快照已锁定。不满足时阻塞实验；可另提供明确标为“示意”的图，不输出可信回测结论。

#### T7-B 观点结构化与确定性回测

- 用受限、可版本化 DSL 定义策略：信号、参数、仓位、再平衡、交易规则和停止条件。自然语言观点可由 Agent 提出结构化草案，用户审核；无法机器化的观点只做研究检查。
- 首版做明确市场规则下的日频、单币种、long-only、无杠杆、固定标的池价格策略；不同时承诺完整 A/H/美市场交易仿真。
- 每个市场使用已验证配置；未实现的交易规则直接拒绝或明确降级。t 日收盘生成信号，t+1 可成交开盘执行；加入 warm-up、最小单位、可卖数量、费用、滑点、停牌与日线可判断的涨跌停限制。
- 日 OHLC 不能重建盘口和限价队列，报告明确是保守日频模拟，尤其一字板等不能保证可成交；不使用同日未来 high/low 改变先前决策。
- 复权、执行价和分红账务采用一种可解释方案：标准成交/权益模型优先原始执行价 + 公司行动/调整信息；如只有已知复权序列，只能另标为简化调整价格模拟，不伪造真实成交价格，不把已隐含于调整的分红再记一次收益。
- 输出交易日志、现金/持仓、权益曲线、价格/调整价格收益口径、最大回撤、交易次数、换手和成本；无分红/税费/再投资完整账务时，不声称真实含股息总回报。
- engineVersion、策略 hash、数据 hash、规则/费用配置和 seed 一并保存。核心计算无网络、无当前时钟依赖；运行元数据与可复现结果分开。

**验收**：手工金样本逐笔相符；手续费、T+1、资金不足、停牌、除权、缺失数据覆盖；同输入结果一致；对未来 bar 的修改不影响历史信号；截断与延长数据在共同区间结果一致。

#### T7-C 稳健性与时间切片

- 做参数邻域、成本敏感性、滚动训练/验证和 walk-forward；最终测试集锁定，不参与参数/模板选择。
- 最终测试访问与选型流程可审计；重复查看同一不可变最终结果不重新选优。如果依据测试结果改策略，则该区间不再是未见样本，需新的测试集。
- 设置最少样本期和最少交易数；不足返回“证据不足”，不因一次高收益自动入库为优质策略。
- 披露当前标的池/历史池覆盖、幸存者偏差、搜索次数与策略自由度。历史观点事后结构化不能当作当时已执行规则；只能作研究实验或从保存时点开始前向跟踪。

**验收**：所有切片无数据泄漏；训练/验证与最终测试严格隔离；稳健性差的策略被降级；极小样本不输出确定性排名。

#### T7-D 有限进化搜索、策略库与采样

- 借鉴“候选生成—确定性评估—保留—变异—再评估”范式，不引入整套 Python/Backtrader 依赖。先完成网格/固定种子随机基线，再扩展 DSL 参数/模板变异。
- Agent 只生成受限 DSL，禁止 eval/exec 任意生成代码；固定 seed、候选去重、总候选/代数/时间/并发预算、暂停取消、失败记录与 lineage。
- 按收益/回撤/交易数/成本/稳定性约束多目标选型，而非只追求最高收益。保存实际候选全集；LLM 生成过程不保证可复现，但每个保存候选的评估必须可复现。
- 策略库版本化保存 proposed/tested/watchlisted/retired 状态与理由；周/月低频重评，使用冻结规则和新时间段前向记录，不自动下单。升级到有效用户策略需明确人工批准。
- 分 CNY/HKD/USD 采样“已跟踪证券市值”；记录 holdingsRevision、报价实际时间、来源和缺失，不把成本替代行情，不将不同币种直接相加。
- 缺现金/现金流账本时不称账户总净值或投资收益。持仓变更导致的市值跳变另列并分段计算回撤；缺报价不更新有效高水位，避免错误巨额回撤；无 FX 序列不做基准币归一，也不计算 TWR/IRR。

**验收**：搜索预算与取消有效；无任意代码执行；lineage/输入/结果可复核；参数更新不改旧实验；采样可幂等、持仓变化和缺行情明确标注，各币种不混算。

## 四、T8 工程配套与测试矩阵

建议渐进新增 `src/contracts/`、`src/jobs/`、`src/strategy/`、`src/client/components/`，在扩展功能时拆出路由和前端模块，避免一次大重构掩盖行为变化。

### 校验与接口

- HTTP 与工具共享业务 schema；覆盖 code/market/type、日期真实性与范围、周期、复权、分页上限、费用非负、参数上下界、候选预算、未知字段和有限数。
- 使用明确 400/404/405/409/413/415 等错误；现有安全边界保持，不因添加预览或 SSE 放松访问控制。远程部署依然需要认证代理，trusted origin 不是身份认证。
- 建议新增/扩展领域入口：确认提议/确认/取消、带游标事件流、带水位状态刷新、档案/报告版本、历史快照、策略校验/实验/取消/结果/策略库/采样。
- 重任务使用 jobId 查询状态，不在一个 HTTP 请求里无限执行；工具返回结构化状态和下一步，不注册 Agent 确认工具。
- 外部资料视为不可信输入，提示词禁止执行资料中的指令；日志屏蔽敏感档案、完整持仓及正文。
- 新任务/实验/策略/采样文件按现有 dataDir 管理，加入忽略规则，原子写入并限制权限；离线测试写临时目录，真实历史与大结果不提交 Git。

### 测试

| 层级 | 必测内容 | 验收门槛 |
|---|---|---|
| 既有回归 | build、test:offline、test:personal、test:regressions | 当前功能全部通过；新旧统计统一记录 |
| 新离线数据 | F10 七维 fixture、WeStock argv/字段、单位/时点、空值、路由策略和回退 | 不允许未声明外网请求；关键分支确定性通过 |
| 确认/消息 | 所有变更入口、并发/失败、重放、epoch/gap、快照交接、TTL、慢客户端 | 无旁路提交、无丢事件导致的最终不一致、无迟到跳转 |
| 量化 | 指标/聚合、逐笔金样本、规则/费用、公司行动、未来数据防泄漏、hash/seed、时间切片、搜索预算 | 核心结果可复现且与手工基准一致；不合格输入拒绝 |
| 调度 | 周边界、幂等、租约、重启恢复、会话缺失、取消/超时、人工决定不可覆盖 | 无重复卡片、无隐式会话投递、失败可见 |
| UI 冒烟 | 首页→diff→确认；深度→图表→AI→保存；断线恢复；实验→取消→结果 | 真实浏览器验收，有截图/断言；失败不能用构建替代 |
| 线上源 | test:westock、test:avail、F10 SH/SZ 样本 | 独立报告可用率/时间/错误，不冒充离线通过 |
| Agent 报告抽样 | 原判断/反证/上次变化/缺失/引用支持程度 | 人工质检；有效索引不等于事实真实性 |

建议增加 `test:f10`、`test:bus`、`test:quant`、`test:ui`，或等价脚本；最终命令以实际实现为准。CI 可分确定性必过与真实网络可选两类。

## 五、交付分组、规模和发布门槛

| 交付包 | 包含内容 | 相对规模 | 必须满足 |
|---|---|---|---|
| A：可靠投资工作流 | P0/P1/P2、T1 任务基础，逐步补 T8 | M–L | 删除也确认；重连可恢复；证据任务不重复 |
| B：深度研究与图文互证 | T4/T5/T6、T1 证据增强 | L | 七维可追溯；AI 先档案后结论；真浏览器验收 |
| C：可复现量化 MVP | T7-A/B/C | L | 数据准入与成交口径验证通过；样本外无泄漏 |
| D：受限搜索与长期观察 | T7-D、端到端验收和文档 | M–L | 搜索不执行任意代码；结果和前向记录不混淆 |

这是多阶段交付，不宜将所有功能合成一次大改。外部接口、历史复权和宿主调度尚未确认，现阶段不提供伪精确工期；P0 后根据可用历史覆盖、市场范围和 UI 自动化环境估时。T7 搜索不能为赶进度跳过数据/回测/稳健性门槛。

每个交付包附：代码、迁移/兼容说明、离线测试、可用性报告、用户验收步骤、已知限制和回滚说明；默认关闭新自动任务/搜索，再逐项启用。更改沿用现有会话工作分支，不包含与本计划无关的已有工作文件。

## 六、外部来源核实记录与阻塞项

1. [东财 F10 来源页](https://aif10.eastmoney.com/pc_extendf10/choicef10.html) 本轮可读取，展示公司、主营、股东、同行比较等入口。但本环境直接请求所列六个 JSON 地址遇到 TLS EOF；**这不证明接口失效，也不证明已接入可用**。实际字段、分页、估值分位和同行接口需 P0/P3 验证。
2. [WeStock 发布路径](https://stockbuddy.qq.com/release/workbuddy/cli) 顶层页面抓取返回 404；版本化下载地址不等于目录首页，不能据此认定二进制下载不可用。仓库安装脚本当前锁定 v0.0.5，需核实资产、help 和能力。脚本在 checksum 清单没有该资产时会跳过校验，建议 T8 改为 fail-closed。
3. [第三方 CLI provider](https://github.com/jinking/a-share-deep-research/blob/main/providers/westock_cli.py) 本轮已读取，主要使用新闻、研报、公告、资金等增强命令；其数值数据并非都来自这个 CLI provider，因此不能直接当作本仓库 K 线/财务字段权威契约。
4. [westock-data 镜像候选](https://github.com/github-water/ll-skills/blob/main/westock-data/skills/westock-data/SKILL.md) 检索可定位，但本轮未完整核实用户指定 v1.0.2 的 SKILL.md/commands.md。实施应锁定镜像来源、commit、版本与校验值，与真实二进制 help 对照；冲突以已验证版本能力为准，文档差异单列。
5. [alphaevolve-trading](https://github.com/shaansuthar/alphaevolve-trading) 的 [pyproject.toml](https://github.com/shaansuthar/alphaevolve-trading/blob/main/pyproject.toml) 声明 MIT，采用 Python/Backtrader 等依赖；本轮仓库树未见独立 LICENSE、GitHub license 元数据为 null。默认只借鉴范式，若复制具体代码需先确认版权/许可证文本并保留归属，不能把元数据缺失解释为无许可证，也不能直接当作可完整搬运证明。

阻塞策略：接口暂不可达时可先做 fixture 和降级 UI，但不能宣称真实数据交付；复权/时点未明时阻塞正式回测；宿主任务能力不足时交付自动证据+待解读状态，明确尚未完成自动 Agent 报告；浏览器环境受阻时保留 UI 验收未完成，不隐瞒缺口。

## 七、执行进度

### 2026-10-01 批次一（P1/P2 起步）

- 基线（改动前全绿，本次改动后复跑仍全绿）：build 通过；test:offline 164 通过；test:personal 通过；test:regressions 由 11 组扩至 14 组全部通过。
- **T2 删除确认闭环**：`remove_holding` 工具与面板 `/mutate removeHolding` 均改为 `PortfolioStore.previewRemoveHolding` 预览确认，确认前不落盘；预览含 before/after、15 分钟时效、单次消费、基线变化拒绝；新增/更新/整表导入预览使用区分性标签。未找到持仓显式报错，不再静默空操作。
- **T3 可恢复面板总线**：`PanelBus` 事件信封 `{v, epoch, seq, emittedAt, event}` + 有界重放缓冲（512 条 / 10 分钟）；SSE 输出 `id: epoch:seq` 与信封 data，支持 `Last-Event-ID` / `?since=` 断线续传；缓冲不足或服务重启发 `__resync` 标记，客户端做快照重同步并按 seq 去重；导航命令带 `commandId` + 15 秒 TTL，过期重放/重复命令不再抢占视图；`panel_navigate` 允许列表补齐 `dossier` 页并支持聚焦代码。
- 新增共享纯函数模块 `src/panel-envelope.ts`（游标解析、过期判定，服务端与客户端共用）。
- 边界说明：拥有文件写权限的宿主 Agent 仍可绕过应用确认（需权限隔离/staging，见 P1）；watchlist 变更沿用直接写入（不在 T2 持仓变更清单）；浏览器真实 UI 冒烟本次未执行（环境无浏览器），SSE 行为由单元测试覆盖。

### 2026-10-01 批次二（P1.6 / T7-A 历史数据可靠性）

- **HistoryStore 重构**：文件键含 code+kind+period（`000001` 股票与同代码基金不再混库）；schemaVersion=2 记录 `adjustment/provider/fetchedAt`；旧版 code-only 文件读取为 `adjustment=unknown`（可读但不进正式回测），首次写入迁移到新键后移除；读-改-写整体串行 + 临时文件原子替换，并发合并不丢 bar；损坏文件读/写均显式拒绝并保留原字节，不再「当空覆盖」。
- **无效 K 线拒收而非补 0**：WeStock K 线解析逐行严格校验（日期、价格有限且 >0、OHLC 关系成立），无效行丢弃并计数警告；缺失成交量标记 `volumeMissing: true`（0 ≠ 零成交）；东财基金净值序列同样标记 `volumeMissing`。`mergeKline` 返回 `{added, rejected}`。
- **复权口径治理**：合并记录实际请求口径（东财/腾讯日线 qfq、WeStock CLI 未验证 → unknown、基金净值 none）；显式口径冲突拒绝合并，unknown 可被显式口径升级、不会降级。
- **接口/工具**：`get_history` 暴露 period/adjustment/provider/fetchedAt；`add_market_event` 与 `/history/event` 支持 kind 参数；`sync_history` 返回 rejectedBars/adjustment。
- 测试：test:offline 164 → 166（零价行拒收、volumeMissing）；test:regressions 14 → 16 组（键控/迁移/损坏拒绝、并发串行原子写）。改动后 build + offline + personal + regressions 全绿。
- 仍待 T7-A 后续：分页拉取更长历史、交易日历/缺口标注、数据集快照 manifest、财报事件改用公告可得日（当前仍以报告期入账，不能当信息可得时点）。（→ 已于批次十一全部完成）

### 2026-10-01 批次三（P3 / T4 东财 F10 七维）

- **七维规范化模块** `src/data/eastmoney-f10.ts`（纯函数，fixture 固定契约）：公司概况、主营构成、主要财务指标、核心题材、股东户数、估值分析、同行比较；每份结果带 `provider/endpointRef/retrievedAt/reportPeriod/publishedAt/asOf/unit/missing`，报告期≠公告日≠抓取时间严格分列；`contractVerified: false` 诚实标注（本环境 TLS 受限，线上契约未核实，fixture 通过 ≠ 线上验证）。
- **估值分位确定性算法**：显式窗口、并列取秩中点、PE/PB≤0 剔除、样本不足返回不可计算；上游无分位字段时本地计算并标注 `computedLocally`。
- **同行比较**：上游防御式解析标 `upstream_unverified`；`buildLocalPeerComparison` 显式「本地计算」口径（共同最新报告期，不同期行标注 mismatch），不冒充上游结果。
- **接入**：7 个 capability 进 registry（F10 专属默认东财源；用户显式策略最高，preferWestock 不影响无 ws 源的能力）；A 股闸门对港美代码显式拒绝；dossier 18→25 维，基金档案 F10 维显式 unsupported 不发请求；catalog/数据源页自动收录。
- 测试：offline 166→207（解析/单位/空值/缺失/分位边界/闸门）；分页与线上抽样对照待接口可达时补。

### 2026-10-01 批次四（P4 / T1 档案与每周证据闭环）

- **结构化观点**：`indicators/falsifiers`（id/metricKey/label/comparator/threshold/unit/window/deadline）与自由文本并存，旧观点兼容；修正必填 `changeReason`，版本不可变（历史保留）；`effectiveAt` 记录生效时间。
- **确定性对照** `src/personal-eval.ts`：逐指标输出 satisfied/diverged/triggered/not_triggered/missing/unverifiable；未知指标键与取不到数绝不猜值；事实取自行情+F10（带报告期/公告时点），评估仅供人审，不是投资结论。
- **周任务调度**：`week+thesisId+cardType` 幂等键、120s 租约、有限重试（3 次上限）、手动重试/取消、重启租约恢复、停机缺口列表（不补造伪历史）；多入口并发触发只生成一张卡。
- **证据卡上下文**：`checks` 结构化对照 + `previous`（上次报告摘要/用户决定）+ `jobKey`；已复核卡与原判断快照不可覆盖（既有保证复测通过）。
- **运行时自动生成**：启动后延迟 + 每 6 小时补本周任务；**Agent 解读任务 `requiresUser`，不自动投递会话**（会话绑定属 P0 未决项）；面板「周任务」区块可见失败/重试/取消，`/personal/job` 操作入口，`get_weekly_jobs` 只读工具。
- **提示词**：先 `stock_dossier` 拉档案再看卡；按「原判断—新证据—验证/反证/待观察—与上次变化—待确认修订建议」组织；Agent 不得代用户决定（服务端拒绝覆盖已复核卡）。
- 测试：test:regressions 16→18 组（结构化评估、任务幂等/租约恢复/重试上限/跨周上下文）；test:personal 适配修正理由必填；build + offline 207 + personal + regressions 全绿。
- 仍待：宿主会话任务绑定（自动投递解读）、补充卡 API（同周修正后显式补卡）、可配置时区周定义、指标键扩展与来源映射。（→ 除会话绑定外已于批次十一完成）

### 2026-10-01 批次五（T5 深度报告版本/引用契约 + 档案快照）

- **维度状态四态**：`DossierSection.status` = `ready / empty / unsupported / error` + `dataAsOf`（F10 `meta.asOf`/`reportPeriod`）+ `missing`；「正常空」与「取数失败」不再混同（空响应缺行不再当失败）。`stale` 态待 SWR 语义露出后补（现取现算无缓存过期概念），已在代码注释说明。
- **内容寻址快照 `snapshotId`**：对剔除 `retrievedAt`/`ms` 等易变字段的规范 JSON 做 sha256（截 32 位）；同数据重取同 id，报告可校验「基于哪一版档案」。
- **分析报告契约（v2）**：`promptVersion=2`、递增 `version` + 稳定 `reportId`、`refs{dossierSnapshotId, thesisRevision, previousReportId}`；历史只追加（≤20 条/标的）；旧缓存单对象格式自动迁移为 v1+历史。
- **保存时引用校验**（`save_position_analysis`）：快照必须已登记、`thesisRevision` 只接受当前或上一版、`previousReportId` 必须在历史中；不通过拒绝保存（报告不落盘）；返回明示「引用有效≠语义真实」。
- **提示词先行检索 + 对照结构**：`analysisPrompt` 异步先取档案快照并登记，嵌入【档案快照】【原判断·vN（含修正理由/结构化指标）】【上次报告·vN 摘录】【上次人工决定】；提示词要求检索是行为指令，不是证明。报告卡显示版本 + 溯源行；资料库「问 Agent」改为先 `stock_dossier` 再补缺口。
- 测试：offline 207→217（+10：快照稳定性/剔除易变字段/空 vs 失败/unsupported/数据时点）；regressions 18→19（+1：版本递增 + 旧缓存迁移 + 引用契约通过/拒绝/不落盘）。build + 全套验证 ✅。

### 2026-10-01 批次六（T6 自包含专业 K 线）

- **纯函数层 `src/client/kline-math.ts`**：清洗（丢非有限/坏日期、同日留最后、高低归正、零/NaN 量归 0）；日/周/月聚合（开=首根开盘、收=末根收盘、高=最大高、低=最小低、量=求和，bar 日期取真实交易日，不为非交易日造 bar）；未完成周期注明（周五/月末最后工作日收线视为完成，否则「进行中」）；MA5/10/20/60 预热期为 null 不伪造；视窗 clamp/zoom/pan/x→下标；恒定序列 ±2% 呼吸空间；红绿/蓝橙（Okabe-Ito）双配色 + 均线四种线型。
- **组件 `src/client/kline-chart.tsx`**：canvas + DPR；蜡烛（涨空心/跌实心——涨跌不只靠颜色）、MA5/10/20/60、成交量、图例（含均线数值与「本周期进行中」）；滚轮/双指缩放、拖动平移、重置、十字光标 tooltip（OHLC/涨跌/量/MA）；键盘（方向键/±/Home/End/R）与 tabIndex 焦点环；空数据/单根/恒定序列/停牌零量/窄面板都有明确表现；事件标记保留。
- **接入**：K 线 tab 换用新组件（入口/同步/事件联动保留，单根也可显示）；深度档案嵌入「行情走势」图 + 维度状态四态徽标（不适用/暂无/失败/条数）+ 数据时点。
- 测试：offline 217→252（+35：周/月黄金聚合、未完成周期、清洗、MA 预热、视窗、配色）。build + 全套验证 ✅。

### 2026-10-01 批次七（T7-B 受限 DSL + 确定性日频回测）

- **DSL `src/strategy/dsl.ts`**：`dslVersion=1`，价格序列信号（ma_cross/momentum/volatility/zscore，zscore 带进出场带状态机）+ 显式交易规则（整手 lotSize、佣金/最低佣金、卖出印花税、滑点、涨跌停近似阈值、T+1 必须 true）+ 可选停止条件（回撤熔断/停止日）；严格校验（未知字段/越界/未实现规则直接拒绝）；规范 JSON → sha256 策略 hash。
- **引擎 `src/strategy/backtest.ts`**：t 收盘信号 → t+1 开盘执行（滑点内嵌成交价）；long-only、无杠杆、单币种、等权分仓独立现金包络；T+1 按买入日 FIFO 手数跟踪；现金不足跳过不透支；停牌（零量/缺量）、一字板双向跳过、开盘涨停不追买/跌停不砍卖（保守可成交）；回撤熔断停开新仓；unknown 复权默认拒绝，显式放行标记「简化调整价格模拟」；输出交易日志（含信号日/skip 原因）、现金/持仓、权益曲线、回撤、换手、成本、敞口；engineVersion/策略 hash/数据 hash/配置 hash 保存；核心无网络、无 Date.now。
- **口径声明**：保守日频模拟，一字板不保证可成交；无分红/再投资账务，不声称含股息总回报。
- **测试 `scripts/test_quant.ts`（test:quant）**：手工金样本逐笔/现金/权益/指标相符（收益 -2.18%、回撤 ≈-2.615%、换手 153.5%、成本 35.75）；T+1、资金不足、停牌/缺量、涨跌停/一字板、截断与延长不变性、改未来 bar 不动历史、逐字节可复现、滑点口径、unknown 复权拒绝/降级、数据准入拒绝、DSL 拒绝、信号黄金值；15/15 ✅。build + offline 252 + regressions 19 + personal 全绿。

### 2026-10-01 批次八（T7-C 稳健性与时间切片）

- **`src/strategy/robustness.ts`**：参数邻域（逐参数 ± 展开、去重、顺序确定）；成本敏感性（费率/滑点场景同信号对比）；walk-forward（`makeFolds` 滚动折 + 折间测试窗不重叠、选型只用训练窗、样本外复利合并、泄漏即拒跑）。
- **冻结最终测试集 `FinalTestSet`**：`select()` 只评估 testStart 之前区间；`viewFinal()` 首次计算并 deep-freeze，重复查看返回同一对象、绝不重新选优（审计日志单调序号，无时钟）；`markStrategyModified()` 后区间作废（burned），再选/再看被拒——「依据测试结果改策略就不再是未见样本」。
- **证据充分性 `evidenceCheck`**：最少样本期/最少交易数，不足返回「证据不足」且 `rankable=false`（禁止确定性排名）。
- **披露 `disclosureReport`**：标的池、逐标的数据覆盖（起止/根数/复权）、幸存者偏差、搜索次数、策略自由度、事后结构化免责。
- 测试：test:quant 15→21（+6：邻域/成本敏感/walk-forward 无泄漏/冻结测试集作废语义/证据不足/披露）。build + offline 252 + regressions 19 + personal 全绿 ✅。

### 2026-10-01 批次九（T7-D 有限进化搜索 + 策略库 + 分币种采样）

- **搜索 `src/strategy/search.ts`**：固定 seed（mulberry32）预算式进化（候选数/代数预算 + `shouldStop` 取消）；只在 DSL 数值参数上变异（±步长钳制，非法即弃）；候选按策略 hash 去重；保存候选全集含 lineage（父 hash/代数/变异说明）与完整可复现评估结果；多目标选型（约束满足优先：最少交易/回撤下限/最少样本，再按得分，同分按 hash）；`experimentFingerprint` 固化实验输入（参数更新不改旧实验）。
- **策略库 `src/strategy/library.ts`**：proposed→tested→watchlisted→retired 版本化流转 + 理由 + 历史只追加；`propose` 只校验保存（Agent 路径，绝不 eval/exec/回测/下单），同 hash 去重；激活（→watchlisted）必须显式 `confirmed`，否则抛 `StrategyConfirmationRequired` 带预览、状态不动；`recordForward` 前向重评记录只追加（specHash+dataHash 可复现）。`submit_strategy` / `get_strategy_library` 工具入库，策略库挂 `data/strategy-library.json`。
- **采样 `src/strategy/sampler.ts`**：分 CNY/HKD/USD 采样「已跟踪证券市值」（报价×持仓），绝不跨币种相加、成本绝不顶替行情；缺报价标的计入 `missingCodes`、部分市值标 `complete=false` 且不更新 HWM（避免假巨额回撤），全缺则市值/回撤为 null；`holdingsRevision` 变化开新分段（市值跳变不算回撤，HWM 重置）；采样幂等；`drawdownSegments` 分段汇总不拼接。
- 测试：test:quant 21→25（+4：搜索复现/预算/取消、lineage/变异边界/指纹、库状态+确认+前向、采样四规则）。build + offline 252 + regressions 19 + personal 全绿 ✅。

### 2026-10-01 批次十（T8 工程配套：共享校验 / UI 冒烟 / 文档）

- **共享校验 `src/validation.ts`**：HTTP 与工具同套业务规则——code/market/type、真实日历日期（2024-02-30/2023-02-29 拒绝）与区间、周期、复权、分页上限、费用非负、有限数/整数/上下界、搜索预算、未知字段；`ValidationError` 显式映射 400/404/405/409/413/415/416。
- **接入关键端点**：`/dossier`、`/analysis` GET/POST、`/history`、`/history/sync`、`/history/event` 全部走共享校验；路由外层 catch 映射校验状态码并回传 issues。既有安全边界不变。
- **UI 冒烟 `scripts/test_ui.ts`（test:ui）**：有 Playwright + `DSH_UI_URL` 时真跑（面板加载/标签切换/截图）；本沙箱无浏览器 → **诚实 SKIPPED 并明示「不能以构建/离线测试替代 UI 验收」**，失败不吞。
- **文档 `docs/strategy-lab.md`**：DSL/引擎口径与保守模拟声明、数据准入与复权降级、稳健性与冻结测试集语义、搜索/库/采样规则、运行命令、用户验收步骤、已知限制、回滚说明。README 测试清单更新；`.gitignore` 补 strategy-library/experiments/ui-shots。
- 测试矩阵对齐：test:quant（量化）、test:regressions（总线/确认/引用契约）、test:offline（F10 fixture/K线/校验）、test:ui（UI 冒烟，SKIPPED 记录在案）；test:westock/test:avail 独立真实网络报告不变。
- 验证 ✅：build、offline 272、quant 25、regressions 19、personal PASS、ui SKIPPED（如实）。

### 2026-10-01 批次十一（收尾：P4 增强 + T7-A 全项 + 真 bug 修复 + UI 友好化）

- **可配置时区周定义**：`weekKey(date?, tz?)` + `weekTimeZone`/`setWeekTimeZone`/`isValidTimeZone`（env `DSH_WEEK_TZ`，默认 UTC，周一为始、按该时区日历日）；`/personal` overview 返回 `weekTimeZone`，UI 周复盘标注动态显示实际时区，不再硬编码「UTC」。
- **补充卡 API**：`requestMakeupCard(thesisId, reason?, week?)`（理由选填）；仅当当前观点 revision 超过原卡快照才可补（否则「无须补卡」），jobKey=`${week}:${thesisId}:evidence:makeup:r${rev}` 幂等；`ReviewCard.makeup{forCardId,reason,revision}`、`WeeklyJob.makeupFor/makeupReason`；claimNext/buildCard/推送均按 jobKey 防重，同周先前卡进 previous 上下文；UI 在观点升级后出「按 vN 补卡」入口（明示不覆盖原卡）+ 补充卡徽标与理由。
- **指标键扩展与来源映射**：`KNOWN_METRICS` +volume/amount/turnover_rate/market_cap/dividend_yield；`METRIC_SOURCES` + `metricProvenance()` 并入评估 note（未知键明确「暂无自动取数映射，须 Agent/人工查证」）；`factsFromQuote` 提取新指标（缺失不猜值）。
- **T7-A 全项**：`fetchKlinePaged` 分页（≤5 页×800，窗口续拉，复权口径混用即停，`pages/truncatedAt` 标注数据边界）；`HistoryStore.manifest(code)`（coverage/bars/events/contentHash=sha256-32/gaps/eventsMissingAvailableAt）+ `detectGaps`（≥2 交易日缺口，周末不计）+ `/history/manifest` 路由 + UI「数据边界/缺口/内容哈希」行；财报事件携带公告可得日（`availableAt`/`dateKind:'period'|'available'`，缺公告日显式标注「公告日缺失，报告期≠可得日」）。
- **真 bug 修复**：①`mergeEvents` 原按 `date|type|label` 去重——label 变更产生重复事件；财报改按 `date|type` 幂等，重同步只升级缺失信息（可得日/数值/公告版标签），绝不覆盖已有有效值、不删历史。②`search.ts` 候选排序比较器 ties 不一致（边界行为未定义）→ 统一 `compareCandidates`（约束满足→得分→hash），walkForward 选型同源。
- **UI 友好化**：Review 卡补卡表单（观点版本对照、理由选填）；K 线「色觉」按钮改「色盲友好」+ 常驻操作提示行（滚轮/双指/拖动/双击/←→/±/Home/End/R）；深度档案无本地 K 线时明确指路（「行情」页同步或「浏览」页附图解析）；历史同步结果提示截断边界与页数。
- 测试：offline 272→299（+27：时区周边界/ISO 年界/非法时区、指标溯源、缺口边界、manifest 契约、mergeEvents 幂等升级、补卡校验与幂等、分页截断/混口径停止/短页即止）；修 test_regressions 一处 buildCard 旧签名残留调用。验证 ✅：build、offline 299、quant 25、regressions 19、personal PASS、ui SKIPPED（无浏览器，如实）。
- 仍待：宿主会话任务绑定（自动投递解读）——属 P0 未决项，维持不做；线上接口契约抽样对照（TLS 受限环境不可达，保留 fixture 口径 `contractVerified:false`）。

### 2026-10-01 批次十二（缺陷修复：买入含费可负担 / 波动率 NaN / 信号参数必填）

- **缺陷①买入未预留佣金 → 现金为负（实测 minCash=-0.3999…）**：`runBacktest` 原按 `cash/(execPrice·lotSize)` 取整手数，佣金后扣 → 名义吃满现金时佣金把现金打负。修复：买入前按 `notional + max(minFee, notional·feeRate) ≤ cash` 反解可负担名义（= min(cash−minFee, cash/(1+feeRate))），整手向下取整 + 浮点护栏逐手回退（判定与扣款同一表达式）；含费买不起才 skip `insufficient_cash`，不误伤可成交场景（黄金样本 25 项零回归）。
- **缺陷②volatility lookback=1 产出 NaN（[null, NaN, NaN]）**：内联 stdev 在样本=1 时 `0/0`。修复两层：校验层 `volatility/zscore.lookback ≥ 2`（标准差需 ≥2 样本）严格拒绝；计算层改用 `stdev()` 帮手并统一 NaN 防御——`sma/stdev` 非法窗口返回 null，momentum/zscore 缺参或越界输出 `value=null`（target 保守为 0/维持状态机），绝不产出 NaN。
- **缺陷③ma_cross 缺 slow 仍过校验（永不触发的坏策略）**：INT 字段原用 `f in signal` 有值才检，缺失即漏。修复：该 kind 的全部非 kind 字段一律必填（`signal.slow 必填` 等显式报错）；warmup/信号层随之不会拿到 undefined 窗口。
- **连带加固**：`parameterNeighborhood` 对非法邻点（如 lookback→1/→0）丢弃而非让评估期抛错；search `mutateSpec` 原有 validate 即弃行为不受影响。
- 测试：test:quant 25→28（+3：含费现金不为负与 skip 语义、波动率 NaN 防御与 lookback=2 黄金值 34.107%、信号参数缺失拒绝）+ 邻域丢弃断言。验证 ✅：build、quant 28、offline 299、regressions 19、personal PASS。

### 2026-10-01 批次十三（UI：点击个股展示专业K线）

- **点击个股即见K线**：行情/持仓/发现点击标的打开的持仓分析浮层（`PositionAnalysisView`）顶部新增「行情走势」区块——T6 专业K线组件（蜡烛/MA5/10/20/60/成交量/十字光标 tooltip/键盘 ←→/±/Home/End/R/色盲友好配色）+ `KlineStats` 紧凑统计；事件标记沿用本地历史事件。
- **一键同步**：本地无历史时在区块内直接「同步K线（首次拉取）」（按代码推断 A/港/美/基金口径），不必切去「行情」页；同步结果明示新增根数与截断边界（`truncatedAt`），失败原因直接显示。
- **「在K线页打开」**：浮层头部按钮经面板总线 navigate 命令切到「K线」页并带上该代码（完整行情工作区），浮层关闭；复用既有一次性命令 TTL/去重语义。
- 验证 ✅：build（bundle 662→666KB）、offline 299、quant 28、regressions 19、personal PASS；test:ui 仍 SKIPPED（无浏览器，不以构建替代 UI 验收）。

### 2026-10-01 批次十四（UI：行情与K线合并为一个 tab）

- **合并**：「市场研究」下移除独立「K线」tab，K线工作区（代码输入/市场选择/同步/查看/标的快捷chips/数据边界行/KlineChart/KlineStats/事件标记/总线刷新）整体嵌入「行情」tab 底部，KlineView 组件原样保留零删减。
- **行情侧交互升级**：自选行点击 → 下方K线工作区加载该标的并平滑滚动到图表（合并的核心体验）；行上新增「AI」按钮打开 AI 解读浮层（原行点击行为完整保留为显式动作）；市场总览/自选增删/名称搜索/刷新/数据源与缓存统计原样保留。持仓 tab 行为不变（点击仍开 AI 解读）。
- **兼容迁移**：`panel_navigate tab=kline` 为别名（等价 quotes 并聚焦K线），工具枚举/描述与提示词同步更新；`tab=quotes` 带 code 亦可聚焦K线；旧 localStorage 收藏 tab='kline' 自动迁到 quotes；「查看K线」浮层按钮改走 quotes 命令。
- 验证 ✅：build（bundle 667KB）、offline 299、quant 28、regressions 19、personal PASS；test:ui SKIPPED（无浏览器）。

### 2026-10-01 批次十五（缺陷修复：资料详情归档后被总线事件弹回）

- **确认存在**：资料详情点「归档/恢复/删除」→ 服务端发布 `research` 总线事件（SSE 在 `await act` 期间即可到达）→ 总线处理器对仍开着的同 id 详情发起异步 `open(id)` 重载 → `close()` 先落地、`setDetail(r)` 后落地 → **详情连同全屏遮罩弹回前台挡住列表**（复现路径与「测试里只能显式关掉详情再筛选」一致）。
- **修复**：`dismissedRef` 闩锁——①`close()` 记录被关闭 id；②归档/恢复/删除按钮在 `act` **之前**上闩（事件可能在 await 期间到达）；③总线处理器对已上闩 id 不再 `open`；④`open()` 响应落地时复查闩锁（堵住 in-flight 竞态）；⑤卡片点击重开时清闩。同源加固：用户**编辑正文**期间总线事件不再抢占刷新（原会 `setEditing(false)` 丢编辑现场）。
- 验证 ✅：build、offline 299、quant 28、regressions 19、personal PASS；行为级验证需真实面板（test:ui SKIPPED），建议手工复核：详情→归档→详情不弹回、列表可直接筛选。

### 2026-10-01 批次十六（优化：数据源页 WeStock 能力归组折叠）

- **问题**：WeStock = 13 个手工核心 + 55 个表驱动 spec（`westock-capabilities.ts`），每能力一行进数据源目录 → 「数据源」页 75+ 行里大半是 WeStock 裸英文 id（minute/technical/market_breadth…），逐行铺开难扫读、难管理。
- **服务端**：`westockCapabilityMeta()`（能力→中文名/分组，同能力先出现的 spec 优先）；`/providers` GET/POST 目录经 `withCapMeta` 附 `label/group`，协议向后兼容（字段可选）。
- **面板重构**：①能力显示名全覆盖（`CAP_LABEL` 补 `quotes_batch`，其余用目录 `label`，tooltip 保留英文 id）②「单一来源能力」按数据源家族折叠卡片（WeStock 50+ 项收成一张卡，卡内再按 行情/技术/市场/行业/资金… 分组小标题；小家族默认展开、大家族默认折叠）③家族级「全启/全停」批量切换（保存后生效），卡头显示「N 项能力 · 已启用 M」④多来源能力区（优先级多选）原样保留。
- **纯函数 `src/client/sources-group.ts`**：`groupBySource`（家族/分组稳定排序、缺省归「其他」）+ `defaultOpenFamily`（≤6 项默认展开）。
- 测试：offline 299→305（+6：元数据分组/中文名完整性、家族聚合与排序、折叠默认）。验证 ✅：build、offline 305、quant 28、regressions 19、personal PASS。
