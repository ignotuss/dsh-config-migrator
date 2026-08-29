import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { countPatchEntries, readManifest, validateManifest } from '../src/core/manifest'

describe('validateManifest', () => {
  const base = {
    schemaVersion: 1,
    tool: 'dsh-config-migrator',
    toolVersion: '0.1.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    source: { dshVersion: 'unknown', platform: 'win32', homeLabel: '~/.dsh' },
    profiles: {
      web: {
        bundles: ['@deepseek-ai/dsh-base'],
        dependencies: { 'dsh-config-migrator': '^0.1.0' },
        patchEntryCount: 2,
        composedAvailable: false,
        redactions: [],
      },
    },
    home: { included: true, patchEntryCount: 0, redactions: [] },
    warnings: [],
  }

  it('accepts a valid v1 manifest', () => {
    const manifest = validateManifest(base)
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.profiles.web!.bundles[0], '@deepseek-ai/dsh-base')
  })

  it('rejects unsupported schema versions', () => {
    assert.throws(() => validateManifest({ ...base, schemaVersion: 2 }), /unsupported schemaVersion/)
  })

  it('rejects a manifest from another tool', () => {
    assert.throws(() => validateManifest({ ...base, tool: 'other' }), /not a dsh-config-migrator snapshot/)
  })

  it('rejects an empty profiles object', () => {
    assert.throws(() => validateManifest({ ...base, profiles: {} }), /at least one profile/)
  })

  it('rejects malformed profile entries', () => {
    assert.throws(
      () => validateManifest({ ...base, profiles: { web: { bundles: 'nope' } } }),
      /"bundles" must be a string array/,
    )
  })
})

describe('countPatchEntries', () => {
  it('counts top-level rows and skips comments and blanks', () => {
    const text = ['# header', '- insert:', '    - id: a', '      name: pkg', '- id: b', '  disabled: true', ''].join('\n')
    assert.equal(countPatchEntries(text), 2)
  })
})

describe('readManifest', () => {
  const dirs: string[] = []
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a manifest through disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcm-manifest-'))
    dirs.push(dir)
    const manifest = {
      schemaVersion: 1,
      tool: 'dsh-config-migrator',
      toolVersion: '0.1.0',
      createdAt: new Date().toISOString(),
      source: { dshVersion: 'unknown', platform: 'win32', homeLabel: '~/.dsh' },
      profiles: {},
      home: { included: false, patchEntryCount: 0, redactions: [] },
      warnings: [],
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    // Empty profiles fails validation by design; a real snapshot always has one.
    assert.throws(() => readManifest(dir), /at least one profile/)
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        profiles: {
          web: { bundles: [], dependencies: {}, patchEntryCount: 0, composedAvailable: false, redactions: [] },
        },
      }),
    )
    const loaded = readManifest(dir)
    assert.equal(loaded.tool, 'dsh-config-migrator')
    assert.equal(loaded.profiles.web!.patchEntryCount, 0)
  })

  it('reports a missing manifest file clearly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcm-manifest-'))
    dirs.push(dir)
    assert.throws(() => readManifest(dir), /has no manifest\.json/)
  })
})
