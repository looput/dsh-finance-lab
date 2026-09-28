import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { FinanceDataService } from '../data/service.js'
import type { PanelBus } from '../panel-bus.js'
import {
  RESEARCH_KINDS,
  RESEARCH_STATUSES,
  ResearchValidationError,
  type ResearchFilter,
  type ResearchItem,
  type ResearchKind,
  type ResearchOrigin,
  type ResearchStatus,
  type ResearchVault,
} from './store.js'

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

const jsonOut = {
  schema: { type: 'json' as const },
  render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
}

function normKind(v: unknown): ResearchKind {
  const k = String(v ?? '').toLowerCase()
  return (RESEARCH_KINDS as string[]).includes(k) ? (k as ResearchKind) : 'other'
}

function normStatus(v: unknown): ResearchStatus {
  const s = String(v ?? '').toLowerCase()
  return (RESEARCH_STATUSES as string[]).includes(s) ? (s as ResearchStatus) : 'inbox'
}

function normList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，\s]+/) : []
  return [...new Set(raw.map((x) => String(x ?? '').trim()).filter(Boolean))]
}

function dayOf(v: unknown): string {
  const raw = String(v ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10)
}

/** Compact list row: enough to pick an item, cheap enough for context. */
function brief(item: ResearchItem) {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    source: item.source,
    date: item.occurredAt,
    status: item.status,
    codes: item.codes,
    tags: item.tags,
    opinion: item.opinion,
    notes: item.notes.length,
    file: item.file,
    origin: item.origin ?? 'panel',
  }
}

/** Normalize the two news row shapes (东财 {date,source} / WeStock {time,src}). */
function normalizeNewsRow(r: Record<string, unknown>) {
  return {
    title: String(r.title ?? '').trim(),
    source: String(r.source ?? r.src ?? '').trim() || '未知来源',
    time: dayOf(r.time ?? r.date ?? ''),
    url: r.url ? String(r.url) : undefined,
    summary: r.summary ? String(r.summary) : undefined,
  }
}

export interface CollectOptions {
  code: string
  kind: 'report' | 'news'
  size?: number
  withBody?: boolean
  tags?: string[]
  status?: ResearchStatus
  /** 入库渠道：Agent 工具调用默认 chat，面板调用默认 panel。 */
  origin?: ResearchOrigin
  signal?: AbortSignal
}

export interface CollectResult {
  ok: boolean
  vault: string
  code: string
  kind: string
  saved: number
  skipped: number
  items: ResearchItem[]
  skippedList?: Array<{ title: string; reason: string }>
  errors?: string[]
  error?: string
  hint?: string
}

/**
 * Collect research material from data sources into the vault.
 * Shared by the `collect_research` tool and the panel's HTTP route so both
 * paths dedupe and persist identically.
 */
export async function collectResearch(
  finance: FinanceDataService,
  vault: ResearchVault,
  options: CollectOptions,
): Promise<CollectResult> {
  const code = options.code
  const kind = options.kind === 'news' ? 'news' : 'report'
  const size = Math.min(Math.max(Number(options.size ?? 5), 1), 20)
  const tags = options.tags ?? []
  const status = options.status ?? 'inbox'
  const saved: ResearchItem[] = []
  const skipped: Array<{ title: string; reason: string }> = []
  const errors: string[] = []
  const base = { vault: vault.dir, code, kind }

  if (kind === 'report') {
    const res = await finance.getResearchReports(code, size, options.signal)
    if (!res.ok || !Array.isArray(res.data)) {
      return { ok: false, ...base, saved: 0, skipped: 0, items: [], error: res.error ?? '研报数据源不可用', hint: '可先运行 probe_finance_sources 或检查 westock CLI 是否安装' }
    }
    for (const row of res.data) {
      const title = String(row.title ?? '').trim()
      if (!title) continue
      const date = dayOf(row.time)
      const dup = vault.list({ query: title.slice(0, 20), limit: 50 }).some((i) => i.title === title && i.occurredAt === date)
      if (dup) { skipped.push({ title, reason: '已存在（标题+时间重复）' }); continue }
      let body = `机构：${row.org ?? '—'}　评级：${row.rating ?? '—'}　类型：${row.type ?? '—'}\n\n${row.summary ?? ''}`
      if (options.withBody && row.id) {
        const detail = await finance.getResearchReportDetail(row.id, options.signal)
        if (detail.ok && detail.data?.body) body = detail.data.body
        else if (!detail.ok) errors.push(`正文获取失败 ${row.id}: ${detail.error}`)
      }
      saved.push(await vault.create({
        title,
        kind: 'report',
        source: row.org ? `${row.org}研报` : 'WeStock 研报',
        occurredAt: date,
        codes: [code],
        tags: [...new Set(['研报', ...(row.org ? [row.org] : []), ...(row.rating ? [row.rating] : []), ...tags])],
        summary: row.summary,
        sourceUrl: row.url,
        body,
        status,
        origin: options.origin ?? 'chat',
      }))
    }
  } else {
    const res = await finance.getStockNews(code, size, options.signal)
    if (!res.ok || !Array.isArray(res.data)) {
      return { ok: false, ...base, saved: 0, skipped: 0, items: [], error: res.error ?? '资讯数据源不可用' }
    }
    for (const raw of res.data as Array<Record<string, unknown>>) {
      const row = normalizeNewsRow(raw)
      if (!row.title) continue
      const dup = vault.list({ query: row.title.slice(0, 20), limit: 50 }).some((i) => i.title === row.title && i.occurredAt === row.time)
      if (dup) { skipped.push({ title: row.title, reason: '已存在（标题+时间重复）' }); continue }
      saved.push(await vault.create({
        title: row.title,
        kind: 'news',
        source: row.source,
        occurredAt: row.time,
        codes: [code],
        tags: [...new Set(['资讯', ...tags])],
        summary: row.summary,
        sourceUrl: row.url,
        status,
        origin: options.origin ?? 'chat',
      }))
    }
  }

  return {
    ok: saved.length > 0,
    ...base,
    saved: saved.length,
    skipped: skipped.length,
    items: saved,
    ...(skipped.length ? { skippedList: skipped.slice(0, 5) } : {}),
    ...(errors.length ? { errors: errors.slice(0, 5) } : {}),
  }
}

export function registerResearchTools(
  ctx: Context,
  finance: FinanceDataService,
  vault: ResearchVault,
  bus: PanelBus,
) {
  ctx.tools.register(defineTool({
    name: 'save_research',
    description: '把一条投研资料存入资料库（研报/财报/个人观点/资讯）。source（来源）与 date（资料时间）必填；可关联 codes（标的）与 opinion（观点）。正文落盘为 Markdown，可被文件工具继续编辑。',
    parameters: {
      title: { type: 'string', required: true, description: '资料标题' },
      source: { type: 'string', required: true, description: '来源，如「诚通证券研报」「公司公告」「个人观点」' },
      date: { type: 'string', required: true, description: '资料时间 YYYY-MM-DD（研报发布日/财报期/观点日期）' },
      kind: { type: 'string', enum: [...RESEARCH_KINDS], description: 'report 研报 / filing 财报 / note 观点 / news 资讯 / other' },
      codes: { type: 'array', items: { type: 'string' }, description: '关联标的代码，如 ["600519"]' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签，如 ["白酒","中报"]' },
      summary: { type: 'string', description: '一句话摘要' },
      opinion: { type: 'string', description: '个人观点/结论（可与资料一起沉淀）' },
      body: { type: 'string', description: '正文或摘录（Markdown）' },
      url: { type: 'string', description: '原文链接' },
      status: { type: 'string', enum: [...RESEARCH_STATUSES], description: 'inbox 待整理 / active 在用 / archived 已归档，默认 inbox' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        const item = await vault.create({
          title: String(args.title ?? ''),
          source: String(args.source ?? ''),
          occurredAt: String(args.date ?? ''),
          kind: normKind(args.kind),
          codes: normList(args.codes),
          tags: normList(args.tags),
          summary: args.summary ? String(args.summary) : undefined,
          opinion: args.opinion ? String(args.opinion) : undefined,
          body: args.body ? String(args.body) : undefined,
          sourceUrl: args.url ? String(args.url) : undefined,
          status: normStatus(args.status),
          origin: 'chat',
        })
        bus.publish({ kind: 'research', action: 'save', id: item.id, title: item.title, origin: 'chat' })
        return asJson({ ok: true, vault: vault.dir, item: brief(item) })
      } catch (err) {
        const message = err instanceof ResearchValidationError ? err.message : (err instanceof Error ? err.message : String(err))
        return asJson({ ok: false, error: message })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_research',
    description: '检索资料库：按 kind/status/code/tag/关键词过滤，返回条目清单（不含正文）。',
    parameters: {
      kind: { type: 'string', enum: [...RESEARCH_KINDS] },
      status: { type: 'string', enum: [...RESEARCH_STATUSES], description: '默认全部；传 inbox/active/archived 过滤' },
      code: { type: 'string', description: '关联标的代码，如 600519' },
      tag: { type: 'string' },
      query: { type: 'string', description: '全文关键词（标题/摘要/观点/批注/标签）' },
      limit: { type: 'number', description: '返回条数，默认 20' },
    },
    output: jsonOut,
    async execute(args) {
      const filter: ResearchFilter = {
        kind: args.kind ? normKind(args.kind) : undefined,
        status: args.status ? normStatus(args.status) : undefined,
        code: args.code ? String(args.code) : undefined,
        tag: args.tag ? String(args.tag) : undefined,
        query: args.query ? String(args.query) : undefined,
        limit: Number(args.limit) > 0 ? Number(args.limit) : 20,
      }
      const items = vault.list(filter)
      return asJson({ ok: true, vault: vault.dir, count: items.length, stats: vault.stats(), items: items.map(brief) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_research',
    description: '读取一条资料的完整内容（含正文 Markdown 与全部观点批注）。',
    parameters: { id: { type: 'string', required: true } },
    output: jsonOut,
    async execute(args) {
      const item = vault.find(String(args.id ?? ''))
      if (!item) return asJson({ ok: false, error: `资料不存在：${args.id}` })
      const body = await vault.readBody(item)
      return asJson({ ok: true, vault: vault.dir, path: `${vault.dir}/${item.file}`, item, body })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'update_research',
    description: '更新一条资料的元数据/关联/状态（标题、摘要、观点、codes、tags、status）。归档用 archive_research。',
    parameters: {
      id: { type: 'string', required: true },
      title: { type: 'string' },
      summary: { type: 'string' },
      opinion: { type: 'string', description: '个人观点/结论' },
      codes: { type: 'array', items: { type: 'string' }, description: '覆盖式设置关联标的' },
      tags: { type: 'array', items: { type: 'string' }, description: '覆盖式设置标签' },
      status: { type: 'string', enum: [...RESEARCH_STATUSES] },
      kind: { type: 'string', enum: [...RESEARCH_KINDS] },
    },
    output: jsonOut,
    async execute(args) {
      try {
        const item = await vault.update(String(args.id ?? ''), {
          ...(args.title ? { title: String(args.title) } : {}),
          ...(args.summary ? { summary: String(args.summary) } : {}),
          ...(args.opinion ? { opinion: String(args.opinion) } : {}),
          ...(args.codes !== undefined ? { codes: normList(args.codes) } : {}),
          ...(args.tags !== undefined ? { tags: normList(args.tags) } : {}),
          ...(args.status ? { status: normStatus(args.status) } : {}),
          ...(args.kind ? { kind: normKind(args.kind) } : {}),
        })
        bus.publish({ kind: 'research', action: 'update', id: item.id, title: item.title, origin: 'chat' })
        return asJson({ ok: true, item: brief(item) })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'add_research_note',
    description: '给资料追加一条带时间戳的观点/批注（持续积累，不覆盖历史）。',
    parameters: {
      id: { type: 'string', required: true },
      note: { type: 'string', required: true, description: '观点或批注内容' },
      author: { type: 'string', description: '标注作者/角色，默认「我」' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        const item = await vault.addNote(String(args.id ?? ''), String(args.note ?? ''), args.author ? String(args.author) : '我')
        bus.publish({ kind: 'research', action: 'note', id: item.id, title: item.title, origin: 'chat' })
        return asJson({ ok: true, id: item.id, notes: item.notes })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'archive_research',
    description: '归档/恢复一条资料（status=archived 或 active）。归档不删除，仍可检索。',
    parameters: {
      id: { type: 'string', required: true },
      restore: { type: 'boolean', description: 'true 恢复为在用(active)，默认 false 归档' },
    },
    output: jsonOut,
    async execute(args) {
      try {
        const item = await vault.setStatus(String(args.id ?? ''), args.restore === true ? 'active' : 'archived')
        bus.publish({ kind: 'research', action: args.restore === true ? 'restore' : 'archive', id: item.id, title: item.title, origin: 'chat' })
        return asJson({ ok: true, id: item.id, status: item.status, archivedAt: item.archivedAt })
      } catch (err) {
        return asJson({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'collect_research',
    description: '从数据源（WeStock 研报/资讯）批量收集资料并入库：自动带来源与时间、关联标的代码、按标题+时间去重。用于「持续收集整理」。',
    parameters: {
      code: { type: 'string', required: true, description: '标的代码，如 600519 / 00700 / AAPL' },
      kind: { type: 'string', enum: ['report', 'news'], description: 'report 研报（WeStock）/ news 资讯，默认 report' },
      size: { type: 'number', description: '收集条数，默认 5（1-20）' },
      withBody: { type: 'boolean', description: '研报模式下是否抓取正文（较慢），默认 false' },
      tags: { type: 'array', items: { type: 'string' }, description: '附加标签' },
      status: { type: 'string', enum: [...RESEARCH_STATUSES], description: '入库状态，默认 inbox' },
    },
    output: jsonOut,
    async execute(args, exec) {
      const result = await collectResearch(finance, vault, {
        code: String(args.code ?? '').trim(),
        kind: String(args.kind ?? 'report') === 'news' ? 'news' : 'report',
        size: Number(args.size ?? 5),
        withBody: args.withBody === true,
        tags: normList(args.tags),
        status: normStatus(args.status),
        signal: exec.signal,
      })
      if (result.items.length) {
        bus.publish({
          kind: 'research',
          action: 'collect',
          id: result.items[0]!.id,
          title: result.items.length === 1 ? result.items[0]!.title : `${result.items.length} 条 ${result.code} 资料`,
          count: result.items.length,
          origin: 'chat',
        })
      }
      return asJson({ ...result, items: result.items.map(brief) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sync_research',
    description: '扫描资料库目录并把磁盘上的改动合并回索引：用文件工具手工新建/编辑/删除 Markdown 后调用，保证面板与索引看到最新内容。',
    parameters: {},
    output: jsonOut,
    async execute() {
      const result = await vault.syncFromDisk()
      if (result.added || result.updated || result.missing) bus.publish({ kind: 'research', action: 'sync', id: result.changed[0] ?? '', origin: 'chat' })
      return asJson({ ok: true, vault: vault.dir, ...result, stats: vault.stats() })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'research_overview',
    description: '资料库总览：总数、按类型/状态分布、关联最多的标的。用于判断「哪些标的资料积累够了」。',
    parameters: {},
    output: jsonOut,
    async execute() {
      return asJson({ ok: true, vault: vault.dir, ...vault.stats() })
    },
  }))
}
