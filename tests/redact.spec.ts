import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { REDACTED, redactPatch } from '../src/core/redact'

describe('redactPatch', () => {
  it('redacts sensitive-named values, quoted and unquoted', () => {
    const { text, redactions } = redactPatch([
      '- id: provider',
      '  config:',
      '    apiKey: sk-abc123',
      '    access_token: "tok-xyz"',
      '    model: deepseek-v4-pro',
      '',
    ].join('\n'))
    assert.equal(text, [
      '- id: provider',
      '  config:',
      `    apiKey: ${REDACTED}`,
      `    access_token: "${REDACTED}"`,
      '    model: deepseek-v4-pro',
      '',
    ].join('\n'))
    assert.equal(redactions.length, 2)
    assert.deepEqual(redactions[0]!, { line: 3, hint: 'apiKey' })
    assert.deepEqual(redactions[1]!, { line: 4, hint: 'access_token' })
  })

  it('redacts secret-shaped values regardless of key name', () => {
    const { text } = redactPatch([
      '- id: x',
      '  config:',
      '    tokenish: sk-proj-1234567890',
      '    opaque: A1b2C3d4E5f6A7b8C9d0E1f2A3b4C5d6E7f8A9b0',
      '',
    ].join('\n'))
    const lines = text.split('\n')
    assert.ok(lines[2]!.includes(REDACTED))
    assert.ok(lines[3]!.includes(REDACTED))
  })

  it('keeps camelCase prefix secrets and skips words that merely end in "key"', () => {
    const input = ['- id: x', '    secretKey: abc', '    monkey: banana', ''].join('\n')
    const { text, redactions } = redactPatch(input)
    assert.ok(text.includes(`secretKey: ${REDACTED}`))
    assert.ok(text.includes('monkey: banana'))
    assert.equal(redactions.length, 1)
  })

  it('reports env-var references instead of redacting them', () => {
    const { text, redactions, envRefs } = redactPatch('- id: x\n  config:\n    apiKey: $OPENAI_TOKEN\n    secret: ${GH_TOKEN}\n')
    assert.ok(text.includes('apiKey: $OPENAI_TOKEN'))
    assert.ok(text.includes('secret: ${GH_TOKEN}'))
    assert.equal(redactions.length, 0)
    assert.deepEqual(envRefs.map(item => item.variable), ['$OPENAI_TOKEN', '${GH_TOKEN}'])
  })

  it('never touches comments, !!js expressions, or block scalars', () => {
    const input = [
      '# token: sk-comment-only',
      '- id: x',
      '  config:',
      '    exp: !!js process.env.SESSION_KEY',
      '    script: |',
      '      token: not-a-real-secret',
      '',
    ].join('\n')
    const { text, redactions } = redactPatch(input)
    assert.equal(text, input)
    assert.equal(redactions.length, 0)
  })

  it('handles multiple redactions on one line without corrupting the rest', () => {
    const input = '- id: x\n  config:\n    flow: {apiKey: a, secret: b, keep: c}\n'
    const { text } = redactPatch(input)
    assert.ok(text.includes(`{apiKey: ${REDACTED}, secret: ${REDACTED}, keep: c}`))
  })

  it('is a no-op on plain patch rows', () => {
    const input = '- id: llm\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-pro\n'
    const { text, redactions } = redactPatch(input)
    assert.equal(text, input)
    assert.equal(redactions.length, 0)
  })
})
