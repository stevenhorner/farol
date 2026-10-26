/* farol report, in the browser (1/3): review state, live score, attribution, tiers, coverage, diffs and the
 * pages/operations list. Reads window.FAROL = { D: view model (src/report/workbench-model.ts), T: texts
 * (src/report/strings-workbench.ts) }. No user-facing text here: every text comes from T. */
const { D, T } = window.FAROL
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
/** Fills {name} placeholders of a text. */
const t = (text, values = {}) => String(text).replace(/\{(\w+)\}/g, (m, k) => (values[k] === undefined ? m : String(values[k])))
/** "1 file" / "3 files", from a [one, many] pair of T. */
const pl = (n, pair) => t(n === 1 ? pair[0] : pair[1], { n })
const short = (p) => (p && D.prefix && p.startsWith(D.prefix) ? p.slice(D.prefix.length) : p ?? '')
const base = (p) => (p ?? '').split('/').pop()
const dir = (p) => { const s = short(p).split('/'); s.pop(); return s.length ? s.join('/') + '/' : '' }
const pct = (r) => `${Math.round(r * 100)}%`
const listText = (xs) => (xs.length <= 1 ? xs.join('') : t(T.listAnd, { items: xs.slice(0, -1).join(', '), last: xs[xs.length - 1] }))
const TERM = D.term

/* Review state, kept in this browser per commit. */
const KEY = `farol-review:${D.repo ?? ''}:${D.head}:${D.surface}`
const EMPTY = () => ({ reviewed: [], acked: [], tested: [], flagged: [], notes: {} })
const state = (() => { try { return { ...EMPTY(), ...JSON.parse(localStorage.getItem(KEY)) } } catch { return EMPTY() } })()
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* private window: state lives until the page closes */ } }
const listeners = []
const onChange = (fn) => listeners.push(fn)
const emit = () => { save(); listeners.forEach((fn) => fn()) }
const setIn = (list, id, on) => { const set = new Set(state[list]); if (on) set.add(id); else set.delete(id); state[list] = [...set] }
const toggle = (list, id, on) => { setIn(list, id, on ?? !state[list].includes(id)); emit() }
const isReviewed = (file) => state.reviewed.includes(file)
const isAcked = (id) => state.acked.includes(id)

/* Feature flags: a changed file whose pages/operations all ship behind a flag leaves the score, like a reviewed one. */
const OPS = D.ops
const FILE_OPS = new Map()
for (const op of OPS) for (const f of op.files) FILE_OPS.set(f, [...(FILE_OPS.get(f) ?? []), op.key])
const isFlagged = (key) => state.flagged.includes(key)
const flagCovered = (file) => { const keys = FILE_OPS.get(file); return !!keys?.length && keys.every(isFlagged) }

/* Score groups: one per file, one per finding (security, lint: checked on their own, not by reviewing the file), and
 * one per item without a file (contract, vulnerable dependency, analysis problems). The PR comment splits the score
 * the same way (src/report/review-parts.ts). */
const FINDING_KINDS = new Set(['security', 'lint'])
const lineOf = (title) => Number(title.match(/at line (\d+)/)?.[1] ?? 0)
const logOf = (items) => items.reduce((s, it) => s - Math.log(1 - it.weight), 0)
/* Something farol could not read (a route path computed at run time…): checked by hand, not by reviewing the file. */
const UNREAD = 'unknown'
const GROUPS = D.groups.flatMap((g, i) => {
  const rest = g.items.filter((it) => !(g.file && (FINDING_KINDS.has(it.kind) || it.kind === UNREAD)))
  const findings = g.file ? g.items.filter((it) => FINDING_KINDS.has(it.kind)) : []
  const unread = g.file ? g.items.filter((it) => it.kind === UNREAD) : []
  return [
    ...(rest.length ? [{ file: g.file, items: rest, id: g.file ?? `item:${g.items[0].kind}:${i}`, log: logOf(rest) }] : []),
    ...findings.map((it) => ({ file: null, owner: g.file, items: [it], id: `finding:${it.kind}:${g.file}:${lineOf(it.title)}`, log: logOf([it]) })),
    ...unread.map((it, j) => ({ file: null, items: [it], id: `unread:${g.file}:${j}`, log: logOf([it]) })),
  ]
})
const groupActive = (g) => (g.file ? !isReviewed(g.file) && !flagCovered(g.file) : !isAcked(g.id))
/** What must be checked by hand, above every file: breaking contracts, security findings, lint errors, vulnerable dependencies. */
const isMust = (g) => g.owner != null || g.items.every((i) => i.kind === 'contract' || i.kind === 'vulnerability' || i.kind === UNREAD)
const MUST = GROUPS.filter(isMust)
/** Removable by the reviewer: files by reviewing them, the rest of Must check by checking it. */
const groupRemovable = (g) => g.file !== null || isMust(g)
const findingLine = (g) => lineOf(g.items[0].title)
const SCORE0 = Math.round(100 * (1 - Math.exp(-GROUPS.reduce((n, g) => n + g.log, 0))))

function liveScore() {
  const L = GROUPS.filter(groupActive).reduce((s, g) => s + g.log, 0)
  return Math.round(100 * (1 - Math.exp(-L)))
}
/** Integer shares of the score that add up to it (log attribution, largest remainder). */
function shares(groups) {
  const L = groups.reduce((s, g) => s + g.log, 0)
  const score = 100 * (1 - Math.exp(-L))
  const rows = groups.map((g) => { const v = L === 0 ? 0 : (score * g.log) / L; return { group: g, v, points: Math.floor(v) } })
  let left = Math.round(score) - rows.reduce((s, r) => s + r.points, 0)
  ;[...rows].sort((a, b) => (b.v - b.points) - (a.v - a.points)).forEach((r) => { if (left > 0) { r.points++; left-- } })
  return rows.sort((a, b) => b.v - a.v)
}
/** Share of the current score owed to each part still active. */
const attribution = () => shares(GROUPS.filter(groupActive))
/** Shares with nothing reviewed: the points each part had at first. */
const attributionAll = () => shares(GROUPS)
const POINTS0 = new Map(attributionAll().map((a) => [a.group.id, a.points]))
/** Each file's share of the current score: what ticking it removes now. */
const shareOf = () => new Map(attribution().filter((a) => a.group.file).map((a) => [a.group.file, a.points]))
function topParts(att, max) {
  const list = att.filter((a) => a.points > 0)
  return list.length <= max + 1 ? { top: list, rest: [] } : { top: list.slice(0, max), rest: list.slice(max) }
}
const levelOf = (s) => (s >= 60 ? 'high' : s >= 30 ? 'medium' : 'low')
/** A low score and nothing left in Must check: what is left looks safe to approve. */
function readiness() {
  const s = liveScore()
  const mustLeft = MUST.filter(groupActive).length
  return { s, mustLeft, ready: levelOf(s) === 'low' && mustLeft === 0 }
}

/* Files to review: their own points leave the findings out, so tiers rank the code change itself. */
const FILES = D.files.map((f) => { const g = GROUPS.find((x) => x.file === f.path); return { ...f, points: g ? Math.round(100 * (1 - Math.exp(-g.log))) : 0 } })
  .sort((a, b) => b.points - a.points || (a.path < b.path ? -1 : 1))
const TIERS = [{ id: 'high', min: 20 }, { id: 'medium', min: 5 }, { id: 'skim', min: -1, collapsed: true }, { id: 'tests', min: Infinity, collapsed: true }]
const tierOf = (f) => (f.extra === 'tests' ? 'tests' : TIERS.find((x) => f.points >= x.min).id)
const filesByTier = () => TIERS.map((x) => ({ ...x, label: T.tiers[x.id], files: FILES.filter((f) => tierOf(f) === x.id) })).filter((x) => x.files.length)
const fileDone = (f) => isReviewed(f.path) || flagCovered(f.path)

function groupLabel(g) {
  if (g.file) return short(g.file)
  const it = g.items[0]
  if (g.owner) return t(it.kind === 'security' ? T.must.securityAt : T.must.lintAt, { file: base(g.owner), line: findingLine(g) })
  return T.kinds[it.kind] ?? it.kind
}
function groupWhy(g) {
  const f = g.file && FILES.find((x) => x.path === g.file)
  if (f && f.why) return f.why
  return g.items.map((i) => i.title).join(' · ')
}

/** One sentence on where the risk comes from (the two largest parts at first) and how far the change reaches. */
function riskLede() {
  const top = attributionAll().filter((a) => a.points > 0).slice(0, 2).map(({ group: g }) => {
    const it = g.items[0]
    if (it.kind === 'contract') return t(T.lede.contract, { key: `<code>${esc(it.title.match(/of (.+?):/)?.[1] ?? '')}</code>` })
    if (g.owner) return t(it.kind === 'security' ? T.lede.security : T.lede.lint, { file: `<code>${esc(base(g.owner))}</code>` })
    if (it.kind === UNREAD) return t(T.lede.unknown, { what: esc(it.title.slice(it.title.indexOf(': ') + 2)) })
    if (!g.file) return esc(it.title)
    const code = `<code>${esc(base(g.file))}</code>`
    if (g.items.some((i) => i.kind === 'global')) return t(T.lede.global, { file: code })
    const deps = D.dependencies.filter((c) => c.manifest === g.file && g.items.some((i) => i.kind === 'dependency' && i.title.startsWith(c.name + ' ')))
    if (deps.length) {
      const c = [...deps].sort((a, b) => Number(b.critical) - Number(a.critical))[0]
      return c.from && c.to ? t(c.critical ? T.lede.bumpMayBreak : T.lede.bump, { name: `<code>${esc(c.name)}</code>`, from: esc(c.from), to: esc(c.to) }) : t(T.lede.dependency, { name: `<code>${esc(c.name)}</code>`, change: esc(c.change) })
    }
    if (it.kind === 'tests') return t(T.lede.tests, { file: code })
    const f = FILES.find((x) => x.path === g.file)
    return f?.why ? t(T.lede.file, { file: code, why: esc(f.why) }) : code
  })
  const code = FILES.filter((f) => !f.extra).length
  const reach = t(T.lede.reach, { files: pl(code, T.codeFiles), n: D.routes.affected, total: D.totalEntries, many: TERM.many })
  const added = D.routes.added ? t(T.lede.added, { what: pl(D.routes.added, T.newEntries) }) : ''
  return `${top.length ? t(T.lede.top, { parts: listText(top) }) + ' ' : ''}${reach}${added}.`
}

/* Coverage of the changed lines. */
const COV = D.coverage.status === 'ok' ? D.coverage : null
const covOf = (path) => COV?.files.find((f) => f.path === path) ?? null
function coverageSummary() {
  if (!COV || !COV.total) return null
  const reported = COV.files.filter((f) => !f.missing)
  const rTotal = reported.reduce((s, f) => s + f.total, 0)
  const rCovered = reported.reduce((s, f) => s + f.covered, 0)
  const missing = COV.files.filter((f) => f.missing)
  return { ratio: COV.covered / COV.total, covered: COV.covered, total: COV.total, missing, missingLines: missing.reduce((s, f) => s + f.total, 0), reportedRatio: rTotal ? rCovered / rTotal : 1 }
}
const inRanges = (line, ranges) => ranges.some((r) => line >= r.start && line <= r.end)
const rangeText = (r) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`)

/* GitHub: a changed file in the pull request, and one line of it (where a comment can be left). */
const ghFile = (path) => D.links.files[path] ?? null
const ghLine = (path, side, n) => (D.links.files[path] ? `${D.links.files[path]}${side}${n}` : null)

/** Findings on a file's lines, to annotate its diff. */
function notesOf(path) {
  const notes = []
  for (const s of D.security) if (s.path === path) notes.push({ line: s.line, tone: 'bad', label: t(T.diff.security, { severity: s.severity }), text: s.message })
  for (const l of D.lint) if (l.path === path && !D.security.some((s) => s.path === path && s.line === l.line)) notes.push({ line: l.line, tone: '', label: t(T.diff.lint, { rule: l.rule }), text: l.message })
  for (const s of D.suppressions) if (s.path === path) notes.push({ line: s.line, tone: '', label: t(T.diff.suppression, { kind: s.kind }), text: s.text })
  return notes
}
function addedLines(path) {
  const out = new Map()
  for (const h of D.diffs[path] ?? []) {
    let n = h.newStart
    for (const line of h.lines) { if (line[0] === '+') out.set(n++, line.slice(1)); else if (line[0] !== '-') n++ }
  }
  return out
}
/** One sentence on a file's diff coverage, with links that jump to each stretch that never ran. */
function coverageNote(path) {
  const cf = covOf(path)
  if (!cf) return COV ? '' : `<div class="covhead">${T.diff.noReport}</div>`
  if (cf.missing) return `<div class="covhead bad">${t(T.diff.missing, { n: cf.total })}</div>`
  if (cf.total === 0) return `<div class="covhead">${T.diff.declarations}</div>`
  const added = addedLines(path)
  const blocks = cf.uncovered.filter((r) => [...added.keys()].some((k) => k >= r.start && k <= r.end))
  if (!blocks.length) return `<div class="covhead">${t(T.diff.allRan, { n: cf.total })}</div>`
  const links = blocks.map((b) => `<a href="#" data-jump="${b.start}">${rangeText(b)}</a>`)
  return `<div class="covhead bad">${t(T.diff.someRan, { covered: cf.covered, total: cf.total, missing: pl(cf.total - cf.covered, T.lines), ranges: listText(links) })}</div>`
}
const lnk = (path, side, n) => { const url = ghLine(path, side, n); return url ? `<a class="d-gh" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(T.diff.commentLine)}">${n}</a>` : n }
/** Unified diff of a file; lines the tests never ran are marked and each stretch of them is labeled. */
function renderDiff(path, maxLines = 1500) {
  const hunks = D.diffs[path]
  if (!hunks) return `<p class="muted small">${T.diff.none}${ghFile(path) ? ` <a href="${esc(ghFile(path))}" target="_blank" rel="noopener">${T.diff.seeInPr}</a>` : ''}</p>`
  const cf = covOf(path)
  const marks = cf && !cf.missing && cf.total > 0
  const notes = notesOf(path)
  const added = addedLines(path)
  let rows = ''
  let count = 0
  let inBlock = false
  for (const h of hunks) {
    rows += `<tr class="d-hunk"><td colspan="3">${esc(h.header)}</td></tr>`
    let o = h.oldStart
    let n = h.newStart
    for (const line of h.lines) {
      if (count++ > maxLines) break
      const kind = line[0]
      const text = esc(line.slice(1)) || ' '
      if (kind === '+') {
        const unc = marks && inRanges(n, cf.uncovered)
        if (unc && !inBlock) {
          const r = cf.uncovered.find((x) => n >= x.start && n <= x.end)
          const shown = [...added.keys()].filter((k) => k >= r.start && k <= r.end)
          rows += `<tr class="d-unclabel" data-ln="${n}"><td colspan="2"></td><td>${t(T.diff.notRun, { lines: rangeText({ start: shown[0] ?? r.start, end: shown[shown.length - 1] ?? r.end }) })}</td></tr>`
        }
        inBlock = unc
        rows += `<tr class="d-add${unc ? ' d-unc' : ''}" data-new="${n}"><td class="d-n"></td><td class="d-n">${lnk(path, 'R', n)}</td><td class="d-c">${text}</td></tr>`
        for (const nt of notes.filter((x) => x.line === n)) rows += `<tr class="d-note"><td colspan="2"></td><td><div class="note ${nt.tone}"><b>${esc(nt.label)}</b> ${esc(nt.text)}</div></td></tr>`
        n++
      } else if (kind === '-') {
        rows += `<tr class="d-del"><td class="d-n">${lnk(path, 'L', o)}</td><td class="d-n"></td><td class="d-c">${text}</td></tr>`
        o++
      } else {
        inBlock = false
        rows += `<tr data-new="${n}"><td class="d-n">${o}</td><td class="d-n">${lnk(path, 'R', n)}</td><td class="d-c">${text}</td></tr>`
        o++
        n++
      }
    }
  }
  return `<div class="diffbox">${ghFile(path) ? `<div class="ghhint">${T.diff.hint}</div>` : ''}${coverageNote(path)}<div class="diff"><table>${rows}</table></div></div>`
}
/** Scrolls a diff to a line and flashes it. */
function flashRow(row) {
  if (!row) return
  row.scrollIntoView({ behavior: 'smooth', block: 'center' })
  row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash')
}
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('[data-jump]')
  if (!a) return
  e.preventDefault()
  flashRow(document.querySelector(`tr[data-ln="${a.dataset.jump}"]`) ?? document.querySelector(`tr[data-new="${a.dataset.jump}"]`))
})

/* Theme: follows the system, with a manual override. */
function initTheme(button) {
  const root = document.documentElement
  try { const saved = localStorage.getItem('farol-theme'); if (saved) root.dataset.theme = saved } catch { /* no storage */ }
  button?.addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
    root.dataset.theme = dark ? 'light' : 'dark'
    try { localStorage.setItem('farol-theme', root.dataset.theme) } catch { /* no storage */ }
    window.dispatchEvent(new Event('farol-theme'))
  })
}
