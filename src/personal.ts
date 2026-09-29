import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FinanceDataService } from './data/service.js'
import { routeCode } from './data/route-code.js'
import type { AssetType } from './types.js'
import type { ResearchVault } from './research/store.js'

export interface InvestorProfile { goal: string; horizonMonths: number; risk: 'low' | 'medium' | 'high'; maxDrawdownPct: number; baseCurrency: 'CNY' | 'HKD' | 'USD'; updatedAt: string }
export interface Thesis { id: string; code: string; type?: AssetType; rationale: string; indicator: string; falsifier: string; updatedAt: string; revision: number }
export interface Evidence { source: string; sourceUrl?: string; occurredAt: string | null; retrievedAt: string; text: string; missing: string[] }
export interface ReviewCard { id: string; week: string; generatedAt: string; thesis: Thesis; evidence: Evidence[]; missing: string[]; agent?: { report: string; evidenceIndexes: number[]; at: string }; decision?: { action: 'keep' | 'revise' | 'defer'; reason: string; at: string } }
export interface PersonalState { startedAt: string; profile?: InvestorProfile; theses: Thesis[]; history: Thesis[]; cards: ReviewCard[] }
export function weekKey(date = new Date()) {
  const d = new Date(date); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7)
  return d.toISOString().slice(0, 10)
}
function required(v: unknown, name: string) { if (typeof v !== 'string' || !v.trim() || v.length > 10000) throw new Error(`${name}必填且不得超过10000字`); return v.trim() }
export function validateProfile(v: Record<string, unknown>): InvestorProfile {
  if (!Number.isInteger(v.horizonMonths) || Number(v.horizonMonths) < 1 || Number(v.horizonMonths) > 1200) throw new Error('投资期限须为1–1200个月')
  if (!['low', 'medium', 'high'].includes(String(v.risk))) throw new Error('请选择风险承受能力')
  if (typeof v.maxDrawdownPct !== 'number' || !Number.isFinite(v.maxDrawdownPct) || v.maxDrawdownPct < 0 || v.maxDrawdownPct > 100) throw new Error('可承受回撤须为0–100%')
  if (!['CNY', 'HKD', 'USD'].includes(String(v.baseCurrency))) throw new Error('请选择基准币种')
  return { goal: required(v.goal, '目标'), horizonMonths: Number(v.horizonMonths), risk: v.risk as InvestorProfile['risk'], maxDrawdownPct: v.maxDrawdownPct, baseCurrency: v.baseCurrency as InvestorProfile['baseCurrency'], updatedAt: new Date().toISOString() }
}
export class PersonalStore {
  private state: PersonalState = { startedAt: new Date().toISOString(), theses: [], history: [], cards: [] }
  private ready?: Promise<void>
  private preparation?: Promise<ReviewCard[]>
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private file: string) {}
  async load() {
    this.ready ??= (async () => {
      try { const data = JSON.parse(await readFile(this.file, 'utf8')); if (!Array.isArray(data.theses) || !Array.isArray(data.cards) || !Array.isArray(data.history)) throw new Error('个人档案文件损坏，拒绝覆盖'); this.state = data }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    })()
    await this.ready
  }
  get() { return structuredClone(this.state) }
  private async change(fn: (s: PersonalState) => void) {
    const task = this.queue.then(async () => {
      await this.load(); const next = this.get(); fn(next)
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${randomUUID()}.tmp`
      await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(tmp, this.file); this.state = next
    })
    this.queue = task.catch(() => {}); await task
  }
  async profile(v: Record<string, unknown>) { const profile = validateProfile(v); await this.change(s => { s.profile = profile }); return profile }
  thesis(v: Record<string, unknown>): Thesis {
    if (!this.state.profile) throw new Error('请先完成建档')
    const old = this.state.theses.find(t => t.id === v.id)
    if (v.type !== undefined && v.type !== 'stock' && v.type !== 'fund') throw new Error('无效标的类型')
    const type: AssetType = v.type === undefined ? old?.type ?? 'stock' : v.type as AssetType
    const rawCode = required(v.code, '标的')
    if (!/^[A-Za-z0-9][A-Za-z0-9.:-]{0,31}$/.test(rawCode)) throw new Error('请输入有效标的代码')
    const code = routeCode(rawCode, type).code
    if (v.id && !old) throw new Error('观点不存在')
    return { id: old?.id ?? randomUUID(), code, type, rationale: required(v.rationale, '投资理由'), indicator: required(v.indicator, '验证指标及阈值'), falsifier: required(v.falsifier, '证伪条件'), revision: (old?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }
  }
  async saveThesis(t: Thesis) { await this.change(s => { const old = s.theses.find(x => x.id === t.id); if (t.revision !== (old?.revision ?? 0) + 1) throw new Error('观点版本冲突'); if (old) s.history.push(old); s.theses = [...s.theses.filter(x => x.id !== t.id), t] }) }
  async prepare(finance: FinanceDataService, vault?: ResearchVault): Promise<ReviewCard[]> {
    this.preparation ??= this.prepareOnce(finance, vault).finally(() => { this.preparation = undefined })
    return structuredClone(await this.preparation)
  }
  private async prepareOnce(finance: FinanceDataService, vault?: ResearchVault) {
    await this.load()
    if (vault) await vault.load()
    if (!this.state.profile) throw new Error('请先完成建档')
    const week = weekKey()
    for (const thesis of this.get().theses) {
      if (this.state.cards.some(c => c.week === week && c.thesis.id === thesis.id)) continue
      const now = new Date().toISOString()
      const evidence: Evidence[] = []
      try {
        const q = await finance.getAutoQuote(thesis.code, undefined, thesis.type ?? 'stock')
        evidence.push({ source: q.provider || '行情接口（来源缺失）', occurredAt: null, retrievedAt: new Date().toISOString(), text: q.ok ? JSON.stringify(q.data ?? {}) : String(q.error), missing: q.ok && typeof q.data?.price === 'number' && Number.isFinite(q.data.price) ? ['行情时间缺失'] : ['行情获取失败'] })
      } catch { evidence.push({ source: '行情接口', occurredAt: null, retrievedAt: now, text: '行情不可用', missing: ['行情获取失败'] }) }
      try {
        const news = await finance.getStockNews(thesis.code, 8)
        if (news.ok && Array.isArray(news.data) && news.data.length) {
          for (const row of news.data) {
            if (!row || typeof row !== 'object') continue
            const n = row as Record<string, unknown>
            const rawDate = String(n.time ?? n.date ?? n.publishedAt ?? '')
            const date = /^\d{4}-\d{2}-\d{2}/.test(rawDate) && Number.isFinite(Date.parse(rawDate)) ? rawDate : ''
            evidence.push({ source: `${String(n.source ?? n.src ?? news.provider ?? '新闻来源缺失')}${news.provider ? ` (${news.provider})` : ''}`, sourceUrl: typeof n.url === 'string' ? n.url : undefined, occurredAt: date || null, retrievedAt: new Date().toISOString(), text: JSON.stringify(n), missing: date ? [] : ['新闻发布时间缺失'] })
          }
        } else evidence.push({ source: news.provider ?? '新闻接口', occurredAt: null, retrievedAt: now, text: news.error ?? '没有可用新资讯', missing: ['在线新资料缺失'] })
      } catch { evidence.push({ source: '新闻接口', occurredAt: null, retrievedAt: now, text: '获取失败', missing: ['在线新资料获取失败'] }) }
      const research = vault?.list({ code: thesis.code, limit: 20 }) ?? []
      for (const r of research) evidence.push({ source: r.source, sourceUrl: r.sourceUrl, occurredAt: r.occurredAt || null, retrievedAt: now, text: `${r.title}\n${r.summary ?? ''}\n${r.opinion ?? ''}`, missing: r.missing ? ['资料正文缺失'] : [] })
      const missing = [...new Set(evidence.flatMap(e => e.missing))]
      if (!research.length) missing.push('关联投研资料缺失')
      if (!research.some(r => Date.parse(r.occurredAt) >= Date.parse(week) && Date.parse(r.occurredAt) <= Date.now())) missing.push('本周关联资料库新资料缺失（在线资讯另列）')
      missing.push('验证指标须由Agent逐项查证；价格变化不等于观点成立或证伪')
      const card: ReviewCard = { id: randomUUID(), week, generatedAt: new Date().toISOString(), thesis, evidence, missing }
      await this.change(s => { if (!s.cards.some(c => c.week === week && c.thesis.id === thesis.id)) s.cards.push(card) })
    }
    return this.get().cards.filter(c => c.week === week)
  }
  async saveAgent(id: string, report: string, indexes: number[]) {
    required(report, '复盘报告')
    await this.change(s => { const c = s.cards.find(x => x.id === id); if (!c) throw new Error('卡片不存在'); if (c.decision) throw new Error('已复核卡片不可覆盖'); if (!Array.isArray(indexes) || !indexes.length || indexes.some(i => !Number.isInteger(i) || !c.evidence[i])) throw new Error('必须引用有效的证据索引'); c.agent = { report, evidenceIndexes: indexes, at: new Date().toISOString() } })
  }
  async decide(id: string, action: string, reason: string) {
    required(reason, '复核理由')
    if (!['keep', 'revise', 'defer'].includes(action)) throw new Error('无效复核决定')
    await this.change(s => { const c = s.cards.find(x => x.id === id); if (!c || !c.agent) throw new Error('请先完成Agent复盘'); if (c.decision) throw new Error('已复核，不可覆盖历史'); c.decision = { action: action as 'keep' | 'revise' | 'defer', reason, at: new Date().toISOString() } })
  }
  metrics() {
    const s = this.state, reviewed = s.cards.filter(c => c.decision), weeks = new Set(reviewed.map(c => weekKey(new Date(c.decision!.at))))
    let streak = 0, d = new Date(weekKey()); if (!weeks.has(weekKey(d))) d.setUTCDate(d.getUTCDate() - 7)
    while (weeks.has(weekKey(d))) { streak++; d.setUTCDate(d.getUTCDate() - 7) }
    return { profileCompleted: !!s.profile, consecutiveWeeks: streak, reviewed: reviewed.length, generated: s.cards.length, reviewRate: s.cards.length ? reviewed.length / s.cards.length : null, quality: '人工检查：是否对照原判断、逐项查证指标、讨论反证及缺失、解释修正理由。引用存在不等于证据支持结论。' }
  }
}
