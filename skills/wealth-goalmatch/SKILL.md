---
name: wealth-goalmatch
description: 当用户需要系统推荐 2～4 个财富目标优先级、评估现有目标是否合理、或根据家庭与财务数据给出目标金额/期限/月投建议时使用。默认输出 HTML；规则见 references，计算见 scripts/run.py。
---

# 财富目标匹配（Wealth Goal Match）

## 核心价值定位

- 在已有财务数据基础上**排序与补充**目标（必要型/期望型），输出可执行的参数建议。
- **默认交付 HTML**；推荐逻辑与阈值扩展见 `references/recommendation_rules.md`。
- 与 `wealth-family-advisor` 串联时作为「目标发现」子模块。

## 合规边界

- 推荐理由与数字须来自**用户输入、MCP 返回或脚本计算**；禁止虚构目标完成度。
- **不构成投资建议**；须有免责声明与风险提示。

---

## 输入层

### 交互流程

```
用户描述家庭与财务 → MCP 构造 assets_liabilities / income_expenses → scripts/run.py → HTML
```

### 输入与意图


| 数据状态 | 处理方式 |
| -------- | -------- |
| 无结构化资产负债/收支 | 必调 P0：`AnalyzeAssetLiability`、`AnalyzeIncomeExpense` |
| 需 Hero KPI 与文案一致 | `AnalyzeFinancialIndicators` |
| 有成员/生命周期叙事 | P1：`AnalyzeFamilyMembers`、`AnalyzeCashFlow` |

**必填**：`assets_liabilities`、`income_expenses`  
**可选**：`family_members`、`existing_goals`、`user_age`、`retirement_age`、`risk_tolerance`

---

## 处理层

### （铁律）HTML 交付前置

生成 HTML 前必须遵守 [`HTML视觉模板.md` 开篇「HTML 交付铁律（强制，写死）」](../yingmi-skill/references/HTML视觉模板.md)：**先完整阅读本 `SKILL.md` 及 `references/recommendation_rules.md` 等引用，再完整阅读 `../yingmi-skill/references/demo-report.html` 全文**。`demo-report` **仅作 UI 壳**；**目标推荐逻辑、固定板块与表图**仅以**本 `SKILL.md`** 为准。禁止未读上述文件即交付、禁止照抄 demo 示例、禁止自造版式。

### 第零步：加载视觉模板

技术操作见 [HTML 视觉模板 · 生成 HTML 时（操作清单）](../yingmi-skill/references/HTML视觉模板.md#生成-html-时操作清单)；样式源 [`demo-report.html`](../yingmi-skill/references/demo-report.html)。无图表可不引 ECharts；**禁止**照抄 demo 示例数据。

### 样式与数据隔离（强约束）

- **壳层规则见「铁律」与第零步；本条约束目标匹配数据：**
- KPI、表格、推荐卡片中的数值均须来自**本次** MCP 或脚本；不得复用历史会话数字。
- 缺失标注 `数据暂未获取`；输出前核对月投合计与月结余口径一致。

### 第一步：规则与脚本

- 优先级与业务规则扩展、维护位置：[references/recommendation_rules.md](references/recommendation_rules.md)。  
- 执行入口：[scripts/run.py](scripts/run.py)（stdin JSON，默认 HTML）。

---

## 输出规范

### 输出格式


| 条件 | 格式 |
| --- | --- |
| 默认 | HTML（自包含） |
| 用户明确要纯文本 | Markdown |

### 固定板块（顺序固定）

1. Topbar  
2. Hero（家庭概览 + 月结余 + 目标可行性 KPI）  
3. 💡 AI 核心观点  
4. 现有目标评估  
5. 新目标推荐（优先级 1～4）  
6. 月度投入可行性  
7. 行动建议  
8. 免责声明  
9. 页脚  

### 设计硬规则

壳层类名与 `demo-report.html` 一致；完整 HTML；禁止自造整页样式替代模板。

---

## MCP 工具配置（P0 必调 / P1 按需）

### P0 工具


| 工具 | 调用时机 | 产出字段 | 触发条件 |
| --- | --- | --- | --- |
| `GetCurrentTime` | 报告生成前 | 当前日期时间 | 截止日、页脚 |
| `AnalyzeAssetLiability` | 构造 `assets_liabilities` | 资产负债分项、净资产 | 用户未给结构化资产负债 |
| `AnalyzeIncomeExpense` | 构造 `income_expenses` | 月收支、结余 | 用户未给结构化收支 |
| `AnalyzeFinancialIndicators` | Hero KPI、文案对齐 | 储蓄率、应急覆盖、杠杆等及评级 | 需官方口径支撑 KPI |

### P1 工具


| 工具 | 调用时机 | 产出字段 | 触发条件 |
| --- | --- | --- | --- |
| `AnalyzeFamilyMembers` | 推荐理由、生命周期 | 家庭结构、阶段标签 | 有成员或推断子女/养老优先级 |
| `AnalyzeCashFlow` | 多年压力测试 | 年度现金流、解释 | 关注多年度能否承受月投 |

---

### 运行治理

- **重试与降级**：单工具最多重试 1 次，仍失败则降级输出（已有数据 + 缺失字段标注「数据暂未获取」+ 免责声明）。
- **板块完整性**：输出规范「固定板块」缺一不可；月投合计与月结余口径须在成稿前自检一致。

### 板块完整性自检（必过）

- **失败示例**：缺少 Topbar / Hero / 💡 AI 核心观点 / 免责声明 / 页脚即判定失败。
- **最小可交付骨架（10 行以内）**：

```text
Topbar
Hero
💡 AI 核心观点
现有目标评估
新目标推荐
月度投入可行性
行动建议
免责声明
页脚（Powered by 盈米MCP · {{日期}}）
```

---

## 质量标准

- **数字可溯源**：KPI、推荐卡片、月投可行性均来自本次 MCP 或 `scripts/run.py`；禁止复用历史会话数值。
- **规则一致**：优先级与阈值以 [references/recommendation_rules.md](references/recommendation_rules.md) 为准。
- **免责声明**：每份报告末尾必须出现。

---

## 最小输入集（MIS）


| 场景     | 最小必填输入                         | 可选输入                                                                                    | 缺失处理        |
| ------ | ------------------------------ | --------------------------------------------------------------------------------------- | ----------- |
| 目标匹配报告 | `assets_liabilities`、`income_expenses` | `family_members`、`existing_goals`、`user_age`、`retirement_age`、`risk_tolerance` | 先 MCP 构造入参或追问 |


---

## 错误处理


| 场景           | 处理方式                              |
| ------------ | --------------------------------- |
| MCP 工具调用失败 | 已得数据输出推荐骨架，失败字段标注，不空白            |
| 入参无法构造结构化数据 | 提示用户补充资产负债/收支口径                 |
| 脚本导入失败       | 检查 `financial-analysis` 包路径与 `run.py` 工作目录 |


---

## 注意事项

- 调整推荐阈值优先改 `references/recommendation_rules.md`，再视需要改 `run.py`。

---

## 资源索引

- [references/recommendation_rules.md](references/recommendation_rules.md)：推荐规则与扩展说明  
- [scripts/run.py](scripts/run.py)：推荐计算与 HTML 渲染入口  
- [HTML 视觉模板](../yingmi-skill/references/HTML视觉模板.md)  
- [demo-report.html](../yingmi-skill/references/demo-report.html)  

---

## 自测用例


| 用例     | 场景          | 预期工具链 | 核心通过标准                    |
| ------ | ----------- | ----- | ------------------------- |
| A 完整推荐 | 口述财务经 MCP 构造 | P0 表  | HTML 含 2～4 个目标优先级 + 月投可行性 + 免责 |
| B 工具失败 | 模拟 P0 失败    | 其余可用  | 有降级说明，不无输出                |


**失败判定**：无免责声明 / 月投合计与结余口径矛盾 / 固定板块缺失

---

## 快速启动

分场景示范提示语见本目录 [README.md](README.md#快速启动)。
