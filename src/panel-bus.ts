import { EventEmitter } from 'node:events'
import type { AssetType, PortfolioHolding, WatchItem } from './types.js'

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
}

/**
 * Events pushed to panel clients over SSE (`GET /events`).
 * - portfolio/analysis/history: state changed (store-level or tool-level mutation)
 * - providers/skills/mcp: configuration changed, views should refetch
 * - panel: a command from the model to the panel UI (agent → panel direction)
 */
export type BusEvent =
  | { kind: 'portfolio'; holdings: PortfolioHolding[]; watchlist: WatchItem[]; portfolioPath: string }
  | { kind: 'analysis'; code: string; type: AssetType; generatedAt: string }
  | { kind: 'history'; code: string; bars: number; addedBars: number }
  | { kind: 'providers' }
  | { kind: 'skills' }
  | { kind: 'mcp' }
  | { kind: 'panel'; command: PanelCommand }

/**
 * In-process pub/sub bridge between server-side mutations (tools, stores,
 * routes) and connected panel clients (SSE). One instance per plugin apply().
 */
export class PanelBus {
  private readonly emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(0)
  }

  publish(event: BusEvent): void {
    this.emitter.emit('event', event)
  }

  subscribe(fn: (event: BusEvent) => void): () => void {
    this.emitter.on('event', fn)
    return () => {
      this.emitter.off('event', fn)
    }
  }
}
