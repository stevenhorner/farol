import { posix } from 'node:path'
import type { Output } from '../output/schema.js'
import type { Linker } from './links.js'
import { code, esc, fileMd, locationMd } from './markdown-format.js'
import { fileCoverage, mergeScore } from './merge-score.js'
import { reviewParts, tierOf, type ReviewPart } from './review-parts.js'
import { COMMENT_TEXT as C } from './strings-comment.js'
import { workbenchText } from './strings-workbench.js'
import { terms } from './strings.js'
import { computeVerdict } from './verdict.js'

/** Files listed by name at most; the others are summed up in one line. */
const MAX_FILES = 8

const fill = (text: string, values: Record<string, string | number>): string => text.replace(/\{(\w+)\}/g, (m, k: string) => (values[k] === undefined ? m : String(values[k])))
const listAnd = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1] ?? ''}`)
const isTests = (p: ReviewPart): boolean => p.items.every((i) => i.kind === 'tests')

/** One sentence on where the risk comes from (its two largest parts) and how far the change reaches, as in the report. */
function lede(o: Output, parts: readonly ReviewPart[], why: ReadonlyMap<string, string | null>, codeFiles: number): string {
  const L = workbenchText(o.surface).lede
  const top = parts.filter((p) => p.points > 0).slice(0, 2).map((p) => {
    const first = p.items[0]
    if (p.kind === 'contract') return fill(L.contract, { key: code(o.contracts?.entries.find((e) => e.level !== 'safe')?.key ?? '') })
    if (p.kind === 'finding') return fill(first?.kind === 'security' ? L.security : L.lint, { file: code(posix.basename(p.file ?? '')) })
    if (p.kind === 'unread') return fill(L.unknown, { what: esc((first?.title ?? '').slice((first?.title ?? '').indexOf(': ') + 2), 160) })
    if (p.file === null) return esc(first?.title ?? '', 160)
    const file = code(posix.basename(p.file))
    if (p.items.some((i) => i.kind === 'global')) return fill(L.global, { file })
    const dep = o.dependencies.changes.filter((c) => c.manifest === p.file && p.items.some((i) => i.kind === 'dependency' && i.title.startsWith(`${c.name} `))).sort((a, b) => Number(b.critical) - Number(a.critical))[0]
    if (dep !== undefined) return dep.from !== null && dep.to !== null ? fill(dep.critical ? L.bumpMayBreak : L.bump, { name: code(dep.name), from: esc(dep.from), to: esc(dep.to) }) : fill(L.dependency, { name: code(dep.name), change: dep.change })
    if (isTests(p)) return fill(L.tests, { file })
    const reason = why.get(p.file)
    return reason ? fill(L.file, { file, why: esc(reason, 160) }) : file
  })
  const t = terms(o.surface)
  const affected = o.routes.affected.filter((r) => !r.hasChildren).length
  const added = o.routes.added.filter((r) => !r.hasChildren).length
  const reach = fill(L.reach, { files: `${codeFiles} code file${codeFiles === 1 ? '' : 's'}`, n: affected, total: o.risk.totalPages, many: t.many })
  const plus = added > 0 ? fill(L.added, { what: `${added} new ${added === 1 ? t.one : t.many}` }) : ''
  return `${top.length > 0 ? `${fill(L.top, { parts: listAnd(top) })} ` : ''}${reach}${plus}.`
}

function mustLines(o: Output, parts: readonly ReviewPart[], l: Linker): string[] {
  const lines: string[] = []
  const contracts = parts.filter((p) => p.kind === 'contract')
  if (contracts.length > 0) {
    const entries = (o.contracts?.entries ?? []).filter((e) => e.level !== 'safe')
    const breaking = entries.filter((e) => e.level === 'breaking').map((e) => code(e.key))
    const text = breaking.length > 0 ? C.contract(breaking.join(', ')) : C.contractDangerous(entries.map((e) => code(e.key)).join(', '))
    lines.push(`- [ ] ${text} — **${contracts.reduce((n, p) => n + p.points, 0)}**`)
  }
  for (const p of parts.filter((x) => x.kind === 'finding' || x.kind === 'vulnerability' || x.kind === 'unread')) {
    const item = p.items[0]
    if (item === undefined) continue
    if (p.kind === 'vulnerability' || p.kind === 'unread') {
      lines.push(`- [ ] ${p.kind === 'unread' ? `⚠ ${C.unread(esc(item.title, 200))}` : C.vulnerability(esc(item.title, 200))} — **${p.points}**`)
      continue
    }
    const path = p.file ?? ''
    const where = locationMd(l, path, p.line ?? 0, posix.basename(path))
    if (item.kind === 'security') {
      const s = o.signals.security.findings.find((f) => f.path === path && f.line === p.line)
      lines.push(`- [ ] 🔴 ${C.security(where, s?.severity ?? '', code(s?.rule ?? ''), esc(s?.message ?? item.title, 160))} — **${p.points}**`)
    } else {
      const f = o.signals.lint.findings.find((x) => x.path === path && x.line === p.line && x.severity === 'error')
      lines.push(`- [ ] ${C.lint(where, code(f?.rule ?? ''), esc(f?.message ?? item.title, 160))} — **${p.points}**`)
    }
  }
  return lines
}

/**
 * The top of the PR comment: the same reading as the HTML report. Merge risk and verdict, where the risk comes from,
 * what must be checked by hand, then the files by risk with their share of the score, and how much new code is tested.
 */
export function reviewSection(o: Output, l: Linker, reportUrl: string | undefined): string[] {
  const { score, level, items } = mergeScore(o)
  const verdict = computeVerdict(o)
  const parts = reviewParts(items)
  const coverage = fileCoverage(o)
  const codeFiles = [...verdict.startHere, ...verdict.skim]
  const byPath = new Map(codeFiles.map((f) => [f.path, f]))
  const must = mustLines(o, parts, l)
  const ready = level === 'low' && must.length === 0
  const lines = [C.title(score, level, C.verdict[verdict.level]), '', lede(o, parts, new Map(codeFiles.map((f) => [f.path, f.why])), codeFiles.length)]
  if (ready) lines.push('', C.ready)
  lines.push('', reportUrl === undefined ? `<sub>${C.shadow}</sub>` : `${C.workbench(reportUrl)} ${C.shadow}`)
  if (must.length > 0) lines.push('', C.must, ...must)

  const files = parts.filter((p) => p.kind === 'file' && p.file !== null && !isTests(p))
  const shown = files.filter((p) => tierOf(p) !== 'skim').sort((a, b) => b.own - a.own || b.points - a.points).slice(0, MAX_FILES)
  const rest = parts.filter((p) => p.kind === 'file' && !shown.includes(p))
  const t = terms(o.surface)
  if (shown.length > 0 || rest.length > 0) {
    lines.push('', C.files(score))
    for (const p of shown) {
      const path = p.file ?? ''
      const f = byPath.get(path)
      const reach = f !== undefined && f.pagesReached > 0 ? C.reach(f.pagesReached, o.risk.totalPages, t.many) : null
      lines.push(`- ${C.tier[tierOf(p) === 'high' ? 'high' : 'medium']} ${fileMd(l, path)} ${C.file(p.points, coverage.get(path)?.label ?? null, reach)}`)
    }
    if (rest.length > 0) lines.push(C.restLine(C.rest(rest.filter((p) => !isTests(p)).length, rest.filter(isTests).length), rest.reduce((n, p) => n + p.points, 0), shown.length === 0))
  }
  for (const p of parts.filter((x) => x.kind === 'other' && x.points > 0)) lines.push(C.other(esc(p.items[0]?.title ?? '', 200), p.points))

  const c = o.signals.coverage
  if (c.status === 'ok' && c.total !== null && c.total.changedExecutableLines > 0) {
    const reported = c.files.filter((f) => !f.missingFromReport)
    const rTotal = reported.reduce((n, f) => n + f.changedExecutableLines, 0)
    const rCovered = reported.reduce((n, f) => n + f.coveredLines, 0)
    const missing = c.files.length - reported.length
    const pct = (r: number): string => `${Math.round(r * 100)}%`
    const leftOut = c.ignoredFiles.length + (c.excludedByProject?.length ?? 0)
    lines.push('', `${C.tested(pct(c.total.coveredLines / c.total.changedExecutableLines), c.total.coveredLines, c.total.changedExecutableLines)}${missing > 0 ? C.testedWithout(pct(rTotal === 0 ? 1 : rCovered / rTotal), missing) : ''}${leftOut > 0 ? C.leftOut(leftOut) : ''}`)
  }
  return lines
}
