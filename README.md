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

| 分类 | 工具 | 说明 |
|------|------|------|
| A 股 | `get_stock_kline` / `get_realtime_quote` | K 线 / 单票行情（东财 + 腾讯） |
| A 股 | `search_stock` / `get_stock_list` | 列表样本搜索 |
| A 股 | `get_market_overview` / `get_financial_indicators` | 沪深指数 / 财务 |
| 港股 | `get_hk_quote` / `get_hk_kline` / `get_hk_list` | 港股行情 / K 线 / 列表（东财，secid 116/128） |
| 美股 | `get_us_quote` / `get_us_kline` | 美股行情 / K 线（Yahoo 优先，东财兜底） |
| 通用 | `search_symbol` | 跨市场代码/名称解析（东财 suggest） |
| 通用 | `get_stock_info` | 个股档案：现价/涨跌/总市值/流通市值/股本 |
| 通用 | `calculate_technical_indicators` | MA/MACD/RSI/KDJ（本地计算） |
| 搜索 | `web_search` | 免费网页搜索（DuckDuckGo，无需 Key） |
| 持仓 | `get_portfolio` / `upsert_holding` / `remove_holding` / `analyze_portfolio` | 持仓（无行情也可 CRUD） |
| 运维 | `probe_finance_sources` | 串行探测各 HTTP 端点健康 |

端点对照 [AkShare](https://github.com/akfamily/akshare)（`stock_hk_hist` / `stock_hk_spot_em` / `stock_us_hist` / `stock_individual_info_em` 等）；美股同时走 [yfinance](https://github.com/ranaroussi/yfinance) 式 Yahoo 会话。东财 push2 用统一 secid（`1.`沪 / `0.`深 / `116.`港 / `105|106|107.`美），跨市场经 suggest 解析。公开源遇风控/限流时自动降级或放弃。

## 可用性测试集

多类 Query（A 股 / 美股 / 搜索）串行探测各能力可用性：

```bash
npm run test:avail
# 或只测一组
npx tsx scripts/test_availability.ts --group us
```

## 持仓面板

Settings → 插件配置 → `dsn-finance`：编辑持仓与自选股。

## 端点溯源

见 [`src/data/providers.ts`](src/data/providers.ts) 各函数上方的 `Source: akshare....` 注释。
