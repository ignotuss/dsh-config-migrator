import { defineConfig } from 'tsdown'

/**
 * Node-half build only (the client browser bundle gets its own config when
 * the settings UI lands). Mirrors DSH's package conventions: bundled ESM into
 * lib/*.js, types emitted separately by tsc into lib/types (tsconfig.types).
 */
export default defineConfig({
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
  // dsh-tools is an optional peer provided by the DSH installation: never
  // bundle it (a duplicate instance would break cross-plugin identity), and
  // never resolve it from the registry (its transitive deps are unpublished).
  external: ['@deepseek-ai/dsh-tools'],
})
