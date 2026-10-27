import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { ChangedFile } from '../git/types.js'
import { compareStrings } from '../output/order.js'
import type { SecurityFinding, SuppressionKind, SuppressionsSignal } from '../output/schema.js'
import type { Advisory, Severity } from './audit.js'
import { ReportError } from './coverage.js'
import type { LintMessage } from './lint.js'
import { reportPathToRepo } from './paths.js'

type Statements = { start: number; end: number; count: number }[]

/** Suppressions read from the comments and directives the C# helper prints (Roslyn trivia, so strings never match). */
const CSHARP_SUPPRESSIONS: [RegExp, SuppressionKind][] = [
  [/^#\s*pragma\s+warning\s+disable\b/, 'pragma-warning-disable'],
  [/^#\s*nullable\s+disable\b/, 'nullable-disable'],
  [/^\/\/\s*ReSharper\s+disable\b/, 'resharper-disable'],
  [/^\[(System\.Diagnostics\.CodeAnalysis\.)?SuppressMessage/, 'suppress-message'],
  [/^\[(System\.Diagnostics\.CodeAnalysis\.)?ExcludeFromCodeCoverage/, 'exclude-from-coverage'],
  // The helper prints null-forgiving expressions (`user!`) as written: code, not a comment.
  [/^(?!\/\/|\/\*|#|\[).*!$/, 'null-forgiving'],
]

/**
 * `#pragma warning disable`, `#nullable disable`, `// ReSharper disable`, `[SuppressMessage]`, `[ExcludeFromCodeCoverage]`
 * and the null-forgiving `!` (C#'s `as any`) on the lines a PR adds to C# files.
 */
export function csharpSuppressions(files: readonly ChangedFile[], comments: readonly { file: string; line: number; text: string }[]): SuppressionsSignal['items'] {
  const added = new Map(files.map((f) => [f.path, new Set(f.added.map((l) => l.line))]))
  const items: SuppressionsSignal['items'] = []
  for (const c of comments) {
    if (!added.get(c.file)?.has(c.line)) continue
    const kind = CSHARP_SUPPRESSIONS.find(([pattern]) => pattern.test(c.text))?.[1]
    if (kind) items.push({ path: c.file, line: c.line, kind, text: c.text.slice(0, 200) })
  }
  return items.sort((a, b) => compareStrings(a.path, b.path) || a.line - b.line)
}

function json(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new ReportError(`the ${label} report is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

/** coverlet's own JSON format: module → file → class → method → { Lines: { "12": hits } }. */
const Coverlet = z.record(z.string(), z.record(z.string(), z.record(z.string(), z.record(z.string(), z.object({ Lines: z.record(z.string(), z.number()) }).loose()))))

/** Whether a coverage report is coverlet JSON (`--collect "XPlat Code Coverage;Format=json"`, `CoverletOutputFormat=json`). */
export function isCoverletReport(text: string): boolean {
  return text.trimStart().startsWith('{') && text.includes('"Lines"') && !text.includes('"statementMap"')
}

/** Line hits of a coverage report as farol's statements: one per line, merged across modules (highest count). */
function linesToStatements(files: Iterable<[string, Iterable<[number, number]>]>, repoRoot: string, projectPrefix: string, canonical?: (path: string) => string): Map<string, Statements> {
  const out = new Map<string, Map<number, number>>()
  for (const [raw, lines] of files) {
    const path = reportPathToRepo(raw, repoRoot, projectPrefix, canonical)
    if (path === undefined) continue
    const perFile = out.get(path) ?? new Map<number, number>()
    for (const [line, hits] of lines) perFile.set(line, Math.max(perFile.get(line) ?? 0, hits))
    out.set(path, perFile)
  }
  return new Map([...out].map(([path, lines]) => [path, [...lines].sort(([a], [b]) => a - b).map(([line, count]) => ({ start: line, end: line, count }))]))
}

export function parseCoverletReport(text: string, repoRoot: string, projectPrefix: string, canonical?: (path: string) => string): Map<string, Statements> {
  const parsed = Coverlet.safeParse(json(text, 'coverlet'))
  if (!parsed.success) throw new ReportError('the coverage report is not coverlet JSON')
  const files: [string, [number, number][]][] = []
  for (const module of Object.values(parsed.data))
    for (const [file, classes] of Object.entries(module))
      for (const methods of Object.values(classes)) for (const method of Object.values(methods)) files.push([file, Object.entries(method.Lines).map(([l, h]) => [Number(l), h])])
  return linesToStatements(files, repoRoot, projectPrefix, canonical)
}

/** Cobertura XML, as the C# helper converts it: [{ path, lines: { "12": hits } }]. */
const CoberturaJson = z.array(z.object({ path: z.string(), lines: z.record(z.string(), z.number()) }))

/** Whether a coverage report is the helper's JSON form of Cobertura XML (see cli/analyze). */
export function isCoberturaJson(text: string): boolean {
  return text.trimStart().startsWith('[') && text.includes('"lines"') && text.includes('"path"')
}

export function parseCoberturaJson(text: string, repoRoot: string, projectPrefix: string, canonical?: (path: string) => string): Map<string, Statements> {
  const parsed = CoberturaJson.safeParse(json(text, 'Cobertura'))
  if (!parsed.success) throw new ReportError('the coverage report is not Cobertura XML')
  return linesToStatements(parsed.data.map((f) => [f.path, Object.entries(f.lines).map(([l, h]) => [Number(l), h])]), repoRoot, projectPrefix, canonical)
}

const SarifLocation = z.object({
  physicalLocation: z.object({ artifactLocation: z.object({ uri: z.string(), uriBaseId: z.string().optional() }).loose(), region: z.object({ startLine: z.number().int().optional() }).loose().optional() }).loose().optional(),
  resultFile: z.object({ uri: z.string(), region: z.object({ startLine: z.number().int().optional() }).loose().optional() }).loose().optional(),
}).loose()

const Sarif = z.object({
  runs: z.array(z.object({
    originalUriBaseIds: z.record(z.string(), z.object({ uri: z.string() }).loose()).optional(),
    results: z.array(z.object({
      ruleId: z.string().optional(),
      level: z.string().optional(),
      message: z.union([z.string(), z.object({ text: z.string().optional() }).loose()]).optional(),
      locations: z.array(SarifLocation).optional(),
    }).loose()).optional(),
  }).loose()),
}).loose()

/** Whether a lint report is SARIF (Roslyn analyzers' ErrorLog, CodeQL, Semgrep). */
export function isSarifReport(text: string): boolean {
  return text.trimStart().startsWith('{') && text.includes('"runs"') && (text.includes('sarif') || text.includes('"results"'))
}

/** .NET security analyzers: injection and deserialization rules are high, the other security rules medium. */
const SECURITY_RULE = /^(CA2100|CA21(09|53)|CA23\d\d|CA30\d\d|CA31\d\d|CA53\d\d|CA54\d\d|SCS\d{4})$/
const SECURITY_HIGH = /^(CA2100|CA300[1-9]|CA301[0-2]|CA23\d\d|CA5360|SCS000[1-3]|SCS0018|SCS0026|SCS0028|SCS0029)$/

function sarifPath(uri: string, base: string | undefined): string {
  const joined = base !== undefined && !/^[a-z]+:/i.test(uri) ? `${base.replace(/\/$/, '')}/${uri}` : uri
  return joined.startsWith('file:') ? fileURLToPath(joined) : decodeURIComponent(joined)
}

/** SARIF 2.1 and 1.0 results as lint messages (errors and warnings), and security rule results as findings. */
export function parseSarifReport(text: string, repoRoot: string, projectPrefix: string, canonical?: (path: string) => string): { messages: LintMessage[]; sast: Omit<SecurityFinding, 'text'>[] } {
  const parsed = Sarif.safeParse(json(text, 'SARIF'))
  if (!parsed.success) throw new ReportError('the lint report is not SARIF (runs[].results[])')
  const messages: LintMessage[] = []
  const sast: Omit<SecurityFinding, 'text'>[] = []
  for (const run of parsed.data.runs) {
    for (const result of run.results ?? []) {
      const level = result.level ?? 'warning'
      if (level === 'none' || level === 'note') continue
      const location = result.locations?.[0]
      const uri = location?.physicalLocation?.artifactLocation.uri ?? location?.resultFile?.uri
      if (uri === undefined) continue
      const baseId = location?.physicalLocation?.artifactLocation.uriBaseId
      const raw = sarifPath(uri, baseId === undefined ? undefined : run.originalUriBaseIds?.[baseId]?.uri)
      const path = reportPathToRepo(raw, repoRoot, projectPrefix, canonical) ?? raw
      const line = location?.physicalLocation?.region?.startLine ?? location?.resultFile?.region?.startLine
      const rule = result.ruleId ?? 'sarif'
      const message = typeof result.message === 'string' ? result.message : (result.message?.text ?? rule)
      messages.push({ path, line, rule, severity: level === 'error' ? 'error' : 'warning', message })
      if (line !== undefined && SECURITY_RULE.test(rule)) sast.push({ path, line, rule: 'dotnet-analyzer', severity: SECURITY_HIGH.test(rule) ? 'high' : 'medium', message: `${rule}: ${message}` })
    }
  }
  return { messages, sast }
}

const DotnetPackage = z.object({
  id: z.string(),
  resolvedVersion: z.string().optional(),
  vulnerabilities: z.array(z.object({ severity: z.string(), advisoryurl: z.string() }).loose()).optional(),
}).loose()

const DotnetAudit = z.object({
  projects: z.array(z.object({
    frameworks: z.array(z.object({ topLevelPackages: z.array(DotnetPackage).optional(), transitivePackages: z.array(DotnetPackage).optional() }).loose()).optional(),
  }).loose()),
}).loose()

/** Whether an audit report is `dotnet list package --vulnerable --format json`. */
export function isDotnetAuditReport(text: string): boolean {
  return text.includes('"projects"') && (text.includes('"topLevelPackages"') || text.includes('"frameworks"'))
}

const SEVERITY: Record<string, Severity> = { low: 'low', moderate: 'moderate', medium: 'moderate', high: 'high', critical: 'critical' }

/**
 * `dotnet list package --vulnerable --include-transitive --format json`: one advisory per package and advisory URL. The
 * report has no dependency paths: transitive advisories count in the totals, and relate to the PR only when the PR
 * changed that package itself.
 */
export function parseDotnetAuditReport(text: string): { advisories: Advisory[]; dependsOn: Map<string, string[]> } {
  const parsed = DotnetAudit.safeParse(json(text, 'dotnet list package'))
  if (!parsed.success) throw new ReportError('the audit report is not `dotnet list package --vulnerable --format json` output')
  const advisories = new Map<string, Advisory>()
  for (const project of parsed.data.projects)
    for (const framework of project.frameworks ?? [])
      for (const pkg of [...(framework.topLevelPackages ?? []), ...(framework.transitivePackages ?? [])])
        for (const v of pkg.vulnerabilities ?? []) {
          const id = v.advisoryurl.split('/').filter((x) => x !== '').pop() ?? v.advisoryurl
          const severity = SEVERITY[v.severity.toLowerCase()] ?? 'moderate'
          advisories.set(`${pkg.id}\0${id}`, { package: pkg.id, severity, title: `${pkg.id} ${pkg.resolvedVersion ?? ''}: ${severity} vulnerability`.replace('  ', ' '), id, url: v.advisoryurl, cves: [], vulnerableRange: pkg.resolvedVersion ?? null, patchedVersions: null, paths: [] })
        }
  return { advisories: [...advisories.values()].sort((a, b) => compareStrings(a.package, b.package) || compareStrings(a.id, b.id)), dependsOn: new Map() }
}
