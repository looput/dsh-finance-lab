# Dashboard Design Patterns

## Multi-Chart Layout

### HTML/CSS Grid

```html
<div class="dashboard">
    <div class="chart-container">
        <canvas id="chart1"></canvas>
    </div>
    <div class="chart-container">
        <canvas id="chart2"></canvas>
    </div>
    <div class="chart-container">
        <canvas id="chart3"></canvas>
    </div>
</div>

<style>
.dashboard {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 20px;
    padding: 20px;
}
.chart-container {
    background: white;
    padding: 15px;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}
</style>
```

### Plotly Subplots

```python
from plotly.subplots import make_subplots

fig = make_subplots(
    rows=2, cols=2,
    subplot_titles=('Chart 1', 'Chart 2', 'Chart 3', 'Chart 4'),
    specs=[[{"type": "bar"}, {"type": "scatter"}],
           [{"type": "pie"}, {"type": "bar"}]]
)

fig.add_trace(go.Bar(...), row=1, col=1)
fig.add_trace(go.Scatter(...), row=1, col=2)
fig.add_trace(go.Pie(...), row=2, col=1)
fig.add_trace(go.Bar(...), row=2, col=2)

fig.update_layout(height=800, title_text="Dashboard")
fig.write_html('dashboard.html')
```

## Dashboard Components

### Key Metrics (KPI Cards)

```html
<div class="kpi-card">
    <div class="kpi-label">Total Sales</div>
    <div class="kpi-value">$1,234,567</div>
    <div class="kpi-change">+12.5%</div>
</div>
```

### Filters and Controls

```html
<div class="dashboard-controls">
    <select id="timeRange">
        <option>Last 7 days</option>
        <option>Last 30 days</option>
        <option>Last year</option>
    </select>
    <button onclick="updateCharts()">Update</button>
</div>
```

## Responsive Design

```css
@media (max-width: 768px) {
    .dashboard {
        grid-template-columns: 1fr;
    }
}
```
