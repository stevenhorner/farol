import type { Output } from '../output/schema.js'
import { ASSETS } from './html-assets.js'
import type { Linker } from './links.js'
import { faviconUri, logoSvg } from './logo.js'
import { workbenchText } from './strings-workbench.js'
import { workbenchModel } from './workbench-model.js'

function esc(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/** JSON inside a <script> element: `<` escaped so the text can never close the element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

function asset(name: string): string {
  const text = ASSETS[name]
  if (text === undefined) throw new Error(`internal: report asset ${name} is missing (npm run assets)`)
  return text
}

/** Browser scripts of the workbench, in load order (they share the page's global scope). */
const SCRIPTS = ['report/wb-highlight.js', 'report/wb-core.js', 'report/wb-views.js', 'report/wb-pages.js'] as const

/**
 * The HTML report: a review workbench. The side rail holds the live merge risk, what must be checked by hand and the
 * files by risk tier, each with a "reviewed" box; the main area shows the summary, one file with its diff and test
 * coverage, what the change can affect, the details of the analysis (`details`, a page of its own shown in a frame)
 * and the results to paste in the pull request. Everything is rendered in the browser from one JSON model.
 */
export function workbenchPage(o: Output, links: Linker, prefix: string, details: string): string {
  const T = workbenchText(o.surface)
  const D = workbenchModel(o, links, prefix)
  const repo = `${o.repo ?? ''}${o.pr === null ? '' : ` #${o.pr}`}`
  const pr = links.page?.() ?? null
  return `<!doctype html>
<html lang="${T.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="${faviconUri('light')}" media="(prefers-color-scheme: light)">
<link rel="icon" type="image/svg+xml" href="${faviconUri('dark')}" media="(prefers-color-scheme: dark)">
<title>${esc(T.title.replace('{repo}', repo.trim() || o.surface))}</title>
<style>${asset('report/workbench.css')}</style>
</head>
<body>
<div class="top"><span class="brand"><span class="logo-light">${logoSvg('light')}</span><span class="logo-dark">${logoSvg('dark')}</span></span><span class="repo">${esc(repo)} <span class="muted">· ${esc(D.base)} → ${esc(D.head)}</span></span><span class="grow"></span><span class="keys-hint"><span class="kbd">j</span> <span class="kbd">k</span> ${T.keysHint} · <span class="kbd">r</span> ${T.keysReviewed}</span><button type="button" class="act" data-copyresults>${T.copyResults}</button>${pr === null ? '' : `<a class="act dark" href="${esc(pr)}" target="_blank" rel="noopener">${T.commentOnGithub}</a>`}<button type="button" class="act" id="theme">${T.themeToggle}</button></div>
<div class="layout"><aside class="rail" id="rail"></aside><main class="main" id="main"><noscript>${T.noscript}</noscript></main></div>
<script type="application/json" id="farol-details">${scriptJson(details)}</script>
<script>window.FAROL = ${scriptJson({ D, T })}</script>
${SCRIPTS.map((s) => `<script>\n${asset(s)}</script>`).join('\n')}
</body>
</html>
`
}
