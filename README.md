# DSN Finance（dsn-finance）

DeepSeek Harness 金融插件：公开行情 HTTP **直连** + 本地持仓面板。运行时 **不依赖 akshare**；端点从 [AkShare](https://github.com/akfamily/akshare) 源码对照而来，注释里标注了函数名。

## 准备

```bash
cd dsn-finance-lab
npm install
npm run build
```

## 先探测数据源（必做）

公开源（东财/腾讯等）不稳定，**按 provider 串行探测**：

```bash
npm run probe
# 或
npx tsx scripts/probe_sources.ts --out data/probe-report.json --gap-sec 3
# 单测
npx tsx scripts/probe_sources.ts --only kline.em_kline
```

报告写入 `data/probe-report.json`。插件启动时会读取并调整降级顺序。

## 接入 DSN

```bash
npx @deepseek-ai/dsh plugin --profile web add /Users/lupu/workspace/harness/dsn-finance-lab
npx @deepseek-ai/dsh web --profile web
```

开发期绝对路径 overlay：

```bash
npx @deepseek-ai/dsh web --patch ./cordis.dev.yml
```

## 模型工具

| 工具 | 说明 |
|------|------|
| `probe_finance_sources` | 串行探测各 HTTP 端点 |
| `get_stock_kline` / `get_realtime_quote` | K 线 / 单票行情 |
| `calculate_technical_indicators` | MA/MACD/RSI/KDJ |
| `search_stock` / `get_stock_list` | 列表样本搜索 |
| `get_market_overview` / `get_financial_indicators` | 指数 / 财务 |
| `get_portfolio` / `upsert_holding` / `remove_holding` / `analyze_portfolio` | 持仓（无行情也可 CRUD） |

## 持仓面板

Settings → 插件配置 → `dsn-finance`：编辑持仓与自选股。

## 端点溯源

见 [`src/data/providers.ts`](src/data/providers.ts) 各函数上方的 `Source: akshare....` 注释。
