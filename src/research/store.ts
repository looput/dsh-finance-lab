import { confirmations } from '../confirmations.js'
import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../log.js'

/**
 * Research Vault — 投研过程资料库（研报 / 财报 / 个人观点 / 新闻剪藏）。
 *
 * 设计取舍：
 * - **不做孤岛**：每条资料必须带 `source`（来源）与 `occurredAt`（时间戳），
 *   可关联 `codes`（标的）与 `notes/opinion`（观点），因此资料天然挂在一棵
 *   「标的 → 观点」的图上，而不是一堆散落文件。
 * - **落工作区**：正文以 Markdown 落盘（`<vault>/<年>/<id>-<slug>.md`），
 *   宿主的文件技能可以直接读写/检索这些文件；`index.json` 只是可重建的索引。
 * - **可扩展**：kind 为开放枚举（report/filing/note/news/other），
 *   tags 自由，status 走 inbox → active → archived 的归档流。
 */

export type ResearchKind = 'report' | 'filing' | 'note' | 'news' | 'other'
export type ResearchStatus = 'inbox' | 'active' | 'archived'
/**
 * 资料是从哪条链路进库的：
 * - `chat`：Agent 对话里收集/产出后落库（工具调用）
 * - `panel`：面板手动新建或收集
 * - `file`：外部文件（编辑器 / 文件工具）写入被同步采纳
 */
export type ResearchOrigin = 'chat' | 'panel' | 'file'

export const ORIGIN_LABEL: Record<ResearchOrigin, string> = {
  chat: '对话',
  panel: '面板',
  file: '文件',
}

export const RESEARCH_KINDS: ResearchKind[] = ['report', 'filing', 'note', 'news', 'other']
export const RESEARCH_STATUSES: ResearchStatus[] = ['inbox', 'active', 'archived']

export const KIND_LABEL: Record<ResearchKind, string> = {
  report: '研报',
  filing: '财报',
  note: '观点',
  news: '资讯',
  other: '其他',
}

export const STATUS_LABEL: Record<ResearchStatus, string> = {
  inbox: '待整理',
  active: '在用',
  archived: '已归档',
}

export interface ResearchNote {
  at: string
  text: string
  author?: string
}

export interface ResearchItem {
  id: string
  title: string
  kind: ResearchKind
  /** 必填：资料来源（机构名 / 网站 / "个人观点"）。 */
  source: string
  /** 必填：资料本身的时间（YYYY-MM-DD 或 ISO）。 */
  occurredAt: string
  createdAt: string
  updatedAt: string
  status: ResearchStatus
  /** 关联标的代码（600519 / 00700 / AAPL / 110022）。 */
  codes: string[]
  tags: string[]
  summary?: string
  /** 一句话个人观点（结论/判断）。 */
  opinion?: string
  sourceUrl?: string
  /** 相对 vault 根目录的 Markdown 文件，可被宿主文件工具直接编辑。 */
  file: string
  notes: ResearchNote[]
  archivedAt?: string
  /** 入库渠道：Agent 对话 / 面板 / 外部文件（用于区分「对话沉淀」与「我手动存」）。 */
  origin?: ResearchOrigin
  /** 文件在磁盘上缺失（被外部删除/移动）：索引仍在，可在面板里清理。 */
  missing?: boolean
}

export interface ResearchInput {
  title: string
  kind?: ResearchKind
  source: string
  occurredAt: string
  sourceUrl?: string
  codes?: string[]
  tags?: string[]
  summary?: string
  body?: string
  opinion?: string
  status?: ResearchStatus
  origin?: ResearchOrigin
}

export interface ResearchFilter {
  kind?: ResearchKind
  status?: ResearchStatus
  code?: string
  tag?: string
  query?: string
  limit?: number
}

export class ResearchConfirmationRequired extends Error {
  constructor(public readonly preview: { confirmationRequired: boolean; id: string; label: string; before: unknown; after: unknown; expiresAt: string }) {
    super('观点未修改：请在首页预览并确认')
    this.name = 'ResearchConfirmationRequired'
  }
}

export class ResearchValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResearchValidationError'
  }
}

interface VaultFile {
  version: 1
  updatedAt: string
  items: ResearchItem[]
}

function normKind(v: unknown): ResearchKind {
  const k = String(v ?? '').toLowerCase()
  return (RESEARCH_KINDS as string[]).includes(k) ? (k as ResearchKind) : 'other'
}

function normStatus(v: unknown): ResearchStatus {
  const s = String(v ?? '').toLowerCase()
  return (RESEARCH_STATUSES as string[]).includes(s) ? (s as ResearchStatus) : 'inbox'
}

function normOrigin(v: unknown): ResearchOrigin {
  const s = String(v ?? '').toLowerCase()
  return s === 'chat' || s === 'panel' ? s : 'file'
}

function normCodes(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，\s]+/) : []
  return [...new Set(raw.map((c) => String(c ?? '').trim()).filter(Boolean))]
}

function normTags(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，\s]+/) : []
  return [...new Set(raw.map((t) => String(t ?? '').trim()).filter(Boolean))]
}

/** Keep a stable ISO date prefix: `2026-09-18`, `2026-09`, or `2026` all accepted. */
function normDate(v: unknown): string {
  const raw = String(v ?? '').trim()
  if (!raw) return ''
  if (/^\d{4}$/.test(raw)) return `${raw}-01-01`
  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

function slugify(title: string): string {
  const base = String(title ?? '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base || 'note'
}

/**
 * On-disk shape is intentionally boring: **YAML frontmatter + 正文 + 观点与批注**。
 * 元数据全部在 frontmatter 里（不再在正文重复标题/来源），所以在编辑器里改正文
 * 不会破坏结构，改 frontmatter 也能被 `syncFromDisk()` 反向同步回索引。
 */
function frontmatter(item: ResearchItem): string {
  const oneLine = (v?: string) => (v ?? '').replace(/\s*\n\s*/g, ' ').trim()
  const block = [
    '---',
    `id: ${item.id}`,
    `title: ${oneLine(item.title)}`,
    `kind: ${item.kind}`,
    `source: ${oneLine(item.source)}`,
    `date: ${item.occurredAt}`,
    `status: ${item.status}`,
    `origin: ${item.origin ?? 'panel'}`,
    `codes: [${item.codes.join(', ')}]`,
    `tags: [${item.tags.join(', ')}]`,
    item.sourceUrl ? `url: ${item.sourceUrl}` : '',
    item.summary ? `summary: ${oneLine(item.summary)}` : '',
    item.opinion ? `opinion: ${oneLine(item.opinion)}` : '',
    '---',
  ].filter((l) => l !== '')
  return `${block.join('\n')}\n`
}

function notesSection(item: ResearchItem): string {
  if (!item.notes.length) return ''
  return ['## 观点与批注', '', ...item.notes.map((n) => `- ${n.at}${n.author ? ` · ${n.author}` : ''}：${n.text}`), ''].join('\n')
}

const PLACEHOLDER_BODY = '（无正文，仅索引记录）'

/** Rebuild the on-disk Markdown for an item (metadata + body + notes). */
export function renderResearchDoc(item: ResearchItem, body: string): string {
  const text = body?.trim() ? body.trim() : PLACEHOLDER_BODY
  return `${frontmatter(item)}\n${text}\n\n${notesSection(item)}`
}

/** 占位正文不算正文内容，避免反复渲染后被当成真实正文写回。 */
function unplaceholder(body: string): string {
  return body.trim() === PLACEHOLDER_BODY ? '' : body
}

/** 索引里的批注 + 文件里的批注 合并去重（按 时间+内容），保持时间顺序。 */
function mergeNotes(indexed: ResearchNote[], fromDoc: ResearchNote[]): ResearchNote[] {
  const key = (n: ResearchNote) => `${n.at}|${n.text}`
  const out = [...indexed]
  const seen = new Set(out.map(key))
  for (const n of fromDoc) {
    if (seen.has(key(n))) continue
    out.push(n)
    seen.add(key(n))
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

/** 结构化快照：用于判断磁盘同步后条目是否真的变了。 */
function snapshotOf(item: ResearchItem): string {
  return JSON.stringify([
    item.title, item.kind, item.source, item.occurredAt, item.status,
    item.codes, item.tags, item.summary ?? '', item.opinion ?? '', item.sourceUrl ?? '',
    item.file, item.notes, item.missing === true,
  ])
}

/** Result of one `syncFromDisk()` pass: what the file system changed. */
export interface SyncResult {
  scanned: number
  added: number
  updated: number
  missing: number
  changed: string[]
  watched: boolean
}

export interface DocMeta { [key: string]: string | string[] }

/** Parse the leading YAML-ish frontmatter block (`---\nkey: value\n---`). */
export function parseFrontmatter(raw: string): { meta: DocMeta; rest: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(raw)
  if (!m) return { meta: {}, rest: raw }
  const meta: DocMeta = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (!kv) continue
    const value = kv[2]!.trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      meta[kv[1]!.toLowerCase()] = value.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
      continue
    }
    meta[kv[1]!.toLowerCase()] = value.replace(/^["'](.*)["']$/, '$1')
  }
  return { meta, rest: raw.slice(m[0].length) }
}

const NOTES_HEADING = /^##[ \t]+观点与批注[ \t]*$/m

/** Split a vault doc into `body`（正文）and `notes`（观点时间线，从文件里读回来）。 */
export function splitDoc(raw: string): { meta: DocMeta; body: string; notes: ResearchNote[] } {
  const { meta, rest } = parseFrontmatter(raw)
  const at = rest.search(NOTES_HEADING)
  const notes: ResearchNote[] = []
  let body = at >= 0 ? rest.slice(0, at) : rest
  if (at >= 0) {
    const block = rest.slice(at).split(/\r?\n/).slice(1)
    for (const line of block) {
      const m = /^-[ \t]+(\S+)(?:[ \t]+·[ \t]+([^：]+))?[ \t]*：[ \t]*(.+)$/.exec(line.trim())
      if (m) notes.push({ at: m[1]!, text: m[3]!.trim(), author: m[2]?.trim() || undefined })
    }
  }
  body = stripLegacyPreamble(body, meta)
  return { meta, body: body.trim(), notes }
}

/** 兼容旧格式：正文里若残留 `# 标题` / `> 来源…` / `**观点**` / `## 正文` 等生成块，读取时剔除。 */
function stripLegacyPreamble(body: string, meta: DocMeta): string {
  const lines = body.split(/\r?\n/)
  const title = typeof meta.title === 'string' ? meta.title.trim() : ''
  let i = 0
  const skipBlank = () => { while (i < lines.length && lines[i]!.trim() === '') i++ }
  skipBlank()
  if (title && lines[i]?.trim() === `# ${title}`) { i++; skipBlank() }
  if (lines[i]?.trim().startsWith('> 来源')) { i++; skipBlank() }
  if (typeof meta.summary === 'string' && lines[i]?.trim() === meta.summary.trim()) { i++; skipBlank() }
  if (lines[i]?.trim().startsWith('**观点**')) { i++; skipBlank() }
  if (/^##[ \t]+正文[ \t]*$/.test(lines[i]?.trim() ?? '')) { i++; skipBlank() }
  return i > 0 ? lines.slice(i).join('\n') : body
}

function titleFromFileName(file: string): string {
  const base = path.basename(file, '.md')
  return base.replace(/^r-\d{8}-[a-z0-9]+-/, '').replace(/-+/g, ' ').trim()
}

function docString(meta: DocMeta, key: string): string {
  const v = meta[key]
  return typeof v === 'string' ? v.trim() : ''
}

function docList(meta: DocMeta, key: string): string[] {
  const v = meta[key]
  return Array.isArray(v) ? normCodes(v) : []
}

interface VaultTransaction { data: VaultFile; docs: Map<string, { before: string | null; after: string | null }> }

export class ResearchVault {
  private data: VaultFile = { version: 1, updatedAt: new Date(0).toISOString(), items: [] }
  private loaded = false
  private loading?: Promise<void>
  private indexRaw: string | null = null
  private recoveryRequired = false
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(items: ResearchItem[]) => void>()
  private watcher?: FSWatcher
  private pollTimer?: NodeJS.Timeout
  private syncing?: Promise<SyncResult>

  constructor(
    private readonly root: string,
    private readonly logger?: Logger,
  ) {}

  get dir(): string {
    return this.root
  }

  get indexPath(): string {
    return path.join(this.root, 'index.json')
  }

  onChange(fn: (items: ResearchItem[]) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loading ??= this.loadOnce().catch(err => { this.loading = undefined; throw err })
    return this.loading
  }

  private async loadOnce(): Promise<void> {
    try {
      this.indexRaw = await readFile(this.indexPath, 'utf8')
      const parsed = JSON.parse(this.indexRaw) as Partial<VaultFile>
      if (!Array.isArray(parsed.items)) throw new Error('资料库索引结构无效')
      this.data = {
        version: 1,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        items: (parsed.items ?? []).map((i) => this.normalize(i)),
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      this.data = { version: 1, updatedAt: new Date().toISOString(), items: [] }
      this.logger?.debug('vault index missing, starting empty', { path: this.indexPath, error: err instanceof Error ? err.message : String(err) })
      await this.persist()
    }
    this.loaded = true
  }

  private normalize(item: ResearchItem): ResearchItem {
    this.docPath(item.file)
    return {
      ...item,
      kind: normKind(item.kind),
      status: normStatus(item.status),
      codes: normCodes(item.codes),
      tags: normTags(item.tags),
      notes: Array.isArray(item.notes) ? item.notes : [],
    }
  }

  private docPath(file: string): string {
    const root = path.resolve(this.root), absolute = path.resolve(root, file)
    if (!absolute.startsWith(root + path.sep)) throw new ResearchValidationError('资料路径越界')
    return absolute
  }
  private async readRaw(file: string): Promise<string | null> {
    try { return await readFile(file, 'utf8') }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  }
  private async atomic(file: string, raw: string | null) {
    if (raw === null) { await unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e }); return }
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temp, file)
    } finally { await unlink(temp).catch(() => {}) }
  }
  private async persist(): Promise<void> {
    const raw = `${JSON.stringify(this.data, null, 2)}\n`
    await this.atomic(this.indexPath, raw)
    this.indexRaw = raw
  }
  private transaction<T>(fn: (tx: VaultTransaction) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      await this.load()
      if (this.recoveryRequired) throw new ResearchValidationError('资料写入回滚失败；请备份并重新加载插件、同步文件后再操作')
      const tx: VaultTransaction = { data: structuredClone(this.data), docs: new Map() }
      const result = await fn(tx)
      if (!tx.docs.size && JSON.stringify(tx.data) === JSON.stringify(this.data)) return structuredClone(result)
      const applied: Array<[string, { before: string | null; after: string | null }]> = []
      try {
        for (const [file, op] of tx.docs) {
          if (await this.readRaw(file) !== op.before) throw new ResearchValidationError('资料文件已变化，请重新同步后预览')
          await this.atomic(file, op.after); applied.push([file, op])
        }
        tx.data.updatedAt = new Date().toISOString()
        if (await this.readRaw(this.indexPath) !== this.indexRaw) throw new ResearchValidationError('资料索引被外部修改，请重新加载插件')
        const raw = `${JSON.stringify(tx.data, null, 2)}\n`
        await this.atomic(this.indexPath, raw)
        this.indexRaw = raw
      } catch (error) {
        // Best-effort rollback for ordinary I/O failures, never overwrite an
        // intervening external edit. This is not multi-file crash atomicity.
        for (const [file, op] of applied.reverse()) {
          try { if (await this.readRaw(file) === op.after) await this.atomic(file, op.before); else this.recoveryRequired = true }
          catch (e) { this.recoveryRequired = true; this.logger?.error('vault rollback failed; resync required', { file, error: String(e) }) }
        }
        throw error
      }
      this.data = tx.data
      this.emit()
      return structuredClone(result)
    })
    this.queue = task.catch(() => {})
    return task
  }
  private assertMetadataCurrent(cur: ResearchItem, raw: string) {
    const actual = splitDoc(raw), expected = splitDoc(renderResearchDoc(cur, actual.body))
    const keys = new Set([...Object.keys(actual.meta), ...Object.keys(expected.meta)])
    if ([...keys].some(key => JSON.stringify(actual.meta[key] ?? '') !== JSON.stringify(expected.meta[key] ?? '')) ||
        JSON.stringify(actual.notes) !== JSON.stringify(expected.notes)) {
      throw new ResearchValidationError('资料文件与索引不一致，请先同步本地文件后再修改')
    }
  }
  private async stageDoc(tx: VaultTransaction, item: ResearchItem, body: string | null, expected?: string | null) {
    const file = this.docPath(item.file)
    const before = tx.docs.has(file) ? tx.docs.get(file)!.before : (expected !== undefined ? expected : await this.readRaw(file))
    tx.docs.set(file, { before, after: body === null ? null : renderResearchDoc(item, body) })
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(this.all())
      } catch { /* listener errors must not break persistence */ }
    }
  }

  all(): ResearchItem[] {
    return structuredClone(this.data.items)
  }

  find(id: string): ResearchItem | undefined {
    return structuredClone(this.data.items.find((i) => i.id === id))
  }

  /**
   * Read one doc from disk (host file tools may have edited it since the index
   * was written). Returns the *body only* — frontmatter and the notes section
   * are stripped, because the panel/agent render them from structured fields.
   */
  async readDoc(item: ResearchItem): Promise<{ body: string; notes: ResearchNote[]; raw: string; mtime?: string; exists: boolean }> {
    const abs = this.docPath(item.file)
    try {
      const raw = await readFile(abs, 'utf8')
      const { body, notes } = splitDoc(raw)
      // 空正文的占位符不当作内容返回。
      const st = await stat(abs).catch(() => undefined)
      return { body: unplaceholder(body), notes, raw, mtime: st ? st.mtime.toISOString() : undefined, exists: true }
    } catch (err) {
      this.logger?.warn('vault doc unreadable', { id: item.id, file: item.file, error: err instanceof Error ? err.message : String(err) })
      return { body: '', notes: [], raw: '', exists: false }
    }
  }

  /** Body-only read (used when re-rendering a doc after metadata changes). */
  async readBody(item: ResearchItem): Promise<string> {
    return (await this.readDoc(item)).body
  }

  /** 面板/工具直接改正文：只改正文段落，frontmatter 与观点时间线保持不变。 */
  async writeBody(id: string, body: string): Promise<ResearchItem> {
    return this.transaction(tx => this.writeBodyIn(tx, id, body))
  }

  private async writeBodyIn(tx: VaultTransaction, id: string, body: string): Promise<ResearchItem> {
    const idx = tx.data.items.findIndex((i) => i.id === id)
    if (idx < 0) throw new ResearchValidationError(`资料不存在：${id}`)
    const cur = tx.data.items[idx]!
    const doc = await this.readDoc(cur)
    if (doc.exists) this.assertMetadataCurrent(cur, doc.raw)
    // 磁盘上的观点时间线优先（外部可能在文件里手写过批注）。
    const notes = mergeNotes(cur.notes, doc.notes)
    const next: ResearchItem = { ...cur, notes, missing: false, updatedAt: new Date().toISOString() }
    tx.data.items[idx] = next
    await this.stageDoc(tx, next, unplaceholder(body), doc.exists ? doc.raw : null)
    this.logger?.info('research body saved', { id, file: next.file, chars: body.length })
    return next
  }

  /** 列出 vault 下全部 Markdown 正文（相对路径，POSIX 分隔）。 */
  private async markdownFiles(): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const childRel = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) await walk(path.join(dir, e.name), childRel)
        else if (e.isFile() && e.name.endsWith('.md')) out.push(childRel)
      }
    }
    await walk(this.root, '')
    return out
  }

  /**
   * 反向同步：磁盘是事实来源。扫描 vault 目录，把外部新增/编辑/删除的 Markdown
   * 合并回索引——宿主文件工具写的文件、用户手写的笔记、编辑器里改的 frontmatter
   * 都会在这里被采纳，实现「本地文件 ↔ 面板」双向联动。
   */
  async syncFromDisk(): Promise<SyncResult> {
    if (!this.loaded) await this.load()
    if (this.syncing) return this.syncing
    this.syncing = this.transaction(tx => this.doSync(tx))
    try {
      return await this.syncing
    } finally {
      this.syncing = undefined
    }
  }

  private async doSync(tx: VaultTransaction): Promise<SyncResult> {
    const files = await this.markdownFiles()
    const result: SyncResult = { scanned: files.length, added: 0, updated: 0, missing: 0, changed: [], watched: this.watcher !== undefined }
    const seen = new Set<string>()
    // 同一条资料可能被两种身份命中：文件里的 id，或索引里记录的相对路径。
    // 先按 id 命中；未命中再按路径命中，否则外部新建的文件会被反复当成新资料。
    const byId = new Map(tx.data.items.map((i) => [i.id, i]))
    const byFile = new Map<string, ResearchItem>()
    for (const i of tx.data.items) if (!byFile.has(i.file)) byFile.set(i.file, i)
    let dirty = false

    for (const rel of files) {
      const abs = path.join(this.root, rel)
      const raw = await readFile(abs, 'utf8').catch(() => '')
      if (!raw.trim()) continue
      const { meta, body, notes } = splitDoc(raw)
      const title = docString(meta, 'title') || titleFromFileName(rel)
      const source = docString(meta, 'source')
      const date = normDate(docString(meta, 'date') || docString(meta, 'occurredat'))
      if (!title || !source || !date) continue // 无来源/无时间的文件不成资料
      const docId = docString(meta, 'id')
      const cur = (docId ? byId.get(docId) : undefined) ?? byFile.get(rel)

      if (cur) {
        const idx = tx.data.items.findIndex((i) => i.id === cur.id)
        if (idx < 0) continue
        seen.add(cur.id)
        const merged: ResearchItem = {
          ...cur,
          title,
          kind: normKind(docString(meta, 'kind') || cur.kind),
          source,
          occurredAt: date,
          status: normStatus(docString(meta, 'status') || cur.status),
          codes: docList(meta, 'codes').length ? docList(meta, 'codes') : cur.codes,
          tags: docList(meta, 'tags').length ? docList(meta, 'tags') : cur.tags,
          summary: docString(meta, 'summary') || cur.summary,
          opinion: Object.hasOwn(meta, 'opinion') ? docString(meta, 'opinion') : cur.opinion,
          sourceUrl: docString(meta, 'url') || cur.sourceUrl,
          file: rel,
          notes: mergeNotes(cur.notes, notes),
          // 入库渠道以索引为准：面板/对话存的资料被外部编辑后仍是原渠道；
          // 历史条目没有 origin 时按「面板」补齐，避免被误判成外部文件。
          origin: cur.origin ?? (docString(meta, 'origin') ? normOrigin(docString(meta, 'origin')) : 'panel'),
          missing: false,
        }
        delete merged.missing
        const changed = snapshotOf(merged) !== snapshotOf(cur)
        if (changed) {
          merged.updatedAt = new Date().toISOString()
          tx.data.items[idx] = merged
          result.updated++
          result.changed.push(merged.id)
          dirty = true
        }
        // 文件里没有（或写错了）id → 回写一次，保证下次同步按 id 命中、不会重复入库。
        if (docId !== merged.id) await this.stageDoc(tx, merged, body, raw)
        continue
      }

      const now = new Date().toISOString()
      const item: ResearchItem = {
        id: docId || `r-${now.slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`,
        title,
        kind: normKind(docString(meta, 'kind') || 'other'),
        source,
        occurredAt: date,
        createdAt: now,
        updatedAt: now,
        status: normStatus(docString(meta, 'status') || 'inbox'),
        codes: docList(meta, 'codes'),
        tags: docList(meta, 'tags'),
        summary: docString(meta, 'summary') || undefined,
        opinion: docString(meta, 'opinion') || undefined,
        sourceUrl: docString(meta, 'url') || undefined,
        file: rel,
        notes,
        origin: docString(meta, 'origin') ? normOrigin(docString(meta, 'origin')) : 'file',
      }
      tx.data.items.push(item)
      byId.set(item.id, item)
      seen.add(item.id)
      // 认领外部文件：把 id 写回 frontmatter，后续同步即幂等。
      await this.stageDoc(tx, item, body, raw)
      result.added++
      result.changed.push(item.id)
      dirty = true
    }

    for (const item of tx.data.items) {
      if (seen.has(item.id)) continue
      if (!item.missing) {
        item.missing = true
        dirty = true
      }
      result.missing++
    }

    if (dirty) {
      this.logger?.info('vault synced from disk', { ...result, changed: result.changed.length })
    }
    return result
  }

  /**
   * 监听 vault 目录：外部（编辑器 / Agent 文件工具）一改文件就回灌索引。
   * 递归 watch 不可用时退化为 15s 轮询，保证「本地文件联动」始终有效。
   */
  watch(onSync?: (result: SyncResult) => void, debounceMs = 600): void {
    if (this.watcher || this.pollTimer) return
    let timer: NodeJS.Timeout | undefined
    let running = false
    const run = async () => {
      if (running) return
      running = true
      try {
        const result = await this.syncFromDisk()
        if (result.added || result.updated || result.missing) onSync?.(result)
      } catch (err) {
        this.logger?.warn('vault watch sync failed', { error: err instanceof Error ? err.message : String(err) })
      } finally {
        running = false
      }
    }
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void run() }, debounceMs)
      timer.unref?.()
    }
    try {
      const w = watch(this.root, { recursive: true }, (_event, filename) => {
        // 只认正文：index.json / index.json.tmp 是我们自己写的，忽略以避免自触发回环。
        const name = filename ? String(filename) : ''
        if (name && !name.endsWith('.md')) return
        schedule()
      })
      w.on('error', (err) => {
        this.logger?.warn('vault watcher error', { error: err instanceof Error ? err.message : String(err) })
      })
      this.watcher = w
      this.logger?.info('vault watching', { dir: this.root })
      return
    } catch (err) {
      this.logger?.warn('vault watch unavailable, falling back to polling', { error: err instanceof Error ? err.message : String(err) })
    }
    this.pollTimer = setInterval(() => { void run() }, 15_000)
    this.pollTimer.unref?.()
    this.logger?.info('vault polling', { dir: this.root, intervalMs: 15_000 })
  }

  stopWatching(): void {
    this.watcher?.close()
    this.watcher = undefined
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  isWatching(): boolean {
    return this.watcher !== undefined || this.pollTimer !== undefined
  }

  /** Validate + create. `source` and `occurredAt` are mandatory by design. */
  async create(input: ResearchInput): Promise<ResearchItem> {
    return this.transaction(tx => this.createIn(tx, structuredClone(input)))
  }

  private async createIn(tx: VaultTransaction, input: ResearchInput): Promise<ResearchItem> {
    const title = String(input.title ?? '').trim()
    const source = String(input.source ?? '').trim()
    const occurredAt = normDate(input.occurredAt)
    if (!title) throw new ResearchValidationError('title 不能为空')
    if (!source) throw new ResearchValidationError('source（来源）必填，例如「诚通证券研报」「个人观点」「公司公告」')
    if (!occurredAt) throw new ResearchValidationError('occurredAt（资料时间）必填，格式 YYYY-MM-DD')

    const now = new Date().toISOString()
    const id = `r-${now.slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`
    const item: ResearchItem = {
      id,
      title,
      kind: normKind(input.kind ?? 'other'),
      source,
      occurredAt,
      createdAt: now,
      updatedAt: now,
      status: normStatus(input.status ?? 'inbox'),
      codes: normCodes(input.codes),
      tags: normTags(input.tags),
      summary: input.summary?.trim() || undefined,
      opinion: input.opinion?.trim() || undefined,
      sourceUrl: input.sourceUrl?.trim() || undefined,
      file: path.join(occurredAt.slice(0, 4), `${id}-${slugify(title)}.md`),
      notes: [],
      origin: normOrigin(input.origin ?? 'panel'),
    }
    await this.stageDoc(tx, item, input.body ?? '', null)
    tx.data.items.push(item)
    this.logger?.info('research saved', { id, kind: item.kind, codes: item.codes, source })
    return item
  }

  async update(id: string, patch: Partial<ResearchInput> & { status?: ResearchStatus }): Promise<ResearchItem> {
    return this.transaction(tx => this.updateIn(tx, id, structuredClone(patch)))
  }

  private async updateIn(tx: VaultTransaction, id: string, patch: Partial<ResearchInput> & { status?: ResearchStatus }, confirmed = false, expected?: string, expectedDoc?: string): Promise<ResearchItem> {
    const idx = tx.data.items.findIndex((i) => i.id === id)
    if (idx < 0) throw new ResearchValidationError(`资料不存在：${id}`)
    const cur = tx.data.items[idx]!
    if (expected !== undefined && JSON.stringify(cur) !== expected) throw new ResearchValidationError('资料已变化，请重新预览')
    if (!confirmed && patch.opinion !== undefined && patch.opinion.trim() !== (cur.opinion ?? '')) {
      patch = structuredClone(patch)
      const before = JSON.stringify(cur)
      const doc = await this.readDoc(cur)
      if (!doc.exists) throw new ResearchValidationError('资料文件已变化或缺失，请先同步再预览')
      this.assertMetadataCurrent(cur, doc.raw)
      const proposal = confirmations.propose('修改资料观点', cur, { ...cur, ...patch }, () => this.find(id), () => this.transaction(inner => this.updateIn(inner, id, patch, true, before, doc.raw)))
      throw new ResearchConfirmationRequired(proposal)
    }
    const auditNotes = confirmed && patch.opinion !== undefined && patch.opinion.trim() !== (cur.opinion ?? '')
      ? [...cur.notes, { at: new Date().toISOString(), text: `修改前观点：${cur.opinion ?? '（无）'}`, author: 'audit' }]
      : cur.notes
    const next: ResearchItem = {
      ...cur,
      notes: auditNotes,
      title: patch.title?.trim() || cur.title,
      kind: patch.kind ? normKind(patch.kind) : cur.kind,
      source: patch.source?.trim() || cur.source,
      occurredAt: patch.occurredAt ? (normDate(patch.occurredAt) || cur.occurredAt) : cur.occurredAt,
      summary: patch.summary?.trim() ?? cur.summary,
      opinion: patch.opinion?.trim() ?? cur.opinion,
      sourceUrl: patch.sourceUrl?.trim() ?? cur.sourceUrl,
      codes: patch.codes ? normCodes(patch.codes) : cur.codes,
      tags: patch.tags ? normTags(patch.tags) : cur.tags,
      status: patch.status ? normStatus(patch.status) : cur.status,
      updatedAt: new Date().toISOString(),
      archivedAt: patch.status ? (normStatus(patch.status) === 'archived' ? new Date().toISOString() : undefined) : cur.archivedAt,
    }
    tx.data.items[idx] = next
    const doc = await this.readDoc(cur)
    if (expectedDoc !== undefined && doc.raw !== expectedDoc) throw new ResearchValidationError('资料文件已变化，请同步后重新预览')
    if (!doc.exists) throw new ResearchValidationError('资料正文不可读，拒绝覆盖；请先恢复文件')
    this.assertMetadataCurrent(cur, doc.raw)
    await this.stageDoc(tx, next, unplaceholder(doc.body), doc.raw)
    this.logger?.info('research updated', { id, status: next.status })
    return next
  }

  /** Append a dated opinion/annotation (个人观点持续积累). */
  async addNote(id: string, text: string, author?: string): Promise<ResearchItem> {
    return this.transaction(tx => this.addNoteIn(tx, id, text, author))
  }

  private async addNoteIn(tx: VaultTransaction, id: string, text: string, author?: string): Promise<ResearchItem> {
    const note = String(text ?? '').trim()
    if (!note) throw new ResearchValidationError('note 不能为空')
    const idx = tx.data.items.findIndex((i) => i.id === id)
    if (idx < 0) throw new ResearchValidationError(`资料不存在：${id}`)
    const cur = tx.data.items[idx]!
    const next: ResearchItem = {
      ...cur,
      notes: [...cur.notes, { at: new Date().toISOString(), text: note, author: author?.trim() || undefined }],
      updatedAt: new Date().toISOString(),
    }
    tx.data.items[idx] = next
    const doc = await this.readDoc(cur)
    if (!doc.exists) throw new ResearchValidationError('资料正文不可读，拒绝覆盖；请先恢复文件')
    this.assertMetadataCurrent(cur, doc.raw)
    await this.stageDoc(tx, next, unplaceholder(doc.body), doc.raw)
    this.logger?.info('research note added', { id, notes: next.notes.length })
    return next
  }

  async setStatus(id: string, status: ResearchStatus): Promise<ResearchItem> {
    return this.update(id, { status })
  }

  /**
   * 删除条目：连正文一起删。只删索引会留下孤儿 Markdown，
   * 下一次目录同步又会被当成「外部新建」重新入库——所以文件与索引一起走。
   */
  async remove(id: string): Promise<boolean> {
    return this.transaction(tx => this.removeIn(tx, id))
  }

  private async removeIn(tx: VaultTransaction, id: string): Promise<boolean> {
    const idx = tx.data.items.findIndex((i) => i.id === id)
    if (idx < 0) return false
    const item = tx.data.items[idx]!
    tx.data.items.splice(idx, 1)
    await this.stageDoc(tx, item, null)
    this.logger?.info('research removed', { id })
    return true
  }

  /** Filter + full-text search; results are newest-first by 资料时间. */
  list(filter: ResearchFilter = {}): ResearchItem[] {
    const q = String(filter.query ?? '').trim().toLowerCase()
    let items = this.data.items
    if (filter.kind) items = items.filter((i) => i.kind === filter.kind)
    if (filter.status) items = items.filter((i) => i.status === filter.status)
    if (filter.code) {
      const code = String(filter.code).trim().toLowerCase()
      items = items.filter((i) => i.codes.some((c) => c.toLowerCase() === code || c.toLowerCase().includes(code)))
    }
    if (filter.tag) {
      const tag = String(filter.tag).trim().toLowerCase()
      items = items.filter((i) => i.tags.some((t) => t.toLowerCase() === tag))
    }
    if (q) {
      items = items.filter((i) => [
        i.title, i.summary, i.opinion, i.source, ...i.codes, ...i.tags,
        ...i.notes.map((n) => n.text),
      ].filter(Boolean).join(' ').toLowerCase().includes(q))
    }
    items = [...items].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt))
    return structuredClone(filter.limit && filter.limit > 0 ? items.slice(0, filter.limit) : items)
  }

  /** Remove index entries whose Markdown file no longer exists on disk. */
  async pruneMissing(): Promise<number> {
    return this.transaction(async tx => {
      await this.doSync(tx)
      const keep = tx.data.items.filter(i => !i.missing)
      const removed = tx.data.items.length - keep.length
      tx.data.items = keep
      return removed
    })
  }

  /**
   * 「资料库现状」快照：每轮对话动态注入系统提示，让 Agent 知道已经沉淀了什么
   * （避免重复收集），并能按 id 继续维护（补观点 / 归档 / 追加批注）。
   */
  digest(limit = 12): {
    total: number
    byKind: Record<string, number>
    byStatus: Record<string, number>
    byOrigin: Record<string, number>
    topCodes: Array<{ code: string; count: number }>
    recent: Array<{
      id: string
      title: string
      kind: ResearchKind
      source: string
      date: string
      status: ResearchStatus
      origin: ResearchOrigin
      codes: string[]
      opinion?: string
      notes: number
    }>
  } {
    const stats = this.stats()
    const recent = this.list({ limit })
    return {
      total: stats.total,
      byKind: stats.byKind,
      byStatus: stats.byStatus,
      byOrigin: stats.byOrigin,
      topCodes: stats.topCodes,
      recent: recent.map((i) => ({
        id: i.id,
        title: i.title,
        kind: i.kind,
        source: i.source,
        date: i.occurredAt,
        status: i.status,
        origin: i.origin ?? 'panel',
        codes: i.codes,
        opinion: i.opinion,
        notes: i.notes.length,
      })),
    }
  }

  /** Group counts for the panel/agent overview (kind / status / top codes). */
  stats(): {
    total: number
    byKind: Record<string, number>
    byStatus: Record<string, number>
    byOrigin: Record<string, number>
    topCodes: Array<{ code: string; count: number }>
    missing: number
    lastUpdatedAt?: string
  } {
    const byKind: Record<string, number> = {}
    const byStatus: Record<string, number> = {}
    const byOrigin: Record<string, number> = {}
    const codes = new Map<string, number>()
    for (const i of this.data.items) {
      byKind[i.kind] = (byKind[i.kind] ?? 0) + 1
      byStatus[i.status] = (byStatus[i.status] ?? 0) + 1
      const o = i.origin ?? 'panel'
      byOrigin[o] = (byOrigin[o] ?? 0) + 1
      for (const c of i.codes) codes.set(c, (codes.get(c) ?? 0) + 1)
    }
    return {
      total: this.data.items.length,
      byKind,
      byStatus,
      byOrigin,
      topCodes: [...codes.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      missing: this.data.items.filter((i) => i.missing).length,
      lastUpdatedAt: this.data.updatedAt,
    }
  }

  isLoaded(): boolean {
    return this.loaded
  }
}
