---
name: wealth-report
description: 当用户需要一份整合型财富规划书面报告（诊断、资产负债、收支、指标、目标、现金流、配置与保障/负债建议等全模块）且默认要 HTML 时使用。依赖 MCP 拉齐家庭财务与方案数据，脚本整合为 9 大模块。
---

# 财富规划报告（Wealth Report）

## 核心价值定位

- **单份交付**串联诊断、明细、指标、目标、现金流、资产配置与文字类建议模块。
- **默认 HTML**；整合与页面渲染均在 `scripts/run.py`（stdin JSON）。`generate_report_html.py` 为本地批处理辅助（读写固定文件名），非运行期必调。
- 与 `wealth-family-advisor` 主流程对齐，可作为「成稿导出」子能力。

## 合规边界

- 各模块数字须来自**用户输入、MCP 或上游脚本**；不得编造方案收益或基金业绩。
- **不构成投资建议**；须有免责声明；涉及具体基金须可溯源工具返回。

---

## 输入层

### 交互流程

```
多模块数据（对话/MCP/子技能结果）→ 拼 JSON → scripts/run.py → HTML（可选：generate_report_html.py 落盘）
```

### 输入与模块映射


| 模块 | 主要数据/MCP |
| --- | --- |
| 1 诊断总览、2 资产负债、3 收支 | `AnalyzeFamilyMembers`、`AnalyzeAssetLiability`、`AnalyzeIncomeExpense` |
| 4 财务指标 | `AnalyzeFinancialIndicators` |
| 5 目标、6 现金流 | 用户 `goals` + `AnalyzeCashFlow`（有目标时） |
| 7 配置 | `GetAssetAllocationPlan`、按需 `GetCompositeModel` |
| 8～9 保障/负债 | 以用户输入与规则文案为主；缺数据则标注 |

**必填**：`assets_liabilities`、`income_expenses`  
**可选**：`family_members`、`goals`、`risk_tolerance`

---

## 处理层

### （铁律）HTML 交付前置

生成 HTML 前必须遵守 [`HTML视觉模板.md` 开篇「HTML 交付铁律（强制，写死）」](../yingmi-skill/references/HTML视觉模板.md)：**先完整阅读本 `SKILL.md` 及 `scripts/`、`references/` 中与整合相关的约定，再完整阅读 `../yingmi-skill/references/demo-report.html` 全文**。`demo-report` **仅作 UI 壳**；**九大模块、顺序与字段**仅以**本 `SKILL.md`** 为准。禁止未读上述文件即交付、禁止照抄 demo 示例模块、禁止自造版式。

### 第零步：加载视觉模板

技术操作见 [HTML 视觉模板 · 生成 HTML 时（操作清单）](../yingmi-skill/references/HTML视觉模板.md#生成-html-时操作清单)；样式源 [`demo-report.html`](../yingmi-skill/references/demo-report.html)。图表与正文数据须来自本次 MCP/整合结果，**禁止**抄 demo。

### 样式与数据隔离（强约束）

- **壳层规则见「铁律」与第零步；本条约束九模块一致性：**
- 9 大模块同一指标在摘要、表格、图表中**一致**。
- 缺失模块保留标题骨架并标注 `数据暂未获取` 或省略子表（与 `market-morning-brief` 无数据不硬占位原则一致时可整块弱化，但须在 AI 观点中说明）。

### 第一步：脚本职责

- [scripts/run.py](scripts/run.py)：聚合入参、调用 `wealth-healthcheck` / `wealth-goalcalc` 计算链、**内联**输出 HTML（或 `--json` 结构化稿）。  
- [scripts/generate_report_html.py](scripts/generate_report_html.py)：可选；读 `report-input.json`、调 `run.py`、写 `report-output.html` / `report-output.json`，便于本地批跑。  
- **用户默认只见 HTML**。

---

## 输出规范

### 输出格式


| 条件 | 格式 |
| --- | --- |
| 默认 | HTML（自包含） |
| 用户明确要纯文本 | Markdown |
| 用户要 PDF | `RenderHtmlToPdf`（P1） |

### 报告固定板块（顺序固定）

1. Topbar  
2. Hero（标题 + 家庭标签 + 核心 KPI）  
3. 💡 AI 核心观点  
4. 九大模块内容区（与上文模块表顺序一致）  
5. 免责声明  
6. 页脚  

### 设计硬规则

壳层与 `demo-report.html` 一致；完整 HTML；配置模块若含基金代码，卡片字段须与 `BatchGetFundsDetail` 等返回一致。

---

## MCP 工具配置（P0 必调 / P1 按需）

### P0 工具


| 工具 | 调用时机 | 产出字段 | 触发条件 |
| --- | --- | --- | --- |
| `GetCurrentTime` | 全篇 | 当前日期时间 | 报告日期、截止日 |
| `AnalyzeFamilyMembers` | 模块 1、Hero | 家庭结构、生命周期 | 画像与模块 1 |
| `AnalyzeIncomeExpense` | 模块 3 | 收支分项、结余、占比 | 模块 3 |
| `AnalyzeAssetLiability` | 模块 2 | 资产负债分项、净资产 | 模块 2 |
| `AnalyzeFinancialIndicators` | 模块 4 | 财务指标与状态 | 模块 4 |
| `AnalyzeCashFlow` | 模块 6 | 年度现金流、表格与解释 | 有目标或多年现金流 |
| `GetAssetAllocationPlan` | 模块 7 | 大类权重、方案参数/ID | 需要配置方案 |

### P1 工具


| 工具 | 调用时机 | 产出字段 | 触发条件 |
| --- | --- | --- | --- |
| `GetCompositeModel` | 模块 7 落地 | 基金及比例 | 有 `assetPlanId` 或展示落地组合 |
| `AnalyzeInvestmentPerformance` | 方案评估 | 加权收益、配置分析 | 方案是否达标类问题 |
| `MonteCarloSimulate` | 长期情景 | 分位收益、分布 | 概率化长期展望 |
| `GetTxnDayRange` | 区间叙事 | 交易日列表 | 需对齐交易日口径 |
| `BatchGetFundsDetail` | 基金卡片 | 名称、风险、费率等 | 正文出现基金代码 |
| `RenderHtmlToPdf` | 导出 | PDF | 用户要 PDF |

---

### 运行治理

- **重试与降级**：单工具最多重试 1 次，仍失败则降级输出（已有数据 + 缺失字段标注「数据暂未获取」+ 免责声明）。
- **板块完整性**：固定壳层（Topbar → Hero → 💡 AI 核心观点 → 九大模块区 → 免责声明 → 页脚）缺一不可；单模块无数据时保留标题骨架并标注。

### 板块完整性自检（必过）

- **失败示例**：缺少 Topbar / Hero / 💡 AI 核心观点 / 免责声明 / 页脚，或九大模块顺序与「报告固定板块」不一致，即判定失败。
- **最小可交付骨架（10 行以内）**：

```text
Topbar
Hero
💡 AI 核心观点
[九大模块 1..9 按输出规范顺序]
免责声明
页脚（Powered by 盈米MCP · {{日期}}）
```

---

## 质量标准

- **数据可追溯**：各模块数字来自用户输入、MCP 或 `scripts/run.py` 整合链；禁止编造基金业绩或方案收益。
- **跨区一致性**：同一指标在 Hero、表格、图表与叙述中一致。
- **免责声明**：每份报告末尾必须出现。

---

## 最小输入集（MIS）


| 场景        | 最小必填输入                         | 可选输入                                       | 缺失处理                |
| --------- | ------------------------------ | ------------------------------------------ | ------------------- |
| 整合 HTML 报告 | `assets_liabilities`、`income_expenses` | `family_members`、`goals`、`risk_tolerance` | 追问关键字段或对缺模块标注「数据暂未获取」 |


---

## 错误处理


| 场景            | 处理方式                          |
| ------------- | ----------------------------- |
| MCP 工具调用失败    | 已获取模块正常输出，失败模块标注原因，不输出空白页   |
| `run.py` 入参不完整 | 列出缺失 JSON 字段，提示补全后再跑          |
| 用户仅提供部分模块数据   | 输出已有模块 + 其余模块骨架 + 标注            |


---

## 注意事项

- **单只基金深度分析**（诊断/持仓/归因）不在本 skill 默认 P0；用户追问某基金时，按需调用 `fund-analyst` 工具集或转入该 skill。
- **并行调用**：无依赖的 MCP 可合并请求以降低延迟。

---

## 资源索引

- [scripts/run.py](scripts/run.py)：整合与 HTML 渲染入口（stdin）  
- [scripts/generate_report_html.py](scripts/generate_report_html.py)：本地文件批处理包装（可选）  
- [HTML 视觉模板](../yingmi-skill/references/HTML视觉模板.md)  
- [demo-report.html](../yingmi-skill/references/demo-report.html)  

---

## 自测用例


| 用例       | 场景              | 预期工具链     | 核心通过标准                                  |
| -------- | --------------- | --------- | --------------------------------------- |
| A 九模块成稿 | 用户提供完整家庭财务 JSON | 依模块调用 P0 表 | HTML 含九大模块 + 免责 + 页脚          |
| B 部分 MCP 失败 | 模拟某一 P0 工具失败    | 其余工具可用    | 成功模块正常展示，失败模块有原因标注，不整份空白              |


**失败判定**：无免责声明 / 固定板块顺序错乱或整块缺失且无标注

---

## 快速启动

分场景示范提示语见本目录 [README.md](README.md#快速启动)。
