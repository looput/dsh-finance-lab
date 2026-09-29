import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PersonalStore, validateProfile, weekKey } from '../src/personal.js'
import { Confirmations, confirmations } from '../src/confirmations.js'
import { PortfolioStore } from '../src/store.js'
import { ResearchVault } from '../src/research/store.js'
import { valuation, quoteCurrency } from '../src/valuation.js'
import { accessError } from '../src/api-security.js'

const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-personal-'))
try {
  assert.throws(() => validateProfile({ goal: '退休', horizonMonths: 0 }))
  assert.equal(weekKey(new Date('2026-09-27T23:59:59Z')), '2026-09-21')
  assert.equal(weekKey(new Date('2026-09-28T00:00:00Z')), '2026-09-28')
  const profile = { goal: '退休资金', horizonMonths: 120, risk: 'medium', maxDrawdownPct: 15, baseCurrency: 'CNY' }
  const store = new PersonalStore(path.join(dir, 'personal.json')); await store.load(); await store.profile(profile)
  const t = store.thesis({ code: '600519', rationale: '盈利改善', indicator: '下季营收同比超过10%', falsifier: '毛利率低于50%' }); await store.saveThesis(t)
  const finance = { getAutoQuote: async () => ({ ok: false, error: 'offline' }), getStockNews: async () => ({ ok: false, error: 'offline' }) }
  await Promise.all([store.prepare(finance as never), store.prepare(finance as never)])
  assert.equal(store.get().cards.length, 1)
  const c = store.get().cards[0]!; assert.ok(c.missing.includes('行情获取失败'))
  await assert.rejects(store.saveAgent(c.id, '报告', [99]))
  await store.saveAgent(c.id, '原判断仍待验证；行情缺失，暂缓结论 [0]', [0])
  await assert.rejects(store.decide(c.id, 'keep', ''))
  await store.decide(c.id, 'defer', '证据0缺失，不能验证营收指标')
  await assert.rejects(store.decide(c.id, 'keep', '覆盖历史'))
  await assert.rejects(store.saveAgent(c.id, '覆盖报告', [0]))
  assert.equal(store.metrics().consecutiveWeeks, 1)
  const changed = store.thesis({ ...t, rationale: '修正理由' }); await store.saveThesis(changed)
  assert.equal(store.get().history[0]?.rationale, '盈利改善')
  assert.equal(store.get().cards[0]?.thesis.revision, 1)
  const loaded = new PersonalStore(path.join(dir, 'personal.json')); await loaded.load(); assert.deepEqual(loaded.get(), store.get())
  assert.equal((await stat(path.join(dir, 'personal.json'))).mode & 0o777, 0o600)
  const queue = new Confirmations(); let value = 1
  const proposal = queue.propose('test', 1, 2, () => value, async () => { value = 2 }); assert.equal(value, 1)
  await queue.confirm(proposal.id); assert.equal(value, 2); await assert.rejects(queue.confirm(proposal.id))
  const stale = queue.propose('test', 2, 3, () => value, async () => { value = 3 }); value = 4; await assert.rejects(queue.confirm(stale.id)); assert.equal(value, 4)
  const portfolio = new PortfolioStore(path.join(dir, 'portfolio.json')); await portfolio.load()
  const preview = portfolio.previewHoldings([{ code: '600519', type: 'stock', quantity: 100, avgCost: 10 }]); assert.equal(portfolio.get().holdings.length, 0)
  await confirmations.confirm(preview.id); assert.equal(portfolio.get().holdings.length, 1)
  assert.throws(() => portfolio.previewHoldings([{ code: 'AAPL', type: 'stock', quantity: NaN, avgCost: 1 }]))
  await writeFile(path.join(dir, 'corrupt.json'), '{bad'); await assert.rejects(new PortfolioStore(path.join(dir, 'corrupt.json')).load()); assert.equal(await readFile(path.join(dir, 'corrupt.json'), 'utf8'), '{bad')
  const vault = new ResearchVault(path.join(dir, 'research')); await vault.load()
  const item = await vault.create({ title: '观点', source: '个人', occurredAt: '2026-09-29', opinion: '原判断' })
  await assert.rejects(vault.update(item.id, { opinion: '新判断' }), /首页/)
  const pending = confirmations.list().find(p => p.label === '修改资料观点')!; await confirmations.confirm(pending.id)
  assert.equal(vault.list({})[0]?.opinion, '新判断'); assert.ok(vault.list({})[0]?.notes.some(n => n.text.includes('原判断')))
  const rows = [{ code: 'AAPL', quantity: 2, avgCost: 10, price: 12, currency: 'USD' as const }]
  assert.equal(valuation(rows).consolidated?.profit, 4)
  assert.equal(valuation([...rows, { code: '600519', quantity: 1, avgCost: 1, price: 2, currency: 'CNY' }]).consolidated, null)
  assert.equal(valuation([{ ...rows[0]!, price: undefined }]).consolidated?.value, null)
  assert.equal(quoteCurrency('600519.SH'), 'CNY'); assert.equal(quoteCurrency('00700.HK'), 'HKD')
  const req = (host: string, remoteAddress: string, origin?: string) => ({ headers: { host, origin }, socket: { remoteAddress } }) as never
  assert.equal(accessError(req('localhost:3000', '127.0.0.1')), undefined)
  assert.ok(accessError(req('evil.example', '127.0.0.1')))
  assert.ok(accessError(req('localhost:3000', '10.0.0.2')))
  assert.ok(accessError(req('localhost:3000', '127.0.0.1', 'https://evil.example')))
  assert.equal(accessError(req('finance.example', '10.0.0.2', 'https://finance.example'), 'https://finance.example'), undefined)
  console.log('PASS: profile, weekly deduplication, evidence, history, decisions, confirmation/conflict/replay, permissions, corrupt-file preservation, currencies and access boundary')
} finally { await rm(dir, { recursive: true, force: true }) }
