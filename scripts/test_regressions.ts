import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Confirmations, confirmations } from '../src/confirmations.js'
import { PortfolioStore } from '../src/store.js'
import { PanelBus, type PanelCommand } from '../src/panel-bus.js'
import { formatCursor, isStaleCommand, parseCursor } from '../src/panel-envelope.js'
import { HistoryStore } from '../src/history/store.js'
import { PersonalStore, weekKey, MAX_JOB_ATTEMPTS } from '../src/personal.js'
import { AnalysisStore, ANALYSIS_PROMPT_VERSION } from '../src/analysis-store.js'
import { registerTools } from '../src/tools/register.js'
import { evaluateThesis, factsFromF10, parseIndicators } from '../src/personal-eval.js'
import { ResearchVault, ResearchConfirmationRequired } from '../src/research/store.js'
import { routeCode, FinanceDataService } from '../src/data/service.js'
import { quoteCurrency } from '../src/valuation.js'
import { readBody } from '../src/server-routes.js'
import { buildLiveSnapshot } from '../src/live.js'

const dir = await mkdtemp(path.join(tmpdir(), 'finance-regressions-'))
let checks = 0
async function check(name: string, fn: () => unknown | Promise<unknown>) { await fn(); checks++; console.log(`PASS ${name}`) }
async function proposal(vault: ResearchVault, id: string, opinion: string) {
  try { await vault.update(id, { opinion }) } catch (e) { if (e instanceof ResearchConfirmationRequired) return e.preview; throw e }
  throw new Error('Expected confirmation')
}
try {
  await check('market classification / quote currency agree, no ticker prefix corruption', () => {
    for (const [code, market, currency, canonical] of [
      ['SHOP', '美股', 'USD', 'SHOP'], ['SHAK', '美股', 'USD', 'SHAK'], ['BJ', '美股', 'USD', 'BJ'],
      ['HKD', '美股', 'USD', 'HKD'], ['USB', '美股', 'USD', 'USB'], ['USFD', '美股', 'USD', 'USFD'],
      ['usAAPL', '美股', 'USD', 'AAPL'], ['sh600519', 'A股', 'CNY', '600519'], ['600519.SS', 'A股', 'CNY', '600519'],
      ['hk00700', '港股', 'HKD', '00700'], [' HK:700 ', '港股', 'HKD', '00700'], ['700', '港股', 'HKD', '00700'],
    ]) { assert.deepEqual(routeCode(code!), { code: canonical, market }); assert.equal(quoteCurrency(code!), currency) }
    assert.equal(routeCode('110022', 'fund').market, '基金')
  })
  await check('concurrent confirmations compare/apply once; snapshot cannot be mutated', async () => {
    const q = new Confirmations(); let value = { n: 1 }
    const first = q.propose('a', value, { n: 2 }, () => value, async () => { await new Promise(r => setTimeout(r, 10)); value = { n: 2 } })
    const second = q.propose('b', value, { n: 3 }, () => value, async () => { value = { n: 3 } })
    ;(first.before as { n: number }).n = 10
    const outcomes = await Promise.allSettled([q.confirm(first.id), q.confirm(second.id)])
    assert.deepEqual(outcomes.map(x => x.status), ['fulfilled', 'rejected']); assert.equal(value.n, 2)
    const next = q.propose('c', value, { n: 4 }, () => value, async () => { value = { n: 4 } }); await q.confirm(next.id)
    assert.equal(value.n, 4)
  })
  await check('portfolio loads once, concurrent updates preserved; external edits refuse overwrite', async () => {
    const file = path.join(dir, 'holdings.json'), store = new PortfolioStore(file)
    await Promise.all([store.load(), store.load(), store.load()])
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.upsertHolding({ code: `X${i}`, type: 'stock', quantity: 1, avgCost: 2 })))
    assert.equal(store.get().holdings.length, 20)
    const copy = store.get(); copy.holdings.length = 0; assert.equal(store.get().holdings.length, 20)
    const before = store.get(), raw = await readFile(file, 'utf8')
    await writeFile(file, raw + '\n')
    await assert.rejects(store.setHoldings([]), /外部修改/)
    assert.deepEqual(store.get(), before); assert.equal(await readFile(file, 'utf8'), raw + '\n')
    assert.ok(!(await readdir(dir)).some(f => f.endsWith('.tmp')))
  })
  await check('holdings removal requires confirmation; stale or missing targets are refused', async () => {
    const q = new Confirmations()
    const store = new PortfolioStore(path.join(dir, 'holdings-remove.json'), undefined, q)
    await store.load()
    await store.upsertHolding({ code: '600519', type: 'stock', quantity: 1, avgCost: 2 })
    await store.upsertHolding({ code: '000001', type: 'stock', quantity: 1, avgCost: 2 })
    const preview = store.previewRemoveHolding('600519')
    assert.equal(store.get().holdings.length, 2) // unconfirmed → not persisted
    assert.match(preview.label, /删除持仓 600519/)
    assert.equal((preview.before as unknown[]).length, 2)
    assert.equal((preview.after as unknown[]).length, 1)
    await q.confirm(preview.id)
    assert.deepEqual(store.get().holdings.map(h => h.code), ['000001'])
    // base changed after preview → confirmation must refuse, not delete
    const stale = store.previewRemoveHolding('000001')
    await store.upsertHolding({ code: 'AAPL', type: 'stock', quantity: 1, avgCost: 1 })
    await assert.rejects(q.confirm(stale.id), /变化/)
    assert.deepEqual(store.get().holdings.map(h => h.code).sort(), ['000001', 'AAPL'])
    assert.throws(() => store.previewRemoveHolding('MISSING'), /未找到/)
  })
  await check('panel bus envelopes are ordered; cursor replay catches up without duplicates', () => {
    const bus = new PanelBus({ commandTtlMs: 60_000 })
    assert.equal(parseCursor(formatCursor(bus.epoch, 7))?.seq, 7)
    assert.equal(parseCursor('bogus'), undefined)
    bus.publish({ kind: 'providers' }) // seq 1
    bus.publish({ kind: 'skills' }) // seq 2
    const seen: number[] = []
    const live = bus.subscribe((env) => seen.push(env.seq), { since: formatCursor(bus.epoch, 1) })
    assert.equal(live.gap, false)
    assert.deepEqual(seen, [2]) // replay is exclusive at the cursor
    bus.publish({ kind: 'mcp' }) // seq 3
    assert.deepEqual(seen, [2, 3])
    live.close()
    bus.publish({ kind: 'providers' }) // seq 4 while disconnected
    const resumed: number[] = []
    const again = bus.subscribe((env) => resumed.push(env.seq), { since: formatCursor(bus.epoch, 2) })
    assert.equal(again.gap, false)
    assert.deepEqual(resumed, [3, 4]) // missed seq 3 + live 4, no duplicate 2
    again.close()
    // server restart (foreign epoch) → gap flag + full buffer replay
    const old: number[] = []
    const restarted = bus.subscribe((env) => old.push(env.seq), { since: formatCursor('previous-epoch', 99) })
    assert.equal(restarted.gap, true)
    assert.deepEqual(old, [1, 2, 3, 4])
    restarted.close()
  })
  await check('trimmed replay buffer reports a gap; panel commands carry one-shot TTL', () => {
    const bus = new PanelBus({ replayLimit: 2, commandTtlMs: 1_000 })
    bus.publish({ kind: 'providers' })
    bus.publish({ kind: 'skills' })
    bus.publish({ kind: 'mcp' })
    bus.publish({ kind: 'reminder', count: 1, at: new Date().toISOString() })
    // buffer keeps only seq 3,4 — cursor at 1 missed seq 2
    const seen: number[] = []
    let gaps = 0
    const sub = bus.subscribe((env) => seen.push(env.seq), {
      since: formatCursor(bus.epoch, 1),
      onGap: () => { gaps++ },
    })
    assert.equal(sub.gap, true)
    assert.equal(gaps, 1) // gap marker fires before replay
    assert.deepEqual(seen, [3, 4])
    sub.close()
    const env = bus.publish({ kind: 'panel', command: { action: 'navigate', tab: 'dossier', code: '600519' } })
    const cmd = (env.event as { command: PanelCommand }).command
    assert.ok(cmd.commandId && cmd.issuedAt && cmd.expiresAt)
    assert.equal(isStaleCommand(cmd, Date.parse(cmd.issuedAt!)), false)
    assert.equal(isStaleCommand(cmd, Date.parse(cmd.expiresAt!)), true) // replayed after TTL → ignored
    assert.equal(isStaleCommand(undefined), false)
  })
  await check('history store keys by code+kind, migrates legacy files, refuses corrupt overwrite', async () => {
    const store = new HistoryStore(path.join(dir, 'history'))
    const good = { date: '2026-09-24', open: 10, high: 11, low: 9, close: 10.5, volume: 100 }
    // legacy code-only file migrates into the kinded key on first write
    await mkdir(path.join(dir, 'history'), { recursive: true })
    await writeFile(path.join(dir, 'history', 'LEG.json'), JSON.stringify({
      code: 'LEG', kind: 'a', updatedAt: '2026-01-01T00:00:00Z',
      kline: [{ date: '2026-09-23', open: 9, high: 10, low: 8, close: 9.5, volume: 50 }], events: [],
    }, null, 2))
    const legacy = await store.read('LEG')
    assert.equal(legacy?.adjustment, 'unknown') // migrated data readable but quarantined
    const m1 = await store.mergeKline('LEG', 'a', [good], { provider: 'test', adjustment: 'unknown' })
    assert.deepEqual(m1, { added: 1, rejected: 0 })
    assert.ok(!(await readdir(path.join(dir, 'history'))).includes('LEG.json')) // migrated away
    assert.equal((await store.read('LEG'))?.kline.length, 2)
    // same code, different kind: separate series (000001 股票与同代码基金不混库)
    await store.mergeKline('000001', 'a', [good])
    await store.mergeKline('000001', 'fund', [{ ...good, date: '2026-09-25' }])
    assert.equal((await store.list()).filter(s => s.code === '000001').length, 2)
    // invalid bars rejected, never zero-filled; same-date overwrite is not an add
    const r = await store.mergeKline('000001', 'a', [
      { date: '2026-09-26', open: 0, high: 0, low: 0, close: 0, volume: 0 },
      { date: 'bad', open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { date: '2026-09-27', open: 10, high: 9, low: 8, close: 9, volume: 1 }, // high < open
      good,
    ])
    assert.deepEqual(r, { added: 0, rejected: 3 })
    // explicit adjustment conflict refuses to mix series; unknown upgrades and never downgrades
    await store.mergeKline('MIX', 'a', [good], { adjustment: 'qfq' })
    await assert.rejects(store.mergeKline('MIX', 'a', [good], { adjustment: 'hfq' }), /复权口径不一致/)
    await store.mergeKline('MIX', 'a', [{ ...good, date: '2026-09-28' }])
    assert.equal((await store.read('MIX'))?.adjustment, 'qfq')
    // corrupt file: read/merge refuse and the bytes are preserved
    await writeFile(path.join(dir, 'history', 'BAD-a-day.json'), '{bad')
    await assert.rejects(store.read('BAD'), /损坏/)
    await assert.rejects(store.mergeKline('BAD', 'a', [good]), /损坏/)
    assert.equal(await readFile(path.join(dir, 'history', 'BAD-a-day.json'), 'utf8'), '{bad')
  })
  await check('history concurrent merges serialize: no lost bars, atomic writes', async () => {
    const store = new HistoryStore(path.join(dir, 'history-concurrent'))
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.mergeKline('X', 'a', [{
      date: `2026-01-${String(i + 1).padStart(2, '0')}`, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10,
    }])))
    assert.equal((await store.read('X'))?.kline.length, 20)
    assert.ok(!(await readdir(path.join(dir, 'history-concurrent'))).some(f => f.endsWith('.tmp')))
  })
  await check('structured thesis indicators evaluate deterministically; unknown metrics stay unverifiable', () => {
    const indicators = parseIndicators([
      { id: 'i1', metricKey: 'roe', label: 'ROE 保持 15% 以上', comparator: '>=', threshold: 15, unit: '%' },
      { id: 'i2', metricKey: 'custom_brand', label: '品牌力提升', comparator: '>', threshold: 0 },
      { id: 'i3', metricKey: 'revenue_yoy', label: '收入增速 10–30%', comparator: 'between', threshold: 10, threshold2: 30 },
    ], '验证指标')!
    const falsifiers = parseIndicators([{ id: 'f1', metricKey: 'net_profit_yoy', label: '利润增速转负', comparator: '<', threshold: 0 }], '证伪条件')!
    const checks = evaluateThesis(indicators, falsifiers, {
      roe: { value: 17.7, asOf: '2026-08-02', source: 'F10' },
      revenue_yoy: { value: 5, source: 'F10' },
    })
    assert.deepEqual(checks.map(c => [c.id, c.status]), [
      ['i1', 'satisfied'], ['i2', 'unverifiable'], ['i3', 'diverged'], ['f1', 'missing'],
    ])
    const facts = factsFromF10({
      financials: { rows: [{ reportPeriod: '2026-06-30', publishedAt: '2026-08-02', roeWeighted: 17.71 }] },
      holders: { rows: [{ reportPeriod: '2026-06-30', publishedAt: '2026-07-05', holderCount: 155000 }] },
    })
    assert.equal(facts.roe?.value, 17.71)
    assert.equal(facts.roe?.asOf, '2026-08-02') // 公告时点，不是抓取时点
    assert.equal(facts.holder_count?.value, 155000)
    assert.throws(() => parseIndicators([{ metricKey: 'roe', comparator: 'between', threshold: 5 }], '验证指标'), /threshold2/)
    assert.throws(() => parseIndicators([{ metricKey: 'roe', comparator: '><', threshold: 5 }], '验证指标'), /comparator/)
    assert.throws(() => parseIndicators([{ id: 'x', metricKey: 'roe', comparator: '>', threshold: 1 }, { id: 'x', metricKey: 'roe', comparator: '>', threshold: 2 }], '验证指标'), /重复/)
  })
  await check('weekly jobs: idempotent cards, lease recovery, bounded retries, previous context, gaps', async () => {
    const file = path.join(dir, 'personal-jobs.json')
    const store = new PersonalStore(file)
    await store.load()
    await store.profile({ goal: 'g', horizonMonths: 12, risk: 'low', maxDrawdownPct: 5, baseCurrency: 'CNY' })
    const t = store.thesis({ code: '600519', rationale: 'r', indicator: 'i', falsifier: 'f', indicators: [{ metricKey: 'roe', label: 'ROE≥15', comparator: '>=', threshold: 15 }] })
    await store.saveThesis(t)
    assert.throws(() => store.thesis({ ...t, rationale: 'r2' }), /修正理由/) // 修正必须写明理由
    const revised = store.thesis({ ...t, rationale: 'r2', changeReason: '依据新财报', indicators: [{ metricKey: 'roe', label: 'ROE≥15', comparator: '>=', threshold: 15 }] })
    assert.equal(revised.revision, t.revision + 1)
    assert.equal(revised.changeReason, '依据新财报')
    const dead = {
      getAutoQuote: async () => ({ ok: false, error: 'down' }),
      getStockNews: async () => ({ ok: false, error: 'down' }),
      westock: async () => ({ ok: false, error: 'down' }),
    } as never
    // 多入口并发触发只生成一张卡（job+card 幂等）
    const [a, b] = await Promise.all([store.prepare(dead), store.prepare(dead)])
    assert.equal(a.length, 1)
    assert.equal(b.length, 1)
    assert.equal(store.get().cards.filter(c => c.week === weekKey()).length, 1)
    const card = a[0]!
    assert.equal(card.checks?.[0]?.status, 'missing') // 取不到数→缺失，不猜值
    const jobs = store.listJobs()
    assert.equal(jobs.filter(j => j.cardType === 'evidence').length, 1)
    assert.equal(jobs.find(j => j.cardType === 'evidence')?.state, 'ready')
    assert.ok(jobs.some(j => j.cardType === 'interpretation' && j.requiresUser))
    await store.saveAgent(card.id, '上次报告内容', [0])
    await store.decide(card.id, 'keep', '维持原判断')
    await assert.rejects(store.decide(card.id, 'revise', '再改'), /不可覆盖/)
    // 模拟崩溃：running 租约过期 → 新实例重启恢复为 pending
    const t2 = store.thesis({ code: '000001', rationale: 'r', indicator: 'i', falsifier: 'f' })
    await store.saveThesis(t2)
    await store.ensureWeekJobs()
    const claimed = await (store as never as { claimNextEvidenceJob(w: string): Promise<{ key: string } | undefined> }).claimNextEvidenceJob(weekKey())
    assert.ok(claimed)
    await (store as never as { change(fn: (s: { jobs: Array<{ key: string; leaseUntil?: string }> }) => void): Promise<void> }).change((s) => {
      const j = s.jobs.find(x => x.key === claimed!.key)!
      j.leaseUntil = new Date(Date.now() - 1).toISOString()
    })
    const restarted = new PersonalStore(file)
    await restarted.load()
    assert.equal(restarted.listJobs().find(j => j.key === claimed!.key)?.state, 'pending') // 重启恢复
    // 有限重试：失败计数封顶后不再自动认领；手动 retry 重置（首认领已计 1 次）
    for (let i = 2; i <= MAX_JOB_ATTEMPTS; i++) {
      const j = await (restarted as never as { claimNextEvidenceJob(w: string): Promise<{ key: string; attempts: number } | undefined> }).claimNextEvidenceJob(weekKey())
      assert.ok(j, `attempt ${i}`)
      assert.equal(j.attempts, i)
      await (restarted as never as { finishEvidenceJob(k: string, p: Record<string, unknown>): Promise<void> }).finishEvidenceJob(j.key, { state: 'failed', error: 'boom' })
    }
    assert.equal(await (restarted as never as { claimNextEvidenceJob(w: string): Promise<unknown> }).claimNextEvidenceJob(weekKey()), undefined)
    await restarted.retryJob(claimed!.key)
    assert.ok(await (restarted as never as { claimNextEvidenceJob(w: string): Promise<unknown> }).claimNextEvidenceJob(weekKey()))
    // 上次报告/决定上下文跨周可追溯
    await (restarted as never as { buildCard(j: { key: string; week: string; thesisId: string; cardType: 'evidence'; state: 'running'; attempts: number }, f: unknown, v: unknown): Promise<unknown> }).buildCard({ key: 'job-x', week: '2029-01-07', thesisId: t.id, cardType: 'evidence', state: 'running', attempts: 1 }, dead, undefined)
    const later = restarted.get().cards.find(c => c.week === '2029-01-07')!
    assert.equal(later.previous?.cardId, card.id)
    assert.equal(later.previous?.decision?.action, 'keep')
    assert.ok((later.previous?.reportExcerpt ?? '').includes('上次报告内容'))
    // 停机缺口可见，不补造伪历史
    assert.ok(Array.isArray(restarted.weeklyGaps()))
  })
  const vault = new ResearchVault(path.join(dir, 'vault')); await vault.load()
  const item = await vault.create({ title: 'test', source: 'fixture', occurredAt: '2026-09-29', opinion: 'original', body: 'body' })
  await check('concurrent research notes and sync have no lost updates', async () => {
    await Promise.all([...Array.from({ length: 30 }, (_, i) => vault.addNote(item.id, `note ${i}`)), vault.syncFromDisk()])
    assert.equal(vault.find(item.id)?.notes.length, 30)
    assert.equal((await vault.readDoc(item)).notes.length, 30)
  })
  await check('research empty opinion remains cleared after sync; stale doc preview rejected', async () => {
    const p = await proposal(vault, item.id, '')
    await confirmations.confirm(p.id); await vault.syncFromDisk(); assert.equal(vault.find(item.id)?.opinion, '')
    const stale = await proposal(vault, item.id, 'new')
    const file = path.join(vault.dir, item.file), raw = await readFile(file, 'utf8')
    await writeFile(file, raw + '\nexternal text')
    await assert.rejects(confirmations.confirm(stale.id), /变化/)
    assert.equal(await readFile(file, 'utf8'), raw + '\nexternal text'); assert.equal(vault.find(item.id)?.opinion, '')
    await writeFile(file, raw)
  })
  await check('index write failure rolls back docs and memory; queue still works', async () => {
    const internal = vault as any, atomic = internal.atomic.bind(vault), before = vault.all(), raw = await readFile(path.join(vault.dir, item.file), 'utf8')
    internal.atomic = (file: string, body: string | null) => { if (file === vault.indexPath) throw new Error('injected index failure'); return atomic(file, body) }
    try {
      await assert.rejects(vault.addNote(item.id, 'must not remain'), /injected/)
      assert.deepEqual(vault.all(), before); assert.equal(await readFile(path.join(vault.dir, item.file), 'utf8'), raw)
      const files = await readdir(path.join(vault.dir, '2026'))
      await assert.rejects(vault.create({ title: 'rollback', source: 'test', occurredAt: '2026-09-29' }), /injected/)
      assert.deepEqual(await readdir(path.join(vault.dir, '2026')), files)
      await assert.rejects(vault.remove(item.id), /injected/)
      assert.equal(await readFile(path.join(vault.dir, item.file), 'utf8'), raw)
    } finally { internal.atomic = atomic }
    await vault.addNote(item.id, 'after failure'); assert.equal(vault.find(item.id)?.notes.at(-1)?.text, 'after failure')
  })
  await check('external metadata and index changes refuse overwrite', async () => {
    const file = path.join(vault.dir, item.file), raw = await readFile(file, 'utf8')
    await writeFile(file, raw.replace('title: test', 'title: external'))
    await assert.rejects(vault.update(item.id, { summary: 'overwrite' }), /同步|变化/)
    await writeFile(file, raw)
    const index = await readFile(vault.indexPath, 'utf8'), before = vault.all()
    await writeFile(vault.indexPath, index + '\n')
    await assert.rejects(vault.addNote(item.id, 'blocked'), /索引被外部修改/)
    assert.deepEqual(vault.all(), before)
    assert.equal(await readFile(file, 'utf8'), raw)
    await writeFile(vault.indexPath, index)
  })
  await check('rollback failure refuses future writes, corrupt index is not reseeded', async () => {
    const v = new ResearchVault(path.join(dir, 'rollback')); const it = await v.create({ title: 'x', source: 'x', occurredAt: '2026-09-29' })
    const internal = v as any, atomic = internal.atomic.bind(v); let calls = 0
    internal.atomic = (file: string, raw: string | null) => { calls++; if (calls > 1) throw new Error('fail index then rollback'); return atomic(file, raw) }
    await assert.rejects(v.addNote(it.id, 'new')); internal.atomic = atomic
    await assert.rejects(v.addNote(it.id, 'blocked'), /回滚失败/)
    await writeFile(v.indexPath, '{bad')
    await assert.rejects(new ResearchVault(v.dir).load()); assert.equal(await readFile(v.indexPath, 'utf8'), '{bad')
  })
  await check('JSON request body rejects null, arrays, primitives and oversize payloads', async () => {
    for (const body of ['null', '[]', '"text"', '1', '{bad', 'x'.repeat(1_048_577)]) await assert.rejects(readBody(Readable.from([Buffer.from(body)]) as never))
    assert.deepEqual(await readBody(Readable.from([Buffer.from('{"id":"ok"}')]) as never), { id: 'ok' })
  })
  const fakeRegistry = { call: async (cap: string, args: any) => cap === 'quotes_batch'
    ? { ok: true, provider: 'fixture', data: args.codes.map((code: string) => ({ code, price: 10 })) }
    : { ok: true, provider: 'fixture', data: { code: args.code, price: cap === 'fund_quote' ? 2 : NaN } } }
  const finance = new FinanceDataService(fakeRegistry as never, () => [{ code: '000001', type: 'stock', quantity: 1, avgCost: 1 }, { code: '000001', type: 'fund', quantity: 1, avgCost: 1 }], async () => {})
  await check('same-code stock/fund quotes and portfolio valuation remain separate', async () => {
    const batch = await finance.getQuotes([{ code: '000001', type: 'stock' }, { code: '000001', type: 'fund' }])
    assert.equal(batch.data?.length, 2); assert.deepEqual(batch.data?.map(q => [q.type, q.price]), [['stock', 10], ['fund', 2]])
    const result = await finance.analyzePortfolio()
    assert.deepEqual(result.holdings?.map(h => h.currentPrice), [10, 2]); assert.equal(result.summary?.totalValue, 12)
    const snapshot = await buildLiveSnapshot({
      getQuotes: finance.getQuotes.bind(finance), getAutoQuote: finance.getAutoQuote.bind(finance), getAutoKline: async () => ({ ok: false }),
      getMarketOverview: async () => ({ ok: false }), getHealth: () => ({ results: [] }), getStats: () => ({}), getWestockStatus: async () => ({}),
    } as never, [{ code: '000001', type: 'stock' }, { code: '000001', type: 'fund' }])
    assert.deepEqual(snapshot.quotes.map(q => q.price), [10, 2])
  })
  await check('weekly generation coalesces upstream requests and uses explicit fund type', async () => {
    const personal = new PersonalStore(path.join(dir, 'personal.json'))
    await personal.profile({ goal: 'long term', horizonMonths: 36, risk: 'low', maxDrawdownPct: 5, baseCurrency: 'CNY' })
    const t = personal.thesis({ code: '110022', type: 'fund', rationale: 'x', indicator: 'y', falsifier: 'z' }); await personal.saveThesis(t)
    let calls = 0
    const source = { getAutoQuote: async (_: string, __: unknown, type: string) => { calls++; assert.equal(type, 'fund'); return { ok: false } }, getStockNews: async () => ({ ok: false }) }
    await Promise.all([personal.prepare(source as never), personal.prepare(source as never)])
    assert.equal(calls, 1); assert.equal(personal.get().cards.length, 1)
    assert.equal(personal.thesis({ ...t, type: 'stock', changeReason: '测试类型修正' }).type, 'stock')
  })
  await check('deep-analysis versioning + reference contract (snapshot / thesis / previous report)', async () => {
    // 旧缓存格式迁移：单对象 → v1 + 一条历史
    const legacyFile = path.join(dir, 'analysis-legacy.json')
    await writeFile(legacyFile, JSON.stringify({ code: '600519', type: 'stock', report: '旧报告', generatedAt: '2025-01-01T00:00:00.000Z' }))
    const legacy = new AnalysisStore(legacyFile); await legacy.load()
    assert.equal(legacy.get('600519', 'stock')?.version, 1)
    assert.equal(legacy.revisions('600519', 'stock').length, 1)
    assert.equal(legacy.get('600519', 'stock')?.generatedAt, '2025-01-01T00:00:00.000Z')

    // 版本递增 / 历史追加 / promptVersion 契约版本
    const file = path.join(dir, 'analysis.json')
    const store = new AnalysisStore(file); await store.load()
    const v1 = await store.set({ code: '600519', type: 'stock', report: '报告一' })
    assert.equal(v1.version, 1); assert.equal(v1.promptVersion, ANALYSIS_PROMPT_VERSION)
    assert.ok(v1.reportId)
    const v2 = await store.set({ code: '600519', type: 'stock', report: '报告二' })
    assert.equal(v2.version, 2)
    assert.equal(store.get('600519', 'stock')?.report, '报告二')
    assert.deepEqual(store.revisions('600519', 'stock').map(a => a.report), ['报告一', '报告二'])
    assert.equal(store.hasReportId(v1.reportId), true)
    assert.equal(store.hasReportId('rep_nope'), false)

    // 快照登记与存在性（含标的归属校验）
    const snap = 'a'.repeat(32)
    await store.noteSnapshot(snap, '600519', 'stock')
    assert.equal(store.hasSnapshot(snap, '600519', 'stock'), true)
    assert.equal(store.hasSnapshot(snap, '000001', 'stock'), false)
    assert.equal(store.hasSnapshot('b'.repeat(32)), false)

    // save_position_analysis 引用契约：存在性校验（证明引用有效，不证明语义真实）
    const tools: Record<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }> = {}
    const ctx = { tools: { register: (t: { name: string }) => { tools[t.name] = t as never } }, effect: () => () => {} }
    const personal = { get: () => ({ theses: [{ code: '600519', type: 'stock', revision: 3 }] }) }
    registerTools(ctx as never, {} as never, {} as never, store, { emit: () => {} } as never, personal as never)
    const save = tools['save_position_analysis']!

    // 合法引用通过并原样回显
    const ok = await save.execute({ code: '600519', type: 'stock', report: '带引用的报告', dossierSnapshotId: snap, thesisRevision: 3, previousReportId: v2.reportId }) as { ok: boolean; refs: Record<string, unknown> }
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.refs, { dossierSnapshotId: snap, thesisRevision: 3, previousReportId: v2.reportId })

    // 快照不存在 / 原判断版本越界 / 上次报告 id 不在历史 → 拒绝保存
    assert.equal(((await save.execute({ code: '600519', type: 'stock', report: 'x', dossierSnapshotId: 'b'.repeat(32) })) as { ok: boolean }).ok, false)
    assert.equal(((await save.execute({ code: '600519', type: 'stock', report: 'x', thesisRevision: 99 })) as { ok: boolean }).ok, false)
    assert.equal(((await save.execute({ code: '600519', type: 'stock', report: 'x', previousReportId: 'rep_nope' })) as { ok: boolean }).ok, false)
    assert.equal(((await save.execute({ code: '600519', type: 'stock', report: 'x', thesisRevision: 0 })) as { ok: boolean }).ok, false)
    // 上一版本（revision-1）可接受；无原判断的标的不许带版本
    assert.equal(((await save.execute({ code: '600519', type: 'stock', report: 'y', thesisRevision: 2 })) as { ok: boolean }).ok, true)
    assert.equal(((await save.execute({ code: '000001', type: 'stock', report: 'z', thesisRevision: 1 })) as { ok: boolean }).ok, false)

    // 校验不通过 → 报告不落盘
    const before = store.revisions('600519', 'stock').length
    await save.execute({ code: '600519', type: 'stock', report: '不应保存', thesisRevision: 99 })
    assert.equal(store.revisions('600519', 'stock').length, before)

    // 重载：版本/历史/promptVersion 一致
    const reloaded = new AnalysisStore(file); await reloaded.load()
    assert.equal(reloaded.revisions('600519', 'stock').length, before)
    assert.equal(reloaded.get('600519', 'stock')?.promptVersion, ANALYSIS_PROMPT_VERSION)
  })
  console.log(`\n${checks} regression groups passed`)
} finally { await rm(dir, { recursive: true, force: true }) }
