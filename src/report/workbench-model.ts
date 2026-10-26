import type { Output } from '../output/schema.js'
import { compactNumber, datadogErrorsUrl, usageHits, usageSummary } from './usage.js'
import type { Linker } from './links.js'
import { fileCoverage, mergeScore, scoreGroups } from './merge-score.js'
import { OWNER_TEXT as O, PLAN_TEXT as P, USAGE_TEXT as U, terms } from './strings.js'
import { testPlan } from './test-plan.js'
import { computeVerdict } from './verdict.js'

/** A file the reviewer can tick: code from the review plan, or a manifest or test that adds to the score. */
interface WorkbenchFile {
  path: string
  change: string | null
  why: string | null
  reached: number
  entries: string[]
  coverage: string | null
  /** Not code of the review plan: a dependency manifest, a changed test, or another scored file. */
  extra?: 'dependency' | 'tests' | 'other'
}

/**
 * Everything the HTML report's workbench renders, as JSON for the page (assets/report/wb-*.js). Pure: derived from
 * the analysis output and its links only. The score is recomputed in the page from `groups` as files get reviewed.
 */
export function workbenchModel(o: Output, links: Linker, prefix: string) {
  const { items } = mergeScore(o)
  const groups = scoreGroups(items)
  const v = computeVerdict(o)
  const coverage = fileCoverage(o)
  const t = terms(o.surface)

  const files: WorkbenchFile[] = [...v.startHere, ...v.skim].map((f) => ({ path: f.path, change: f.change, why: f.why, reached: f.pagesReached, entries: f.entries, coverage: coverage.get(f.path)?.label ?? null }))
  const listed = new Set(files.map((f) => f.path))
  // Every part of the score tied to a file must be reviewable: manifests, tests and other scored files join the list.
  for (const g of groups) {
    if (g.file === null || listed.has(g.file)) continue
    const kinds = new Set(g.items.map((i) => i.kind))
    const extra = kinds.has('dependency') ? 'dependency' : kinds.has('tests') ? 'tests' : 'other'
    files.push({ path: g.file, change: o.files.find((f) => f.path === g.file)?.status ?? null, why: g.items.map((i) => i.title).join('; '), reached: 0, entries: [], coverage: null, extra })
    listed.add(g.file)
  }

  const usage = usageSummary(o)
  const traffic = usageHits(o)
  const ops = testPlan(o).flatMap((g) => g.items).map((i) => ({ key: i.key, path: i.path, kind: i.kind, files: i.files, hits: traffic.byKey.get(i.key) ?? 0, errors: traffic.errorsByKey.get(i.key) ?? 0, errorsUrl: traffic.linkByKey.get(i.key) ?? null }))

  const c = o.signals.coverage
  const fileUrls: Record<string, string> = {}
  for (const f of o.files) {
    const url = links.file(f.path)
    if (url !== null) fileUrls[f.path] = url
  }

  const fileErrors: Record<string, { errors: number; url: string | null }> = {}
  if (o.usage?.status === 'ok') for (const f of o.usage.files) fileErrors[f.path] = { errors: f.errors, url: datadogErrorsUrl(o, f.issueIds, f.track ?? (o.usage.kind === 'pages' ? 'rum' : 'trace')) }

  return {
    repo: o.repo,
    pr: o.pr,
    base: (o.mergeBase ?? o.base.sha ?? o.base.ref).slice(0, 7),
    head: (o.head.sha ?? o.head.ref).slice(0, 7),
    version: o.tool.version,
    surface: o.surface,
    prefix,
    term: { one: t.one, many: t.many, Many: t.Many },
    incremental: o.incremental ? o.incremental.since.slice(0, 12) : null,
    verdict: v.level,
    groups: groups.map((g) => ({ file: g.file, items: g.items.map((i) => ({ kind: i.kind, weight: i.weight, title: i.title })) })),
    files,
    totalEntries: o.risk.totalPages,
    routes: { added: o.routes.added.filter((r) => !r.hasChildren).length, affected: o.routes.affected.filter((r) => !r.hasChildren).length },
    ops,
    coverage:
      c.status === 'ok' && c.total
        ? { status: 'ok' as const, covered: c.total.coveredLines, total: c.total.changedExecutableLines, files: c.files.map((f) => ({ path: f.path, total: f.changedExecutableLines, covered: f.coveredLines, uncovered: f.uncovered, missing: f.missingFromReport })), leftOut: [...c.ignoredFiles.map((path) => ({ path, by: 'ignore' as const })), ...(c.excludedByProject ?? []).map((path) => ({ path, by: 'project' as const }))] }
        : { status: c.status, covered: 0, total: 0, files: [], leftOut: [] },
    contracts: o.contracts ? o.contracts.entries : null,
    callers: Object.fromEntries((o.usage?.status === 'ok' ? o.usage.callers : []).map((x) => [x.key, x.services])),
    security: o.signals.security.findings.map((s) => ({ path: s.path, line: s.line, severity: s.severity, rule: s.rule, message: s.message, text: s.text })),
    lint: o.signals.lint.findings.map((l) => ({ path: l.path, line: l.line, severity: l.severity, rule: l.rule, message: l.message })),
    suppressions: o.signals.suppressions.items.map((s) => ({ path: s.path, line: s.line, kind: s.kind, text: s.text })),
    dependencies: o.dependencies.changes,
    reviewers: reviewersOf(o),
    fileErrors,
    usage: usage === null ? null : U.summary(usage.share, compactNumber(usage.affectedHits), compactNumber(usage.total), usage.kind, usage.source, usage.days),
    diffs: Object.fromEntries((o.diffs ?? []).map((d) => [d.path, d.hunks])),
    allFiles: o.files.filter((f) => f.role !== 'excluded').map((f) => ({ path: f.path, added: f.linesAdded, removed: f.linesRemoved })),
    links: { files: fileUrls, pr: links.page?.() ?? null },
  }
}

/** People who know the changed files: authors by blame (farol reviewers), else CODEOWNERS and recent authors. */
function reviewersOf(o: Output): { name: string; note: string; files: string[] }[] {
  if (o.ownership !== undefined) return o.ownership.reviewers.slice(0, 8).map((r) => ({ name: r.name, note: O.score(r.score) + (r.active ? '' : ` · ${O.inactive}`), files: r.files.map((f) => f.path) }))
  return (o.reviewers ?? []).slice(0, 8).map((r) => ({ name: r.name, note: r.kind === 'codeowner' ? P.codeowner(r.files.length) : P.author(r.files.length, r.commits), files: r.files }))
}
