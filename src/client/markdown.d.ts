/** Client-only deps bundled by esbuild; ambient types for tsc + NodeNext resolution. */
declare module 'react-markdown' {
  import type { ComponentType, ReactNode } from 'react'
  interface ReactMarkdownProps {
    children?: string
    remarkPlugins?: unknown[]
    components?: Record<string, ComponentType<Record<string, unknown>>>
  }
  const ReactMarkdown: ComponentType<ReactMarkdownProps>
  export default ReactMarkdown
}

declare module 'remark-gfm' {
  const remarkGfm: unknown
  export default remarkGfm
}
