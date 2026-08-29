/**
 * Snapshot restore: rebuild a snapshot into a NEW (empty) profile on the
 * target machine — stage the truth files, install with pnpm (frozen
 * lockfile), validate bundle rows, optionally write the machine-level home
 * layer, and verify with a boot-free dump-config comparison.
 *
 * v1 restores empty profiles only (DESIGN.md §7.1): the operation is
 * add-only, so it can never conflict with an existing setup. Merge mode is
 * a P2 concern.
 * @module dsh-config-migrator/core/unpack
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { readManifest, type Manifest } from './manifest'
import { blockedBuilds, runPnpm, type PnpmOptions, type PnpmResult } from './pnpm'
import { spawnDumpConfig, type DshProbe } from './pack'
import { verifyRestore } from './verify'

export interface RestoreOptions {
  snapshotDir: string
  /** Target profile name; defaults to the snapshot's profile when it holds exactly one. */
  targetProfile?: string
  /** Write the machine-level home patch layer (affects ALL profiles on this machine). */
  withHome: boolean
  /** Allow overwriting an existing home patch (backed up first). */
  force: boolean
  /** Print the plan and touch nothing. */
  dryRun: boolean
  /** Test injection: replace the real pnpm runner. */
  pnpmRunner?: (args: readonly string[], options: PnpmOptions) => PnpmResult
}

export interface RestoreReport {
  manifest: Manifest
  profile: string
  targetDir: string
  /** Human-readable plan lines; the CLI prints these, GUI/agent may ignore. */
  plan: string[]
  homeWritten: boolean
  homeBackedUpTo?: string
  installed: boolean
  installOutput?: string
  verification: VerifyReportKind
  warnings: string[]
  redactionCount: number
}

type VerifyReportKind = { status: 'verified' } | { status: 'mismatch'; detail: string } | { status: 'skipped'; reason: string }

const GENERATED_FILES = new Set(['cordis.yml'])
const HOME_PATCH_FILENAME = 'cordis.patch.yml'
const PATCH_FILENAME = 'cordis.patch.yml'

/** Files that may legitimately exist in a profile we treat as "empty". */
function isEffectivelyEmpty(dir: string): boolean {
  if (!existsSync(dir)) return true
  const entries = readdirSync(dir)
  return entries.every(entry => GENERATED_FILES.has(entry))
}

/**
 * Resolve a `link:`/`file:` dependency spec to an absolute directory on THIS
 * machine. Relative specs resolve against the profile directory (pnpm
 * semantics); `C://`-style and `file:///`-style specs are normalized.
 */
function resolveLinkedDir(spec: string, profileDir: string): string {
  let target = spec.trim()
  target = target.replace(/^(?:link|file):/, '')
  target = target.replace(/^file:\/\/\/([A-Za-z]:\/.*)$/i, '$1')
  target = target.replace(/^([A-Za-z]):\/\//, '$1:/')
  if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(target)) target = target.slice(1)
  return resolve(profileDir, target)
}

/**
 * pnpm records link/file dependencies in the lockfile as paths RELATIVE to
 * the profile directory, so after a restore into a different home the
 * junctions it recreates dangle. Repair them from the absolute spec the
 * snapshot's package.json still carries. Targets missing on this machine are
 * reported — a cross-machine restore cannot conjure the source directory.
 */
function repairLinkedDeps(targetDir: string, dependencies: Record<string, string>, warnings: string[]): void {
  for (const [dep, spec] of Object.entries(dependencies)) {
    if (!/^(?:link|file):/.test(spec)) continue
    const target = resolveLinkedDir(spec, targetDir)
    if (!existsSync(target)) {
      warnings.push(`本地依赖 ${dep} 指向 ${target}——目标机器上不存在，链接保持损坏；先迁移该目录或改用 registry 版本`)
      continue
    }
    const linkPath = join(targetDir, 'node_modules', ...dep.split('/'))
    try {
      const stat = lstatSync(linkPath)
      if (stat.isSymbolicLink() || stat.isDirectory()) rmSync(linkPath, { recursive: true, force: true })
      else rmSync(linkPath, { force: true })
    } catch {
      /* absent — created below */
    }
    mkdirSync(join(linkPath, '..'), { recursive: true })
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    warnings.push(`本地依赖 ${dep} 的链接已重建为绝对路径 ${target}（lockfile 中的相对链接在新 home 下会失效）`)
  }
}

function requiredSnapshotFile(snapshotProfileDir: string, filename: string): string {
  const path = join(snapshotProfileDir, filename)
  if (!existsSync(path)) throw new Error(`snapshot is missing ${path}`)
  return readFileSync(path, 'utf8')
}

/**
 * Restore a snapshot. Throws on any blocking problem (non-empty target,
 * pnpm failure, missing files); returns a report otherwise.
 */
export function restoreSnapshot(options: RestoreOptions, probe: DshProbe = spawnDumpConfig): RestoreReport {
  const manifest = readManifest(options.snapshotDir)
  const home = resolveDshHome()
  const warnings: string[] = []

  const names = Object.keys(manifest.profiles)
  const profile = options.targetProfile ?? (names.length === 1 ? names[0] : undefined)
  if (profile === undefined) {
    throw new Error(`snapshot 包含 ${names.length} 个 profile（${names.join(', ')}），请用 --profile 指定要恢复哪一个`)
  }
  const entry = manifest.profiles[profile]
  if (entry === undefined) throw new Error(`snapshot 不含 profile ${JSON.stringify(profile)}`)

  const targetDir = resolveProfileDir(profile, home)
  const snapshotProfileDir = join(options.snapshotDir, 'profiles', profile)

  if (!isEffectivelyEmpty(targetDir)) {
    throw new Error(
      `目标 profile ${JSON.stringify(profile)}（${targetDir}）非空——v1 只恢复到空 profile。`
      + `换一个名字（--profile <新名字>）即可规避冲突`,
    )
  }

  // ---- Plan (dry-run returns it before ANY write) ----
  const packageJson = JSON.parse(requiredSnapshotFile(snapshotProfileDir, 'package.json')) as Record<string, unknown>
  const deps = (packageJson.dependencies ?? {}) as Record<string, string>
  const hasLockfile = existsSync(join(snapshotProfileDir, 'pnpm-lock.yaml'))
  const homePlan = manifest.home.included && options.withHome
  const homeTarget = join(home, HOME_PATCH_FILENAME)
  const homeExists = homePlan && existsSync(homeTarget)
  if (homePlan && homeExists && !options.force) {
    throw new Error(`目标机器已有机器级配置 ${homeTarget}；用 --force 覆盖（会自动备份为 .bak-<时间戳>）或去掉 --with-home`)
  }

  const plan: string[] = [
    `恢复计划: profile ${profile} → ${targetDir}`,
    `  安装 ${Object.keys(deps).length} 个依赖${hasLockfile ? '（pnpm install --frozen-lockfile，精确版本）' : '（快照无 lockfile，安装最新兼容版本）'}`,
    ...Object.entries(deps).map(([dep, spec]) => `    - ${dep} ${spec}`),
    `  写入文件: package.json, pnpm-workspace.yaml, cordis.patch.yml${hasLockfile ? ', pnpm-lock.yaml' : ''}`,
    `  机器级配置: ${homePlan ? (homeExists ? '覆盖现有（先备份）' : '写入') : '不写入'}`,
    `  脱敏补填处数: ${entry.redactions.length + (homePlan ? manifest.home.redactions.length : 0)}`,
  ]
  if (options.dryRun) {
    return {
      manifest, profile, targetDir, plan, homeWritten: false, installed: false,
      verification: { status: 'skipped', reason: 'dry-run' },
      warnings, redactionCount: entry.redactions.length,
    }
  }

  // ---- Stage ----
  const existedBefore = existsSync(targetDir)
  mkdirSync(targetDir, { recursive: true })
  const staged: string[] = []
  const stageFile = (filename: string, content: string): void => {
    const path = join(targetDir, filename)
    writeFileSync(path, content)
    staged.push(path)
  }
  const rollback = (): void => {
    for (const path of staged) {
      try { rmSync(path, { force: true }) } catch { /* best-effort */ }
    }
    if (!existedBefore) {
      try { rmSync(targetDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  }

  try {
    stageFile('package.json', readFileSync(join(snapshotProfileDir, 'package.json'), 'utf8'))
    stageFile('pnpm-workspace.yaml', readFileSync(join(snapshotProfileDir, 'pnpm-workspace.yaml'), 'utf8'))
    stageFile(PATCH_FILENAME, readFileSync(join(snapshotProfileDir, PATCH_FILENAME), 'utf8'))
    if (hasLockfile) stageFile('pnpm-lock.yaml', readFileSync(join(snapshotProfileDir, 'pnpm-lock.yaml'), 'utf8'))
  } catch (error) {
    rollback()
    throw error
  }

  // ---- Install ----
  const installArgs = hasLockfile ? ['install', '--frozen-lockfile'] : ['install']
  const install = (options.pnpmRunner ?? runPnpm)(installArgs, { cwd: targetDir, capture: true })
  if (!install.ok) {
    rollback()
    const hint = blockedBuilds(install) ? '\npnpm 拦截了依赖的构建脚本——按 pnpm 输出中的包名，在 pnpm-workspace.yaml 的 allowBuilds 下放行后重试' : ''
    throw new Error(
      `pnpm install 失败（退出码 ${install.exitCode ?? 'unknown'}），已回滚恢复操作${hint}\n--- pnpm 输出 ---\n${install.stderr || install.stdout}`,
    )
  }
  if (blockedBuilds(install)) {
    warnings.push('pnpm 警告：部分依赖的构建脚本被拦截（IGNORED_BUILDS）——如需构建（如 git 插件的 prepare），'
      + `在 ${targetDir} 的 pnpm-workspace.yaml 的 allowBuilds 下放行后重跑 pnpm install`)
  }

  // ---- Repair link/file deps: lockfile-relative junctions break under a new home ----
  repairLinkedDeps(targetDir, deps, warnings)

  // ---- Bundle sanity: dependency-owned bundles must resolve with a patch ----
  for (const bundle of entry.bundles) {
    if (deps[bundle] === undefined) {
      warnings.push(`${bundle} 不在 dependencies 中（模板/安装自带 bundle）——由目标 DSH 安装提供，恢复后校验会确认`)
      continue
    }
    const manifestPath = join(targetDir, 'node_modules', ...bundle.split('/'), 'package.json')
    if (!existsSync(manifestPath)) {
      warnings.push(`${bundle} 在快照中是 bundle，但目标 node_modules 中解析不到——安装或 hoisting 异常，恢复后校验会确认`)
      continue
    }
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { bundle?: { patch?: unknown } } }
      if (parsed.dsh?.bundle?.patch === undefined) {
        warnings.push(`${bundle} 目标版本不再声明 dsh.bundle——不会被加入层级栈（版本漂移）`)
      }
    } catch {
      warnings.push(`${bundle} 的 package.json 无法解析`)
    }
  }

  // ---- Home layer ----
  let homeWritten = false
  let homeBackedUpTo: string | undefined
  if (homePlan) {
    if (homeExists) {
      homeBackedUpTo = `${homeTarget}.bak-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '')}`
      renameSync(homeTarget, homeBackedUpTo)
    }
    mkdirSync(home, { recursive: true })
    writeFileSync(homeTarget, readFileSync(join(options.snapshotDir, 'home', HOME_PATCH_FILENAME), 'utf8'))
    homeWritten = true
  }

  // ---- Verify ----
  const verificationResult = verifyRestore(snapshotProfileDir, profile, probe)
  let verification: VerifyReportKind
  if (verificationResult.dumpFailed) {
    verification = { status: 'skipped', reason: `dump-config 失败: ${verificationResult.stderr.slice(0, 500)}` }
  } else if (verificationResult.noBaseline) {
    verification = { status: 'skipped', reason: '快照没有 composed-config.yml 基准（导出时无 dsh 命令），仅确认 dump-config 可运行' }
  } else if (verificationResult.verified) {
    verification = { status: 'verified' }
  } else {
    const compare = verificationResult.compare
    verification = {
      status: 'mismatch',
      detail: [
        `缺失行: ${compare?.missingIds.join(', ') || '无'}`,
        `多余行: ${compare?.extraIds.join(', ') || '无'}`,
        `禁用位不一致: ${compare?.disabledMismatches.map(item => `${item.id}(${item.expected}→${item.actual})`).join(', ') || '无'}`,
      ].join('\n'),
    }
  }

  return {
    manifest,
    profile,
    targetDir,
    plan,
    homeWritten,
    homeBackedUpTo,
    installed: true,
    installOutput: install.stdout,
    verification,
    warnings,
    redactionCount: entry.redactions.length + (homePlan ? manifest.home.redactions.length : 0),
  }
}
