import { REASONS } from '../classify/reasons.js'
import type { Output } from '../output/schema.js'
import type { Linker } from './links.js'
import { HTML_STYLE } from './html-style.js'
import { securitySection } from './html-security.js'
import { routesSection } from './html-routes.js'
import { usageHits } from './usage.js'
import { faviconUri } from './logo.js'
import { contractsSection } from './html-contracts.js'
import { FULLSCREEN_SCRIPT, MERMAID_SCRIPT, RISK_FILTER_SCRIPT, THEME_SCRIPT } from './html-scripts.js'
import { reviewersSection } from './html-verdict.js'
import { workbenchPage } from './html-workbench.js'
import { HTML_TEXT as T, REASON_TEXT, terms } from './strings.js'
import { fileCoverage } from './merge-score.js'
import { scoreByFile } from './html-score.js'

/** Rows shown per table before "e mais N" (the JSON keeps everything). */
const MAX_ROWS = 200
const NO_LINKS: Linker = { file: () => null, lines: () => null }

function esc(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/** Longest directory prefix shared by every path (e.g. "apps/web/"), so tables can show short paths. */
export function commonDirectory(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  const split = paths.map((p) => p.split('/').slice(0, -1))
  const first = split[0] ?? []
  let n = 0
  while (n < first.length && split.every((parts) => parts[n] === first[n])) n++
  return n === 0 ? '' : `${first.slice(0, n).join('/')}/`
}

/**
 * Prefix to shorten paths with: the common directory of the paths under the dominant top-two-level directory
 * (e.g. the app of a monorepo), when at least 70% of the paths are there. Other paths are shown in full.
 */
export function displayPrefix(paths: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const p of paths) {
    const parts = p.split('/')
    if (parts.length > 2) counts.set(`${parts[0] ?? ''}/${parts[1] ?? ''}/`, (counts.get(`${parts[0] ?? ''}/${parts[1] ?? ''}/`) ?? 0) + 1)
  }
  const [top, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
  if (top === '' || count < paths.length * 0.7) return commonDirectory(paths)
  return commonDirectory(paths.filter((p) => p.startsWith(top)))
}

class Html {
  traffic?: { hits: ReadonlyMap<string, number>; errors: ReadonlyMap<string, number>; links: ReadonlyMap<string, string>; kind: 'pages' | 'operations' }

  constructor(
    private readonly prefix: string,
    private readonly links: Linker,
  ) {}

  /** Path shown to people: without the shared app prefix. */
  shortPath(p: string): string {
    return this.short(p)
  }

  /** Route key shown to people: module paths inside `(layout:…)` segments lose the shared prefix too. */
  shortKey(key: string): string {
    return this.prefix === '' ? key : key.replaceAll(this.prefix, '')
  }

  private short(p: string): string {
    return this.prefix !== '' && p.startsWith(this.prefix) ? p.slice(this.prefix.length) : p
  }

  private anchor(text: string, title: string, url: string | null, cls = 'path'): string {
    return url === null ? `<span class="${cls}" title="${esc(title)}">${esc(text)}</span>` : `<a class="${cls}" title="${esc(title)}" href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`
  }

  /** URL of a file's diff (or content), when links are available. */
  url(p: string): string | null {
    return this.links.file(p)
  }

  /** A file, linked to its diff on GitHub (or to its content at the analyzed commit when the PR did not change it). */
  path(p: string): string {
    return this.anchor(this.short(p), p, this.links.file(p))
  }

  /** `file:line`, linked to that line. */
  loc(p: string, line: number): string {
    return this.anchor(`${this.short(p)}:${line}`, `${p}:${line}`, this.links.lines(p, line))
  }

  /** Line ranges of a file, each linked to its lines. */
  ranges(p: string, list: readonly { start: number; end: number }[]): string {
    return list.map((r) => this.anchor(r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`, `${p}:${r.start}`, this.links.lines(p, r.start, r.end), 'range')).join(', ')
  }


  table<T>(cols: readonly string[], rows: readonly T[], render: (row: T) => string, numeric: readonly number[] = []): string {
    if (rows.length === 0) return `<p class="muted">${T.noneFound}</p>`
    const head = cols.map((c, i) => `<th${numeric.includes(i) ? ' class="num"' : ''}>${esc(c)}</th>`).join('')
    const body = rows.slice(0, MAX_ROWS).map(render).join('\n')
    const more = rows.length > MAX_ROWS ? `<tr><td colspan="${cols.length}" class="muted">${T.more(rows.length - MAX_ROWS)}</td></tr>` : ''
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}${more}</tbody></table>`
  }
}

function ratioClass(ratio: number): string {
  return ratio < 0.5 ? 'bad' : ratio < 0.8 ? 'warn' : 'good'
}


function signalStatus(signal: { status: string; message?: string }): string | undefined {
  if (signal.status === 'ok') return undefined
  const label = signal.status === 'error' ? T.reportError : T.notVerified
  return `<p><span class="tag no">${label}</span> <span class="muted small">${esc(signal.message ?? '')}</span></p>`
}

function coverageSection(o: Output, h: Html): string {
  const c = o.signals.coverage
  const status = signalStatus(c)
  let body = status ?? ''
  if (!status && c.total) {
    const { changedExecutableLines: total, coveredLines } = c.total
    const ratio = total === 0 ? 1 : coveredLines / total
    body = `<div class="big">${total === 0 ? '—' : `${(ratio * 100).toFixed(1)}%`}</div><div class="muted small">${coveredLines} / ${total}</div>
<div class="bar ${ratioClass(ratio)}"><span style="width:${(ratio * 100).toFixed(1)}%"></span></div>`
    const reported = c.files.filter((f) => !f.missingFromReport)
    if (reported.length < c.files.length) {
      const rTotal = reported.reduce((n, f) => n + f.changedExecutableLines, 0)
      const rCovered = reported.reduce((n, f) => n + f.coveredLines, 0)
      if (rTotal > 0) body += `<p class="small muted">${esc(T.reportedOnly(`${((rCovered / rTotal) * 100).toFixed(1)}%`, rCovered, rTotal))}</p>`
    }
    const rows = [...c.files].sort((a, b) => Number(a.missingFromReport) - Number(b.missingFromReport) || b.changedExecutableLines - b.coveredLines - (a.changedExecutableLines - a.coveredLines))
    body += h.table(T.coverageCols, rows, (f) => `<tr><td>${h.path(f.path)}${f.missingFromReport ? ` <span class="tag no">${T.missing}</span>` : ''}</td><td class="num">${f.changedExecutableLines}</td><td class="num">${f.coveredLines}</td><td class="ranges">${h.ranges(f.path, f.uncovered)}</td></tr>`, [1, 2])
  }
  if (c.ignoredFiles.length > 0) body += `<details><summary class="small">${T.coverageIgnoredTitle(c.ignoredFiles.length)}</summary><div class="finding-files">${c.ignoredFiles.map((p) => h.path(p)).join('')}</div></details>`
  const excluded = c.excludedByProject ?? []
  if (excluded.length > 0) body += `<details><summary class="small">${T.coverageExcludedTitle(excluded.length)}</summary><div class="finding-files">${excluded.map((p) => h.path(p)).join('')}</div></details>`
  return `<div id="coverage"><h3>${T.coverageTitle}</h3>${body}</div>`
}

function lintSection(o: Output, h: Html): string {
  const l = o.signals.lint
  const status = signalStatus(l)
  if (status || !l.changedLines || !l.otherLines) return `<div id="lint"><h3>${T.lintTitle}</h3>${status ?? ''}</div>`
  const summary = `<p class="small">${esc(T.lintSummary(l.changedLines.errors, l.changedLines.warnings, l.otherLines.errors, l.otherLines.warnings))}</p>`
  const table = h.table(T.lintCols, l.findings, (f) => `<tr><td>${h.loc(f.path, f.line)}</td><td><span class="tag ${f.severity === 'error' ? 'no' : ''}">${esc(f.severity)}</span></td><td><code>${esc(f.rule)}</code></td><td>${esc(f.message)}</td></tr>`)
  const omitted = l.omittedFindings > 0 ? `<p class="muted small">${T.omitted(l.omittedFindings)}</p>` : ''
  return `<div id="lint"><h3>${T.lintTitle}</h3>${summary}${table}${omitted}</div>`
}

function suppressionsAndTests(o: Output, h: Html): string {
  const s = o.signals.suppressions
  const sup = signalStatus(s) ?? h.table(T.suppressionsCols, s.items, (i) => `<tr><td>${h.loc(i.path, i.line)}</td><td><code>${esc(i.kind)}</code></td><td><code>${esc(i.text)}</code></td></tr>`)
  const t = o.signals.testsModified
  const tests = signalStatus(t) ?? h.table(T.testsCols, t.files, (f) => `<tr><td>${h.path(f.path)}${f.oldPath ? ` ← ${h.path(f.oldPath)}` : ''}</td><td><span class="tag ${f.status}">${T.statusNames[f.status]}</span></td><td class="num">${f.linesRemoved}</td></tr>`, [2])
  return `<div class="grid2"><div id="suppressions"><h3>${T.suppressionsTitle}</h3>${sup}</div><div id="tests"><h3>${T.testsTitle}</h3>${tests}</div></div>`
}

function filesSection(o: Output, h: Html): string {
  const roles = ['global', 'manifest', 'lockfile', 'routes', 'schema', 'resolvers', 'source', 'barrel', 'i18n', 'client', 'infra', 'test', 'story', 'excluded'] as const
  const groups = roles
    .map((role) => ({ role, files: o.files.filter((f) => f.role === role) }))
    .filter((g) => g.files.length > 0)
    .map(({ role, files }) => {
      const table = h.table(T.filesCols, files, (f) => {
        const additive = f.additive === undefined ? '' : `<span class="tag ${f.additive ? 'yes' : 'no'}">${f.additive ? T.additiveYes : T.additiveNo}</span>`
        return `<tr><td>${h.path(f.path)}${f.oldPath ? ` ← ${h.path(f.oldPath)}` : ''}</td><td><span class="tag ${f.status}">${T.statusNames[f.status]}</span></td><td class="num">${f.linesAdded}</td><td class="num">${f.linesRemoved}</td><td>${additive}</td></tr>`
      }, [2, 3])
      return `<details${role === 'excluded' || role === 'story' ? '' : ' open'}><summary>${T.roleNames[role]} (${files.length})</summary>${table}</details>`
    })
  const ignored = o.ignoredFiles.length > 0 ? `<details><summary>${T.ignoredTitle} (${o.ignoredFiles.length})</summary><div class="finding-files">${o.ignoredFiles.map((p) => h.path(p)).join('')}</div></details>` : ''
  return `<section class="panel">${groups.join('\n')}${ignored}</section>`
}

function riskSection(o: Output, h: Html): string {
  const r = o.risk
  const counts = (['high', 'medium', 'low'] as const).map((l) => `<div class="stat ${l === 'high' && r.summary.high > 0 ? 'bad' : l === 'medium' && r.summary.medium > 0 ? 'warn' : ''}"><div class="value">${r.summary[l]}</div><div class="label">${T.reachLevel(T.severity[l])}</div></div>`).join('')
  const points = scoreByFile(o)
  const coverage = fileCoverage(o)
  const verified = o.signals.coverage.status === 'ok'
  const findings = (path: string): string => {
    const sec = o.signals.security.findings.filter((x) => x.path === path).length
    const lint = o.signals.lint.findings.filter((x) => x.path === path && x.severity === 'error').length
    const sup = o.signals.suppressions.items.filter((x) => x.path === path).length
    return [sec > 0 ? `<span class="pill bad">${T.riskFindings.security(sec)}</span>` : '', lint > 0 ? `<span class="pill bad">${T.riskFindings.lint(lint)}</span>` : '', sup > 0 ? `<span class="pill warn">${T.riskFindings.suppressions(sup)}</span>` : ''].join('')
  }
  const rows = [...r.files].sort((a, b) => (points.get(b.path) ?? 0) - (points.get(a.path) ?? 0) || (a.path < b.path ? -1 : 1))
  const table = h.table(
    T.riskCols(terms(o.surface)),
    rows,
    (f) => {
      const share = r.totalPages === 0 ? 0 : f.pagesReached / r.totalPages
      const bar = `<div class="mini-bar"><span style="width:${(share * 100).toFixed(1)}%"></span></div>`
      const c = coverage.get(f.path)
      const cov = !verified ? `<span class="muted small">${T.notVerified}</span>` : c === undefined || c.ratio === null ? `<span class="muted small">${esc(c?.label ?? '—')}</span>` : `<span class="pill ${c.ratio < 0.5 ? 'bad' : c.ratio < 0.8 ? 'warn' : 'good'}">${Math.round(c.ratio * 100)}%</span>`
      const graph = T.graphTitle(f.directImporters, f.transitiveDependents, f.centrality.toFixed(3))
      const p = points.get(f.path) ?? 0
      return `<tr data-level="${f.level}" data-change="${f.change}"><td>${h.path(f.path)}</td><td><span class="tag ${f.change === 'added' ? 'added' : f.change === 'deleted' ? 'deleted' : ''}">${T.riskChanges[f.change]}</span></td><td class="num" title="${esc(graph)}"><span class="chip ${f.level}">${T.severity[f.level]}</span> ${f.pagesReached} / ${r.totalPages}${bar}</td><td>${cov}</td><td>${findings(f.path)}</td><td class="num"><span class="file-points inline ${p >= 30 ? 'high' : p >= 12 ? 'medium' : 'low'}">${p}</span></td><td class="small muted">${esc(f.why)}</td></tr>`
    },
    [2, 5],
  )
  const chip = (group: 'level' | 'change', value: string, text: string, n: number): string =>
    n === 0 ? '' : `<label class="filter"><input type="checkbox" data-filter="${group}" value="${value}" checked> ${esc(text)} <span class="muted">(${n})</span></label>`
  const changes = Object.keys(T.riskChanges) as (keyof typeof T.riskChanges)[]
  const filters = `<div class="filters" id="risk-filters"><span class="filter-label">${T.filterLevel}</span>${(['high', 'medium', 'low'] as const).map((l) => chip('level', l, T.severity[l], r.summary[l])).join('')}
<span class="filter-label">${T.filterChange}</span>${changes.map((c) => chip('change', c, T.riskChanges[c], r.files.filter((f) => f.change === c).length)).join('')}<span class="muted small" id="risk-count"></span></div>`
  return `<section class="panel"><p class="small muted">${esc(T.riskIntro(r.totalPages, terms(o.surface)))}</p><div class="stats">${counts}</div>${r.files.length === 0 ? `<p class="muted">${T.noRiskFiles}</p>` : `${filters}<div id="risk-table">${table}</div>`}</section>`
}


function dependenciesSection(o: Output, h: Html): string {
  const d = o.dependencies
  const manifestReasons = o.reasons.filter((r) => r.code === 'manifest-changed' || r.code === 'lockfile-only-change')
  if (d.changes.length === 0 && d.lockfiles.length === 0 && manifestReasons.length === 0) return `<section class="panel"><p class="muted">${T.noDependencyChanges}</p></section>`
  const counts = (Object.keys(T.dependencyCounts) as (keyof typeof T.dependencyCounts)[])
    .map((k) => `<div class="stat ${k === 'critical' && d.summary.critical > 0 ? 'bad' : ''}"><div class="value">${d.summary[k]}</div><div class="label">${T.dependencyCounts[k]}</div></div>`)
    .join('')
  const rows = [...d.changes].sort((a, b) => Number(b.critical) - Number(a.critical))
  const table = h.table(T.dependencyCols, rows, (c) => {
    const section = c.change === 'moved' ? `${esc(c.fromSection ?? '')} → ${esc(c.section)}` : esc(c.section)
    const bump = c.bump === null ? '' : `<span class="tag ${c.bump === 'major' || c.bump === 'unknown' ? 'no' : ''}">${esc(c.bump)}${c.direction === 'downgrade' ? ' ↓' : ''}</span>`
    const status = `<span class="tag ${c.critical ? 'no' : 'yes'}">${c.critical ? T.critical : T.safe}</span>${c.note ? `<div class="muted small">${esc(c.note)}</div>` : ''}`
    return `<tr class="${c.critical ? 'critical' : ''}"><td><code>${esc(c.name)}</code></td><td>${h.path(c.manifest)}</td><td class="small">${section}</td><td>${T.changeNames[c.change]}</td><td><code>${esc(c.from ?? '')}</code></td><td><code>${esc(c.to ?? '')}</code></td><td>${bump}</td><td>${status}</td></tr>`
  })
  const lockfiles = d.lockfiles.length > 0 ? `<h3>${T.lockfilesTitle}</h3><div class="finding-files">${d.lockfiles.map((p) => h.path(p)).join('')}</div>` : ''
  const manifestTable = manifestReasons.length > 0 ? `<h3>${T.manifestChangesTitle}</h3>${h.table(T.manifestCols, manifestReasons, (r) => `<tr class="critical"><td>${r.file ? h.path(r.file) : ''}</td><td>${esc(r.detail)}</td><td><span class="tag no">${T.critical}</span></td></tr>`)}` : ''
  const changesTable = d.changes.length > 0 ? `<h3>${T.packagesTitle}</h3>${table}` : ''
  return `<section class="panel"><p class="small muted">${T.dependenciesIntro}</p><div class="stats">${counts}</div>${manifestTable}${changesTable}${lockfiles}</section>`
}

function reasonsSection(o: Output, h: Html): string {
  const table = h.table(T.reasonsCols, o.reasons, (r) => `<tr class="effect-${REASONS[r.code]}"><td>${esc(REASON_TEXT[r.code])}<div class="muted small"><code>${esc(r.code)}</code></div></td><td>${r.file ? h.path(r.file) : ''}</td><td class="small">${esc(r.detail)}</td></tr>`)
  return `<section class="panel"><details><summary>${T.reasonsTitle} (${o.reasons.length})</summary>${table}</details></section>`
}

function diagnosticsSection(o: Output, h: Html): string {
  const d = o.diagnostics
  const parts = [
    d.error ? `<p><span class="tag no">error</span> ${esc(d.error)}</p>` : '',
    `<h3>${T.dynamicTitle} (${d.dynamicRoutes.length})</h3>${h.table(T.dynamicCols, d.dynamicRoutes, (x) => `<tr><td>${h.loc(x.file, x.line)}</td><td>${esc(x.detail)}</td></tr>`)}`,
    `<h3>${T.unresolvedTitle} (${d.unresolvedImports.length})</h3>${h.table(T.unresolvedCols, d.unresolvedImports, (x) => `<tr><td>${h.loc(x.file, x.line)}</td><td><code>${esc(x.specifier)}</code></td><td>${esc(x.reason)}</td></tr>`)}`,
    `<h3>${T.parseTitle} (${d.parseErrors.length})</h3>${h.table(T.parseCols, d.parseErrors, (x) => `<tr><td>${h.loc(x.file, x.line)}</td><td>${esc(x.message)}</td></tr>`)}`,
    `<h3>${T.timingsTitle}</h3><p class="small"><code>${esc(Object.entries(d.timingsMs).map(([k, v]) => `${k} ${v}`).join(' · '))}</code></p>`,
  ]
  const open = d.error !== null || d.dynamicRoutes.length > 0 || d.parseErrors.length > 0
  return `<section class="panel"><details${open ? ' open' : ''}><summary>${T.diagnosticsTitle}</summary>${parts.join('\n')}</details></section>`
}

function securityBadge(o: Output): string {
  const severe = o.signals.security.summary.high + o.signals.vulnerabilities.related.filter((r) => r.severity === 'critical' || r.severity === 'high').length
  const all = o.signals.security.findings.length + o.signals.vulnerabilities.related.length
  return severe > 0 ? `<span class="count bad">${severe}</span>` : all > 0 ? `<span class="count">${all}</span>` : ''
}

/** Single-file HTML report of an analyze result: the review workbench, with the full analysis as its Details page. */
export function renderHtml(output: Output, links: Linker = NO_LINKS): string {
  const prefix = displayPrefix([...output.files.map((f) => f.path), ...output.routes.affected.flatMap((r) => r.via.flatMap((v) => v.chain))])
  return workbenchPage(output, links, prefix, renderDetails(output, links, prefix))
}

/**
 * The full analysis as a page of its own (shown in a frame of the workbench): reach of every changed file, security,
 * dependencies, signals, contracts, reviewers, routes with their import graphs, files, reasons and diagnostics.
 */
export function renderDetails(output: Output, links: Linker, prefix: string): string {
  const h = new Html(prefix, links)
  if (output.usage?.status === 'ok') {
    const u = usageHits(output)
    h.traffic = { hits: u.byKey, errors: u.errorsByKey, links: u.linkByKey, kind: output.usage.kind }
  }
  const depsCritical = output.dependencies.summary.critical + output.reasons.filter((r) => r.code === 'manifest-changed' || r.code === 'lockfile-only-change').length
  const sections: [keyof typeof T.tabs, string, string][] = [
    ['risk', output.risk.summary.high > 0 ? `<span class="count bad">${output.risk.summary.high}</span>` : '', riskSection(output, h)],
    ['security', securityBadge(output), securitySection(output, h)],
    ['dependencies', depsCritical > 0 ? `<span class="count bad">${depsCritical}</span>` : output.dependencies.changes.length > 0 ? `<span class="count">${output.dependencies.changes.length}</span>` : '', dependenciesSection(output, h)],
    ['signals', '', `<section class="panel">${coverageSection(output, h)}${lintSection(output, h)}${suppressionsAndTests(output, h)}</section>`],
    ...(output.contracts === undefined ? [] : [['contracts', output.contracts.summary.breaking > 0 ? `<span class="count bad">${output.contracts.summary.breaking}</span>` : output.contracts.summary.dangerous > 0 ? `<span class="count">${output.contracts.summary.dangerous}</span>` : '', contractsSection(output)] as [keyof typeof T.tabs, string, string]]),
    ...(output.ownership !== undefined || output.reviewers !== undefined ? [['reviewers', '', reviewersSection(output)] as [keyof typeof T.tabs, string, string]] : []),
    ['routes', output.routes.affected.some((r) => !r.hasChildren) ? `<span class="count">${output.routes.affected.filter((r) => !r.hasChildren).length}</span>` : '', routesSection(output, h, links)],
    ['files', `<span class="count">${output.files.length}</span>`, filesSection(output, h)],
    ['details', '', [reasonsSection(output, h), diagnosticsSection(output, h)].join('\n')],
  ]
  const body = [
    `<nav class="sectionbar">${sections.map(([id, badge]) => `<a href="#${id}">${id === 'routes' ? terms(output.surface).section : T.tabs[id]}${badge}</a>`).join('')}</nav>`,
    ...sections.map(([id, , content]) => `<div class="section" id="${id}"><h2 class="section-title">${id === 'routes' ? terms(output.surface).section : T.tabs[id]}</h2>${content}</div>`),
    `<footer>${esc(T.footer(output.tool.version))}</footer>`,
  ]
  return `<!doctype html>
<html lang="${T.lang}">
<head>
<meta charset="utf-8">
<link rel="icon" type="image/svg+xml" href="${faviconUri('light')}" media="(prefers-color-scheme: light)">
<link rel="icon" type="image/svg+xml" href="${faviconUri('dark')}" media="(prefers-color-scheme: dark)">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(T.pageTitle(output.repo ?? T.unknownRepo))}</title>
<style>${HTML_STYLE}</style>
</head>
<body><main>
${body.join('\n')}
</main>
${THEME_SCRIPT}
${RISK_FILTER_SCRIPT}
${MERMAID_SCRIPT}
${FULLSCREEN_SCRIPT}
</body>
</html>
`
}
