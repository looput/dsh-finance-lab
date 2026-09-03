import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AssetType } from './types.js'

export interface PositionAnalysis {
  code: string
  type: AssetType
  report: string
  generatedAt: string
  dataAsOf?: string
  promptVersion: string
}

interface AnalysisFile {
  analyses: Record<string, PositionAnalysis>
  updatedAt: string
}

export const ANALYSIS_PROMPT_VERSION = '1'

function keyOf(code: string, type: AssetType): string {
  return `${type}:${code.trim()}`
}

export class AnalysisStore {
  private data: AnalysisFile = { analyses: {}, updatedAt: new Date(0).toISOString() }
  private readonly changeListeners = new Set<(analysis: PositionAnalysis) => void>()

  constructor(private readonly file: string) {}

  get path(): string {
    return this.file
  }

  /** Observe saved analyses (fires after persist, e.g. from save_position_analysis). */
  onChange(fn: (analysis: PositionAnalysis) => void): () => void {
    this.changeListeners.add(fn)
    return () => {
      this.changeListeners.delete(fn)
    }
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AnalysisFile>
      this.data = {
        analyses: parsed.analyses ?? {},
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      }
    } catch {
      this.data = { analyses: {}, updatedAt: new Date().toISOString() }
      await this.persist().catch(() => {})
    }
  }

  get(code: string, type: AssetType): PositionAnalysis | undefined {
    return this.data.analyses[keyOf(code, type)]
  }

  async set(input: Pick<PositionAnalysis, 'code' | 'type' | 'report' | 'dataAsOf'>): Promise<PositionAnalysis> {
    const analysis: PositionAnalysis = {
      code: input.code.trim(),
      type: input.type,
      report: input.report.trim(),
      dataAsOf: input.dataAsOf,
      generatedAt: new Date().toISOString(),
      promptVersion: ANALYSIS_PROMPT_VERSION,
    }
    this.data.analyses[keyOf(analysis.code, analysis.type)] = analysis
    await this.persist()
    for (const fn of [...this.changeListeners]) {
      try {
        fn(analysis)
      } catch { /* listener errors must not break persistence */ }
    }
    return analysis
  }

  private async persist(): Promise<void> {
    this.data.updatedAt = new Date().toISOString()
    await mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    await rename(tmp, this.file)
  }
}
