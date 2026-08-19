# 选基输出模板

本文件包含 3 种输出模板，AI 根据筛选场景和结果数量选择对应模板。所有 `{placeholder}` 由 MCP 工具返回数据填入。

---

## 模板一：基金推荐报告（HTML）

推荐基金 ≥ 3 只时使用，输出完整自包含 HTML 推荐仪表盘。

### 固定骨架

> **⚠️ CSS/JS 来源**：必须以 [demo-report.html](../../yingmi-skill/references/demo-report.html) 为基准，提取其 CSS 完整放入 `<style>`，JS 完整放入 `<script>`。以下仅为板块骨架。

```html
<!-- ⚠️ <head> 必须包含 demo-report.html 的完整 CSS -->
<div class="container">
  <div class="topbar"><button class="theme-btn" onclick="toggleTheme()"><span id="themeIcon">🌙</span><span id="themeText">深色模式</span></button></div>

  <div class="hero-card">
    <div class="hero-title">{screening_title}</div>
    <div class="hero-sub">筛选条件：{screening_conditions} | 数据截至 {data_date}</div>
    <div class="tag-row"><span class="badge badge-rank">{fund_category}</span></div>
  </div>

  <div class="card ai-card">
    <div class="ai-title">💡 AI 推荐摘要</div>
    <div class="ai-conclusion">{ai_conclusion}</div>
    <ul class="ai-list">{ai_highlights}</ul>
    <div class="ai-risk">⚠️ {risk_note}</div>
  </div>

  <div class="card"><div class="section-title">推荐基金一览</div><!-- fund-card × N --></div>
  <div class="card"><div class="section-title">业绩对比</div><!-- table --></div>
  <div class="card"><div class="section-title">风险对比</div><!-- table --></div>
  <div class="card"><div class="section-title">推荐理由明细</div><!-- 详情 --></div>
  <!-- 可选: charts-grid ECharts -->

  <div class="disclaimer"><p><strong>免责声明：</strong>以上筛选结果基于历史数据，仅供参考，不构成投资建议。数据来源：盈米且慢。</p></div>
  <div class="footer">Powered by 盈米MCP · {data_date}</div>
</div>
```

### 基金卡片区规则

- 每只基金一张卡片，网格排列（桌面端 3 列，移动端 1 列）
- 卡片必须包含：基金名称、代码、近 1 年收益（涨红跌绿）、类型、规模、风险等级、夏普比率、经理、简短推荐理由
- 收益为正值使用 `class="val-up"`，负值使用 `class="val-down"`

### ECharts 图表（可选增强）

推荐基金 ≥ 5 只时可添加以下图表：
- **收益对比柱状图**：X 轴为基金名称，Y 轴为近 1 年收益率
- **风险雷达图**：选 2~3 只代表性基金做多维对比（收益/回撤/波动/夏普/规模）
- 图表在浅色/深色切换时需 `dispose` + 重绘

---

## 模板二：债基排雷报告（Markdown）

```markdown
## 债基排雷报告

> 数据截至 {data_date} | 来源：盈米且慢

### 告警概览
- 告警类型：{alert_type_desc}（{alert_type}）
- 告警阈值：{threshold_desc}
- 命中基金数量：{alert_count} 只

### 告警基金列表

| 序号 | 基金名称 | 代码 | 基金类型 | 规模 | 告警类型 | 跌幅 | 风险解读 |
|------|---------|------|---------|------|---------|------|---------|
{alert_rows}
<!-- 每行: | 1 | XX纯债A | 000001 | 纯债 | 3.2亿 | 日跳水 | -0.52% | 出现显著净值回撤，可能存在持仓信用风险 | -->

### 风险提示

{risk_analysis}
<!-- 基于 screening-playbook.md 第四章 4.3 风险解读规则，逐一解读 -->

### 建议操作

{action_suggestions}
<!-- 如: 
- 重点关注规模小于2亿且多次触发告警的基金
- 建议持有人排查重仓债券信用状况
- 如持有以上基金，建议评估是否减仓
-->

**免责声明：以上分析/筛选结果基于历史数据和公开信息，仅供参考，不构成投资建议。基金过往业绩不预示未来表现，投资有风险，入市需谨慎。数据来源：盈米且慢。**
```

### 排雷报告规则

- 每只基金必须标注告警类型（日跳水 / 周跳水 / 异动）
- 跌幅数据精确到小数点后两位
- 风险解读遵循 [screening-playbook.md](screening-playbook.md) 第四章 4.3 规则
- 规模 < 2 亿的基金额外标注流动性风险
- 同一基金多次告警时合并展示并重点提示

---

## 模板三：热门基金速览（Markdown）

```markdown
## 热门基金速览

> 数据截至 {data_date} | 来源：盈米且慢

### 近期热门基金 TOP {count}

| 序号 | 基金名称 | 代码 | 类型 | 近1年收益 | 近1年排名 | 规模 | 风险等级 | 推荐理由 |
|------|---------|------|------|---------|---------|------|---------|---------|
{hot_fund_rows}
<!-- 每行: | 1 | XX蓝筹精选 | 005827 | 偏股混合 | +15.2% | 前12% | 120亿 | R4 | 近1年收益同类前12%，风控优秀 | -->

### AI 点评

{ai_commentary}
<!-- 如:
- 近期热门基金以偏股型为主，反映市场风险偏好回升
- XX基金连续3个月进入热门榜，近1年收益同类前10%
- 建议投资者关注自身风险承受能力，不盲目追热
-->

### 风险提示

热门基金反映近期市场关注度，不代表未来收益预期。过往业绩不预示未来表现。

**免责声明：以上分析/筛选结果基于历史数据和公开信息，仅供参考，不构成投资建议。基金过往业绩不预示未来表现，投资有风险，入市需谨慎。数据来源：盈米且慢。**
```

### 热门速览规则

- 按 `GetPopularFund` 返回的访问量排序
- 增强显示近 1 年收益和同类排名（来自 `GetBatchFundPerformance`）
- 每只基金一条简短推荐理由
- AI 点评需总结热门趋势，不做个基推荐

---

## 模板选择规则

使用以下唯一优先级（由高到低）：

| 优先级 | 条件 | 使用模板 | 输出格式 |
|-------|------|---------|---------|
| P1 | 用户明确要求 `HTML / 可视化 / 报告` | 模板一 | **HTML** |
| P2 | 用户明确要求 `简洁 / 文字版 / 纯文本` | 模板二/三 或纯文本 | Markdown |
| P3 | 债基排雷 | 模板二：债基排雷报告 | **HTML（默认）** |
| P4 | 关联策略查找 | 模板三（改标题）或简版 HTML 列表 | **HTML（默认）** |
| P5 | 条件筛选推荐且推荐基金数量 `>= 3` | 模板一：基金推荐报告 | **HTML** |
| P6 | 条件筛选推荐且推荐基金数量 `< 3` | 模板三（改标题） | **HTML（默认）** |
| P7 | 热门推荐（默认） | 模板三：热门基金速览 | **HTML（默认）** |

### 格式仲裁规则

- 若用户同时提出“要可视化”和“要简洁文字版”，按优先级执行：**可视化优先（P1）**
- 除用户明确要求文字版外，所有场景默认 HTML 输出

### 免责声明（所有模板通用）

以下免责声明必须出现在每份输出的末尾：

> 免责声明：以上分析/筛选结果基于历史数据和公开信息，仅供参考，不构成投资建议。基金过往业绩不预示未来表现，投资有风险，入市需谨慎。数据来源：盈米且慢。
