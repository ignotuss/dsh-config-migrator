import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareComposed, digestComposed } from '../src/core/verify'

const SAMPLE = [
  '# == bundle',
  '- id: a',
  "  name: '@x/a'",
  '- id: b',
  '  config:',
  '    token: <REDACTED>',
  '  disabled: true',
  '- id: c',
  "  name: '@x/c'",
  '',
].join('\n')

describe('digestComposed', () => {
  it('extracts row ids and disabled bits', () => {
    const rows = digestComposed(SAMPLE)
    assert.deepEqual(rows, [
      { id: 'a', disabled: false },
      { id: 'b', disabled: true },
      { id: 'c', disabled: false },
    ])
  })

  it('ignores comments and blank lines', () => {
    assert.deepEqual(digestComposed('# only\n\n- id: x\n  name: pkg\n'), [{ id: 'x', disabled: false }])
  })
})

describe('compareComposed', () => {
  it('reports a clean match', () => {
    const result = compareComposed(SAMPLE, SAMPLE)
    assert.equal(result.ok, true)
    assert.deepEqual(result.missingIds, [])
    assert.deepEqual(result.extraIds, [])
  })

  it('reports missing, extra, and disabled mismatches', () => {
    const actual = [
      '- id: a',
      '- id: b',
      '  disabled: false',
      '- id: extra',
      '',
    ].join('\n')
    const result = compareComposed(SAMPLE, actual)
    assert.equal(result.ok, false)
    assert.deepEqual(result.missingIds, ['c'])
    assert.deepEqual(result.extraIds, ['extra'])
    assert.deepEqual(result.disabledMismatches, [{ id: 'b', expected: true, actual: false }])
  })

  it('ignores value differences (REDACTED placeholders allowed)', () => {
    const variant = SAMPLE.replace('token: <REDACTED>', 'token: sk-real-value')
    assert.equal(compareComposed(SAMPLE, variant).ok, true)
  })
})
