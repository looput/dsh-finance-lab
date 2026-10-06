import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Logger } from './log.js'
import type { AssetType } from './types.js'

/** 报告溯源引用：保存时做存在性契约校验（证明引用有效，不证明语义真实）。 */
export interface AnalysisRefs {
  /** 分析所依据的档案快照 id（由 /analysis 提示词或 stock_dossier 工具登记）。 */
  dossierSnapshotId?: string
  /** 对照的原判断版本。 */
  thesisRevision?: number
  /** 上一份报告的 reportId。 */
  previousReportId?: string
}

export interface PositionAnalysis {
  code: string
  type: AssetType
  report: string
  generatedAt: string
  dataAsOf?: string
  promptVersion: string
  /** 同标的报告版本（递增；旧缓存文件迁移为 1）。 */
  version: number
  reportId: string
  refs?: AnalysisRefs
}

interface AnalysisFile {
  /** 最新报告（兼容旧读取接口）。 */
  analyses: Record<string, PositionAnalysis>
  /** 修订历史（按保存时间追加）。 */
  history: Record<string, PositionAnalysis[]>
  /** 最近生成过的档案快照（供 refs 存在性校验；裁剪保存）。 */
  snapshots: Record<string, { code: string; type: AssetType; at: string }>
  updatedAt: string
}

export const ANALYSIS_PROMPT_VERSION = '2'

function keyOf(code: string, type: AssetType): string {
  return `${type}:${code.trim()}`
}

function normalize(raw: Partial<AnalysisFile>): AnalysisFile {
  const analyses: Record<string, PositionAnalysis> = {}
  // 旧缓存迁移：单对象 {code,type,report,generatedAt} → 1 版历史（保留生成时间）。
  const legacy = raw as Partial<PositionAnalysis> & Partial<AnalysisFile>
  const source: Record<string, unknown> = (raw.analyses && typeof raw.analyses === 'object')
    ? raw.analyses as Record<string, unknown>
    : (legacy.code && legacy.report
      ? { [keyOf(String(legacy.code), (legacy.type ?? 'stock') as AssetType)]: legacy }
      : {})
  for (const [k, v] of Object.entries(source)) {
    if (!v || typeof v !== 'object') continue
    const a = v as PositionAnalysis
    analyses[k] = {
      ...a,
      version: Number.isInteger(a.version) ? a.version : 1,
      reportId: a.reportId || randomUUID(),
      promptVersion: a.promptVersion ?? '1',
      refs: a.refs ?? {},
    }
  }
  const history: Record<string, PositionAnalysis[]> = raw.history && typeof raw.history === 'object' ? raw.history : {}
  for (const [k, a] of Object.entries(analyses)) {
    if (!history[k]?.length) history[k] = [a]
  }
  return {
    analyses,
    history,
    snapshots: raw.snapshots ?? {},
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
  }
}

export class AnalysisStore {
  private data: AnalysisFile = { analyses: {}, history: {}, snapshots: {}, updatedAt: new Date(0).toISOString() }
  private readonly changeListeners = new Set<(analysis: PositionAnalysis) => void>()

  constructor(
    private readonly file: string,
    private readonly logger?: Logger,
  ) {}

  get path() { return this.file }

  /** Observe saved analyses (fires after persist, e.g. from save_position_analysis). */
  onChange(fn: (analysis: PositionAnalysis) => void): () => void {
    this.changeListeners.add(fn)
    return () => { this.changeListeners.delete(fn) }
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      this.data = normalize(JSON.parse(raw) as Partial<AnalysisFile>)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      this.logger?.[code === 'ENOENT' ? 'debug' : 'warn']('analysis cache load failed, starting empty', { file: this.file, error: err instanceof Error ? err.message : String(err) })
      this.data = { analyses: {}, history: {}, snapshots: {}, updatedAt: new Date().toISOString() }
      await this.persist().catch(() => {})
    }
  }

  get(code: string, type: AssetType): PositionAnalysis | undefined {
    return this.data.analyses[keyOf(code, type)]
  }

  /** 全部修订（时间升序，最新在最后）。 */
  revisions(code: string, type: AssetType): PositionAnalysis[] {
    return structuredClone(this.data.history[keyOf(code, type)] ?? [])
  }

  hasReportId(reportId: string): boolean {
    if (!reportId) return false
    for (const list of Object.values(this.data.history)) {
      if (list.some((a) => a.reportId === reportId)) return true
    }
    return Object.values(this.data.analyses).some((a) => a.reportId === reportId)
  }

  /** 登记档案快照 id（提示词生成与 stock_dossier 工具都会调用），供 refs 校验。 */
  async noteSnapshot(snapshotId: string, code: string, type: AssetType): Promise<void> {
    if (!/^[0-9a-f]{8,64}$/.test(snapshotId)) return
    await this.change((data) => {
      data.snapshots[snapshotId] = { code: code.trim(), type, at: new Date().toISOString() }
      const ids = Object.keys(data.snapshots)
      if (ids.length > 50) {
        const drop = ids.sort((a, b) => data.snapshots[a]!.at.localeCompare(data.snapshots[b]!.at)).slice(0, ids.length - 50)
        for (const id of drop) delete data.snapshots[id]
      }
    })
  }

  hasSnapshot(snapshotId: string, code?: string, type?: AssetType): boolean {
    const hit = this.data.snapshots[snapshotId]
    if (!hit) return false
    return (!code || hit.code === code.trim()) && (!type || hit.type === type)
  }

  async set(input: Pick<PositionAnalysis, 'code' | 'type' | 'report' | 'dataAsOf'> & { refs?: AnalysisRefs }): Promise<PositionAnalysis> {
    const key = keyOf(input.code, input.type)
    const old = this.data.analyses[key]
    const analysis: PositionAnalysis = {
      code: input.code.trim(),
      type: input.type,
      report: input.report.trim(),
      dataAsOf: input.dataAsOf,
      generatedAt: new Date().toISOString(),
      promptVersion: ANALYSIS_PROMPT_VERSION,
      version: (old?.version ?? 0) + 1,
      reportId: randomUUID(),
      refs: input.refs && Object.values(input.refs).some((v) => v !== undefined) ? input.refs : undefined,
    }
    await this.change((data) => {
      data.analyses[key] = analysis
      data.history[key] = [...(data.history[key] ?? []), analysis].slice(-20)
    })
    for (const fn of [...this.changeListeners]) {
      try { fn(analysis) } catch { /* listener errors must not break persistence */ }
    }
    return analysis
  }

  private async change(fn: (data: AnalysisFile) => void): Promise<void> {
    fn(this.data)
    await this.persist()
  }

  private async persist(): Promise<void> {
    this.data.updatedAt = new Date().toISOString()
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.file)
  }
}
