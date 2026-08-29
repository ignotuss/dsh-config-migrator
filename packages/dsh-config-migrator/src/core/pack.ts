/**
 * Snapshot export: read a profile directory (or every profile) plus the
 * machine-level home layer, copy the declarative truth files byte-faithfully,
 * redact secrets, analyze portability, and write the manifest + report.
 *
 * The engine never boots a cordis tree: everything a snapshot needs is file
 * state under $DSH_HOME (see DESIGN.md §3).
 * @module dsh-config-migrator/core/pack
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dshHomeDisplay, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { PROFILE_TEMPLATES, resolveProfileDir, type ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import {
  countPatchEntries,
  TOOL_NAME,
  TOOL_VERSION,
  writeManifest,
  type Manifest,
  type ManifestProfile,
  type ManifestWarning,
} from './manifest'
import { redactPatch } from './redact'

/** Profile files a snapshot carries verbatim. */
const PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']
const HOME_PATCH_FILENAME = 'cordis.patch.yml'
const PATCH_FILENAME = 'cordis.patch.yml'
/** The dump-config reference a restore diffs against. */
const COMPOSED_FILENAME = 'composed-config.yml'

export interface ExportOptions {
  /** `true` = every profile under $DSH_HOME/profiles; else `profiles` names. */
  all: boolean
  profiles: string[]
  /** Output parent directory (the snapshot dir is created inside it). */
  outDir: string
  /** Disable redaction (CLI --no-redact, with a loud warning). */
  noRedact: boolean
  /** Include the machine-level home patch layer. Defaults to true. */
  includeHome: boolean
}

export interface ExportResult {
  snapshotDir: string
  manifest: Manifest
  warnings: ManifestWarning[]
}

/**
 * Resolve a `link:`/`file:` dependency spec to an absolute directory on this
 * machine (mirror of the restore-side helper; kept local so pack stays
 * self-contained). Relative specs resolve against the profile directory.
 */
export function resolveLinkedDir(spec: string, profileDir: string): string {
  let target = spec.trim()
  target = target.replace(/^(?:link|file):/, '')
  target = target.replace(/^file:\/\/\/([A-Za-z]:\/.*)$/i, '$1')
  target = target.replace(/^([A-Za-z]):\/\//, '$1:/')
  if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(target)) target = target.slice(1)
  return resolve(profileDir, target)
}

export interface DshProbe {
  (profile: string): { ok: boolean; stdout: string; stderr: string }
}

/** Absolute dsh entry override: `DSH_MIGRATE_DSH` (a JS bin to run with node). */
function dshInvocation(args: string): { command: string; shell: boolean } {
  const override = process.env.DSH_MIGRATE_DSH
  if (override !== undefined && override.trim() !== '') {
    return { command: `node ${JSON.stringify(override)} ${args}`, shell: process.platform === 'win32' }
  }
  return { command: `dsh ${args}`, shell: process.platform === 'win32' }
}

/**
 * Default probe: run `dsh --profile <name> --dump-config` (boot-free) to
 * capture the composed effective config as the restore verification baseline.
 * Injectable so tests and the GUI path can substitute their own. The command
 * is a single string because spawnSync forbids argument arrays under
 * `shell: true` (DEP0190); profile names are validated upstream.
 */
export function spawnDumpConfig(profile: string): { ok: boolean; stdout: string; stderr: string } {
  const { command, shell } = dshInvocation(`--profile ${JSON.stringify(profile)} --dump-config`)
  const result = spawnSync(command, { encoding: 'utf8', shell })
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Best-effort dsh version for the manifest source record. */
function probeDshVersion(): string {
  const { command, shell } = dshInvocation('--version')
  const result = spawnSync(command, { encoding: 'utf8', shell })
  const line = (result.stdout ?? '').trim()
  return result.status === 0 && line !== '' ? line : 'unknown'
}

/** Flag config values that embed absolute machine paths. */
function scanAbsolutePaths(profile: string | undefined, snapshotFile: string, content: string): ManifestWarning[] {
  const warnings: ManifestWarning[] = []
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trimStart().startsWith('#')) continue
    if (/[A-Za-z]:[\\/]/.test(line) || /(?:^|[^A-Za-z])\/(?:Users|home|var|etc|opt|usr)\//.test(line)) {
      warnings.push({
        kind: 'absolute-path',
        profile,
        file: snapshotFile,
        message: `第 ${index + 1} 行疑似包含绝对路径，换机器后需核对`,
      })
    }
  }
  return warnings
}

/**
 * Analyze one profile directory, write its truth files (redacted) into the
 * snapshot, and return its manifest entry.
 */
function packProfile(
  home: string,
  name: string,
  options: ExportOptions,
  probe: DshProbe,
  snapshotProfilesDir: string,
): { entry: ManifestProfile; warnings: ManifestWarning[] } {
  const dir = resolveProfileDir(name, home)
  if (!existsSync(join(dir, 'package.json'))) {
    throw new Error(`profile ${JSON.stringify(name)} does not exist at ${dir}`)
  }
  const targetDir = join(snapshotProfilesDir, name)
  mkdirSync(targetDir, { recursive: true })

  const warnings: ManifestWarning[] = []
  const redactions: ManifestProfile['redactions'] = []
  const bundles: string[] = []
  const dependencies: Record<string, string> = {}
  let patchEntryCount = 0

  for (const filename of PROFILE_FILES) {
    const path = join(dir, filename)
    if (!existsSync(path)) continue
    const content = readFileSync(path, 'utf8')
    const snapshotFile = `profiles/${name}/${filename}`

    if (filename === 'package.json') {
      let parsed: ProfileManifest
      try {
        parsed = JSON.parse(content) as ProfileManifest
      } catch {
        throw new Error(`profile ${name}: package.json is not valid JSON`)
      }
      bundles.push(...(parsed.dsh?.profile?.bundles ?? []))
      for (const [dep, spec] of Object.entries(parsed.dependencies ?? {})) {
        if (typeof spec === 'string') dependencies[dep] = spec
      }
      writeFileSync(join(targetDir, filename), content)
      continue
    }

    if (filename === PATCH_FILENAME) {
      patchEntryCount = countPatchEntries(content)
      if (options.noRedact) {
        writeFileSync(join(targetDir, filename), content)
      } else {
        const result = redactPatch(content)
        writeFileSync(join(targetDir, filename), result.text)
        redactions.push(...result.redactions.map(item => ({ file: snapshotFile, line: item.line, hint: item.hint })))
        for (const ref of result.envRefs) {
          warnings.push({
            kind: 'env-reference',
            profile: name,
            file: snapshotFile,
            message: `第 ${ref.line} 行引用了环境变量 ${ref.variable}——快照不包含环境变量，恢复后需在目标机器自行配置`,
          })
        }
      }
    } else {
      writeFileSync(join(targetDir, filename), content)
    }

    // pnpm-lock.yaml legitimately embeds machine paths for link/file deps
    // (the non-registry-dependency warning covers that signal); only the
    // hand-written config files get the absolute-path scan.
    if (filename !== 'pnpm-lock.yaml') {
      warnings.push(...scanAbsolutePaths(name, snapshotFile, content))
    }
  }

  for (const [dep, spec] of Object.entries(dependencies)) {
    if (!/^(?:file|link|workspace):/.test(spec)) continue
    warnings.push({
      kind: 'non-registry-dependency',
      profile: name,
      message: `依赖 ${dep} 使用 ${spec} spec，指向导出机器的本地路径，恢复时需人工处理`,
    })
    if (/^(?:file|link):/.test(spec)) {
      const target = resolveLinkedDir(spec, dir)
      if (!existsSync(target)) {
        warnings.push({
          kind: 'stale-link-target',
          profile: name,
          message: `依赖 ${dep} 的本地目标 ${target} 在导出机器上已不存在——该链接在源机与目标机上都无法解析，请先恢复该目录或改用 registry 版本`,
        })
      }
    }
  }
  for (const bundle of PROFILE_TEMPLATES[name] ?? []) {
    if (bundles.includes(bundle)) {
      warnings.push({
        kind: 'template-bundle',
        profile: name,
        message: `${bundle} 是模板自带 bundle，不由快照安装——目标 DSH 安装必须能提供它`,
      })
    }
  }

  // Composed-config capture (best-effort, boot-free). Redactions in it get
  // their own file path — the composed dump is a snapshot artifact, not the
  // patch itself.
  let composedAvailable = false
  const composed = probe(name)
  if (composed.ok) {
    const snapshotFile = `profiles/${name}/${COMPOSED_FILENAME}`
    if (options.noRedact) {
      writeFileSync(join(targetDir, COMPOSED_FILENAME), composed.stdout)
    } else {
      const result = redactPatch(composed.stdout)
      writeFileSync(join(targetDir, COMPOSED_FILENAME), result.text)
      redactions.push(...result.redactions.map(item => ({ file: snapshotFile, line: item.line, hint: item.hint })))
    }
    composedAvailable = true
  }

  return {
    entry: { bundles, dependencies, patchEntryCount, composedAvailable, redactions },
    warnings,
  }
}

/** Home layer: always travels with the snapshot; redaction applies equally. */
function packHome(
  home: string,
  options: ExportOptions,
  snapshotHomeDir: string,
): { entry: Manifest['home']; warnings: ManifestWarning[] } {
  const path = join(home, HOME_PATCH_FILENAME)
  if (!existsSync(path)) return { entry: { included: false, patchEntryCount: 0, redactions: [] }, warnings: [] }
  const content = readFileSync(path, 'utf8')
  mkdirSync(snapshotHomeDir, { recursive: true })
  const snapshotFile = `home/${HOME_PATCH_FILENAME}`
  const warnings: ManifestWarning[] = []
  const redactions: Manifest['home']['redactions'] = []
  if (options.noRedact) {
    writeFileSync(join(snapshotHomeDir, HOME_PATCH_FILENAME), content)
  } else {
    const result = redactPatch(content)
    writeFileSync(join(snapshotHomeDir, HOME_PATCH_FILENAME), result.text)
    redactions.push(...result.redactions.map(item => ({ file: snapshotFile, line: item.line, hint: item.hint })))
    for (const ref of result.envRefs) {
      warnings.push({
        kind: 'env-reference',
        file: snapshotFile,
        message: `第 ${ref.line} 行引用了环境变量 ${ref.variable}——快照不包含环境变量，恢复后需在目标机器自行配置`,
      })
    }
  }
  warnings.push(...scanAbsolutePaths(undefined, snapshotFile, content))
  return { entry: { included: true, patchEntryCount: countPatchEntries(content), redactions }, warnings }
}

/** Profile names under $DSH_HOME/profiles (directories with a manifest). */
function listProfiles(home: string): string[] {
  const dir = join(home, 'profiles')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name !== 'node_modules')
    .filter(name => statSync(join(dir, name)).isDirectory())
    .filter(name => existsSync(join(dir, name, 'package.json')))
    .sort()
}

/**
 * Export one or every profile into a new snapshot directory under outDir.
 */
export function exportSnapshot(options: ExportOptions, probe: DshProbe = spawnDumpConfig): ExportResult {
  const home = resolveDshHome()
  const warnings: ManifestWarning[] = []

  const profileNames = options.all ? listProfiles(home) : options.profiles
  if (profileNames.length === 0) {
    throw new Error('no profiles to export: pass --profile <name> or --all')
  }

  const scope = options.all ? 'all' : profileNames.join('+')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '')
  const snapshotDir = join(options.outDir, `dsh-migrate-${scope}-${stamp}`)
  mkdirSync(snapshotDir, { recursive: true })

  const profiles: Record<string, ManifestProfile> = {}
  const profilesDir = join(snapshotDir, 'profiles')
  for (const name of profileNames) {
    const result = packProfile(home, name, options, probe, profilesDir)
    profiles[name] = result.entry
    warnings.push(...result.warnings)
  }
  const homeResult = options.includeHome ? packHome(home, options, join(snapshotDir, 'home')) : undefined
  if (homeResult !== undefined) warnings.push(...homeResult.warnings)

  const manifest: Manifest = {
    schemaVersion: 1,
    tool: TOOL_NAME,
    toolVersion: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    source: { dshVersion: probeDshVersion(), platform: process.platform, homeLabel: dshHomeDisplay(home) },
    profiles,
    home: homeResult?.entry ?? { included: false, patchEntryCount: 0, redactions: [] },
    warnings,
  }
  writeManifest(snapshotDir, manifest)
  return { snapshotDir, manifest, warnings }
}
