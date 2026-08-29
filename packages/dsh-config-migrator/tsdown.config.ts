import { defineConfig } from 'tsdown'
import { typertPlugin } from '../../scripts/vendor-typert2/types/tsdown-plugin.js'

/** Platform modules shared into the browser module table (mirrors DSH's client/web/src/platform.ts). */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

const ID = 'dsh-config-migrator'

/**
 * Node half with the typert generator (vendored from a local DSH checkout by
 * scripts/link-inbox.mjs — the npm release set is internally inconsistent).
 */
const node = defineConfig({
  name: ID,
  entry: {
    index: 'src/index.ts',
    host: 'src/host/index.ts',
    bin: 'src/bin/cli.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  // dsh-tools is an in-box package of the DSH installation: never bundle it.
  deps: { neverBundle: ['@deepseek-ai/dsh-tools'] },
  plugins: [typertPlugin()],
})

/**
 * Browser half: the settings section, emitted as the loader-registered
 * client bundle (window.__ModuleLoader__.load handoff, mirrors DSH's
 * clientBundle preset).
 */
const client = defineConfig({
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...PLATFORM_MODULES, '@deepseek-ai/dsh-client-runtime/client'],
  // Everything not in the frozen module table must inline (mirrors DSH).
  noExternal: (id: string) => [...PLATFORM_MODULES, '@deepseek-ai/dsh-client-runtime/client'].includes(id) ? undefined : true,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

export default [node, client]
