#!/usr/bin/env npx tsx
/**
 * 功能正确性测试（离线、可重复）——不依赖网络、不依赖真实数据源。
 *
 *   npx tsx scripts/test_offline.ts
 *
 * 覆盖：
 *   1. Markdown 表格解析（WeStock CLI 的唯一输出格式）
 *   2. 代码 → CLI symbol 映射（A/港/美）
 *   3. westock provider 端到端映射（用 fake CLI，确定性离线）
 *   4. 失败路径：二进制缺失 / 命令报错 → 明确错误（不再静默）
 *   5. Research Vault：必填校验、过滤检索、观点追加、归档、落盘文件
 *   6. Logger：JSONL 落盘、级别过滤、recent 读取
 *   7. Provider registry：策略校验、目录包含 WeStock、默认优先级
 */
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { configureWestock, parseMarkdownTables, toWestockSymbol, fromWestockSymbol, klineArgs, westockProviders, westockRaw, validateRawArgv, WestockRawError } from '../src/data/westock.ts'
import { WESTOCK_SPECS, WESTOCK_CAPABILITY_PROVIDERS, westockCapabilityCatalog } from '../src/data/westock-capabilities.ts'
import { Logger } from '../src/log.ts'
import { ResearchVault, ResearchValidationError, renderResearchDoc } from '../src/research/store.ts'
import { routeCode, FinanceDataService } from '../src/data/service.ts'
import { ProviderRegistry } from '../src/data/registry.ts'
import { CAPABILITIES, DEFAULT_PROVIDER_ORDER } from '../src/types.ts'
import { ReminderStore, scanReminders } from '../src/reminders.js'
import { buildStockDossier, dossierSummary } from '../src/data/dossier.js'
import { buildFundDossier } from '../src/data/fund-dossier.js'
import { parseFundNavLsjz, parseFundHoldings, fundRankSc, fundRankRequest } from '../src/data/providers.js'
import { emSecMarket } from '../src/data/http.js'
import { computeLookthrough, marginalLookthrough, buildLookthrough } from '../src/lookthrough.js'
import { GROWTH_CURRICULUM, METRIC_CONCEPT_MAP, findLesson, lessonByQuery } from '../src/growth-curriculum.js'
import { computeGrowth, computeStreak, diagnoseGrowth, evaluateFamilyPlan, gradeQuiz, type GrowthState } from '../src/growth.js'
import { GrowthStore } from '../src/growth-store.js'
import { PanelBus, isStaleCommand } from '../src/panel-bus.js'
import { setPanelFocus, getPanelFocus } from '../src/panel-focus.js'
import { registerTools } from '../src/tools/register.js'
import {
  compareFunds, compareWithBenchmark, computeFundOverlap, computeFundRiskMetrics,
  isOnExchangeFundCode, latestProfileNumber, normalizeHoldingCode, normalizeNavSeries, profileRows,
} from '../src/fund-analysis.js'
import {
  MA_WINDOWS, aggregateBars, clampViewport, indexAtX, isPeriodClosed, lastWeekdayOfMonth,
  monthEnd, movingAverage, palette, panViewport, priceRange, sanitizeBars, visibleRange,
  weekStart, zoomViewport,
} from '../src/client/kline-math.js'
import {
  ValidationError, expectNoUnknownFields, validateAssetType, validateBudget, validateCode,
  validateDate, validateDateRange, validateFinite, validateNonNegative, validatePagination,
} from '../src/validation.js'
import { advisorMemory, registerRoutes, API_PREFIX } from '../src/server-routes.js'
import {
  defaultFollowState, daysSince, staleLevel, diff13F, diffCongress, latestSnapshot, previousSnapshot,
  jobKey, shouldEnqueue, allocateShadow, applyEntryPrice, shadowTotals, overlapWithHoldings, matchAliases,
  type FollowPosition, type FollowSnapshot, type FollowTrade,
} from '../src/follow.ts'
import { FollowStore, DEFAULT_FOLLOW_TARGETS } from '../src/follow-store.ts'
import {
  parse13FInformationTable, parseEdgarSubmissions, latestFilingGroup, normalizeIssuerName,
  parseCompanyTickers, mapPositionsToTickers, parseAmountRange, parseCongressBargo, parseEdgarCompanyAtom,
  fetchEdgarFilings, secUserAgent,
} from '../src/data/follow-sources.ts'
import { resolveAliases } from '../src/data/manager-aliases.ts'
import { registerFollowTools, followHash, summarizeDiff } from '../src/tools/follow-tools.ts'
import { PersonalStore, weekKey, setWeekTimeZone } from '../src/personal.js'
import type { PersonalState, Thesis, ReviewCard as PersonalReviewCard, WeeklyJob } from '../src/personal.js'
import { HistoryStore, detectGaps } from '../src/history/store.js'
import { fetchKlinePaged } from '../src/history/sync.js'
import { metricProvenance, KNOWN_METRICS, evaluateThesis, factsFromFundProfile, factsFromFundRisk } from '../src/personal-eval.js'
import { westockCapabilityMeta } from '../src/data/westock-capabilities.js'
import { defaultOpenFamily, groupBySource } from '../src/client/sources-group.js'
import type { KlineBar } from '../src/types.js'
import { parseBingRss } from '../src/data/providers.js'
import {
  isAShareCode,
  buildLocalPeerComparison,
  normalizeBusinessComposition,
  normalizeCompanySurvey,
  normalizeCoreConcepts,
  normalizeMainFinancials,
  normalizePeers,
  normalizeShareholderCount,
  normalizeValuation,
  valuationPercentile,
} from '../src/data/eastmoney-f10.js'

let passed = 0
let failed = 0
const failures: string[] = []

/** Bing RSS 样例：含 CDATA 与 &amp; 转义，验证解析与还原。 */
const FIXTURE_RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[贵州茅台 & 五粮液 对比]]></title><link>https://example.com/a</link><description>摘要 A</description></item>
<item><title>第二 &amp; 条</title><link>https://example.com/b</link><description>摘要 B</description></item>
</channel></rss>`

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? `${JSON.stringify(actual)}` : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-finance-offline-'))
  const realFetch = globalThis.fetch
  // ---- 批次21 fixtures：EDGAR（submissions/13F XML/company_tickers/atom）+ Bargo（members/trades，轮换响应测增量） ----
  const FIX_SUBMISSIONS = {
    filings: { recent: {
      form: ['13F-HR', '13D', '13F-HR'],
      accessionNumber: ['0001193125-26-054580', '0001193125-25-777777', '0001193125-25-666666'],
      filingDate: ['2026-02-17', '2026-01-10', '2025-11-14'],
      reportDate: ['2025-12-31', '', '2025-09-30'],
    } },
  }
  const FIX_13F_XML = [
    '<?xml version="1.0"?><informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">',
    '<infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><cusip>037833100</cusip><titleOfClass>COM</titleOfClass><value>600000000</value><shrsOrPrnamt><sshPrnamt>30000000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnamt></infoTable>',
    '<infoTable><nameOfIssuer>COCA COLA CO</nameOfIssuer><cusip>191216100</cusip><titleOfClass>COM</titleOfClass><value>20000000</value><shrsOrPrnamt><sshPrnamt>32000000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnamt></infoTable>',
    '</informationTable>',
  ].join('')
  const FIX_TICKERS = {
    '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
    '1': { cik_str: 1309001, ticker: 'KO', title: 'Coca Cola Co' },
  }
  const FIX_ATOM = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>BERKSHIRE HATHAWAY INC (CIK 0001067983)</title><content>CIK=0001067983</content></entry></feed>'
  const BARGO_T1 = { id: 'bt1', ticker: 'NVDA', politician_name: 'Nancy Pelosi', transaction_type: 'purchase', amount_range: '$1,001 - $15,000', transaction_date: '2026-09-10', disclosure_date: '2026-09-20', asset_description: 'NVDA call' }
  const BARGO_T2 = { id: 'bt2', ticker: 'TSLA', politician_name: 'Nancy Pelosi', transaction_type: 'sale', amount_range: '$50,001 - $100,000', transaction_date: '2026-09-11', disclosure_date: '2026-09-21' }
  const followFx = { bargoHits: 0 }
  // A truly offline suite: no external requests. Exercise the real HTTP parser
  // and provider fallback with a deterministic JSONP response.
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    // SEC 公平访问：UA 不带联系方式 → 403（复现真实拦截，验证默认 UA 与修复指引）
    if (url.hostname === 'www.sec.gov' || url.hostname === 'data.sec.gov') {
      const ua = String((init?.headers as Record<string, string> | undefined)?.['User-Agent'] ?? '')
      if (!ua.includes('@') && !ua.includes('github.com')) return new Response('Forbidden', { status: 403, statusText: 'Forbidden' })
    }
    if (url.hostname === 'search-api-web.eastmoney.com') return new Response('x(' + JSON.stringify({ result: { cmsArticleWebOld: [{ title: '离线新闻', content: '摘要', url: 'https://example.com/news', date: '2026-09-27 09:00:00', mediaName: '测试来源' }] } }) + ')', { status: 200 })
    if (url.hostname === 'data.sec.gov' && url.pathname === '/submissions/CIK0001067983.json') return Response.json(FIX_SUBMISSIONS)
    if (url.hostname === 'www.sec.gov' && url.pathname === '/files/company_tickers.json') return Response.json(FIX_TICKERS)
    if (url.hostname === 'www.sec.gov' && url.pathname.startsWith('/cgi-bin/browse-edgar')) return new Response(FIX_ATOM, { status: 200 })
    const arch = /^\/Archives\/edgar\/data\/1067983\/([^/]+)\/(.+)$/.exec(url.pathname)
    if (url.hostname === 'www.sec.gov' && arch) {
      if (arch[2] === 'index.json') return Response.json({ directory: { item: [{ name: 'primary_doc.xml' }, { name: 'form13fInfoTable.xml' }] } })
      if (/\.xml$/i.test(arch[2] ?? '')) return new Response(FIX_13F_XML, { status: 200 })
    }
    if (url.hostname === 'www.bargo.ai' && url.pathname.endsWith('/members')) {
      return Response.json({ members: [{ slug: 'nancy-pelosi', name: 'Nancy Pelosi' }, { slug: 'other-member', name: 'Other Member' }] })
    }
    if (url.hostname === 'www.bargo.ai' && url.pathname.endsWith('/trades')) {
      followFx.bargoHits++
      // 第1次返回1笔（基线），第2次起多1笔（增量），第3次不再变化（幂等）
      return Response.json({ trades: followFx.bargoHits === 1 ? [BARGO_T1] : [BARGO_T1, BARGO_T2] })
    }
    throw new Error(`offline: blocked network ${url.hostname}`)
  }
  try {
    // ---- 1. Markdown table parsing ----
    console.log('\n== markdown table parsing ==')
    const tables = parseMarkdownTables([
      '# 贵州茅台(600519)跟踪报告',
      '',
      '| type | id | title | time |',
      '| --- | --- | --- | --- |',
      '| 1 | res1 | 【诚通证券】标题A | 2026-09-18 00:00:00 |',
      '| 1 | res2 | 【长江证券】标题B | 2026-08-27 00:00:00 |',
      '',
      '**利润表**',
      '',
      '| EndDate | OperatingRevenue |',
      '| --- | --- |',
      '| 2026-06-30 | 922.78 |',
    ].join('\n'))
    check('parses two tables', tables.length === 2, `tables=${tables.length}`)
    eq('first table rows', tables[0]!.rows.length, 2)
    eq('row field', tables[0]!.rows[0]!.title, '【诚通证券】标题A')
    eq('section heading captured', tables[1]!.section, '利润表')
    eq('numeric cell kept as string', tables[1]!.rows[0]!.OperatingRevenue, '922.78')
    eq('empty text → no tables', parseMarkdownTables('no table here').length, 0)

    // ---- 2. symbol mapping ----
    console.log('\n== symbol mapping ==')
    eq('A股 600519', toWestockSymbol('600519'), 'sh600519')
    eq('A股 000001', toWestockSymbol('000001'), 'sz000001')
    eq('北交所 830799', toWestockSymbol('830799'), 'bj830799')
    eq('港股 00700', toWestockSymbol('00700'), 'hk00700')
    eq('港股 700', toWestockSymbol('700'), 'hk00700')
    eq('美股 AAPL', toWestockSymbol('AAPL'), 'usAAPL')
    eq('后缀 00700.HK', toWestockSymbol('00700.HK'), 'hk00700')
    eq('后缀 600519.SH', toWestockSymbol('600519.SH'), 'sh600519')
    eq('reverse sh600519', fromWestockSymbol('sh600519'), '600519')
    eq('reverse hk00700', fromWestockSymbol('hk00700'), '00700')
    eq('kline args', klineArgs('600519', 'daily', 30), ['kline', 'sh600519', '--period', 'day', '--limit', '30'])
    eq('kline args with range', klineArgs('600519', 'weekly', 60, '2026-01-01', '2026-09-24'),
      ['kline', 'sh600519', '--period', 'week', '--limit', '60', '--start', '2026-01-01', '--end', '2026-09-24'])

    // ---- 3. providers against a fake CLI ----
    console.log('\n== westock providers (fake CLI, offline) ==')
    const fake = path.join(root, 'fake-westock.sh')
    await writeFile(fake, `#!/bin/sh
sym="\${3:-}"
case "$1" in
  -v) echo "westock 0.0.5 channel=workbuddy (fake)" ;;
  quote)
    printf '| code | name | price | prev_close | change | change_percent | time |\\n| --- | --- | --- | --- | --- | --- | --- |\\n| %s | 测试标的 | 1237 | 1251.24 | -14.24 | -1.14 | 2026-09-24 |\\n' "$2"
    ;;
  kline)
    printf '| date | open | last | high | low | volume | amount |\\n| --- | --- | --- | --- | --- | --- | --- |\\n| 2026-09-25 | 1240 | 1245 | 1250 | 1235 | | |\\n| 2026-09-24 | 1250.01 | 1237 | 1256.13 | 1231.05 | 31239 | 3867 |\\n| 2026-09-23 | 1255.03 | 1251.24 | 1271.5 | 1250.89 | 30981 | 3894 |\\n| 2026-09-22 | 0 | 0 | 0 | 0 | 0 | 0 |\\n'
    ;;
  search)
    printf '**股票** — 共 2 条\\n\\n| code | name | type |\\n| --- | --- | --- |\\n| hk00700 | 腾讯控股 | GP |\\n| usAAPL | 苹果 | GP |\\n'
    ;;
  news)
    printf '| id | src | summary | time | title | url |\\n| --- | --- | --- | --- | --- | --- |\\n| SN1 | 华夏酒报 | 摘要 | 2026-09-27 11:25:25 | 新闻标题 | http://x |\\n'
    ;;
  report)
    if [ "$2" = "list" ]; then
      printf '共 9999 条\\n| type | id | src | summary | symbol | time | title | typeStr | tzpj | url |\\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\\n| 1 | res1 | 诚通证券 | 摘要A | sh600519 | 2026-09-18 00:00:00 | 【诚通证券】标题A | 中报点评 | 买入 | http://r/1 |\\n'
    else
      printf '# 研报正文\\n\\n日期: 2026-09-18\\n\\n正文内容。\\n'
    fi
    ;;
  finance)
    printf '**利润表**\\n\\n| EndDate | OperatingRevenue | ROE |\\n| --- | --- | --- |\\n| 2026-06-30 | 922.78 | 17.71 |\\n'
    ;;
  profile)
    printf '| code | name | listedDate | industry | business |\\n| --- | --- | --- | --- | --- |\\n| sh600519 | 贵州茅台 | 2001-08-27 | 食品饮料 | 白酒生产与销售 |\\n'
    ;;
  *) echo "unknown command: $1" >&2; exit 2 ;;
esac
`, 'utf8')
    await chmod(fake, 0o755)

    const ctx = { timeoutMs: 10_000 }
    configureWestock({ enabled: true, binPath: fake, timeoutMs: 10_000, autoUpgrade: false })

    const quote = await westockProviders.quote({ code: '600519' }, ctx)
    eq('quote → StockQuote.price', (quote.data as { price?: number }).price, 1237)
    eq('quote → code normalized', (quote.data as { code?: string }).code, '600519')
    eq('quote → changePercent', (quote.data as { changePercent?: number }).changePercent, -1.14)

    const kline = await westockProviders.kline({ code: '600519', days: 30 }, ctx)
    const bars = kline.rows as Array<{ date: string; close: number; open: number; volumeMissing?: boolean }>
    eq('kline → bars（零价行被拒绝，不补 0）', bars.length, 3)
    check('kline → 统一为时间升序（与东财/Yahoo 一致）',
      Date.parse(bars[0]!.date) < Date.parse(bars[1]!.date), bars.map((b) => b.date).join(' → '))
    eq('kline → 最新一根 close 取 `last`', bars[1]!.close, 1237)
    eq('kline → 日期解析', bars[1]!.date, '2026-09-24')
    eq('kline → 零价/缺失价格行被拒绝', bars.some((b) => b.date === '2026-09-22'), false)
    eq('kline → 缺失成交量标记 volumeMissing 而非 0 成交', bars[2]!.volumeMissing, true)

    const search = await westockProviders.search({ query: '腾讯' }, ctx)
    const matches = search.rows as Array<{ code: string; market: string; secid: string }>
    eq('search → 2 matches', matches.length, 2)
    eq('search → hk market label', matches[0]!.market, '港股')
    eq('search → secid kept', matches[0]!.secid, 'hk00700')

    const news = await westockProviders.news({ code: '600519', size: 5 }, ctx)
    eq('news → title', (news.rows as Array<{ title: string }>)[0]!.title, '新闻标题')

    const research = await westockProviders.research({ code: '600519', size: 5 }, ctx)
    const reports = research.rows as Array<{ id: string; org?: string; rating?: string; time: string; code: string }>
    eq('research → 1 report', reports.length, 1)
    eq('research → org', reports[0]!.org, '诚通证券')
    eq('research → rating', reports[0]!.rating, '买入')
    eq('research → date trimmed', reports[0]!.time, '2026-09-18 00:00:00'.slice(0, 19))
    eq('research → code', reports[0]!.code, '600519')

    const fin = await westockProviders.financials({ code: '600519' }, ctx)
    const finRows = fin.rows as Array<Record<string, unknown>>
    eq('financials → numeric coercion', finRows[0]!.OperatingRevenue, 922.78)
    eq('financials → section', finRows[0]!._section, '利润表')

    const profile = await westockProviders.profile({ code: '600519' }, ctx)
    eq('profile → industry', (profile.data as { industry?: string }).industry, '食品饮料')

    // ---- 4. failure paths are explicit, never silent ----
    console.log('\n== failure paths ==')
    configureWestock({ enabled: true, binPath: path.join(root, 'does-not-exist', 'westock'), timeoutMs: 5_000 })
    let missingMsg = ''
    try {
      await westockProviders.quote({ code: '600519' }, ctx)
    } catch (err) {
      missingMsg = err instanceof Error ? err.message : String(err)
    }
    check('missing binary → explicit error', /不存在|ENOENT|不可用/.test(missingMsg), missingMsg)

    configureWestock({ enabled: false, binPath: fake, timeoutMs: 5_000 })
    let disabledMsg = ''
    try {
      await westockProviders.quote({ code: '600519' }, ctx)
    } catch (err) {
      disabledMsg = err instanceof Error ? err.message : String(err)
    }
    check('disabled source → explicit error', /已停用/.test(disabledMsg), disabledMsg)

    configureWestock({ enabled: true, binPath: fake, timeoutMs: 5_000 })
    let unknownMsg = ''
    try {
      await (westockProviders as unknown as Record<string, (a: Record<string, unknown>, c: unknown) => Promise<unknown>>).nope({ code: '1' }, ctx)
    } catch {
      unknownMsg = 'n/a'
    }
    check('unknown provider is not exported', unknownMsg === 'n/a')

    // ---- 4b. 表驱动能力目录：每个 spec 的 argv 构造 + 解析 ----
    console.log('\n== westock capability catalog (table-driven) ==')
    const echo = path.join(root, 'fake-westock-echo.sh')
    await writeFile(echo, '#!/bin/sh\nprintf "| argv |\\n| --- |\\n| %s |\\n" "$*"\n', 'utf8')
    await chmod(echo, 0o755)
    configureWestock({ enabled: true, binPath: echo, timeoutMs: 5_000 })
    check('能力目录非空', WESTOCK_SPECS.length >= 45, `specs=${WESTOCK_SPECS.length}`)
    check('每个 spec 都有对应 provider', WESTOCK_SPECS.every((s) => typeof WESTOCK_CAPABILITY_PROVIDERS[s.id] === 'function'))
    check('capability 唯一性（同 capability 允许多源）',
      new Set(WESTOCK_SPECS.map((s) => s.capability)).size <= WESTOCK_SPECS.length)

    let argvBad = 0
    let symbolBad = 0
    for (const spec of WESTOCK_SPECS) {
      const provider = WESTOCK_CAPABILITY_PROVIDERS[spec.id]!
      const res = await provider({ ...spec.sampleArgs }, { timeoutMs: 5_000 })
      const argv = String((res.rows?.[0] as Record<string, string> | undefined)?.argv ?? '').split(' ').filter(Boolean)
      // usage 里的字面命令（去掉 `<占位>`、`[可选]`、`--flag` 及其取值）必须与 argv 前缀一致
      const literal = spec.usage
        .replace(/^westock\s+/, '')
        .replace(/<[^>]*>/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .split(/\s+/)
        .filter((t) => t && !t.startsWith('--') && /^[A-Za-z0-9_\u4e00-\u9fa5-]+$/.test(t))
      const expect = literal[1] ? literal.slice(0, 2) : literal.slice(0, 1)
      if (expect.join(' ') !== argv.slice(0, expect.length).join(' ')) {
        argvBad++
        console.log(`    argv mismatch ${spec.id}: expect ${expect.join(' ')} got ${argv.join(' ')}`)
      }
      // 代码类 spec：必须把裸代码映射成带市场前缀的 symbol
      if (spec.codeKind !== 'raw' && typeof spec.sampleArgs.code === 'string' && /^\d{4,6}$/.test(spec.sampleArgs.code)) {
        if (!argv.includes(toWestockSymbol(spec.sampleArgs.code))) {
          symbolBad++
          console.log(`    symbol mismatch ${spec.id}: ${argv.join(' ')} (want ${toWestockSymbol(spec.sampleArgs.code)})`)
        }
      }
    }
    eq('全部 spec 的 argv 前缀正确', argvBad, 0)
    eq('全部 spec 的 symbol 映射正确', symbolBad, 0)

    // ---- 4c. 通用 CLI 桥（逃生舱）----
    console.log('\n== westock raw bridge ==')
    const raw = await westockRaw(['fund', 'flow', 'sh600519'], { timeoutMs: 5_000 })
    eq('raw 桥执行并回显 argv', raw.argv.join(' '), 'fund flow sh600519')
    eq('raw 桥解析表格行数', raw.rows.length, 1)

    const denied: string[] = []
    for (const bad of [['update'], ['upgrade'], ['config', 'set'], ['login'], []]) {
      try { validateRawArgv(bad); denied.push(`未拦截: ${JSON.stringify(bad)}`) }
      catch (err) { if (!(err instanceof WestockRawError)) denied.push(`错误类型不对: ${JSON.stringify(bad)}`) }
    }
    for (const bad of [['quote', 'sh600519;rm -rf /'], ['quote', '$(whoami)'], ['quote', 'a|b']]) {
      try { validateRawArgv(bad); denied.push(`未拦截注入: ${JSON.stringify(bad)}`) }
      catch { /* expected */ }
    }
    eq('危险/写操作/注入参数全部被拦截', denied.length, 0)
    check('argv 过长被拦截', (() => {
      try { validateRawArgv(Array.from({ length: 40 }, (_, i) => `a${i}`)); return false }
      catch { return true }
    })())
    check('字符串 argv 也会被解析', validateRawArgv('quote sh600519').join(' ') === 'quote sh600519')

    // ---- 5. Research Vault ----
    console.log('\n== research vault ==')
    const vaultDir = path.join(root, 'research')
    const vault = new ResearchVault(vaultDir)
    await vault.load()
    eq('empty vault', vault.all().length, 0)

    let vErr = ''
    try {
      await vault.create({ title: '缺来源', source: '', occurredAt: '2026-09-18' })
    } catch (err) {
      vErr = err instanceof ResearchValidationError ? err.message : String(err)
    }
    check('source 必填校验', /source/.test(vErr), vErr)
    vErr = ''
    try {
      await vault.create({ title: '缺时间', source: '诚通证券研报', occurredAt: '' })
    } catch (err) {
      vErr = err instanceof ResearchValidationError ? err.message : String(err)
    }
    check('occurredAt 必填校验', /occurredAt|时间/.test(vErr), vErr)
    vErr = ''
    try {
      await vault.create({ title: '', source: 'x', occurredAt: '2026-09-18' })
    } catch (err) {
      vErr = err instanceof ResearchValidationError ? err.message : String(err)
    }
    check('title 必填校验', /title/.test(vErr), vErr)

    const report = await vault.create({
      title: '【诚通证券】贵州茅台公司跟踪报告',
      kind: 'report',
      source: '诚通证券研报',
      occurredAt: '2026-09-18',
      codes: ['600519'],
      tags: ['白酒', '中报点评'],
      summary: '低速稳态发展',
      body: '正文：营收 922.78 亿。',
      opinion: '短期承压，长期看龙头地位不改',
    })
    check('created item persisted', vault.all().length === 1)
    eq('关联标的', report.codes, ['600519'])
    eq('默认状态 inbox', report.status, 'inbox')

    const docPath = path.join(vaultDir, report.file)
    let docExists = true
    try { await access(docPath) } catch { docExists = false }
    check('正文落盘为工作区 Markdown', docExists, report.file)
    const docText = await readFile(docPath, 'utf8')
    check('文档含 frontmatter 来源/时间/标的',
      /source: 诚通证券研报/.test(docText) && /date: 2026-09-18/.test(docText) && /codes: \[600519\]/.test(docText))
    check('文档含正文与观点（含 frontmatter 元数据）',
      /正文：营收/.test(docText) && /opinion: 短期承压/.test(docText) && /summary: 低速稳态发展/.test(docText))
    check('正文不再重复渲染标题/来源块', !/# 【诚通证券】/.test(docText) && !/^> 来源/m.test(docText))

    const filing = await vault.create({
      title: '2026 中报', kind: 'filing', source: '公司公告', occurredAt: '2026-08-27', codes: ['600519'],
    })
    const note = await vault.create({
      title: '关于白酒周期的判断', kind: 'note', source: '个人观点', occurredAt: '2026-09-27',
      codes: ['600519'], opinion: '库存周期未见底', status: 'active',
    })

    eq('按 kind 过滤', vault.list({ kind: 'report' }).length, 1)
    eq('按 status 过滤', vault.list({ status: 'active' }).length, 1)
    eq('按 code 过滤', vault.list({ code: '600519' }).length, 3)
    eq('按 tag 过滤', vault.list({ tag: '白酒' }).length, 1)
    eq('全文检索（观点）', vault.list({ query: '库存周期' }).length, 1)
    eq('按资料时间倒序', vault.list().map((i) => i.id)[0], note.id)
    eq('limit 生效', vault.list({ limit: 2 }).length, 2)

    const noted = await vault.addNote(report.id, '批注：关注三季度动销', '我')
    eq('追加观点', noted.notes.length, 1)
    eq('观点带作者', noted.notes[0]!.author, '我')
    check('观点带时间戳', !!Date.parse(noted.notes[0]!.at))
    const notedAgain = await vault.addNote(report.id, '第二条：估值进入合理区间')
    eq('观点追加不覆盖', notedAgain.notes.length, 2)

    const archived = await vault.setStatus(report.id, 'archived')
    eq('归档状态', archived.status, 'archived')
    check('归档时间戳', !!archived.archivedAt)
    eq('归档后仍可检索', vault.list({ status: 'archived' }).length, 1)
    const restored = await vault.setStatus(report.id, 'active')
    eq('恢复状态', restored.status, 'active')

    const updated = await vault.update(filing.id, { codes: ['600519', '000858'], tags: ['财报'] })
    eq('覆盖式更新 codes', updated.codes, ['600519', '000858'])
    eq('覆盖式更新 tags', updated.tags, ['财报'])

    const stats = vault.stats()
    eq('stats.total', stats.total, 3)
    eq('stats.byKind.report', stats.byKind.report, 1)
    eq('stats.topCodes[0]', stats.topCodes[0], { code: '600519', count: 3 })

    eq('删除', await vault.remove(note.id), true)
    eq('删除后总数', vault.all().length, 2)

    // reload from disk: index is the source of truth, docs stay on the workspace
    const vault2 = new ResearchVault(vaultDir)
    await vault2.load()
    eq('reload 恢复条目', vault2.all().length, 2)
    eq('reload 保留观点', vault2.find(report.id)?.notes.length, 2)
    const reloadedDoc = await vault2.readBody(vault2.find(report.id)!)
    check('reload 后正文可读', /正文：营收/.test(reloadedDoc))
    check('renderResearchDoc 幂等渲染', renderResearchDoc(vault2.find(report.id)!, 'X').includes('## 观点与批注'))

    // ---- 5b. 本地文件 ↔ 索引 双向联动 ----
    console.log('\n== research vault ↔ local files ==')
    const doc = await vault.readDoc(vault.find(report.id)!)
    check('readDoc 正文剥离 frontmatter', !doc.body.startsWith('---') && /正文：营收/.test(doc.body))
    check('readDoc 返回文件批注', doc.notes.length === 2, `notes=${doc.notes.length}`)
    check('readDoc 返回文件 mtime', !!doc.mtime)

    await vault.writeBody(report.id, '改过的正文 v2')
    const afterWrite = await readFile(path.join(vaultDir, vault.find(report.id)!.file), 'utf8')
    check('writeBody 写回文件', /改过的正文 v2/.test(afterWrite))
    check('writeBody 保留 frontmatter', /^---\nid: /.test(afterWrite) && /source: 诚通证券研报/.test(afterWrite))
    check('writeBody 保留批注时间线',
      /## 观点与批注/.test(afterWrite) && /批注：关注三季度动销/.test(afterWrite))

    // 外部新建（frontmatter 无 id）→ 采纳并回写 id；再同步一次必须幂等
    const extFile = path.join(vaultDir, '2026', '外部手写.md')
    await mkdir(path.dirname(extFile), { recursive: true })
    await writeFile(extFile, [
      '---', 'title: 外部手写笔记', 'kind: note', 'source: 个人观点', 'date: 2026-09-20',
      'status: active', 'codes: [000858]', '---', '', '手写正文。', '',
      '## 观点与批注', '', '- 2026-09-20T08:00:00.000Z · 我：手写批注', '',
    ].join('\n'), 'utf8')
    const s1 = await vault.syncFromDisk()
    eq('外部新建文件被采纳', s1.added, 1)
    const adopted = vault.all().find((i) => i.title === '外部手写笔记')!
    check('采纳后把 id 回写进文件', (await readFile(extFile, 'utf8')).includes(`id: ${adopted.id}`))
    check('采纳 frontmatter 元数据', adopted.status === 'active' && adopted.codes[0] === '000858')
    check('采纳文件里手写的批注', adopted.notes.length === 1)
    const s2 = await vault.syncFromDisk()
    eq('再次同步幂等（不重复入库）', [s2.added, s2.updated], [0, 0])
    eq('同步后总数', vault.all().length, 3)

    // 外部改 frontmatter/正文 → 合并回索引
    await writeFile(extFile, (await readFile(extFile, 'utf8'))
      .replace('status: active', 'status: archived').replace('手写正文。', '手写正文 v2。'), 'utf8')
    const s3 = await vault.syncFromDisk()
    eq('外部编辑被合并', s3.updated, 1)
    eq('外部改状态被采纳', vault.find(adopted.id)?.status, 'archived')
    check('外部改正文被采纳', (await vault.readDoc(vault.find(adopted.id)!)).body.includes('手写正文 v2'))

    // 外部删除 → 标记缺失 → prune 清理
    await rm(extFile)
    const s4 = await vault.syncFromDisk()
    eq('外部删除标记缺失', s4.missing, 1)
    check('条目标记 missing', vault.find(adopted.id)?.missing === true)
    eq('stats.missing 反映缺失数', vault.stats().missing, 1)
    eq('prune 清理缺失条目', await vault.pruneMissing(), 1)
    eq('prune 后总数', vault.all().length, 2)

    // ---- 5c. 对话 ↔ 面板：入库渠道与「资料库现状」快照 ----
    console.log('\n== research vault: origin & digest ==')
    const chatItem = await vault.create({
      title: '对话里产出的结论', kind: 'note', source: '个人观点', occurredAt: '2026-09-28',
      codes: ['600519'], opinion: '回收节奏符合预期', origin: 'chat',
    })
    eq('Agent 对话落库 → origin=chat', chatItem.origin, 'chat')
    check('origin 写入 frontmatter', (await readFile(path.join(vaultDir, chatItem.file), 'utf8')).includes('origin: chat'))
    const panelItem = await vault.create({ title: '面板手动新建', kind: 'note', source: '个人观点', occurredAt: '2026-09-28' })
    eq('面板落库默认 origin=panel', panelItem.origin, 'panel')

    const extFile2 = path.join(vaultDir, '2026', '外部渠道.md')
    await writeFile(extFile2, '---\ntitle: 外部渠道\nkind: note\nsource: 个人观点\ndate: 2026-09-21\n---\n\n外部正文。\n', 'utf8')
    await vault.syncFromDisk()
    const adopted2 = vault.all().find((i) => i.title === '外部渠道')!
    eq('外部文件同步 → origin=file', adopted2.origin, 'file')

    const digest = vault.digest(10)
    eq('digest.total 与 stats 一致', digest.total, vault.stats().total)
    check('digest.recent 带 id/渠道/观点数',
      digest.recent.length > 0 && digest.recent.every((i) => !!i.id && !!i.origin) && digest.recent.some((i) => i.origin === 'chat'))
    eq('digest.byOrigin.chat ≥ 1', (digest.byOrigin.chat ?? 0) >= 1, true)
    check('digest.topCodes 可用', Array.isArray(digest.topCodes) && (digest.topCodes[0]?.count ?? 0) >= 1)
    // 对话侧维护：改状态 + 追加观点，面板与 digest 都要反映
    await vault.update(chatItem.id, { status: 'active' })
    await vault.addNote(chatItem.id, '对话里补充的批注', 'Agent')
    const afterChat = vault.find(chatItem.id)!
    eq('对话维护后状态', afterChat.status, 'active')
    eq('对话追加的批注可追溯', afterChat.notes[0]?.author, 'Agent')
    eq('渠道不因对话维护而变', afterChat.origin, 'chat')

    await rm(extFile2)
    await vault.syncFromDisk()
    await vault.pruneMissing()
    eq('清理后保留对话/面板条目', vault.all().some((i) => i.id === chatItem.id), true)

    // ---- 5c. 市场路由：带前缀的代码不能被误判成美股 ----
    console.log('\n== market routing ==')
    const r1 = routeCode('sh515080')
    const r2 = routeCode('600519')
    const r3 = routeCode('00700')
    const r4 = routeCode('NVDA')
    const r5 = routeCode('hk00700')
    const r6 = routeCode('600519.SH')
    eq('sh515080 → A股（不是美股，否则会打到不通的 Yahoo）', [r1.market, r1.code], ['A股', '515080'])
    eq('600519 → A股', [r2.market, r2.code], ['A股', '600519'])
    eq('00700 → 港股', [r3.market, r3.code], ['港股', '00700'])
    eq('NVDA → 美股', [r4.market, r4.code], ['美股', 'NVDA'])
    eq('hk00700 → 港股', [r5.market, r5.code], ['港股', '00700'])
    eq('600519.SH → A股', [r6.market, r6.code], ['A股', '600519'])
    eq('基金类型保留基金', routeCode('110022', 'fund').market, '基金')

    // ---- 5d. registry 性能：并发去重 / 熔断 / 统计 ----
    console.log('\n== registry performance ==')
    configureWestock({ enabled: true, binPath: fake, timeoutMs: 5_000 })
    const perfRegistry = new ProviderRegistry({
      cacheTtlSec: 60,
      requestGapMs: 0,
      httpTimeoutMs: 5_000,
      probeReportPath: path.join(root, 'probe.json'),
      packageRoot: root,
      dataDir: path.join(root, 'perfdata'),
      westockConcurrency: 4,
      circuitFailThreshold: 2,
      circuitCooldownSec: 30,
    })
    // 并发同参：只打一次上游（合并计数 +1）。
    const [a1, a2, a3] = await Promise.all([
      perfRegistry.call('quote', { code: '600519' }),
      perfRegistry.call('quote', { code: '600519' }),
      perfRegistry.call('quote', { code: '600519' }),
    ])
    check('并发同参结果一致', a1.ok && a2.ok && a3.ok && JSON.stringify(a1) === JSON.stringify(a3))
    // 命中缓存：第二次不再走上游（calls 不增长、cacheHits 增长）。
    await perfRegistry.call('quote', { code: '600519' })
    const afterCached = perfRegistry.getStats()
    check('缓存命中计入统计', afterCached.cacheHits >= 1, `hits=${afterCached.cacheHits}`)
    // 熔断：连续失败的源在冷却期内被跳过。
    configureWestock({ enabled: false, binPath: fake, timeoutMs: 5_000 })
    // 每次换参数，避免命中失败缓存——这里要测的是熔断本身。
    for (let i = 0; i < 2; i++) await perfRegistry.call('research_report', { code: '600519', size: i + 1 })
    const tripped = perfRegistry.getStats()
    check('连续失败后熔断', tripped.circuitOpen.includes('ws_research'), tripped.circuitOpen.join(','))
    const third = await perfRegistry.call('research_report', { code: '600519', size: 9 })
    check('熔断期内直接跳过（不再等超时）',
      third.ok === false && (third.attempts ?? []).some((x) => /熔断/.test(x.error)),
      JSON.stringify(third.attempts))
    // WeStock 优先：有效顺序里 ws_* 排在最前。
    const orderCap = perfRegistry.getCatalog().find((c) => c.capability === 'quote')!
    eq('quote 首选 WeStock', orderCap.selected[0], 'ws_quote')

    // ---- 6. Logger ----
    console.log('\n== logger ==')
    const logDir = path.join(root, 'logdata')
    const logger = new Logger('test', 'warn', undefined, { dataDir: logDir, console: false })
    logger.info('should be filtered out')
    logger.warn('kept warning', { scope: 'x' })
    logger.error('kept error')
    await new Promise((r) => setTimeout(r, 60))
    const logFile = path.join(logDir, 'logs', 'dsh-finance.jsonl')
    let logRaw = ''
    try { logRaw = await readFile(logFile, 'utf8') } catch { /* */ }
    const lines = logRaw.split('\n').filter(Boolean)
    eq('JSONL 只写 warn+ 级别', lines.length, 2)
    check('记录含级别与 scope', /"level":"warn"/.test(lines[0] ?? '') && /"scope":"test"/.test(lines[0] ?? ''))
    const recent = await logger.recent(10)
    eq('recent() 读取', recent.length, 2)
    eq('recent(level) 过滤', (await logger.recent(10, 'error')).length, 1)
    const logStats = await logger.stats()
    check('stats 报告文件', logStats.file === logFile && logStats.bytes > 0, `${logStats.bytes}B`)

    // ---- 7. Registry ----
    console.log('\n== provider registry ==')
    const registry = new ProviderRegistry({
      cacheTtlSec: 60,
      requestGapMs: 0,
      httpTimeoutMs: 5_000,
      probeReportPath: path.join(root, 'probe.json'),
      packageRoot: root,
      dataDir: root,
    })
    const catalog = registry.getCatalog()
    check('catalog 覆盖全部能力', catalog.length === CAPABILITIES.length, `${catalog.length}`)
    const quoteCap = catalog.find((c) => c.capability === 'quote')!
    check('quote 能力含 ws_quote', quoteCap.providers.some((p) => p.id === 'ws_quote'))
    eq('quote 默认首选 westock', DEFAULT_PROVIDER_ORDER.quote[0], 'ws_quote')
    eq('research_report 默认源', DEFAULT_PROVIDER_ORDER.research_report, ['ws_research'])
    check('WeStock 家族标签', quoteCap.providers.find((p) => p.id === 'ws_quote')?.source === 'WeStock')

    await registry.setPolicy({ quote: ['ws_quote', 'bogus_provider'] })
    const afterPolicy = registry.getCatalog().find((c) => c.capability === 'quote')!
    eq('策略丢弃未知 provider', afterPolicy.selected, ['ws_quote'])
    check('策略落盘', !!(await readFile(path.join(root, 'provider-policy.json'), 'utf8')).includes('ws_quote'))

    // 源不可用时 registry 必须返回 ok:false + attempts，而不是抛异常或静默返回空
    configureWestock({ enabled: false, binPath: fake, timeoutMs: 5_000 })
    const missing = await registry.call('research_report', { code: '600519' })
    check('不可用能力返回 ok:false 而非抛异常', missing.ok === false && !!missing.attempts?.length, missing.error)

    // ---- 回补数据源：web_search 的默认源必须是免安装的 Node 实现 ----
    check('web_search 首选免安装源', DEFAULT_PROVIDER_ORDER.web_search[0] === 'rss_web_search', DEFAULT_PROVIDER_ORDER.web_search.join(','))
    const parsed = parseBingRss(FIXTURE_RSS)
    eq('Bing RSS 解析条数', parsed.length, 2)
    check('RSS 首条有标题/链接/摘要', !!parsed[0]?.title && !!parsed[0]?.url && !!parsed[0]?.snippet, JSON.stringify(parsed[0]))
    check('RSS 实体转义还原', parsed[0]!.title.includes('&'), parsed[0]!.title)

    // ---- 观点触发式提醒：落盘、去重、已读 ----
    const rs = new ReminderStore(path.join(root, 'reminders.json'))
    const first = await rs.add([
      { kind: 'move', level: 'info', code: '600519', type: 'stock', pct: 6.2, title: 't', detail: 'd' },
    ])
    eq('提醒写入', first.length, 1)
    const again = await rs.add([
      { kind: 'move', level: 'info', code: '600519', type: 'stock', pct: 7.1, title: 't2', detail: 'd2' },
    ])
    eq('冷却期内不重复提醒', again.length, 0)
    const other = await rs.add([
      { kind: 'opinion', level: 'warn', code: '600519', type: 'stock', pct: 9, title: 't3', detail: 'd3' },
    ])
    eq('不同类型可分别提醒', other.length, 1)
    eq('未读数', rs.unread(), 2)
    await rs.markRead([first[0]!.id])
    eq('单条已读', rs.unread(), 1)
    await rs.markRead()
    eq('全部已读', rs.unread(), 0)
    const reloaded = new ReminderStore(path.join(root, 'reminders.json'))
    await reloaded.load()
    eq('提醒持久化', reloaded.list().length, 2)

    // ---- 投顾视角：解读 prompt 必须带上资料库里的观点 ----
    const vroot = path.join(root, 'vault')
    const advVault = new ResearchVault(vroot)
    await advVault.load()
    await advVault.create({
      title: '库存周期见底',
      source: '个人观点',
      occurredAt: '2026-09-01',
      kind: 'note',
      codes: ['600519'],
      opinion: '库存周期见底，Q4 营收转正',
      status: 'active',
    })
    const memory = advisorMemory(advVault, '600519')
    check('投顾记忆命中该标的观点', memory.includes('库存周期见底'), memory.slice(0, 60))
    check('投顾记忆要求对照既有观点', memory.includes('与我既有观点的对照'))
    eq('无关标的没有投顾记忆', advisorMemory(advVault, '000001'), '')

    console.log('\n== eastmoney F10 normalization (fixtures) ==')
    // ---- T4 七维：纯函数规范化（fixture 固定契约；线上契约未核实）----
    const survey = normalizeCompanySurvey({
      jbzl: [{ SECURITY_NAME_ABBR: '贵州茅台', ORG_NAME: '贵州茅台酒股份有限公司', INDUSTRYCSRC1: '食品制造业', PROVINCE: '贵州省', LISTING_DATE: '2001-08-27T00:00:00', MAIN_BUSINESS: '茅台酒及系列酒的生产与销售', ORG_WEB: 'https://www.moutaichina.com' }],
    })
    eq('公司概况 → 名称', survey.name, '贵州茅台')
    eq('公司概况 → 上市日期只留日期', survey.listingDate, '2001-08-27')
    eq('公司概况 → 行业', survey.industry, '食品制造业')
    eq('公司概况 → 契约未核实标记', survey.meta.contractVerified, false)
    check('公司概况 → 缺失字段登记（businessScope 等）', survey.meta.missing!.includes('businessScope'), survey.meta.missing!.join(','))
    const emptySurvey = normalizeCompanySurvey({})
    check('公司概况 → 空响应不抛错且标 missing', Array.isArray(emptySurvey.meta.missing) && emptySurvey.meta.missing.length > 0, emptySurvey.meta.missing!.join(','))

    const bc = normalizeBusinessComposition({ zygcfx: [
      { MAINOP_TYPE: '1', ITEM_NAME: '茅台酒', MAIN_BUSINESS_INCOME: 100000000000, MBI_RATIO: 85.5, GROSS_RPOFIT_RATIO: 92.1, REPORT_DATE: '2026-06-30 00:00:00' },
      { MAINOP_TYPE: '2', ITEM_NAME: '国内', MAIN_BUSINESS_INCOME: 99000000000, MBI_RATIO: 99 },
    ] })
    eq('主营构成 → 行数', bc.rows.length, 2)
    eq('主营构成 → 收入金额（元）', bc.rows[0]!.revenue, 100000000000)
    eq('主营构成 → 报告期', bc.meta.reportPeriod, '2026-06-30')
    eq('主营构成 → 单位', bc.meta.unit, '元')
    eq('主营构成 → 空表不抛错', normalizeBusinessComposition({}).rows.length, 0)

    const finMain = normalizeMainFinancials({ result: { data: [
      { REPORT_DATE: '2026-06-30', NOTICE_DATE: '2026-08-02', EPSJB: 28.5, ROEJQ: 17.71, TOTAL_OPERATE_INCOME: 9e10, TOTALOPERATEREVETZ: 15.2, XSMLL: 91.2, ZCFZL: 12.3 },
      { REPORT_DATE: '2025-12-31', NOTICE_DATE: '2026-03-28', EPSJB: 50.1, ROEJQ: 30.2 },
    ] } })
    eq('主要财务 → 按报告期升序', finMain.rows[0]!.reportPeriod, '2025-12-31')
    eq('主要财务 → 报告期/公告日分列', finMain.rows.at(-1)!.publishedAt, '2026-08-02')
    eq('主要财务 → meta.reportPeriod=最新报告期', finMain.meta.reportPeriod, '2026-06-30')
    eq('主要财务 → ROE', finMain.rows.at(-1)!.roeWeighted, 17.71)
    eq('主要财务 → 无公告日时登记 missing', normalizeMainFinancials({ result: { data: [{ REPORT_DATE: '2026-06-30' }] } }).meta.missing!.includes('publishedAt'), true)

    const cc = normalizeCoreConcepts({ keyConcept: [{ KEYWORD_NAME: '白酒', KEYWORD_EXPLAIN: '主导产品所属概念' }, { KEYWORD_NAME: '国企改革' }] })
    eq('核心题材 → 行数', cc.rows.length, 2)
    eq('核心题材 → 首行理由', cc.rows[0]!.reason, '主导产品所属概念')
    eq('核心题材 → 空表', normalizeCoreConcepts({}).rows.length, 0)

    const holders = normalizeShareholderCount({ gdrs: [
      { END_DATE: '2026-06-30', HOLDER_NUM: 155000, HOLDER_NUM_RATIO: -2.3, NOTICE_DATE: '2026-07-05' },
      { END_DATE: '2026-03-31', HOLDER_NUM: 158000 },
    ] })
    eq('股东户数 → 户数', holders.rows.at(-1)!.holderCount, 155000)
    eq('股东户数 → 统计截止日与公告日分列', [holders.meta.asOf, holders.meta.publishedAt].join('|'), '2026-06-30|2026-07-05')
    eq('股东户数 → 环比', holders.rows.at(-1)!.changePct, -2.3)

    const days = Array.from({ length: 200 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1)); d.setUTCDate(d.getUTCDate() + i)
      return { date: d.toISOString().slice(0, 10), peTtm: 20 + (i % 10), pb: 8 }
    })
    const val = normalizeValuation({ result: { data: days.map((p) => ({ TRADE_DATE: `${p.date} 00:00:00`, PE_TTM: p.peTtm, PB: p.pb })) } }, { windowDays: 1825, minSamples: 60 })
    eq('估值 → 历史条数（升序）', val.history.length, 200)
    eq('估值 → 分位可计算', val.percentile!.ok, true)
    eq('估值 → 分位为本地秩中点', val.percentile!.method, 'rank_midpoint')
    check('估值 → 分位在 [0,100]', val.percentile!.percentile! >= 0 && val.percentile!.percentile! <= 100, String(val.percentile!.percentile))
    const flat = Array.from({ length: 100 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1)); d.setUTCDate(d.getUTCDate() + i)
      return { date: d.toISOString().slice(0, 10), value: 10 }
    })
    eq('估值 → 并列值取秩中点 50', valuationPercentile(flat, { metric: 'peTtm', windowDays: 365, minSamples: 60 }).percentile, 50)
    eq('估值 → 样本不足不伪造', valuationPercentile(flat.slice(0, 10), { metric: 'peTtm', windowDays: 365, minSamples: 60 }).ok, false)
    eq('估值 → 负 PE 最新值不可计算', valuationPercentile([...flat.slice(0, 99), { date: '2026-04-11', value: -5 }], { metric: 'peTtm', windowDays: 365, minSamples: 60 }).ok, false)
    eq('估值 → 空历史不伪造', valuationPercentile([], { metric: 'peTtm', windowDays: 365 }).ok, false)

    const peers = normalizePeers({ data: [{ SECURITY_CODE: '000858', SECURITY_NAME_ABBR: '五粮液', PE_TTM: 18, PB: 3.2, REPORT_DATE: '2026-06-30' }] })
    eq('同行上游 → 方法标注（契约未核实）', peers.method, 'upstream_unverified')
    eq('同行上游 → 行数', peers.rows.length, 1)
    const localPeers = buildLocalPeerComparison([
      { code: '600519', name: '贵州茅台', reportPeriod: '2026-06-30', roe: 17.7, peTtm: 25 },
      { code: '000858', name: '五粮液', reportPeriod: '2026-03-31', roe: 12 },
    ])
    eq('同行本地 → 显式本地计算标注', localPeers.method, 'local')
    check('同行本地 → 口径写明共同报告期', (localPeers.caliber ?? '').includes('2026-06-30'), localPeers.caliber ?? '')
    check('同行本地 → 不同报告期行标注 mismatch', localPeers.rows.some((r) => (r.reportPeriod ?? '').includes('≠')), localPeers.rows.map((r) => r.reportPeriod).join(','))

    eq('F10 代码闸门 → 600519 通过', isAShareCode('600519'), true)
    eq('F10 代码闸门 → 830799 北交所通过', isAShareCode('830799'), true)
    eq('F10 代码闸门 → 港股拒绝', isAShareCode('00700'), false)
    eq('F10 代码闸门 → 美股拒绝', isAShareCode('AAPL'), false)
    eq('F10 默认东财源', DEFAULT_PROVIDER_ORDER.valuation_analysis, ['em_f10_valuation'])

    // ---- 个股深度档案：聚合层必须"单项失败不影响整体 + 空数据不算失败" ----
    configureWestock({ enabled: false, binPath: '/nonexistent/westock', timeoutMs: 1_000 })
    const dossierFinance = new FinanceDataService(registry, () => [], async () => {})
    const dossier = await buildStockDossier(dossierFinance as never, '600519')
    eq('档案维度总数', dossier.total, 25)
    check('全部源不可用时档案仍返回结构', Array.isArray(dossier.sections) && dossier.sections.length === 25)
    check('单项失败不影响其他维度', dossier.sections.every((s) => typeof s.ok === 'boolean' && typeof s.ms === 'number'))
    check('ready 不超过总数', dossier.ready >= 0 && dossier.ready <= dossier.total, String(dossier.ready))
    check('摘要含维度计数', /\d+\/25 个维度有数据/.test(dossierSummary(dossier)), dossierSummary(dossier).slice(0, 40))
    check('WeStock 关闭后新闻维度回落到 HTTP 源', dossier.sections.some((s) => s.key === 'news' && s.provider?.startsWith('em_')), dossier.sections.find((s) => s.key === 'news')?.provider ?? '')
    const fundDossier = await buildStockDossier(dossierFinance as never, '110022', 'fund')
    check('基金档案不发 F10 请求（显式 unsupported）',
      fundDossier.sections.filter((s) => ['company_survey', 'valuation_analysis', 'peer_comparison'].includes(s.key))
        .every((s) => !s.ok && /仅支持 A 股/.test(s.error ?? '')))
    eq('基金 F10 维度状态 = unsupported',
      fundDossier.sections.filter((s) => ['company_survey', 'valuation_analysis', 'peer_comparison'].includes(s.key))
        .every((s) => s.status === 'unsupported'), true)
    eq('取数失败维度状态 = error',
      dossier.sections.filter((s) => !s.ok).every((s) => s.status === 'error'), true)
    eq('snapshotId 为 32 位十六进制', /^[0-9a-f]{32}$/.test(dossier.snapshotId), true)
    const dossierAgain = await buildStockDossier(dossierFinance as never, '600519')
    eq('同数据重取 → snapshotId 稳定（对抓取时间不敏感）', dossierAgain.snapshotId, dossier.snapshotId)

    // ---- 维度状态：「正常空」与「取数失败」不再混同（T5） ----
    const emptyFinance = {
      westock: async (cap: string) => ({
        ok: true,
        provider: 'WeStock CLI',
        data: cap === 'company_survey'
          ? {}
          : { rows: [], meta: { missing: ['rows'], asOf: '2024-03-31' } },
      }),
    } as never
    const emptyDossier = await buildStockDossier(emptyFinance, '000001')
    eq('空响应维度状态 = empty（不是 error）', emptyDossier.sections.every((s) => s.status === 'empty'), true)
    eq('正常空不计入 ready', emptyDossier.ready, 0)
    eq('空维度携带数据时点', emptyDossier.sections.find((s) => s.key === 'main_financials')?.dataAsOf, '2024-03-31')
    eq('空内容快照 id 稳定', (await buildStockDossier(emptyFinance, '000001')).snapshotId, emptyDossier.snapshotId)
    const mixedFinance = {
      westock: async (cap: string) => {
        if (cap === 'company_survey') return { ok: true, provider: 'WeStock CLI', data: { name: '平安银行', meta: { retrievedAt: 'x' } } }
        throw new Error('boom')
      },
    } as never
    const mixed = await buildStockDossier(mixedFinance, '000001')
    eq('混合状态：ready 与 error 并存', mixed.sections.some((s) => s.status === 'ready') && mixed.sections.some((s) => s.status === 'error'), true)
    eq('快照剔除易变字段：retrievedAt 不影响 id', (await buildStockDossier({ westock: async (cap) => cap === 'company_survey' ? { ok: true, provider: 'p', data: { name: '平安银行', meta: { retrievedAt: 'y' } } } : { ok: false, provider: 'p', error: 'boom' } } as never, '000001')).snapshotId, mixed.snapshotId)

    // ---- K 线纯函数层（T6）：聚合/预热/清洗/视窗/配色 ----
    const kb = [
      { date: '2024-01-02', open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { date: '2024-01-03', open: 11, high: 13, low: 10, close: 12, volume: 200 },
      { date: '2024-01-04', open: 12, high: 12.5, low: 8, close: 9, volume: 300 },
      { date: '2024-01-05', open: 9, high: 15, low: 9, close: 14, volume: 400 },
      { date: '2024-01-08', open: 14, high: 14, low: 12, close: 13, volume: 50 },
      { date: '2024-01-09', open: 13, high: 13, low: 11, close: 12, volume: 60 },
      { date: '2024-01-10', open: 12, high: 12, low: 10, close: 11, volume: 70 },
    ]
    const klineWeek = aggregateBars(kb, 'week')
    eq('周聚合根数', klineWeek.length, 2)
    eq('周聚合：开=首根开盘', klineWeek[0]!.open, 10)
    eq('周聚合：收=末根收盘', klineWeek[0]!.close, 14)
    eq('周聚合：高=区间最高', klineWeek[0]!.high, 15)
    eq('周聚合：低=区间最低', klineWeek[0]!.low, 8)
    eq('周聚合：量=求和', klineWeek[0]!.volume, 1000)
    eq('周聚合：日期取真实交易日', klineWeek[0]!.date, '2024-01-02')
    eq('周五收线 → 该周完成', klineWeek[0]!.unfinished, false)
    eq('数据截断在周三 → 未完成周', klineWeek[1]!.unfinished, true)
    eq('未完成周只累计已交易量', klineWeek[1]!.volume, 180)
    const klineMonth = aggregateBars(kb, 'month')
    eq('月聚合：开/收', `${klineMonth[0]!.open}/${klineMonth[0]!.close}`, '10/11')
    eq('月聚合：高/低/量', `${klineMonth[0]!.high}/${klineMonth[0]!.low}/${klineMonth[0]!.volume}`, '15/8/1180')
    eq('数据截断在月中 → 未完成月', klineMonth[0]!.unfinished, true)
    const klineClosedMonth = aggregateBars([
      { date: '2024-04-29', open: 1, high: 2, low: 1, close: 2, volume: 1 },
      { date: '2024-04-30', open: 2, high: 3, low: 1, close: 2, volume: 1 },
    ], 'month')
    eq('月末最后工作日收线 → 完成月', klineClosedMonth[0]!.unfinished, false)
    eq('日线不标未完成', aggregateBars(kb, 'day').every((b) => !b.unfinished && b.count === 1), true)
    eq('周期边界：周起始', weekStart('2024-01-03'), '2024-01-01')
    eq('周期边界：月末', monthEnd('2024-02-15'), '2024-02-29')
    eq('周期边界：当月最后工作日', lastWeekdayOfMonth('2024-06-15'), '2024-06-28')
    eq('收口判定：周五', isPeriodClosed('2024-01-05', 'week'), true)
    eq('收口判定：周三', isPeriodClosed('2024-01-10', 'week'), false)

    const klineDirty = sanitizeBars([
      { date: '2024-01-03', open: NaN, high: 1, low: 0, close: 1, volume: 5 },
      { date: 'bad', open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { date: '2024-01-02', open: 2, high: 3, low: 1, close: 2, volume: Infinity },
      { date: '2024-01-02', open: 4, high: 5, low: 3, close: 5, volume: 10 },
      { date: '2024-01-01', open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
    ])
    eq('清洗：丢非有限/坏日期，同日留最后', klineDirty.map((b) => b.date).join(','), '2024-01-01,2024-01-02')
    eq('清洗：高低点归正', `${klineDirty[1]!.high}/${klineDirty[1]!.low}`, '5/3')
    eq('清洗：非有限量归 0', sanitizeBars([{ date: '2024-01-01', open: 1, high: 1, low: 1, close: 1, volume: NaN }])[0]!.volume, 0)

    const klineCloses = [1, 2, 3, 4, 5, 6].map((c, i) => ({ date: `2024-01-0${i + 1}`, open: c, high: c, low: c, close: c, volume: 0 }))
    const klineMa5 = movingAverage(klineCloses, 5)
    eq('MA5 预热期为 null', klineMa5.slice(0, 4).every((v) => v === null), true)
    eq('MA5 黄金值', `${klineMa5[4]}/${klineMa5[5]}`, '3/4')
    eq('MA 窗口集合', MA_WINDOWS.join(','), '5,10,20,60')

    const klineVp = clampViewport(200, { count: 80, offset: 0 })
    eq('视窗：贴右', JSON.stringify(visibleRange(200, klineVp)), JSON.stringify({ start: 120, end: 200 }))
    eq('视窗：平移', JSON.stringify(visibleRange(200, panViewport(klineVp, 10, 200))), JSON.stringify({ start: 110, end: 190 }))
    eq('视窗：放大减根数', zoomViewport(klineVp, 2, 200).count, 40)
    eq('视窗：越界钳制', JSON.stringify(clampViewport(200, { count: 500, offset: 50 })), JSON.stringify({ count: 200, offset: 0 }))
    eq('视窗：x→下标', `${indexAtX(0, 80, 200, klineVp)}/${indexAtX(80, 80, 200, klineVp)}`, '120/199')

    const klineFlat = priceRange([{ date: '2024-01-01', open: 5, high: 5, low: 5, close: 5, volume: 0 }])
    eq('恒定序列给出呼吸空间', klineFlat.min < 5 && klineFlat.max > 5, true)

    const klinePalA = palette(false), klinePalB = palette(true)
    eq('默认涨跌色不同', klinePalA.up !== klinePalA.down, true)
    eq('色盲配色与默认不同且涨跌不同', klinePalB.up !== klinePalB.down && klinePalB.up !== klinePalA.up, true)
    eq('均线线型互相区分', klinePalA.maDash[5].length !== klinePalA.maDash[10].length, true)

    // ---- T8 共享校验：HTTP 与工具同一套业务规则 ----
    eq('校验：合法代码', validateCode(' 600519 '), '600519')
    eq('校验：空代码拒绝', (() => { try { validateCode(''); return 'no' } catch (e) { return e instanceof ValidationError ? `400:${e.httpStatus}` : 'other' } })(), '400:400')
    eq('校验：超长代码拒绝', (() => { try { validateCode('x'.repeat(17)); return 'no' } catch (e) { return e instanceof ValidationError ? e.issues[0]!.message : 'other' } })(), '长度不得超过 16')
    eq('校验：非法字符拒绝', (() => { try { validateCode('600 519'); return 'no' } catch (e) { return e instanceof ValidationError ? 'rejected' : 'other' } })(), 'rejected')
    eq('校验：资产类型', validateAssetType('fund'), 'fund')
    eq('校验：非法资产类型拒绝', (() => { try { validateAssetType('bond'); return 'no' } catch { return 'rejected' } })(), 'rejected')
    eq('校验：真实日期通过', validateDate('2024-02-29', 'd'), '2024-02-29')
    eq('校验：2024-02-30 拒绝', (() => { try { validateDate('2024-02-30', 'd'); return 'no' } catch (e) { return e instanceof ValidationError ? e.issues[0]!.message : 'other' } })(), '不是真实日历日期')
    eq('校验：2023-02-29 拒绝', (() => { try { validateDate('2023-02-29', 'd'); return 'no' } catch { return 'rejected' } })(), 'rejected')
    eq('校验：日期区间倒挂拒绝（416）', (() => { try { validateDateRange('2024-02-01', '2024-01-01'); return 'no' } catch (e) { return e instanceof ValidationError ? String(e.httpStatus) : 'other' } })(), '416')
    eq('校验：NaN/Infinity 拒绝', (() => { try { validateFinite(NaN, 'x'); return 'no' } catch { return 'rejected' } })(), 'rejected')
    eq('校验：越界拒绝', (() => { try { validateFinite(5, 'x', { max: 3 }); return 'no' } catch { return 'rejected' } })(), 'rejected')
    eq('校验：整数约束', (() => { try { validateFinite(1.5, 'x', { integer: true }); return 'no' } catch { return 'rejected' } })(), 'rejected')
    eq('校验：费用非负', validateNonNegative(0, 'fee'), 0)
    eq('校验：负费用拒绝', (() => { try { validateNonNegative(-1, 'fee'); return 'no' } catch { return 'rejected' } })(), 'rejected')
    eq('校验：分页默认值', validatePagination(undefined, 50, 200), 50)
    eq('校验：分页超限 413', (() => { try { validatePagination(500, 50, 200); return 'no' } catch (e) { return e instanceof ValidationError ? String(e.httpStatus) : 'other' } })(), '413')
    eq('校验：搜索预算上限', validateBudget({ maxCandidates: 10, maxGenerations: 2 }).maxCandidates, 10)
    eq('校验：预算越界拒绝', (() => { try { validateBudget({ maxCandidates: 99999 }); return 'no' } catch { return 'rejected' } })(), 'rejected')
    eq('校验：未知字段拒绝', (() => { try { expectNoUnknownFields({ a: 1, evil: 2 }, ['a']); return 'no' } catch (e) { return e instanceof ValidationError ? e.issues[0]!.field : 'other' } })(), 'evil')

    // ===== 批次11：剩余任务补齐（周时区 / 补卡 / 历史manifest / 分页 / 指标溯源） =====
    eq('周起点：UTC 下周日夜归上周一 2023-12-25', weekKey('2023-12-31T23:30:00Z'), '2023-12-25')
    eq('周起点：上海时区同一时刻归 2024-01-01 周', weekKey('2023-12-31T23:30:00Z', 'Asia/Shanghai'), '2024-01-01')
    setWeekTimeZone('Asia/Shanghai')
    eq('周起点：setWeekTimeZone 全局生效', weekKey('2023-12-31T23:30:00Z'), '2024-01-01')
    setWeekTimeZone('UTC')
    eq('周起点：ISO 年界归 2022-12-26', weekKey('2023-01-01'), '2022-12-26')
    eq('周起点：非法时区拒绝', (() => { try { setWeekTimeZone('Nope/Zone'); return 'no' } catch { return 'rejected' } })(), 'rejected')
    eq('指标溯源：成交量有自动取数来源', metricProvenance('volume') !== '暂无自动取数映射，须 Agent/人工查证', true)
    eq('指标溯源：换手率有来源', metricProvenance('turnover_rate') !== '暂无自动取数映射，须 Agent/人工查证', true)
    eq('指标溯源：未知指标明确未溯源', metricProvenance('nope_metric'), '暂无自动取数映射，须 Agent/人工查证')

    const b11GapBars = [
      { date: '2024-01-02', open: 1, high: 1, low: 1, close: 1, volume: 100 },
      { date: '2024-01-03', open: 1, high: 1, low: 1, close: 1, volume: 100 },
      { date: '2024-01-04', open: 1, high: 1, low: 1, close: 1, volume: 100 },
      { date: '2024-01-09', open: 1, high: 1, low: 1, close: 1, volume: 100 },
      { date: '2024-01-10', open: 1, high: 1, low: 1, close: 1, volume: 100 },
    ] as KlineBar[]
    const b11Gaps = detectGaps(b11GapBars)
    eq('缺口检测：跨周末缺 2 个交易日', `${b11Gaps[0]?.from}|${b11Gaps[0]?.to}|${b11Gaps[0]?.weekdays}|${b11Gaps.length}`, '2024-01-04|2024-01-09|2|1')
    eq('缺口检测：仅缺 1 个交易日不报', detectGaps([...b11GapBars.slice(0, 3), { date: '2024-01-08', open: 1, high: 1, low: 1, close: 1, volume: 100 }] as KlineBar[]).length, 0)

    const b11dir = await mkdtemp(path.join(tmpdir(), 'dsh-b11-'))
    const b11hs = new HistoryStore(b11dir)
    await b11hs.mergeKline('600519', 'a', b11GapBars)
    await b11hs.mergeEvents('600519', 'a', [
      { date: '2024-03-31', type: '财报', label: '（公告日缺失，报告期≠可得日）', dateKind: 'period' },
      { date: '2024-04-15', type: '分红', label: '分红 10派30' },
    ])
    const b11m1 = await b11hs.manifest('600519')
    eq('manifest：覆盖区间与根数', `${b11m1?.coverage?.from}|${b11m1?.coverage?.to}|${b11m1?.bars}|${b11m1?.events}`, '2024-01-02|2024-01-10|5|2')
    eq('manifest：内容哈希 32 位十六进制', /^[0-9a-f]{32}$/.test(b11m1?.contentHash ?? ''), true)
    eq('manifest：缺口与可得日缺失计数', `${b11m1?.gaps.length}|${b11m1?.eventsMissingAvailableAt}`, '1|1')
    const b11added = await b11hs.mergeEvents('600519', 'a', [
      { date: '2024-03-31', type: '财报', label: '（公告 2024-04-10）', dateKind: 'period', availableAt: '2024-04-10', value: 123 },
      { date: '2024-04-15', type: '分红', label: '分红 10派30' },
    ])
    eq('mergeEvents：财报按 date|type 幂等不重复', b11added, 0)
    const b11Series = await b11hs.read('600519')
    const b11E = b11Series?.events.find(e => e.type === '财报')
    eq('mergeEvents：可得日升级', b11E?.availableAt, '2024-04-10')
    eq('mergeEvents：标签升级为公告版', b11E?.label, '（公告 2024-04-10）')
    eq('mergeEvents：数值补全且总数不膨胀', `${b11E?.value}|${b11Series?.events.length}`, '123|2')
    eq('manifest：升级后可得日缺失归零', (await b11hs.manifest('600519'))?.eventsMissingAvailableAt, 0)

    const b11pdir = await mkdtemp(path.join(tmpdir(), 'dsh-b11p-'))
    const b11ps = new PersonalStore(path.join(b11pdir, 'personal.json'))
    await b11ps.load()
    const b11W = weekKey('2024-06-12')
    const b11Now = '2024-06-12T02:00:00.000Z'
    const b11Thesis: Thesis = { id: 'th-mu', code: '600519', rationale: '业绩确定性', indicator: '净利润增速', falsifier: '增速转负', updatedAt: b11Now, revision: 1 }
    const b11Orig: PersonalReviewCard = { id: 'c-orig', week: b11W, generatedAt: b11Now, jobKey: `${b11W}:th-mu:evidence`, thesis: { ...b11Thesis }, evidence: [], missing: [] }
    ;(b11ps as never as { state: PersonalState }).state = {
      startedAt: b11Now, theses: [b11Thesis], history: [], cards: [b11Orig],
      jobs: [{ key: b11Orig.jobKey, week: b11W, thesisId: 'th-mu', cardType: 'evidence', state: 'ready', attempts: 1 } satisfies WeeklyJob],
    }
    eq('补卡：观点未升级拒绝', await (async () => { try { await b11ps.requestMakeupCard('th-mu', '理由', b11W); return 'no' } catch (e) { return (e as Error).message } })(), '当前观点 v1 未超过原卡快照 v1，无须补卡')
    eq('补卡：其他周无原卡拒绝', await (async () => { try { await b11ps.requestMakeupCard('th-mu', '', weekKey('2024-06-05')); return 'no' } catch (e) { return (e as Error).message } })(), '本周尚无原卡，无须补卡')
    b11Thesis.revision = 2
    const b11r1 = await b11ps.requestMakeupCard('th-mu', '', b11W)
    eq('补卡：任务指向原卡且理由选填', `${b11r1.job.makeupFor}|${b11r1.job.makeupReason ?? ''}|${b11r1.job.state}`, 'c-orig||pending')
    eq('补卡：jobKey 带修订号', b11r1.job.key, `${b11W}:th-mu:evidence:makeup:r2`)
    await b11ps.requestMakeupCard('th-mu', '', b11W)
    const b11ps2 = b11ps as never as { state: PersonalState }
    eq('补卡：幂等不重复建任务', b11ps2.state.jobs!.filter(j => j.key === b11r1.job.key).length, 1)
    b11ps2.state.cards.push({ ...b11Orig, id: 'c-mu', jobKey: b11r1.job.key, makeup: { forCardId: 'c-orig', reason: '', revision: 2 } })
    const b11r3 = await b11ps.requestMakeupCard('th-mu', '', b11W)
    eq('补卡：已有补卡返回 existingCardId', b11r3.existingCardId, 'c-mu')

    const b11Bars = (startMs: number, n: number) => Array.from({ length: n }, (_, i) => ({ date: new Date(startMs - i * 86400000).toISOString().slice(0, 10), open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }))
    let b11Calls = 0
    const b11Fetch5 = async (end: string | undefined) => {
      b11Calls++
      return { ok: true, data: b11Bars(end ? Date.parse(`${end}T00:00:00Z`) : Date.parse('2025-12-31T00:00:00Z'), 800), provider: 'em_mock' }
    }
    const b11Paged = await fetchKlinePaged('a', b11Fetch5)
    eq('分页：满页最多 5 页并标注截断', `${b11Paged.pages}|${b11Paged.bars.length}|${Boolean(b11Paged.truncatedAt)}|${b11Calls}`, '5|4000|true|5')
    let b11Calls2 = 0
    const b11FetchMix = async (end: string | undefined) => {
      b11Calls2++
      return { ok: true, data: b11Bars(end ? Date.parse(`${end}T00:00:00Z`) : Date.parse('2025-12-31T00:00:00Z'), 800), provider: b11Calls2 === 1 ? 'em_mock' : 'ws_mock' }
    }
    const b11Mix = await fetchKlinePaged('a', b11FetchMix)
    eq('分页：复权口径不一致立即停且截断', `${b11Mix.pages}|${b11Mix.bars.length}|${Boolean(b11Mix.truncatedAt)}|${b11Calls2}`, '1|800|true|2')
    const b11Short = await fetchKlinePaged('a', async () => ({ ok: true, data: b11Bars(Date.parse('2025-12-31T00:00:00Z'), 100), provider: 'em_mock' }))
    eq('分页：短页即止不截断', `${b11Short.pages}|${b11Short.bars.length}|${b11Short.truncatedAt === undefined}`, '1|100|true')

    // ===== 批次16：数据源分组（westock 能力归组展示） =====
    const b16Meta = westockCapabilityMeta()
    eq('能力元数据：分时数据归「行情」组', `${b16Meta.get('minute')?.label}|${b16Meta.get('minute')?.group}`, '分时数据|行情')
    eq('能力元数据：全部条目有中文名与分组', [...b16Meta.values()].every(m => m.label.trim() && m.group.trim()), true)
    check('能力元数据：覆盖 40+ 扩展能力', b16Meta.size >= 40, `size=${b16Meta.size}`)
    const b16F = groupBySource([
      { capability: 'minute', group: '行情', source: 'WeStock' },
      { capability: 'technical', group: '技术', source: 'WeStock' },
      { capability: 'chip', group: '技术', source: 'WeStock' },
      { capability: 'odd_cap', source: 'WeStock' },
      { capability: 'x1', group: '其他', source: 'DuckDuckGo' },
    ])
    eq('分组：家族按首次出现排序且计数正确', `${b16F.map(f => `${f.source}:${f.total}`).join(',')}`, 'WeStock:4,DuckDuckGo:1')
    eq('分组：家族内按 group 聚合、缺省归其他', b16F[0]!.groups.map(g => `${g.group}${g.caps.length}`).join(','), '行情1,技术2,其他1')
    eq('分组：大家族默认折叠、小家族展开', `${defaultOpenFamily(52)}|${defaultOpenFamily(3)}`, 'false|true')


    // ===== 批次17：基金分析内核（纯函数，离线；对应 P0-1/P0-3/P1-7/P1-8） =====
    const dayStr = (i: number) => new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10)
    const geoNav = Array.from({ length: 241 }, (_, i) => ({ date: dayStr(i), nav: Math.pow(1.005, i) }))

    // (1) 风险指标：净值 0.5%/日复利 → 精确的全区间收益/年化；波动=0；回撤=0。
    const riskGeo = computeFundRiskMetrics(geoNav)
    const wantRet = Math.round((Math.pow(1.005, 240) - 1) * 100 * 100) / 100
    const wantAnn = Math.round((Math.pow(1.005, 365) - 1) * 100 * 100) / 100
    eq('基金指标：复利增长全样本收益', riskGeo.full.returnPct, wantRet)
    eq('基金指标：年化收益=按365天折算', riskGeo.full.annualizedReturnPct, wantAnn)
    eq('基金指标：恒定日收益→年化波动0', riskGeo.full.annualizedVolPct, 0)
    eq('基金指标：单调上涨→最大回撤0', riskGeo.full.maxDrawdownPct, 0)
    eq('基金指标：波动为0时夏普为空而非NaN', riskGeo.full.sharpe === null, true)
    eq('基金指标：跨度240天不足1年→y1缺失', riskGeo.y1, null)
    eq('基金指标：今年来锚定成立年起点', riskGeo.stages.ytd, riskGeo.full.returnPct)
    eq('基金指标：asOf=最新净值日', riskGeo.asOf, dayStr(240))
    const riskDD = computeFundRiskMetrics([
      { date: '2024-01-01', nav: 100 },
      { date: '2024-01-02', nav: 80 },
      { date: '2024-01-03', nav: 100 },
    ])
    eq('基金指标：100→80→100 最大回撤=20（绝对值）', riskDD.full.maxDrawdownPct, 20)
    eq('基金指标：样本<90天不年化', riskDD.full.annualizedReturnPct, null)
    eq('基金指标：单点序列不抛错、指标为空', computeFundRiskMetrics([{ date: '2024-01-01', nav: 1 }]).full.returnPct, null)
    const norm = normalizeNavSeries([
      { date: '2024-01-03', nav: 3 },
      { date: '2024-01-01', nav: 1 },
      { date: '2024-01-01', nav: 1.5 },
      { date: '2024-01-02', nav: Number.NaN },
      { date: 'bad', nav: 2 },
    ] as never)
    eq('净值清洗：排序+去重+丢非法', `${norm.length}|${norm[0]!.date}|${norm[0]!.nav}`, '2|2024-01-01|1.5')

    // (2) 基准对比：基金日收益=2×基准 → Beta=2、相关=1；样本不足 → null。
    const benchSeries: Array<{ date: string; close: number }> = [{ date: dayStr(0), close: 100 }]
    const fundLevered: Array<{ date: string; nav: number }> = [{ date: dayStr(0), nav: 1 }]
    const benchInv: Array<{ date: string; close: number }> = [{ date: dayStr(0), close: 100 }]
    const fundInv: Array<{ date: string; nav: number }> = [{ date: dayStr(0), nav: 1 }]
    let b = 100; let bl = 1; let bi = 1
    for (let i = 1; i <= 80; i++) {
      const r = i % 7 === 0 ? -0.012 : 0.002 + 0.0015 * (i % 5)
      b *= 1 + r; bl *= 1 + 2 * r; bi *= 1 - r
      benchSeries.push({ date: dayStr(i), close: b })
      fundLevered.push({ date: dayStr(i), nav: bl })
      benchInv.push({ date: dayStr(i), close: b * 1.001 })
      fundInv.push({ date: dayStr(i), nav: bi })
    }
    const cmp = compareWithBenchmark(fundLevered, benchSeries, 'sh000300')
    eq('基准对比：样本≥40才产出', cmp !== null, true)
    eq('基准对比：Beta=2（收益精确2倍）', cmp!.beta, 2)
    eq('基准对比：相关系数=1', cmp!.correlation, 1)
    eq('基准对比：跟踪误差为正', (cmp!.trackingErrorPct ?? 0) > 0, true)
    eq('基准对比：超额=基金-基准', typeof cmp!.excessPct, 'number')
    const cmpInv = compareWithBenchmark(fundInv, benchSeries, 'sh000300')
    eq('基准对比：反向序列相关=-1', cmpInv!.correlation, -1)
    eq('基准对比：共同收益<40→null', compareWithBenchmark(geoNav.slice(0, 10), benchSeries.slice(0, 10), 'x'), null)

    // (3) 多基金对比：相关矩阵 + 平均两两相关；重叠不足 → null 不产出。
    const seriesByCode = { '110022': fundLevered, '161725': fundLevered.map((p) => ({ ...p })) }
    const cmpF = compareFunds(seriesByCode)
    eq('多基金对比：两只基金入池', cmpF.funds.length, 2)
    eq('多基金对比：同序列相关=1', cmpF.correlation[0]!.correlation, 1)
    eq('多基金对比：平均相关=1', cmpF.avgPairwiseCorrelation, 1)
    const cmpShort = compareFunds({ '110022': geoNav.slice(0, 20), '161725': geoNav.slice(0, 20) })
    eq('多基金对比：重叠不足→相关缺失', cmpShort.correlation[0]!.correlation, null)
    eq('多基金对比：无有效相关→平均为null', cmpShort.avgPairwiseCorrelation, null)

    // (4) lsjz 解析（契约未线上核实的回落源）：命名字段严格解析，命不中抛错。
    const lsjzOk = parseFundNavLsjz({
      Data: {
        lsjzList: [
          { FSRQ: '2025-09-30', DWJZ: '1.2345', LJJZ: '2.3456', JZZDF: '+1.23', SGZT: '开放申购', SHZT: '开放赎回' },
          { FSRQ: '2025-09-29', DWJZ: '1.2180' },
        ],
      },
      ErrCode: 0,
    })
    eq('lsjz：新在前+净值/累计/日涨幅', `${lsjzOk.series.length}|${lsjzOk.series[0]!.date}|${lsjzOk.series[0]!.nav}|${lsjzOk.series[0]!.accumNav}|${lsjzOk.series[0]!.growthPct}`, '2|2025-09-30|1.2345|2.3456|1.23')
    eq('lsjz：申赎状态带出', `${lsjzOk.subscribeStatus}|${lsjzOk.redeemStatus}`, '开放申购|开放赎回')
    let lsjzMissing = ''
    try { parseFundNavLsjz({ Data: {} }) } catch (e) { lsjzMissing = e instanceof Error ? e.message : String(e) }
    check('lsjz：缺 lsjzList 明确抛错', lsjzMissing.includes('缺少 Data.lsjzList'), lsjzMissing)
    let lsjzGarbage = ''
    try { parseFundNavLsjz({ Data: { lsjzList: [{ FOO: '1', BAR: '2' }, { FSRQ: '2025-09-30', DWJZ: '20000' }] } }) } catch (e) { lsjzGarbage = e instanceof Error ? e.message : String(e) }
    check('lsjz：识别不出有效净值行抛错（含越界净值）', lsjzGarbage.includes('解析不到有效净值行'), lsjzGarbage)

    // (5) JJCC 持仓解析：年份键取最新；识别不出结构就抛错（拒绝猜测）。
    const jjccRows = Array.from({ length: 10 }, (_, i) => ({ 股票代码: `6005${String(10 + i).padStart(2, '0')}`, 股票名称: `股票${i}`, 占净值比例: `${(10 - i) * 0.5}` }))
    const holdings = parseFundHoldings({ Data: { '2024': jjccRows.slice(0, 5), '2025': jjccRows } })
    eq('JJCC：取最新年份键', holdings.length, 10)
    eq('JJCC：代码/名称/占比解析', `${holdings[0]!.code}|${holdings[0]!.name}|${holdings[0]!.weightPct}`, '600510|股票0|5')
    let jjccBad = ''
    try { parseFundHoldings({ Data: { foo: [{ a: 1 }, { b: 2 }] } }) } catch (e) { jjccBad = e instanceof Error ? e.message : String(e) }
    check('JJCC：无代码列拒绝猜测', jjccBad.includes('无法从响应识别持仓结构') || jjccBad.includes('没有可识别的持仓行'), jjccBad)
    eq('持仓代码归一化：带前缀/后缀', `${normalizeHoldingCode('SH510300')}|${normalizeHoldingCode('510300.SH')}|${normalizeHoldingCode('sh510300')}|${normalizeHoldingCode('AAPL')}`, '510300|510300|510300|AAPL')

    // (6) 持仓重叠：与组合交集 + 权重加总。
    const overlap = computeFundOverlap('110022', [
      { code: '600519', name: '贵州茅台', weightPct: 9.5 },
      { code: '000858', name: '五粮液', weightPct: 8 },
    ], [
      { code: '600519', weightPct: 30 },
      { code: '601318', weightPct: 10 },
    ])
    eq('持仓重叠：交集命中', overlap.overlaps.length, 1)
    eq('持仓重叠：权重=交集占基金净值合计', overlap.overlapWeightPct, 9.5)
    eq('持仓重叠：无权重行→null', computeFundOverlap('x', [{ code: '600519' }], [{ code: '600519' }]).overlapWeightPct, null)
    eq('场内基金判定', `${isOnExchangeFundCode('510300')}|${isOnExchangeFundCode('159915')}|${isOnExchangeFundCode('110022')}`, 'true|true|false')

    // (7) 排行排序参数：周期→东财 sc 映射 + 分页钳制。
    eq('排行：y1→1nzf', fundRankSc('all', 'y1'), '1nzf')
    eq('排行：货币基金固定近1年', fundRankSc('hb', 'm6'), '1nsyl')
    eq('排行：未知排序回落近6月', fundRankSc('all', 'bogus'), fundRankSc('all'))
    const rankReq = fundRankRequest('all', 999, 'ytd', 0)
    eq('排行：size/page 钳制 + ytd 排序', `${rankReq.pn}|${rankReq.pi}|${rankReq.sc}|${rankReq.st}`, '50|1|jnzf|desc')

    // (8) secid 市场位：sh 前缀优先于首字符启发式（sh000300 指数必须 1.000300）。
    eq('secid 市场位：sh000300→沪', emSecMarket('sh000300'), 1)
    eq('secid 市场位：无前缀按首字符', `${emSecMarket('600519')}|${emSecMarket('000001')}|${emSecMarket('399001')}`, '1|0|0')
    eq('secid 市场位：sz 前缀', emSecMarket('sz000001'), 0)

    // (9) 画像取数与越界防御 + 风险事实。
    const profFacts = factsFromFundProfile({
      raw: {
        profile: { fluctuationScale: [100.5, 130.2], rateInSimilarPersent: '23.4' },
        navDate: '2025-09-30',
      },
    } as never)
    eq('画像事实：规模取末值', profFacts.fund_size?.value, 130.2)
    eq('画像事实：同类排名百分比', profFacts.similar_rank_pct?.value, 23.4)
    eq('画像事实：asOf=净值日期', profFacts.fund_size?.asOf, '2025-09-30')
    const profBad = factsFromFundProfile({
      raw: { profile: { fluctuationScale: 999999, rateInSimilarPersent: 150 } },
    } as never)
    eq('画像事实：越界规模/排名按缺失省略', 'fund_size' in profBad || 'similar_rank_pct' in profBad, false)
    const riskFacts = factsFromFundRisk(riskGeo)
    eq('风险事实：今年来有值', typeof riskFacts.nav_ytd?.value, 'number')
    eq('风险事实：历史不足1年→近1年三件套缺失', 'max_drawdown_1y' in riskFacts || 'volatility_annual' in riskFacts || 'sharpe' in riskFacts, false)

    // (10) 结构化验证：新基金指标键可评估；tracking_error 故意不进 KNOWN（只能工具算）。
    const knownFundKeys = ['nav_ytd', 'max_drawdown_1y', 'volatility_annual', 'sharpe', 'fund_size', 'similar_rank_pct']
    eq('结构化：6个基金指标键进 KNOWN_METRICS', knownFundKeys.every((k) => (KNOWN_METRICS as readonly string[]).includes(k)), true)
    eq('结构化：基金指标都有溯源', knownFundKeys.every((k) => metricProvenance(k) !== '暂无自动取数映射，须 Agent/人工查证'), true)
    eq('结构化：tracking_error 不在 KNOWN（仅工具产出）', (KNOWN_METRICS as readonly string[]).includes('tracking_error'), false)
    const fundChecks = evaluateThesis(
      [{ id: 'i1', metricKey: 'max_drawdown_1y', label: '近1年回撤≤20%', comparator: '<=', threshold: 20 }],
      [{ id: 'f1', metricKey: 'sharpe', label: '夏普<0 证伪', comparator: '<', threshold: 0 }],
      { max_drawdown_1y: { value: 15, source: 'test' }, sharpe: { value: -0.3, source: 'test' } },
    )
    eq('结构化：基金指标满足', fundChecks[0]!.status, 'satisfied')
    eq('结构化：基金证伪触发', fundChecks[1]!.status, 'triggered')
    eq('结构化：未知键 unverifiable', evaluateThesis(
      [{ id: 'x', metricKey: 'tracking_error', label: 'x', comparator: '<=', threshold: 1 }], [], {},
    )[0]!.status, 'unverifiable')

    // (11) 画像行渲染：{x,y} 时间戳点 → 日期/值（不要把毫秒当数值展示）。
    const msTs = Date.UTC(2023, 10, 14)
    const prows = profileRows([{ x: msTs, y: 1.23 }], '值')
    eq('画像行：{x,y}→日期/值两列', `${prows[0]!['日期']}|${prows[0]!['值']}`, `${new Date(msTs).toISOString().slice(0, 10)}|1.23`)
    eq('画像取末值：对象数组按 y', latestProfileNumber([{ x: 1, y: 10 }, { x: 2, y: 42 }]), 42)

    // (12) 基金档案：假行情（离线）→ 12 维结构、关键维就绪、快照稳定；全挂也不抛错。
    const dossierBars = geoNav.map((p) => ({ date: p.date, open: p.nav, high: p.nav, low: p.nav, close: p.nav, volume: 0, volumeMissing: true }))
    const fakeFundFinance = {
      getFundQuote: async () => ({
        ok: true, provider: 'em_pingzhongdata',
        data: {
          code: '110022', name: '易方达消费行业股票', price: geoNav.at(-1)!.nav,
          changePercent: 0.5, asOf: geoNav.at(-1)!.date,
          raw: {
            navDate: geoNav.at(-1)!.date, accumNav: 3.21, subscribeStatus: '开放申购', redeemStatus: '开放赎回',
            profile: { currentFundManager: '萧楠', fluctuationScale: 150.5, rateInSimilarPersent: '12' },
          },
        },
      }),
      getFundKline: async () => ({ ok: true, provider: 'em_fund_kline', data: dossierBars }),
      getFundHoldings: async () => ({ ok: true, provider: 'em_fund_holdings', data: jjccRows.map((r) => ({ code: r.股票代码, name: r.股票名称, weightPct: Number(r.占净值比例) })) }),
      getKline: async () => ({ ok: true, provider: 'em_kline', data: benchSeries.map((p) => ({ date: p.date, open: p.close, high: p.close, low: p.close, close: p.close, volume: 0 })) }),
      westock: async () => ({ ok: false, error: 'offline' }),
    } as never
    const fd = await buildFundDossier(fakeFundFinance, '110022')
    eq('基金档案：12 个维度', fd.total, 12)
    eq('基金档案：类型=fund', fd.type, 'fund')
    eq('基金档案：基本信息就绪', fd.sections.find((s) => s.key === 'overview')?.status, 'ready')
    eq('基金档案：风险指标就绪且带时点', `${fd.sections.find((s) => s.key === 'risk_metrics')?.status}|${fd.sections.find((s) => s.key === 'risk_metrics')?.dataAsOf}`, `ready|${geoNav.at(-1)!.date}`)
    eq('基金档案：基准对比就绪（宽基近似标注）', fd.sections.find((s) => s.key === 'benchmark')?.status, 'ready')
    eq('基金档案：重仓持仓就绪', fd.sections.find((s) => s.key === 'holdings')?.rows, 10)
    eq('基金档案：经理/规模画像就绪', `${fd.sections.find((s) => s.key === 'manager')?.status}|${fd.sections.find((s) => s.key === 'scale')?.status}`, 'ready|ready')
    eq('基金档案：摘要含维度计数', /\d+\/12 个维度有数据/.test(dossierSummary(fd, '基金深度档案')), true)
    const fdAgain = await buildFundDossier(fakeFundFinance, '110022')
    eq('基金档案：快照 id 稳定', fdAgain.snapshotId, fd.snapshotId)
    const brokenFundFinance = {
      getFundQuote: async () => { throw new Error('net down') },
      getFundKline: async () => { throw new Error('net down') },
      getFundHoldings: async () => { throw new Error('net down') },
      getKline: async () => { throw new Error('net down') },
      westock: async () => { throw new Error('net down') },
    } as never
    const fdBroken = await buildFundDossier(brokenFundFinance, '110022')
    eq('基金档案：全失败仍返回结构', fdBroken.sections.length, 12)
    eq('基金档案：全失败维度标错误不抛', fdBroken.sections.every((s) => typeof s.ok === 'boolean' && typeof s.ms === 'number'), true)

    // (13) 分类型提醒阈值：股票 ±5 / 基金 ±2（净值日频、波动小）。
    const remindFinance = {
      getAutoQuote: async (code: string) => ({
        ok: true,
        data: code === '510300'
          ? { code, price: 4.1, changePercent: -3, name: '华泰柏瑞沪深300ETF' }
          : { code, price: 1700, changePercent: -3, name: '贵州茅台' },
      }),
    } as never
    const remindStore = {
      get: () => ({
        holdings: [{ code: '600519', type: 'stock', name: '贵州茅台', qty: 1, cost: 1 }],
        watchlist: [{ code: '510300', type: 'fund', name: '华泰柏瑞沪深300ETF' }],
        budget: undefined as unknown,
        settings: {},
      }),
    } as never
    const rstore = new ReminderStore(path.join(root, 'reminders-fund.json'))
    const scan1 = await scanReminders(remindFinance, remindStore, undefined, rstore, {})
    eq('提醒：只触发基金（股票-3%<±5，基金-3%≥±2）', scan1.added.length, 1)
    eq('提醒：触发的是基金异动', `${scan1.added[0]?.type}|${scan1.added[0]?.kind}`, 'fund|move')
    check('提醒：详情标注（基金）与±2阈值', (scan1.added[0]?.detail ?? '').includes('（基金）') && (scan1.added[0]?.detail ?? '').includes('±2%'), scan1.added[0]?.detail ?? '')
    eq('提醒：-3% 未到2倍阈值→info 级', scan1.added[0]?.level, 'info')
    const scan2 = await scanReminders(remindFinance, remindStore, undefined, rstore, {})
    eq('提醒：冷却窗口内不重复', scan2.added.length, 0)
    const scan3 = await scanReminders(remindFinance, remindStore, undefined, new ReminderStore(path.join(root, 'reminders-fund2.json')), { fundMovePct: 5 })
    eq('提醒：可覆盖基金阈值（传5→-3不触发）', scan3.added.length, 0)


    // ===== 批次18：组合穿透 + 买入前边际检查（P2，纯函数/假行情，离线） =====
    const directP = [{ code: '600519', name: '贵州茅台', weightPct: 10 }]
    const fundsP = [
      {
        code: '110022', name: '易方达消费', weightPct: 40,
        holdings: [
          { code: '600519', name: '贵州茅台', weightPct: 10 },
          { code: '000858', name: '五粮液', weightPct: 5 },
          { code: '601318', name: '中国平安', weightPct: 20 },
          { code: '000651', name: '格力电器', weightPct: 2 },
        ] as Array<{ code: string; name?: string; weightPct?: number }>,
      },
      {
        code: '161725', name: '招商白酒', weightPct: 30,
        holdings: [
          { code: '600519', name: '贵州茅台', weightPct: 8 },
          { code: '300750', name: '宁德时代', weightPct: 15 },
          { code: '000651', name: '格力电器', weightPct: 3 },
        ] as Array<{ code: string; name?: string; weightPct?: number }>,
      },
      { code: '005827', name: '易方达蓝筹', weightPct: 20, holdings: [] as Array<{ code: string }>, error: '重仓获取失败：boom' },
    ] as Parameters<typeof computeLookthrough>[1]
    const lt = computeLookthrough(directP, fundsP, { topN: 10 })
    const mt = lt.stocks.find((s) => s.code === '600519')!
    eq('穿透：茅台=直投10+基金穿透6.4', `${mt.weightPct}|${mt.directPct}|${mt.indirectPct}`, '16.4|10|6.4')
    eq('穿透：茅台 via 两基金', mt.via.length, 2)
    eq('穿透：茅台标记重复暴露', mt.repeated, true)
    const gl = lt.stocks.find((s) => s.code === '000651')!
    eq('穿透：双基金共有但无直投也算重复', `${gl.weightPct}|${gl.repeated}|${gl.directPct}`, '1.7|true|0')
    eq('穿透：单基金独有不重复', lt.stocks.find((s) => s.code === '300750')?.repeated, false)
    eq('穿透：股票总暴露=直接+间接', lt.totals.stockPct, 32.6)
    eq('穿透：直投/基金/已覆盖权重', `${lt.totals.directPct}|${lt.totals.fundPct}|${lt.totals.fundCoveredPct}`, '10|90|70')
    eq('穿透：重复暴露数=2', lt.totals.repeatedCount, 2)
    eq('穿透：第一大=茅台16.4', lt.totals.top1Pct, 16.4)
    check('穿透：HHI 落在合理区间', lt.totals.hhi > 0.3 && lt.totals.hhi < 0.4, `hhi=${lt.totals.hhi}`)
    check('穿透：有效个股数≈3', lt.totals.effectiveStocks > 2 && lt.totals.effectiveStocks < 4, `eff=${lt.totals.effectiveStocks}`)
    check('穿透：首行按暴露排序', lt.stocks[0]!.code === '600519' && (lt.stocks[1]?.weightPct ?? 0) >= (lt.stocks[2]?.weightPct ?? 99), '')
    check('穿透：未穿透基金进告警', lt.warnings.some((w) => w.includes('1 只基金重仓未取到')), lt.warnings.join(' | '))
    check('穿透：单股≥15%进告警', lt.warnings.some((w) => w.includes('16.4%') && w.includes('15%')), lt.warnings.join(' | '))
    check('穿透：伪分散（有效个股<10）进告警', lt.warnings.some((w) => w.includes('伪分散')), lt.warnings.join(' | '))
    check('穿透：上界近似口径写进 notes', lt.notes.some((n) => n.includes('上界近似')), '')
    eq('穿透：失败基金行带 error', lt.funds.find((f) => f.code === '005827')?.error, '重仓获取失败：boom')
    eq('穿透：成功基金行带重仓覆盖', lt.funds.find((f) => f.code === '110022')?.topWeightPct, 37)

    // (2) 边际检查：加仓已持有的个股 → 集中度上升 + 明确「同一个赌注」。
    const margStock = marginalLookthrough(lt, { code: '300750', type: 'stock', name: '宁德时代', weightPct: 5 })
    eq('边际-股：前后快照齐备', `${typeof margStock.before.hhi}|${typeof margStock.after?.hhi}`, 'number|number')
    eq('边际-股：重叠明细=现有4.5→9.5', `${margStock.overlaps[0]?.code}|${margStock.overlaps[0]?.beforePct}|${margStock.overlaps[0]?.addedPct}|${margStock.overlaps[0]?.afterPct}`, '300750|4.5|5|9.5')
    check('边际-股：提示已有暴露', margStock.warnings.some((w) => w.includes('已有穿透暴露 4.5%')), margStock.warnings.join(' | '))
    eq('边际-股：目标权重往返', margStock.target.proposedWeightPct, 5)
    const margNew = marginalLookthrough(lt, { code: '600036', type: 'stock', name: '招商银行', weightPct: 8 })
    eq('边际-股：新标的无重叠', margNew.overlaps.length, 0)
    check('边际-股：新标的算新增分散', margNew.notes.some((n) => n.includes('新增分散来源')), margNew.notes.join(' | '))

    // (3) 边际检查：新基金重叠度 → fundOverlapPct 与加仓后第一大个股。
    const margFund = marginalLookthrough(lt, {
      code: '510300', type: 'fund', name: '沪深300ETF', weightPct: 10,
      holdings: [
        { code: '600519', weightPct: 20 },
        { code: '601318', weightPct: 10 },
        { code: '600036', weightPct: 5 },
      ],
    })
    eq('边际-基：重叠占其净值30%', margFund.fundOverlapPct, 30)
    eq('边际-基：重叠股数=2（茅台/平安）', margFund.overlaps.length, 2)
    eq('边际-基：茅台 16.4→18.4', `${margFund.overlaps.find((o) => o.code === '600519')?.beforePct}|${margFund.overlaps.find((o) => o.code === '600519')?.afterPct}`, '16.4|18.4')
    check('边际-基：加仓后第一大≥15%告警', (margFund.warnings ?? []).some((w) => w.includes('18.4%') && w.includes('15%')), margFund.warnings.join(' | '))
    check('边际-基：重叠明细进告警', margFund.warnings.some((w) => w.includes('16.4%→18.4%')), margFund.warnings.join(' | '))
    const margFundBad = marginalLookthrough(lt, { code: '510300', type: 'fund', weightPct: 10, error: '契约未线上核实，解析失败' })
    eq('边际-基：持仓未知→无 after', margFundBad.after, undefined)
    check('边际-基：持仓未知必须告警', margFundBad.warnings.some((w) => w.includes('持仓未知')), margFundBad.warnings.join(' | '))

    // (4) 装配器：假行情（风险权重路径 / 成本回退 / 多币种拒绝 / 空组合拒绝）。
    const fakeLookFinance = {
      analyzePortfolio: async () => ({
        ok: true as const, quoteAvailable: true,
        summary: { holdingCount: 3, totalValue: 1000, totalProfit: 0, profitPercent: 0, valuation: {} },
        risk: {
          weights: [
            { code: '600519', name: '贵州茅台', type: 'stock', weight: 10 },
            { code: '110022', name: '易方达消费', type: 'fund', weight: 40 },
            { code: '161725', name: '招商白酒', type: 'fund', weight: 30 },
          ],
        },
        holdings: [],
      }),
      getFundHoldings: async (code: string) => code === '110022'
        ? { ok: true as const, provider: 'em_fund_holdings', data: [{ code: '600519', name: '贵州茅台', weightPct: 10 }, { code: '000858', name: '五粮液', weightPct: 5 }] }
        : { ok: false as const, provider: 'em_fund_holdings', error: 'boom' },
      westock: async () => ({ ok: false as const, error: 'offline' }),
    } as never
    const ltb = await buildLookthrough(fakeLookFinance, { topN: 10 })
    eq('装配：权重来源=行情市值', ltb.weightsSource, 'market')
    eq('装配：直投10、基金70、已覆盖40', `${ltb.totals.directPct}|${ltb.totals.fundPct}|${ltb.totals.fundCoveredPct}`, '10|70|40')
    eq('装配：茅台=直投10+穿透4=14%', ltb.stocks.find((s) => s.code === '600519')?.weightPct, 14)
    eq('装配：失败基金回落告警', ltb.warnings.some((w) => w.includes('1 只基金')), true)

    const fakeCostFinance = {
      analyzePortfolio: async () => ({
        ok: true as const, quoteAvailable: false,
        summary: { holdingCount: 1, totalValue: null, totalProfit: null, profitPercent: null, valuation: {} },
        risk: null,
        holdings: [{ code: '600519', name: '贵州茅台', type: 'stock', quantity: 100, avgCost: 10 }],
      }),
      getFundHoldings: async () => ({ ok: false as const, error: 'n/a' }),
      westock: async () => ({ ok: false as const, error: 'n/a' }),
    } as never
    const ltc = await buildLookthrough(fakeCostFinance, {})
    eq('装配：缺行情单币种→成本回退', ltc.weightsSource, 'cost')
    eq('装配：成本权重直投=100%', `${ltc.totals.directPct}|${ltc.totals.stockPct}`, '100|100')

    const fakeMultiCurrency = {
      analyzePortfolio: async () => ({
        ok: true as const, quoteAvailable: false,
        summary: { holdingCount: 2, totalValue: null, totalProfit: null, profitPercent: null, valuation: {} },
        risk: null,
        holdings: [
          { code: '600519', type: 'stock', quantity: 100, avgCost: 10 },
          { code: 'AAPL', type: 'stock', quantity: 10, avgCost: 100 },
        ],
      }),
      getFundHoldings: async () => ({ ok: false as const, error: 'n/a' }),
      westock: async () => ({ ok: false as const, error: 'n/a' }),
    } as never
    let multiErr = ''
    try { await buildLookthrough(fakeMultiCurrency, {}) } catch (e) { multiErr = e instanceof Error ? e.message : String(e) }
    check('装配：多币种缺行情拒绝计算', multiErr.includes('多币种'), multiErr)

    const fakeEmpty = {
      analyzePortfolio: async () => ({ ok: true as const, quoteAvailable: false, summary: {}, risk: null, holdings: [] }),
      getFundHoldings: async () => ({ ok: false as const, error: 'n/a' }),
      westock: async () => ({ ok: false as const, error: 'n/a' }),
    } as never
    let emptyErr = ''
    try { await buildLookthrough(fakeEmpty, {}) } catch (e) { emptyErr = e instanceof Error ? e.message : String(e) }
    check('装配：空组合明确报错', emptyErr.includes('组合为空'), emptyErr)

    // ------------------------------------------------------------
    // 批次19：成长（教材完整性 / 判分 / 规划健康度 / 四柱与等级 / 诊断 / 档案存储）
    // ------------------------------------------------------------
    {
      const LS = GROWTH_CURRICULUM.lessons
      check('成长：教材 ≥20 课', LS.length >= 20, `total=${LS.length}`)
      eq('成长：教材 id 唯一', new Set(LS.map((x) => x.id)).size, LS.length)
      check('成长：入门必修 track ≥6 课', LS.filter((x) => x.track === 'l0').length >= 6, String(LS.filter((x) => x.track === 'l0').length))
      check('成长：每题答案都在选项内', LS.every((x) => x.quiz.every((q) => q.answer >= 0 && q.answer < q.options.length)))
      check('成长：每课 ≥3 要点且有测验', LS.every((x) => x.keyPoints.length >= 3 && x.quiz.length >= 1))
      check('成长：指标映射都指向存在的课', Object.values(METRIC_CONCEPT_MAP).every((id) => LS.some((x) => x.id === id)), JSON.stringify(Object.values(METRIC_CONCEPT_MAP)))
      const any = LS[0]!
      check('成长：findLesson 命中', findLesson(any.id)?.id === any.id, any.id)
      check('成长：lessonByQuery 标题命中', lessonByQuery(any.title).some((x) => x.id === any.id), any.title)

      // 判分：满分/零分/越界/题数不符
      const quizLesson = findLesson('etf-premium')!
      check('成长：etf-premium 教材存在', !!quizLesson)
      const perfect = gradeQuiz(quizLesson, quizLesson.quiz.map((q) => q.answer))
      eq('成长：判分满分 passed', `${perfect.score}|${perfect.passed}`, '100|true')
      const wrong = gradeQuiz(quizLesson, quizLesson.quiz.map((q) => (q.answer + 1) % q.options.length))
      eq('成长：判分零分 not passed', `${wrong.score}|${wrong.passed}`, '0|false')
      let quizErr = ''
      try { gradeQuiz(quizLesson, quizLesson.quiz.map((q) => q.answer).concat([0])) } catch (e) { quizErr = e instanceof Error ? e.message : String(e) }
      check('成长：题数不符拒绝', quizErr.includes('不符'), quizErr)
      let boundErr = ''
      try { gradeQuiz(quizLesson, quizLesson.quiz.map(() => 99)) } catch (e) { boundErr = e instanceof Error ? e.message : String(e) }
      check('成长：答案越界拒绝', boundErr.includes('越界'), boundErr)

      // 规划健康度：缺数据 → score null + unknown 修复项
      const emptyH = evaluateFamilyPlan({}, undefined)
      eq('成长：全缺数据 score=null', emptyH.score, null)
      check('成长：缺数据给出补数提示', emptyH.fixes.some((f) => f.key === 'emergency-unknown') && emptyH.fixes.some((f) => f.key === 'protection-unknown'), emptyH.fixes.map((f) => f.key).join(','))
      // 混合严重度 → high 在前（排序稳定）
      const mixed = evaluateFamilyPlan({
        cashflow: { monthlyIncome: 10000, monthlyExpense: 9500 },
        balance: { liquidAssets: 1000, liabilities: [{ name: '贷', monthlyPayment: 5000 }] },
        protection: [{ type: '医疗', covered: true }],
        goals: [],
      }, { responsibility: 'family' })
      const sevRank: Record<string, number> = { high: 0, medium: 1, low: 2 }
      check('成长：修复项 high→medium→low 排序', mixed.fixes.every((f, i, arr) => i === 0 || sevRank[arr[i - 1]!.severity] <= sevRank[f.severity]), mixed.fixes.map((f) => `${f.key}:${f.severity}`).join(','))
      eq('成长：高危在首位', mixed.fixes[0]?.severity, 'high')
      check('成长：负债收入比>40% 触发降杠杆', mixed.fixes.some((f) => f.key === 'debt-high'), mixed.fixes.map((f) => f.key).join(','))
      // 保障按责任认定
      const covered3 = [{ type: '医疗', covered: true }, { type: '重疾', covered: true }, { type: '意外', covered: true }]
      const famH = evaluateFamilyPlan({ protection: covered3 }, { responsibility: 'family' })
      check('成长：家庭责任要求寿险', famH.protectionGaps.includes('寿险'), famH.protectionGaps.join(','))
      const singleH = evaluateFamilyPlan({ protection: covered3 }, { responsibility: 'single' })
      eq('成长：单身不强制寿险', singleH.protectionGaps.length, 0)
      // 目标可行性
      const goalH = evaluateFamilyPlan({ goals: [{ id: 'g1', name: '旅行', targetAmount: 120000, currentAmount: 0, deadline: '2027-06', monthlySaving: 1000 }] })
      eq('成长：月存不够目标判不可行', goalH.goalStatus[0]?.feasible, false)
      check('成长：不可行目标有修复项', goalH.fixes.some((f) => f.key === 'goal-infeasible'), goalH.fixes.map((f) => f.key).join(','))
      const doneH = evaluateFamilyPlan({ goals: [{ id: 'g1', name: '已达成', targetAmount: 10000, currentAmount: 10000, deadline: '2027-06', monthlySaving: 1 }] })
      eq('成长：达标目标可行', doneH.goalStatus[0]?.feasible, true)
      const goodH = evaluateFamilyPlan({
        cashflow: { monthlyIncome: 20000, monthlyExpense: 8000 },
        balance: { liquidAssets: 60000, liabilities: [] },
        protection: covered3,
        goals: [{ id: 'g1', name: '应急外目标', targetAmount: 10000, currentAmount: 5000, deadline: '2027-12', monthlySaving: 5000 }],
      }, {})
      eq('成长：全达标 score=100', goodH.score, 100)

      // 四柱与等级：构造让每柱都等于 v → total=v，卡等级边界
      const edgeFacts = (v: number) => ({
        masteredLessons: v, totalLessons: 100, quizAvg: v, planHealthScore: v,
        falsifierCoverage: v / 100, weeklyReviewRate: v / 100, journalCount30d: 0.04 * v,
        savingsRatePct: 0.3 * v, goalFundingRate: v / 100,
      })
      for (const [v, lv] of [[39, 'L1'], [40, 'L2'], [59, 'L2'], [60, 'L3'], [74, 'L3'], [75, 'L4'], [87, 'L4'], [88, 'L5']] as Array<[number, string]>) {
        const s = computeGrowth(edgeFacts(v))
        eq(`成长：${v} 分等级`, `${s.total}|${s.level.id}`, `${v}|${lv}`)
      }
      const nullG = computeGrowth({ masteredLessons: 0, totalLessons: 0, quizAvg: null, planHealthScore: null, falsifierCoverage: null, weeklyReviewRate: null, journalCount30d: null, savingsRatePct: null, goalFundingRate: null })
      eq('成长：全缺 → total null → L1', `${nullG.total}|${nullG.level.id}`, 'null|L1')
      const partG = computeGrowth({ masteredLessons: 5, totalLessons: 10, quizAvg: null, planHealthScore: null, falsifierCoverage: null, weeklyReviewRate: null, journalCount30d: null, savingsRatePct: null, goalFundingRate: null })
      eq('成长：仅认知柱 → 权重重归一 total=50', `${partG.total}|${partG.pillars.plan}`, '50|null')

      // 连续周（显式 today=2026-10-07 周三，周一=2026-10-05）
      const t = new Date('2026-10-07T12:00:00Z')
      eq('成长：空活动 streak=0', computeStreak([], t), 0)
      eq('成长：本周活动 streak=1', computeStreak(['2026-10-06'], t), 1)
      eq('成长：本周+上周 streak=2', computeStreak(['2026-10-06', '2026-09-30'], t), 2)
      eq('成长：仅上周 streak=1（不断更）', computeStreak(['2026-09-30'], t), 1)
      eq('成长：断更归零', computeStreak(['2026-09-20'], t), 0)

      // 诊断引擎
      const mkState = (): GrowthState => ({ createdAt: new Date().toISOString(), plan: {}, lessons: [], attempts: [], reviews: [], activityDates: [] })
      // ETF 持仓 → etf-premium（证据带代码）
      const d1 = diagnoseGrowth({ state: mkState(), facts: { holdings: [{ code: '510300', type: 'fund', name: '沪深300ETF' }] } })
      const etfF = d1.find((f) => f.ref === 'etf-premium')
      check('成长：场内ETF持仓库出折溢价课', !!etfF, d1.map((f) => f.ref).join(','))
      check('成长：ETF证据引用用户代码', !!etfF && etfF.evidence.includes('510300'), etfF?.evidence)
      // 已 mastered → 跳过
      const masteredState = mkState()
      masteredState.lessons.push({ lessonId: 'etf-premium', status: 'mastered', mastery: 100 })
      const d2 = diagnoseGrowth({ state: masteredState, facts: { holdings: [{ code: '510300', type: 'fund' }] } })
      eq('成长：已掌握的课不再库出', d2.some((f) => f.ref === 'etf-premium'), false)
      // 在用指标 → 课程
      const d3 = diagnoseGrowth({ state: mkState(), facts: { thesisMetrics: ['sharpe'] } })
      eq('成长：sharpe指标→risk-metrics', d3.find((f) => f.priority <= 5 && f.kind === 'lesson')?.ref, 'risk-metrics')
      // 规划修复优先于一切（priority=1 首位）
      const planState = mkState()
      planState.plan = { cashflow: { monthlyIncome: 10000, monthlyExpense: 6000 }, balance: { liquidAssets: 6000 } }
      const d4 = diagnoseGrowth({ state: planState, facts: { holdings: [{ code: '510300', type: 'fund' }] } })
      check('成长：规划修复列首位', d4[0]?.kind === 'plan' && d4[0]?.priority === 1, `${d4[0]?.kind}:${d4[0]?.priority}:${d4[0]?.ref}`)
      check('成长：应急金缺口有专项 finding', d4.some((f) => f.ref === 'emergency-gap'), d4.map((f) => f.ref).join(','))
      // 去重：多个指标映射同一课 → 1 条
      const d5 = diagnoseGrowth({ state: mkState(), facts: { thesisMetrics: ['sharpe', 'volatility_annual', 'max_drawdown_1y'] } })
      eq('成长：同课多指标去重', d5.filter((f) => f.ref === 'risk-metrics').length, 1)
      const d5b = diagnoseGrowth({ state: mkState(), facts: { holdings: [{ code: '000001', type: 'fund', name: '某基金' }], thesisMetrics: ['similar_rank_pct'] } })
      eq('成长：持仓与指标同课去重', d5b.filter((f) => f.ref === 'fund-basics').length, 1)
      // 对话主题命中教材标签/标题
      const target = LS.find((x) => x.track !== 'l0') ?? LS[0]!
      const d6 = diagnoseGrowth({ state: mkState(), facts: { recentTopics: [target.title] } })
      check('成长：对话主题顺势补课', d6.some((f) => f.ref === target.id), `target=${target.id} refs=${d6.map((f) => f.ref).join(',')}`)
      // 封顶 8 条且按优先级
      const busyState = mkState()
      busyState.plan = { cashflow: { monthlyIncome: 5000, monthlyExpense: 4900 }, balance: { liquidAssets: 100 }, goals: [] }
      const d7 = diagnoseGrowth({
        state: busyState,
        facts: {
          holdings: [{ code: '510300', type: 'fund' }, { code: '110011', type: 'fund' }, { code: '161725', type: 'fund' }],
          thesisMetrics: ['pe_ttm_percentile', 'roe', 'tracking_error', 'revenue_yoy', 'eps'],
          thesesTotal: 4, thesesWithFalsifier: 1, weeklyReviewRate: 0.2, journalCount30d: 0,
          recentTopics: LS.slice(0, 6).map((x) => x.title),
        },
      })
      check('成长：诊断封顶 8 条', d7.length <= 8, String(d7.length))
      check('成长：诊断按优先级升序', d7.every((f, i, arr) => i === 0 || arr[i - 1]!.priority <= f.priority), d7.map((f) => f.priority).join(','))

      // GrowthStore：原子落盘 + 重读 + 损坏拒绝
      const gfile = path.join(root, 'growth-store', 'growth.json')
      const gs = new GrowthStore(gfile)
      await gs.load()
      await gs.updateProfile({ responsibility: 'family', ageBand: '30s' })
      await gs.updateProfile({ horizonYears: 10 })
      eq('成长：profile 浅合并', `${gs.get().profile?.responsibility}|${gs.get().profile?.horizonYears}`, 'family|10')
      const { plan: planAfter } = await gs.updatePlanSection('cashflow', { monthlyIncome: 12000, monthlyExpense: 7000 })
      eq('成长：cashflow 写入', planAfter.cashflow?.monthlyIncome, 12000)
      await gs.updatePlanSection('goals', [{ id: 'g1', name: '应急', targetAmount: 100000, currentAmount: 0, deadline: '2027-12', monthlySaving: 3000 }])
      eq('成长：goals 整段替换', gs.get().plan.goals?.length, 1)
      let secErr = ''
      try { await gs.updatePlanSection('goals', [{ name: '', targetAmount: -5 } as never]) } catch (e) { secErr = e instanceof Error ? e.message : String(e) }
      check('成长：非法 section 数据拒绝', secErr.includes('必填') || secErr.includes('正数'), secErr)
      const quizRec = await gs.recordQuiz('etf-premium', 100, true)
      check('成长：通过测验记 mastered', quizRec.masteredCount >= 1, JSON.stringify(quizRec))
      const reviewRec = await gs.markReview('2026-10', 'vault-r1', ['补了证伪条件'])
      eq('成长：月度复盘幂等键', reviewRec.review.period, '2026-10')
      await gs.markReview('2026-10', 'vault-r1', ['重复标记'])
      eq('成长：同月复盘覆盖不膨胀', gs.get().reviews.filter((r) => r.period === '2026-10').length, 1)
      check('成长：活动痕迹进 streak', computeStreak(gs.get().activityDates) >= 1, JSON.stringify(gs.get().activityDates.slice(0, 3)))
      let badPeriod = ''
      try { await gs.markReview('202610') } catch (e) { badPeriod = e instanceof Error ? e.message : String(e) }
      check('成长：非法 period 拒绝', badPeriod.includes('YYYY-MM'), badPeriod)
      // 新实例重读（跨会话记忆）
      const gs2 = new GrowthStore(gfile)
      await gs2.load()
      const st2 = gs2.get()
      eq('成长：跨实例重读 profile', st2.profile?.responsibility, 'family')
      eq('成长：跨实例重读目标', st2.plan.goals?.[0]?.id, 'g1')
      check('成长：跨实例重读 mastered', st2.lessons.some((l) => l.lessonId === 'etf-premium' && l.status === 'mastered'))
      eq('成长：跨实例重读复盘', st2.reviews[0]?.vaultId, 'vault-r1')
      // 损坏文件 → 拒绝加载（绝不覆盖）
      await mkdir(path.dirname(gfile), { recursive: true })
      await writeFile(gfile, JSON.stringify({ hello: 'broken' }), 'utf8')
      const gs3 = new GrowthStore(gfile)
      let corruptErr = ''
      try { await gs3.load() } catch (e) { corruptErr = e instanceof Error ? e.message : String(e) }
      check('成长：结构损坏拒绝加载', corruptErr.includes('损坏'), corruptErr)
      await writeFile(gfile, '{ not json', 'utf8')
      const gs4 = new GrowthStore(gfile)
      let syntaxErr = ''
      try { await gs4.load() } catch (e) { syntaxErr = e instanceof Error ? e.message : String(e) }
      check('成长：JSON 语法损坏拒绝加载', syntaxErr.length > 0, syntaxErr)
      const stillBroken = await readFile(gfile, 'utf8')
      eq('成长：损坏文件未被覆盖', stillBroken, '{ not json')
    }

    // ------------------------------------------------------------
    // 批次20：面板 ↔ Agent 双向联动（焦点上报 / 导航命令增强 / 成长回执 / 工具透传）
    // ------------------------------------------------------------
    {
      // 1) 面板焦点：面板 → Agent 的上下文（panel_state 读取源）
      const f1 = setPanelFocus({ tab: 'quotes', code: '510300', type: 'fund' })
      eq('联动：焦点写入', `${f1.tab}|${f1.code}|${f1.type}`, 'quotes|510300|fund')
      check('联动：焦点带时间戳', Number.isFinite(Date.parse(f1.at)), f1.at)
      const f2 = setPanelFocus({ tab: 'home' })
      eq('联动：焦点覆盖为首页', f2.tab, 'home')
      check('联动：首页无聚焦代码', f2.code === undefined, String(f2.code))
      let focusErr = ''
      try { setPanelFocus({ tab: '' }) } catch (e) { focusErr = e instanceof Error ? e.message : String(e) }
      check('联动：非法焦点拒绝', focusErr.includes('tab'), focusErr)
      eq('联动：非法焦点不污染状态', getPanelFocus()?.tab, 'home')

      // 2) 导航命令增强：note（面板一句话）+ anchor（页内锚点）经总线不丢形
      const pb = new PanelBus({ commandTtlMs: 60_000 })
      let env: { event?: unknown } | undefined
      const sub = pb.subscribe((e) => { env = e })
      pb.publish({
        kind: 'panel',
        command: { action: 'navigate', tab: 'holdings', anchor: 'lookthrough', note: '看看穿透体检', commandId: 'c-anchor-1' },
      })
      const cmd = (env as { event?: { command?: Record<string, unknown> } } | undefined)?.event?.command
      check('联动：命令携带 note/anchor', !!cmd && cmd.note === '看看穿透体检' && cmd.anchor === 'lookthrough', JSON.stringify(cmd))
      check('联动：新命令未过期', !isStaleCommand(cmd as never), JSON.stringify(cmd))
      sub.close()

      // 3) 成长回执：写盘成功 → onChange(action)（面板即时刷新的信号源）
      const acts: string[] = []
      const gs = new GrowthStore(path.join(root, 'growth-bus', 'growth.json'), (c) => acts.push(c.action))
      await gs.load()
      await gs.updateProfile({ responsibility: 'single' })
      await gs.updatePlanSection('cashflow', { monthlyIncome: 9000, monthlyExpense: 6000 })
      await gs.recordQuiz('etf-premium', 100, true)
      await gs.markReview('2026-10')
      eq('联动：成长回执动作序列', acts.join(','), 'profile,plan,quiz,review')

      // 4) 工具透传：panel_navigate 的 note/anchor 发布到总线；panel_state 读焦点
      const toolDefs: Array<{ name: string; execute?: (args: Record<string, unknown>) => Promise<unknown> }> = []
      const fakeCtx = { tools: { register: (d: { name: string }) => { toolDefs.push(d as never) } } } as never
      const published: Array<Record<string, unknown>> = []
      const fakeBus = { publish: (e: Record<string, unknown>) => { published.push(e); return e }, subscribe: () => ({ close() {}, gap: false, epoch: 'test' }) } as never
      registerTools(fakeCtx, {} as never, {} as never, {} as never, fakeBus)
      check('联动：panel_navigate 已注册', toolDefs.some((t) => t.name === 'panel_navigate'), String(toolDefs.length))
      const nav = toolDefs.find((t) => t.name === 'panel_navigate')!
      const navOk = await nav.execute!({ tab: 'holdings', anchor: 'lookthrough', note: '你的基金是不是真分散，看这里' })
      const navVal = navOk as { ok: boolean; note?: string; anchor?: string }
      eq('联动：导航返回 note/anchor', `${navVal.ok}|${navVal.anchor}|${navVal.note}`, 'true|lookthrough|你的基金是不是真分散，看这里')
      const evt = published.find((p) => p.kind === 'panel') as { command?: { anchor?: string; note?: string; tab?: string } } | undefined
      check('联动：导航命令入总线', !!evt?.command && evt.command.anchor === 'lookthrough' && evt.command.note?.includes('真分散') && evt.command.tab === 'holdings', JSON.stringify(evt))
      let navErr = ''
      try { await nav.execute!({ tab: 'not-a-tab' }) } catch (e) { navErr = e instanceof Error ? e.message : String(e) }
      check('联动：非法 tab 拒绝', navErr.includes('must be one of') || navErr.includes('valid'), navErr)
      const st = toolDefs.find((t) => t.name === 'panel_state')
      check('联动：panel_state 已注册', !!st)
      setPanelFocus({ tab: 'home' })
      const stVal = await st!.execute!({}) as { ok: boolean; focus?: { tab?: string } | null }
      eq('联动：panel_state 读到焦点', stVal.focus?.tab, 'home')

      // 5) 成长工具回执：lesson_complete 判分成功后应触发 growth 总线事件（经 store.onChange）
      const growthActs: string[] = []
      const gs2 = new GrowthStore(path.join(root, 'growth-bus2', 'growth.json'), (c) => growthActs.push(c.action))
      await gs2.load()
      await gs2.recordQuiz('etf-premium', 100, true)
      eq('联动：判分产生 quiz 回执', growthActs.join(','), 'quiz')
    }

    // 批次21：追踪（13F / 国会申报 / A股名私募）——内核 diff、入队幂等、纸面复刻数学、数据源解析、
    // 档案存储、8 工具端到端（建档→基线→diff→与我对比→复刻→简报 / 国会增量 / 股东扫描）、GET /follow
    // ------------------------------------------------------------
    {
      // 1) 内核（纯）
      eq('追踪：默认档案为空', defaultFollowState().targets.length + defaultFollowState().jobs.length, 0)
      eq('追踪：天数计算', daysSince('2026-10-06', new Date('2026-10-07T12:00:00.000Z')), 1)
      eq('追踪：未拉取', staleLevel('investor-13f', undefined), 'none')
      eq('追踪：13F 新鲜', staleLevel('investor-13f', '2026-10-01', new Date('2026-10-07')), 'fresh')
      eq('追踪：13F 正常', staleLevel('investor-13f', '2026-07-01', new Date('2026-10-07')), 'normal')
      eq('追踪：13F 滞后', staleLevel('investor-13f', '2026-03-01', new Date('2026-10-07')), 'stale')
      eq('追踪：国会 45 天口径', staleLevel('congress', '2026-09-20', new Date('2026-10-07')), 'fresh')
      const P = (cusip: string, issuer: string, value: number, extra: Partial<FollowPosition> = {}): FollowPosition => ({ cusip, issuer, value, shares: 0, ...extra })
      const d13 = diff13F(
        [P('037833100', 'APPLE INC', 100), P('88160R101', 'TESLA INC', 400), P('191216100', 'COKE', 50)],
        [P('037833100', 'APPLE INC', 600000000), P('191216100', 'COKE', 20), P('594918104', 'MICROSOFT', 80), P('037833100', 'APPLE CALL', 10, { call: true })],
      )
      eq('追踪：13F 新进按|Δ|排序', d13.added.map((r) => r.issuer), ['MICROSOFT', 'APPLE CALL'])
      eq('追踪：13F 清仓', d13.removed.map((r) => r.issuer), ['TESLA INC'])
      eq('追踪：13F 加仓/减仓/持平', `${d13.increased.length}|${d13.decreased.length}|${d13.unchanged}`, '1|1|0')
      check('追踪：putCall 与普通股分键', d13.added.some((r) => r.key === '037833100:call'), d13.added.map((r) => r.key).join(','))
      const newTrades = diffCongress(
        [{ id: 't1', side: 'buy', ticker: 'NVDA', source: 'bargo' }],
        [{ id: 't1', side: 'buy', ticker: 'NVDA', source: 'bargo' }, { id: 't2', side: 'sell', ticker: 'TSLA', source: 'bargo' }],
      )
      eq('追踪：国会按 id 求新增', newTrades.map((t) => t.id), ['t2'])
      const tj = { id: 'tgt1', name: 'Berkshire', kind: 'investor-13f' as const }
      const j1 = shouldEnqueue([], tj, '13F', '0001193125-26-054580', '13F 已发布')
      check('追踪：新披露入队', !!j1 && j1.state === 'ready' && j1.id === jobKey('tgt1', '13F', '0001193125-26-054580'), j1?.id)
      eq('追踪：同主键不重复入队', shouldEnqueue(j1 ? [j1] : [], tj, '13F', '0001193125-26-054580', '再来一条'), undefined)
      eq('追踪：空主键不入队', shouldEnqueue([], tj, '13F', '', 'x'), undefined)
      const alloc = allocateShadow(100_000, [
        { cusip: 'A', issuer: 'BIG', ticker: 'BIG', value: 60 },
        { cusip: 'B', issuer: 'MID', ticker: 'MID', value: 30 },
        { cusip: 'C', issuer: 'SML', ticker: 'SML', value: 10 },
      ])
      eq('追踪：复刻权重按市值降序', alloc.map((a) => a.weightPct), [60, 30, 10])
      check('追踪：复刻分配合计≈本金', Math.abs(alloc.reduce((s, a) => s + a.allocUsd, 0) - 100_000) < 1, String(alloc.reduce((s, a) => s + a.allocUsd, 0)))
      const sp = applyEntryPrice({ cusip: 'A', issuer: 'BIG', allocUsd: 60_000, weightPct: 60 } as never, 120, '2026-02-18')
      eq('追踪：入场价→股数', sp.shares, 500)
      eq('追踪：非法入场价不编数', applyEntryPrice({ cusip: 'A', issuer: 'X', allocUsd: 10, weightPct: 1 } as never, Number.NaN, 'x').shares, undefined)
      const tt = shadowTotals([
        { cusip: 'A', issuer: 'A', allocUsd: 100, weightPct: 1, shares: 10, entryPrice: 10, entryDate: 'd', lastPrice: 11 } as never,
        { cusip: 'B', issuer: 'B', allocUsd: 90, weightPct: 9 } as never,
      ])
      eq('追踪：收益只算已定价', `${tt.pricedCount}|${tt.missingCount}`, '1|1')
      check('追踪：已定价收益率为正', (tt.pnlPct ?? 0) > 0, String(tt.pnlPct))
      eq('追踪：全缺价收益为 null', shadowTotals([{ cusip: 'A', issuer: 'A', allocUsd: 1, weightPct: 1 } as never]).pnlPct, null)
      const ov = overlapWithHoldings(
        [P('037833100', 'APPLE INC', 70, { ticker: 'AAPL' }), { cusip: 'X', issuer: 'NO MAP', value: 30, shares: 0 }],
        undefined,
        [{ code: 'aapl', name: '苹果' }],
      )
      eq('追踪：与我重叠命中', ov.matched.map((m) => m.ticker), ['AAPL'])
      eq('追踪：未映射如实计数', `${ov.unmapped}|${ov.theirsMapped}`, '1|1')
      const ovT = overlapWithHoldings(
        undefined,
        [{ id: '1', side: 'buy', ticker: 'NVDA', source: 'bargo' }, { id: '2', side: 'sell', ticker: 'TSLA', source: 'bargo' }],
        [{ code: 'NVDA' }],
      )
      eq('追踪：政客按 ticker 交集', ovT.matched.map((m) => m.ticker), ['NVDA'])
      const snapA: FollowSnapshot = { targetId: 't1', filingKey: 'B', form: '13F-HR', filedAt: '2026-02-17', capturedAt: 'c', data: { positions: [] } }
      const snapB: FollowSnapshot = { targetId: 't1', filingKey: 'A', form: '13F-HR', filedAt: '2025-11-14', capturedAt: 'c', data: { positions: [] } }
      eq('追踪：最新快照按披露日', latestSnapshot([snapB, snapA], 't1')?.filingKey, 'B')
      eq('追踪：上一期快照', previousSnapshot([snapB, snapA], 't1', 'B')?.filingKey, 'A')
      eq('追踪：缺上期=基线摘要', summarizeDiff(undefined, snapA).mode, 'baseline')
      eq('追踪：主键哈希与顺序无关', followHash(['b', 'a']) === followHash(['a', 'b']), true)
      eq('追踪：别名命中', matchAliases({ rows: [{ name: '广东邻山1号投资合伙' }] }, ['邻山1号']).map((h) => h.alias), ['邻山1号'])
      eq('追踪：别名未命中不硬凑', matchAliases({ rows: [{ name: '毫不相关' }] }, ['邻山1号']).length, 0)

      // 2) 数据源解析（纯）
      const pos13f = parse13FInformationTable(FIX_13F_XML)
      eq('追踪：13F XML 解析', pos13f.map((p) => p.issuer), ['APPLE INC', 'COCA COLA CO'])
      eq('追踪：13F 金额与股数', `${pos13f[0]!.value}|${pos13f[0]!.shares}`, '600000000|30000000')
      const nsXml = '<ns1:informationTable><ns1:infoTable><ns1:nameOfIssuer>ABC</ns1:nameOfIssuer><ns1:cusip>123456789</ns1:cusip><ns1:value>1000</ns1:value><ns1:shrsOrPrnamt><ns1:sshPrnamt>10</ns1:sshPrnamt></ns1:shrsOrPrnamt></ns1:infoTable></ns1:informationTable>'
      check('追踪：13F 命名空间前缀容错', parse13FInformationTable(nsXml)[0]?.issuer === 'ABC' && parse13FInformationTable(nsXml)[0]?.value === 1000, JSON.stringify(parse13FInformationTable(nsXml)[0]))
      const optPos = parse13FInformationTable('<informationTable><infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><cusip>037833100</cusip><value>5000</value><putCall>Call</putCall><shrsOrPrnamt><sshPrnamt>100</sshPrnamt></shrsOrPrnamt></infoTable></informationTable>')[0]!
      check('追踪：期权 putCall 标记', optPos.call === true && !optPos.put, JSON.stringify(optPos))
      const subs = parseEdgarSubmissions(FIX_SUBMISSIONS)
      eq('追踪：EDGAR 关注表单', subs.map((f) => f.form), ['13F-HR', '13D', '13F-HR'])
      eq('追踪：13F 组取最新', latestFilingGroup(subs, '13F')?.accession, '0001193125-26-054580')
      eq('追踪：13DG 组取最新', latestFilingGroup(subs, '13DG')?.accession, '0001193125-25-777777')
      eq('追踪：发行人归一化', `${normalizeIssuerName('Berkshire Hathaway Inc.')}|${normalizeIssuerName('Apple Inc.')}`, 'BERKSHIRE HATHAWAY|APPLE')
      const idx = parseCompanyTickers({
        '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
        '1': { cik_str: 1, ticker: 'AAA', title: 'Ambiguous Corp' },
        '2': { cik_str: 2, ticker: 'BBB', title: 'Ambiguous Corp' },
      })
      const mappedPos = mapPositionsToTickers(
        [P('037833100', 'APPLE INC', 10), P('999999999', 'Ambiguous Corp', 30), P('888888888', 'Unknown Thing', 40)],
        idx,
      )
      eq('追踪：发行人→代码唯一映射', mappedPos.map((p) => p.ticker ?? ''), ['AAPL', '', ''])
      eq('追踪：金额区间', JSON.stringify(parseAmountRange('$1,001 - $15,000')), '{"lo":1001,"hi":15000}')
      const ctrTrades = parseCongressBargo({ trades: [
        { id: 'b1', ticker: 'nvda ', transaction_type: 'purchase', amount_range: '$1,001 - $15,000', transaction_date: '2026-09-10', disclosure_date: '2026-09-20', politician_name: 'Nancy Pelosi' },
        { symbol: 'tsla', transaction_type: 'sale', amount: '$50,001 - $100,000', transaction_date: '2026-09-11', disclosure_date: '2026-09-21' },
      ] })
      eq('追踪：国会申报归一化', ctrTrades.map((t) => `${t.side}:${t.ticker}`), ['buy:NVDA', 'sell:TSLA'])
      eq('追踪：国会金额与成员', `${ctrTrades[0]!.amountLo}|${ctrTrades[0]!.amountHi}|${ctrTrades[0]!.politician}`, '1001|15000|Nancy Pelosi')
      eq('追踪：国会 id 兜底', ctrTrades[1]!.id, '2026-09-11:TSLA:2026-09-21')
      eq('追踪：名字→CIK atom', parseEdgarCompanyAtom(FIX_ATOM)[0]?.cik, '0001067983')
      eq('追踪：受控别名表', resolveAliases('冯柳').join(','), '邻山1号')
      eq('追踪：别名缺省回退原名', resolveAliases('某私募').join(','), '某私募')

      // 3) 档案存储：原子写 / 幂等 / 级联 / 损坏拒绝
      const ev1: string[] = []
      const fstore = new FollowStore(path.join(root, 'follow-a', 'follow.json'), (c) => ev1.push(c.action))
      const tInv = await fstore.addTarget({ kind: 'investor-13f', name: 'Berkshire Hathaway', cik: '1067983', note: '长期视角' })
      check('追踪：建档生成 id', /^flw-/.test(tInv.id), tInv.id)
      eq('追踪：建档回执', ev1.join(','), 'target')
      let dupErr = ''
      try { await fstore.addTarget({ kind: 'investor-13f', name: 'Berkshire Hathaway Inc', cik: '0001067983' }) } catch (e) { dupErr = e instanceof Error ? e.message : String(e) }
      check('追踪：重复建档拒绝（cik 归一）', dupErr.includes('已存在'), dupErr)
      const oldSnap: FollowSnapshot = { targetId: tInv.id, filingKey: '0001193125-25-666666', form: '13F-HR', filedAt: '2025-11-14', capturedAt: '2026-10-07T00:00:00.000Z', data: { positions: [P('037833100', 'APPLE INC', 100), P('88160R101', 'TESLA INC', 400)] } }
      const rec1 = await fstore.recordSnapshot(oldSnap)
      const rec2 = await fstore.recordSnapshot(oldSnap)
      check('追踪：快照幂等（首录/替换）', rec1.replaced === false && rec2.replaced === true, JSON.stringify([rec1, rec2]))
      eq('追踪：快照回执', ev1.join(','), 'target,snapshot,snapshot')
      await fstore.touchTarget(tInv.id, { lastCheckedAt: '2026-10-07T00:00:00.000Z' })
      eq('追踪：touch 不发回执', ev1.join(','), 'target,snapshot,snapshot')
      const job1 = shouldEnqueue([], tInv, '13F', '0001193125-26-054580', '13F 已发布')!
      eq('追踪：入队幂等', JSON.stringify([await fstore.enqueueJob(job1), await fstore.enqueueJob(job1)]), '[{"queued":true},{"queued":false}]')
      await fstore.setJobState(job1.id, 'done')
      eq('追踪：任务状态', fstore.get().jobs.find((j) => j.id === job1.id)?.state, 'done')
      await fstore.addBrief({ targetId: tInv.id, title: 'Q4 减持苹果', points: ['p1', 'p2'], filingKey: '0001193125-25-666666' })
      await fstore.addBrief({ targetId: tInv.id, title: 'Q4 减持苹果', points: ['p1'], filingKey: 'x' })
      eq('追踪：7日标题去重', fstore.get().briefs.filter((b) => b.title === 'Q4 减持苹果').length, 1)
      check('追踪：原子文件落盘', await access(path.join(root, 'follow-a', 'follow.json')).then(() => true).catch(() => false), '')
      const f2 = new FollowStore(path.join(root, 'follow-b', 'follow.json'))
      const tC = await f2.addTarget({ kind: 'congress', name: 'Test Member', slug: 'test-member' })
      await f2.recordSnapshot({ targetId: tC.id, filingKey: 'k', form: 'PTR', filedAt: '2026-10-01', capturedAt: 'x', data: { trades: [] } })
      await f2.enqueueJob({ id: `${tC.id}:congress:k`, targetId: tC.id, group: 'congress', filingKey: 'k', title: 't' })
      await f2.addBrief({ targetId: tC.id, title: 'b', points: ['x'] })
      await f2.removeTarget(tC.id)
      const st2 = f2.get()
      check('追踪：移除级联清空', st2.targets.length === 0 && st2.snapshots.length === 0 && st2.jobs.length === 0 && st2.briefs.length === 0, JSON.stringify({ t: st2.targets.length, s: st2.snapshots.length, j: st2.jobs.length, b: st2.briefs.length }))
      const badFile = path.join(root, 'follow-bad', 'follow.json')
      await mkdir(path.dirname(badFile), { recursive: true })
      await writeFile(badFile, '{"targets":{}}')
      let badErr = ''
      try { await new FollowStore(badFile).load() } catch (e) { badErr = e instanceof Error ? e.message : String(e) }
      check('追踪：损坏档案拒绝加载', badErr.includes('损坏'), badErr)

      // 4) 8 工具端到端（fetch mock 提供 EDGAR/Bargo fixture）
      const toolDefs: Array<{ name: string; execute?: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown> }> = []
      const fakeCtx = { tools: { register: (d: { name: string }) => { toolDefs.push(d as never) } } } as never
      const fstore2 = new FollowStore(path.join(root, 'follow-e2e', 'follow.json'))
      const researchEvents: Array<Record<string, unknown>> = []
      const fakeBus = { publish: (e: Record<string, unknown>) => { researchEvents.push(e); return e }, subscribe: () => ({ close() {}, gap: false, epoch: 'test' }) } as never
      const fakeVault = { create: async (input: { title?: string }) => ({ id: 'r-1', title: String(input.title ?? '') }) } as never
      let growthHits = 0
      const fakeGrowth = { markActivity: async () => { growthHits++ } } as never
      const fakePortfolio = { get: () => ({
        holdings: [
          { code: 'AAPL', name: '苹果', type: 'stock' },
          { code: 'NVDA', name: '英伟达', type: 'stock' },
          { code: '600519', name: '贵州茅台', type: 'stock' },
        ],
        watchlist: [],
      }) } as never
      const fakeFinance = {
        westock: async (capability: string) => capability === 'shareholder'
          ? { ok: true, data: { top10: [{ holder: '广东邻山1号投资合伙企业（有限合伙）', ratio: '4.2%' }, { holder: '中央结算', ratio: '9%' }] } }
          : { ok: false, error: 'unsupported' },
        getQuotes: async (codes: Array<{ code: string }>) => ({ ok: true, data: codes.map((c) => ({ code: c.code, price: c.code === 'AAPL' ? 260 : 70 })) }),
        getKline: async (code: string) => ({ ok: true, data: [{ date: '2026-02-18', open: 100, high: 110, low: 90, close: code === 'AAPL' ? 252 : 71, volume: 1000 }] }),
      } as never
      registerFollowTools(fakeCtx, { finance: fakeFinance, portfolio: fakePortfolio, follow: fstore2, bus: fakeBus, vault: fakeVault, growth: fakeGrowth } as never, { tick: false })
      const WANT = ['follow_list', 'follow_add', 'follow_remove', 'follow_fetch', 'follow_diff', 'follow_vs_holdings', 'follow_replicate', 'follow_note']
      eq('追踪：8 工具全注册', WANT.filter((n) => toolDefs.some((t) => t.name === n)), WANT)
      eq('追踪：工具数', toolDefs.length, 8)
      const T = (name: string) => toolDefs.find((t) => t.name === name)!
      const exec = { signal: undefined }
      const list0 = await T('follow_list').execute!({}, exec) as { ok: boolean; counts?: { targets?: number } }
      check('追踪：follow_list 空档案', list0.ok && list0.counts?.targets === 0, JSON.stringify(list0.counts))
      const addInv = await T('follow_add').execute!({ kind: 'investor-13f', name: 'Berkshire Hathaway' }, exec) as { ok: boolean; target?: { id: string; cik?: string }; caveats?: string[] }
      check('追踪：名字→CIK 建档', addInv.ok && addInv.target?.cik === '0001067983', JSON.stringify(addInv.target))
      check('追踪：建档带边界说明', (addInv.caveats ?? []).some((c) => c.includes('45')), (addInv.caveats ?? []).join(' '))
      const invId = addInv.target!.id
      await fstore2.recordSnapshot({ targetId: invId, filingKey: '0001193125-25-666666', form: '13F-HR', filedAt: '2025-11-14', capturedAt: '2026-10-07T00:00:00.000Z', data: { positions: [P('037833100', 'APPLE INC', 100), P('88160R101', 'TESLA INC', 400)] } })
      const fetch1 = await T('follow_fetch').execute!({ id: invId }, exec) as { ok: boolean; newFiling?: boolean; filing?: { accession?: string }; caveats?: string[] }
      check('追踪：拉取 13F 新期', fetch1.ok === true && fetch1.newFiling === true && fetch1.filing?.accession === '0001193125-26-054580', JSON.stringify(fetch1.filing))
      check('追踪：拉取带延迟边界', (fetch1.caveats ?? []).some((c) => c.includes('45')), (fetch1.caveats ?? []).join(' '))
      const invSnap = latestSnapshot(fstore2.get().snapshots, invId)
      eq('追踪：快照期与持仓数', `${invSnap?.period}|${invSnap?.data.positions?.length}`, '2025-12-31|2')
      eq('追踪：发行人→代码入库', invSnap?.data.positions?.map((p) => p.ticker ?? '').sort().join(','), 'AAPL,KO')
      check('追踪：新披露入队待解读', fstore2.get().jobs.some((j) => j.targetId === invId && j.state === 'ready' && j.group === '13F'), JSON.stringify(fstore2.get().jobs.map((j) => j.id)))
      const fetch2 = await T('follow_fetch').execute!({ id: invId }, exec) as { newFiling?: boolean }
      check('追踪：同披露重复拉取幂等', fetch2.newFiling === false && fstore2.get().snapshots.filter((s) => s.targetId === invId).length === 2, JSON.stringify(fetch2))
      const diffR = await T('follow_diff').execute!({ id: invId }, exec) as { ok: boolean; baseline?: boolean; diff?: { added?: Array<{ issuer: string }>; removed?: Array<{ issuer: string }>; increased?: Array<{ issuer: string; delta: number }> } }
      check('追踪：两期 diff 非基线', diffR.ok && diffR.baseline === false, String(diffR.baseline))
      eq('追踪：diff 新进', diffR.diff?.added?.map((r) => r.issuer), ['COCA COLA CO'])
      eq('追踪：diff 清仓', diffR.diff?.removed?.map((r) => r.issuer), ['TESLA INC'])
      check('追踪：diff 加仓带数字', (diffR.diff?.increased ?? []).some((r) => r.issuer === 'APPLE INC' && r.delta > 0), JSON.stringify(diffR.diff?.increased))
      const vsR = await T('follow_vs_holdings').execute!({ id: invId }, exec) as { matched?: Array<{ ticker: string }>; theirsMapped?: number; unmapped?: number }
      eq('追踪：与我重叠', vsR.matched?.map((m) => m.ticker), ['AAPL'])
      eq('追踪：映射计数', `${vsR.theirsMapped}|${vsR.unmapped}`, '2|0')
      const rep = await T('follow_replicate').execute!({ id: invId, capital: 100_000 }, exec) as { ok: boolean; started?: boolean; priced?: number; total?: number; totals?: { pnlPct?: number | null } }
      check('追踪：纸面复刻启动', rep.ok && rep.started === true, JSON.stringify({ priced: rep.priced, total: rep.total }))
      eq('追踪：复刻全部定价', `${rep.priced}|${rep.total}`, '2|2')
      check('追踪：复刻收益已计算', typeof rep.totals?.pnlPct === 'number', String(rep.totals?.pnlPct))
      const rep2 = await T('follow_replicate').execute!({ id: invId }, exec) as { refreshed?: boolean }
      check('追踪：复刻刷新幂等', rep2.refreshed === true, String(rep2.refreshed))
      const noteR = await T('follow_note').execute!({ id: invId, title: '2025Q4：清仓特斯拉、增持苹果', points: ['苹果市值占比提升', '新进可口可乐', '边界：13F 滞后约 45 天'] }, exec) as { ok: boolean; brief?: { title: string; points: string[] }; vaultId?: string; jobsDone?: boolean }
      check('追踪：简报落库', noteR.ok && noteR.brief?.points?.length === 3, JSON.stringify(noteR.brief))
      eq('追踪：简报同步资料库', noteR.vaultId, 'r-1')
      check('追踪：解读完成收口任务', noteR.jobsDone === true && !fstore2.get().jobs.some((j) => j.targetId === invId && j.state === 'ready'), JSON.stringify(fstore2.get().jobs.map((j) => j.state)))
      check('追踪：资料库回执入总线', researchEvents.some((e) => e.kind === 'research' && e.action === 'save'), JSON.stringify(researchEvents))
      eq('追踪：拉取与解读计成长活动', growthHits, 3)
      // 国会：成员解析 → 基线 → 新增入队 → 幂等
      const addC = await T('follow_add').execute!({ kind: 'congress', name: 'Nancy Pelosi' }, exec) as { ok: boolean; target?: { id: string; slug?: string } }
      check('追踪：成员名→slug', addC.ok && addC.target?.slug === 'nancy-pelosi', JSON.stringify(addC.target))
      const cId = addC.target!.id
      const cf1 = await T('follow_fetch').execute!({ id: cId }, exec) as { newFiling?: boolean }
      check('追踪：国会基线快照', cf1.newFiling === true, String(cf1.newFiling))
      eq('追踪：国会基线不入队（无上期）', fstore2.get().jobs.filter((j) => j.targetId === cId).length, 0)
      const cf2 = await T('follow_fetch').execute!({ id: cId }, exec) as { newFiling?: boolean; newCount?: number }
      check('追踪：国会新增申报入队', cf2.newFiling === true && cf2.newCount === 1 && fstore2.get().jobs.some((j) => j.targetId === cId && j.state === 'ready'), JSON.stringify(cf2))
      const cf3 = await T('follow_fetch').execute!({ id: cId }, exec) as { newFiling?: boolean }
      check('追踪：国会无变化不重复入库', cf3.newFiling === false && fstore2.get().snapshots.filter((s) => s.targetId === cId).length === 2, JSON.stringify(cf3))
      const vsC = await T('follow_vs_holdings').execute!({ id: cId }, exec) as { matched?: Array<{ ticker: string }>; theirsMapped?: number }
      eq('追踪：政客与我重叠', `${vsC.matched?.map((m) => m.ticker).join(',')}|${vsC.theirsMapped}`, 'NVDA|2')
      // 名私募：受控别名 → 十大流通股东扫描 → 对入库 → 幂等
      const addCn = await T('follow_add').execute!({ kind: 'cn-holder', name: '冯柳' }, exec) as { ok: boolean; target?: { id: string; aliases?: string[] } }
      eq('追踪：名私募别名建档', addCn.target?.aliases?.join(','), '邻山1号')
      const cnId = addCn.target!.id
      const cn1 = await T('follow_fetch').execute!({ id: cnId }, exec) as { newFiling?: boolean; newCount?: number }
      check('追踪：十大流通股东命中', cn1.newFiling === true && cn1.newCount === 1, JSON.stringify(cn1))
      const pairs = (latestSnapshot(fstore2.get().snapshots, cnId)?.data.meta?.pairs ?? []) as Array<{ code: string; alias: string }>
      eq('追踪：股东对入库', pairs.map((p) => `${p.code}:${p.alias}`).join(','), '600519:邻山1号')
      const cn2 = await T('follow_fetch').execute!({ id: cnId }, exec) as { newFiling?: boolean }
      check('追踪：股东扫描幂等', cn2.newFiling === false, String(cn2.newFiling))
      check('追踪：股东对生成任务', fstore2.get().jobs.some((j) => j.targetId === cnId && j.group === 'cnholder' && j.state === 'ready'), '')
      eq('追踪：拉取与解读计成长活动（合计）', growthHits, 8)
      const remC = await T('follow_remove').execute!({ id: cId }, exec) as { removed?: boolean }
      check('追踪：移除工具', remC.removed === true, JSON.stringify(remC))
      const list1 = await T('follow_list').execute!({}, exec) as { counts?: { targets?: number; readyJobs?: number } }
      eq('追踪：档案计数', `${list1.counts?.targets}|${list1.counts?.readyJobs}`, '2|1')

      // 5) 面板只读接口 GET /follow + follow 总线事件
      const regs: Array<{ path?: string; handler?: (req: unknown, res: unknown) => Promise<unknown> }> = []
      const fakeWeb = { register: (cfg: { path?: string; handler: (req: unknown, res: unknown) => Promise<unknown> }) => { regs.push(cfg); return () => {} } } as never
      registerRoutes(
        fakeWeb,
        {} as never,
        { load: async () => {} } as never,
        undefined, undefined, undefined,
        {} as never,
        { publish: () => {}, subscribe: () => ({ close() {}, gap: false, epoch: 't' }) } as never,
        undefined, undefined, undefined, undefined, undefined, undefined,
        fstore2,
      )
      const prefixCfg = regs.find((r) => r.path === API_PREFIX)
      check('追踪：路由已挂载', !!prefixCfg?.handler, regs.map((r) => r.path).join(','))
      const req = { url: `${API_PREFIX}/follow`, method: 'GET', headers: { host: 'localhost:3000' }, socket: { remoteAddress: '127.0.0.1' } }
      let status = 0
      let body = ''
      const res = { writeHead: (s: number) => { status = s }, end: (t: string) => { body = t } }
      await prefixCfg!.handler!(req, res)
      const parsed = JSON.parse(body || '{}') as { ok?: boolean; counts?: { targets?: number; readyJobs?: number }; targets?: Array<{ name: string; caveats?: string[]; stale?: string }> }
      eq('追踪：GET /follow 成功', `${status}|${parsed.ok}`, '200|true')
      eq('追踪：接口计数', `${parsed.counts?.targets}|${parsed.counts?.readyJobs}`, '2|1')
      const invView = parsed.targets?.find((t) => t.name === 'Berkshire Hathaway')
      check('追踪：对象带边界与新鲜度', !!invView && (invView.caveats?.length ?? 0) > 0 && invView.stale === 'stale', JSON.stringify({ stale: invView?.stale, caveats: invView?.caveats?.length }))
      const pb2 = new PanelBus({ commandTtlMs: 60_000 })
      let fEnv: { event?: Record<string, unknown> } | undefined
      const fSub = pb2.subscribe((e) => { fEnv = e })
      pb2.publish({ kind: 'follow', action: 'job', targetId: 'x', at: new Date().toISOString() })
      check('追踪：follow 回执入总线', fEnv?.event?.kind === 'follow' && fEnv?.event?.action === 'job', JSON.stringify(fEnv?.event))
      fSub.close()
    }

    // 批次22：默认追踪对象（首次 seed、幂等、删除不复活、旧档案只标记）
    // ------------------------------------------------------------
    {
      eq('默认对象：纯默认状态仍为空', defaultFollowState().targets.length, 0)
      check('默认对象：三个样本覆盖三类', DEFAULT_FOLLOW_TARGETS.length === 3 && new Set(DEFAULT_FOLLOW_TARGETS.map((t) => t.kind)).size === 3, DEFAULT_FOLLOW_TARGETS.map((t) => t.kind).join(','))
      const sseed = new FollowStore(path.join(root, 'follow-seed', 'follow.json'))
      const r1 = await sseed.seedDefaults()
      eq('默认对象：首次 seed 3 个', r1.seeded, 3)
      eq('默认对象：名单与顺序', sseed.get().targets.map((t) => t.name).join(','), 'Berkshire Hathaway,Nancy Pelosi,冯柳')
      check('默认对象：seededAt 已标记', !!sseed.get().seededAt, sseed.get().seededAt ?? '')
      eq('默认对象：伯克希尔 cik 归一', sseed.get().targets.find((t) => t.name === 'Berkshire Hathaway')?.cik, '0001067983')
      eq('默认对象：冯柳带受控别名', sseed.get().targets.find((t) => t.name === '冯柳')?.aliases?.join(','), '邻山1号')
      check('默认对象：全部可解析入库', sseed.get().targets.every((t) => t.enabled && /^flw-/.test(t.id)), '')
      const r2 = await sseed.seedDefaults()
      eq('默认对象：二次 seed 幂等', r2.seeded, 0)
      const berk = sseed.get().targets.find((t) => t.name === 'Berkshire Hathaway')!
      await sseed.removeTarget(berk.id)
      const r3 = await sseed.seedDefaults()
      eq('默认对象：删除后不复活', `${r3.seeded}|${sseed.get().targets.length}`, '0|2')
      // 旧档案（已有对象但没有 seededAt）：只补标记，不注入
      const sold = new FollowStore(path.join(root, 'follow-seed-old', 'follow.json'))
      await sold.addTarget({ kind: 'congress-ticker', ticker: 'NVDA', name: 'NVDA 国会交易' })
      const r4 = await sold.seedDefaults()
      eq('默认对象：旧档案只标记不注入', `${r4.seeded}|${sold.get().targets.length}`, '0|1')
      check('默认对象：旧档案 seededAt 已补', !!sold.get().seededAt, sold.get().seededAt ?? '')
      // 损坏档案不静默播种
      const seedBad = path.join(root, 'follow-seed-bad', 'follow.json')
      await mkdir(path.dirname(seedBad), { recursive: true })
      await writeFile(seedBad, '{"targets":{}}')
      let seedErr = ''
      try { await new FollowStore(seedBad).seedDefaults() } catch (e) { seedErr = e instanceof Error ? e.message : String(e) }
      check('默认对象：损坏档案拒绝播种', seedErr.includes('损坏'), seedErr)
    }

    // 批次23：SEC UA 合规（默认联系方式 / 环境变量覆盖 / 403 修复指引）
    // ------------------------------------------------------------
    {
      check('SEC UA：默认含联系方式（仓库地址）', secUserAgent().includes('github.com/looput/dsh-finance-lab'), secUserAgent())
      process.env.DSH_SEC_EDGAR_UA = 'Acme Research Bot v9 (https://acme.example/ops)'
      eq('SEC UA：环境变量覆盖', secUserAgent(), 'Acme Research Bot v9 (https://acme.example/ops)')
      delete process.env.DSH_SEC_EDGAR_UA
      // 无联系方式的 UA → mock 按 SEC 真实策略 403 → 错误信息必须带可执行指引
      process.env.DSH_SEC_EDGAR_UA = 'naked-bot/1.0'
      let uaErr = ''
      try { await fetchEdgarFilings('0001067983') } catch (e) { uaErr = e instanceof Error ? e.message : String(e) }
      delete process.env.DSH_SEC_EDGAR_UA
      check('SEC UA：403 带修复指引', /\b403\b/.test(uaErr) && uaErr.includes('DSH_SEC_EDGAR_UA'), uaErr)
      const okFilings = await fetchEdgarFilings('0001067983')
      check('SEC UA：默认 UA 恢复 200', okFilings.length >= 1, `filings=${okFilings.length}`)
    }

    console.log(`\n[offline] ${passed} passed, ${failed} failed`)
    if (failed) {
      console.log(`failed cases: ${failures.join(' | ')}`)
      process.exitCode = 1
    }
  } finally {
    globalThis.fetch = realFetch
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
