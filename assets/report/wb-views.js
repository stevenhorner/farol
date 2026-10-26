/* farol report, in the browser (2/3): the side rail, the summary and the views of one file, one finding and one
 * dependency manifest. Uses wb-core.js. */
const midCut = (s, n) => (s.length <= n ? s : `${s.slice(0, Math.ceil(n * 0.45))}…${s.slice(s.length - Math.floor(n * 0.55))}`)
const SHADES = ['var(--ink)', 'color-mix(in srgb, var(--ink) 72%, var(--bg))', 'color-mix(in srgb, var(--ink) 52%, var(--bg))', 'color-mix(in srgb, var(--ink) 36%, var(--bg))', 'color-mix(in srgb, var(--ink) 24%, var(--bg))']
const S = coverageSummary()
const ui = { view: 'summary', tierOpen: new Set(), covOpen: false }
const contractGroups = MUST.filter((g) => g.items[0].kind === 'contract')
const breakingKeys = () => (D.contracts ?? []).filter((e) => e.level !== 'safe').map((e) => e.key)
/** Must check as the rail lists it: all contract changes as one item, then each finding and vulnerable dependency. */
const mustList = () => [...(contractGroups.length ? [{ contract: true, groups: contractGroups }] : []), ...MUST.filter((g) => !contractGroups.includes(g)).map((g) => ({ contract: false, groups: [g] }))]
const mustDone = (m) => m.groups.every((g) => !groupActive(g))

function rail() {
  const R = readiness()
  const s = R.s
  const done = FILES.filter(fileDone).length
  const share = shareOf()
  const cov = S
    ? `<div class="metric"><div class="label"><span>${T.rail.tested}</span></div><div class="value${S.ratio < 0.5 ? ' bad' : ''}">${pct(S.ratio)}</div>
    <div class="track"><span style="width:${(S.covered / S.total) * 100}%"></span><span class="bad" style="width:${((S.total - S.covered - S.missingLines) / S.total) * 100}%"></span><span class="hatch" style="width:${(S.missingLines / S.total) * 100}%"></span></div>
    <div class="sub">${t(T.rail.testedSub, { covered: S.covered, total: S.total })}${S.missing.length ? t(T.rail.testedWithout, { ratio: pct(S.reportedRatio), files: pl(S.missing.length, T.files) }) : ''}</div></div>`
    : `<div class="metric"><div class="label"><span>${T.rail.tested}</span></div><div class="value">—</div><div class="sub">${D.coverage.status === 'ok' ? T.rail.noExecutable : T.rail.noReport}</div></div>`
  const item = (f) => {
    const flagged = flagCovered(f.path) && !isReviewed(f.path)
    const on = fileDone(f)
    return `<div class="fi${ui.view === 'file:' + f.path ? ' on' : ''}${on ? ' done' : ''}"><input type="checkbox" data-review-cb="${esc(f.path)}" ${on ? 'checked' : ''} ${flagged ? `disabled title="${esc(T.rail.flagged)}"` : ''} aria-label="${esc(T.rail.reviewedBox)}"><a href="#file:${esc(f.path)}" class="nm" title="${esc(short(f.path))}"><span class="n">${esc(midCut(base(f.path), 25))}</span><span class="dirl">${esc(dir(f.path).replace(/\/$/, '')) || '&nbsp;'}</span></a><span class="r">${on ? '' : share.get(f.path) ?? 0}</span></div>`
  }
  const tiers = filesByTier().map((x) => {
    const count = `${x.files.filter(fileDone).length}/${x.files.length}`
    return x.collapsed
      ? `<details class="tier" ${ui.tierOpen.has(x.id) ? 'open' : ''} data-tier="${x.id}"><summary><span>${x.label}</span><span>${count}</span></summary>${x.files.map(item).join('')}</details>`
      : `<h4><span>${x.label}</span><span>${count}</span></h4>${x.files.map(item).join('')}`
  }).join('')
  const mustItem = (m) => {
    const g = m.groups[0]
    const target = m.contract ? 'contract' : 'finding:' + g.id
    const title = m.contract ? T.must.contract : g.owner ? (g.items[0].kind === 'security' ? T.must.security : T.must.lint) : g.items[0].kind === UNREAD ? T.must.unknown : T.must.vulnerability
    const sub = m.contract ? breakingKeys().join(', ') : g.owner ? `${base(g.owner)}:${findingLine(g)}` : g.items[0].title
    const on = mustDone(m)
    const points = m.groups.reduce((n, x) => n + (POINTS0.get(x.id) ?? 0), 0)
    return `<div class="fi must${ui.view === target ? ' on' : ''}${on ? ' done' : ''}"><input type="checkbox" data-ack="${esc(m.groups.map((x) => x.id).join('|'))}" ${on ? 'checked' : ''} aria-label="${esc(T.rail.checkedBox)}"><a href="#${esc(target)}" class="nm"><span class="n">${esc(title)}</span><span class="dirl">${esc(sub)}</span></a><span class="r">${on ? '' : points}</span></div>`
  }
  const must = mustList()
  const sub = R.ready ? `<span class="ok">${T.rail.ready}</span>` : levelOf(s) === 'low' && R.mustLeft ? t(T.rail.lowButMust, { items: pl(R.mustLeft, T.items) }) : T.verdict[D.verdict]
  document.getElementById('rail').innerHTML = `
  <div class="metric${R.ready ? ' ready' : ''}"><div class="label"><span>${T.rail.risk}</span><span>${T.levels[levelOf(s)]}</span></div><div class="value">${s}<small>/100</small></div>
    <div class="track"><span class="${levelOf(s) === 'high' ? 'bad' : ''}" style="width:${Math.max(s, 1)}%"></span></div>
    <div class="sub">${sub}${s !== SCORE0 ? t(T.rail.was, { score: SCORE0 }) : ''}</div></div>
  ${cov}
  <div class="metric"><div class="label"><span>${T.rail.reviewed}</span><span>${done} / ${FILES.length}</span></div><div class="track"><span style="width:${(done / Math.max(1, FILES.length)) * 100}%"></span></div></div>
  <nav class="nav">
    <a href="#summary" class="${ui.view === 'summary' ? 'on' : ''}"><span class="n">${T.nav.summary}</span></a>
    ${must.length ? `<h4 class="mustcheck"><span>${T.nav.must}</span><span>${must.filter(mustDone).length}/${must.length}</span></h4>${must.map(mustItem).join('')}` : ''}
    ${tiers}
    <h4><span>${T.nav.before}</span></h4>
    ${D.contracts && !contractGroups.length ? `<a href="#contract" class="${ui.view === 'contract' ? 'on' : ''}"><span class="n">${T.nav.contract}</span><span class="r">${T.nav.contractSafe}</span></a>` : ''}
    <a href="#plan" class="${ui.view === 'plan' ? 'on' : ''}"><span class="n">${T.nav.plan}</span><span class="r">${pl(OPS.length, T.entriesPair)}</span></a>
    <a href="#details" class="${ui.view === 'details' ? 'on' : ''}"><span class="n">${T.nav.details}</span></a>
    <h4><span>${T.nav.finish}</span></h4>
    <a href="#results" class="${ui.view === 'results' ? 'on' : ''}"><span class="n">${T.nav.results}</span><span class="r">${T.nav.resultsHint}</span></a>
  </nav>`
}

function summary() {
  const att = attribution()
  const s = liveScore()
  const R = readiness()
  const rows = [...(COV?.files ?? [])].filter((f) => !f.missing).sort((a, b) => (b.total - b.covered) - (a.total - a.covered))
  const missing = (COV?.files ?? []).filter((f) => f.missing).sort((a, b) => b.total - a.total)
  const leftOut = COV?.leftOut ?? []
  const table = S ? `<table class="t"><thead><tr><th>${T.cov.file}</th><th class="num">${T.cov.tested}</th><th class="mini"></th><th>${T.cov.notRun}</th></tr></thead><tbody>${rows.map((f) => `<tr><td class="p">${esc(short(f.path))}</td><td class="num">${f.covered}/${f.total} · ${pct(f.total ? f.covered / f.total : 1)}</td>
    <td class="mini"><div class="track"><span style="width:${f.total ? (f.covered / f.total) * 100 : 100}%"></span><span class="bad" style="width:${f.total ? ((f.total - f.covered) / f.total) * 100 : 0}%"></span></div></td>
    <td class="small muted">${f.uncovered.map(rangeText).join(', ') || '—'}</td></tr>`).join('')}</tbody></table>
    ${missing.length ? `<h3 class="misshead">${t(T.cov.missingTitle, { files: pl(missing.length, T.files) })}</h3><p class="small muted">${T.cov.missingWhy}</p><table class="t"><tbody>${missing.map((f) => `<tr><td class="p">${esc(short(f.path))}</td><td class="num small muted">${pl(f.total, T.changedLines)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${leftOut.length ? `<h3>${t(T.cov.leftOutTitle, { files: pl(leftOut.length, T.files) })}</h3><p class="small muted">${T.cov.leftOutWhy}</p><table class="t"><tbody>${leftOut.map((f) => `<tr><td class="p">${esc(short(f.path))}</td><td class="small muted">${T.cov.leftOutBy[f.by]}</td></tr>`).join('')}</tbody></table>` : ''}`
    : `<p class="muted">${D.coverage.status === 'ok' ? T.rail.noExecutable : T.cov.none}</p>`
  const parts = (() => {
    if (!att.length) return `<p class="muted">${T.summary.allReviewed}</p>`
    const { top, rest } = topParts(att, 11)
    const restPts = rest.reduce((n, a) => n + a.points, 0)
    const segs = [...top.map((a, i) => ({ pts: a.points, color: SHADES[Math.min(i, SHADES.length - 1)], label: groupLabel(a.group), why: groupWhy(a.group), file: a.group.file })), ...(rest.length ? [{ pts: restPts, color: 'color-mix(in srgb, var(--ink) 14%, var(--bg))', label: pl(rest.length, T.otherParts), why: rest.map((a) => groupLabel(a.group)).join(', '), file: null }] : [])]
    return `<div class="stack">${segs.map((x) => `<div style="flex:${x.pts};background:${x.color}" title="${esc(x.label)}: ${x.pts}">${x.pts >= 8 ? x.pts : ''}</div>`).join('')}</div>
    <div class="keys">${segs.map((x) => `<div><i style="background:${x.color}"></i><span title="${esc(x.why)}">${x.file ? `<a href="#file:${esc(x.file)}"><code>${esc(base(x.file))}</code></a>` : esc(x.label)}</span><b>${x.pts}</b></div>`).join('')}</div>`
  })()
  const covLine = S ? t(T.cov.summary, { ratio: pct(S.ratio), covered: S.covered, total: S.total }) + (S.missing.length ? t(T.cov.summaryWithout, { ratio: pct(S.reportedRatio), files: pl(S.missing.length, T.files) }) : '') : T.cov.none
  return `${D.incremental ? `<p class="incremental">${t(T.summary.incremental, { since: esc(D.incremental) })}</p>` : ''}
  <h1>${R.ready ? T.summary.ready : T.verdict[D.verdict]}</h1><p class="lead">${riskLede()}</p>
  ${R.ready ? '' : `<p class="small muted">${MUST.length ? T.summary.startMust : T.summary.start}</p>`}
  ${R.ready ? `<div class="ready-banner"><b>${t(T.summary.readyTitle, { score: s })}</b> ${s !== SCORE0 ? t(T.summary.readyDown, { score: SCORE0 }) : T.summary.readyNothing} <a href="#results">${T.summary.copyResults}</a></div>` : ''}
  ${D.usage ? `<p class="small muted">${esc(D.usage)}</p>` : ''}
  <h2>${t(T.summary.makesUp, { score: s })}</h2>${parts}
  <details class="cov" ${ui.covOpen ? 'open' : ''} id="cov-d"><summary><h2>${T.cov.title}</h2><span class="sumtxt">${covLine}</span><span class="clickhint">${ui.covOpen ? T.cov.hide : T.cov.show}</span></summary>${table}</details>
  <footer>${t(T.footer, { version: esc(D.version) })}</footer>`
}

const factsScore = (path) => `<div><b>${shareOf().get(path) ?? 0}<span class="of"> ${t(T.file.of, { score: liveScore() })}</span></b>${T.file.part}</div>`
const actions = (f, i) => `<button class="primary${isReviewed(f.path) ? ' done' : ''}" data-review="${esc(f.path)}">${isReviewed(f.path) ? T.file.reviewedBtn : T.file.markBtn}</button>${FILES[i + 1] ? `<button class="secondary" data-go="${esc(FILES[i + 1].path)}">${T.file.next}</button>` : ''}${ghFile(f.path) ? `<a class="secondary" href="${esc(ghFile(f.path))}" target="_blank" rel="noopener" title="${esc(T.file.commentTitle)}">${T.file.comment}</a>` : ''}`
const noteBox = (path) => `<h3>${T.file.note}</h3><textarea class="note-in" data-note="${esc(path)}" placeholder="${esc(T.file.notePlaceholder)}">${esc(state.notes[path] ?? '')}</textarea>`

function fileView(path) {
  const f = FILES.find((x) => x.path === path)
  if (!f) return summary()
  if (f.extra === 'dependency') return depView(f)
  const i = FILES.indexOf(f)
  const cf = covOf(path)
  const entries = f.entries ?? []
  const owners = D.reviewers.filter((r) => r.files.includes(path))
  const errors = D.fileErrors[path]
  const covFact = cf ? (cf.missing ? `<div><b class="bad">—</b>${T.file.notInReport}</div>` : cf.total === 0 ? `<div><b>—</b>${T.file.declarations}</div>` : `<div><b class="${cf.covered / cf.total < 0.5 ? 'bad' : ''}">${pct(cf.covered / cf.total)}</b>${t(T.file.linesTested, { covered: cf.covered, total: cf.total })}</div>`) : `<div><b>—</b>${esc(f.coverage ?? T.file.noCoverage)}</div>`
  return `<div class="fhead"><div class="grow"><div class="muted small">${t(T.file.position, { i: i + 1, n: FILES.length, change: esc(f.change ?? '') })}</div><div class="fpath"><span class="d">${esc(dir(path))}</span>${esc(base(path))}</div><div class="muted small">${esc(f.why ?? '')}</div></div>${actions(f, i)}</div>
  ${MUST.filter((g) => g.owner === path).map(findingBox).join('')}
  ${f.extra === 'tests' ? `<div class="mustbox done"><h3>${T.file.testTitle}</h3><p>${t(T.file.testWhy, { why: esc(f.why) })}</p></div>` : ''}
  <div class="facts">${factsScore(path)}${f.extra ? '' : `<div><b>${f.reached}<span class="of"> / ${D.totalEntries}</span></b>${t(T.file.reach, { many: TERM.many })}</div>${covFact}`}${errors ? `<div><b class="bad">${errors.errors}</b>${errors.url ? `<a href="${esc(errors.url)}" target="_blank" rel="noopener">${T.file.errors}</a>` : T.file.errors}</div>` : ''}</div>
  <div class="cols"><div>${renderDiff(path)}</div>
  <div class="aside">${noteBox(path)}<h3>${t(T.file.entries, { Many: TERM.Many })}</h3><ul>${entries.slice(0, 12).map((e) => `<li>${esc(e)}</li>`).join('') || `<li class="pp muted">${T.none}</li>`}${entries.length > 12 ? `<li class="pp muted">${t(T.andMore, { n: entries.length - 12 })}</li>` : ''}</ul>
  <h3>${T.file.knows}</h3><ul>${owners.map((r) => `<li class="pp">${esc(r.name)} <span class="muted">· ${esc(r.note)}</span></li>`).join('') || `<li class="pp muted">${T.file.noHistory}</li>`}</ul></div></div>`
}

function findingBox(g) {
  const it = g.items[0]
  const line = findingLine(g)
  const sec = it.kind === 'security' ? D.security.find((x) => x.path === g.owner && x.line === line) : null
  const lint = D.lint.find((x) => x.path === g.owner && x.line === line)
  const on = !groupActive(g)
  const url = ghLine(g.owner, 'R', line)
  return `<div class="mustbox${on ? ' done' : ''}"><h3>${it.kind === 'security' ? t(T.finding.security, { severity: esc(sec?.severity ?? '') }) : t(T.finding.lint, { rule: esc(lint?.rule ?? '') })} <a href="#" data-jump="${line}">${t(T.finding.atLine, { line })}</a></h3>
    <p>${esc(sec?.message ?? lint?.message ?? it.title)}</p>${sec?.text ? `<code class="snip">${esc(sec.text)}</code>` : ''}
    <label class="ack"><input type="checkbox" data-ack="${esc(g.id)}" ${on ? 'checked' : ''}> ${it.kind === 'security' ? T.finding.ackSecurity : T.finding.ackLint}</label>${url ? ` <a class="small" href="${esc(url)}" target="_blank" rel="noopener">${t(T.finding.comment, { line })}</a>` : ''}</div>`
}

function findingView(id) {
  const g = MUST.find((x) => x.id === id)
  if (!g) return summary()
  if (!g.owner) {
    const on = !groupActive(g)
    const unread = g.items[0].kind === UNREAD
    return `<div class="muted small">${T.nav.must}</div><h1>${unread ? T.must.unknown : T.must.vulnerability}</h1><div class="mustbox${on ? ' done' : ''}"><p>${esc(g.items[0].title)}</p>${unread ? `<p class="small muted">${T.finding.unknownWhy}</p>` : ''}<label class="ack"><input type="checkbox" data-ack="${esc(g.id)}" ${on ? 'checked' : ''}> ${unread ? T.finding.ackUnknown : T.finding.ackVulnerability}</label></div>`
  }
  return `<div class="muted small">${T.nav.must}</div><h1>${esc(groupLabel(g))}</h1><p class="lead">${t(T.finding.lead, { points: POINTS0.get(id) ?? 0 })}</p>
  ${findingBox(g)}<p class="small"><a href="#file:${esc(g.owner)}">${t(T.finding.open, { file: esc(base(g.owner)) })}</a></p>${renderDiff(g.owner)}`
}

function depView(f) {
  const i = FILES.indexOf(f)
  const list = D.dependencies.filter((c) => c.manifest === f.path)
  const card = (c) => {
    const key = c.change === 'removed' ? 'removed' : c.change === 'added' ? 'added' : c.change === 'moved' ? 'moved' : /^(minor bump of a 0\.x|patch bump of a 0\.0)/.test(c.note ?? '') ? 'zeroMinor' : c.bump ?? 'unknown'
    const npm = f.path.endsWith('package.json') ? `https://www.npmjs.com/package/${c.name}?activeTab=versions` : null
    const tag = key === 'zeroMinor' ? T.dep.zeroMinorTag : c.bump ?? c.change
    return `<div class="dep"><span class="nm">${esc(c.name)}</span><span class="sec">${esc(c.section)}</span>
      <div class="ver">${c.from ? esc(c.from) : `<span class="muted">${T.dep.none}</span>`}<span class="arrow">→</span>${c.to ? esc(c.to) : `<span class="muted">${T.dep.removed}</span>`}<span class="bump${c.critical ? ' bad' : ''}">${esc(tag)}</span></div>
      <p class="mean">${T.dep.means[key] ?? T.dep.means.unknown}</p>
      <div class="diff"><table><tr class="d-hunk"><td colspan="2">${esc(t(T.dep.where, { section: c.section, file: base(f.path) }))}</td></tr>${c.from ? `<tr class="d-del"><td class="d-n">−</td><td class="d-c">"${esc(c.name)}": "${esc(c.from)}"</td></tr>` : ''}${c.to ? `<tr class="d-add"><td class="d-n">+</td><td class="d-c">"${esc(c.name)}": "${esc(c.to)}"</td></tr>` : ''}</table></div>
      ${c.critical ? `<h4>${T.dep.howTitle}</h4><ol><li>${t(T.dep.how1, { from: esc(c.from ?? ''), to: esc(c.to ?? '') })}${npm ? ` (<a href="${esc(npm)}" target="_blank" rel="noopener">${T.dep.npm}</a>)` : ''}</li><li>${t(T.dep.how2, { name: `<code>${esc(c.name)}</code>` })}</li><li>${t(T.dep.how3, { one: TERM.one })}</li></ol>` : ''}</div>`
  }
  return `<div class="fhead"><div class="grow"><div class="muted small">${t(T.file.position, { i: i + 1, n: FILES.length, change: T.dep.change })}</div><div class="fpath"><span class="d">${esc(dir(f.path))}</span>${esc(base(f.path))}</div><div class="muted small">${pl(list.length, T.packages)}</div></div>${actions(f, i)}</div>
  <div class="facts">${factsScore(f.path)}</div>
  <div class="cols"><div>${list.map(card).join('') || `<p class="muted">${esc(f.why)}</p>`}</div><div class="aside">${noteBox(f.path)}</div></div>`
}
