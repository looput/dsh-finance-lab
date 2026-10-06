/**
 * 策略库（T7-D）：版本化保存 proposed/tested/watchlisted/retired 与理由；
 * 升级为有效用户策略（watchlisted/生效跟踪）必须显式人工批准——无确认只生成预览。
 * 周/月低频重评使用冻结规则 + 新时间段前向记录（forwardRecords 只追加、不可改写）。
 * 不自动下单；Agent 只能提交受限 DSL（经 validateStrategy），不能 eval/exec。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { strategyHash, validateStrategy, type StrategySpec } from './dsl.js'
import type { BacktestResult } from './backtest.js'

export type StrategyStatus = 'proposed' | 'tested' | 'watchlisted' | 'retired'

export interface ForwardRecord {
  runId: string
  periodStart: string
  periodEnd: string
  /** 冻结规则下的前向评估摘要（可复现：保存 specHash + dataHash）。 */
  summary: {
    specHash: string
    dataHash: string
    totalReturnPct: number
    maxDrawdownPct: number
    tradeCount: number
  }
  note: string
}

export interface LibraryEntry {
  id: string
  spec: StrategySpec
  specHash: string
  status: StrategyStatus
  version: number
  reason: string
  createdAt: string
  forwardRecords: ForwardRecord[]
  history: { version: number; status: StrategyStatus; reason: string; at: string }[]
}

interface LibraryFile {
  entries: LibraryEntry[]
  updatedAt: string
}

/** 无确认提交激活等「需用户批准」动作时抛出，携带预览。 */
export class StrategyConfirmationRequired extends Error {
  constructor(public readonly preview: Record<string, unknown>) {
    super('该操作需要用户在面板显式批准')
    this.name = 'StrategyConfirmationRequired'
  }
}

const STATUS_ORDER: Record<StrategyStatus, StrategyStatus[]> = {
  proposed: ['tested', 'retired'],
  tested: ['watchlisted', 'retired'],
  watchlisted: ['retired', 'tested'],
  retired: ['proposed'],
}

export class StrategyLibrary {
  private data: LibraryFile = { entries: [], updatedAt: '' }
  private readonly now: () => string

  constructor(private readonly file: string, opts?: { now?: () => string }) {
    this.now = opts?.now ?? (() => new Date().toISOString())
  }

  get path(): string { return this.file }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as LibraryFile
      this.data = { entries: parsed.entries ?? [], updatedAt: parsed.updatedAt ?? this.now() }
    } catch {
      this.data = { entries: [], updatedAt: this.now() }
    }
  }

  private async persist(): Promise<void> {
    this.data.updatedAt = this.now()
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.file)
  }

  list(status?: StrategyStatus): LibraryEntry[] {
    return this.data.entries
      .filter((e) => !status || e.status === status)
      .map((e) => structuredClone(e))
  }

  get(id: string): LibraryEntry | undefined {
    const hit = this.data.entries.find((e) => e.id === id)
    return hit ? structuredClone(hit) : undefined
  }

  /** 提交受限 DSL 草案（Agent 调用路径）：只校验与保存，绝不执行。 */
  async propose(spec: unknown, reason: string): Promise<LibraryEntry> {
    const validated = validateStrategy(spec)
    if (!validated.ok) throw new Error(`策略 DSL 非法：${validated.errors.join('；')}`)
    const specHash = strategyHash(validated.spec)
    const existing = this.data.entries.find((e) => e.specHash === specHash && e.status !== 'retired')
    if (existing) return structuredClone(existing) // 同策略去重，不重复入库
    const entry: LibraryEntry = {
      id: `s_${specHash.slice(0, 8)}_${this.data.entries.length + 1}`,
      spec: validated.spec,
      specHash,
      status: 'proposed',
      version: 1,
      reason,
      createdAt: this.now(),
      forwardRecords: [],
      history: [{ version: 1, status: 'proposed', reason, at: this.now() }],
    }
    this.data.entries.push(entry)
    await this.persist()
    return structuredClone(entry)
  }

  /** 状态流转：须是合法转移；激活类操作（→watchlisted）必须 confirmed=true。 */
  async transition(id: string, status: StrategyStatus, reason: string, opts?: { confirmed?: boolean }): Promise<LibraryEntry> {
    const entry = this.data.entries.find((e) => e.id === id)
    if (!entry) throw new Error(`策略不存在：${id}`)
    if (entry.status === status) return structuredClone(entry)
    if (!STATUS_ORDER[entry.status].includes(status)) {
      throw new Error(`非法状态转移：${entry.status} → ${status}`)
    }
    if (status === 'watchlisted' && opts?.confirmed !== true) {
      throw new StrategyConfirmationRequired({
        action: 'activate_strategy',
        id,
        name: entry.spec.name,
        from: entry.status,
        to: status,
        reason,
        note: '升级为生效跟踪策略需用户显式批准；批准前不会改变任何状态。',
      })
    }
    entry.status = status
    entry.version += 1
    entry.reason = reason
    entry.history.push({ version: entry.version, status, reason, at: this.now() })
    await this.persist()
    return structuredClone(entry)
  }

  /** 前向重评记录：只追加，不覆盖历史；不自动下单。 */
  async recordForward(id: string, record: Omit<ForwardRecord, 'runId'> & { runId?: string }): Promise<LibraryEntry> {
    const entry = this.data.entries.find((e) => e.id === id)
    if (!entry) throw new Error(`策略不存在：${id}`)
    entry.forwardRecords.push({
      runId: record.runId ?? `f_${entry.forwardRecords.length + 1}_${record.periodStart}`,
      periodStart: record.periodStart,
      periodEnd: record.periodEnd,
      summary: structuredClone(record.summary),
      note: record.note,
    })
    await this.persist()
    return structuredClone(entry)
  }

  /** 由回测结果生成前向摘要（冻结规则可复现：保存 hash）。 */
  static forwardSummary(result: BacktestResult): ForwardRecord['summary'] {
    return {
      specHash: result.strategyHash,
      dataHash: result.dataHash,
      totalReturnPct: result.metrics.totalReturnPct,
      maxDrawdownPct: result.metrics.maxDrawdownPct,
      tradeCount: result.metrics.tradeCount,
    }
  }
}
