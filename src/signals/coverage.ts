import { z } from 'zod'
import type { AnalysisRole } from '../classify/roles.js'
import type { ChangedFile } from '../git/types.js'
import { compareStrings } from '../output/order.js'
import type { CoverageSignal } from '../output/schema.js'
import { isCodeFile, reportPathToRepo, toRanges } from './paths.js'

const Position = z.object({ line: z.number().int() }).loose()
const IstanbulFile = z
  .object({
    path: z.string().optional(),
    statementMap: z.record(z.string(), z.object({ start: Position, end: Position }).loose()),
    s: z.record(z.string(), z.number()),
  })
  .loose()
const IstanbulReport = z.record(z.string(), IstanbulFile)

type Statements = { start: number; end: number; count: number }[]

export class ReportError extends Error {}

/** Parses an Istanbul `coverage-final.json` into statements per repo-relative path. */
export function parseCoverageReport(text: string, repoRoot: string, projectPrefix: string, canonical?: (path: string) => string): Map<string, Statements> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new ReportError(`the coverage report is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  const parsed = IstanbulReport.safeParse(raw)
  if (!parsed.success) throw new ReportError('the coverage report is not in the Istanbul coverage-final.json format (use the Vitest "json" reporter)')
  const result = new Map<string, Statements>()
  for (const [key, entry] of Object.entries(parsed.data)) {
    const path = reportPathToRepo(entry.path ?? key, repoRoot, projectPrefix, canonical)
    if (path === undefined) continue
    const statements: Statements = []
    for (const [id, loc] of Object.entries(entry.statementMap)) statements.push({ start: loc.start.line, end: loc.end.line, count: entry.s[id] ?? 0 })
    result.set(path, statements)
  }
  return result
}

/**
 * Whether a report lists files no test loaded (every statement at 0): then the coverage tool was told which files to
 * measure, and a changed file missing from it was left out by the project's settings rather than never loaded.
 * Not for Go profiles: a package without tests is missing from them, untested.
 */
export function listsUnloadedFiles(report: Map<string, Statements>): boolean {
  return [...report.values()].some((statements) => statements.length > 0 && statements.every((s) => s.count === 0))
}

export interface CoverageOptions {
  /** Whether a changed file left out of the report was excluded by the project's settings (see listsUnloadedFiles). */
  missingIsExcluded?: boolean
  /** Whether a changed file only declares things (types, static constants): nothing for a test to run. */
  declarationsOnly?: (path: string) => boolean
}

/**
 * Diff coverage of added/modified source files: a changed line is executable when it intersects a statement, and
 * covered when every statement intersecting it ran. A file missing from the report is entirely uncovered, unless it
 * only declares things or the project's coverage settings left it out.
 */
export function coverageSignal(report: Map<string, Statements>, files: readonly ChangedFile[], roleOf: (path: string) => AnalysisRole | 'outside', ignored: (path: string) => boolean = () => false, options: CoverageOptions = {}): CoverageSignal {
  const out: CoverageSignal['files'] = []
  const ignoredFiles: string[] = []
  const excluded: string[] = []
  for (const file of files) {
    if (file.status !== 'added' && file.status !== 'modified') continue
    // Resolver files (backend) are code too; schema, barrels and the frontend routes file are declarations.
    const role = roleOf(file.path)
    if ((role !== 'source' && role !== 'resolvers') || !isCodeFile(file.path) || file.added.length === 0) continue
    if (ignored(file.path)) {
      ignoredFiles.push(file.path)
      continue
    }
    const lines = file.added.map((l) => l.line)
    const statements = report.get(file.path)
    if (statements === undefined && options.declarationsOnly?.(file.path) === true) {
      out.push({ path: file.path, changedExecutableLines: 0, coveredLines: 0, uncovered: [], missingFromReport: false })
      continue
    }
    if (statements === undefined && options.missingIsExcluded === true) {
      excluded.push(file.path)
      continue
    }
    if (statements === undefined) {
      out.push({ path: file.path, changedExecutableLines: lines.length, coveredLines: 0, uncovered: toRanges(lines), missingFromReport: true })
      continue
    }
    let executable = 0
    let covered = 0
    const uncovered: number[] = []
    for (const line of lines) {
      const hits = statements.filter((s) => s.start <= line && line <= s.end)
      if (hits.length === 0) continue
      executable++
      if (hits.every((s) => s.count > 0)) covered++
      else uncovered.push(line)
    }
    out.push({ path: file.path, changedExecutableLines: executable, coveredLines: covered, uncovered: toRanges(uncovered), missingFromReport: false })
  }
  out.sort((a, b) => compareStrings(a.path, b.path))
  const total = out.reduce((acc, f) => ({ changedExecutableLines: acc.changedExecutableLines + f.changedExecutableLines, coveredLines: acc.coveredLines + f.coveredLines }), { changedExecutableLines: 0, coveredLines: 0 })
  return { status: 'ok', files: out, total, ignoredFiles: ignoredFiles.sort(compareStrings), ...(excluded.length > 0 ? { excludedByProject: excluded.sort(compareStrings) } : {}) }
}
