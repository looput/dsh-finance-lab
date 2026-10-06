# 策略实验室（Strategy Lab）使用与验收说明

对应交付：T7-A 历史数据治理 → T7-B 确定性回测 → T7-C 稳健性切片 → T7-D 有限搜索/策略库/分币种采样。
所有核心计算**无网络、无当前时钟**，同输入逐字节可复现；以下口径与限制必须随结论一起披露。

---

## 1. 受限策略 DSL（`src/strategy/dsl.ts`）

策略是**数据**，不是代码：只允许价格序列信号 + 显式交易规则；**禁止 eval/exec**，未知字段直接拒绝。

```jsonc
{
  "dslVersion": 1,
  "name": "动量示例",
  "codes": ["600519"],            // 固定标的池，1–20 个
  "signal": { "kind": "momentum", "lookback": 20, "thresholdPct": 0 },
  "allocation": "equal_weight",   // 首版仅支持等权分仓
  "trading": {
    "lotSize": 100,               // 买入整手
    "feeRateBps": 10,             // 佣金（万分之一）
    "minFee": 0,
    "stampDutyBps": 5,            // 印花税（仅卖出）
    "slippageBps": 0,             // 滑点（买上浮/卖下浮）
    "limitPct": 9.5,              // 开盘涨跌停近似阈值（%），0=关闭
    "tPlus1": true                // 首版必须 true，false 拒绝
  },
  "risk": { "maxDrawdownStopPct": 20, "stopAfter": "2024-12-31" }  // 可选
}
```

信号（均为 t 日收盘后目标仓位 0/1，预热期不交易）：

| kind | 参数 | 进入持有条件 |
|---|---|---|
| `ma_cross` | `fast < slow`（均必填正整数） | MA_fast > MA_slow |
| `momentum` | `lookback`, `thresholdPct`（必填） | 收盘涨幅 > 阈值 |
| `volatility` | `lookback ≥ 2`（波动率需 ≥2 个收益率样本）, `maxVolPct` | 年化波动率 ≤ 阈值 |
| `zscore` | `lookback ≥ 2`, `entryZ ≥ exitZ`（必填） | z ≤ -entryZ 进、z ≥ -exitZ 出（状态机） |

信号参数**该 kind 的全部非 kind 字段一律必填**（缺 `slow` 这类字段会静默产出永不触发的坏策略，直接拒绝）；
计算层另有 NaN 防御：样本不足/非法窗口输出 `value=null`、`target=0`，绝不产出 NaN。

策略 hash = 规范 JSON（键排序）sha256 截 32 位；同策略必得同 hash。

## 2. 确定性回测引擎（`src/strategy/backtest.ts`）

**成交口径（保守日频模拟）**：

- t 日收盘生成信号 → **t+1 开盘执行**（滑点内嵌成交价）；
- long-only、无杠杆、**单币种**、等权分仓（每标的独立现金包络）；
- 买入整手；**T+1**（当日买入不可卖，按买入日 FIFO 手数跟踪）；
- 费用 = 佣金（最低佣金）+ 卖出印花税 + 滑点成本（分列输出）；
- **停牌**（零量/缺量）与**一字板**双向跳过；**开盘涨停不追买、开盘跌停不砍卖**，挂单顺延到下一个可成交日（日 OHLC 无法重建盘口限价队列，一字板尤其不保证可成交）；
- 现金不足买不成整手 → 跳过，**现金永不为负**。买入连佣金一起可负担：`notional + max(minFee, notional·feeRate) ≤ 现金`
  （最大可负担名义 = min(现金 − minFee, 现金/(1 + feeRate))，含费买不起才 skip `insufficient_cash`）。

**数据准入（拒绝即不出结论）**：代码/日期真实、OHLC 有限且关系成立、日期严格递增、单币种、标的不重复。
`adjustment=unknown` 的历史**默认拒绝**（不猜复权方式）；显式 `allowSimplifiedAdjustment` 放行时结果标记
`simplified=true` 与「简化调整价格模拟」提示——**仅示意，不输出可信回测结论**。

**输出**：交易日志（成交价/量/费用/印花税/滑点成本/信号日/skip 原因）、现金与持仓、权益曲线、最大回撤、
交易次数、换手率、成本合计、持仓敞口、样本天数；`engineVersion / strategyHash / dataHash / configHash` 四指纹。

**口径声明（必须随结果展示）**：未建模分红/再投资账务，收益为价格口径，**不声称真实含股息总回报**。

## 3. 稳健性与时间切片（`src/strategy/robustness.ts`）

- `parameterNeighborhood`：逐参数 ± 邻域展开（含基准、去重、顺序确定）。
- `costSensitivity`：同信号同数据对比费率/滑点场景。
- `makeFolds` / `walkForward`：滚动训练/验证折；**折间测试窗不重叠**，选型只用训练窗，泄漏即拒跑；
  样本外收益按折复利合并。
- **`FinalTestSet`（冻结最终测试集）**：
  - `select()` 只在 `testStart` 之前评估候选（并列按策略 hash，确定性）；
  - `viewFinal()` 首次计算并冻结（deep-freeze），**重复查看返回同一份结果，绝不重新选优**；
  - 依据测试结果改了策略必须 `markStrategyModified()`——该区间**不再是未见样本**，再选/再看被拒，需换新测试集；
  - 审计日志用单调序号（无时钟）：select / view / burn 全留痕。
- `evidenceCheck`：最少样本期 + 最少交易数；不足返回「证据不足」且 `rankable=false`——**不因一次高收益给确定性排名**。
- `disclosureReport`：标的池、逐标的数据覆盖、幸存者偏差、搜索次数、策略自由度、事后结构化免责。

## 4. 有限进化搜索与策略库（`src/strategy/search.ts`、`library.ts`）

- `runSearch`：固定 seed（mulberry32）→ 生成 → 确定性评估 → 保留 → 变异 → 再评估；
  候选/代数预算 + `shouldStop()` 取消；只在 DSL 数值参数上 ±步长变异（非法即弃）；
  候选按 hash 去重；保存**候选全集**含 lineage（父 hash/代数/变异说明）与完整可复现结果。
- 多目标选型：约束满足优先（最少交易/回撤下限/最少样本）→ 得分 → hash 字典序。
- `experimentFingerprint` 固化搜索输入：参数更新不得改写旧实验。
- **策略库**：`proposed → tested → watchlisted → retired` 版本化流转 + 理由 + 历史只追加；
  - Agent 提交路径（工具 `submit_strategy`）**只校验保存**，不回测不下单不执行代码；同 hash 去重；
  - 升级为生效跟踪（→`watchlisted`）**必须用户显式批准**（无确认只出预览，状态不动）；
  - `recordForward` 前向重评记录只追加（specHash+dataHash 可复现）；**不自动下单**。

## 5. 分币种市值回撤采样（`src/strategy/sampler.ts`）

- 分 **CNY/HKD/USD** 采样「已跟踪证券市值」= 报价 × 持仓量；**绝不跨币种相加**；
  缺现金/现金流账本 → 不称账户总净值或投资收益；无 FX 序列 → 不做基准币归一、不算 TWR/IRR。
- **成本绝不顶替行情**；缺报价标的列入 `missingCodes`，市值标 `complete=false`。
- 高水位（HWM）按币种独立：**部分缺报价的样本不更新 HWM**（避免假巨额回撤）；全缺则市值/回撤为 `null`。
- `holdingsRevision` 变化 → **新分段**（市值跳变不算回撤，HWM 重置）；`drawdownSegments` 分段汇总不拼接。
- 采样幂等：同输入重复采样不产生新分段、不重复历史。

## 6. 测试与运行

```bash
npm run build          # 类型检查 + 客户端打包
npm run test:offline   # 离线正确性（含 K线数学、共享校验、档案快照）
npm run test:quant     # 量化金样本 + T7-C/D 验收（手工推演基准）
npm run test:regressions
npm run test:personal
npm run test:ui        # UI 冒烟：无浏览器/无 DSH_UI_URL 时诚实 SKIPPED
```

`test:quant` 金样本为手工推演（见 `scripts/test_quant.ts` 注释），不允许用引擎输出回填；
覆盖逐笔成交/费用/T+1/资金不足/停牌/涨跌停/截断不变性/可复现/复权拒绝/DSL 拒绝/
邻域/成本敏感/walk-forward/冻结测试集/证据不足/搜索预算与取消/lineage/策略库确认/采样四规则。

## 7. 用户验收步骤（手动）

1. 打开面板 K 线页 → 同步一只 A 股 → 切换日/周/月、缩放、拖动、十字光标、色觉配色；深度档案页应显示同一图表与维度状态。
2. 用 `submit_strategy` 提交一份 DSL 草案 → 面板策略库应只出现 `proposed`；未经批准不得变成 `watchlisted`。
3. 跑 `test:quant` 两次，diff 输出应完全一致。
4. UI 冒烟在有浏览器的环境：`DSH_UI_URL=<面板地址> npm run test:ui`，通过后查看 `data/ui-shots/` 截图。

## 8. 已知限制（如实披露）

- 日频 OHLC 保守模拟 ≠ 真实成交；一字板/涨跌停按不可保证成交处理。
- 价格口径收益，不含分红/再投资；`adjustment=unknown` 只有显式放行才跑且标记「简化」。
- 首版 single-currency、long-only、等权分仓；A/H/美完整市场仿真、融资融券、税费账本未实现（规则不支持即拒绝）。
- 估值分位、F10 历史时点等基本面因子不参与历史回测（缺公告时点）。
- UI 冒烟在无浏览器环境只有 SKIPPED 记录，**不等于 UI 验收通过**。
- 策略搜索的 LLM 生成过程不保证可复现；可复现的是每个保存候选的评估结果。

## 9. 回滚说明

策略实验产物按 dataDir 落盘（`data/strategy-library.json`、实验结果目录等，均在 `.gitignore`），
删除即回滚，不影响持仓/历史/档案等既有数据；核心代码无迁移、无 schema 变更。
