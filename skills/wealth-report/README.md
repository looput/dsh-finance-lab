# Wealth Report（财富规划报告）

单份交付串联诊断、资产负债、收支、指标、目标、现金流、资产配置与文字类建议等九大模块；默认 HTML，依赖 MCP 拉齐家庭财务与方案数据，由 `scripts/run.py` 整合渲染。

## 能做什么

- **九大模块成稿**：按 `SKILL.md` 固定顺序输出完整 HTML
- **配置与落地**：可衔接 `GetAssetAllocationPlan`、`GetCompositeModel`、基金卡片等
- **可选 PDF**：用户明确要求时可经 `RenderHtmlToPdf` 导出

## 快速启动

```
请基于我已提供的家庭与财务数据，生成 wealth-report 完整 HTML：九大模块齐全，含免责声明与页脚。
```

## 文件结构

```text
wealth-report/
├── README.md                           # 本文件
├── SKILL.md                            # 技能主文件（模块定义 + 工具矩阵 + 输出规范）
└── scripts/
    ├── run.py                          # 整合与 HTML 渲染入口（stdin）
    └── generate_report_html.py         # 本地批处理包装（可选）
```

## 独立运行

- 本目录业务素材自包含；主路径为 `scripts/run.py` 读取 stdin JSON。
- HTML 视觉壳由同仓库 `../yingmi-skill/references/demo-report.html` 与 `../yingmi-skill/references/HTML视觉模板.md` 约定，生成 HTML 前须按 `SKILL.md` 要求读取。

## 依赖

- **盈米MCP 插件**：`GetCurrentTime`、`AnalyzeFamilyMembers`、`AnalyzeIncomeExpense`、`AnalyzeAssetLiability`、`AnalyzeFinancialIndicators`、`AnalyzeCashFlow`、`GetAssetAllocationPlan` 等（按模块按需调用）；扩展工具见 `SKILL.md` P1 表。
