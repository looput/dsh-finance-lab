/**
 * 成长内核（纯函数，离线可测）：家庭财务健康度、四柱成长评分、学习连续周、
 * 测验判分，以及核心的「学什么」诊断引擎。
 *
 * 设计约束（Agent 插件，不是传统软件）：
 * - 这里只产出「证据 → 结论」；何时推给用户、推几个，由 Agent 在对话中决策（系统提示约束）。
 * - 激励只看过程（学习/计划/纪律），资产柱衡量的是计划执行而非收益率——
 *   绝不用收益排名激励交易。
 * - 所有输入由调用方（工具层）从本地状态拼装：不发网络请求、不读全局。
 */
import { GROWTH_CURRICULUM, METRIC_CONCEPT_MAP, findLesson, type Curriculum, type Lesson } from './growth-curriculum.js'
import { isOnExchangeFundCode } from './fund-analysis.js'

// ---------------------------------------------------------------------------
// 状态类型（GrowthStore 与工具层共用）
// ---------------------------------------------------------------------------

export interface GrowthProfile {
  ageBand?: string
  incomeStability?: 'stable' | 'variable' | 'uncertain'
  horizonYears?: number
  maxDrawdownAcceptPct?: number
  riskSelfAssessment?: 'conservative' | 'balanced' | 'aggressive'
  responsibility?: 'single' | 'couple' | 'family' | 'single_parent'
  updated?: string
}

export interface FamilyGoal {
  id: string
  name: string
  type?: string
  targetAmount: number
  currentAmount?: number
  /** YYYY-MM */
  deadline?: string
  monthlySaving?: number
  priority?: 'high' | 'normal' | 'low'
}

export interface Liability {
  name?: string
  monthlyPayment?: number
  ratePct?: number
}

export interface FamilyPlan {
  cashflow?: { monthlyIncome?: number; monthlyExpense?: number; currency?: string }
  balance?: { liquidAssets?: number; investmentAssets?: number; liabilities?: Liability[] }
  goals?: FamilyGoal[]
  protection?: Array<{ type: string; covered: boolean; sumInsured?: number }>
  updated?: string
}

export interface LessonProgress {
  lessonId: string
  status: 'learning' | 'mastered'
  mastery?: number
  completedAt?: string
}

export interface QuizAttempt {
  lessonId: string
  score: number
  at: string
}

export interface GrowthReviewEntry {
  period: string
  at: string
  vaultId?: string
  highlights?: string[]
}

export interface GrowthState {
  createdAt: string
  updatedAt?: string
  profile?: GrowthProfile
  plan: FamilyPlan
  lessons: LessonProgress[]
  attempts: QuizAttempt[]
  reviews: GrowthReviewEntry[]
  /** ISO 日期倒序去重（学习/计划/复盘等活动痕迹，用于连续周）。 */
  activityDates: string[]
}

// ---------------------------------------------------------------------------
// 家庭财务健康度
// ---------------------------------------------------------------------------

export interface PlanFix {
  key: string
  severity: 'high' | 'medium' | 'low'
  message: string
  /** 配套微课（诊断引擎会交叉引用）。 */
  lessonId?: string
}

export interface PlanHealth {
  emergencyMonths: number | null
  savingsRatePct: number | null
  debtIncomePct: number | null
  protectionGaps: string[]
  goalStatus: Array<{ id: string; name: string; progressPct: number | null; feasible: boolean | null }>
  /** 0-100；关键信息全缺为 null（不惩罚「还没填」，但 fixes 会提示补数）。 */
  score: number | null
  fixes: PlanFix[]
  notes: string[]
}

const REQUIRED_BASE = ['医疗', '重疾', '意外'] as const

function requiredProtections(profile?: GrowthProfile): string[] {
  const base: string[] = [...REQUIRED_BASE]
  if (profile?.responsibility === 'family' || profile?.responsibility === 'single_parent') base.push('寿险')
  return base
}

function monthsUntil(deadline: string, from = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(deadline)
  if (!m) return null
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)
  const now = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)
  const diff = Math.ceil((target - now) / (30.44 * 86400000))
  return Number.isFinite(diff) ? diff : null
}

export function evaluateFamilyPlan(plan: FamilyPlan, profile?: GrowthProfile): PlanHealth {
  const fixes: PlanFix[] = []
  const notes: string[] = []

  // 应急金月数
  const expense = plan.cashflow?.monthlyExpense
  const income = plan.cashflow?.monthlyIncome
  const liquid = plan.balance?.liquidAssets
  const emergencyMonths = expense && expense > 0 && typeof liquid === 'number' && liquid >= 0
    ? Math.round((liquid / expense) * 10) / 10
    : null
  if (emergencyMonths === null) {
    if (!expense || expense <= 0 || typeof liquid !== 'number') {
      fixes.push({ key: 'emergency-unknown', severity: 'medium', message: '缺月支出/流动资产数据，无法核对应急金是否达标。', lessonId: 'plan-emergency' })
    }
  } else if (emergencyMonths < 3) {
    fixes.push({ key: 'emergency-gap', severity: 'high', message: `应急金仅 ${emergencyMonths} 个月支出（建议 ≥3，目标 6）——先补足活钱再谈加仓。`, lessonId: 'plan-emergency' })
  } else if (emergencyMonths < 6) {
    fixes.push({ key: 'emergency-warn', severity: 'low', message: `应急金 ${emergencyMonths} 个月，未达 6 个月目标，继续积累。`, lessonId: 'plan-emergency' })
  }

  // 储蓄率
  const savingsRatePct = income && income > 0 && typeof expense === 'number' && expense >= 0
    ? Math.round(((income - expense) / income) * 1000) / 10
    : null
  if (savingsRatePct !== null && savingsRatePct < 0) {
    fixes.push({ key: 'cashflow-negative', severity: 'high', message: `入不敷出（储蓄率 ${savingsRatePct}%）：先调整收支，任何投资都补不上现金流窟窿。`, lessonId: 'plan-cashflow' })
  } else if (savingsRatePct !== null && savingsRatePct < 10) {
    fixes.push({ key: 'cashflow-low', severity: 'medium', message: `储蓄率 ${savingsRatePct}%（建议 ≥20%）：优化现金流的边际收益远大于选股。`, lessonId: 'plan-cashflow' })
  } else if (savingsRatePct === null) {
    fixes.push({ key: 'cashflow-unknown', severity: 'low', message: '未填月收入/支出，储蓄率与目标进度无法评估。', lessonId: 'plan-cashflow' })
  }

  // 负债收入比
  const liabilities = plan.balance?.liabilities ?? []
  const monthlyDebt = liabilities.reduce((s, x) => s + (Number.isFinite(x.monthlyPayment as number) ? (x.monthlyPayment as number) : 0), 0)
  const debtIncomePct = income && income > 0 && liabilities.length >= 0
    ? Math.round((monthlyDebt / income) * 1000) / 10
    : null
  if (debtIncomePct !== null && debtIncomePct > 40) {
    fixes.push({ key: 'debt-high', severity: 'high', message: `负债收入比 ${debtIncomePct}%（>40% 危险）：优先降杠杆、留足月供缓冲。`, lessonId: 'plan-debt' })
  } else if (debtIncomePct !== null && debtIncomePct > 35) {
    fixes.push({ key: 'debt-watch', severity: 'medium', message: `负债收入比 ${debtIncomePct}%（>35% 预警）：新增负债前先算月供。`, lessonId: 'plan-debt' })
  }

  // 保障
  const required = requiredProtections(profile)
  const coveredSet = new Set((plan.protection ?? []).filter((p) => p.covered).map((p) => String(p.type)))
  const protectionGaps = plan.protection
    ? required.filter((t) => !coveredSet.has(t))
    : []
  if (!plan.protection) {
    fixes.push({ key: 'protection-unknown', severity: 'medium', message: '保障清单未填写：无法核对医疗/重疾/意外缺口。', lessonId: 'plan-insurance' })
  } else if (protectionGaps.length) {
    const heavy = profile?.responsibility === 'family' || profile?.responsibility === 'single_parent'
    fixes.push({
      key: 'protection-gap',
      severity: protectionGaps.length >= 2 || heavy ? 'high' : 'medium',
      message: `保障缺口：${protectionGaps.join('、')}——先保家庭支柱，再谈加仓。`,
      lessonId: 'plan-insurance',
    })
  }

  // 目标可行性
  const goals = plan.goals ?? []
  const goalStatus: PlanHealth['goalStatus'] = goals.map((g) => {
    const target = Number(g.targetAmount)
    const current = Number.isFinite(Number(g.currentAmount)) ? Number(g.currentAmount) : 0
    const progressPct = Number.isFinite(target) && target > 0
      ? Math.min(100, Math.round((Math.max(0, current) / target) * 10000) / 100)
      : null
    const remaining = Number.isFinite(target) && target > 0 ? Math.max(0, target - current) : null
    if (remaining !== null && remaining <= 0) return { id: g.id, name: g.name, progressPct, feasible: true }
    if (!g.deadline || typeof g.monthlySaving !== 'number' || remaining === null) {
      return { id: g.id, name: g.name, progressPct, feasible: null }
    }
    const monthsLeft = monthsUntil(g.deadline)
    if (monthsLeft === null) return { id: g.id, name: g.name, progressPct, feasible: null }
    if (monthsLeft <= 0) return { id: g.id, name: g.name, progressPct, feasible: false } // 已到期仍有缺口
    const requiredMonthly = Math.ceil(remaining / monthsLeft)
    return { id: g.id, name: g.name, progressPct, feasible: g.monthlySaving >= requiredMonthly }
  })
  const infeasible = goalStatus.filter((g) => g.feasible === false)
  if (infeasible.length) {
    fixes.push({
      key: 'goal-infeasible',
      severity: 'medium',
      message: `目标「${infeasible.map((g) => g.name).join('、')}」按当前月存达不到截止日：提高月存/延长期限/下调目标额。`,
      lessonId: 'plan-goals',
    })
  }
  if (!goals.length) {
    fixes.push({ key: 'goals-none', severity: 'low', message: '未设置财务目标：金额+期限+月供倒推，才能把「增值」变成计划。', lessonId: 'plan-goals' })
  }

  // 分项打分（缺数据的项不参与，避免惩罚「还没填」）
  const subs: Array<{ key: string; weight: number; v: number | null }> = []
  // 应急金：≥6 满分；3-6 线性 60-100；<3 按比例 0-60
  subs.push({
    key: 'emergency', weight: 30,
    v: emergencyMonths === null ? null
      : emergencyMonths >= 6 ? 100
        : emergencyMonths >= 3 ? Math.round(60 + ((emergencyMonths - 3) / 3) * 40)
          : Math.round(Math.max(0, (emergencyMonths / 3) * 60)),
  })
  // 负债：≤20 →100，≤35 →70，≤50 →40，>50 →0
  subs.push({
    key: 'debt', weight: 20,
    v: debtIncomePct === null ? null
      : debtIncomePct <= 20 ? 100
        : debtIncomePct <= 35 ? 70
          : debtIncomePct <= 50 ? 40 : 0,
  })
  // 储蓄率：≥30 满分，≥20 →85，≥10 →60，≥0 →30，<0 →0
  subs.push({
    key: 'savings', weight: 20,
    v: savingsRatePct === null ? null
      : savingsRatePct >= 30 ? 100
        : savingsRatePct >= 20 ? 85
          : savingsRatePct >= 10 ? 60
            : savingsRatePct >= 0 ? 30 : 0,
  })
  // 保障：按必保项覆盖率
  subs.push({
    key: 'protection', weight: 15,
    v: plan.protection ? Math.round(((required.length - protectionGaps.length) / required.length) * 100) : null,
  })
  // 目标：可行 100 / 不可行 40 / 未知取进度均值（无目标 → null）
  subs.push({
    key: 'goals', weight: 15,
    v: !goals.length ? null
      : (() => {
        const vals = goalStatus.map((g) => (g.feasible === true ? 100 : g.feasible === false ? 40 : (g.progressPct ?? 0)))
        return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length)
      })(),
  })
  const known = subs.filter((s) => s.v !== null)
  const score = known.length
    ? Math.round(known.reduce((s, x) => s + (x.weight * (x.v as number)), 0) / known.reduce((s, x) => s + x.weight, 0))
    : null

  if (emergencyMonths !== null && emergencyMonths >= 6 && !protectionGaps.length && savingsRatePct !== null && savingsRatePct >= 20) {
    notes.push('家庭财务底盘健康：应急金、保障与储蓄率均达标，可按计划配置。')
  }
  if (liabilities.length) notes.push('负债月供合计 ' + monthlyDebt + '（含在负债收入比中）。')

  const sev = { high: 0, medium: 1, low: 2 }
  fixes.sort((a, b) => sev[a.severity] - sev[b.severity])
  return { emergencyMonths, savingsRatePct, debtIncomePct, protectionGaps, goalStatus, score, fixes, notes }
}

// ---------------------------------------------------------------------------
// 四柱评分与等级
// ---------------------------------------------------------------------------

export interface GrowthFacts {
  masteredLessons: number
  totalLessons: number
  quizAvg: number | null
  planHealthScore: number | null
  /** 0..1：写了证伪条件的观点占比（结构化 falsifiers 或文本 falsifier）。 */
  falsifierCoverage: number | null
  /** 0..1：近 8 周（或开始以来）周复盘覆盖率。 */
  weeklyReviewRate: number | null
  journalCount30d: number | null
  savingsRatePct: number | null
  /** 0..1：目标进度均值。 */
  goalFundingRate: number | null
}

export interface GrowthSummary {
  pillars: { knowledge: number | null; plan: number | null; discipline: number | null; assets: number | null }
  total: number | null
  level: { id: 'L1' | 'L2' | 'L3' | 'L4' | 'L5'; label: string }
}

const LEVELS: Array<{ min: number; id: 'L1' | 'L2' | 'L3' | 'L4' | 'L5'; label: string }> = [
  { min: 88, id: 'L5', label: '成熟投资者' },
  { min: 75, id: 'L4', label: '稳健' },
  { min: 60, id: 'L3', label: '进阶' },
  { min: 40, id: 'L2', label: '入门' },
  { min: 0, id: 'L1', label: '启蒙' },
]

export function computeGrowth(f: GrowthFacts): GrowthSummary {
  const knowledge = f.totalLessons > 0 ? Math.round((f.masteredLessons / f.totalLessons) * 100) : null
  const plan = f.planHealthScore
  const discParts: Array<{ w: number; v: number | null }> = [
    { w: 0.4, v: f.falsifierCoverage },
    { w: 0.4, v: f.weeklyReviewRate },
    { w: 0.2, v: f.journalCount30d === null || f.journalCount30d === undefined ? null : Math.min(1, f.journalCount30d / 4) },
  ]
  const discKnown = discParts.filter((p) => p.v !== null)
  const discipline = discKnown.length
    ? Math.round(discKnown.reduce((s, p) => s + p.w * (p.v as number), 0) / discKnown.reduce((s, p) => s + p.w, 0) * 100)
    : null
  const assetParts: Array<number> = []
  if (f.savingsRatePct !== null) assetParts.push(Math.max(0, Math.min(100, (f.savingsRatePct / 30) * 100)))
  if (f.goalFundingRate !== null) assetParts.push(Math.max(0, Math.min(100, f.goalFundingRate * 100)))
  const assets = assetParts.length ? Math.round(assetParts.reduce((s, v) => s + v, 0) / assetParts.length) : null

  const weights = { knowledge: 30, plan: 25, discipline: 25, assets: 20 }
  const parts: Array<{ w: number; v: number }> = []
  if (knowledge !== null) parts.push({ w: weights.knowledge, v: knowledge })
  if (plan !== null) parts.push({ w: weights.plan, v: plan })
  if (discipline !== null) parts.push({ w: weights.discipline, v: discipline })
  if (assets !== null) parts.push({ w: weights.assets, v: assets })
  const total = parts.length
    ? Math.round(parts.reduce((s, p) => s + p.w * p.v, 0) / parts.reduce((s, p) => s + p.w, 0))
    : null
  const lv = LEVELS.find((x) => total !== null && total >= x.min) ?? LEVELS[LEVELS.length - 1]!
  return { pillars: { knowledge, plan, discipline, assets }, total, level: { id: lv.id, label: lv.label } }
}

/** 连续活动周数：从本周（或上周）往回数连续有活动的 ISO 周。 */
export function computeStreak(activityDates: string[], today = new Date()): number {
  const weekOf = (d: Date): string => {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7))
    return x.toISOString().slice(0, 10)
  }
  const weeks = new Set<string>()
  for (const raw of activityDates) {
    const d = new Date(`${String(raw).slice(0, 10)}T00:00:00Z`)
    if (Number.isFinite(d.getTime())) weeks.add(weekOf(d))
  }
  if (!weeks.size) return 0
  const thisWeek = weekOf(today)
  let cursor = new Date(`${thisWeek}T00:00:00Z`)
  if (!weeks.has(thisWeek)) {
    cursor.setUTCDate(cursor.getUTCDate() - 7) // 本周还没活动：从上周数，不断更
    if (!weeks.has(weekOf(cursor))) return 0
  }
  let streak = 0
  while (weeks.has(weekOf(cursor))) {
    streak++
    cursor.setUTCDate(cursor.getUTCDate() - 7)
    if (streak > 520) break
  }
  return streak
}

// ---------------------------------------------------------------------------
// 测验判分
// ---------------------------------------------------------------------------

export function gradeQuiz(lesson: Lesson, answers: number[]): { score: number; passed: boolean; details: Array<{ correct: boolean; given: number; correctIndex: number }> } {
  if (!lesson.quiz.length) throw new Error(`课程 ${lesson.id} 无测验题`)
  if (!Array.isArray(answers) || answers.length !== lesson.quiz.length) {
    throw new Error(`答案数(${Array.isArray(answers) ? answers.length : '?'}) 与题目数(${lesson.quiz.length}) 不符`)
  }
  const details = lesson.quiz.map((q, i) => {
    const given = Number(answers[i])
    if (!Number.isInteger(given) || given < 0 || given >= q.options.length) {
      throw new Error(`第 ${i + 1} 题答案越界（0-${q.options.length - 1}）`)
    }
    return { correct: given === q.answer, given, correctIndex: q.answer }
  })
  const score = Math.round((details.filter((d) => d.correct).length / details.length) * 100)
  return { score, passed: score >= 80, details }
}

// ---------------------------------------------------------------------------
// 诊断引擎：证据 → 「学什么/修什么/复盘什么」（Agent 决策的输入）
// ---------------------------------------------------------------------------

export interface DiagnosisFinding {
  kind: 'plan' | 'lesson' | 'discipline' | 'review'
  /** 越小越优先。 */
  priority: number
  ref?: string
  title: string
  /** 为什么得出这个结论（必须引用用户自己的数据）。 */
  evidence: string
  /** 给 Agent 的行动建议（可直接作为话术要点）。 */
  suggestion: string
}

export interface DiagnosisFacts {
  holdings?: Array<{ code: string; type: string; name?: string }>
  /** 用户在 thesis 里真实用过的结构化指标键。 */
  thesisMetrics?: string[]
  thesesTotal?: number
  thesesWithFalsifier?: number
  /** 近 8 周（或开始以来）复盘覆盖率 0..1；无观点为 null。 */
  weeklyReviewRate?: number | null
  journalCount30d?: number | null
  recentTopics?: string[]
  lookthroughWarnings?: string[]
}

export interface DiagnosisInput {
  state: GrowthState
  curriculum?: Curriculum
  facts: DiagnosisFacts
}

function planFixPriority(s: PlanFix['severity']): number {
  return s === 'high' ? 1 : s === 'medium' ? 2 : 3
}

function planSectionHint(key: string): string {
  if (key.startsWith('emergency')) return '（family_plan_update section=balance/cashflow 补流动资产与支出）'
  if (key.startsWith('cashflow')) return '（family_plan_update section=cashflow 补收入/支出）'
  if (key.startsWith('debt')) return '（family_plan_update section=balance 补负债月供）'
  if (key.startsWith('protection')) return '（family_plan_update section=protection 补保障清单）'
  if (key.startsWith('goal')) return '（family_plan_update section=goals 补目标金额/期限/月存）'
  return ''
}

export function diagnoseGrowth(input: DiagnosisInput): DiagnosisFinding[] {
  const { state, facts } = input
  const curriculum = input.curriculum ?? GROWTH_CURRICULUM
  const mastered = new Set(state.lessons.filter((x) => x.status === 'mastered').map((x) => x.lessonId))
  const out: DiagnosisFinding[] = []
  const seen = new Set<string>()
  const push = (f: DiagnosisFinding, dedupeKey: string) => {
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    out.push(f)
  }

  // 1) 家庭财务修复项（规划先于一切投资教学）
  const health = evaluateFamilyPlan(state.plan, state.profile)
  for (const fix of health.fixes) {
    if (fix.severity === 'low' && out.length >= 6) continue
    const lesson = fix.lessonId ? findLesson(fix.lessonId) : undefined
    push({
      kind: 'plan',
      priority: planFixPriority(fix.severity),
      ref: fix.key,
      title: fix.severity === 'high' ? `优先修复：${fix.key}` : `计划待完善：${fix.key}`,
      evidence: fix.message,
      suggestion: `${lesson ? `配套微课 lesson_get(${lesson.id})《${lesson.title}》；` : ''}${planSectionHint(fix.key)}`,
    }, `plan:${fix.key}`)
  }

  // 2) 持仓与概念错配（用他真实持有的东西教）
  for (const h of facts.holdings ?? []) {
    const wanted: Array<{ lessonId: string; why: string }> = []
    if (h.type === 'fund') wanted.push({ lessonId: 'fund-basics', why: `持有基金 ${h.code}${h.name ? `（${h.name}）` : ''}` })
    if (isOnExchangeFundCode(h.code)) wanted.push({ lessonId: 'etf-premium', why: `持有场内 ETF ${h.code}${h.name ? `（${h.name}）` : ''}，折溢价直接决定买入成本` })
    for (const w of wanted) {
      if (mastered.has(w.lessonId)) continue
      const lesson = curriculum.lessons.find((x) => x.id === w.lessonId)
      if (!lesson) continue
      push({
        kind: 'lesson', priority: 4, ref: w.lessonId,
        title: `补课：${lesson.title}`,
        evidence: `${w.why}，但《${lesson.title}》未通过测验。`,
        suggestion: `对话里讲 3 个要点 + 1 道检验题，答完 lesson_complete(${lesson.id}) 判分。`,
      }, `lesson:${w.lessonId}`)
    }
  }

  // 3) 在用指标 → 概念（thesis 里的 metricKey 是最真实的学习需求）
  for (const key of new Set(facts.thesisMetrics ?? [])) {
    const mapped = metricLesson(key)
    if (!mapped || mastered.has(mapped)) continue
    const lesson = curriculum.lessons.find((x) => x.id === mapped)
    if (!lesson) continue
    push({
      kind: 'lesson', priority: 5, ref: mapped,
      title: `补课：${lesson.title}`,
      evidence: `你的验证指标用到「${key}」，但对应课程《${lesson.title}》未掌握。`,
      suggestion: `先讲清该指标口径再继续分析（lesson_get(${mapped})），完成时 lesson_complete 判分。`,
    }, `lesson:${mapped}`)
  }

  // 4) 纪律缺口
  if ((facts.thesesTotal ?? 0) > 0) {
    const covered = facts.thesesWithFalsifier ?? 0
    if (covered < (facts.thesesTotal as number)) {
      push({
        kind: 'discipline', priority: 3, ref: 'falsifier-coverage',
        title: `${facts.thesesTotal! - covered}/${facts.thesesTotal} 条观点缺证伪条件`,
        evidence: `${covered}/${facts.thesesTotal} 条观点写了「什么情况下我错」。`,
        suggestion: `逐条补 falsifier（thesis 修改需填 changeReason）；顺带讲《决策日志》decision-journal。`,
      }, 'discipline:falsifier')
    }
    if (facts.journalCount30d === 0) {
      push({
        kind: 'discipline', priority: 5, ref: 'decision-journal',
        title: '30 天内没有决策日记',
        evidence: `已有 ${facts.thesesTotal} 条观点，但近 30 天没有 kind=decision 的笔记。`,
        suggestion: `引导用户写一条「为什么买 / 什么情况下我错」（save_research kind=decision），先讲 decision-journal。`,
      }, 'discipline:journal')
    }
  }
  const rate = facts.weeklyReviewRate
  if (rate !== null && rate !== undefined && rate < 0.5 && (facts.thesesTotal ?? 0) > 0) {
    push({
      kind: 'discipline', priority: 3, ref: 'review-method',
      title: '周复盘覆盖不足',
      evidence: `近 8 周复盘覆盖率 ${Math.round(rate * 100)}%（<50%）。`,
      suggestion: `讲《复盘方法》review-method，然后走首页「生成本周复盘」流程。`,
    }, 'discipline:weekly')
  }

  // 5) 组合穿透告警 → 分散课（引用他自己的告警文本）
  const warn = (facts.lookthroughWarnings ?? [])[0]
  if (warn && !mastered.has('diversification')) {
    push({
      kind: 'lesson', priority: 4, ref: 'diversification',
      title: '补课：分散与仓位',
      evidence: `组合穿透告警：${warn}`,
      suggestion: `用他自己的组合讲《分散与仓位》（对照 alert 数字），然后 lesson_complete(diversification)。`,
    }, 'lesson:diversification')
  }

  // 6) 对话主题命中课程标签（Agent 传入最近话题）
  for (const topic of (facts.recentTopics ?? []).slice(0, 6)) {
    const t = topic.trim().toLowerCase()
    if (!t) continue
    const hit = curriculum.lessons.find((x) => !mastered.has(x.id) && (
      x.tags.some((tag) => t.includes(tag.toLowerCase()) || tag.toLowerCase().includes(t)) ||
      t.includes(x.title.toLowerCase())
    ))
    if (!hit) continue
      push({
        kind: 'lesson', priority: 6, ref: hit.id,
        title: `顺势补课：${hit.title}`,
        evidence: `对话中出现了与《${hit.title}》相关的话题「${topic}」。`,
        suggestion: `最多顺带 1 句概念 + 1 道检验题，不打断主线；用户展开才继续。`,
      }, `lesson:${hit.id}`)
  }

  // 7) 月度成长复盘到期
  const lastReview = [...(state.reviews ?? [])].sort((a, b) => b.period.localeCompare(a.period))[0]
  const now = new Date()
  const ageDays = lastReview
    ? (now.getTime() - Date.parse(`${lastReview.at.slice(0, 10)}T00:00:00Z`)) / 86400000
    : (now.getTime() - Date.parse(`${state.createdAt.slice(0, 10)}T00:00:00Z`)) / 86400000
  if (!Number.isFinite(ageDays) || ageDays > 30) {
    push({
      kind: 'review', priority: 6, ref: 'monthly-review',
      title: '成长月度复盘到期',
      evidence: lastReview ? `上次成长复盘：${lastReview.period}（${Math.round(ageDays)} 天前）。` : `已启用成长档案 ${Math.round(ageDays)} 天，尚无成长复盘。`,
      suggestion: `产出四柱复盘正文（学习/计划/纪律/资产对照上期）→ save_research kind=review → growth_review_mark。`,
    }, 'review:monthly')
  }

  return out.sort((a, b) => a.priority - b.priority).slice(0, 8)
}

/** 指标键 → 课程 id（教材库映射表，集中一处便于测试）。 */
function metricLesson(key: string): string | undefined {
  return METRIC_CONCEPT_MAP[key]
}
