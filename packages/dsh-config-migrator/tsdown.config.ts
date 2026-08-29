import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

/**
 * Node-half build with the typert generator plugin: lowers decorators and
 * emits lib/typert.host.js + lib/typert.remote-client.js for the Remote
 * gateway. The analyzer needs the packages/-under-a-tsconfig.host.json
 * layout this repository mirrors; during development the generator resolves
 * from a local DSH checkout (see README §Development), because the npm
 * release set is internally inconsistent (rc.1 generator vs rc.6 protocol).
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
  // dsh-tools is an in-box package of the DSH installation: never bundle it
  // (a duplicate instance would break cross-plugin identity), and never
  // resolve it from the registry (its transitive deps are unpublished).
  deps: { neverBundle: ['@deepseek-ai/dsh-tools'] },
  plugins: [typertPlugin()],
})
