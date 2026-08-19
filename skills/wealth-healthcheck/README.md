# Wealth Health Check（财务健康体检）

输出 9 项财务健康指标（数值、区间、评级、可执行建议）及总览；默认 HTML，指标由本地 `scripts/` 计算，MCP 用于把口述数据变为入参或与官方口径对齐。

## 能做什么

- **9 项指标仪表盘**：与 `indicators.py`、`rating.py` 口径一致
- **风险与短板**：结构化解读与优先改进动作
- **财务总览**：与 MCP/入参一致的资产负债与收支叙事

## 快速启动

```
这是我的资产和月收支 JSON，请用 wealth-healthcheck 生成 HTML 体检报告（含 9 项指标与改进建议）。
```

## 文件结构

```text
wealth-healthcheck/
├── README.md                           # 本文件
├── SKILL.md                            # 技能主文件（交互流程 + 输出规范 + 质量标准）
├── references/
│   ├── data_schema.md                  # 输入 JSON 约定
│   ├── indicator_formulas.md           # 指标公式
│   ├── summary_rules.md                # 汇总规则
│   └── rating_thresholds.json          # 评级阈值
└── scripts/
    ├── run.py                          # 主入口
    ├── indicators.py                   # 指标计算
    ├── rating.py                       # 评级
    └── summary.py                      # 汇总
```

## 独立运行

- 本目录业务素材自包含；`scripts/run.py` 接受结构化 JSON 产出 HTML。
- HTML 视觉壳由同仓库 `../yingmi-skill/references/demo-report.html` 与 `../yingmi-skill/references/HTML视觉模板.md` 约定，生成 HTML 前须按 `SKILL.md` 要求读取。

## 依赖

- **盈米MCP 插件**：`GetCurrentTime`、`AnalyzeAssetLiability`、`AnalyzeIncomeExpense`、`AnalyzeFinancialIndicators`（P0），按需 `AnalyzeFamilyMembers`（P1）。
