import type { SearchResult } from './types.js'

/** Shape of the ctx.web search provider (mirrors @deepseek-ai/dsh-web WebSearchProvider). */
export interface WebSearchProviderLike {
  readonly id: string
  available(): boolean
  search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<{
    content?: string
    sources: Array<{ url: string; title?: string; snippet?: string }>
    truncated: boolean
  }>
}

export const DDG_PROVIDER_ID = 'dsn-duckduckgo'

/**
 * A DuckDuckGo-backed provider for the ctx.web search seam, so the built-in `web_search`
 * tool works without an API key (replacing the default DeepSeek provider, which needs one).
 * Reuses the plugin's ddg providers (html → instant fallback, shared rate limit + cache).
 */
export function createDdgSearchProvider(
  search: (query: string, signal?: AbortSignal) => Promise<{ ok: boolean; data?: SearchResult[]; error?: string }>,
): WebSearchProviderLike {
  return {
    id: DDG_PROVIDER_ID,
    available: () => true,
    async search(request, signal) {
      const res = await search(request.query, signal)
      if (!res.ok || !Array.isArray(res.data)) throw new Error(res.error ?? 'duckduckgo search unavailable')
      const sources = res.data
        .filter((r): r is SearchResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
        .map((r) => ({ url: r.url, title: r.title || undefined, snippet: r.snippet || undefined }))
      return { sources, truncated: false }
    },
  }
}
