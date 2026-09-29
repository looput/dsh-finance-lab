import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Confirmations, confirmations } from '../src/confirmations.js'
import { PortfolioStore } from '../src/store.js'
import { ResearchVault, ResearchConfirmationRequired } from '../src/research/store.js'
import { PersonalStore } from '../src/personal.js'
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
    assert.equal(personal.thesis({ ...t, type: 'stock' }).type, 'stock')
  })
  console.log(`\n${checks} regression groups passed`)
} finally { await rm(dir, { recursive: true, force: true }) }
