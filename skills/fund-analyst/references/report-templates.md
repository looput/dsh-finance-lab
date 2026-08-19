# 基金分析报告模板

本文件包含 5 种输出模板，AI 根据分析场景选择对应模板填充。所有 `{placeholder}` 由 MCP 工具返回数据填入。

输出格式约定：默认输出 HTML（自包含）；仅在用户明确要求纯文本/简版，或触发降级时输出 Markdown。

---

## 模板一：单只基金完整分析

```markdown
## {fund_name}（{fund_code}）完整分析报告

### 基本信息
- 基金代码：{fund_code}
- 基金名称：{fund_name}
- 基金类型：{fund_type}
- 风险等级：{risk_level}
- 成立日期：{establishment_date}
- 基金规模：{fund_size}（截至 {size_date}）
- 基金经理：{fund_manager}（任职 {manager_tenure}）
- 管理公司：{management_company}
- 业绩基准：{benchmark}
- 最新净值：{net_value}（{nav_date}）
- 累计净值：{cumulative_net_value}
- 日涨跌：{daily_change}

### 业绩表现
| 区间 | 基金收益 | 同类平均 | 排名 | 评价 |
|------|---------|---------|------|------|
| 近 1 月 | {month_1} | {month_1_avg} | {month_1_rank} | {month_1_rating} |
| 近 3 月 | {month_3} | {month_3_avg} | {month_3_rank} | {month_3_rating} |
| 近 6 月 | {month_6} | {month_6_avg} | {month_6_rank} | {month_6_rating} |
| 近 1 年 | {year_1} | {year_1_avg} | {year_1_rank} | {year_1_rating} |
| 近 3 年 | {year_3} | {year_3_avg} | {year_3_rank} | {year_3_rating} |
| 今年来 | {this_year} | {this_year_avg} | {this_year_rank} | {this_year_rating} |
| 成立以来 | {since_inception} | {since_inception_avg} | {since_inception_rank} | — |

> 评价列按 analysis-playbook.md 第三章「业绩排名解读」标准填写。
> 新基金缺失的长期数据行直接删除，不保留空行。

### 风险评估
| 指标 | 数值 | 同类排名 | 解读 |
|------|------|---------|------|
| 近 1 年波动率 | {volatility_1y} | {vol_rank} | {vol_interpret} |
| 近 1 年最大回撤 | {max_drawdown_1y} | {dd_rank} | {dd_interpret} |
| 近 1 年夏普比率 | {sharpe_1y} | {sharpe_rank} | {sharpe_interpret} |
| 今年来最大回撤 | {max_drawdown_ytd} | {dd_ytd_rank} | {dd_ytd_interpret} |

> 解读列按 analysis-playbook.md 第三章「风险指标解读」标准填写。

### 持仓分析

#### 资产配置
| 资产类型 | 配置比例 |
|---------|---------|
| 股票 | {stock_ratio} |
| 债券 | {bond_ratio} |
| 现金 | {cash_ratio} |
| 其他 | {other_ratio} |

#### 重仓明细
<!-- 股票型/混合型：展示十大重仓股 -->
| 序号 | 名称 | 代码 | 持仓占比 | 行业 |
|------|------|------|---------|------|
{top_holdings}

<!-- 债券型：展示十大重仓债 -->
| 序号 | 债券名称 | 代码 | 持仓占比 | 债券类型 |
|------|---------|------|---------|---------|
{top_bond_holdings}

#### 行业分布（股票型/混合型）
| 行业 | 配置比例 |
|------|---------|
{industry_allocation}

#### 券种配置（债券型）
| 券种 | 配置比例 |
|------|---------|
{bond_type_allocation}

#### 信用评级分布（债券型）
| 评级 | 占比 |
|------|------|
{credit_rating_distribution}

### 收益归因分析

<!-- 股票型/偏股混合：展示 Brinson 归因（调用 getFundBrinsonIndicator） -->
#### Brinson 收益归因（股票型/混合型）
| 归因类型 | 贡献率 | 说明 |
|---------|--------|------|
| 配置收益（AR） | {brinson_ar} | 行业配置偏离基准带来的收益贡献 |
| 选股收益（SR） | {brinson_sr} | 行业内个股选择的超额收益 |
| 总超额收益（ER） | {brinson_er} | 相对基准的超额总收益 |

> 数据来源：`getFundBrinsonIndicator`，默认展示近 1 年。AR > 0 表示行业配置优于基准，SR > 0 表示选股能力强。

<!-- 债券型：展示 Campisi 归因（调用 getFundCampisiIndicator） -->
#### Campisi 收益归因（债券型）
| 归因类型 | 贡献率 | 说明 |
|---------|--------|------|
| 收入效应 | {campisi_income} | 票息带来的收益贡献 |
| 国债效应 | {campisi_treasury} | 利率变动对收益的影响 |
| 利差效应 | {campisi_spread} | 信用利差变动的贡献 |
| 券种选择效应 | {campisi_selection} | 具体券种选择的超额收益 |
| 超额回报 | {campisi_excess} | 相对基准的超额总收益 |

> 数据来源：`getFundCampisiIndicator`，默认展示近 1 年。收入效应反映底仓票息收益，利差效应反映信用策略贡献。

<!-- 仅展示与基金类型匹配的归因分析，不匹配的归因小节整块删除 -->

### 基金经理
- 姓名：{manager_name}
- 从业年限：{manager_experience}
- 任职回报：{manager_return}
- 管理规模：{manager_total_size}
- 投资风格：{investment_style}

### 交易规则
- 买入：最低申购 {min_buy}，{buy_confirm_time} 确认
- 卖出：{redeem_time} 到账，费率 {redeem_fee}
- 持有期限制：{holding_limit}
- 分红方式：{dividend_mode}

### 综合评价

**收益能力**：{return_assessment}
**风险控制**：{risk_assessment}
**稳定性**：{stability_assessment}
**费用效率**：{fee_assessment}

### 投资建议
- 适合投资者：{target_investors}
- 建议持有期：{suggested_holding_period}
- 核心优势：{core_advantages}
- 主要风险：{key_risks}

**注：以上分析仅供参考，不构成投资建议。投资有风险，入市需谨慎。**
```

---

## 模板二：单只基金简要分析

用于用户只问了某个维度，或需要快速概览时。

```markdown
## {fund_name}（{fund_code}）简要分析

| 项目 | 数据 |
|------|------|
| 基金类型 | {fund_type} |
| 风险等级 | {risk_level} |
| 最新净值 | {net_value}（{nav_date}） |
| 近 1 年收益 | {year_1}（同类排名 {year_1_rank}） |
| 近 1 年最大回撤 | {max_drawdown_1y} |
| 夏普比率 | {sharpe_1y} |
| 基金规模 | {fund_size} |
| 基金经理 | {fund_manager} |

### 快速结论
{quick_summary}

### 投资建议
{investment_advice}

**注：以上分析仅供参考，不构成投资建议。投资有风险，入市需谨慎。**
```

---

## 模板三：多基金对比分析

```markdown
## 多基金对比分析

### 基本信息对比
| 对比项 | {fund_name_1} | {fund_name_2} | {fund_name_3} |
|-------|--------------|--------------|--------------|
| 基金代码 | {code_1} | {code_2} | {code_3} |
| 基金类型 | {type_1} | {type_2} | {type_3} |
| 风险等级 | {risk_1} | {risk_2} | {risk_3} |
| 成立日期 | {date_1} | {date_2} | {date_3} |
| 基金规模 | {size_1} | {size_2} | {size_3} |
| 基金经理 | {mgr_1} | {mgr_2} | {mgr_3} |

### 业绩对比
| 区间 | {fund_name_1} | {fund_name_2} | {fund_name_3} |
|------|--------------|--------------|--------------|
| 近 1 月 | {m1_1} | {m1_2} | {m1_3} |
| 近 3 月 | {m3_1} | {m3_2} | {m3_3} |
| 近 6 月 | {m6_1} | {m6_2} | {m6_3} |
| 近 1 年 | {y1_1} | {y1_2} | {y1_3} |
| 今年来 | {ytd_1} | {ytd_2} | {ytd_3} |

### 风险对比
| 指标 | {fund_name_1} | {fund_name_2} | {fund_name_3} |
|------|--------------|--------------|--------------|
| 波动率 | {vol_1} | {vol_2} | {vol_3} |
| 最大回撤 | {dd_1} | {dd_2} | {dd_3} |
| 夏普比率 | {sharpe_1} | {sharpe_2} | {sharpe_3} |

### 资产配置对比
| 类型 | {fund_name_1} | {fund_name_2} | {fund_name_3} |
|------|--------------|--------------|--------------|
| 股票 | {stock_1} | {stock_2} | {stock_3} |
| 债券 | {bond_1} | {bond_2} | {bond_3} |
| 现金 | {cash_1} | {cash_2} | {cash_3} |

### 相关性分析
{correlation_analysis}

### 对比总结
{comparison_summary}

### 投资建议
{investment_advice}

**注：以上分析仅供参考，不构成投资建议。投资有风险，入市需谨慎。**
```

---

## 模板四：基金经理深度分析

```markdown
## 基金经理分析：{manager_name}

### 基本信息
- 从业年限：{experience}
- 管理基金总规模：{total_size}
- 管理基金数量：{fund_count}
- 现任公司：{company}

### 管理基金列表
| 基金代码 | 基金名称 | 任职日期 | 任职回报 | 同类排名 |
|---------|---------|---------|---------|---------|
{managed_funds}

### 投资风格
- 市值偏好：{market_cap_pref}
- 成长/价值偏好：{growth_value_pref}
- 行业集中度：{industry_concentration}
- 换手率水平：{turnover_level}

### 行业配置偏好
| 行业 | 平均配置 |
|------|---------|
{industry_preference}

### 风险控制能力
| 指标 | 数值 | 同类排名 |
|------|------|---------|
| 平均波动率 | {avg_vol} | {vol_rank} |
| 平均最大回撤 | {avg_dd} | {dd_rank} |
| 平均夏普比率 | {avg_sharpe} | {sharpe_rank} |

### 综合评价
{manager_assessment}

**注：以上分析仅供参考，不构成投资建议。投资有风险，入市需谨慎。**
```

---

## 模板五：风险评估专项报告

用于用户专门询问"这只基金风险怎么样"时。

```markdown
## {fund_name}（{fund_code}）风险评估报告

### 风险等级：{risk_level}

### 波动性分析
| 区间 | 波动率 | 同类平均 | 评价 |
|------|--------|---------|------|
| 近 3 月 | {vol_3m} | {vol_3m_avg} | {vol_3m_rating} |
| 近 6 月 | {vol_6m} | {vol_6m_avg} | {vol_6m_rating} |
| 近 1 年 | {vol_1y} | {vol_1y_avg} | {vol_1y_rating} |

### 回撤分析
| 区间 | 最大回撤 | 同类平均 | 评价 |
|------|---------|---------|------|
| 近 1 年 | {dd_1y} | {dd_1y_avg} | {dd_1y_rating} |
| 近 3 年 | {dd_3y} | {dd_3y_avg} | {dd_3y_rating} |
| 成立以来 | {dd_total} | {dd_total_avg} | {dd_total_rating} |

### 回撤修复能力
{recovery_ability}

### 风险调整后收益
| 指标 | 数值 | 同类排名 | 解读 |
|------|------|---------|------|
| 夏普比率 | {sharpe} | {sharpe_rank} | {sharpe_interpret} |
| Sortino 比率 | {sortino} | {sortino_rank} | {sortino_interpret} |

### 风险归因
{risk_attribution}

### 风险结论
- 整体风险水平：{overall_risk_level}
- 适合的风险承受能力：{suitable_risk_tolerance}
- 主要风险因素：{main_risk_factors}

**注：以上分析仅供参考，不构成投资建议。投资有风险，入市需谨慎。**
```

---

## 模板选择规则

| 用户意图 | 使用模板 | 输出格式 |
|---------|---------|---------|
| "帮我分析基金 XXX"（无特定维度） | 模板一：完整分析 | **HTML**（单基金仪表盘） |
| "XXX 基金怎么样"（快速了解） | 模板二：简要分析 | Markdown |
| "帮我对比 A 和 B"（多基金） | 模板三：对比分析 | **HTML**（多基金对比仪表盘） |
| "推荐/筛选 XX 类基金"（筛选推荐） | 模板三：对比分析 | **HTML**（多基金对比仪表盘） |
| "XX 基金经理怎么样" | 模板四：经理分析 | HTML（默认）/ Markdown（用户要求时） |
| "这只基金风险大吗" | 模板五：风险评估 | HTML（默认）/ Markdown（用户要求时） |
| 用户指定了特定维度（如"看看持仓"） | 从模板一中摘取对应章节 | Markdown |
| 用户明确要求"可视化""HTML""报告" | 对应模板 | HTML |

> **HTML 输出**：单基金与多基金对比均按统一视觉模板 `demo-report.html`（`../../yingmi-skill/references/demo-report.html`）生成完整自包含 HTML，支持浅色/深色切换、ECharts 交互图表。详见 SKILL.md「输出规范」。
