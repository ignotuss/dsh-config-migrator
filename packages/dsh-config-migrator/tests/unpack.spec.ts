import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { exportSnapshot, type DshProbe } from '../src/core/pack'
import { REDACTED } from '../src/core/redact'
import { restoreSnapshot } from '../src/core/unpack'

const SAVED_HOME = process.env.DSH_HOME
const SAVED_DSH_BIN = process.env.DSH_MIGRATE_DSH

const fakeProbe: DshProbe = () => ({
  ok: true,
  stdout: [
    '# == fixture',
    '- id: base',
    "  name: '@deepseek-ai/dsh-base'",
    '- id: provider',
    '  config:',
    '    apiKey: sk-test-123456',
    '',
  ].join('\n'),
  stderr: '',
})

/** pnpm runner stub: records invocations, never touches the filesystem. */
function makePnpmStub() {
  const calls: Array<{ args: string[]; cwd: string }> = []
  const runner = (args: readonly string[], options: { cwd: string }) => {
    calls.push({ args: [...args], cwd: options.cwd })
    return { ok: true, exitCode: 0, stdout: '', stderr: '' }
  }
  return { calls, runner }
}

function makeSourceSnapshot(dir: string): string {
  mkdirSync(join(dir, 'profiles', 'demo'), { recursive: true })
  writeFileSync(join(dir, 'profiles', 'demo', 'package.json'), JSON.stringify({
    name: 'dsh-profile-demo',
    private: true,
    dependencies: { 'registry-plugin': '^1.2.3' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'registry-plugin'] } },
  }, undefined, 2) + '\n')
  writeFileSync(join(dir, 'profiles', 'demo', 'cordis.patch.yml'), [
    '- id: provider',
    '  config:',
    '    apiKey: sk-patch-secret',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'profiles', 'demo', 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  writeFileSync(join(dir, 'profiles', 'demo', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: hmr\n  config:\n    root: [.]\n')
  const out = join(dir, 'out')
  mkdirSync(out, { recursive: true })
  const result = exportSnapshot(
    { all: false, profiles: ['demo'], outDir: out, noRedact: false, includeHome: true },
    fakeProbe,
  )
  return result.snapshotDir
}

describe('restoreSnapshot', () => {
  const roots: string[] = []
  after(() => {
    process.env.DSH_HOME = SAVED_HOME
    process.env.DSH_MIGRATE_DSH = SAVED_DSH_BIN
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  function withHomes(block: (snapshotDir: string, targetHome: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'dcm-unpack-'))
    roots.push(root)
    const sourceHome = join(root, 'source')
    const targetHome = join(root, 'target')
    process.env.DSH_HOME = sourceHome
    delete process.env.DSH_MIGRATE_DSH
    // makeSourceSnapshot lays its fixtures under $DSH_HOME/profiles.
    const snapshotDir = makeSourceSnapshot(sourceHome)
    process.env.DSH_HOME = targetHome
    block(snapshotDir, targetHome)
  }

  it('restores into an empty profile, verifies, and stages redacted files', () => {
    withHomes((snapshotDir, targetHome) => {
      const { calls, runner } = makePnpmStub()
      const report = restoreSnapshot(
        { snapshotDir, withHome: true, force: false, dryRun: false, pnpmRunner: runner },
        fakeProbe,
      )
      assert.equal(report.installed, true)
      assert.equal(report.verification.status, 'verified')
      assert.equal(report.homeWritten, true)
      assert.deepEqual(calls[0]!.args, ['install', '--frozen-lockfile'])
      assert.ok(calls[0]!.cwd.endsWith(join('profiles', 'demo')))

      const targetProfile = join(targetHome, 'profiles', 'demo')
      assert.ok(existsSync(join(targetProfile, 'package.json')))
      assert.ok(existsSync(join(targetProfile, 'pnpm-lock.yaml')))
      const patch = readFileSync(join(targetProfile, 'cordis.patch.yml'), 'utf8')
      assert.ok(patch.includes(`apiKey: ${REDACTED}`))
      assert.ok(existsSync(join(targetHome, 'cordis.patch.yml')))
    })
  })

  it('dry-run prints the plan and touches nothing', () => {
    withHomes((snapshotDir, targetHome) => {
      const { runner } = makePnpmStub()
      const report = restoreSnapshot(
        { snapshotDir, withHome: false, force: false, dryRun: true, pnpmRunner: runner },
        fakeProbe,
      )
      assert.equal(report.installed, false)
      assert.ok(report.plan.some(line => line.includes('registry-plugin')))
      assert.equal(existsSync(join(targetHome, 'profiles')), false)
      assert.equal(existsSync(join(targetHome, 'cordis.patch.yml')), false)
    })
  })

  it('rejects a non-empty target profile', () => {
    withHomes((snapshotDir, targetHome) => {
      mkdirSync(join(targetHome, 'profiles', 'demo'), { recursive: true })
      writeFileSync(join(targetHome, 'profiles', 'demo', 'package.json'), '{}')
      const { runner } = makePnpmStub()
      assert.throws(
        () => restoreSnapshot({ snapshotDir, withHome: false, force: false, dryRun: false, pnpmRunner: runner }, fakeProbe),
        /非空/,
      )
    })
  })

  it('repairs lockfile-relative link deps to their absolute targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'dcm-unpack-link-'))
    roots.push(root)
    const sourceHome = join(root, 'source')
    const targetHome = join(root, 'target')
    const localPlugin = join(root, 'local-plugin')
    mkdirSync(join(localPlugin), { recursive: true })
    writeFileSync(join(localPlugin, 'package.json'), JSON.stringify({
      name: 'local-plugin', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    process.env.DSH_HOME = sourceHome
    mkdirSync(join(sourceHome, 'profiles', 'demo'), { recursive: true })
    writeFileSync(join(sourceHome, 'profiles', 'demo', 'package.json'), JSON.stringify({
      name: 'dsh-profile-demo',
      private: true,
      dependencies: { 'local-plugin': `link:${localPlugin.replace(/\\/g, '/')}` },
      dsh: { profile: { bundles: ['local-plugin'] } },
    }, undefined, 2) + '\n')
    writeFileSync(join(sourceHome, 'profiles', 'demo', 'cordis.patch.yml'), '# empty\n')
    writeFileSync(join(sourceHome, 'profiles', 'demo', 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    writeFileSync(join(sourceHome, 'profiles', 'demo', 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const out = join(root, 'out')
    mkdirSync(out, { recursive: true })
    const snapshotDir = exportSnapshot(
      { all: false, profiles: ['demo'], outDir: out, noRedact: false, includeHome: false },
      fakeProbe,
    ).snapshotDir
    process.env.DSH_HOME = targetHome
    const { runner } = makePnpmStub()
    const report = restoreSnapshot(
      { snapshotDir, withHome: false, force: false, dryRun: false, pnpmRunner: runner },
      fakeProbe,
    )
    assert.equal(report.installed, true)
    const linkPath = join(targetHome, 'profiles', 'demo', 'node_modules', 'local-plugin')
    assert.ok(readFileSync(join(linkPath, 'package.json'), 'utf8').includes('local-plugin'))
    assert.ok(report.warnings.some(line => line.includes('已重建为绝对路径')))
  })

  it('warns when a link target is missing on the target machine', () => {
    const root = mkdtempSync(join(tmpdir(), 'dcm-unpack-link-'))
    roots.push(root)
    const sourceHome = join(root, 'source')
    const targetHome = join(root, 'target')
    process.env.DSH_HOME = sourceHome
    mkdirSync(join(sourceHome, 'profiles', 'demo'), { recursive: true })
    writeFileSync(join(sourceHome, 'profiles', 'demo', 'package.json'), JSON.stringify({
      name: 'dsh-profile-demo',
      private: true,
      dependencies: { 'ghost-plugin': `link:${join(root, 'no-such-dir').replace(/\\/g, '/')}` },
      dsh: { profile: { bundles: ['ghost-plugin'] } },
    }, undefined, 2) + '\n')
    writeFileSync(join(sourceHome, 'profiles', 'demo', 'cordis.patch.yml'), '# empty\n')
    writeFileSync(join(sourceHome, 'profiles', 'demo', 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    const out = join(root, 'out')
    mkdirSync(out, { recursive: true })
    const snapshotDir = exportSnapshot(
      { all: false, profiles: ['demo'], outDir: out, noRedact: false, includeHome: false },
      fakeProbe,
    ).snapshotDir
    process.env.DSH_HOME = targetHome
    const { runner } = makePnpmStub()
    const report = restoreSnapshot(
      { snapshotDir, withHome: false, force: false, dryRun: false, pnpmRunner: runner },
      fakeProbe,
    )
    assert.ok(report.warnings.some(line => line.includes('ghost-plugin') && line.includes('不存在')))
  })

  it('requires --force before overwriting an existing home layer', () => {
    withHomes((snapshotDir, targetHome) => {
      mkdirSync(targetHome, { recursive: true })
      writeFileSync(join(targetHome, 'cordis.patch.yml'), '# existing\n')
      const { runner } = makePnpmStub()
      assert.throws(
        () => restoreSnapshot({ snapshotDir, withHome: true, force: false, dryRun: false, pnpmRunner: runner }, fakeProbe),
        /--force/,
      )
    })
  })

  it('backs up then overwrites the home layer with --force', () => {
    withHomes((snapshotDir, targetHome) => {
      mkdirSync(targetHome, { recursive: true })
      writeFileSync(join(targetHome, 'cordis.patch.yml'), '# existing\n')
      const { runner } = makePnpmStub()
      const report = restoreSnapshot(
        { snapshotDir, withHome: true, force: true, dryRun: false, pnpmRunner: runner },
        fakeProbe,
      )
      assert.equal(report.homeWritten, true)
      assert.ok(report.homeBackedUpTo !== undefined)
      assert.ok(existsSync(report.homeBackedUpTo))
      const files = readdirSync(targetHome).filter(name => name.startsWith('cordis.patch.yml.bak-'))
      assert.equal(files.length, 1)
      assert.ok(readFileSync(join(targetHome, 'cordis.patch.yml'), 'utf8').includes('- id: hmr'))
    })
  })

  it('rolls back staged files when pnpm fails', () => {
    withHomes((snapshotDir, targetHome) => {
      const runner = () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'boom' })
      assert.throws(
        () => restoreSnapshot({ snapshotDir, withHome: false, force: false, dryRun: false, pnpmRunner: runner }, fakeProbe),
        /pnpm install 失败/,
      )
      assert.equal(existsSync(join(targetHome, 'profiles', 'demo')), false)
    })
  })

  it('requires an explicit --profile for multi-profile snapshots', () => {
    const root = mkdtempSync(join(tmpdir(), 'dcm-unpack-'))
    roots.push(root)
    const sourceHome = join(root, 'source')
    process.env.DSH_HOME = sourceHome
    // Two profiles under $DSH_HOME/profiles, exported with --all.
    mkdirSync(join(sourceHome, 'profiles', 'alpha'), { recursive: true })
    mkdirSync(join(sourceHome, 'profiles', 'beta'), { recursive: true })
    for (const name of ['alpha', 'beta']) {
      writeFileSync(join(sourceHome, 'profiles', name, 'package.json'), JSON.stringify({
        name: `dsh-profile-${name}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
      }))
      writeFileSync(join(sourceHome, 'profiles', name, 'cordis.patch.yml'), '# empty\n')
      writeFileSync(join(sourceHome, 'profiles', name, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    }
    const out = join(root, 'out2')
    mkdirSync(out, { recursive: true })
    const multi = exportSnapshot(
      { all: true, profiles: [], outDir: out, noRedact: false, includeHome: false },
      fakeProbe,
    )
    process.env.DSH_HOME = join(root, 'target')
    assert.throws(
      () => restoreSnapshot({ snapshotDir: multi.snapshotDir, withHome: false, force: false, dryRun: true }, fakeProbe),
      /--profile/,
    )
  })

  it('restores a single-profile snapshot under a NEW target name (rename on restore)', () => {
    withHomes((snapshotDir, targetHome) => {
      const { calls, runner } = makePnpmStub()
      const report = restoreSnapshot(
        { snapshotDir, targetProfile: 'fresh-copy', withHome: false, force: false, dryRun: false, pnpmRunner: runner },
        fakeProbe,
      )
      // The destination name is the target profile directory…
      assert.equal(report.profile, 'fresh-copy')
      assert.equal(report.installed, true)
      assert.ok(calls[0]!.cwd.endsWith(join('profiles', 'fresh-copy')))
      // …while the snapshot is still read from its own profile key (`demo`).
      assert.ok(existsSync(join(targetHome, 'profiles', 'fresh-copy', 'package.json')))
      assert.equal(existsSync(join(targetHome, 'profiles', 'demo')), false)
      assert.equal(report.verification.status, 'verified')
    })
  })

  it('names the destination in the plan and rejects a taken target name', () => {
    withHomes((snapshotDir, targetHome) => {
      const { runner } = makePnpmStub()
      const plan = restoreSnapshot(
        { snapshotDir, targetProfile: 'fresh-copy', withHome: false, force: false, dryRun: true, pnpmRunner: runner },
        fakeProbe,
      )
      assert.ok(plan.plan[0]!.includes('fresh-copy'))

      mkdirSync(join(targetHome, 'profiles', 'taken'), { recursive: true })
      writeFileSync(join(targetHome, 'profiles', 'taken', 'package.json'), '{}')
      assert.throws(
        () => restoreSnapshot(
          { snapshotDir, targetProfile: 'taken', withHome: false, force: false, dryRun: true, pnpmRunner: runner },
          fakeProbe,
        ),
        /非空/,
      )
    })
  })
})
