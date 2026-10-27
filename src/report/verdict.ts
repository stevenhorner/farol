import { posix } from 'node:path'
import { REASONS } from '../classify/reasons.js'
import { HELPER_EXTENSIONS, SCRIPT_EXTENSIONS } from '../config/languages.js'
import { compareStrings } from '../output/order.js'
import type { Output } from '../output/schema.js'
import { fileCoverage, mergeScore, type FileCoverage } from './merge-score.js'
import { reviewParts } from './review-parts.js'

/** How much review a PR needs, from the reviewer's point of view. */
export type VerdictLevel = 'pass' | 'quick' | 'careful'

/** Score from which a review is quick or careful (independently of the other triggers). */
export const QUICK_SCORE = 25
export const CAREFUL_SCORE = 60
/** Files listed under "start here" at most, and the least points a file needs to be listed. */
export const START_HERE_MAX = 7
export const START_HERE_MIN_POINTS = 5

export interface FileToReview {
  path: string
  /** Risk points of the file's change on its own (0–100); its findings are parts of their own, as in the report. */
  points: number
  change: string | null
  level: 'high' | 'medium' | 'low' | null
  pagesReached: number
  coverage: FileCoverage | undefined
  security: number
  lint: number
  suppressions: number
  why: string | null
  /** Pages/operations (paths) this file reaches: affected existing ones, and new ones it renders. */
  entries: string[]
}

export interface Verdict {
  level: VerdictLevel
  /** Why this level, most important first. */
  reasons: string[]
  score: number
  startHere: FileToReview[]
  /** Other changed code files: low risk, a skim is enough. */
  skim: FileToReview[]
  /** Environment, infrastructure and CI files: deploy-time configuration, reviewed on their own. */
  infra: string[]
  /** Files that are not code (docs, assets) and changed tests. */
  other: { path: string; kind: 'test' | 'not-code' | 'dependency' }[]
}

const CODE = new Set([...SCRIPT_EXTENSIONS, ...HELPER_EXTENSIONS, '.graphql', '.gql'])

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

/**
 * Review effort for a PR: careful when anything can break widely or silently (global or unknown class, high score,
 * security findings, critical or vulnerable dependencies, a central file without tests); quick when existing code
 * changed in a way worth a look; fast track otherwise. Files are ordered by their own risk points.
 */
export function computeVerdict(o: Output): Verdict {
  const { score, items } = mergeScore(o)
  const coverage = fileCoverage(o)
  const points = new Map(reviewParts(items).flatMap((p) => (p.kind === 'file' && p.file !== null ? [[p.file, p.own] as const] : [])))
  const riskOf = new Map(o.risk.files.map((f) => [f.path, f]))
  const entriesOf = new Map<string, Set<string>>()
  const addEntry = (file: string, path: string): void => {
    entriesOf.set(file, (entriesOf.get(file) ?? new Set()).add(path))
  }
  for (const r of o.routes.affected) if (!r.hasChildren) for (const v of r.via) addEntry(v.file, r.path)
  for (const r of o.routes.added) if (r.entry !== null && !r.hasChildren) addEntry(r.entry, r.path)
  const count = (list: readonly { path: string }[], path: string): number => list.filter((x) => x.path === path).length
  const isCode = (path: string): boolean => CODE.has(posix.extname(path))

  const files: FileToReview[] = []
  const other: Verdict['other'] = []
  const infra: string[] = []
  for (const f of o.files) {
    if (f.role === 'excluded' || f.role === 'story') continue
    if (f.role === 'infra') {
      infra.push(f.path)
      continue
    }
    if (f.role === 'test') {
      other.push({ path: f.path, kind: 'test' })
      continue
    }
    if (f.role === 'manifest' || f.role === 'lockfile') {
      other.push({ path: f.path, kind: 'dependency' })
      continue
    }
    if (!isCode(f.path) && f.role !== 'global') {
      other.push({ path: f.path, kind: 'not-code' })
      continue
    }
    const risk = riskOf.get(f.path)
    files.push({
      path: f.path,
      points: points.get(f.path) ?? 0,
      change: risk?.change ?? f.status,
      level: risk?.level ?? null,
      pagesReached: risk?.pagesReached ?? 0,
      coverage: coverage.get(f.path),
      security: count(o.signals.security.findings, f.path),
      lint: o.signals.lint.findings.filter((l) => l.path === f.path && l.severity === 'error').length,
      suppressions: count(o.signals.suppressions.items, f.path),
      why: risk?.why ?? (f.role === 'global' ? 'global file: affects the whole app' : null),
      entries: [...(entriesOf.get(f.path) ?? [])].sort(compareStrings),
    })
  }
  files.sort((a, b) => b.points - a.points || compareStrings(a.path, b.path))
  const startHere = files.filter((f) => f.points >= START_HERE_MIN_POINTS).slice(0, START_HERE_MAX)
  const skim = files.filter((f) => !startHere.includes(f))

  const careful: string[] = []
  const quick: string[] = []
  // A global change alone is a quick review (calibration: no more problems than other changes to existing code);
  // its weight in the score can still make it careful.
  if (o.classification === 'global') quick.push('a global file, manifest or critical dependency changed: everything may be affected')
  if (o.classification === 'unknown') careful.push('farol could not read part of the change (unknown): nothing here is guaranteed')
  if (score >= CAREFUL_SCORE) careful.push(`merge risk score ${score}/100`)
  const highSecurity = o.signals.security.findings.filter((s) => s.severity === 'high').length
  if (highSecurity > 0) careful.push(`${highSecurity} high-severity security finding(s) on added lines`)
  const vulnerable = o.signals.vulnerabilities.related.filter((v) => v.severity === 'critical' || v.severity === 'high').length
  if (vulnerable > 0) careful.push(`${vulnerable} serious vulnerabilit${vulnerable === 1 ? 'y' : 'ies'} in added or changed dependencies`)
  const untestedCentral = files.filter((f) => f.level === 'high' && f.coverage?.ratio !== undefined && f.coverage.ratio !== null && f.coverage.ratio < 0.5)
  if (untestedCentral.length > 0) careful.push(`${untestedCentral.length} central file(s) with little or no diff coverage: ${untestedCentral.slice(0, 3).map((f) => posix.basename(f.path)).join(', ')}`)
  const contracts = o.contracts?.entries ?? []
  const breaking = contracts.filter((e) => e.level === 'breaking')
  const dangerous = contracts.filter((e) => e.level === 'dangerous')
  if (breaking.length > 0) careful.push(`${breaking.length} endpoint(s) with breaking contract changes: ${breaking.slice(0, 3).map((e) => e.key).join(', ')} (check that clients are updated)`)
  if (dangerous.length > 0) quick.push(`${dangerous.length} endpoint(s) with contract changes that may affect clients`)
  if (score >= QUICK_SCORE && score < CAREFUL_SCORE) quick.push(`merge risk score ${score}/100`)
  const affected = o.routes.affected.filter((r) => !r.hasChildren).length
  const codeChanged = o.reasons.some((r) => REASONS[r.code] === 'touches-existing' && r.code !== 'infra-file-changed')
  if (codeChanged) quick.push(`existing code changed: ${affected} existing ${o.surface === 'backend' ? 'operation' : 'page'}(s) run it`)
  if (infra.length > 0) quick.push(`${infra.length} environment, infrastructure or CI file(s) changed: check them for every environment`)
  const total = o.signals.coverage.total
  const ratio = total && total.changedExecutableLines > 0 ? total.coveredLines / total.changedExecutableLines : null
  // Low coverage of new code is worth a look; of existing code, already below 80%.
  if (ratio !== null && (ratio < 0.5 || (ratio < 0.8 && o.classification === 'touches-existing'))) quick.push(`diff coverage ${percent(ratio)}`)
  const notes = o.signals.coverage.status === 'ok' ? [] : ['diff coverage not verified: risk is counted as if nothing were tested']
  const lintErrors = o.signals.lint.changedLines?.errors ?? 0
  if (lintErrors > 0) quick.push(`${lintErrors} lint error(s) on changed lines`)
  const removedTests = o.signals.testsModified.files.filter((t) => t.status === 'deleted' || t.linesRemoved >= 10).length
  if (removedTests > 0) quick.push(`${removedTests} existing test file(s) deleted or heavily trimmed`)
  if (o.signals.suppressions.items.length > 0) quick.push(`${o.signals.suppressions.items.length} new suppression(s) (lint/type/security ignores)`)

  const level: VerdictLevel = careful.length > 0 ? 'careful' : quick.length > 0 ? 'quick' : 'pass'
  const reasons = [...(level === 'careful' ? [...careful, ...quick] : level === 'quick' ? quick : ['only new code, tests or low-risk changes; nothing existing is widely affected']), ...notes]
  return { level, reasons, score, startHere, skim, infra: infra.sort(compareStrings), other: other.sort((a, b) => compareStrings(a.kind, b.kind) || compareStrings(a.path, b.path)) }
}
