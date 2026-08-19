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

export const WEB_SEARCH_PROVIDER_ID = 'dsn-web-search'

/**
 * Free web search for the ctx.web seam (replaces key-gated DeepSeek provider).
 * Backed by Python ddgs + primp → Bing/Google/Yandex meta engines.
 */
export function createWebSearchProvider(
  search: (query: string, signal?: AbortSignal) => Promise<{ ok: boolean; data?: SearchResult[]; error?: string }>,
): WebSearchProviderLike {
  return {
    id: WEB_SEARCH_PROVIDER_ID,
    available: () => true,
    async search(request, signal) {
      const res = await search(request.query, signal)
      if (!res.ok || !Array.isArray(res.data)) throw new Error(res.error ?? 'web search unavailable')
      const sources = res.data
        .filter((r): r is SearchResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
        .map((r) => ({ url: r.url, title: r.title || undefined, snippet: r.snippet || undefined }))
      return { sources, truncated: false }
    },
  }
}
