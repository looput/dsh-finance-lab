# 写入路径矩阵（T2 确认覆盖审计）

更新：2026-10-01。目标：所有持仓变更与已有观点变更经统一预览 diff → 确认队列；未确认不落盘。「直接写入」指绕过确认队列的入口，均在此显式登记。

## 持仓（holdings）

| 入口 | 路径 | 确认 | 状态 |
|---|---|---|---|
| Agent 工具 `upsert_holding` | `PortfolioStore.previewHolding` → 确认后写 | ✅ 预览 diff | 已覆盖 |
| Agent 工具 `import_holdings` | `PortfolioStore.previewHoldings`（整表替换） | ✅ 预览 diff | 已覆盖 |
| Agent 工具 `remove_holding` | `PortfolioStore.previewRemoveHolding` | ✅ 预览 diff | 批次一补齐（此前直接删除） |
| 面板 `/mutate upsertHolding` | 同 `previewHolding` | ✅ | 已覆盖 |
| 面板 `/mutate removeHolding` | 同 `previewRemoveHolding` | ✅ | 批次一补齐 |
| 确认队列 `/personal` 确认按钮 | `Confirmations.confirm`（单次、15 分钟、基线校验） | — 提交点 | 已覆盖 |
| `PortfolioStore.setHoldings/upsertHolding/removeHolding` | 原子写盘 | ❌ 原语 | 仅供确认事务与受控系统写入；测试/脚本直接使用属受控 |
| `FinanceDataService.upsertHolding/removeHolding` | 经 `setHoldings` 回调 | ❌ 原语 | 内部 API，当前仅 smoke 脚本使用；勿接到新入口 |

## 观点（research opinion）与观点修订（thesis）

| 入口 | 路径 | 确认 | 状态 |
|---|---|---|---|
| Agent 工具 `update_research`（改 opinion） | `ResearchVault.update` 抛 `ResearchConfirmationRequired` | ✅ 预览 diff | 已覆盖 |
| 个人首页修正观点（T1 thesis） | `PersonalStore.saveThesis` 走确认队列 | ✅ | 已覆盖 |
| 外部 Markdown 文件直接编辑 opinion | `ResearchVault.syncFromDisk` 自动采纳 | ❌ | **已知缺口**：字面「未确认不落盘」对拥有文件写权限的 Agent 不可能仅靠应用保证；待 P1 第 7 步做候选隔离或权限/staging 边界 |
| 个人档案/证据卡/复盘决定 | `PersonalStore` 直写（自身版本历史） | ❌ | 按设计：本人档案内容非「持仓/已有观点」变更，保留历史可追溯 |

## 其余直接写入（非 T2 清单，显式登记）

| 入口 | 说明 |
|---|---|
| watchlist 增删（工具/面板） | 自选清单，非持仓；直接写入 |
| 历史库 `sync_history` / `add_market_event` | 追加式数据采集；批次二起串行原子写、坏数据拒收 |
| 资料库 create/addNote/archive/collect | 新增/追加行为（不覆盖已有观点），保留直接落库 |
| 分析报告 `save_position_analysis` | 保存最新报告缓存（报告版本化在 T5），不改持仓/观点 |
| provider 策略/skills/MCP 配置 | 配置面，非投资数据 |

## 提交点保证（已测）

- 确认前持仓文件字节不变；确认单次消费；基线变化（含外部修改）拒绝并要求重新预览。
- 并发确认串行 compare-and-apply，只有一个成功。
- 写盘失败不推进内存；临时文件原子替换；外部改文件后拒绝覆盖。
