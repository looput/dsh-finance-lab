# 家庭理财规划报告模板

本文件包含 4 种输出模板，AI 根据分析场景选择对应模板填充。所有 `{placeholder}` 由 数据工具返回数据填入。

---

## 模板一：完整家庭财务规划报告

用于完整规划流程，覆盖从家庭画像到配置落地的全部模块。默认输出为 HTML；本模板中的 Markdown 结构用于定义章节与字段映射。

```markdown
# {family_name}家庭财务规划报告

> 报告生成时间：{report_date}
> 数据基于用户提供信息，仅供参考

---

## 一、家庭概览

### 家庭成员
| 关系 | 姓名 | 年龄 | 职业 | 所在城市 |
|------|------|------|------|---------|
{family_members_table}

### 生命周期阶段
- **当前阶段**：{lifecycle_stage}
- **阶段特征**：{lifecycle_description}
- **理财重点**：{lifecycle_focus}

---

## 二、收支分析

### 年度收入结构
| 收入项目 | 金额（万元） | 占比 |
|---------|------------|------|
| 工资薪金 | {salary} | {salary_pct} |
| 年终奖金 | {bonus} | {bonus_pct} |
| 租金收入 | {rental} | {rental_pct} |
| 公积金提取 | {housing_fund} | {housing_fund_pct} |
| 投资收益 | {investment_income} | {investment_income_pct} |
| 经营收入 | {business_income} | {business_income_pct} |
| 其他收入 | {other_income} | {other_income_pct} |
| **合计** | **{total_income}** | **100%** |

### 年度支出结构
| 支出项目 | 金额（万元） | 占比 | 必要性 |
|---------|------------|------|--------|
| 日常花销 | {daily} | {daily_pct} | 必要 |
| 生活缴费 | {utility} | {utility_pct} | 必要 |
| 交通通勤 | {transport} | {transport_pct} | 必要 |
| 房贷还款 | {mortgage} | {mortgage_pct} | 必要 |
| 车贷还款 | {car_loan} | {car_loan_pct} | 必要 |
| 车位贷还款 | {parking_loan} | {parking_loan_pct} | 必要 |
| 保障型保费 | {insurance} | {insurance_pct} | 必要 |
| 教育支出 | {education} | {education_pct} | 半必要 |
| 医疗支出 | {medical} | {medical_pct} | 半必要 |
| 旅行支出 | {travel} | {travel_pct} | 弹性 |
| 其他支出 | {other_expense} | {other_expense_pct} | 弹性 |
| **合计** | **{total_expense}** | **100%** | — |

### 收支总结
- **年度结余**：{annual_surplus} 万元
- **结余率**：{surplus_rate}
- **月度必要性支出**：{monthly_essential} 万元
- **结余率解读**：{surplus_interpretation}

---

## 三、资产负债分析

### 资产明细
| 资产类别 | 项目 | 金额（万元） |
|---------|------|------------|
| **流动性资产** | 流动资金（现金/活期/货基） | {cash} |
| **投资性资产** | 定期存款/大额存单 | {fixed_deposit} |
| | 银行理财/债券 | {bank_finance} |
| | 基金/策略 | {fund} |
| | 股票 | {stock} |
| | 储蓄型保险 | {savings_insurance} |
| | 个人养老金 | {pension} |
| | 投资房产 | {investment_property} |
| | 其他投资 | {other_investment} |
| **自用性资产** | 自住房 | {residential} |
| | 车辆 | {vehicle} |
| | 车位 | {parking} |
| | **总资产** | **{total_assets}** |

### 负债明细
| 负债类别 | 项目 | 金额（万元） |
|---------|------|------------|
| **自用性负债** | 自住房贷款 | {mortgage_balance} |
| | 车贷 | {car_loan_balance} |
| | 车位贷 | {parking_loan_balance} |
| **投资性负债** | 投资房贷款 | {investment_mortgage} |
| | 其他投资贷款 | {investment_loans} |
| **流动性负债** | 信用卡 | {credit_card} |
| | 个人借贷 | {personal_loan} |
| | 其他借款 | {other_debt} |
| | **总负债** | **{total_liabilities}** |

### 资产负债总结
- **净资产**：{net_assets} 万元
- **资产负债率**：{debt_ratio}
- **解读**：{asset_liability_interpretation}

---

## 四、财务健康仪表盘

| 指标 | 数值 | 参考范围 | 状态 | 解读 |
|------|------|---------|------|------|
| 资产负债率 | {indicator_1_value} | < 50% | {indicator_1_status} | {indicator_1_interpretation} |
| 流动比率 | {indicator_2_value} | > 3 | {indicator_2_status} | {indicator_2_interpretation} |
| 融资比率 | {indicator_3_value} | < 40% | {indicator_3_status} | {indicator_3_interpretation} |
| 即付比率 | {indicator_4_value} | > 70% | {indicator_4_status} | {indicator_4_interpretation} |
| 结余比率 | {indicator_5_value} | > 30% | {indicator_5_status} | {indicator_5_interpretation} |
| 投资回报率 | {indicator_6_value} | — | {indicator_6_status} | {indicator_6_interpretation} |
| 自由储蓄率 | {indicator_7_value} | > 20% | {indicator_7_status} | {indicator_7_interpretation} |

### 综合诊断
{overall_diagnosis}

---

## 五、现金流预测

> 本章节仅在用户有目标规划需求时生成

### 规划假设
- 预测期：{projection_years} 年（本人 {start_age} 岁 → {end_age} 岁）
- 报酬率假设：{return_rate_config}
- 通胀率假设：{inflation_rate}

### 关键目标节点
| 目标 | 时间 | 所需金额（万元） | 届时可用资产 | 是否可达成 |
|------|------|----------------|------------|-----------|
{goal_nodes_table}

### 现金流预测
{cash_flow_description}

---

## 六、资产配置方案

### 配置依据
- 风险偏好：{risk_preference}
- 投资期限：{investment_horizon}
- 预期收益/回撤：{expected_return_drawdown}

### 六大类资产权重
| 资产类别 | 配置比例 | 说明 |
|---------|---------|------|
| 股票权益 | {equity_weight} | 国内股票型/偏股混合型基金 |
| 固定收益 | {fixed_income_weight} | 债券型基金 |
| 海外权益 | {overseas_equity_weight} | QDII 股票型基金 |
| 海外固收 | {overseas_fi_weight} | QDII 债券型基金 |
| 大宗商品 | {commodity_weight} | 黄金/商品基金 |
| 货币现金 | {cash_weight} | 货币基金 |

---

## 七、配置落地清单

| 资产类别 | 基金代码 | 基金名称 | 配置比例 | 建议金额（万元） |
|---------|---------|---------|---------|----------------|
{fund_allocation_table}

### 实施建议
{implementation_advice}

---

## 免责声明

本报告由 AI 基于用户提供的财务数据和盈米且慢 工具生成，所含分析结果和配置方案仅供参考，**不构成任何投资建议、投资承诺或收益保证**。

投资有风险，入市需谨慎。实际投资前请充分了解产品风险，根据自身情况审慎决策。本报告中的财务指标解读基于通用标准，不考虑个人特殊情况，建议结合专业理财顾问意见使用。

过往业绩不代表未来表现，基金投资净值可能因市场波动而上下波动。
```

### HTML 版（完整家庭规划报告 — 默认输出格式）

模板一默认输出 HTML 仪表盘。

> **⚠️ CSS/JS 来源**：必须以 [demo-report.html](../../yingmi-skill/references/demo-report.html) 为基准，提取其 CSS 完整放入 `<style>`，JS 完整放入 `<script>`。以下仅为板块骨架。

```html
<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>{family_name}家庭财务规划报告</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
</head>
<body>
<div class="container">
  <!-- 1. 顶部主题切换 -->
  <div class="topbar">...</div>

  <!-- 2. Hero 区：hero-card + kpi-grid -->
  <div class="hero-card">...</div>

  <!-- 3. AI 核心观点 -->
  <div class="card ai-card">
    <div class="ai-title">💡 AI 核心观点</div>
    <div class="ai-conclusion">{overall_diagnosis_conclusion}</div>
    <ul class="ai-list">...</ul>
    <div class="ai-risk">⚠️ {risk_warning}</div>
  </div>

  <!-- 4. 家庭概览 -->
  <div class="card"><div class="section-title">家庭概览</div>...</div>

  <!-- 5. 收支分析（含 ECharts 饼图） -->
  <div class="card"><div class="section-title">收支分析</div>...</div>

  <!-- 6. 资产负债分析 -->
  <div class="card"><div class="section-title">资产负债分析</div>...</div>

  <!-- 7. 财务健康仪表盘 -->
  <div class="card"><div class="section-title">财务健康仪表盘</div>...</div>

  <!-- 8. 资产配置方案 -->
  <div class="card"><div class="section-title">资产配置方案</div>...</div>

  <!-- 9. 配置落地清单 -->
  <div class="card"><div class="section-title">配置落地清单</div>...</div>

  <!-- 10. 免责声明 + 页脚 -->
  <div class="disclaimer">...</div>
</div>
</body>
</html>
```

---

## 模板二：收支分析专项

用于用户只需要收支分析时的简洁输出。

```markdown
## 家庭收支分析报告

### 收入结构
| 项目 | 金额（万元） | 占比 |
|------|------------|------|
{income_table}
| **合计** | **{total_income}** | **100%** |

### 支出结构
| 项目 | 金额（万元） | 占比 |
|------|------------|------|
{expense_table}
| **合计** | **{total_expense}** | **100%** |

### 核心指标
- **年度结余**：{annual_surplus} 万元
- **结余率**：{surplus_rate}（{surplus_rating}）
- **月度必要性支出**：{monthly_essential} 万元

### 分析结论
{income_expense_summary}

### 优化建议
{optimization_suggestions}

**注：以上分析基于用户提供数据，仅供参考，不构成投资建议。**
```

---

## 模板三：资产负债专项

用于用户只需要资产负债分析时。

```markdown
## 家庭资产负债分析报告

### 资产总览
| 类别 | 金额（万元） | 占总资产比 |
|------|------------|-----------|
| 流动性资产 | {liquid_assets} | {liquid_pct} |
| 投资性资产 | {investment_assets} | {investment_pct} |
| 自用性资产 | {personal_use_assets} | {personal_use_pct} |
| **总资产** | **{total_assets}** | **100%** |

### 负债总览
| 类别 | 金额（万元） | 占总负债比 |
|------|------------|-----------|
| 自用性负债 | {personal_use_liabilities} | {pu_liability_pct} |
| 投资性负债 | {investment_liabilities} | {inv_liability_pct} |
| 流动性负债 | {current_liabilities} | {curr_liability_pct} |
| **总负债** | **{total_liabilities}** | **100%** |

### 核心指标
- **净资产**：{net_assets} 万元
- **资产负债率**：{debt_ratio}（{debt_rating}）

### 财务指标评估
| 指标 | 数值 | 状态 | 解读 |
|------|------|------|------|
{indicators_table}

### 分析结论
{asset_liability_summary}

### 改善建议
{improvement_suggestions}

**注：以上分析基于用户提供数据，仅供参考，不构成投资建议。**
```

---

## 模板四：配置方案报告

用于用户直接要求配置方案时的专项输出。

```markdown
## 资产配置方案

### 配置依据
- **风险偏好**：{risk_preference}
- **投资期限**：{investment_horizon}
- **预期年化收益**：{expected_return}
- **预期最大回撤**：{expected_drawdown}

### 资产配置方案
| 资产类别 | 配置比例 | 说明 |
|---------|---------|------|
| 股票权益 | {equity_weight} | 国内股票型/偏股混合型基金 |
| 固定收益 | {fixed_income_weight} | 债券型基金 |
| 海外权益 | {overseas_equity_weight} | QDII 股票型基金 |
| 海外固收 | {overseas_fi_weight} | QDII 债券型基金 |
| 大宗商品 | {commodity_weight} | 黄金/商品基金 |
| 货币现金 | {cash_weight} | 货币基金 |

### 配置落地清单
| 资产类别 | 基金代码 | 基金名称 | 配置比例 | 建议金额（万元） |
|---------|---------|---------|---------|----------------|
{fund_allocation_table}

### 方案评估
{performance_assessment}

### 蒙特卡洛模拟（如有）
{monte_carlo_results}

### 实施建议
1. **分批建仓**：建议分 3-6 个月逐步建仓，降低择时风险
2. **定期再平衡**：每季度或半年检查一次配置比例，偏离目标 5% 以上时再平衡
3. **动态调整**：随年龄增长逐步降低权益比例，增加固收和现金占比

**注：以上配置方案基于历史数据和模型计算，仅供参考，不构成投资建议。投资有风险，入市需谨慎。过往业绩不代表未来表现。**
```

---

## 模板选择规则


| 用户意图                   | 使用模板            | 输出格式             |
| ---------------------- | --------------- | ---------------- |
| "帮我做个家庭财务规划"（完整流程）     | 模板一：完整规划报告      | **HTML**（自包含仪表盘） |
| 提供了收支数据，要求分析收支         | 模板二：收支分析专项      | Markdown         |
| 提供了资产负债数据，要求分析         | 模板三：资产负债专项      | Markdown         |
| "给我一个配置方案"             | 模板四：配置方案报告      | Markdown         |
| 收支 + 资产负债完整数据（未要求完整规划） | 模板二 + 模板三（组合输出） | Markdown         |
| 用户明确要求可视化/HTML/报告      | 对应模板            | **HTML**         |
| 完整数据 + 配置方案            | 模板一（完整）         | **HTML**         |


> **HTML 输出**：完整规划基于 SKILL.md「输出规范」中定义的 HTML 结构生成，包含 ECharts 图表（饼图、柱状图、仪表盘）、浅色/深色切换、响应式布局。均为完整自包含 HTML 文件。

### 模板裁剪规则

- 用户未提供资产负债数据 → 删除第三章（资产负债分析）和第四章（财务健康仪表盘）
- 用户无目标规划需求 → 删除第五章（现金流预测）
- 用户未要求配置方案 → 删除第六章（资产配置方案）和第七章（配置落地清单）
- 删除的章节不留空标题，整块移除
- 免责声明始终保留

