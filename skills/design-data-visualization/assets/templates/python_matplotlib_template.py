#!/usr/bin/env python3
"""
Matplotlib 图表模板

这是一个基础的 matplotlib 图表模板，可以根据需要修改。
"""

import matplotlib.pyplot as plt
import seaborn as sns
import numpy as np

# 设置样式
sns.set_style("whitegrid")
plt.rcParams['font.sans-serif'] = ['Arial', 'SimHei', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

# 默认图表配色方案
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

# 创建图表
fig, ax = plt.subplots(figsize=(10, 6))

# 示例数据
x = ['类别1', '类别2', '类别3', '类别4', '类别5']
y = [12, 19, 3, 5, 2]

# 创建柱状图（使用默认配色方案）
ax.bar(x, y, color=chart_colors[:len(x)], edgecolor='black', alpha=0.8)

# 设置标签和标题
ax.set_xlabel('X轴标签', fontsize=12)
ax.set_ylabel('Y轴标签', fontsize=12)
ax.set_title('图表标题', fontsize=14, fontweight='bold')

# 添加网格
ax.grid(axis='y', alpha=0.3)

# 调整布局
plt.tight_layout()

# 保存图表
plt.savefig('chart.png', dpi=300, bbox_inches='tight')
print("图表已保存为 chart.png")

# 显示图表（如果在交互环境中）
# plt.show()
