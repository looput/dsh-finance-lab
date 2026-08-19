# Matplotlib/Seaborn Guide

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

## Common Chart Patterns

### Bar Chart

```python
import matplotlib.pyplot as plt
import seaborn as sns

# Default chart color palette
chart_colors = ['#69B1F4', '#F88D72', '#FBCA74', '#7DD4C4', '#68E0F3', 
                '#ADAFE8', '#3A7BB8', '#FAB6A5', '#EDC273', '#9CCBF8', 
                '#C8CAEF', '#6B9CCA']

sns.set_style("whitegrid")
fig, ax = plt.subplots(figsize=(10, 6))

ax.bar(x, y, color=chart_colors[:len(x)], edgecolor='black', alpha=0.8)
ax.set_xlabel('X Label', fontsize=12)
ax.set_ylabel('Y Label', fontsize=12)
ax.set_title('Chart Title', fontsize=14, fontweight='bold')
ax.grid(axis='y', alpha=0.3)

plt.tight_layout()
plt.savefig('bar_chart.png', dpi=300, bbox_inches='tight')
```

### Line Chart

```python
fig, ax = plt.subplots(figsize=(10, 6))
ax.plot(x, y, marker='o', linewidth=2, markersize=8)
ax.set_xlabel('X Label')
ax.set_ylabel('Y Label')
ax.set_title('Line Chart')
ax.grid(True, alpha=0.3)
plt.tight_layout()
plt.savefig('line_chart.png', dpi=300)
```

### Pie Chart

```python
fig, ax = plt.subplots(figsize=(8, 8))
# Use default chart colors
chart_colors = ['#69B1F4', '#F88D72', '#FBCA74', '#7DD4C4', '#68E0F3', 
                '#ADAFE8', '#3A7BB8', '#FAB6A5', '#EDC273', '#9CCBF8', 
                '#C8CAEF', '#6B9CCA']
ax.pie(values, labels=labels, autopct='%1.1f%%', 
       colors=chart_colors[:len(values)], startangle=90)
ax.set_title('Pie Chart')
plt.tight_layout()
plt.savefig('pie_chart.png', dpi=300)
```

### Scatter Plot

```python
fig, ax = plt.subplots(figsize=(10, 6))
ax.scatter(x, y, s=100, alpha=0.6, c=colors, edgecolors='black')
ax.set_xlabel('X Label')
ax.set_ylabel('Y Label')
ax.set_title('Scatter Plot')
plt.tight_layout()
plt.savefig('scatter.png', dpi=300)
```

### Heatmap

```python
fig, ax = plt.subplots(figsize=(10, 8))
sns.heatmap(data, annot=True, fmt='.2f', cmap='coolwarm', center=0)
ax.set_title('Heatmap')
plt.tight_layout()
plt.savefig('heatmap.png', dpi=300)
```

## Styling

### Set Style
```python
sns.set_style("whitegrid")  # whitegrid, darkgrid, white, dark, ticks
sns.set_palette("husl")  # husl, Set2, Set3, pastel, etc.
```

### Custom Colors
```python
colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd']
```

### Figure Size
```python
fig, ax = plt.subplots(figsize=(width, height))  # inches
```

## Export Options

```python
# PNG (high quality)
plt.savefig('chart.png', dpi=300, bbox_inches='tight')

# SVG (vector)
plt.savefig('chart.svg', format='svg', bbox_inches='tight')

# PDF (vector)
plt.savefig('chart.pdf', format='pdf', bbox_inches='tight')
```
