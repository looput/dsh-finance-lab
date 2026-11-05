import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FinanceDataService } from './data/service.js'
import { routeCode } from './data/route-code.js'
import type { AssetType } from './types.js'
import type { ResearchVault } from './research/store.js'
import { evaluateThesis, factsFromF10, factsFromFundProfile, factsFromFundRisk, factsFromQuote, parseIndicators, type FactValue, type IndicatorCheck, type ThesisIndicator } from './personal-eval.js'
import { computeFundRiskMetrics } from './fund-analysis.js'

export type { ThesisIndicator, IndicatorCheck } from './personal-eval.js'

export interface InvestorProfile { goal: string; horizonMonths: number; risk: 'low' | 'medium' | 'high'; maxDrawdownPct: number; baseCurrency: 'CNY' | 'HKD' | 'USD'; updatedAt: string }
export interface Thesis {
  id: string
  code: string
  type?: AssetType
  rationale: string
  /** 自由文本验证指标/证伪条件（保留原文，历史版本不回填）。 */
  indicator: string
  falsifier: string
  /** 结构化可查证指标（P4）；旧观点无此字段，评估输出 unverifiable/missing 而非猜测。 */
  indicators?: ThesisIndicator[]
  falsifiers?: ThesisIndicator[]
  /** 修订理由与生效时间：每次修正必填理由，版本不可变。 */
  changeReason?: string
  effectiveAt?: string
  updatedAt: string
  revision: number
}
export interface Evidence { source: string; sourceUrl?: string; occurredAt: string | null; retrievedAt: string; text: string; missing: string[] }
export interface ReviewCard {
  id: string
  week: string
  generatedAt: string
  /** 幂等键 `${week}:${thesisId}:evidence`。 */
  jobKey: string
  /** 原判断快照（含 revision），同周修正不覆盖本卡。 */
  thesis: Thesis
  evidence: Evidence[]
  missing: string[]
  /** 结构化指标逐条对照（确定性计算；非 Agent 结论）。 */
  checks?: IndicatorCheck[]
  /** 上一张卡的上下文：上次报告与用户决定，供对照「与上次变化」。 */
  previous?: {
    cardId: string
    week: string
    reportAt?: string
    reportExcerpt?: string
    decision?: { action: 'keep' | 'revise' | 'defer'; reason: string; at: string }
  }
  agent?: { report: string; evidenceIndexes: number[]; at: string }
  decision?: { action: 'keep' | 'revise' | 'defer'; reason: string; at: string }
  /** 补充卡（同周修正后显式补卡）：指向被补的原卡与修订版本。 */
  makeup?: { forCardId: string; reason: string; revision: number }
}

/** 周任务：证据采集（自动、有限重试）与 Agent 解读（待用户投递会话）。 */
export interface WeeklyJob {
  key: string
  week: string
  thesisId: string
  cardType: 'evidence' | 'interpretation'
  state: 'pending' | 'running' | 'ready' | 'failed' | 'cancelled'
  attempts: number
  leaseUntil?: string
  startedAt?: string
  finishedAt?: string
  error?: string
  /** 解读任务不自动执行：须用户绑定会话/触发。 */
  requiresUser?: boolean
  /** 补充卡任务：被补的原卡 id 与理由。 */
  makeupFor?: string
  makeupReason?: string
}

export interface PersonalState { startedAt: string; profile?: InvestorProfile; theses: Thesis[]; history: Thesis[]; cards: ReviewCard[]; jobs?: WeeklyJob[] }

export const MAX_JOB_ATTEMPTS = 3
const JOB_LEASE_MS = 120_000

/**
 * 周定义时区（可配置）：默认 UTC，可用 setWeekTimeZone 或 DSH_WEEK_TZ 切换
 * （如 'Asia/Shanghai'）。周起始统一为周一，按该时区的日历日计算。
 */
export let weekTimeZone = process.env.DSH_WEEK_TZ && isValidTimeZone(process.env.DSH_WEEK_TZ) ? process.env.DSH_WEEK_TZ : 'UTC'

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true } catch { return false }
}

export function setWeekTimeZone(tz: string): void {
  if (!isValidTimeZone(tz)) throw new Error(`无效时区：${tz}`)
  weekTimeZone = tz
}

/** 取该时区下的日历日（YYYY-MM-DD）。 */
function calendarDate(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/** 该时区日历日的「周一」所在日期（周定义：周一为一周之始）。 */
export function weekKey(date: Date | string = new Date(), tz: string = weekTimeZone) {
  const local = calendarDate(new Date(date), tz)
  const asUtc = new Date(`${local}T00:00:00Z`)
  asUtc.setUTCDate(asUtc.getUTCDate() - (asUtc.getUTCDay() + 6) % 7)
  return asUtc.toISOString().slice(0, 10)
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
  private state: PersonalState = { startedAt: new Date().toISOString(), theses: [], history: [], cards: [], jobs: [] }
  private ready?: Promise<void>
  private preparation?: Promise<ReviewCard[]>
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private file: string) {}
  async load() {
    this.ready ??= (async () => {
      try {
        const data = JSON.parse(await readFile(this.file, 'utf8'))
        if (!Array.isArray(data.theses) || !Array.isArray(data.cards) || !Array.isArray(data.history)) throw new Error('个人档案文件损坏，拒绝覆盖')
        this.state = { ...data, jobs: Array.isArray(data.jobs) ? data.jobs : [] }
        this.recoverLeases()
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    })()
    await this.ready
  }
  /** 重启恢复：租约过期的 running 任务回到 pending；超限的标 failed，不吞任务。 */
  private recoverLeases(): void {
    const now = Date.now()
    for (const j of this.state.jobs ?? []) {
      if (j.state === 'running' && (!j.leaseUntil || Date.parse(j.leaseUntil) <= now)) {
        j.state = j.attempts >= MAX_JOB_ATTEMPTS ? 'failed' : 'pending'
        j.leaseUntil = undefined
        j.error = j.error ?? '执行中断（租约过期），已恢复待重试'
      }
    }
  }
  get() { return structuredClone(this.state) }
  private async change<T>(fn: (s: PersonalState) => T): Promise<T> {
    let out!: T
    const task = this.queue.then(async () => {
      await this.load(); const next = this.get(); out = fn(next)
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${randomUUID()}.tmp`
      await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(tmp, this.file)
      // 与磁盘一致：undefined 键经 JSON 落盘会被丢弃，内存态同步规范化，reload 前后 deepEqual 成立。
      this.state = JSON.parse(JSON.stringify(next)) as PersonalState
    })
    this.queue = task.catch(() => {}); await task
    return out
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
    const indicators = parseIndicators(v.indicators, '验证指标')
    const falsifiers = parseIndicators(v.falsifiers, '证伪条件')
    const changeReason = v.changeReason === undefined || v.changeReason === '' ? undefined : required(v.changeReason, '修正理由')
    // 版本不可变：修正必须写明理由；生效时间默认即刻（ISO）。
    if (old && !changeReason) throw new Error('修正观点须填写修正理由')
    const effectiveAt = typeof v.effectiveAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.effectiveAt)
      ? v.effectiveAt.slice(0, 10)
      : new Date().toISOString()
    return {
      id: old?.id ?? randomUUID(), code, type,
      rationale: required(v.rationale, '投资理由'),
      indicator: required(v.indicator, '验证指标及阈值'),
      falsifier: required(v.falsifier, '证伪条件'),
      indicators, falsifiers, changeReason, effectiveAt,
      revision: (old?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    }
  }
  async saveThesis(t: Thesis) { await this.change(s => { const old = s.theses.find(x => x.id === t.id); if (t.revision !== (old?.revision ?? 0) + 1) throw new Error('观点版本冲突'); if (old) s.history.push(old); s.theses = [...s.theses.filter(x => x.id !== t.id), t] }) }

  // ---- 周任务调度：week+thesisId+cardType 幂等；租约、有限重试、可取消、重启恢复 ----

  private jobKey(week: string, thesisId: string, cardType: WeeklyJob['cardType']) { return `${week}:${thesisId}:${cardType}` }

  /** 为当前周补齐缺失任务（已有卡片/任务的不重复建）；只补本周，不伪造历史。 */
  async ensureWeekJobs(week = weekKey()): Promise<WeeklyJob[]> {
    return this.change(s => {
      s.jobs ??= []
      const jobs = s.jobs
      for (const t of s.theses) {
        const key = this.jobKey(week, t.id, 'evidence')
        if (!jobs.some(j => j.key === key) && !s.cards.some(c => c.jobKey === key)) {
          jobs.push({ key, week, thesisId: t.id, cardType: 'evidence', state: 'pending', attempts: 0 })
        }
      }
      for (const c of s.cards.filter(c => c.week === week)) {
        const key = this.jobKey(week, c.thesis.id, 'interpretation')
        if (!jobs.some(j => j.key === key) && !c.agent) {
          jobs.push({ key, week, thesisId: c.thesis.id, cardType: 'interpretation', state: 'pending', attempts: 0, requiresUser: true })
        }
      }
      return structuredClone(jobs.filter(j => j.week === week))
    })
  }

  /**
   * 显式补卡（P4 遗留）：同周修正观点后，原卡（旧 revision 快照）不可覆盖，
   * 用户可请求按当前 revision 生成补充卡；一版一卡，重复请求幂等。
   */
  async requestMakeupCard(thesisId: string, reason = '', week = weekKey()): Promise<{ job: WeeklyJob; existingCardId?: string }> {
    return this.change(s => {
      s.jobs ??= []
      const thesis = s.theses.find(t => t.id === thesisId)
      if (!thesis) throw new Error('观点不存在')
      const weekCards = s.cards.filter(c => c.week === week && c.thesis.id === thesisId)
      const original = weekCards.filter(c => !c.makeup).sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))[0]
      if (!original) throw new Error('本周尚无原卡，无须补卡')
      if (thesis.revision <= original.thesis.revision) throw new Error(`当前观点 v${thesis.revision} 未超过原卡快照 v${original.thesis.revision}，无须补卡`)
      const key = `${week}:${thesisId}:evidence:makeup:r${thesis.revision}`
      const done = s.cards.find(c => c.jobKey === key)
      if (done) {
        const existingJob = s.jobs.find(j => j.key === key)
        return { job: existingJob ? structuredClone(existingJob) : { key, week, thesisId, cardType: 'evidence', state: 'ready', attempts: 0 }, existingCardId: done.id }
      }
      let job = s.jobs.find(j => j.key === key)
      if (!job) {
        job = { key, week, thesisId, cardType: 'evidence', state: 'pending', attempts: 0, makeupFor: original.id, makeupReason: reason }
        s.jobs.push(job)
      }
      return { job: structuredClone(job) }
    })
  }

  /** 认领一个可执行的证据任务（pending / 未超限 failed / 租约过期 running），写入租约。 */
  private async claimNextEvidenceJob(week: string): Promise<WeeklyJob | undefined> {
    return this.change(s => {
      s.jobs ??= []
      this.recoverLeases()
      const now = Date.now()
      const job = s.jobs.find(j => j.week === week && j.cardType === 'evidence'
        && (j.state === 'pending' || (j.state === 'failed' && j.attempts < MAX_JOB_ATTEMPTS))
        && !s.cards.some(c => c.jobKey === j.key))
      if (!job) return undefined
      job.state = 'running'
      job.attempts++
      job.startedAt = new Date().toISOString()
      job.leaseUntil = new Date(now + JOB_LEASE_MS).toISOString()
      job.error = undefined
      return structuredClone(job)
    })
  }

  private async finishEvidenceJob(key: string, patch: Partial<WeeklyJob>): Promise<void> {
    await this.change(s => {
      const j = (s.jobs ?? []).find(x => x.key === key)
      if (!j) return
      Object.assign(j, patch)
      if (patch.state && patch.state !== 'running') j.leaseUntil = undefined
    })
  }

  async cancelJob(key: string) {
    await this.change(s => {
      const j = (s.jobs ?? []).find(x => x.key === key)
      if (!j) throw new Error('任务不存在')
      if (j.state === 'ready') throw new Error('已完成任务不可取消')
      j.state = 'cancelled'; j.leaseUntil = undefined
    })
  }

  /** 手动重试：重置次数并回到 pending（自动重试只到 MAX_JOB_ATTEMPTS）。 */
  async retryJob(key: string) {
    await this.change(s => {
      const j = (s.jobs ?? []).find(x => x.key === key)
      if (!j) throw new Error('任务不存在')
      if (j.state === 'ready') throw new Error('已完成任务无须重试')
      j.state = 'pending'; j.attempts = 0; j.error = undefined; j.leaseUntil = undefined
    })
  }

  listJobs(): WeeklyJob[] { return structuredClone(this.state.jobs ?? []) }

  /** 停机缺口：从建档/首卡到本周，哪些周没有任何证据卡（不补造伪历史）。 */
  weeklyGaps(): string[] {
    const weeks = new Set(this.state.cards.map(c => c.week))
    const start = this.state.cards.map(c => c.week).sort()[0] ?? weekKey(new Date(this.state.startedAt))
    const out: string[] = []
    const d = new Date(`${weekKey()}T00:00:00Z`)
    const startD = new Date(`${start}T00:00:00Z`)
    for (let i = 0; i < 52 && d > startD; i++) {
      const w = d.toISOString().slice(0, 10)
      if (!weeks.has(w)) out.push(w)
      d.setUTCDate(d.getUTCDate() - 7)
    }
    return out.reverse()
  }

  async prepare(finance: FinanceDataService, vault?: ResearchVault): Promise<ReviewCard[]> {
    this.preparation ??= this.prepareOnce(finance, vault).finally(() => { this.preparation = undefined })
    return structuredClone(await this.preparation)
  }

  private async prepareOnce(finance: FinanceDataService, vault?: ResearchVault) {
    await this.load()
    if (vault) await vault.load()
    if (!this.state.profile) throw new Error('请先完成建档')
    const week = weekKey()
    await this.ensureWeekJobs(week)
    // 逐个认领执行（串行限流），失败记入任务并有限重试；多入口并发由 preparation 合并 + 任务幂等兜底。
    for (let guard = 0; guard < 200; guard++) {
      const job = await this.claimNextEvidenceJob(week)
      if (!job) break
      try {
        await this.buildCard(job, finance, vault)
        await this.finishEvidenceJob(job.key, { state: 'ready', finishedAt: new Date().toISOString() })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.finishEvidenceJob(job.key, {
          state: 'failed',
          error: message,
          finishedAt: job.attempts >= MAX_JOB_ATTEMPTS ? new Date().toISOString() : undefined,
        })
      }
    }
    return this.get().cards.filter(c => c.week === week)
  }

  /** 每张卡 = 原判断快照 + 多源证据（行情/资料/F10 基本面）+ 结构化对照 + 上次卡上下文。 */
  private async buildCard(job: WeeklyJob, finance: FinanceDataService, vault: ResearchVault | undefined) {
    const { thesisId, week, key: jobKey } = job
    const thesis = this.get().theses.find(t => t.id === thesisId)
    if (!thesis) throw new Error('观点不存在')
    if (this.get().cards.some(c => c.jobKey === jobKey)) return
    const now = new Date().toISOString()
    const evidence: Evidence[] = []
    const facts: Record<string, FactValue> = {}
    try {
      const q = await finance.getAutoQuote(thesis.code, undefined, thesis.type ?? 'stock')
      if (q.ok && q.data) Object.assign(facts, factsFromQuote(q.data as unknown as Record<string, unknown>, q.provider || '行情接口'))
      // 基金：画像里的规模与同类排名百分比也是可核验事实（防御式取数，缺失即缺失）。
      if (q.ok && q.data && (thesis.type ?? 'stock') === 'fund') {
        Object.assign(facts, factsFromFundProfile(q.data as unknown as Record<string, unknown>, `基金画像（${q.provider || '东财'}）`))
      }
      evidence.push({ source: q.provider || '行情接口（来源缺失）', occurredAt: null, retrievedAt: new Date().toISOString(), text: q.ok ? JSON.stringify(q.data ?? {}) : String(q.error), missing: q.ok && typeof q.data?.price === 'number' && Number.isFinite(q.data.price) ? ['行情时间缺失'] : ['行情获取失败'] })
    } catch { evidence.push({ source: '行情接口', occurredAt: null, retrievedAt: now, text: '行情不可用', missing: ['行情获取失败'] }) }
    // 基金证据：净值序列 → 本地计算近1年回撤/波动/夏普与今年来涨幅（P0 基金深度指标本地化）。
    if ((thesis.type ?? 'stock') === 'fund') {
      try {
        const kl = await finance.getFundKline(thesis.code)
        if (kl.ok && Array.isArray(kl.data) && kl.data.length) {
          const risk = computeFundRiskMetrics(kl.data.map((b) => ({ date: b.date, nav: b.close })))
          Object.assign(facts, factsFromFundRisk(risk, `基金净值序列（${kl.provider || '东财'}·本地计算）`))
          evidence.push({
            source: `基金净值序列（${kl.provider || '来源缺失'}·本地计算）`,
            occurredAt: null,
            retrievedAt: new Date().toISOString(),
            text: JSON.stringify({ points: risk.points, asOf: risk.asOf, full: risk.full, y1: risk.y1, stages: risk.stages }),
            missing: risk.points >= 2 ? (risk.y1 ? [] : ['近1年窗口数据不足，回撤/波动/夏普缺失']) : ['净值序列无效'],
          })
        } else {
          evidence.push({ source: '基金净值序列', occurredAt: null, retrievedAt: new Date().toISOString(), text: kl.ok ? '空序列' : String(kl.error ?? ''), missing: ['净值序列获取失败'] })
        }
      } catch {
        evidence.push({ source: '基金净值序列', occurredAt: null, retrievedAt: new Date().toISOString(), text: '获取失败', missing: ['净值序列获取失败'] })
      }
    }
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
    // T4 基本面证据（仅 A 股）：主要财务指标 / 估值分位 / 股东户数，带报告期与公告时点。
    if ((thesis.type ?? 'stock') === 'stock' && routeCode(thesis.code, thesis.type ?? 'stock').market === 'A股') {
      const f10: { financials?: { rows?: Array<Record<string, unknown>> }; valuation?: Parameters<typeof factsFromF10>[0]['valuation']; holders?: Parameters<typeof factsFromF10>[0]['holders'] } = {}
      for (const [cap, bucket, label] of [
        ['main_financials', 'financials', '主要财务指标'],
        ['valuation_analysis', 'valuation', '估值分位'],
        ['shareholder_count', 'holders', '股东户数'],
      ] as const) {
        try {
          const r = await finance.westock<unknown>(cap, { code: thesis.code })
          if (r.ok && r.data) {
            ;(f10 as Record<string, unknown>)[bucket] = r.data
            evidence.push({
              source: `东财 F10 ${label} (${r.provider ?? '未知源'})`, occurredAt: null, retrievedAt: new Date().toISOString(),
              text: JSON.stringify(r.data).slice(0, 4000),
              missing: ['F10 上游契约未线上核实（fixture 验证 ≠ 线上核实）'],
            })
          } else evidence.push({ source: `东财 F10 ${label}`, occurredAt: null, retrievedAt: now, text: String(r.error ?? '无数据'), missing: [`F10 ${label}缺失`] })
        } catch { evidence.push({ source: `东财 F10 ${label}`, occurredAt: null, retrievedAt: now, text: '获取失败', missing: [`F10 ${label}获取失败`] }) }
      }
      Object.assign(facts, factsFromF10(f10))
    }
    const missing = [...new Set(evidence.flatMap(e => e.missing))]
    if (!research.length) missing.push('关联投研资料缺失')
    if (!research.some(r => Date.parse(r.occurredAt) >= Date.parse(week) && Date.parse(r.occurredAt) <= Date.now())) missing.push('本周关联资料库新资料缺失（在线资讯另列）')
    const checks = (thesis.indicators?.length || thesis.falsifiers?.length)
      ? evaluateThesis(thesis.indicators ?? [], thesis.falsifiers ?? [], facts)
      : undefined
    if (checks?.some(c => c.status === 'missing' || c.status === 'unverifiable')) {
      missing.push('存在无法自动查证的指标，须 Agent/人工逐项核对；价格变化不等于观点成立或证伪')
    }
    const priorCard = this.get().cards
      .filter(c => c.thesis.id === thesis.id && (c.week < week || (c.week === week && c.jobKey !== jobKey)))
      .sort((a, b) => (a.week + a.generatedAt).localeCompare(b.week + b.generatedAt))
      .at(-1)
    const previous = priorCard ? {
      cardId: priorCard.id,
      week: priorCard.week,
      reportAt: priorCard.agent?.at,
      reportExcerpt: priorCard.agent?.report.slice(0, 500),
      decision: priorCard.decision,
    } : undefined
    const card: ReviewCard = {
      id: randomUUID(), week, generatedAt: now, jobKey, thesis, evidence, missing, checks, previous,
      makeup: job.makeupFor ? { forCardId: job.makeupFor, reason: job.makeupReason ?? '', revision: thesis.revision } : undefined,
    }
    await this.change(s => {
      if (!s.cards.some(c => c.jobKey === jobKey)) {
        s.cards.push(card)
        // 卡生成后补解读任务（requiresUser：不自动投递会话）
        s.jobs ??= []
        const ik = this.jobKey(week, thesis.id, 'interpretation')
        if (!s.jobs.some(j => j.key === ik)) {
          s.jobs.push({ key: ik, week, thesisId: thesis.id, cardType: 'interpretation', state: 'pending', attempts: 0, requiresUser: true })
        }
      }
    })
    return card
  }

  async saveAgent(id: string, report: string, indexes: number[]) {
    required(report, '复盘报告')
    await this.change(s => {
      const c = s.cards.find(x => x.id === id)
      if (!c) throw new Error('卡片不存在')
      if (c.decision) throw new Error('已复核卡片不可覆盖')
      if (!Array.isArray(indexes) || !indexes.length || indexes.some(i => !Number.isInteger(i) || !c.evidence[i])) throw new Error('必须引用有效的证据索引')
      c.agent = { report, evidenceIndexes: indexes, at: new Date().toISOString() }
      const job = (s.jobs ?? []).find(j => j.key === c.jobKey.replace(/:evidence$/, ':interpretation'))
      if (job && !c.decision) { job.state = 'ready'; job.finishedAt = c.agent.at }
    })
  }
  async decide(id: string, action: string, reason: string) {
    required(reason, '复核理由')
    if (!['keep', 'revise', 'defer'].includes(action)) throw new Error('无效复核决定')
    await this.change(s => {
      const c = s.cards.find(x => x.id === id)
      if (!c || !c.agent) throw new Error('请先完成Agent复盘')
      if (c.decision) throw new Error('已复核，不可覆盖历史')
      // 用户独立决定：Agent 不得代写；revise 也不自动改观点（修正走确认预览流程）。
      c.decision = { action: action as 'keep' | 'revise' | 'defer', reason, at: new Date().toISOString() }
    })
  }
  metrics() {
    const s = this.state, reviewed = s.cards.filter(c => c.decision), weeks = new Set(reviewed.map(c => weekKey(new Date(c.decision!.at))))
    let streak = 0, d = new Date(weekKey()); if (!weeks.has(weekKey(d))) d.setUTCDate(d.getUTCDate() - 7)
    while (weeks.has(weekKey(d))) { streak++; d.setUTCDate(d.getUTCDate() - 7) }
    return { profileCompleted: !!s.profile, consecutiveWeeks: streak, reviewed: reviewed.length, generated: s.cards.length, reviewRate: s.cards.length ? reviewed.length / s.cards.length : null, quality: '人工检查：是否对照原判断、逐项查证指标、讨论反证及缺失、解释修正理由。引用存在不等于证据支持结论。' }
  }
}
