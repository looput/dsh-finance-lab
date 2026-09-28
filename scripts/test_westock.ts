#!/usr/bin/env npx tsx
/**
 * 数据源可用性测试（真实网络，允许失败但必须标注原因）——WeStock CLI。
 *
 *   npx tsx scripts/test_westock.ts
 *
 * 与 scripts/test_offline.ts 的区别：这里真的调用 `westock` 二进制与腾讯自选股
 * 网关。失败是允许的（二进制未安装 / 网络不通 / 上游限频），但必须打印原因，
 * 且不能让进程崩溃。功能正确性请以离线测试为准。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { WESTOCK_SPECS } from '../src/data/westock-capabilities.ts'
import path from 'node:path'
import { configureWestock, westockStatus, westockProviders, westockReportDetail } from '../src/data/westock.ts'
import { ProviderRegistry } from '../src/data/registry.ts'
import { FinanceDataService } from '../src/data/service.ts'

interface CaseResult { ok: boolean; info?: string; reason?: string }
interface TestCase { label: string; run: (f: FinanceDataService) => Promise<CaseResult> }

const ctx = { timeoutMs: 25_000 }

const CASES: TestCase[] = [
  {
    label: 'westock CLI 可用性与版本',
    run: async () => {
      const s = await westockStatus()
      return s.available
        ? { ok: true, info: `${s.version} · ${s.binPath}` }
        : { ok: false, reason: `CLI 不可用：${s.error ?? '未找到二进制'}（binPath=${s.binPath}）` }
    },
  },
  {
    label: 'quote A股 600519',
    run: async () => quote(await westockProviders.quote({ code: '600519' }, ctx)),
  },
  {
    label: 'quote 港股 00700',
    run: async () => quote(await westockProviders.hkQuote({ code: '00700' }, ctx)),
  },
  {
    label: 'quote 美股 AAPL',
    run: async () => quote(await westockProviders.usQuote({ code: 'AAPL' }, ctx)),
  },
  {
    label: 'kline A股 600519 (30 根)',
    run: async () => kline(await westockProviders.kline({ code: '600519', days: 30 }, ctx)),
  },
  {
    label: 'kline 港股 00700',
    run: async () => kline(await westockProviders.hkKline({ code: '00700', days: 20 }, ctx)),
  },
  {
    label: 'kline 美股 MSFT',
    run: async () => kline(await westockProviders.usKline({ code: 'MSFT', days: 20 }, ctx)),
  },
  {
    label: 'search 腾讯（跨市场解析）',
    run: async () => {
      const r = await westockProviders.search({ query: '腾讯' }, ctx)
      const rows = r.rows as Array<{ code: string; market: string }>
      return rows.length
        ? { ok: true, info: `n=${rows.length} top=${rows[0]!.code}(${rows[0]!.market})` }
        : { ok: false, reason: 'empty result' }
    },
  },
  {
    label: 'report list 600519（研报）',
    run: async () => {
      const r = await westockProviders.research({ code: '600519', size: 5 }, ctx)
      const rows = r.rows as Array<{ title: string; org?: string; time: string }>
      return rows.length
        ? { ok: true, info: `n=${rows.length} top="${rows[0]!.title.slice(0, 40)}" org=${rows[0]!.org ?? '-'} ${rows[0]!.time}` }
        : { ok: false, reason: 'empty result' }
    },
  },
  {
    label: 'report detail 研报正文',
    run: async () => {
      const list = await westockProviders.research({ code: '600519', size: 1 }, ctx)
      const first = (list.rows as Array<{ id: string }>)[0]
      if (!first) return { ok: false, reason: '列表为空，无法取 id' }
      const detail = await westockReportDetail(first.id, ctx)
      return detail.body.length > 100
        ? { ok: true, info: `id=${first.id} bytes=${detail.body.length}` }
        : { ok: false, reason: `正文过短 (${detail.body.length}B)` }
    },
  },
  {
    label: 'news list 600519（资讯）',
    run: async () => {
      const r = await westockProviders.news({ code: '600519', size: 5 }, ctx)
      const rows = r.rows as Array<{ title: string }>
      return rows.length ? { ok: true, info: `n=${rows.length} top="${rows[0]!.title.slice(0, 30)}"` } : { ok: false, reason: 'empty result' }
    },
  },
  {
    label: 'finance 600519（三大报表）',
    run: async () => {
      const r = await westockProviders.financials({ code: '600519' }, ctx)
      return (r.rows as unknown[]).length ? { ok: true, info: `rows=${(r.rows as unknown[]).length}` } : { ok: false, reason: 'empty result' }
    },
  },
  {
    label: 'profile 600519（公司简况）',
    run: async () => {
      const r = await westockProviders.profile({ code: '600519' }, ctx)
      const info = r.data as { industry?: string; name?: string }
      return info?.name ? { ok: true, info: `${info.name} · ${info.industry ?? '-'}` } : { ok: false, reason: 'empty result' }
    },
  },
  {
    label: 'registry → quote（westock 优先，失败回落）',
    run: async (f) => {
      const r = await f.getRealtimeQuote('600519')
      return r.ok
        ? { ok: true, info: `provider=${r.provider} price=${(r.data as { price?: number })?.price}` }
        : { ok: false, reason: `${r.error} · attempts=${(r.attempts ?? []).map((a) => a.provider).join('/')}` }
    },
  },
  {
    label: 'registry → research_report（经 FinanceDataService）',
    run: async (f) => {
      const r = await f.getResearchReports('600519', 3)
      return r.ok
        ? { ok: true, info: `provider=${r.provider} n=${(r.data as unknown[])?.length}` }
        : { ok: false, reason: r.error }
    },
  },
]

function quote(r: { data?: unknown }): CaseResult {
  const q = r.data as { code?: string; name?: string; price?: number; changePercent?: number } | undefined
  return q?.price != null
    ? { ok: true, info: `${q.name ?? ''}(${q.code}) price=${q.price} ${q.changePercent ?? '-'}%` }
    : { ok: false, reason: 'no price in response' }
}

function kline(r: { rows?: unknown }): CaseResult {
  const bars = (r.rows ?? []) as Array<{ date: string; close: number }>
  return bars.length
    ? { ok: true, info: `bars=${bars.length} last=${bars.at(-1)!.date}@${bars.at(-1)!.close}` }
    : { ok: false, reason: 'empty kline' }
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-finance-westock-'))
  try {
    configureWestock({ enabled: true, binPath: process.env.WESTOCK_BIN ?? '', timeoutMs: 25_000, autoUpgrade: false })
    const registry = new ProviderRegistry({
      cacheTtlSec: 60,
      requestGapMs: 300,
      httpTimeoutMs: 25_000,
      probeReportPath: path.join(root, 'probe.json'),
      packageRoot: root,
      dataDir: root,
    })
    const finance = new FinanceDataService(registry, () => [], async () => {})

    let ok = 0
    for (const c of CASES) {
      const started = Date.now()
      let res: CaseResult
      try {
        res = await c.run(finance)
      } catch (err) {
        res = { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
      const ms = `${Date.now() - started}ms`.padStart(7)
      console.log(`  [${res.ok ? 'OK  ' : 'FAIL'}] ${c.label.padEnd(34)} ${ms}  ${res.ok ? (res.info ?? '') : (res.reason ?? 'unavailable')}`)
      if (res.ok) ok++
    }
    console.log(`\n[westock] 精选用例 ${ok}/${CASES.length} 可用（真实网络；失败项已标注原因，不视为功能缺陷）`)

    // ---- 能力全量扫描：遍历能力目录，真实调用每一个 spec ----
    console.log('\n== capability sweep（遍历全部 WeStock 能力）==')
    let swept = 0
    let byGroup: Record<string, { ok: number; fail: number }> = {}
    const failures: string[] = []
    for (const spec of WESTOCK_SPECS) {
      const started = Date.now()
      try {
        const r = await finance.westock(spec.capability, { ...spec.sampleArgs })
        const rows = Array.isArray(r.data) ? r.data : r.data ? [r.data] : []
        const good = r.ok && rows.length > 0
        const g = (byGroup[spec.group] ??= { ok: 0, fail: 0 })
        good ? g.ok++ : g.fail++
        if (good) swept++
        else failures.push(`${spec.id}(${spec.capability}): ${r.error ?? 'empty'}`)
        const ms = `${Date.now() - started}ms`.padStart(7)
        console.log(`  [${good ? 'OK  ' : 'FAIL'}] ${spec.id.padEnd(22)} ${spec.capability.padEnd(20)} ${ms}  ${good ? `rows=${rows.length}` : (r.error ?? 'empty')}`)
      } catch (err) {
        const g = (byGroup[spec.group] ??= { ok: 0, fail: 0 })
        g.fail++
        const reason = err instanceof Error ? err.message : String(err)
        failures.push(`${spec.id}: ${reason}`)
        console.log(`  [FAIL] ${spec.id.padEnd(22)} ${spec.capability.padEnd(20)}       ${reason}`)
      }
    }
    console.log('\n  分组汇总：')
    for (const [g, v] of Object.entries(byGroup)) console.log(`    ${g.padEnd(6)} OK=${v.ok} FAIL=${v.fail}`)
    if (failures.length) {
      console.log('  失败明细：')
      for (const f of failures) console.log(`    - ${f.slice(0, 120)}`)
    }
    console.log(`\n[westock] 能力扫描 ${swept}/${WESTOCK_SPECS.length} 可用`)

    // ---- 通用 CLI 桥（目录外子命令）----
    console.log('\n== raw bridge ==')
    const raw = await finance.westockRaw(['search', '腾讯', '--type', 'index'])
    console.log(`  [${raw.ok ? 'OK  ' : 'FAIL'}] westock search 腾讯 --type index  ${raw.ok ? `rows=${raw.data?.rows.length ?? 0}` : raw.error}`)
    const blocked = await finance.westockRaw(['update'])
    console.log(`  [${blocked.ok ? 'FAIL' : 'OK  '}] 拒绝非只读命令 westock update  ${blocked.ok ? '未拦截' : blocked.error}`)

    console.log('\n提示：未安装 CLI 时执行 `npm run westock:install`；网络受限/上游限频/参数组合不被支持会导致 FAIL。')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
