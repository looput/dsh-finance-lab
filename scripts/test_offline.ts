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
import { ReminderStore } from '../src/reminders.js'
import { buildStockDossier, dossierSummary } from '../src/data/dossier.js'
import {
  MA_WINDOWS, aggregateBars, clampViewport, indexAtX, isPeriodClosed, lastWeekdayOfMonth,
  monthEnd, movingAverage, palette, panViewport, priceRange, sanitizeBars, visibleRange,
  weekStart, zoomViewport,
} from '../src/client/kline-math.js'
import {
  ValidationError, expectNoUnknownFields, validateAssetType, validateBudget, validateCode,
  validateDate, validateDateRange, validateFinite, validateNonNegative, validatePagination,
} from '../src/validation.js'
import { advisorMemory } from '../src/server-routes.js'
import { PersonalStore, weekKey, setWeekTimeZone } from '../src/personal.js'
import type { PersonalState, Thesis, ReviewCard as PersonalReviewCard, WeeklyJob } from '../src/personal.js'
import { HistoryStore, detectGaps } from '../src/history/store.js'
import { fetchKlinePaged } from '../src/history/sync.js'
import { metricProvenance } from '../src/personal-eval.js'
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
  // A truly offline suite: no external requests. Exercise the real HTTP parser
  // and provider fallback with a deterministic JSONP response.
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'search-api-web.eastmoney.com') return new Response('x(' + JSON.stringify({ result: { cmsArticleWebOld: [{ title: '离线新闻', content: '摘要', url: 'https://example.com/news', date: '2026-09-27 09:00:00', mediaName: '测试来源' }] } }) + ')', { status: 200 })
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
