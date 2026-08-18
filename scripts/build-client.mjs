// Bundle the client plugin into the DSH "wrapped module" format the harness
// serves at /plugins/<id>/client.js. React and DSH client packages stay
// external (provided by the host module table via the factory's `require`).
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const OUT = 'lib/client/wrapped-bundle.js'
const ID = 'dsn-finance'

const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  write: false,
  logLevel: 'warning',
})

const code = result.outputFiles[0].text
const wrapped = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(ID)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  code,
  '    return module.exports;',
  '  }',
  '});',
  '',
].join('\n')

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, wrapped)
console.log(`[build-client] wrote ${OUT} (${wrapped.length} bytes)`)
