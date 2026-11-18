import assert from 'node:assert/strict'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import type { Context as ContextType } from '@deepseek-ai/cordis'
import SystemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import ToolRuntimePlugin from '@deepseek-ai/dsh-tools'
import { LazyToolCatalog } from '../src/tools/lazy.js'

const registered = new Map<string, ToolDefinition>()
const runtime = {
  register(definition: ToolDefinition) {
    assert.equal(registered.has(definition.name), false, `duplicate ${definition.name}`)
    registered.set(definition.name, definition)
    return () => { registered.delete(definition.name) }
  },
}
const catalog = new LazyToolCatalog(runtime as unknown as Pick<ContextType['tools'], 'register'>)
const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }

for (let i = 0; i < 10; i++) {
  const name = i < 5 ? `fund_tool_${i}` : `follow_tool_${i}`
  catalog.capture(defineTool({
    name,
    description: i < 5 ? `基金经理风险工具 ${i}` : `机构追踪工具 ${i}`,
    parameters: {},
    output,
    async execute() { return { ok: true } },
  }))
}
assert.equal(registered.size, 0, 'captured definitions must stay out of the initial model toolset')

catalog.registerSearchTool({ tools: runtime } as unknown as Context)
const search = registered.get('finance_find_tools')!
const first = await search.execute({ query: '基金经理与风险', limit: 2 }, {} as never) as { loaded: Array<{ name: string }>; activeToolCount: number }
assert.equal(first.loaded.length, 2)
assert.ok(first.loaded.every((item) => item.name.startsWith('fund_tool_')))
assert.equal(first.activeToolCount, 2)

const second = await search.execute({ query: '追踪机构', limit: 3 }, {} as never) as { loaded: Array<{ name: string }>; activeToolCount: number }
assert.ok(second.loaded.every((item) => item.name.startsWith('follow_tool_')))
assert.equal(second.activeToolCount, 5)

// Search never expands into the entire catalog; the active set is bounded.
for (let i = 0; i < 4; i++) await search.execute({ query: '基金经理', limit: 5 }, {} as never)
assert.ok(registered.size <= 1 + 8, 'active native schemas must remain bounded (plus the search tool)')

// Exercise the Cordis child-scope adapter used by local tools and the MCP bridge.
const host = new Context()
await Promise.all([host.plugin(SystemPromptPlugin, {}), host.plugin(ToolRuntimePlugin, {})])
const hostCatalog = new LazyToolCatalog(host.tools, host.systemPrompt)
const capturedContext = hostCatalog.captureContext(host, 'mcp:nested-test', true)
const nestedDefinition = defineTool({
  name: 'nested_hidden', description: 'hidden in the child scope', parameters: {}, output,
  async execute() { return { ok: true } },
})
const nestedPlugin = {
  name: 'lazy-capture-test',
  inject: ['tools'],
  apply(pluginCtx: ContextType) {
    const unregister = pluginCtx.tools.register(nestedDefinition)
    const promptFiber = pluginCtx.inject(['systemPrompt'], (inner: ContextType) => {
      const promptUnregister = inner.systemPrompt.section({
        name: 'mcp:nested-test', order: 120, text: 'large external server instructions should also be on demand',
      })
      inner.effect(() => promptUnregister)
    })
    pluginCtx.effect(() => unregister)
    void promptFiber
  },
}
const nestedFiber = capturedContext.plugin(nestedPlugin, {})
await nestedFiber
assert.equal(host.tools.schemas().some((schema) => schema.name === 'nested_hidden'), false)
assert.equal((await host.systemPrompt.assemble()).sections.some((section) => section.name === 'mcp:nested-test'), false)
hostCatalog.pin('nested_hidden')
assert.equal(host.tools.schemas().some((schema) => schema.name === 'nested_hidden'), true)
assert.equal((await host.systemPrompt.assemble()).sections.some((section) => section.name === 'mcp:nested-test'), true)
await nestedFiber.dispose()
assert.equal(host.tools.schemas().some((schema) => schema.name === 'nested_hidden'), false)
assert.equal((await host.systemPrompt.assemble()).sections.some((section) => section.name === 'mcp:nested-test'), false)
hostCatalog.dispose()
await host.fiber.dispose()

console.log('PASS lazy finance tools: hidden by default, retrieved by topic, bounded active set, Cordis/MCP child scope captured')
