/**
 * 成长工具（Agent 驱动）：状态装载、诊断、取材判分、规划访谈写入、月度复盘标记。
 * 没有任何「用户自助流程」——所有动作都发生在对话里，工具只提供证据与状态回写。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import '@deepseek-ai/dsh-tools'
import type { GrowthStore, PlanSection } from '../growth-store.js'
import type { PortfolioStore } from '../store.js'
import type { PersonalStore } from '../personal.js'
import type { ResearchVault } from '../research/store.js'
import { GROWTH_CURRICULUM, findLesson, lessonByQuery } from '../growth-curriculum.js'
import {
  computeGrowth, computeStreak, diagnoseGrowth, evaluateFamilyPlan, gradeQuiz,
  type DiagnosisFacts, type DiagnosisFinding, type GrowthFacts, type GrowthProfile, type GrowthSummary, type PlanHealth,
} from '../growth.js'

const output = { schema: { type: 'json' as const }, render: (_: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v) }] }
const asJson = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue

export interface GrowthSnapshot {
  summary: GrowthSummary
  streakWeeks: number
  health: PlanHealth
  profile?: GrowthProfile
  plan: ReturnType<GrowthStore['get']>['plan']
  planUpdated?: string
  lessons: { mastered: number; total: number; recentAttempts: Array<{ lessonId: string; score: number; at: string }> }
  reviews: Array<{ period: string; at: string; vaultId?: string; highlights?: string[] }>
  /** Agent 下一步（诊断引擎产出，面板也展示前 4 条）。 */
  nextSteps: DiagnosisFinding[]
  /** 诊断依据（让 Agent 看到数字，而不是凭空行动）。 */
  factsUsed: GrowthFacts & { journalCount30d: number | null }
}

interface Ctx {
  state: ReturnType<GrowthStore['get']>
  health: PlanHealth
  facts: GrowthFacts
  diagFacts: DiagnosisFacts
}

/** 从三个本地状态拼装诊断输入：全程不发网络请求（确定、快、离线可测）。 */
export function gatherGrowthContext(growth: GrowthStore, store: PortfolioStore, personal: PersonalStore, vault?: ResearchVault): Ctx {
  const state = growth.get()
  const holdings = store.get().holdings ?? []
  const ps = personal.get()
  const theses = ps.theses ?? []
  const withFalsifier = theses.filter((t) => (t.falsifiers?.length ?? 0) > 0 || String(t.falsifier ?? '').trim()).length
  const thesisMetrics = [...new Set(theses.flatMap((t) => (t.indicators ?? []).map((i) => i.metricKey)).filter(Boolean))]
  const cardWeeks = [...new Set((ps.cards ?? []).map((c) => c.week))].sort()
  let weeklyReviewRate: number | null = null
  if (theses.length) {
    if (!cardWeeks.length) weeklyReviewRate = 0
    else {
      const firstMs = Date.parse(`${cardWeeks[0]}T00:00:00Z`)
      const elapsed = Math.max(1, Math.min(8, Math.floor((Date.now() - firstMs) / (7 * 86400000)) + 1))
      weeklyReviewRate = Math.min(1, cardWeeks.length / elapsed)
    }
  }
  let journalCount30d: number | null = null
  if (vault) {
    const cutoff = Date.now() - 30 * 86400000
    journalCount30d = vault.list({ limit: 200 })
      .filter((i) => (i.kind === 'decision' || i.kind === 'learn') && Date.parse(`${String(i.createdAt).slice(0, 10)}T00:00:00Z`) >= cutoff)
      .length
  }
  const health = evaluateFamilyPlan(state.plan, state.profile)
  const mastered = state.lessons.filter((x) => x.status === 'mastered').length
  const attempts = state.attempts ?? []
  const quizAvg = attempts.length ? Math.round(attempts.reduce((s, a) => s + a.score, 0) / attempts.length) : null
  const goalFundingRate = health.goalStatus.length
    ? health.goalStatus.reduce((s, g) => s + (g.progressPct ?? 0), 0) / health.goalStatus.length / 100
    : null
  const facts: GrowthFacts = {
    masteredLessons: mastered,
    totalLessons: GROWTH_CURRICULUM.lessons.length,
    quizAvg,
    planHealthScore: health.score,
    falsifierCoverage: theses.length ? withFalsifier / theses.length : null,
    weeklyReviewRate,
    journalCount30d,
    savingsRatePct: health.savingsRatePct,
    goalFundingRate,
  }
  const diagFacts: DiagnosisFacts = {
    holdings: holdings.map((h) => ({ code: h.code, type: h.type ?? 'stock', name: h.name })),
    thesisMetrics,
    thesesTotal: theses.length,
    thesesWithFalsifier: withFalsifier,
    weeklyReviewRate,
    journalCount30d,
  }
  return { state, health, facts, diagFacts }
}

export function buildGrowthSnapshot(growth: GrowthStore, store: PortfolioStore, personal: PersonalStore, vault?: ResearchVault, topics?: string[]): GrowthSnapshot & { diagFacts: DiagnosisFacts } {
  const { state, health, facts, diagFacts } = gatherGrowthContext(growth, store, personal, vault)
  const summary = computeGrowth(facts)
  const streakWeeks = computeStreak(state.activityDates)
  const nextSteps = diagnoseGrowth({ state, facts: { ...diagFacts, ...(topics?.length ? { recentTopics: topics } : {}) } })
  return {
    summary,
    streakWeeks,
    health,
    profile: state.profile,
    plan: state.plan,
    planUpdated: state.plan.updated,
    lessons: {
      mastered: facts.masteredLessons,
      total: facts.totalLessons,
      recentAttempts: (state.attempts ?? []).slice(0, 5),
    },
    reviews: (state.reviews ?? []).slice(0, 6),
    nextSteps: nextSteps.slice(0, 6),
    factsUsed: facts,
    diagFacts,
  }
}

export function registerGrowthTools(
  ctx: Context,
  growth: GrowthStore,
  store: PortfolioStore,
  personal: PersonalStore,
  vault?: ResearchVault,
) {
  const snapshot = (topics?: string[]) => buildGrowthSnapshot(growth, store, personal, vault, topics)

  ctx.tools.register(defineTool({
    name: 'growth_state',
    description: '装载成长档案：四柱评分/等级/连续周、家庭财务健康度+修复项、课程进度、诊断出的下一步（nextSteps，带证据）。用户聊到学习、家庭财务、规划、「我该学什么」或复盘时先调它，作为一切成长动作的记忆底座；只读。',
    parameters: {},
    output,
    async execute() {
      const s = snapshot()
      return asJson({
        ok: true,
        summary: s.summary,
        streakWeeks: s.streakWeeks,
        health: s.health,
        profile: s.profile,
        planUpdated: s.planUpdated,
        lessons: s.lessons,
        reviews: s.reviews,
        nextSteps: s.nextSteps,
        factsUsed: s.factsUsed,
        reminder: '下一步只挑 1 件做：规划修复项优先于教学，教学优先于复盘；激励只谈过程，不承诺收益。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'growth_diagnose',
    description: '成长诊断：基于本地状态（持仓/观点指标/复盘/计划）输出带证据的缺口清单——回答「学什么、先修什么」。用户问「我该学什么 / 我是新手」、每次成长复盘前、或你发现概念缺口时调用；可附 recentTopics 关联对话主题。结论由你结合上下文决策，一次只执行 1 条。',
    parameters: {
      recentTopics: { type: 'array', items: { type: 'string' }, description: '最近对话主题（≤6 条短语，如「ETF折溢价」），用于顺势补课' },
    },
    output,
    async execute(args) {
      const topics = Array.isArray(args.recentTopics) ? args.recentTopics.map((x: unknown) => String(x)).filter(Boolean).slice(0, 6) : undefined
      const s = snapshot(topics)
      return asJson({
        ok: true,
        findings: s.nextSteps,
        factsUsed: s.factsUsed,
        planFixes: s.health.fixes,
        emptyNote: s.nextSteps.length ? undefined : '未发现明显缺口：保持当前节奏，下月做一次成长复盘即可。',
        rule: 'findings 按优先级排序；一次只处理 1 条（priority 最高或与当前对话最相关），讲微课 = 3 个要点 + 1 题检验 + lesson_complete 判分。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lesson_get',
    description: '取教材：给 lesson id 返回整课（要点+测验题含答案，供你判分）；给 query 模拟糊找最多 3 条候选。微课讲解只讲 3 个要点、不要照本宣科；测验题直接在对话里问，答案提交给 lesson_complete。',
    parameters: {
      id: { type: 'string', description: '课程 id，如 etf-premium' },
      query: { type: 'string', description: '模糊检索：标题/标签片段，如「折溢价」「复利」' },
    },
    output,
    async execute(args) {
      const id = String(args.id ?? '').trim()
      const query = String(args.query ?? '').trim()
      if (id) {
        const lesson = findLesson(id)
        if (!lesson) throw new Error(`未知课程 id：${id}（用 query 搜索）`)
        return asJson({ ok: true, lesson })
      }
      if (query) {
        const hits = lessonByQuery(query)
        if (!hits.length) return asJson({ ok: true, candidates: [], note: '无匹配课程；换关键词或直接讲清概念（不要硬套课程）。' })
        if (hits.length === 1) return asJson({ ok: true, lesson: hits[0] })
        return asJson({ ok: true, candidates: hits.map((x) => ({ id: x.id, title: x.title, track: x.track, minutes: x.minutes })) })
      }
      throw new Error('需要 id 或 query')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lesson_complete',
    description: '提交测验判分（≥80 记 mastered，<80 记 learning 可重考）。你先在对话里问原题、收集用户答案，再用 answers（按题目顺序的选项下标数组）提交；返回判分与解析，用解析纠正错误认知。诚实判分，不得代答。',
    parameters: {
      id: { type: 'string', required: true, description: '课程 id' },
      answers: { type: 'array', required: true, items: { type: 'number' }, description: '按题目顺序的选项下标数组，如 [1,0]' },
    },
    output,
    async execute(args) {
      const lesson = findLesson(String(args.id ?? ''))
      if (!lesson) throw new Error(`未知课程 id：${args.id}`)
      const answers = (Array.isArray(args.answers) ? args.answers : []).map((x: unknown) => Number(x))
      const graded = gradeQuiz(lesson, answers)
      const rec = await growth.recordQuiz(lesson.id, graded.score, graded.passed)
      return asJson({
        ok: true,
        lesson: { id: lesson.id, title: lesson.title },
        ...rec.attempt,
        passed: graded.passed,
        masteredCount: rec.masteredCount,
        totalLessons: GROWTH_CURRICULUM.lessons.length,
        details: lesson.quiz.map((q, i) => ({
          q: q.q,
          yourAnswer: q.options[graded.details[i]!.given],
          correctAnswer: q.options[q.answer],
          correct: graded.details[i]!.correct,
          explain: q.explain,
        })),
        note: graded.passed
          ? '已记 mastered。用一句话确认用户真正理解了要点，再回到主线任务。'
          : '未达标（<80）。用 explain 纠正错误认知，可当场重问或稍后重考——不刷题库，理解优先。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'family_plan_get',
    description: '读取家庭财务档案（画像/现金流/资产负债/目标/保障）+ 健康度与修复项。规划类对话的第一步；数据只存本地，读时不要外传。',
    parameters: {},
    output,
    async execute() {
      const s = snapshot()
      return asJson({ ok: true, profile: s.profile, plan: s.plan, health: s.health, summary: s.summary })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'family_plan_update',
    description: '写入家庭财务档案（对话式访谈：一次问一个问题、说明用途、敏感数据只存本地）。section=profile|cashflow|balance|goals|protection；对象段浅合并，goals/protection 数组整段替换（先 family_plan_get 再改）。返回更新后的健康度。',
    parameters: {
      section: { type: 'string', enum: ['profile', 'cashflow', 'balance', 'goals', 'protection'], required: true, description: '要写入的段' },
      data: { type: 'object', required: true, additionalProperties: true, description: '该段数据（结构见 family_plan_get 返回）' },
    },
    output,
    async execute(args) {
      const section = String(args.section ?? '') as PlanSection
      if (section === 'profile') {
        const profile = await growth.updateProfile(args.data)
        const s = snapshot()
        return asJson({ ok: true, profile, health: s.health, summary: s.summary })
      }
      const { plan } = await growth.updatePlanSection(section, args.data)
      const s = snapshot()
      return asJson({ ok: true, section, plan, health: s.health, nextSteps: s.nextSteps.slice(0, 3) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'growth_review_mark',
    description: '标记月度成长复盘完成（连续周 streak +1）。前置：先产出四柱复盘正文（学习/计划/纪律/资产：对照上期、引用数字、下月一个改进动作）并 save_research kind=review 落库，把返回的 id 作为 vaultId 传入。period 默认当月 YYYY-MM。',
    parameters: {
      period: { type: 'string', description: 'YYYY-MM，默认当月；同一月重复调用覆盖（幂等）' },
      vaultId: { type: 'string', description: '复盘正文在资料库的 id（save_research 返回）' },
      highlights: { type: 'array', items: { type: 'string' }, description: '3-6 条要点（下月对照用）' },
    },
    output,
    async execute(args) {
      const period = String(args.period ?? '') || new Date().toISOString().slice(0, 7)
      const vaultId = args.vaultId ? String(args.vaultId) : undefined
      const highlights = Array.isArray(args.highlights) ? args.highlights.map((x: unknown) => String(x)) : undefined
      const { review } = await growth.markReview(period, vaultId, highlights)
      const s = snapshot()
      return asJson({ ok: true, review, streakWeeks: s.streakWeeks, summary: s.summary, nextSteps: s.nextSteps.slice(0, 3) })
    },
  }))
}
