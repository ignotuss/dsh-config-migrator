/**
 * link-inbox: junction/symlink an in-box DSH package from a local DSH
 * checkout into this repo's node_modules, so LINKED plugin installs can
 * resolve packages the npm registry does not publish (e.g. dsh-tools, whose
 * transitive dependencies are unpublished).
 *
 * Usage: node scripts/link-inbox.mjs <path-to-dsh-checkout> [package...]
 * Defaults: the checkout is guessed when C:\Users\...\ds_harness exists;
 * packages default to @deepseek-ai/dsh-tools.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultCheckout = process.platform === 'win32' && existsSync('C:/Users/23992/Desktop/ds_harness')
  ? 'C:/Users/23992/Desktop/ds_harness'
  : undefined

const checkout = resolve(process.argv[2] ?? defaultCheckout ?? '')
if (!checkout || !existsSync(join(checkout, 'package.json'))) {
  console.error('usage: node scripts/link-inbox.mjs <path-to-dsh-checkout> [package...]')
  process.exit(1)
}

const packages = process.argv.slice(3)
const defaults = {
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
}
const targets = Object.fromEntries(
  (packages.length > 0 ? packages : Object.keys(defaults))
    .map(name => [name, defaults[name] ?? inferPackagePath(checkout, name)]),
)

for (const [name, relative] of Object.entries(targets)) {
  const target = join(checkout, relative)
  if (!existsSync(join(target, 'package.json'))) {
    console.error(`link-inbox: ${target} has no package.json — pass the package path explicitly (e.g. packages/core/tools)`)
    continue
  }
  const link = join(root, 'node_modules', ...name.split('/'))
  try {
    const stat = lstatSync(link)
    if (stat.isSymbolicLink() || stat.isDirectory()) rmSync(link, { recursive: true, force: true })
  } catch {
    /* absent */
  }
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`linked ${name} -> ${target}`)
}

function inferPackagePath(checkout, name) {
  return `packages/core/${name.split('/').pop()}`
}
