# Plotly Guide

## Default Color Palette

Use the default chart color palette for consistent styling:

```python
# Default chart color palette
chart_colors = [
    '#69B1F4',  # chart01 - Light Blue
    '#F88D72',  # chart02 - Coral
    '#FBCA74',  # chart03 - Yellow
    '#7DD4C4',  # chart04 - Turquoise
    '#68E0F3',  # chart05 - Cyan
    '#ADAFE8',  # chart06 - Lavender
    '#3A7BB8',  # chart07 - Blue
    '#FAB6A5',  # chart08 - Peach
    '#EDC273',  # chart09 - Gold
    '#9CCBF8',  # chart10 - Sky Blue
    '#C8CAEF',  # chart11 - Light Purple
    '#6B9CCA'   # chart12 - Steel Blue
]
```

## Express API (Simpler)

### Bar Chart

```python
import plotly.express as px

# Default chart color palette
chart_colors = ['#69B1F4', '#F88D72', '#FBCA74', '#7DD4C4', '#68E0F3', 
                '#ADAFE8', '#3A7BB8', '#FAB6A5', '#EDC273', '#9CCBF8', 
                '#C8CAEF', '#6B9CCA']

fig = px.bar(df, x='category', y='value', 
              title='Bar Chart',
              color='category',
              color_discrete_sequence=chart_colors,
              text='value')
fig.update_traces(texttemplate='%{text:.2f}', textposition='outside')
fig.write_html('bar_chart.html')
```

### Line Chart

```python
fig = px.line(df, x='date', y='value', 
              color='series',
              title='Line Chart',
              markers=True)
fig.write_html('line_chart.html')
```

### Scatter Plot

```python
fig = px.scatter(df, x='x', y='y', 
                 size='size', color='category',
                 hover_data=['name'],
                 title='Scatter Plot')
fig.write_html('scatter.html')
```

### Pie Chart

```python
fig = px.pie(df, values='value', names='category',
             title='Pie Chart',
             hole=0.4)  # Donut chart
fig.write_html('pie_chart.html')
```

## Graph Objects API (More Control)

### Custom Bar Chart

```python
import plotly.graph_objects as go

# Default chart color palette
chart_colors = ['#69B1F4', '#F88D72', '#FBCA74', '#7DD4C4', '#68E0F3', 
                '#ADAFE8', '#3A7BB8', '#FAB6A5', '#EDC273', '#9CCBF8', 
                '#C8CAEF', '#6B9CCA']

fig = go.Figure(data=[
    go.Bar(x=x, y=y, 
           marker_color=chart_colors[0],  # Use first color from palette
           text=y,
           textposition='outside')
])

fig.update_layout(
    title='Custom Bar Chart',
    xaxis_title='X Label',
    yaxis_title='Y Label',
    template='plotly_white',
    height=600
)

fig.write_html('custom_bar.html')
```

### Multi-series Line Chart

```python
fig = go.Figure()

for series in series_list:
    fig.add_trace(go.Scatter(
        x=x,
        y=series['data'],
        mode='lines+markers',
        name=series['name'],
        line=dict(width=2)
    ))

fig.update_layout(
    title='Multi-series Chart',
    xaxis_title='X Label',
    yaxis_title='Y Label',
    hovermode='x unified'
)

fig.write_html('multi_series.html')
```

## Interactive Features

### Hover Template

```python
fig.update_traces(
    hovertemplate='<b>%{x}</b><br>Value: %{y:.2f}<extra></extra>'
)
```

### Buttons and Dropdowns

```python
fig.update_layout(
    updatemenus=[
        dict(
            type="buttons",
            direction="right",
            x=0.1, y=1.02,
            buttons=list([
                dict(label="All",
                     method="update",
                     args=[{"visible": [True, True, True]}]),
                dict(label="Series 1",
                     method="update",
                     args=[{"visible": [True, False, False]}])
            ])
        )
    ]
)
```

## Export Options

```python
# HTML (interactive)
fig.write_html('chart.html')

# Static PNG
fig.write_image('chart.png', width=1200, height=600, scale=2)

# Static PDF
fig.write_image('chart.pdf', width=1200, height=600)
```

## Templates

```python
# Available templates
fig.update_layout(template='plotly')  # default
fig.update_layout(template='plotly_white')
fig.update_layout(template='plotly_dark')
fig.update_layout(template='ggplot2')
fig.update_layout(template='seaborn')
```
