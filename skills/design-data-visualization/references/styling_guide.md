# Chart Styling Guide

## Typography

### Fonts

```python
# Matplotlib
plt.rcParams['font.family'] = 'sans-serif'
plt.rcParams['font.sans-serif'] = ['Arial', 'Helvetica', 'DejaVu Sans']

# Plotly
fig.update_layout(
    font=dict(family="Arial", size=12, color="black")
)
```

### Font Sizes

```python
# Matplotlib
plt.title('Title', fontsize=16, fontweight='bold')
plt.xlabel('X Label', fontsize=12)
plt.ylabel('Y Label', fontsize=12)

# Plotly
fig.update_layout(
    title_font_size=16,
    xaxis_title_font_size=12,
    yaxis_title_font_size=12
)
```

## Spacing and Layout

### Matplotlib

```python
plt.tight_layout()  # Auto-adjust spacing
plt.subplots_adjust(left=0.1, right=0.9, top=0.9, bottom=0.1)
```

### Plotly

```python
fig.update_layout(
    margin=dict(l=50, r=50, t=50, b=50),
    height=600,
    width=1000
)
```

## Grid and Axes

### Matplotlib

```python
ax.grid(True, alpha=0.3, linestyle='--')
ax.set_axisbelow(True)  # Grid behind data
```

### Plotly

```python
fig.update_layout(
    xaxis=dict(showgrid=True, gridcolor='lightgray'),
    yaxis=dict(showgrid=True, gridcolor='lightgray')
)
```

## Themes

### Seaborn Styles

```python
sns.set_style("whitegrid")  # whitegrid, darkgrid, white, dark, ticks
sns.set_context("paper")    # paper, notebook, talk, poster
```

### Plotly Templates

```python
fig.update_layout(template='plotly_white')
# Options: plotly, plotly_white, plotly_dark, ggplot2, seaborn, simple_white
```
