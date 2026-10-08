import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { AssetType, PortfolioHolding, WatchItem } from './types.js'
import { formatCursor, parseCursor, type BusEnvelope, type StreamCursor } from './panel-envelope.js'

export type { BusEnvelope, StreamCursor } from './panel-envelope.js'
export { formatCursor, parseCursor, isStaleCommand } from './panel-envelope.js'

/** One market kind understood by the panel K-line page. */
export type HistoryKind = 'a' | 'hk' | 'us' | 'fund'

/** A navigation command the model can send to the finance panel (via SSE). */
export interface PanelCommand {
  action: 'navigate'
  /** Target tab id (must match the client TABS list). */
  tab: string
  /** Optional security code to focus (K-line page / analysis). */
  code?: string
  type?: AssetType
  /** Market kind for the K-line page; falls back to `fund` for funds, else `a`. */
  kind?: HistoryKind
  /** Also open the AI position-analysis view for the code. */
  openAnalysis?: boolean
  /** 页内锚点（切到 tab 后滚动/聚焦到某区块）：home=overview|growth|journal|reviews|approvals，holdings=lookthrough。 */
  anchor?: string
  /** 面板顶部展示的一句话（Agent 解释这次导航的意图，≤120 字）。 */
  note?: string
  /** Dedupe id + TTL stamped by the bus. Replayed/stale commands are ignored. */
  commandId?: string
  issuedAt?: string
  expiresAt?: string
}

/**
 * Events pushed to panel clients over SSE (`GET /events`).
 * - portfolio/analysis/history: state changed (store-level or tool-level mutation)
 * - providers/skills/mcp: configuration changed, views should refetch
 * - panel: a command from the model to the panel UI (agent → panel direction)
 * - __resync: stream gap/restart marker (server-generated; views reload snapshots)
 */
export type BusEvent =
  | { kind: 'portfolio'; holdings: PortfolioHolding[]; watchlist: WatchItem[]; portfolioPath: string }
  | { kind: 'analysis'; code: string; type: AssetType; generatedAt: string }
  | { kind: 'history'; code: string; bars: number; addedBars: number }
  | {
      kind: 'research'
      action: 'save' | 'update' | 'note' | 'archive' | 'restore' | 'collect' | 'sync'
      id: string
      /** 资料标题（面板 toast 用：让「Agent 刚存了什么」一眼可见）。 */
      title?: string
      /** 批量动作（collect/sync）的条数。 */
      count?: number
      /** 动作来源：chat=Agent 对话落库，panel=面板操作，file=外部文件同步。 */
      origin?: 'chat' | 'panel' | 'file'
    }
  | { kind: 'providers' }
  | { kind: 'skills' }
  | { kind: 'mcp' }
  | { kind: 'reminder'; count: number; at: string }
  /** 成长档案变更（Agent 在对话里判分/写规划/记复盘 → 面板即时回执刷新）。 */
  | { kind: 'growth'; action: 'profile' | 'plan' | 'quiz' | 'review'; at: string }
  | { kind: 'follow'; action: 'target' | 'snapshot' | 'job' | 'brief' | 'shadow'; targetId?: string; at: string }
  /** Agent 活动指示：工具开始/结束（面板显示「Agent 正在做什么」）。 */
  | { kind: 'agent'; phase: 'start' | 'done'; tool: string; at: string }
  | { kind: 'panel'; command: PanelCommand }

/** Navigation commands stay actionable for this long (replays after that are ignored). */
export const PANEL_COMMAND_TTL_MS = 15_000

/** Bounded replay buffer: the most events a reconnecting client can catch up on. */
const REPLAY_LIMIT = 512
const REPLAY_MAX_AGE_MS = 10 * 60_000

export interface BusSubscribeOptions {
  /** Resume cursor `epoch:seq` (from SSE `Last-Event-ID` or `?since=`). */
  since?: string
  /** Invoked (before replay) when the stream cannot cover `since` continuously. */
  onGap?: (info: { cursor?: StreamCursor; epoch: string }) => void
}

export interface BusSubscription {
  close: () => void
  /** True when the subscriber may have missed events (restart or buffer trim). */
  gap: boolean
  epoch: string
}

/**
 * In-process pub/sub bridge between server-side mutations (tools, stores,
 * routes) and connected panel clients (SSE). One instance per plugin apply().
 *
 * Every published event is wrapped in a numbered envelope (`epoch`/`seq`/
 * `emittedAt`) and kept in a bounded replay buffer, so clients that reconnect
 * with a cursor can catch up instead of silently losing events. If the cursor
 * cannot be covered (server restarted, buffer trimmed), `onGap` fires and the
 * subscriber should resync from state snapshots.
 */
export class PanelBus {
  private readonly emitter = new EventEmitter()
  /** Stream identity for this process/apply(); clients reset their cursor on change. */
  readonly epoch = randomUUID()
  private seq = 0
  private replay: BusEnvelope<BusEvent>[] = []
  private readonly commandTtlMs: number
  private readonly replayLimit: number

  constructor(options: { commandTtlMs?: number; replayLimit?: number } = {}) {
    this.emitter.setMaxListeners(0)
    this.commandTtlMs = options.commandTtlMs ?? PANEL_COMMAND_TTL_MS
    this.replayLimit = options.replayLimit ?? REPLAY_LIMIT
  }

  publish(event: BusEvent): BusEnvelope<BusEvent> {
    const emittedAt = new Date().toISOString()
    const stamped: BusEvent = event.kind === 'panel'
      ? {
          ...event,
          command: {
            ...event.command,
            commandId: event.command.commandId ?? randomUUID(),
            issuedAt: event.command.issuedAt ?? emittedAt,
            expiresAt: event.command.expiresAt ?? new Date(Date.now() + this.commandTtlMs).toISOString(),
          },
        }
      : event
    const envelope: BusEnvelope<BusEvent> = {
      v: 1,
      epoch: this.epoch,
      seq: ++this.seq,
      emittedAt,
      event: stamped,
    }
    this.replay.push(envelope)
    while (this.replay.length > this.replayLimit) this.replay.shift()
    const cutoff = Date.now() - REPLAY_MAX_AGE_MS
    while (this.replay.length && Date.parse(this.replay[0]!.emittedAt) < cutoff) this.replay.shift()
    this.emitter.emit('event', envelope)
    return envelope
  }

  /**
   * Subscribe to the live stream. With a `since` cursor, buffered events after
   * the cursor are replayed synchronously right after registering the listener
   * (no publish can interleave), so nothing is lost; the client additionally
   * drops duplicates by seq.
   */
  subscribe(fn: (envelope: BusEnvelope<BusEvent>) => void, options: BusSubscribeOptions = {}): BusSubscription {
    const cursor = parseCursor(options.since)
    this.emitter.on('event', fn)
    let gap = false
    if (cursor) {
      const first = this.replay[0]
      const contiguous = cursor.epoch === this.epoch
        && cursor.seq <= this.seq
        && (!first || cursor.seq >= first.seq - 1)
      if (!contiguous) {
        gap = true
        options.onGap?.({ cursor, epoch: this.epoch })
        // Epoch mismatch → this buffer is all the history there is. Trimmed
        // below the cursor → replay the surviving tail and flag the hole.
        for (const envelope of [...this.replay]) {
          if (cursor.epoch !== this.epoch || envelope.seq > cursor.seq) fn(envelope)
        }
      } else {
        for (const envelope of [...this.replay]) {
          if (envelope.seq > cursor.seq) fn(envelope)
        }
      }
    }
    return {
      close: () => { this.emitter.off('event', fn) },
      gap,
      epoch: this.epoch,
    }
  }
}

/** SSE `id:` / `Last-Event-ID` value for an envelope. */
export function envelopeCursor(envelope: BusEnvelope<BusEvent>): string {
  return formatCursor(envelope.epoch, envelope.seq)
}
