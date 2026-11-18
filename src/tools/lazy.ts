import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const MAX_ACTIVE_TOOLS = 8
const MAX_SEARCH_RESULTS = 5
const MAX_MCP_INSTRUCTIONS_CHARS = 4_000

type PromptSection = Parameters<Context['systemPrompt']['section']>[0]
interface CapturedPrompt { section: PromptSection; unregister?: () => void }

const TOPICS = [
  { id: 'quotes', label: '行情与标的', terms: ['行情', '报价', '股价', '价格', '实时', 'k线', '走势', '代码', '选股', '股票', '市场'] },
  { id: 'funds', label: '基金与 ETF', terms: ['基金', 'etf', '净值', '基金经理', '基金排行', '基金风险'] },
  { id: 'portfolio', label: '持仓与组合', terms: ['持仓', '组合', '资产配置', '再平衡', '调仓', '集中度', '穿透'] },
  { id: 'research', label: '投研资料', terms: ['资料', '研报', '新闻', '笔记', '观点', '研究', '收藏'] },
  { id: 'personal', label: '投资档案与复盘', terms: ['复盘', '投资观点', '建档', '投资档案', '证据卡', '判断', '投资目标'] },
  { id: 'growth', label: '成长与家庭财务', terms: ['成长', '学习', '家庭财务', '规划', '微课', '课程'] },
  { id: 'follow', label: '机构与人物追踪', terms: ['追踪', '机构', '巴菲特', '13f', '政客', '申报', '名私募'] },
  { id: 'history', label: '历史数据', terms: ['历史', '同步历史', '历史数据', '事件标记', '本地数据'] },
  { id: 'strategy', label: '策略研究', terms: ['策略', '回测', '策略草案', '鲁棒性'] },
  { id: 'alerts', label: '提醒', terms: ['提醒', '异动', '未读提醒'] },
  { id: 'sources', label: '数据源与能力', terms: ['数据源', '数据能力', '能力目录', '来源', 'westock', 'mcp'] },
  { id: 'macro', label: '宏观与资讯', terms: ['宏观', '利率', '快讯', '板块', '资讯'] },
] as const

type TopicId = typeof TOPICS[number]['id']
interface Entry {
  definition: ToolDefinition
  owner: string
  pinned: boolean
  loadedAt?: number
  unregister?: () => void
}

function inferTopic(name: string, description: string): TopicId {
  const value = `${name} ${description}`.toLowerCase()
  if (value.startsWith('mcp__') || /_call$|_schema$|_list$/.test(name)) return 'sources'
  if (/fund|etf|基金/.test(value)) return 'funds'
  if (/portfolio|holding|rebalance|position|持仓|组合/.test(value)) return 'portfolio'
  if (/research|report|news|资料|研报/.test(value)) return 'research'
  if (/weekly|thesis|personal|复盘|观点|档案/.test(value)) return 'personal'
  if (/growth|lesson|family_plan|成长|课程/.test(value)) return 'growth'
  if (/follow|13f|shadow|追踪/.test(value)) return 'follow'
  if (/history|历史|kline/.test(value)) return 'history'
  if (/strategy|策略|backtest/.test(value)) return 'strategy'
  if (/reminder|提醒/.test(value)) return 'alerts'
  if (/probe|provider|source|westock|mcp/.test(value)) return 'sources'
  if (/macro|sector|market|news|宏观|板块/.test(value)) return 'macro'
  return 'quotes'
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

const jsonOutput = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

/**
 * Holds plugin tool definitions off the model-facing registry until a search
 * explicitly activates a small, relevant subset. The actual definitions still
 * execute through the host ToolRuntime after activation (guards and middleware
 * are therefore unchanged).
 */
export class LazyToolCatalog {
  private readonly entries = new Map<string, Entry>()
  private readonly active = new Map<string, Entry>()
  private readonly prompts = new Map<string, CapturedPrompt>()
  constructor(
    private readonly runtime: Pick<Context['tools'], 'register'>,
    private readonly promptRuntime?: Context['systemPrompt'],
  ) {}

  captureContext(ctx: Context, owner = 'dsh-finance', capturePrompt = false): Context {
    const runtime = ctx.tools
    const captureRuntime = new Proxy(runtime, {
      get: (target, property) => {
        if (property === 'register') return (definition: ToolDefinition) => this.capture(definition, owner)
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const overrides: Record<string, unknown> = { tools: captureRuntime }
    if (capturePrompt) {
      const prompt = ctx.systemPrompt
      overrides.systemPrompt = new Proxy(prompt, {
        get: (target, property) => {
          if (property === 'section') return (section: PromptSection) => this.capturePrompt(owner, section)
          const value = Reflect.get(target, property, target) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }
    // A real Cordis child scope is important here: nested plugins (notably MCP)
    // resolve the same captured runtimes through normal service lookup.
    return ctx.extend(overrides as never) as Context
  }

  capture(definition: ToolDefinition, owner = 'dsh-finance'): () => void {
    const previous = this.entries.get(definition.name)
    if (previous?.owner !== owner && previous) throw new Error(`Duplicate lazy finance tool: ${definition.name}`)
    if (previous) {
      previous.unregister?.()
      this.active.delete(definition.name)
      this.deactivatePromptIfUnused(previous.owner)
    }
    const entry: Entry = { definition, owner, pinned: false }
    this.entries.set(definition.name, entry)
    return () => {
      if (this.entries.get(definition.name) !== entry) return
      entry.unregister?.()
      this.active.delete(definition.name)
      this.entries.delete(definition.name)
      this.deactivatePromptIfUnused(entry.owner)
    }
  }

  count(owner?: string): number {
    return [...this.entries.values()].filter((entry) => !owner || entry.owner === owner).length
  }

  names(owner?: string): string[] {
    return [...this.entries.entries()].filter(([, entry]) => !owner || entry.owner === owner).map(([name]) => name)
  }

  pin(name: string): void {
    const entry = this.entries.get(name)
    if (!entry) throw new Error(`Cannot pin unknown tool: ${name}`)
    entry.pinned = true
    this.activate(entry)
  }

  /** Register the small, always-available retrieval entry point. */
  registerSearchTool(ctx: Context): () => void {
    const catalog = this
    return ctx.tools.register(defineTool({
      name: 'finance_find_tools',
      description: '按自然语言检索并加载相关金融工具。先搜“基金排行”“持仓分析”“追踪巴菲特”等主题；返回后相关工具会加入本轮可用工具，再调用具体工具。每次最多加载 5 个。',
      parameters: {
        query: { type: 'string', required: true, description: '要完成的具体任务或关键词，如“基金经理与风险”“新增持仓的集中度影响”“研报资料库”' },
        limit: { type: 'number', description: '最多加载几个相关工具，默认 3，最大 5' },
      },
      output: jsonOutput,
      async execute(args) {
        const query = String(args.query ?? '').trim().toLowerCase()
        if (!query) return asJson({ ok: false, error: '请提供要完成的任务或关键词。' })
        const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(Number(args.limit) || 3)))
        const matches = catalog.search(query).slice(0, limit)
        if (!matches.length) {
          return asJson({
            ok: true,
            query,
            loaded: [],
            topics: TOPICS.map(({ label }) => label),
            note: '没有直接匹配。请改用更具体的关键词，或按上面的主题搜索。',
          })
        }
        for (const match of matches) catalog.activate(match.entry)
        catalog.evictOverflow()
        return asJson({
          ok: true,
          query,
          loaded: matches.map(({ entry }) => ({ name: entry.definition.name, description: entry.definition.description })),
          activeToolCount: catalog.active.size,
          note: '相关工具定义已加入对话工具集；请在下一步调用上面列出的具体工具。',
        })
      },
    }))
  }

  dispose(): void {
    for (const entry of this.active.values()) entry.unregister?.()
    for (const prompt of this.prompts.values()) prompt.unregister?.()
    this.active.clear()
    this.entries.clear()
    this.prompts.clear()
  }

  private capturePrompt(owner: string, section: PromptSection): () => void {
    this.prompts.get(owner)?.unregister?.()
    const captured: CapturedPrompt = { section }
    this.prompts.set(owner, captured)
    if ([...this.active.values()].some((entry) => entry.owner === owner)) this.activatePrompt(owner)
    return () => {
      if (this.prompts.get(owner) !== captured) return
      captured.unregister?.()
      this.prompts.delete(owner)
    }
  }

  private activatePrompt(owner: string): void {
    const captured = this.prompts.get(owner)
    if (!captured || captured.unregister || !this.promptRuntime) return
    const originalText = captured.section.text
    const text: PromptSection['text'] = typeof originalText === 'function'
      ? (context) => this.boundInstruction(originalText(context))
      : this.boundInstruction(originalText)
    captured.unregister = this.promptRuntime.section({ ...captured.section, text })
  }

  private boundInstruction(text: string): string {
    if (text.length <= MAX_MCP_INSTRUCTIONS_CHARS) return text
    return `${text.slice(0, MAX_MCP_INSTRUCTIONS_CHARS)}\n[外部数据源说明已截断；请以工具 schema 和结果为准]`
  }

  private deactivatePromptIfUnused(owner: string): void {
    if ([...this.active.values()].some((entry) => entry.owner === owner)) return
    const prompt = this.prompts.get(owner)
    prompt?.unregister?.()
    if (prompt) prompt.unregister = undefined
  }

  private search(query: string): Array<{ entry: Entry; score: number }> {
    const topicMatches = TOPICS.filter((topic) => topic.terms.some((term) => query.includes(term)))
    const words = query.split(/[\s,，。；;：:、/]+/).filter((word) => word.length > 1)
    const scored: Array<{ entry: Entry; score: number }> = []
    for (const [name, entry] of this.entries) {
      const description = entry.definition.description.toLowerCase()
      const topic = inferTopic(name, description)
      let score = 0
      if (name.toLowerCase() === query) score += 100
      if (name.toLowerCase().includes(query)) score += 35
      for (const word of words) {
        if (name.toLowerCase().includes(word)) score += 12
        if (description.includes(word)) score += 5
      }
      for (const match of topicMatches) {
        if (topic === match.id) score += 22
        if (name.toLowerCase().includes(match.id)) score += 8
      }
      // A concrete tool name in a request should beat broad category matches.
      if (name.toLowerCase().includes(query.replace(/\s+/g, '_'))) score += 80
      if (score > 0) scored.push({ entry, score })
    }
    return scored.sort((a, b) => b.score - a.score || a.entry.definition.name.localeCompare(b.entry.definition.name))
  }

  private activate(entry: Entry): void {
    if (entry.unregister) {
      entry.loadedAt = Date.now()
      return
    }
    const unregister = this.runtime.register(entry.definition)
    entry.unregister = unregister
    entry.loadedAt = Date.now()
    this.active.set(entry.definition.name, entry)
    this.activatePrompt(entry.owner)
  }

  private evictOverflow(): void {
    if (this.active.size <= MAX_ACTIVE_TOOLS) return
    const candidates = [...this.active.entries()]
      .filter(([, entry]) => !entry.pinned)
      .sort((a, b) => (a[1].loadedAt ?? 0) - (b[1].loadedAt ?? 0))
    while (this.active.size > MAX_ACTIVE_TOOLS && candidates.length) {
      const [name, entry] = candidates.shift()!
      entry.unregister?.()
      entry.unregister = undefined
      entry.loadedAt = undefined
      this.active.delete(name)
      this.deactivatePromptIfUnused(entry.owner)
    }
  }
}
