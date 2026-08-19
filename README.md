# DSN Finance

> 让 DeepSeek Harness 从“查一条行情”走向“看懂市场、管理组合、组织研究”。

[English README](./README.en.md) · [MIT License](./package.json)

DSN Finance 是一个面向 DeepSeek Harness 的金融插件：它把 A 股、港股、美股、基金、宏观数据和财经新闻接入模型，同时提供一个可停靠的本地金融面板。行情通过公开 HTTP 接口直连，持仓和自选股保存在本地 JSON 中，适合个人研究、组合复盘和多智能体协作。

<img width="1331" height="804" alt="DSN Finance panel" src="https://github.com/user-attachments/assets/3fa063b1-22ef-404b-8fb9-1d230b7e66c0" />

## 你可以用它做什么

- **跨市场看行情**：A 股、港股、美股和公募基金的报价、K 线、列表与代码解析。
- **从数据到判断**：本地计算 MA、MACD、RSI、KDJ；查询财务指标、市场指数和行业板块。
- **跟踪市场叙事**：读取中国 CPI/PPI/PMI/GDP/M2、市场电报、个股新闻，并通过 DuckDuckGo 免费搜索网页。
- **管理自己的组合**：维护持仓和自选股，计算市值、盈亏、资产类型/市场分布，以及 top1、top3 和 HHI 集中度。
- **用研究团队拆解问题**：内置行情、基本面、宏观、基金、消息和风险管理 playbook，可交给 DSH subagent 并行研究后汇总。

## 核心体验

### 一个面板，七个视角

从侧边栏打开 **📈 金融面板**，可在以下标签页之间切换：

| 标签页 | 内容 |
| --- | --- |
| 行情 | 指数、自选股走势、迷你 K 线和实时刷新 |
| 市场 | 领涨/领跌行业板块，快速定位当日风险 |
| 持仓 | 持仓盈亏、组合市值、股票/基金配置和集中度 |
| 基金 | 开放式基金排行、净值和加入自选 |
| 宏观 | CPI、PPI、PMI、GDP、货币供应量及趋势 |
| 快讯 | 全球财经电报，以及按持仓/自选筛选的个股新闻 |
| 接口 | 数据源健康状态与当前 provider |

持仓截图也可以交给 Agent 识别，再通过 `import_holdings` 批量写入本地文件；面板会自动刷新。插件只修改本地持仓数据，不执行真实交易。

### 面向模型的金融工具

| 领域 | 工具 | 能力 |
| --- | --- | --- |
| A 股 | `get_realtime_quote` · `get_stock_kline` · `search_stock` · `get_stock_list` | 行情、日/周/月 K 线、列表搜索 |
| A 股 | `get_market_overview` · `get_financial_indicators` · `get_sector_board` | 指数、财务指标、行业板块 |
| 港股 | `get_hk_quote` · `get_hk_kline` · `get_hk_list` | 港股报价、K 线和列表样本 |
| 美股 | `get_us_quote` · `get_us_kline` | Yahoo 优先、东财兜底的报价与 K 线 |
| 基金 | `get_fund_quote` · `get_fund_kline` · `get_fund_rank` | 净值、历史走势和分类排行 |
| 通用 | `search_symbol` · `get_stock_info` | 跨市场代码解析、个股档案与市值 |
| 研究 | `calculate_technical_indicators` · `get_macro_china` | MA/MACD/RSI/KDJ 与中国宏观序列 |
| 新闻 | `get_market_news` · `get_stock_news` · `web_search` | 市场快讯、个股新闻、免费网页搜索 |
| 组合 | `get_portfolio` · `analyze_portfolio` · `upsert_holding` · `import_holdings` · `remove_holding` | 持仓 CRUD、批量导入、盈亏与风险分析 |
| 自选 | `add_watchlist` · `remove_watchlist` · `get_portfolio_file` | 自选股/基金和本地文件管理 |
| 运维 | `probe_finance_sources` | 串行探测端点并生成 provider 降级顺序 |

## 快速开始

### 1. 安装并构建

需要 Node.js `>=20`：

```bash
cd dsn-finance-lab
npm install
npm run build
```

### 2. 先探测公开数据源

东财、腾讯、Yahoo 和 DuckDuckGo 都是公开源，可能受到网络波动、风控或限流影响。首次运行建议先探测，插件启动时会读取报告并优先使用健康的 provider：

```bash
npm run probe

# 指定输出和请求间隔
npx tsx scripts/probe_sources.ts \
  --out data/probe-report.json \
  --gap-sec 3

# 只探测某个 capability.provider
npx tsx scripts/probe_sources.ts --only kline.em_kline
```

报告默认写入 `data/probe-report.json`。全部公开源不可用时，行情工具会返回不可用信息；本地持仓 CRUD 仍然可以使用。

### 3. 接入 DeepSeek Harness

将当前项目目录注册到 `web` profile：

```bash
npx @deepseek-ai/dsh plugin \
  --profile web add /absolute/path/to/dsn-finance-lab
npx @deepseek-ai/dsh web --profile web
```

本地开发也可以直接运行：

```bash
bash scripts/dev_web.sh
```

如果需要使用开发期的绝对路径 overlay：

```bash
npx @deepseek-ai/dsh web --patch ./cordis.dev.yml
```

注册插件后，从 Harness 左下角的 **📈 金融面板** 打开 UI；模型工具会自动出现在工具列表中。

## 配置与数据

默认配置位于 `cordis.patch.yml`：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `cacheTtlSec` | `300` | provider 缓存时间 |
| `requestGapMs` | `3000` | 相邻公开请求的间隔 |
| `httpTimeoutMs` | `30000` | 单次请求超时 |
| `probeReportPath` | `data/probe-report.json` | provider 探测报告 |
| `portfolioPath` | `data/portfolio.json` | 本地持仓/自选文件 |
| `panelOpen` | 未设置 | 是否打开金融面板 |
| `panelDocked` | 未设置 | 是否默认停靠为侧栏页 |

相对路径均以插件包目录为基准。`data/probe-report.json` 和 `data/portfolio.json` 属于本地运行数据，不会被提交。

## 可用性测试

项目提供覆盖 A 股、港股、美股、跨市场解析和网页搜索的串行测试集：

```bash
npm run test:avail

# 只测试某个分组
npm run test:avail -- --group us
# 可选分组：ashare、hk、us、tools、search
```

## 数据源与边界

- 运行时不依赖 Python `akshare`；接口形状参考 [AkShare](https://github.com/akfamily/akshare) 源码，并在 `src/data/providers.ts` 中保留来源注释。
- A 股、港股、基金、宏观和新闻主要使用东方财富，部分行情使用腾讯；美股优先使用 Yahoo Finance，并以东方财富兜底；网页搜索使用 DuckDuckGo。
- provider 会按 capability 独立降级。公开源并不承诺稳定性或完整覆盖，返回结果应结合时间、市场状态和来源健康度解读。
- 本项目用于研究和组合记录，不构成投资建议；不连接券商，也不执行下单。

## 项目结构

```text
src/                  插件服务、provider、模型工具和金融面板
skills/               财务分析、组合、策略、风控与研究团队 playbook
scripts/              provider 探测、可用性测试和本地 Web 启动脚本
cordis.patch.yml      Harness 插件注册与默认配置
```
