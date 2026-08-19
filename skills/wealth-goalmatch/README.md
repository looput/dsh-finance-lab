# Wealth Goal Match（财富目标匹配）

在已有财务数据基础上对财富目标排序与补充（必要型/期望型），输出可执行的参数建议；默认交付 HTML，推荐规则见 `references/recommendation_rules.md`。

## 能做什么

- **评估现有目标**：合理性、优先级与缺口叙事
- **推荐新目标**：通常 2～4 个，含金额/期限/月投建议
- **月投可行性**：与收支结余口径对齐的可行性说明

## 快速启动

```
根据我的资产、收支和家庭成员，用 wealth-goalmatch 输出 HTML：评估现有目标并推荐 2～4 个新目标及建议月投。
```

## 文件结构

```text
wealth-goalmatch/
├── README.md                           # 本文件
├── SKILL.md                            # 技能主文件（交互流程 + 输出规范 + 质量标准）
├── references/
│   └── recommendation_rules.md         # 推荐规则与扩展说明
└── scripts/
    └── run.py                          # 推荐计算与 HTML 渲染入口
```

## 独立运行

- 本目录业务素材自包含；`scripts/run.py` 为计算与 HTML 渲染入口。
- HTML 视觉壳由同仓库 `../yingmi-skill/references/demo-report.html` 与 `../yingmi-skill/references/HTML视觉模板.md` 约定，生成 HTML 前须按 `SKILL.md` 要求读取。

## 依赖

- **盈米MCP 插件**：`GetCurrentTime`、`AnalyzeAssetLiability`、`AnalyzeIncomeExpense`、`AnalyzeFinancialIndicators` 等（P0），按需调用 `AnalyzeFamilyMembers`、`AnalyzeCashFlow`（P1）。
