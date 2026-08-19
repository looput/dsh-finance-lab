# Wealth Goal Calculator（财富目标测算）

基于复利公式与本地脚本的财富目标测算技能，回答「目标能否达成」「差多少」「增月投/延长期限能否补上」等可量化问题；默认输出自包含 HTML，可与 MCP 拉齐收支与资产负债口径。

## 能做什么

- **目标终值与达成率**：按用户给定或默认假设测算 FV、达成率、缺口
- **替代方案**：增月投、延长期限等情景对比
- **多目标汇总**：在单份报告中汇总多个理财目标

## 快速启动

```
请根据我的 goals 和收支，用 wealth-goalcalc 生成 HTML：展示各目标终值与达成率，并给增月投/延期的替代方案。
```

## 文件结构

```text
wealth-goalcalc/
├── README.md                    # 本文件
├── SKILL.md                     # 技能主文件（交互流程 + 计算规则 + 输出规范 + 质量标准）
└── scripts/
    ├── run.py                   # CLI 入口，默认输出 HTML
    └── compound_interest.py     # 复利与终值计算
```

## 独立运行

- 本目录业务素材自包含；`scripts/run.py` 可通过 stdin 传入 JSON 驱动测算与 HTML 生成。
- HTML 视觉壳由同仓库 `../yingmi-skill/references/demo-report.html` 与 `../yingmi-skill/references/HTML视觉模板.md` 约定，生成 HTML 前须按 `SKILL.md` 要求读取。

## 依赖

- **盈米MCP 插件**（可选）：`GetCurrentTime`、`AnalyzeIncomeExpense`、`AnalyzeAssetLiability`、`AnalyzeFinancialIndicators` 等，用于对齐数据与叙事口径。
