/**
 * 成长档案：Agent 的跨会话记忆（不是用户要填的表单）。
 * 存本地 data/growth.json——家庭收支/资产负债是敏感隐私，绝不出本机。
 * 持久化与 PersonalStore 同款：原子写 + 损坏拒绝覆盖。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FamilyGoal, FamilyPlan, GrowthProfile, GrowthState, Liability } from './growth.js'

function nowIso(): string {
  return new Date().toISOString()
}

export function defaultGrowthState(): GrowthState {
  return { createdAt: nowIso(), plan: {}, lessons: [], attempts: [], reviews: [], activityDates: [] }
}

export type PlanSection = 'profile' | 'cashflow' | 'balance' | 'goals' | 'protection'

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 轻量结构校验：拒绝把垃圾形状写进档案（明确报错，不静默接受）。 */
export function normalizeSection(section: PlanSection, data: unknown): unknown {
  if (section === 'profile') {
    const p = (data ?? {}) as Record<string, unknown>
    if (typeof p !== 'object' || Array.isArray(p)) throw new Error('profile 需要对象')
    const out: GrowthProfile = {}
    if (p.ageBand !== undefined) out.ageBand = String(p.ageBand)
    if (p.incomeStability !== undefined) {
      if (!['stable', 'variable', 'uncertain'].includes(String(p.incomeStability))) throw new Error('incomeStability ∈ stable|variable|uncertain')
      out.incomeStability = p.incomeStability as GrowthProfile['incomeStability']
    }
    if (p.horizonYears !== undefined) {
      if (!isFiniteNum(p.horizonYears) || (p.horizonYears as number) < 0) throw new Error('horizonYears 需要非负数字')
      out.horizonYears = p.horizonYears
    }
    if (p.maxDrawdownAcceptPct !== undefined) {
      if (!isFiniteNum(p.maxDrawdownAcceptPct) || p.maxDrawdownAcceptPct < 0 || p.maxDrawdownAcceptPct > 100) throw new Error('maxDrawdownAcceptPct ∈ 0-100')
      out.maxDrawdownAcceptPct = p.maxDrawdownAcceptPct
    }
    if (p.riskSelfAssessment !== undefined) {
      if (!['conservative', 'balanced', 'aggressive'].includes(String(p.riskSelfAssessment))) throw new Error('riskSelfAssessment ∈ conservative|balanced|aggressive')
      out.riskSelfAssessment = p.riskSelfAssessment as GrowthProfile['riskSelfAssessment']
    }
    if (p.responsibility !== undefined) {
      if (!['single', 'couple', 'family', 'single_parent'].includes(String(p.responsibility))) throw new Error('responsibility ∈ single|couple|family|single_parent')
      out.responsibility = p.responsibility as GrowthProfile['responsibility']
    }
    out.updated = nowIso()
    return out
  }
  if (section === 'cashflow') {
    const c = (data ?? {}) as Record<string, unknown>
    if (typeof c !== 'object' || Array.isArray(c)) throw new Error('cashflow 需要对象')
    const out: NonNullable<FamilyPlan['cashflow']> = {}
    if (c.monthlyIncome !== undefined) {
      if (!isFiniteNum(c.monthlyIncome) || c.monthlyIncome < 0) throw new Error('monthlyIncome 需要非负数字')
      out.monthlyIncome = c.monthlyIncome
    }
    if (c.monthlyExpense !== undefined) {
      if (!isFiniteNum(c.monthlyExpense) || c.monthlyExpense < 0) throw new Error('monthlyExpense 需要非负数字')
      out.monthlyExpense = c.monthlyExpense
    }
    if (c.currency !== undefined) out.currency = String(c.currency)
    return out
  }
  if (section === 'balance') {
    const b = (data ?? {}) as Record<string, unknown>
    if (typeof b !== 'object' || Array.isArray(b)) throw new Error('balance 需要对象')
    const out: NonNullable<FamilyPlan['balance']> = {}
    if (b.liquidAssets !== undefined) {
      if (!isFiniteNum(b.liquidAssets) || b.liquidAssets < 0) throw new Error('liquidAssets 需要非负数字')
      out.liquidAssets = b.liquidAssets
    }
    if (b.investmentAssets !== undefined) {
      if (!isFiniteNum(b.investmentAssets) || b.investmentAssets < 0) throw new Error('investmentAssets 需要非负数字')
      out.investmentAssets = b.investmentAssets
    }
    if (b.liabilities !== undefined) {
      if (!Array.isArray(b.liabilities)) throw new Error('liabilities 需要数组')
      out.liabilities = (b.liabilities as Liability[]).map((x, i) => {
        const li = (x ?? {}) as unknown as Record<string, unknown>
        if (li.monthlyPayment !== undefined && !isFiniteNum(li.monthlyPayment)) throw new Error(`liabilities[${i}].monthlyPayment 需要数字`)
        if (li.ratePct !== undefined && !isFiniteNum(li.ratePct)) throw new Error(`liabilities[${i}].ratePct 需要数字`)
        const row: Liability = {}
        if (li.name !== undefined) row.name = String(li.name)
        if (li.monthlyPayment !== undefined) row.monthlyPayment = li.monthlyPayment
        if (li.ratePct !== undefined) row.ratePct = li.ratePct
        return row
      })
    }
    return out
  }
  if (section === 'goals') {
    if (!Array.isArray(data)) throw new Error('goals 需要数组（整段替换）')
    const seen = new Set<string>()
    return (data as FamilyGoal[]).map((g, i) => {
      const gg = (g ?? {}) as unknown as Record<string, unknown>
      const id = String(gg.id ?? `goal-${i + 1}`).trim() || `goal-${i + 1}`
      if (seen.has(id)) throw new Error(`goals id 重复：${id}`)
      seen.add(id)
      if (!String(gg.name ?? '').trim()) throw new Error(`goals[${i}].name 必填`)
      if (!isFiniteNum(gg.targetAmount) || gg.targetAmount <= 0) throw new Error(`goals[${i}].targetAmount 需要正数`)
      const out: FamilyGoal = { id, name: String(gg.name).trim(), targetAmount: gg.targetAmount }
      if (gg.type !== undefined) out.type = String(gg.type)
      if (gg.currentAmount !== undefined) {
        if (!isFiniteNum(gg.currentAmount) || gg.currentAmount < 0) throw new Error(`goals[${i}].currentAmount 需要非负数字`)
        out.currentAmount = gg.currentAmount
      }
      if (gg.deadline !== undefined) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(gg.deadline))) throw new Error(`goals[${i}].deadline 需要 YYYY-MM`)
        out.deadline = String(gg.deadline)
      }
      if (gg.monthlySaving !== undefined) {
        if (!isFiniteNum(gg.monthlySaving) || gg.monthlySaving < 0) throw new Error(`goals[${i}].monthlySaving 需要非负数字`)
        out.monthlySaving = gg.monthlySaving
      }
      if (gg.priority !== undefined) {
        if (!['high', 'normal', 'low'].includes(String(gg.priority))) throw new Error(`goals[${i}].priority ∈ high|normal|low`)
        out.priority = gg.priority as FamilyGoal['priority']
      }
      return out
    })
  }
  // protection
  if (!Array.isArray(data)) throw new Error('protection 需要数组（整段替换）')
  return (data as Array<Record<string, unknown>>).map((p, i) => {
    const pp = (p ?? {}) as Record<string, unknown>
    if (!String(pp.type ?? '').trim()) throw new Error(`protection[${i}].type 必填（如 医疗/重疾/意外/寿险）`)
    if (typeof pp.covered !== 'boolean') throw new Error(`protection[${i}].covered 需要布尔`)
    const out = { type: String(pp.type).trim(), covered: pp.covered }
    if (pp.sumInsured !== undefined) {
      if (!isFiniteNum(pp.sumInsured) || pp.sumInsured < 0) throw new Error(`protection[${i}].sumInsured 需要非负数字`)
      return { ...out, sumInsured: pp.sumInsured }
    }
    return out
  })
}

export type GrowthChange = { action: 'profile' | 'plan' | 'quiz' | 'review' }

export class GrowthStore {
  private state: GrowthState = defaultGrowthState()
  private ready?: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private file: string, private onChange?: (change: GrowthChange) => void) {}

  async load(): Promise<void> {
    this.ready ??= (async () => {
      try {
        const data = JSON.parse(await readFile(this.file, 'utf8'))
        if (!Array.isArray(data.lessons) || !Array.isArray(data.attempts) || !Array.isArray(data.reviews) || !Array.isArray(data.activityDates) || typeof data.createdAt !== 'string') {
          throw new Error('成长档案文件损坏，拒绝覆盖')
        }
        this.state = { ...data, plan: data.plan && typeof data.plan === 'object' ? data.plan : {} }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
    })()
    await this.ready
  }

  get(): GrowthState {
    return structuredClone(this.state)
  }

  private async change<T>(action: GrowthChange['action'], fn: (s: GrowthState) => T, notify = true): Promise<T> {
    let out!: T
    const task = this.queue.then(async () => {
      await this.load()
      const next = this.get()
      out = fn(next)
      next.updatedAt = nowIso()
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${randomUUID()}.tmp`
      await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
      await rename(tmp, this.file)
      this.state = JSON.parse(JSON.stringify(next)) as GrowthState
      // 回执：写盘成功后才通知（面板据此即时刷新；监听器异常不影响存储）。
      if (notify) {
        try { this.onChange?.({ action }) } catch { /* 回执失败不回滚存储 */ }
      }
    })
    this.queue = task.catch(() => {})
    await task
    return out
  }

  /** 活动痕迹（供成长连续周等外部读取，如追踪完成一轮拉取；不发回执）。 */
  async markActivity(date = new Date()): Promise<void> {
    await this.change('plan', (s) => {
      this.touchActivity(s, date)
    }, false)
  }

  /** 活动日期（学习/计划/复盘都算）：倒序去重，保留最近 400 天。 */
  private touchActivity(s: GrowthState, date: Date = new Date()): void {
    const iso = date.toISOString().slice(0, 10)
    s.activityDates = [iso, ...s.activityDates.filter((d) => d !== iso)].slice(0, 400)
  }

  async updateProfile(partial: unknown): Promise<GrowthProfile> {
    const profile = normalizeSection('profile', partial) as GrowthProfile
    return this.change('profile', (s) => {
      s.profile = { ...(s.profile ?? {}), ...profile }
      this.touchActivity(s)
      return s.profile!
    })
  }

  async updatePlanSection(section: PlanSection, data: unknown): Promise<{ plan: FamilyPlan }> {
    if (section === 'profile') throw new Error('profile 请用 updateProfile')
    const value = normalizeSection(section, data)
    return this.change('plan', (s) => {
      if (section === 'cashflow') s.plan.cashflow = { ...(s.plan.cashflow ?? {}), ...(value as object) }
      else if (section === 'balance') s.plan.balance = { ...(s.plan.balance ?? {}), ...(value as object) }
      else if (section === 'goals') s.plan.goals = value as FamilyGoal[]
      else if (section === 'protection') s.plan.protection = value as FamilyPlan['protection']
      s.plan.updated = nowIso()
      this.touchActivity(s)
      return { plan: s.plan }
    })
  }

  /** 提交测验：记录尝试；≥80 分记 mastered（同一课可多次尝试，保留最高）。 */
  async recordQuiz(lessonId: string, score: number, passed: boolean): Promise<{ attempt: { lessonId: string; score: number; at: string }; masteredCount: number }> {
    return this.change('quiz', (s) => {
      const at = nowIso()
      s.attempts = [{ lessonId, score, at }, ...s.attempts].slice(0, 500)
      const cur = s.lessons.find((x) => x.lessonId === lessonId)
      if (cur) {
        cur.mastery = Math.max(cur.mastery ?? 0, score)
        if (passed) cur.status = 'mastered'
        else if (cur.status !== 'mastered') cur.status = 'learning'
        cur.completedAt = passed || cur.status === 'mastered' ? (cur.completedAt ?? at) : undefined
      } else {
        s.lessons.push({
          lessonId,
          status: passed ? 'mastered' : 'learning',
          mastery: score,
          completedAt: passed ? at : undefined,
        })
      }
      this.touchActivity(s)
      return { attempt: s.attempts[0]!, masteredCount: s.lessons.filter((x) => x.status === 'mastered').length }
    })
  }

  /** 标记月度成长复盘（正文由 Agent 落资料库 kind=review，这里只记索引与 streak）。 */
  async markReview(period: string, vaultId?: string, highlights?: string[]): Promise<{ review: { period: string; at: string; vaultId?: string; highlights?: string[] } }> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('period 需要 YYYY-MM')
    return this.change('review', (s) => {
      const at = nowIso()
      const review = { period, at, ...(vaultId ? { vaultId } : {}), ...(highlights?.length ? { highlights: highlights.slice(0, 8) } : {}) }
      s.reviews = [review, ...s.reviews.filter((r) => r.period !== period)].slice(0, 60)
      this.touchActivity(s)
      return { review }
    })
  }
}
