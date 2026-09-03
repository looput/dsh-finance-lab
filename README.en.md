# DSN Finance

> Turn DeepSeek Harness from “look up a quote” into a practical market, portfolio, and research workspace.

[中文版](./README.md) · [MIT License](./package.json)

DSN Finance is a finance plugin for DeepSeek Harness. It brings A-shares, Hong Kong stocks, US stocks, funds, macroeconomic data, and financial news into model tools, while providing a dockable local finance panel. Market data uses public HTTP endpoints directly; holdings and watchlists stay in a local JSON file, making the plugin useful for personal research, portfolio reviews, and multi-agent analysis.

<img width="1331" height="804" alt="DSN Finance panel" src="https://github.com/user-attachments/assets/3fa063b1-22ef-404b-8fb9-1d230b7e66c0" />

## What you can do

- **Track multiple markets**: quotes, K-lines, sample lists, and symbol resolution for A-shares, Hong Kong stocks, US stocks, and public funds.
- **Move from data to signals**: calculate MA, MACD, RSI, and KDJ locally; inspect financial indicators, indices, and sector boards.
- **Follow the market narrative**: read China CPI/PPI/PMI/GDP/M2, market flashes, stock news, and search the web through DuckDuckGo without an API key.
- **Manage a personal portfolio**: maintain holdings and watchlists, calculate value and P&L, and inspect asset/market allocation plus top-1, top-3, and HHI concentration.
- **Run structured research**: built-in market, fundamentals, macro, fund, news, and risk-management playbooks can be delegated to DSH subagents and combined into one report.

## Core experience

### One panel, ten views

Open **📈 Finance Panel** from the sidebar:

| View | Includes |
| --- | --- |
| Quotes | Indices, watchlist trends, mini K-lines, and refreshable quotes |
| Market | Leading/lagging sectors for a quick view of where risk is building |
| Holdings | P&L, portfolio value, stock/fund allocation, and concentration |
| Funds | Open-ended fund ranking, NAV data, and add-to-watchlist actions |
| K-line | Local history store of daily K-lines with earnings/dividend/custom event markers |
| Macro | CPI, PPI, PMI, GDP, money supply, and trend lines |
| News | Global market flashes and stock news for holdings/watchlist symbols |
| Sources | Per-capability provider selection; click order is the fallback priority |
| Skills | Enable/disable local playbooks and Yingmi remote finance skills |
| Interfaces | Provider health, current sources, and MCP external source toggles |
You can also give the Agent a holdings screenshot and let it write the recognized positions through `import_holdings`; the panel refreshes afterward. Click any stock or fund in your holdings/watchlist to open a full AI analysis. Generation starts only after that explicit click, the report is cached locally, and you can regenerate it on demand. The plugin only changes local portfolio data. It does not place trades.

### Bidirectional panel ↔ chat channel

The panel and the model stay in sync in both directions:

- **Panel → chat**: clicking a holding/watch item injects the analysis task into the current Harness session.
- **Chat → panel**: tool-side mutations (holdings, watchlist, analysis cache, provider policy, skill toggles) are pushed to the panel instantly through a server event bus (`GET api/events`, SSE) instead of waiting for polling; the model can also call `panel_navigate` to switch the panel to a tab, focus a symbol on the K-line page, or open an AI analysis directly.
- The 60s poll remains as a fallback; EventSource reconnects automatically.

### What-if rebalance simulation

`simulate_rebalance` runs a **pure simulation** over local holdings — it never edits the portfolio file or places orders:

- **trades mode**: an explicit buy/sell list (sells first, cash constraints, oversells clamped);
- **targets mode**: target weights (percent of holdings value + available cash) are converted into trades automatically;
- Output: before/after total value, cash, weights, top1/top3, HHI, per-currency exposure, plus all warnings and basis caveats (fills at latest price, no slippage/fees, no FX conversion across currencies).

### Finance tools for models

| Area | Tools | Capabilities |
| --- | --- | --- |
| A-shares | `get_realtime_quote` · `get_stock_kline` · `search_stock` · `get_stock_list` | Quotes, daily/weekly/monthly K-lines, and sample-list search |
| A-shares | `get_market_overview` · `get_financial_indicators` · `get_sector_board` | Indices, financial indicators, and sector boards |
| Hong Kong | `get_hk_quote` · `get_hk_kline` · `get_hk_list` | Quotes, K-lines, and sample lists |
| US stocks | `get_us_quote` · `get_us_kline` | Yahoo-first quotes and K-lines with Eastmoney fallback |
| Funds | `get_fund_quote` · `get_fund_kline` · `get_fund_rank` | NAV, historical NAV trends, and category rankings |
| General | `search_symbol` · `get_stock_info` | Cross-market symbol resolution, profiles, and market caps |
| Research | `calculate_technical_indicators` · `get_macro_china` | MA/MACD/RSI/KDJ and China macro series |
| News | `get_market_news` · `get_stock_news` · `web_search` | Market flashes, stock news, and free web search |
| Portfolio | `get_portfolio` · `analyze_portfolio` · `upsert_holding` · `import_holdings` · `remove_holding` · `save_position_analysis` | CRUD, bulk import, P&L, risk analysis, and analysis caching |
| Simulation | `simulate_rebalance` | What-if rebalancing (trade list or target weights) with before/after weights, HHI, and per-currency exposure |
| Panel | `panel_navigate` | Switch the finance panel to a tab from chat, focus a symbol, or open its AI analysis |
| Watchlist | `add_watchlist` · `remove_watchlist` · `get_portfolio_file` | Local stock/fund watchlists and file access |
| Operations | `probe_finance_sources` | Serial endpoint checks and provider fallback ordering |

## Quick start

### 1. Install and build

Requires Node.js `>=20`:

```bash
cd dsn-finance-lab
npm install
npm run build
```

### 2. Probe public data sources first

Eastmoney, Tencent, Yahoo, and DuckDuckGo are public sources and may be affected by network conditions, anti-bot controls, or rate limits. Run a probe on first use; the plugin loads the report at startup and prefers healthy providers:

```bash
npm run probe

# Customize the report path and request gap
npx tsx scripts/probe_sources.ts \
  --out data/probe-report.json \
  --gap-sec 3

# Probe one capability.provider pair
npx tsx scripts/probe_sources.ts --only kline.em_kline
```

The report is written to `data/probe-report.json` by default. If all public providers for a capability are unavailable, the corresponding tool reports that it is unavailable; local portfolio CRUD still works.

### 3. Connect to DeepSeek Harness

Register the current project directory in the `web` profile:

```bash
npx @deepseek-ai/dsh plugin \
  --profile web add /absolute/path/to/dsn-finance-lab
npx @deepseek-ai/dsh web --profile web
```

For local development, you can also run:

```bash
bash scripts/dev_web.sh
```

If you need the development overlay with absolute paths:

```bash
npx @deepseek-ai/dsh web --patch ./cordis.dev.yml
```

After registration, open **📈 Finance Panel** in the lower-left corner of Harness. The model tools are loaded automatically.

## Configuration and data

The default configuration is in `cordis.patch.yml`:

| Option | Default | Description |
| --- | --- | --- |
| `cacheTtlSec` | `300` | Provider cache lifetime |
| `requestGapMs` | `3000` | Gap between public requests |
| `httpTimeoutMs` | `30000` | Per-request timeout |
| `probeReportPath` | `data/probe-report.json` | Provider probe report |
| `portfolioPath` | `data/portfolio.json` | Local holdings/watchlist file |
| `panelOpen` | unset | Whether to open the finance panel |
| `panelDocked` | unset | Whether the panel starts docked |

Relative paths are resolved from the plugin package directory. `data/probe-report.json` and `data/portfolio.json` are local runtime data and are ignored by Git.

## Availability tests

The repository includes a serial test set covering A-shares, Hong Kong stocks, US stocks, cross-market resolution, and web search:

```bash
npm run test:avail

# Test one group
npm run test:avail -- --group us
# Available groups: ashare, hk, us, tools, search
```

## Sources and boundaries

- The runtime does not depend on the Python `akshare` package. Endpoint shapes are aligned with [AkShare](https://github.com/akfamily/akshare), with source notes kept in `src/data/providers.ts`.
- Eastmoney is the primary source for A-shares, Hong Kong stocks, funds, macro data, and news; some quote capabilities also use Tencent. US stocks use Yahoo Finance first with Eastmoney fallback. Web search uses DuckDuckGo.
- Providers fall back independently per capability. Public sources do not guarantee stability or complete coverage; interpret results together with timestamps, market conditions, and provider health.
- This project is for research and portfolio record-keeping, not investment advice. It does not connect to a broker or place orders.

## Project structure

```text
src/                  Plugin service, providers, model tools, and finance panel
src/panel-bus.ts      Event bus behind the bidirectional panel ↔ chat channel (SSE push)
src/rebalance.ts      What-if rebalance simulation engine (pure, never edits holdings)
src/mcp/              External MCP source bridging (Miaoxiang HTTP / Yingmi CLI) + token hot reload
src/history/          Local history store (K-line / earnings / dividends) and sync
skills/               Finance, portfolio, strategy, risk, and research playbooks
scripts/              Provider probes, availability tests, and local web launcher
cordis.patch.yml      Harness registration and default configuration
```
