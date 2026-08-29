/**
 * Conservative line-based secret redaction for patch YAML files.
 *
 * Line-based (not AST-based) on purpose: a full parse would drop comments,
 * `!!js` expressions, and ordering that must round-trip byte-faithfully, and
 * v1 only ever needs to blank string scalars. Redactions are located by
 * 1-based line for the same reason — no JSON pointers on a document we never
 * re-serialized.
 * @module dsh-config-migrator/core/redact
 */

export const REDACTED = '<REDACTED>'

export interface Redaction {
  line: number
  hint: string
}

export interface EnvReference {
  line: number
  variable: string
}

export interface RedactResult {
  text: string
  redactions: Redaction[]
  /** Values that reference environment variables — never redacted, always flagged. */
  envRefs: EnvReference[]
}

const SENSITIVE_WORDS = new Set(['key', 'token', 'secret', 'password', 'credential', 'authorization', 'passwd'])

/**
 * A config key that names a secret (camelCase/snake_case/kebab aware).
 * "monkey" merely ends in "key" and must NOT match: the sensitive word needs
 * a real boundary — standalone, a kebab/snake segment, or a camelCase edge.
 */
function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_WORDS.has(key.toLowerCase())) return true
  if (key.includes('_') || key.includes('-')) {
    const segment = key.split(/[_-]/).pop() ?? ''
    if (SENSITIVE_WORDS.has(segment.toLowerCase())) return true
  }
  for (const word of SENSITIVE_WORDS) {
    const tail = word.charAt(0).toUpperCase() + word.slice(1)
    const tailIndex = key.length - tail.length
    if (tailIndex > 0 && key.endsWith(tail) && /[a-z0-9]/.test(key.charAt(tailIndex - 1))) return true
    if (key.length > word.length && key.startsWith(word) && /[A-Z]/.test(key.charAt(word.length))) return true
  }
  return false
}

/** Value shapes that look like secrets regardless of the key name. */
const SHAPE_PATTERNS: RegExp[] = [
  /^sk-[A-Za-z0-9_-]+$/,
  /^gh[pousr]_[A-Za-z0-9]+$/,
  /^github_pat_[A-Za-z0-9_]+$/,
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  /^[A-Za-z0-9+/]{40,}={0,2}$/,
  /^[A-Fa-f0-9]{32,}$/,
]

function looksLikeSecret(value: string): boolean {
  return SHAPE_PATTERNS.some(pattern => pattern.test(value))
}

/** YAML block-scalar indicators must never be touched. */
const BLOCK_SCALARS = new Set(['|', '>', '|-', '>-', '|+', '>+'])

/**
 * Redact one line: sensitive-named values first, then secret-shaped values.
 * Spans are applied right-to-left so earlier replacements never shift later
 * indexes. Comment lines and `!!js`-expression values are left alone; values
 * that reference environment variables (`$NAME` / `${NAME}`) are reported,
 * not redacted.
 */
function redactLine(raw: string, lineNumber: number, state: { redactions: Redaction[]; envRefs: EnvReference[] }): string {
  const trimmed = raw.trimStart()
  if (trimmed === '' || trimmed.startsWith('#')) return raw

  const spans: Array<{ start: number; end: number; replacement: string }> = []

  // 1. Sensitive-named mapping keys: `key: value` with an optional quote pair.
  const keyPattern = /[A-Za-z_][\w.-]*(?=\s*:)/g
  for (const match of raw.matchAll(keyPattern)) {
    const key = match[0]
    if (!isSensitiveKey(key)) continue
    const afterKey = raw.slice(match.index + key.length)
    const colon = /^\s*:/.exec(afterKey)
    if (colon === null) continue
    const rest = afterKey.slice(colon[0].length)
    let valueStart = colon[0].length + match.index + key.length
    let valueEnd = -1
    let quote: string | undefined
    const space = /^\s*/.exec(rest)
    if (space !== null) valueStart += space[0].length
    const head = raw[valueStart]
    if (head === '"' || head === "'") {
      quote = head
      const closing = raw.indexOf(head, valueStart + 1)
      // The span covers both quotes so the replacement round-trips exactly.
      if (closing !== -1) valueEnd = closing + 1
    } else {
      const valueMatch = /^[^\s,#]+/.exec(raw.slice(valueStart))
      if (valueMatch !== null) valueEnd = valueStart + valueMatch[0].length
    }
    if (valueEnd === -1) continue
    const value = raw.slice(valueStart, valueEnd)
    const inner = quote === undefined ? value : value.slice(1, -1)
    if (inner === '' || BLOCK_SCALARS.has(inner)) continue
    if (inner.startsWith('$')) {
      state.envRefs.push({ line: lineNumber, variable: inner })
      continue
    }
    spans.push({
      start: valueStart,
      end: valueEnd,
      replacement: quote === undefined ? REDACTED : `${quote}${REDACTED}${quote}`,
    })
    state.redactions.push({ line: lineNumber, hint: key })
  }

  // 2. Secret-shaped values anywhere after a colon, applied to the already
  //    key-redacted line so nothing is double-counted.
  const working = applySpans(raw, spans)
  const shapePattern = /(?<colon>:\s*)(?<quote>"|')?(?<value>sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9+/]{40,}={0,2}|[A-Fa-f0-9]{32,})(?<close>"|')?/g
  const shapeSpans: Array<{ start: number; end: number; replacement: string }> = []
  for (const match of working.matchAll(shapePattern)) {
    const groups = match.groups as { colon: string; quote?: string; value: string; close?: string }
    if (groups.value === REDACTED || groups.value.startsWith('$')) continue
    if (groups.quote !== undefined && groups.close === undefined) continue
    shapeSpans.push({
      start: (match.index ?? 0) + groups.colon.length,
      end: (match.index ?? 0) + groups.colon.length + (groups.quote !== undefined ? 1 : 0) + groups.value.length + (groups.close !== undefined ? 1 : 0),
      replacement: groups.quote !== undefined ? `${groups.quote}${REDACTED}${groups.quote}` : REDACTED,
    })
  }
  for (const span of shapeSpans) {
    state.redactions.push({ line: lineNumber, hint: '疑似密钥值（形态特征）' })
  }

  return applySpans(working, shapeSpans)
}

function applySpans(text: string, spans: Array<{ start: number; end: number; replacement: string }>): string {
  if (spans.length === 0) return text
  const sorted = [...spans].sort((a, b) => b.start - a.start)
  let result = text
  for (const span of sorted) {
    result = result.slice(0, span.start) + span.replacement + result.slice(span.end)
  }
  return result
}

/** A `key: |` / `key: >` line opens a multi-line block scalar. */
const BLOCK_START = /^(\s*)[A-Za-z_][\w.-]*\s*:\s*[|>][+-]?\s*(?:#.*)?$/

/**
 * Redact a whole patch file, preserving everything except secret values.
 * Lines inside YAML block scalars (`key: |` bodies) are content, not mapping
 * entries, and are passed through untouched.
 * @returns the redacted text plus redaction locations and env-var references.
 */
export function redactPatch(text: string): RedactResult {
  const redactions: Redaction[] = []
  const envRefs: EnvReference[] = []
  const state = { redactions, envRefs }
  const lines = text.split('\n')
  const out: string[] = []
  let blockIndent: number | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (blockIndent !== null) {
      const indent = /^\s*/.exec(line)?.[0].length ?? 0
      if (line.trim() === '' || indent > blockIndent) {
        out.push(line)
        continue
      }
      blockIndent = null
    }
    const block = BLOCK_START.exec(line)
    if (block !== null) blockIndent = block[1]!.length
    out.push(redactLine(line, index + 1, state))
  }
  return { text: out.join('\n'), redactions, envRefs }
}
