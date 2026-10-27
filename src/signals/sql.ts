import type { ChangedFile } from '../git/types.js'
import type { SecurityFinding } from '../output/schema.js'

interface Token {
  /** Upper-case keyword or identifier, `;`, `(`, `)`, or `'` for a string literal. */
  word: string
  line: number
}

/**
 * Tokens of SQL text: comments (`--`, nested `/* *\/`), string literals and quoted identifiers (`"…"`, `[…]`) never
 * produce keywords, so `-- DROP TABLE x` or `'DELETE'` is not a statement.
 */
export function sqlTokens(text: string): Token[] {
  const tokens: Token[] = []
  let line = 1
  let i = 0
  while (i < text.length) {
    const c = text[i] ?? ''
    if (c === '\n') { line++; i++; continue }
    if (/\s/.test(c)) { i++; continue }
    if (text.startsWith('--', i)) {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (text.startsWith('/*', i)) {
      let depth = 0
      while (i < text.length) {
        if (text.startsWith('/*', i)) { depth++; i += 2; continue }
        if (text.startsWith('*/', i)) { depth--; i += 2; if (depth === 0) break; continue }
        if (text[i] === '\n') line++
        i++
      }
      continue
    }
    if (c === "'" || c === '"' || c === '[' || c === '`') {
      const close = c === '[' ? ']' : c
      const at = line
      i++
      while (i < text.length) {
        if (text[i] === '\n') line++
        if (text[i] === close) {
          if (text[i + 1] === close) { i += 2; continue }
          break
        }
        i++
      }
      i++
      tokens.push({ word: c === "'" ? "'" : 'ID', line: at })
      continue
    }
    const word = /^[A-Za-z_@#][\w@#$.]*/.exec(text.slice(i, i + 200))?.[0]
    if (word !== undefined) { tokens.push({ word: word.toUpperCase(), line }); i += word.length; continue }
    if (c === ';' || c === '(' || c === ')') tokens.push({ word: c, line })
    i++
  }
  return tokens
}

/** Statements, split on `;` and on the `GO` batch separator. */
function statements(tokens: readonly Token[]): Token[][] {
  const out: Token[][] = [[]]
  for (const t of tokens) {
    if (t.word === ';' || t.word === 'GO') out.push([])
    else out[out.length - 1]?.push(t)
  }
  return out.filter((s) => s.length > 0)
}

const VERBS = new Set(['DROP', 'TRUNCATE', 'DELETE', 'UPDATE', 'ALTER', 'EXEC', 'EXECUTE', 'SP_RENAME'])
const DML = new Set(['INSERT', 'SELECT', 'MERGE', 'CREATE'])
const DROP_HIGH = new Set(['TABLE', 'DATABASE', 'SCHEMA'])

/** What a statement destroys or rewrites, judged on its words outside parentheses (CTEs, subqueries). */
function destructive(statement: readonly Token[]): { severity: 'high' | 'medium'; message: string } | null {
  let depth = 0
  const top: string[] = []
  for (const t of statement) {
    if (t.word === '(') depth++
    else if (t.word === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) top.push(t.word)
  }
  const start = top.findIndex((w) => VERBS.has(w) || DML.has(w))
  const verb = top[start]
  if (verb === undefined || DML.has(verb)) return null
  const next = top[start + 1] ?? ''
  const has = (w: string): boolean => top.includes(w)
  if (verb === 'DROP') return DROP_HIGH.has(next) ? { severity: 'high', message: `DROP ${next} removes it and its data` } : { severity: 'medium', message: `DROP ${next} removes a database object` }
  if (verb === 'TRUNCATE') return { severity: 'high', message: 'TRUNCATE removes every row' }
  if (verb === 'DELETE' && !has('WHERE')) return { severity: 'high', message: 'DELETE without WHERE removes every row' }
  if (verb === 'UPDATE' && has('SET') && !has('WHERE')) return { severity: 'high', message: 'UPDATE without WHERE changes every row' }
  if (verb === 'ALTER' && next === 'TABLE') {
    const drop = top.indexOf('DROP')
    if (drop >= 0) return top[drop + 1] === 'CONSTRAINT' ? { severity: 'medium', message: 'ALTER TABLE … DROP CONSTRAINT removes a constraint' } : { severity: 'high', message: 'ALTER TABLE … DROP removes a column and its data' }
    if (top.includes('ALTER', start + 1) && top[top.indexOf('ALTER', start + 1) + 1] === 'COLUMN') return { severity: 'medium', message: "ALTER COLUMN changes a column's type or nullability" }
  }
  if (verb === 'SP_RENAME' || ((verb === 'EXEC' || verb === 'EXECUTE') && /SP_RENAME$/.test(next))) return { severity: 'medium', message: 'sp_rename renames an object its users still name' }
  return null
}

/**
 * Destructive statements on the lines a PR adds to .sql files: DROP, TRUNCATE, DELETE/UPDATE without WHERE, ALTER
 * TABLE … DROP/ALTER COLUMN, sp_rename. They ship with the app and cannot be undone by a revert.
 */
export function sqlFindings(files: readonly ChangedFile[], readHead: (path: string) => string | undefined, skip: (path: string) => boolean): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  for (const f of files) {
    if (f.status === 'deleted' || !f.path.toLowerCase().endsWith('.sql') || skip(f.path)) continue
    const text = readHead(f.path)
    if (text === undefined) continue
    const added = new Set(f.added.map((l) => l.line))
    const lines = text.split('\n')
    for (const statement of statements(sqlTokens(text))) {
      const line = statement.map((t) => t.line).find((l) => added.has(l))
      const found = line === undefined ? null : destructive(statement)
      if (found && line !== undefined) findings.push({ path: f.path, line, rule: 'sql-destructive', severity: found.severity, message: found.message, text: (lines[line - 1] ?? '').trim().slice(0, 200) })
    }
  }
  return findings
}
