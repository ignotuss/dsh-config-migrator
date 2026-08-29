/**
 * Post-restore verification: run the boot-free `dsh --dump-config` on the
 * target profile and compare its row structure against the snapshot's
 * composed-config.yml baseline. Values are deliberately ignored (they may
 * legitimately hold `<REDACTED>` placeholders); the comparison is id set +
 * disabled bits — the parts a file-level restore can actually regress.
 * @module dsh-config-migrator/core/verify
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnDumpConfig, type DshProbe } from './pack'

export interface RowDigest {
  id: string
  disabled: boolean
}

export interface CompareResult {
  ok: boolean
  missingIds: string[]
  extraIds: string[]
  disabledMismatches: Array<{ id: string; expected: boolean; actual: boolean }>
}

/**
 * Digest a composed-config dump into row ids + disabled bits. The dump is a
 * YAML list of `- id: ...` blocks; a light line scan is enough because we
 * never re-serialize it.
 */
export function digestComposed(text: string): RowDigest[] {
  const rows: RowDigest[] = []
  let current: RowDigest | undefined
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || trimmed === '') continue
    const idMatch = /^- id:\s*(.+)$/.exec(trimmed)
    if (idMatch !== null) {
      current = { id: idMatch[1]!.trim(), disabled: false }
      rows.push(current)
      continue
    }
    if (current !== undefined && /^disabled:\s*true\b/.test(trimmed)) {
      current.disabled = true
    }
  }
  return rows
}

/** Compare two composed dumps by id set and disabled bits. */
export function compareComposed(expectedText: string, actualText: string): CompareResult {
  const expected = new Map(digestComposed(expectedText).map(row => [row.id, row.disabled]))
  const actual = new Map(digestComposed(actualText).map(row => [row.id, row.disabled]))
  const missingIds: string[] = []
  const disabledMismatches: Array<{ id: string; expected: boolean; actual: boolean }> = []
  for (const [id, disabled] of expected) {
    const actualDisabled = actual.get(id)
    if (actualDisabled === undefined) missingIds.push(id)
    else if (actualDisabled !== disabled) disabledMismatches.push({ id, expected: disabled, actual: actualDisabled })
  }
  const extraIds = [...actual.keys()].filter(id => !expected.has(id))
  return { ok: missingIds.length === 0 && disabledMismatches.length === 0, missingIds, extraIds, disabledMismatches }
}

export interface VerifyReport {
  /** Probe ran and matched the baseline. */
  verified: boolean
  /** Probe ran but the dump could not be produced. */
  dumpFailed: boolean
  /** No baseline in the snapshot (export had no dsh available). */
  noBaseline: boolean
  compare: CompareResult | undefined
  stderr: string
}

/**
 * Verify a restored profile against the snapshot's composed-config.yml.
 * @param snapshotProfileDir - `profiles/<name>` inside the snapshot.
 * @param targetProfile - the restored profile name on this machine.
 * @param probe - dump-config probe (default: spawn `dsh`).
 */
export function verifyRestore(
  snapshotProfileDir: string,
  targetProfile: string,
  probe: DshProbe = spawnDumpConfig,
): VerifyReport {
  const baselinePath = join(snapshotProfileDir, 'composed-config.yml')
  let baseline: string | undefined
  try {
    baseline = readFileSync(baselinePath, 'utf8')
  } catch {
    baseline = undefined
  }
  const result = probe(targetProfile)
  if (!result.ok) {
    return { verified: false, dumpFailed: true, noBaseline: baseline === undefined, compare: undefined, stderr: result.stderr }
  }
  if (baseline === undefined) {
    return { verified: false, dumpFailed: false, noBaseline: true, compare: undefined, stderr: '' }
  }
  const compare = compareComposed(baseline, result.stdout)
  return { verified: compare.ok, dumpFailed: false, noBaseline: false, compare, stderr: '' }
}
