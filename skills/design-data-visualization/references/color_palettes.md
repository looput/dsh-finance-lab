# Color Palettes

## Default Chart Palette (Recommended)

This is the primary color palette for data visualizations. Use this palette as the default choice for all charts.

### Python (matplotlib/seaborn/plotly)

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

# Usage examples:
# Matplotlib
ax.bar(x, y, color=chart_colors)

# Seaborn
sns.set_palette(chart_colors)

# Plotly
fig = px.bar(df, x='x', y='y', color='category', 
             color_discrete_sequence=chart_colors)
```

### JavaScript (Chart.js/D3.js)

```javascript
// Default chart color palette
const chartColors = [
    '#69B1F4',  // chart01 - Light Blue
    '#F88D72',  // chart02 - Coral
    '#FBCA74',  // chart03 - Yellow
    '#7DD4C4',  // chart04 - Turquoise
    '#68E0F3',  // chart05 - Cyan
    '#ADAFE8',  // chart06 - Lavender
    '#3A7BB8',  // chart07 - Blue
    '#FAB6A5',  // chart08 - Peach
    '#EDC273',  // chart09 - Gold
    '#9CCBF8',  // chart10 - Sky Blue
    '#C8CAEF',  // chart11 - Light Purple
    '#6B9CCA'   // chart12 - Steel Blue
];

// Chart.js usage
backgroundColor: chartColors.map(c => c + '80'),  // Add transparency
borderColor: chartColors

// D3.js usage
const color = d3.scaleOrdinal()
    .domain(data.map(d => d.category))
    .range(chartColors);
```

### CSS/HTML

```css
/* Chart color variables */
:root {
    --chart-01: #69B1F4;  /* Light Blue */
    --chart-02: #F88D72;  /* Coral */
    --chart-03: #FBCA74;  /* Yellow */
    --chart-04: #7DD4C4;  /* Turquoise */
    --chart-05: #68E0F3;  /* Cyan */
    --chart-06: #ADAFE8;  /* Lavender */
    --chart-07: #3A7BB8;  /* Blue */
    --chart-08: #FAB6A5;  /* Peach */
    --chart-09: #EDC273;  /* Gold */
    --chart-10: #9CCBF8;  /* Sky Blue */
    --chart-11: #C8CAEF;  /* Light Purple */
    --chart-12: #6B9CCA;  /* Steel Blue */
}
```

## Colorblind-Friendly Palettes

### Okabe-Ito Palette

```python
colors = ['#E69F00', '#56B4E9', '#009E73', '#F0E442', 
          '#0072B2', '#D55E00', '#CC79A7', '#000000']
```

### ColorBrewer Sequential

```python
# Blues
colors = ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', 
          '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b']
```

### ColorBrewer Qualitative

```python
# Set3
colors = ['#8dd3c7', '#ffffb3', '#bebada', '#fb8072', 
          '#80b1d3', '#fdb462', '#b3de69', '#fccde5']
```

## Seaborn Palettes

```python
import seaborn as sns

# Built-in palettes
sns.color_palette("husl", 8)
sns.color_palette("Set2")
sns.color_palette("pastel")
sns.color_palette("dark")
sns.color_palette("muted")
```

## Matplotlib Colormaps

```python
# Sequential
plt.cm.viridis
plt.cm.plasma
plt.cm.inferno
plt.cm.magma

# Diverging
plt.cm.RdYlBu
plt.cm.RdBu
plt.cm.PiYG

# Qualitative
plt.cm.Set3
plt.cm.Pastel1
plt.cm.tab10
```

## Plotly Templates

```python
# Built-in color sequences
px.colors.qualitative.Set3
px.colors.sequential.Viridis
px.colors.diverging.RdYlBu
```

## Web-Safe Colors

```css
/* Common web colors */
#1f77b4  /* Blue */
#ff7f0e  /* Orange */
#2ca02c  /* Green */
#d62728  /* Red */
#9467bd  /* Purple */
#8c564b  /* Brown */
#e377c2  /* Pink */
#7f7f7f  /* Gray */
```
