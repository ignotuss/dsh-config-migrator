#!/usr/bin/env node
/**
 * dsh-migrate bin shim: the npm bin target is a stable root-level file that
 * resolves the built CLI from lib/ so a profile's node_modules/.bin never
 * depends on the package's internal layout.
 */
try {
  const { main } = await import('../lib/bin.js')
  await main()
} catch (error) {
  if (error && typeof error === 'object' && error.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('dsh-migrate: build output missing — run `pnpm build` in the package first')
    process.exit(1)
  }
  throw error
}
