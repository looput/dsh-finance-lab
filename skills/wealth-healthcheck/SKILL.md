---
name: wealth-healthcheck
description: 当用户要快速做家庭财务健康体检、看 9 项指标与评级、或需要结构化 HTML 体检报告时使用。本地脚本计算指标；MCP 用于把口述数据变为入参或与官方指标口径对齐。
---

# 财务健康体检（Wealth Health Check）

## 核心价值定位

- 输出 **9 项财务健康指标**（数值 + 区间 + 评级 + 可执行建议）及总览。
- **默认 HTML**；计算链：`summary` → `indicators` → `rating`（见 `scripts/`）。
- 可与 `wealth-report`、`wealth-family-advisor` 串联。

## 合规边界

- 指标值须来自**用户输入、MCP 或脚本计算**；禁止臆测资产负债。
- **不构成投资建议**；须有免责声明。

---

## 输入层

### 交互流程

```
用户/对话数据 → [可选] MCP 构造 JSON → scripts/run.py → HTML
```

### 输入与意图


| 场景 | 处理 |
| --- | --- |
| 口述资产与收支 | `AnalyzeAssetLiability` + `AnalyzeIncomeExpense` 生成结构化入参 |
| 需与且慢指标表述对齐 | `AnalyzeFinancialIndicators` 交叉验证或补充叙事 |
| 展示家庭画像 | P1：`AnalyzeFamilyMembers` |

**必填**：`assets_liabilities`、`income_expenses`  
**可选**：`family_members`

---

## 处理层

### （铁律）HTML 交付前置

生成 HTML 前必须遵守 [`HTML视觉模板.md` 开篇「HTML 交付铁律（强制，写死）」](../yingmi-skill/references/HTML视觉模板.md)：**先完整阅读本 `SKILL.md` 及 `references/*`（公式、评级、schema），再完整阅读 `../yingmi-skill/references/demo-report.html` 全文**。`demo-report` **仅作 UI 壳**；**9 项指标、固定板块顺序与脚本计算链**仅以**本 `SKILL.md` + `scripts/`** 为准。禁止未读上述文件即交付、禁止照抄 demo 示例指标、禁止自造版式。

### 第零步：加载视觉模板

技术操作见 [HTML 视觉模板 · 生成 HTML 时（操作清单）](../yingmi-skill/references/HTML视觉模板.md#生成-html-时操作清单)；样式源 [`demo-report.html`](../yingmi-skill/references/demo-report.html)。有图表时数据须来自真实入参或 MCP，**禁止**抄 demo 示例数组。

### 样式与数据隔离（强约束）

- **壳层规则见「铁律」与第零步；本条约束体检指标：**
- **9 项指标以本地 `scripts/indicators.py` + `rating.py` 为准**；MCP 指标用于对齐口径或文案，不得与本地结果矛盾而不加说明。
- 缺失字段标注 `数据暂未获取`；表格/图表同一指标数值一致。

### 第一步：计算链与参考文档

| 环节 | 脚本/资源 |
| --- | --- |
| 汇总 | [scripts/summary.py](scripts/summary.py) |
| 指标 | [scripts/indicators.py](scripts/indicators.py) |
| 评级 | [scripts/rating.py](scripts/rating.py) + [references/rating_thresholds.json](references/rating_thresholds.json) |
| 公式与口径 | [references/indicator_formulas.md](references/indicator_formulas.md)、[references/summary_rules.md](references/summary_rules.md) |
| 入参 JSON 约定 | [references/data_schema.md](references/data_schema.md) |

入口：[scripts/run.py](scripts/run.py)

---

## 输出规范

### 输出格式


| 条件 | 格式 |
| --- | --- |
| 默认 | HTML（自包含） |
| 用户明确要纯文本 | Markdown |

### 固定板块（顺序固定）

1. Topbar  
2. Hero（净资产/负债率/储蓄率/流动性 KPI）  
3. 💡 AI 核心观点  
4. 财务总览  
5. 9 项指标仪表盘  
6. 风险与短板（Top 3）  
7. 优先改进动作  
8. 免责声明  
9. 页脚  

### 设计硬规则

与 `demo-report.html` 同壳层与类名；深浅色切换保留；禁止自造整页样式。

---

## MCP 工具配置（P0 必调 / P1 按需）

### P0 工具


| 工具 | 调用时机 | 产出字段 | 触发条件 |
| --- | --- | --- | --- |
| `GetCurrentTime` | 报告生成前 | 当前日期时间 | 截止日、页脚 |
| `AnalyzeAssetLiability` | 构造 `assets_liabilities` | 资产负债分项、比率、解读 | 入参需抽取或校验 |
| `AnalyzeIncomeExpense` | 构造 `income_expenses` | 月收支分项、占比、结余 | 同上 |
| `AnalyzeFinancialIndicators` | 口径对齐或叙事 | 多项指标及合理区间/状态 | 需与 MCP 表述一致或补维度 |

### P1 工具


| 工具 | 调用时机 | 产出字段 | 触发条件 |
| --- | --- | --- | --- |
| `AnalyzeFamilyMembers` | 家庭画像区 | 成员列表、生命周期 | `family_members` 非空或展示画像 |

---

### 运行治理

- **重试与降级**：单工具最多重试 1 次，仍失败则降级输出（已有数据 + 缺失字段标注「数据暂未获取」+ 免责声明）。
- **板块完整性**：输出规范「固定板块」缺一不可；本地脚本计算的 9 项指标须与 `indicators.py` / `rating.py` 一致。

### 板块完整性自检（必过）

- **失败示例**：缺少 Topbar / Hero / 💡 AI 核心观点 / 9 项指标区 / 免责声明 / 页脚即判定失败。
- **最小可交付骨架（10 行以内）**：

```text
Topbar
Hero
💡 AI 核心观点
财务总览
9 项指标仪表盘
风险与短板
优先改进动作
免责声明
页脚（Powered by 盈米MCP · {{日期}}）
```

---

## 质量标准

- **脚本口径优先**：9 项指标与评级以本地 `scripts/indicators.py`、`rating.py` 为准；MCP 仅用于对齐表述，不得与本地结果矛盾而不说明。
- **数值一致**：总览、仪表盘、叙述中同一指标一致；缺失标注「数据暂未获取」。
- **免责声明**：每份报告末尾必须出现。

---

## 最小输入集（MIS）


| 场景     | 最小必填输入                         | 可选输入            | 缺失处理           |
| ------ | ------------------------------ | --------------- | -------------- |
| HTML 体检 | `assets_liabilities`、`income_expenses` | `family_members` | 追问或标注后降级展示缺项区 |


---

## 错误处理


| 场景           | 处理方式                     |
| ------------ | ------------------------ |
| MCP 工具调用失败 | 已得数据正常展示，失败项标注原因，不整份留空 |
| 入参 JSON 字段缺失 | 列出缺失键，提示对照 `data_schema.md` |
| 脚本执行失败       | 提示检查 `run.py` 依赖与入参格式   |


详细的指标与汇总规则见 [references/indicator_formulas.md](references/indicator_formulas.md)、[references/summary_rules.md](references/summary_rules.md)。

---

## 注意事项

- 修改指标定义或阈值：优先改 `references/` 与 `rating_thresholds.json`，再跑通 `run.py`。

---

## 资源索引

- [references/data_schema.md](references/data_schema.md)：输入 JSON 约定  
- [references/indicator_formulas.md](references/indicator_formulas.md)：指标公式  
- [references/summary_rules.md](references/summary_rules.md)：汇总规则  
- [references/rating_thresholds.json](references/rating_thresholds.json)：评级阈值  
- [scripts/run.py](scripts/run.py)：主入口  
- [HTML 视觉模板](../yingmi-skill/references/HTML视觉模板.md)  
- [demo-report.html](../yingmi-skill/references/demo-report.html)  

---

## 自测用例


| 用例      | 场景            | 预期工具链 | 核心通过标准                        |
| ------- | ------------- | ----- | ----------------------------- |
| A 标准体检 | 合法 JSON 入参    | P0 表  | HTML 含 9 项指标 + 评级 + 改进建议 + 免责声明 |
| B MCP 失败 | 模拟 P0 之一失败   | 其余可用  | 已算指标正常，失败来源标注，不空白             |


**失败判定**：无免责声明 / 9 项指标与脚本结果不一致且无说明 / 固定板块缺失

---

## 快速启动

分场景示范提示语见本目录 [README.md](README.md#快速启动)。
