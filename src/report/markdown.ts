import type { Output } from '../output/schema.js'
import type { Linker } from './links.js'
import { mergeScore } from './merge-score.js'
import { computeVerdict } from './verdict.js'
import { CLASS_TEXT, FEEDBACK_OPTIONS, MARKER, PLAN_TEXT, TEST_TEXT, TEXT, REASON_TEXT, USAGE_TEXT, CONTRACT_TEXT, OWNER_TEXT, SINCE_TEXT, terms } from './strings.js'
import { compactNumber, datadogErrorsUrl, usageSummary } from './usage.js'
import { callersText } from './html-contracts.js'
import { code, esc, fileMd, link, locationMd } from './markdown-format.js'
import { reviewSection } from './markdown-review.js'
import { COMMENT_TEXT } from './strings-comment.js'
import { shortFile, testPlan } from './test-plan.js'

export const MAX_COMMENT_LENGTH = 60_000

const NO_LINKS: Linker = { file: () => null, lines: () => null }

function rangesMd(l: Linker, path: string, list: readonly { start: number; end: number }[]): string {
  return list.map((r) => link(r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`, l.lines(path, r.start, r.end))).join(', ')
}

function limited<T>(items: readonly T[], limit: number, render: (item: T) => string, indent = ''): string[] {
  const lines = items.slice(0, limit).map((item) => `${indent}- ${render(item)}`)
  if (items.length > limit) lines.push(`${indent}- ${TEXT.andMore(items.length - limit)}`)
  return lines
}

function statusText(signal: { status: string; message?: string }): string | undefined {
  if (signal.status === 'not-provided') return TEXT.notVerified
  if (signal.status === 'error') return TEXT.reportError(esc(signal.message ?? ''))
  return undefined
}

function describeChangeShort(c: Output['dependencies']['changes'][number]): string {
  if (c.change === 'added') return `added ${c.to ?? ''}`
  if (c.change === 'removed') return `removed (was ${c.from ?? ''})`
  return `${c.from ?? ''} → ${c.to ?? ''}${c.bump ? ` (${c.bump})` : ''}${c.change === 'moved' ? ` moved ${c.fromSection ?? ''} → ${c.section}` : ''}`
}

function signalsSection(o: Output, limit: number, l: Linker): string[] {
  const { coverage, lint, suppressions, testsModified } = o.signals
  const verdict = computeVerdict(o)
  const lines: string[] = [`- **${TEXT.verdictLabel}:** ${esc(verdict.reasons.slice(0, 5).join('; '), 600)}`]
  if (o.incremental) lines.unshift(`- **${PLAN_TEXT.incremental(o.incremental.since.slice(0, 12))}**`)
  if (o.ownership) {
    const own = o.ownership
    const people = own.reviewers.map((r) => esc(OWNER_TEXT.comment(r.name, r.score, r.files.slice(0, 2).map((f) => `${f.path.split('/').pop() ?? f.path} ${f.share}%`).join(', '), !r.active)))
    const owners = own.codeowners.length === 0 ? '' : `; ${OWNER_TEXT.codeowners.toLowerCase()}: ${own.codeowners.map((c) => esc(c.name)).join(', ')}`
    lines.push(`- **${OWNER_TEXT.title}:** ${people.length > 0 ? people.join(', ') : OWNER_TEXT.none}${owners}`)
  } else if (o.reviewers) lines.push(`- **${PLAN_TEXT.reviewersTitle}:** ${o.reviewers.length === 0 ? PLAN_TEXT.noReviewers : o.reviewers.map((r) => `${esc(r.name)} (${r.kind === 'codeowner' ? PLAN_TEXT.codeowner(r.files.length) : PLAN_TEXT.author(r.files.length, r.commits)})`).join(', ')}`)

  const contracts = o.contracts
  if (contracts !== undefined) {
    const s = contracts.summary
    lines.push(`- **${CONTRACT_TEXT.label}:** ${esc(CONTRACT_TEXT.summary(s.breaking, s.dangerous, s.safe))} (${esc(CONTRACT_TEXT.readable(contracts.readable))})`)
    if (contracts.problem !== undefined) lines.push(`  - ${esc(contracts.problem)}`)
    const notable = contracts.entries.filter((e) => e.level !== 'safe')
    lines.push(
      ...limited(notable, Math.min(limit, 10), (e) => {
        const shown = e.changes.filter((c) => c.level === e.level).slice(0, 3).map((c) => `${code(c.where)} ${esc(c.detail, 120)}`).join('; ')
        const rest = e.changes.length + e.omitted - Math.min(3, e.changes.filter((c) => c.level === e.level).length)
        return `${e.level === 'breaking' ? '🔴' : '🟠'} ${code(e.key)}: ${shown}${rest > 0 ? ` (${CONTRACT_TEXT.more(rest)})` : ''} — ${esc(callersText(o, e.key))}`
      }, '  '),
    )
  }
  const usage = usageSummary(o)
  if (usage !== null) {
    lines.push(`- **${USAGE_TEXT.label}:** ${esc(USAGE_TEXT.summary(usage.share, compactNumber(usage.affectedHits), compactNumber(usage.total), usage.kind, usage.source, usage.days))}${usage.issues === 0 ? '' : esc(USAGE_TEXT.issuesOn(usage.issues))}`)
    const pathOf = new Map(o.routes.affected.map((r) => [r.key, r.path]))
    const track = usage.kind === 'pages' ? 'rum' : 'trace'
    lines.push(
      ...limited(o.usage?.entries ?? [], Math.min(limit, 5), (e) => {
        const errors = e.issues === 0 ? '' : `, ${link(USAGE_TEXT.distinct(e.issues), datadogErrorsUrl(o, e.issueIds, track))}`
        return `${code(pathOf.get(e.key) ?? e.key)} ${USAGE_TEXT.hits(compactNumber(e.hits), usage.kind)}${errors}`
      }, '  '),
    )
    const errorFiles = o.usage?.files ?? []
    if (errorFiles.length > 0) {
      lines.push(`- **${USAGE_TEXT.filesLabel}:** ${esc(USAGE_TEXT.filesSummary(errorFiles.length, usage.source, usage.days))}`)
      lines.push(...limited(errorFiles, Math.min(limit, 5), (f) => `${fileMd(l, f.path)} ${link(esc(USAGE_TEXT.fileItem(compactNumber(f.errors), f.issues, f.types.slice(0, 3).join(', '))), datadogErrorsUrl(o, f.issueIds, f.track ?? (o.surface === 'backend' ? 'trace' : 'rum')))}`, '  '))
    }
  } else if (o.usage?.status === 'error') lines.push(`- **${USAGE_TEXT.label}:** ${esc(USAGE_TEXT.error(o.usage.message ?? ''))}`)

  const risk = o.risk
  if (risk.files.length > 0) {
    lines.push(`- **${TEXT.riskLabel}:** ${TEXT.riskValue(risk.summary.high, risk.summary.medium, risk.summary.low)}`)
    const notable = risk.files.filter((f) => f.level !== 'low')
    lines.push(...limited(notable, Math.min(limit, 10), (f) => `${f.level === 'high' ? '🔴' : '🟠'} ${fileMd(l, f.path)} ${TEXT.riskItem(f.pagesReached, risk.totalPages, f.transitiveDependents, terms(o.surface))}`, '  '))
  }

  const sec = o.signals.security
  if (sec.status === 'ok' && sec.findings.length > 0) {
    lines.push(`- **${TEXT.securityLabel}:** ${TEXT.securityValue(sec.summary.high, sec.summary.medium, sec.summary.low)}`)
    lines.push(...limited(sec.findings, Math.min(limit, 10), (f) => `${locationMd(l, f.path, f.line)} ${f.severity} ${code(f.rule)}: ${esc(f.message, 160)}`, '  '))
  }
  const vul = o.signals.vulnerabilities
  const vulStatus = statusText(vul)
  if (vulStatus !== undefined) lines.push(`- **${TEXT.vulnerabilitiesLabel}:** ${vulStatus}`)
  else {
    lines.push(`- **${TEXT.vulnerabilitiesLabel}:** ${vul.related.length === 0 ? TEXT.none : vul.related.length}`)
    lines.push(...limited(vul.related, Math.min(limit, 10), (r) => link(esc(TEXT.vulnerabilityItem(r.severity, r.package, r.title, r.kind, r.relatedTo.join('/'))), r.url), '  '))
  }

  const deps = o.dependencies
  if (deps.changes.length > 0 || deps.lockfiles.length > 0) {
    const critical = deps.changes.filter((c) => c.critical)
    lines.push(`- **${TEXT.dependenciesLabel}:** ${TEXT.dependenciesValue(critical.length, deps.changes.length - critical.length)}`)
    lines.push(...limited([...critical, ...deps.changes.filter((c) => !c.critical)], limit, (c) => `${c.critical ? '⚠️ ' : ''}${code(c.name)} ${esc(describeChangeShort(c))}`, '  '))
    if (deps.lockfiles.length > 0) lines.push(`  - ${TEXT.lockfilesChanged(deps.lockfiles.map((p) => fileMd(l, p)).join(', '))}`)
  }

  const covStatus = statusText(coverage)
  if (covStatus !== undefined || coverage.total === null) lines.push(`- **${TEXT.coverageLabel}:** ${covStatus ?? TEXT.notVerified}`)
  else if (coverage.total.changedExecutableLines === 0) lines.push(`- **${TEXT.coverageLabel}:** ${TEXT.coverageNoLines}`)
  else {
    const { coveredLines, changedExecutableLines } = coverage.total
    const percent = `${((coveredLines / changedExecutableLines) * 100).toFixed(1)}%`
    const gaps = coverage.files.filter((f) => f.uncovered.length > 0)
    const ignoredNote = coverage.ignoredFiles.length > 0 ? ` (${TEXT.coverageIgnored(coverage.ignoredFiles.length)})` : ''
    lines.push(`- **${TEXT.coverageLabel}:** ${TEXT.coverageValue(percent, coveredLines, changedExecutableLines)}${ignoredNote}${gaps.length > 0 ? ` — ${TEXT.coverageUncoveredTitle}` : ''}`)
    if (gaps.length > 0) {
      lines.push(...limited(gaps, limit, (f) => `${fileMd(l, f.path)}${f.missingFromReport ? ` (${TEXT.coverageMissing})` : ''}: ${rangesMd(l, f.path, f.uncovered)}`, '  '))
    }
  }

  const lintStatus = statusText(lint)
  if (lintStatus !== undefined || lint.changedLines === null) lines.push(`- **${TEXT.lintLabel}:** ${lintStatus ?? TEXT.notVerified}`)
  else {
    const other = lint.otherLines && lint.otherLines.errors + lint.otherLines.warnings > 0 ? ` (${TEXT.lintOther(lint.otherLines.errors, lint.otherLines.warnings)})` : ''
    lines.push(`- **${TEXT.lintLabel}:** ${TEXT.lintValue(lint.changedLines.errors, lint.changedLines.warnings)}${other}`)
    const shown = lint.findings.slice(0, limit)
    for (const f of shown) lines.push(`  - ${locationMd(l, f.path, f.line)} ${TEXT.severity[f.severity]} ${code(f.rule)}: ${esc(f.message, 160)}`)
    const hidden = lint.findings.length - shown.length + lint.omittedFindings
    if (hidden > 0) lines.push(`  - ${TEXT.andMore(hidden)}`)
  }

  const supStatus = statusText(suppressions)
  if (supStatus !== undefined) lines.push(`- **${TEXT.suppressionsLabel}:** ${supStatus}`)
  else {
    lines.push(`- **${TEXT.suppressionsLabel}:** ${suppressions.items.length === 0 ? TEXT.none : suppressions.items.length}`)
    lines.push(...limited(suppressions.items, limit, (s) => `${locationMd(l, s.path, s.line)} ${code(s.kind)}`, '  '))
  }

  const testStatus = statusText(testsModified)
  if (testStatus !== undefined) lines.push(`- **${TEXT.testsLabel}:** ${testStatus}`)
  else if (testsModified.files.length === 0) lines.push(`- **${TEXT.testsLabel}:** ${TEXT.none}`)
  else {
    const removed = testsModified.files.reduce((n, f) => n + f.linesRemoved, 0)
    lines.push(`- **${TEXT.testsLabel}:** ${TEXT.testsValue(testsModified.files.length, removed)}`)
    lines.push(
      ...limited(
        testsModified.files,
        limit,
        (f) => `${fileMd(l, f.path)} (${TEXT.testStatus[f.status]}${f.oldPath ? `, ${TEXT.renamedFrom(code(f.oldPath))}` : ''}, ${TEXT.linesRemoved(f.linesRemoved)})`,
        '  ',
      ),
    )
  }
  return lines
}

function detailsSection(o: Output, limit: number, l: Linker): string[] {
  const lines = ['<details>', `<summary>${TEXT.detailsSummary}</summary>`, '']
  lines.push(`**${TEXT.classLabel}:** ${code(o.classification)} — ${CLASS_TEXT[o.classification]}`, '')
  if (o.diagnostics.error !== null) lines.push(TEXT.analysisError(esc(o.diagnostics.error)), '')
  lines.push(`**${TEXT.reasonsLabel}:**`)
  lines.push(...limited(o.reasons, limit, (r) => `${REASON_TEXT[r.code]} (${code(r.code)})${r.file ? ` ${fileMd(l, r.file)}` : ''}: ${esc(r.detail)}`))
  lines.push('', `**${TEXT.addedRoutesLabel}:**${o.routes.added.length === 0 ? ` ${TEXT.noneRoutes}` : ''}`)
  lines.push(...limited(o.routes.added, limit, (r) => `${code(r.path)}${r.entry ? ` → ${fileMd(l, r.entry)}` : ''}`))
  lines.push('', `**${TEXT.affectedRoutesLabel}:**${o.routes.affected.length === 0 ? ` ${TEXT.noneRoutes}` : ''}`)
  lines.push(...limited(o.routes.affected, limit, (r) => `${code(r.path)}${r.path === r.key ? '' : ` (${code(r.key)})`} ${TEXT.via} ${r.via.map((v) => v.chain.map((p) => fileMd(l, p)).join(' → ')).join('; ')}`))
  if (o.routes.disconnectedNewFiles.length > 0) {
    lines.push('', `**${TEXT.disconnectedLabel}:**`)
    lines.push(...limited(o.routes.disconnectedNewFiles, limit, (p) => fileMd(l, p)))
  }
  lines.push('', `**${TEXT.feedbackTitle}**`, ...FEEDBACK_OPTIONS.map((label) => `- [ ] ${label}`), '', '</details>')
  return lines
}

/** GitHub task list of the pages/operations to try by hand (task lists in comments are clickable). */
function testSection(o: Output, limit: number): string[] {
  const items = testPlan(o).flatMap((g) => g.items)
  if (items.length === 0) return []
  const shown = items.slice(0, Math.min(limit, 30))
  const lines = ['<details>', `<summary>${TEST_TEXT.commentTitle(items.length)}</summary>`, '']
  for (const i of shown) lines.push(`- [ ] ${i.kind === 'new' ? `${TEST_TEXT.newTag}: ` : ''}${code(i.path)}${i.because ? ` (${i.kind === 'new' ? TEST_TEXT.renders(shortFile(i.because)) : TEST_TEXT.because(shortFile(i.because))})` : ''}`)
  if (items.length > shown.length) lines.push(`- ${TEST_TEXT.commentMore(items.length - shown.length)}`)
  lines.push('', '</details>', '')
  return lines
}

/** An incremental analysis shown on top of the comment: the commits since the last push, with its own report. */
export interface SinceBlock {
  output: Output
  reportUrl?: string
}

function sinceLines(since: SinceBlock | undefined): string[] {
  if (since === undefined) return []
  const o = since.output
  const score = mergeScore(o)
  const verdict = computeVerdict(o)
  const from = (o.incremental?.since ?? o.mergeBase ?? o.base.ref).slice(0, 12)
  const to = (o.head.sha ?? o.head.ref).slice(0, 12)
  const lines = [`${SINCE_TEXT.title(from, to)}: ${esc(SINCE_TEXT.summary(PLAN_TEXT.levels[verdict.level], score.score, score.level, o.files.length), 400)}`]
  if (since.reportUrl !== undefined) lines.push(`  ${SINCE_TEXT.report(since.reportUrl)}`)
  return [...lines, '']
}

function render(o: Output, limit: number, truncated: boolean, l: Linker, reportUrl: string | undefined, since?: SinceBlock): string {
  const commit = o.head.sha === null ? o.head.ref : o.head.sha.slice(0, 12)
  const signals = ['<details>', `<summary>${COMMENT_TEXT.allSignals}</summary>`, '', ...signalsSection(o, limit, l), '', '</details>']
  const lines = [MARKER, ...reviewSection(o, l, reportUrl), '', ...sinceLines(since), ...signals, '', ...detailsSection(o, limit, l), '', ...testSection(o, limit)]
  if (truncated) lines.push(`_${TEXT.truncated}_`, '')
  lines.push(`<sub>${esc(TEXT.footer(o.tool.version, commit))}</sub>`, '')
  return lines.join('\n')
}

/** Markdown of the PR comment, at most MAX_COMMENT_LENGTH characters: long lists are cut with "e mais N". */
export function renderReport(output: Output, maxLength = MAX_COMMENT_LENGTH, links: Linker = NO_LINKS, reportUrl?: string, since?: SinceBlock): string {
  for (const url of [reportUrl, since?.reportUrl]) if (url !== undefined && !/^https:\/\/[^\s()<>]+$/.test(url)) throw new Error(`report URL must be an https URL, got "${url}"`)
  for (const limit of [50, 20, 10, 5, 2, 1, 0]) {
    const text = render(output, limit, limit < 50, links, reportUrl, since)
    if (text.length <= maxLength) return text
  }
  // Even without list items the text is too long (e.g. a huge error message): cut it hard, keeping the marker.
  const text = render(output, 0, true, links, reportUrl, since)
  return `${text.slice(0, maxLength - 20)}\n\n…\n`
}
