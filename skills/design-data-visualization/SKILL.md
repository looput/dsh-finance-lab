---
name: design-data-visualization
description: 全面的数据可视化工具包，用于创建图表、图形和交互式可视化。当用户请求创建数据可视化、图表、图形、仪表板或数据分析可视化时使用。支持多种图表类型（柱状图、折线图、饼图、散点图、热力图等）和输出格式（HTML、PNG、SVG、PDF）。支持多种库，包括 matplotlib、Plotly、D3.js 和 Chart.js。
---

# 数据可视化

## 概述

本技能支持创建专业的数据可视化，包括静态图表、交互式图形和仪表板组件。支持多种图表类型、输出格式和可视化库。

### （铁律）若输出「且慢统一报告页」HTML

当交付物为**完整自包含 HTML 报告页**且须与 `yingmi-skill-cli` 场景技能口径一致（用户明确要求且慢报告壳、或与某场景 skill 联动的成稿）时，必须遵守 [`HTML视觉模板.md` 开篇「HTML 交付铁律（强制，写死）」](../yingmi-skill/references/HTML视觉模板.md)：**先完整阅读指派任务对应的场景 `SKILL.md` 全文及其 `references/*`，再完整阅读 `../yingmi-skill/references/demo-report.html` 全文**；**壳与 class 来自 `demo-report`，章节与数据叙事来自该场景 `SKILL.md`**。若交付物仅为**单文件图表 / 无报告壳的仪表板片段**，可不套 `demo-report` 全壳，但不得在场景任务中冒充统一 HTML 报告。

## 快速开始

### 图表类型选择

根据数据和目的选择合适的图表类型：

- **柱状图/条形图**：比较类别，显示排名
- **折线图**：显示时间趋势，连续数据
- **饼图/环形图**：显示比例，部分与整体关系
- **散点图**：显示相关性，变量之间的关系
- **热力图**：显示密度、相关性或矩阵数据
- **面积图**：显示随时间累积的值
- **箱线图**：显示分布、四分位数、异常值
- **直方图**：显示频率分布

### 输出格式选择

- **HTML**：交互式图表（Plotly、Chart.js、D3.js）- 最适合网页分享
- **PNG/JPG**：静态图片（matplotlib、seaborn）- 最适合文档、演示文稿
- **SVG**：可缩放矢量图形 - 最适合网页和打印
- **PDF**：矢量格式 - 最适合报告和文档

### 库选择

- **matplotlib/seaborn**：Python，静态图表，出版质量
- **Plotly**：Python/JavaScript，交互式图表，仪表板
- **Chart.js**：JavaScript，轻量级，适合网页
- **D3.js**：JavaScript，高度可定制，高级可视化

## 创建图表

### Python (matplotlib/seaborn)

用于创建静态、出版质量的图表：

```python
import matplotlib.pyplot as plt
import seaborn as sns

# 设置样式
sns.set_style("whitegrid")
plt.figure(figsize=(10, 6))

# 根据类型创建图表
# 柱状图示例
plt.bar(x, y)
plt.xlabel('X轴标签')
plt.ylabel('Y轴标签')
plt.title('图表标题')
plt.tight_layout()
plt.savefig('chart.png', dpi=300, bbox_inches='tight')
```

详细模式和示例请参见 `references/matplotlib_guide.md`。

### Python (Plotly)

用于创建交互式图表和仪表板：

```python
import plotly.graph_objects as go
import plotly.express as px

# Express API（更简单）
fig = px.bar(df, x='category', y='value', title='图表标题')
fig.write_html('chart.html')

# Graph Objects API（更多控制）
fig = go.Figure(data=[go.Bar(x=x, y=y)])
fig.update_layout(title='图表标题')
fig.write_html('chart.html')
```

交互式图表模式请参见 `references/plotly_guide.md`。

### JavaScript (Chart.js)

用于创建轻量级网页图表：

```html
<canvas id="myChart"></canvas>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
const ctx = document.getElementById('myChart');
new Chart(ctx, {
  type: 'bar',
  data: { labels: [...], datasets: [...] },
  options: { responsive: true }
});
</script>
```

Chart.js 模式请参见 `references/chartjs_guide.md`。

### JavaScript (D3.js)

用于创建高度可定制的可视化：

请参见 `references/d3_guide.md` 了解 D3.js 模式和示例。

## 图表模板

预构建的模板位于 `assets/templates/`：

- `bar_chart_template.html` - 交互式柱状图模板
- `line_chart_template.html` - 交互式折线图模板
- `dashboard_template.html` - 多图表仪表板模板
- `python_matplotlib_template.py` - Python matplotlib 入门模板

## 配色方案

**默认图表配色方案**：使用 `references/color_palettes.md` 中定义的 12 色配色方案作为所有可视化的首选。该配色方案包括从 chart01 (#69B1F4) 到 chart12 (#6B9CCA) 的颜色，为所有图表提供一致、专业的样式。

完整的配色方案及 Python、JavaScript 和 CSS 使用示例请参见 `references/color_palettes.md`。

## 最佳实践

1. **选择合适的图表类型** - 根据数据和要传达的信息选择
2. **使用一致的配色** - 优先使用 `references/color_palettes.md` 中的默认图表配色方案
3. **清晰标注** - 包含标题、轴标签、图例、数据标签
4. **考虑可访问性** - 需要时使用色盲友好配色方案，添加替代文本
5. **优化输出格式** - HTML 用于交互性，PNG 用于文档
6. **响应式设计** - 确保图表在不同屏幕尺寸下正常工作

## 高级功能

### 多图表仪表板

将多个图表组合成仪表板。仪表板设计模式请参见 `references/dashboards.md`。

### 数据处理

使用 `scripts/` 中的脚本进行常见的数据处理任务：

- `process_data.py` - 数据清理和准备工具
- `export_chart.py` - 图表导出工具

### 自定义样式

应用主题和样式。自定义选项请参见 `references/styling_guide.md`。

## 资源

### scripts/

- `process_data.py` - 数据处理工具
- `export_chart.py` - 图表导出辅助工具

### references/

- `matplotlib_guide.md` - matplotlib/seaborn 模式和示例
- `plotly_guide.md` - Plotly 交互式图表模式
- `chartjs_guide.md` - Chart.js 网页图表模式
- `d3_guide.md` - D3.js 高级可视化模式
- `color_palettes.md` - 配色方案推荐
- `dashboards.md` - 仪表板设计模式
- `styling_guide.md` - 图表样式和主题

### assets/

- `templates/` - 预构建的图表模板

