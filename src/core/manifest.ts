/**
 * Snapshot manifest: schema, validation, and disk I/O. The manifest is the
 * machine truth a restore reads; requirement.md is only the human report.
 * @module dsh-config-migrator/core/manifest
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MANIFEST_FILENAME = 'manifest.json'
export const SCHEMA_VERSION = 1
export const TOOL_NAME = 'dsh-config-migrator'
export const TOOL_VERSION = '0.1.0'

/** One redacted secret, located by file + 1-based line inside the snapshot. */
export interface ManifestRedaction {
  file: string
  line: number
  hint: string
}

export interface ManifestWarning {
  kind: 'absolute-path' | 'non-registry-dependency' | 'template-bundle' | 'env-reference' | string
  profile?: string
  file?: string
  message: string
}

export interface ManifestProfile {
  /** Layer stack order from `dsh.profile.bundles`. */
  bundles: string[]
  /** Installed plugin packages from `dependencies`. */
  dependencies: Record<string, string>
  /** Top-level patch row count of this profile's cordis.patch.yml. */
  patchEntryCount: number
  /** Whether `dsh --dump-config` was captured as composed-config.yml. */
  composedAvailable: boolean
  redactions: ManifestRedaction[]
}

export interface ManifestHome {
  included: boolean
  patchEntryCount: number
  redactions: ManifestRedaction[]
}

export interface Manifest {
  schemaVersion: typeof SCHEMA_VERSION
  tool: typeof TOOL_NAME
  toolVersion: string
  createdAt: string
  source: {
    /** Best-effort; `unknown` when the dsh binary could not be asked. */
    dshVersion: string
    platform: string
    /** Symbolic label only (e.g. `~/.dsh` or `$DSH_HOME`) — never an absolute machine path. */
    homeLabel: string
  }
  profiles: Record<string, ManifestProfile>
  home: ManifestHome
  warnings: ManifestWarning[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(path: string, message: string): never {
  throw new Error(`invalid manifest${path}: ${message}`)
}

function expectString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key]
  if (typeof value !== 'string') fail(path, `"${key}" must be a string`)
  return value
}

function expectRecord(record: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const value = record[key]
  if (!isRecord(value)) fail(path, `"${key}" must be an object`)
  return value
}

function expectStringArray(record: Record<string, unknown>, key: string, path: string): string[] {
  const value = record[key]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    fail(path, `"${key}" must be a string array`)
  }
  return value as string[]
}

function expectRedactions(record: Record<string, unknown>, key: string, path: string): ManifestRedaction[] {
  const value = record[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(path, `"${key}" must be an array`)
  return value.map((item, index) => {
    if (!isRecord(item)) fail(`${path}.${key}[${index}]`, 'must be an object')
    return {
      file: expectString(item, 'file', `${path}.${key}[${index}]`),
      line: typeof item.line === 'number' && Number.isInteger(item.line)
        ? item.line
        : fail(`${path}.${key}[${index}]`, '"line" must be an integer'),
      hint: expectString(item, 'hint', `${path}.${key}[${index}]`),
    }
  })
}

function expectWarnings(record: Record<string, unknown>): ManifestWarning[] {
  const value = record.warnings
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('.warnings', 'must be an array')
  return value.map((item, index) => {
    if (!isRecord(item)) fail(`.warnings[${index}]`, 'must be an object')
    return {
      kind: typeof item.kind === 'string' ? item.kind : fail(`.warnings[${index}]`, '"kind" must be a string'),
      profile: typeof item.profile === 'string' ? item.profile : undefined,
      file: typeof item.file === 'string' ? item.file : undefined,
      message: expectString(item, 'message', `.warnings[${index}]`),
    }
  })
}

/**
 * Validate an unknown JSON value as a v1 snapshot manifest, throwing on the
 * first structural problem. Restore must never proceed past this check.
 */
export function validateManifest(value: unknown): Manifest {
  if (!isRecord(value)) throw new Error('invalid manifest: root must be an object')
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`invalid manifest: unsupported schemaVersion ${JSON.stringify(value.schemaVersion)} (this build supports ${SCHEMA_VERSION})`)
  }
  if (value.tool !== TOOL_NAME) throw new Error(`invalid manifest: not a ${TOOL_NAME} snapshot`)
  const createdAt = expectString(value, 'createdAt', '')
  const source = expectRecord(value, 'source', '')
  const dshVersion = expectString(source, 'dshVersion', '.source')
  const platform = expectString(source, 'platform', '.source')
  const homeLabel = expectString(source, 'homeLabel', '.source')

  const profiles = expectRecord(value, 'profiles', '')
  const names = Object.keys(profiles)
  if (names.length === 0) fail('.profiles', 'must contain at least one profile')
  const resolvedProfiles: Record<string, ManifestProfile> = {}
  for (const name of names) {
    if (!isRecord(profiles[name])) fail(`.profiles.${name}`, 'must be an object')
    const entry = profiles[name] as Record<string, unknown>
    resolvedProfiles[name] = {
      bundles: expectStringArray(entry, 'bundles', `.profiles.${name}`),
      dependencies: expectRecord(entry, 'dependencies', `.profiles.${name}`) as Record<string, string>,
      patchEntryCount: typeof entry.patchEntryCount === 'number' && Number.isInteger(entry.patchEntryCount)
        ? entry.patchEntryCount
        : fail(`.profiles.${name}`, '"patchEntryCount" must be an integer'),
      composedAvailable: entry.composedAvailable === true,
      redactions: expectRedactions(entry, 'redactions', `.profiles.${name}`),
    }
  }

  const home = expectRecord(value, 'home', '')
  const resolvedHome: ManifestHome = {
    included: home.included === true,
    patchEntryCount: typeof home.patchEntryCount === 'number' && Number.isInteger(home.patchEntryCount)
      ? home.patchEntryCount
      : fail('.home', '"patchEntryCount" must be an integer'),
    redactions: expectRedactions(home, 'redactions', '.home'),
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_NAME,
    toolVersion: expectString(value, 'toolVersion', ''),
    createdAt,
    source: { dshVersion, platform, homeLabel },
    profiles: resolvedProfiles,
    home: resolvedHome,
    warnings: expectWarnings(value),
  }
}

/** Read and validate a snapshot's manifest.json. */
export function readManifest(snapshotDir: string): Manifest {
  const path = join(snapshotDir, MANIFEST_FILENAME)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new Error(`snapshot ${snapshotDir} has no ${MANIFEST_FILENAME}${code === 'ENOENT' ? '' : ` (${code})`}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`invalid manifest: ${path} is not valid JSON`)
  }
  return validateManifest(parsed)
}

/** Write a manifest.json into a snapshot directory (created if needed). */
export function writeManifest(snapshotDir: string, manifest: Manifest): void {
  writeFileSync(join(snapshotDir, MANIFEST_FILENAME), JSON.stringify(manifest, undefined, 2) + '\n')
}

/** Count top-level patch rows of a patch file by its raw text (v1 heuristic). */
export function countPatchEntries(text: string): number {
  let count = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || trimmed === '') continue
    if (line.startsWith('- ')) count += 1
  }
  return count
}
