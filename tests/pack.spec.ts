import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, it } from 'node:test'
import { exportSnapshot, type DshProbe } from '../src/core/pack'
import { REDACTED } from '../src/core/redact'

const SAVED_HOME = process.env.DSH_HOME

/** A boot-free fake dsh probe returning a fixed composed dump with one secret. */
const fakeProbe: DshProbe = profile => ({
  ok: true,
  stdout: [
    '# == fixture',
    '- id: base',
    "  name: '@deepseek-ai/dsh-base'",
    '- id: provider',
    '  config:',
    '    apiKey: sk-test-123456',
    '- id: off',
    '  disabled: true',
    '',
  ].join('\n'),
  stderr: '',
})

interface Fixture {
  root: string
  home: string
  out: string
}

function makeSourceHome(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dcm-pack-'))
  const home = join(root, 'home')
  const out = join(root, 'out')
  mkdirSync(join(home, 'profiles', 'demo'), { recursive: true })
  mkdirSync(out, { recursive: true })
  writeFileSync(join(home, 'profiles', 'demo', 'package.json'), JSON.stringify({
    name: 'dsh-profile-demo',
    private: true,
    dependencies: {
      'local-plugin': 'link:C://Users//me//plugin',
      'registry-plugin': '^1.2.3',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'local-plugin'] } },
  }, undefined, 2) + '\n')
  writeFileSync(join(home, 'profiles', 'demo', 'cordis.patch.yml'), [
    '# user patch',
    '- id: provider',
    '  config:',
    '    apiKey: sk-patch-secret',
    '    model: deepseek-v4-pro',
    '',
  ].join('\n'))
  writeFileSync(join(home, 'profiles', 'demo', 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  writeFileSync(join(home, 'profiles', 'demo', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(home, 'cordis.patch.yml'), [
    '# home layer',
    '- id: hmr',
    '  config:',
    '    token: ${HOME_TOKEN}',
    '',
  ].join('\n'))
  return { root, home, out }
}

describe('exportSnapshot', () => {
  const fixtures: Fixture[] = []
  beforeEach(() => {
    const fixture = makeSourceHome()
    fixtures.push(fixture)
    process.env.DSH_HOME = fixture.home
  })
  afterEach(() => {
    process.env.DSH_HOME = SAVED_HOME
  })
  after(() => {
    for (const fixture of fixtures) rmSync(fixture.root, { recursive: true, force: true })
  })

  it('packs a profile with byte-faithful files and redaction', () => {
    const fixture = fixtures[fixtures.length - 1]!
    const result = exportSnapshot(
      { all: false, profiles: ['demo'], outDir: fixture.out, noRedact: false, includeHome: true },
      fakeProbe,
    )
    assert.ok(result.snapshotDir.includes('dsh-migrate-demo-'))

    const manifest = result.manifest
    assert.equal(manifest.source.homeLabel, '$DSH_HOME')
    assert.deepEqual(manifest.profiles.demo!.bundles, ['@deepseek-ai/dsh-base', 'local-plugin'])
    assert.equal(manifest.profiles.demo!.patchEntryCount, 1)
    assert.equal(manifest.profiles.demo!.composedAvailable, true)
    assert.equal(manifest.home.included, true)

    // Redactions: patch secret + composed secret + home env-ref (reported, not redacted).
    const patchRedactions = manifest.profiles.demo!.redactions.filter(item => item.file.includes('cordis.patch.yml'))
    const composedRedactions = manifest.profiles.demo!.redactions.filter(item => item.file.includes('composed-config.yml'))
    assert.equal(patchRedactions.length, 1)
    assert.equal(composedRedactions.length, 1)

    // Snapshot files: redacted patch, byte-faithful package.json.
    const patch = readFileSync(join(result.snapshotDir, 'profiles', 'demo', 'cordis.patch.yml'), 'utf8')
    assert.ok(patch.includes(`apiKey: ${REDACTED}`))
    assert.ok(patch.includes('model: deepseek-v4-pro'))
    const pkg = readFileSync(join(result.snapshotDir, 'profiles', 'demo', 'package.json'), 'utf8')
    assert.ok(pkg.includes('"link:C://Users//me//plugin"'))
    assert.ok(readFileSync(join(result.snapshotDir, 'profiles', 'demo', 'pnpm-lock.yaml'), 'utf8').includes('lockfileVersion: 9'))

    // Warnings: link dep + env reference + absolute path scan untouched home layer.
    assert.ok(result.warnings.some(warning => warning.kind === 'non-registry-dependency'))
    assert.ok(result.warnings.some(warning => warning.kind === 'env-reference' && warning.file?.includes('home/')))
  })

  it('--no-redact keeps secrets verbatim and counts no redactions', () => {
    const fixture = fixtures[fixtures.length - 1]!
    const result = exportSnapshot(
      { all: false, profiles: ['demo'], outDir: fixture.out, noRedact: true, includeHome: true },
      fakeProbe,
    )
    const patch = readFileSync(join(result.snapshotDir, 'profiles', 'demo', 'cordis.patch.yml'), 'utf8')
    assert.ok(patch.includes('apiKey: sk-patch-secret'))
    assert.equal(result.manifest.profiles.demo!.redactions.length, 0)
  })

  it('--all lists every profile under DSH_HOME', () => {
    const fixture = fixtures[fixtures.length - 1]!
    mkdirSync(join(fixture.home, 'profiles', 'second'), { recursive: true })
    writeFileSync(join(fixture.home, 'profiles', 'second', 'package.json'), JSON.stringify({
      name: 'dsh-profile-second', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
    }))
    const result = exportSnapshot(
      { all: true, profiles: [], outDir: fixture.out, noRedact: false, includeHome: false },
      fakeProbe,
    )
    assert.deepEqual(Object.keys(result.manifest.profiles).sort(), ['demo', 'second'])
    assert.equal(result.manifest.home.included, false)
    assert.equal(existsSync(join(result.snapshotDir, 'home')), false)
  })

  it('rejects a missing profile', () => {
    const fixture = fixtures[fixtures.length - 1]!
    assert.throws(
      () => exportSnapshot({ all: false, profiles: ['nope'], outDir: fixture.out, noRedact: false, includeHome: false }, fakeProbe),
      /does not exist/,
    )
  })

  it('flags link deps whose target is already gone on the source machine', () => {
    const fixture = fixtures[fixtures.length - 1]!
    const manifest = readFileSync(join(fixture.home, 'profiles', 'demo', 'package.json'), 'utf8')
    const patched = manifest.replace('"link:C://Users//me//plugin"', '"link:C:/no/such/dir/here"')
    writeFileSync(join(fixture.home, 'profiles', 'demo', 'package.json'), patched)
    const result = exportSnapshot(
      { all: false, profiles: ['demo'], outDir: fixture.out, noRedact: false, includeHome: false },
      fakeProbe,
    )
    assert.ok(result.warnings.some(warning => warning.kind === 'stale-link-target' && /no[\\/]such/.test(warning.message)))
  })
})
