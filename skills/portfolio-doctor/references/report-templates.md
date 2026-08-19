# 组合诊断报告模板

本文件包含 3 种输出模板。模板一以**结构化骨架**描述每个板块的必含元素、类名和数据来源；视觉与组件规范统一参照 [demo-report.html](../../yingmi-skill/references/demo-report.html)。

---

## 模板一：完整组合诊断报告（HTML 骨架）

### 设计体系

- CSS 变量、组件样式、图表配色统一复用 `demo-report.html`
- 默认输出 HTML（自包含）；Markdown 仅用于用户明确要求简版或降级场景

### 板块清单（必出 15 + 条件 2）

以下每个板块描述了：容器类名、必含子元素、数据来源工具、图表类型。AI 按此骨架组装 HTML，不需要逐字照搬。

---

#### 板块 1：顶部主题切换

- **容器**：`.topbar`（右对齐）
- **必含**：`button.theme-btn`，内含 `#themeIcon`（🌙/☀️）+ `#themeText`（深色模式/浅色模式）
- **交互**：点击切换 `data-theme`，同步更新按钮文案，dispose + 重绘所有图表
- **样式约束**：胶囊按钮（`border-radius:999px`），禁止纯文字方框

---

#### 板块 2：Hero 区

- **容器**：`.hero-card`
- **必含子元素**：
  - `.hero-title`：固定文字"组合诊断报告"
  - `.hero-sub`：数据截止日 + 生成时间 + 数据来源工具列表
  - `.kpi-grid`（4 列网格），每个 `.kpi` 含 `.label` + `.val`：
    1. 组合总金额（用户输入）
    2. 持仓基金数（用户输入）
    3. 组合风险评分 /100（`AnalyzePortfolioRisk`）
    4. 模型解释度 R²（`AnalyzePortfolioRisk`）

---

#### 板块 3：AI 核心观点

- **容器**：`.card.ai-card`（浅蓝渐变底，`!important` 覆盖 `.card` 默认白底）
- **必含子元素**：
  - `.ai-title`：💡 + "AI 核心观点"
  - `.ai-conclusion`：一句可执行结论
  - `.ai-list`（5 条 `<li>`）：资产配置得分+解读、相关性得分+解读、回测得分+解读、亮点、综合健康度+总结
  - `.ai-risk`：⚠️ 风险提示（黄色边框条）
- **数据来源**：`DiagnoseFundPortfolio`（三维评分）+ AI 综合解读
- **约束**：结论 + 5 点 + 风险提示缺一不可

---

#### 板块 4：三维健康度雷达

- **容器**：`.card`
- **标题**：`.section-title` "组合健康度（三维评分）"
- **布局**：`.charts-grid`（左图右卡片）
  - 左：`.chart-box` 内 ECharts **radar** 图（id=`radarChart`），三维度满分 5
  - 右：3 个 `.risk-item`，每个含：维度名 + 得分/5 + `.badge`（badge-ok/warn/danger）+ 一句描述
- **数据来源**：`DiagnoseFundPortfolio`
- **徽章规则**：≥4 分 `badge-ok`、3 分 `badge-warn`、≤2 分 `badge-danger`

---

#### 板块 5：资产配置穿透分析

- **容器**：`.card`
- **标题**：`.section-title` "资产配置穿透分析"
- **布局**：`.charts-grid`
  - 左：`.chart-box` 内 ECharts **pie**（id=`assetPie`），环形图，穿透后六大类分布
  - 右：`.chart-box` 内 ECharts **bar**（id=`weightBar`），各基金权重柱图
- **底部**：配置诊断文字块（N 项提醒，`<ul>` 循环）
- **数据来源**：`GetFundAssetClassAnalysis`（饼图）+ `GetAssetAllocation`（诊断文字）+ 用户输入（权重柱图）

---

#### 板块 6：相关性分析

- **容器**：`.card`
- **标题**：`.section-title` "基金相关性分析"
- **图表**：`.chart-full` 内 ECharts **heatmap**（id=`corrHeatmap`），基金名为轴，颜色映射相关系数
- **表格**：列=基金A / 基金B / 相关系数 / 判定（badge）/ 建议
  - \> 0.8 行加 `.corr-high`（红底）
  - 按 C(n,2) 对数循环生成
- **数据来源**：`GetFundsCorrelation`
- **颜色规则**：> 0.8 红 / 0.5-0.8 黄 / < 0.5 绿 / < 0 深绿

---

#### 板块 7：回测表现

- **容器**：`.card`
- **标题**：`.section-title` "历史回测表现（{period}）"
- **副标题**：回测区间 + 加权方式
- **指标**：`.risk-detail`（2×2 网格），每个 `.risk-item`：
  1. 年化收益率（涨跌色）
  2. 最大回撤（涨跌色）
  3. 年化波动率
  4. 夏普比率（涨跌色）
- **底部**：回撤详情文字（最大回撤起止时间、持续期、跌幅换算为金额）
- **数据来源**：`GetFundsBackTest`

---

#### 板块 7A：净值曲线 + 回撤走势

- **容器**：`.card`
- **标题**：`.section-title` "组合净值走势与回撤"
- **副标题**：数据来源 + 区间
- **布局**：`.charts-grid`
  - 左：`.chart-box` 内 ECharts **line**（id=`navLineChart`）— 组合净值粗线 + 各基金净值细线，`showSymbol:false`，`smooth:true`
  - 右：`.chart-box` 内 ECharts **line+areaStyle**（id=`drawdownAreaChart`）— 红色面积图，y 轴为负值百分比
- **底部**：走势解读文字
- **数据来源**：`GetPortfolioNavHistory`（组合净值）+ `BatchGetFundNavHistory`（各基金净值）
- **数据配合逻辑**：
  1. `GetPortfolioNavHistory` 返回组合级别的日频净值序列 → 用于绘制**组合净值粗线**和**回撤面积图**
  2. `BatchGetFundNavHistory` 返回各基金独立的日频净值序列 → 用于绘制**各基金净值细线**
  3. 当数据量过大（日频数据可达数千行）时，必须编写脚本提取月末净值（每月最后一个交易日），将各基金净值归一化（除以首期净值）后绘制对比曲线
  4. 组合净值可直接使用 `GetPortfolioNavHistory` 返回值；各基金净值严禁估算，必须从 `BatchGetFundNavHistory` 真实提取
  5. 两个工具的时间轴可能不完全重合，取交集日期区间，x 轴标签按月展示
- **防御**：`if(document.getElementById('navLineChart'))` — 数据获取失败时不渲染

---

#### 板块 7B：风险偏好适配分析（条件板块）

> 仅当用户提供了风险偏好/投资期限时展示

- **容器**：`.card`
- **标题**：`.section-title` "风险偏好适配分析"
- **布局**：`.match-card`（flex 两列 + VS 分隔）
  - 左列：用户风险偏好 + 可承受回撤 + 投资期限
  - 右列：组合实际风险特征 + 实际最大回撤 + 风险评分
- **底部**：`.match-verdict`（匹配判定），三级：`match-ok`/`match-warn`/`match-danger`
- **数据来源**：用户输入 + `AnalyzePortfolioRisk` + `GetFundsBackTest`

---

#### 板块 8：组合风险评估

- **容器**：`.card`
- **标题**：`.section-title` "组合风险评估（AnalyzePortfolioRisk）"
- **指标**：`.risk-detail`（2×2 网格），每个 `.risk-item` 含值 + 一句解释：
  1. 风险评分 /100
  2. 模型解释度 R²
  3. 残差方差
  4. 标准误差
- **数据来源**：`AnalyzePortfolioRisk`

---

#### 板块 8A：基金横向对比

- **容器**：`.card`
- **标题**：`.section-title` "基金横向对比"
- **布局**：`.charts-grid`
  - 左：`.chart-box` 内 ECharts **radar**（id=`fundCompareRadar`），四维度=近1年收益/夏普/波动控制/回撤控制，每只基金一条线
  - 右：维度说明 + 对比解读文字
- **数据来源**：`GetBatchFundPerformance`（归一化到 0-100 分）
- **归一化规则**：近1年收益=同类排名百分位；夏普=min(100, sharpe×50)；波动控制=max(0, 100-vol×3)；回撤控制=max(0, 100+drawdown×2)
- **防御**：`if(document.getElementById('fundCompareRadar'))` — 数据获取失败时不渲染

---

#### 板块 9A：基金明细（卡片式）

- **容器**：`.card`
- **标题**：`.section-title` "基金明细"
- **循环**：每只基金一个 `.fund-card`，含：
  - `<h4>`：代码 + 名称 + `.badge`（权重百分比）
  - `.meta`：经理 · 管理年限 · 任期回报 · 规模 · 风险等级 · 基金类型 · 行业
  - `.fund-mini-grid`（4 列）：最新净值 / 近1年收益（涨跌色）/ 近1年排名 / 近1年回撤
  - `.tag-row`：各阶段收益标签（badge-ok/badge-danger）
  - 解读文字：1-2 句 AI 对该基金的点评
- **数据来源**：`BatchGetFundsDetail` + `GetBatchFundPerformance`

---

#### 板块 9B：各阶段收益对比表

- **容器**：`.card`
- **标题**：`.section-title` "各阶段收益对比"
- **表格列**：基金 / 近1周 / 近1月 / 近3月 / 近6月 / 近1年 / 近3年 / 近5年 / 今年来
- **循环行**：每只基金一行（涨跌色），最后追加同类均值行（`background:var(--inset-bg)`）
- **同类均值行规则**：当组合中所有基金属于同一分类（如均为混合型），输出 1 行"同类平均"；当基金跨类型（如混合型+股票型），必须按类型拆分为多行（如"混合型同类均值"和"股票型同类均值"），每行标注对应基金代码，数据取各基金自身的 `similarAvgReturn`，禁止混用不同类别的同类均值
- **数据来源**：`GetBatchFundPerformance`（各基金的 `stageReturns[].similarAvgReturn`）

---

#### 板块 10：优化建议

- **容器**：`.card`
- **标题**：`.section-title` "优化建议（问题 → 动作 → 预期效果）"
- **表格**：`.opt-table`，列=发现的问题（红字）/ 建议动作 / 预期效果（绿字），3-6 行
- **数据来源**：AI 综合解读（基于 diagnosis-playbook.md 第三章规则生成）

---

#### 板块 10A：优化前后对比

- **容器**：`.card`
- **标题**：`.section-title` "优化前后对比（预期）"
- **表格列**：指标 / 当前组合 / 优化后（预期）/ 变化
- **固定行**：资产配置评分、相关性评分、预期最大回撤、预期夏普比率
- **底部注释**：`⚠️ "优化后"列为基于优化方向的定性预期判断，非精确计算值，仅供参考。`
- **数据来源与真实性边界**：
  - "当前组合"列：必须 100% 来自 MCP 工具返回值（`DiagnoseFundPortfolio` 的三维评分、`GetFundsBackTest` 的最大回撤和夏普）
  - "优化后（预期）"列：此列为唯一允许定性推断的板块；推断依据必须写明（如"降低高相关基金权重 → 预期相关性评分提升"），禁止捏造具体数值（如"夏普从 0.5 提升到 0.8"），应使用方向性表述（如"↑ 改善"/"↓ 下降"/"→ 持平"）
  - "变化"列：当优化后为定性表述时，变化列也使用方向箭头，不得出现精确数字差值

---

#### 板块 11：蒙特卡洛模拟（条件板块）

> 仅在预测模拟模式下展示

- **容器**：`.card`
- **标题**：`.section-title` "蒙特卡洛模拟（未来收益概率分布）"
- **副标题**：模拟周期 + 次数
- **图表**：`.chart-full` 内 ECharts **bar**（id=`monteCarloChart`）— 五层叠柱（P10/P25/P50/P75/P90），x 轴为模拟周期
- **指标**：`.monte-stats`（3 列网格）：乐观P90 / 中性P50 / 悲观P10
- **底部**：模拟解读文字
- **数据来源**：`MonteCarloSimulate`
- **防御**：`if(document.getElementById('monteCarloChart'))` — 数据获取失败时不渲染

---

#### 免责声明 + 页脚

- `.disclaimer`：标准免责声明文字
- `.footer`："Powered by 盈米MCP · {日期}"

---

### ECharts 图表配置要点

| 图表 | 容器 ID | 类型 | 关键配置 |
|------|---------|------|---------|
| 三维雷达 | `radarChart` | radar | 三维度满分5，circle形，areaStyle 半透明 |
| 资产饼图 | `assetPie` | pie | 环形（radius 42%-70%），label 显示名称+百分比 |
| 权重柱图 | `weightBar` | bar | barWidth 38，顶部 label 显示百分比 |
| 热力图 | `corrHeatmap` | heatmap | visualMap 0.5-1，绿→黄→红，label 白字加粗 |
| 净值曲线 | `navLineChart` | line | 组合粗线(2.5)各基金细线(1.2)，smooth，无symbol |
| 回撤走势 | `drawdownAreaChart` | line+area | 红色渐变面积，y轴负值百分比 |
| 基金对比 | `fundCompareRadar` | radar | 四维度满分100，每只基金一条线，areaStyle 低透明 |
| 蒙特卡洛 | `monteCarloChart` | bar | 五层叠柱(barGap -100%)，P50 显示 label |

所有图表必须在主题切换时 `dispose()` + 重新 `init()` + `setOption()`。

### 板块动态规则

| 区块 | 动态行为 |
|------|---------|
| 基金明细卡片（9A） | 按实际基金数量（2-20）循环 |
| 相关性表格（6） | 按 C(n,2) 对数循环，> 0.8 加 `.corr-high` |
| 各阶段收益表（9B） | 按基金数循环，最后加"同类平均"行 |
| 优化建议表（10） | 按诊断发现生成 3-6 行 |
| 涨跌色 | 正值 `val-up`（红），负值 `val-down`（绿） |
| 徽章等级 | ≤2 分 `badge-danger`、3 分 `badge-warn`、≥4 分 `badge-ok` |
| 板块 7B | 条件展示：用户提供了风险偏好时 |
| 板块 11 | 条件展示：预测模拟模式时 |

### 板块完整性清单（交付前自检）

**必出（14）：**
1. 顶部主题切换（胶囊按钮）
2. Hero 区（标题+副标题+4 KPI）
3. AI 核心观点（浅蓝卡+结论+5点+风险提示）
4. 三维健康度（雷达图+3评分卡）
5. 资产配置穿透（饼图+柱图+诊断文字）
6. 相关性分析（热力图+明细表）
7. 回测表现（4指标卡+回撤详情）
7A. 净值曲线+回撤走势（双图+解读）
8. 组合风险评估（4指标卡）
8A. 基金横向对比（四维雷达+解读）
9A. 基金明细（每只独立卡片+解读）
9B. 各阶段收益对比表（含同类平均行）
10. 优化建议（问题→动作→预期效果）
10A. 优化前后对比表
免责声明+页脚

**条件（2）：**
7B. 风险偏好适配（用户提供了风险偏好时）
11. 蒙特卡洛模拟（预测模拟模式时）

---

## 模板二：快速诊断摘要

用于搭配评估模式，或用户要求简洁输出时。

```markdown
## 组合快速诊断

> {fund_count} 只基金 | {total_amount} 元 | {data_date}

### 健康度：{health_icon} {health_level}（{avg_score}/5）

| 维度 | 评分 | 状态 |
|------|------|------|
| 资产配置 | {asset_score}/5 | {asset_status} |
| 相关性分散 | {corr_score}/5 | {corr_status} |
| 回测表现 | {backtest_score_or_na} | {backtest_status_or_na} |

### 💡 AI 核心观点

**结论：** {ai_conclusion}

**要点：**
1. {finding_1}
2. {finding_2}
3. {finding_3}

**⚠️ 风险提示：** {risk_warning}

### 相关性速览

{corr_quick_summary}

> 若当前模式未调用回测/总诊断，`回测表现` 显示 `N/A（本模式未启用）`，不得留空。

### 资产配置速览

{asset_quick_summary}

### 快速建议
- {quick_suggestion_1}
- {quick_suggestion_2}

**免责声明：以上分析仅供参考，不构成投资建议。投资有风险，入市需谨慎。**
```

---

## 模板三：优化建议报告

用于优化建议模式，在完整诊断基础上强化优化方案部分。

```markdown
## 组合优化建议报告

> 持仓 {fund_count} 只基金，总金额 {total_amount} 元 | 数据截至 {data_date}

### 当前组合诊断

**健康度**：{health_icon} {health_level}（{avg_score}/5）

| 维度 | 评分 | 核心问题 |
|------|------|---------|
| 资产配置 | {asset_score}/5 | {asset_issue} |
| 相关性分散 | {corr_score}/5 | {corr_issue} |
| 回测表现 | {backtest_score}/5 | {backtest_issue} |

### 💡 AI 核心观点

**结论：** {ai_conclusion}

**要点：**
1. {finding_1}
2. {finding_2}
3. {finding_3}
4. {finding_4}

**⚠️ 风险提示：** {risk_warning}

### 发现的问题（按严重程度排序）

| 序号 | 问题 | 严重程度 | 影响 |
|------|------|---------|------|
| 1 | {issue_1} | {severity_1} | {impact_1} |
| 2 | {issue_2} | {severity_2} | {impact_2} |
| 3 | {issue_3} | {severity_3} | {impact_3} |

### 优化建议

#### 建议一：{suggestion_title_1}
- **问题**：{problem_1}
- **建议动作**：{action_1}
- **预期效果**：{effect_1}

#### 建议二：{suggestion_title_2}
- **问题**：{problem_2}
- **建议动作**：{action_2}
- **预期效果**：{effect_2}

#### 建议三：{suggestion_title_3}
- **问题**：{problem_3}
- **建议动作**：{action_3}
- **预期效果**：{effect_3}

### 推荐配置方案（如有）

> 仅在用户提供风险偏好时展示。
> 仅在用户**明确要求落地候选基金**时展示 `GetCompositeModel` 结果。

| 资产类别 | 当前占比 | 建议占比 | 调整方向 |
|---------|---------|---------|---------|
| 权益 | {current_equity} | {target_equity} | {equity_direction} |
| 固收 | {current_fi} | {target_fi} | {fi_direction} |
| 现金 | {current_cash} | {target_cash} | {cash_direction} |
| 海外 | {current_overseas} | {target_overseas} | {overseas_direction} |

### 优化前后对比（预期）

| 指标 | 当前组合 | 优化后（预期） | 变化 |
|------|---------|-------------|------|
| 资产配置评分 | {current_asset_score}/5 | {target_asset_score}/5 | {asset_change} |
| 相关性评分 | {current_corr_score}/5 | {target_corr_score}/5 | {corr_change} |
| 预期最大回撤 | {current_dd} | {target_dd} | {dd_change} |

**免责声明：以上分析和优化建议基于历史数据和统计模型，仅供参考，不构成投资建议。**
```

---

## 模板选择规则

| 用户意图 | 使用模板 | 输出格式 |
|---------|---------|---------|
| 给了持仓要求诊断/体检（默认） | 模板一 | **HTML** |
| "帮我诊断一下" + 持仓 | 模板一 | **HTML** |
| "搭配合不合理" | 模板二 | **HTML（默认）** / Markdown（用户要求时） |
| "帮我优化组合" | 模板三 | **HTML** |
| "未来表现怎么样" | 模板一 + 板块 11 | **HTML** |
| 用户要求简洁/纯文本 | 模板二 | Markdown |

> **HTML 输出**：按模板一骨架组装完整自包含 HTML，样式统一复用 `demo-report.html`。
