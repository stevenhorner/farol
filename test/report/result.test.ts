import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OutputSchema } from '../../src/output/schema.js'
import { renderHtml } from '../../src/report/html.js'
import { createLinker } from '../../src/report/links.js'
import { mergeScore } from '../../src/report/merge-score.js'
import { reviewParts } from '../../src/report/review-parts.js'
import { ASSETS } from '../../src/report/html-assets.js'
import { detailsOf, workbenchOf } from '../helpers/html.js'
import { FIXTURES_DIR } from '../helpers/repo.js'

const golden = (scenario: string) => OutputSchema.parse(JSON.parse(readFileSync(join(FIXTURES_DIR, scenario, 'expected.json'), 'utf8')))

describe('review workbench', () => {
  it('gives the page the contract changes to check, the pages/operations to try and the texts of the results', () => {
    const html = renderHtml(golden('p10-contracts'))
    const { D, T } = workbenchOf(html)
    const groups = D.groups as { file: string | null; items: { kind: string }[] }[]
    expect(groups.filter((g) => g.items.some((i) => i.kind === 'contract')).length).toBeGreaterThan(0)
    expect((D.contracts as { key: string; level: string }[]).filter((e) => e.level === 'breaking').map((e) => e.key)).toEqual(['GET /brands', 'GET /brands/{brand_id}', 'POST /brands'])
    expect((D.ops as { key: string }[]).map((o) => o.key)).toContain('POST /brands')
    expect((T.md as { title: string }).title).toBe('### farol review')
    // The data cannot close its <script> element.
    expect(/<script>window\.FAROL = (.*?)<\/script>/s.exec(html)?.[1]).not.toContain('<')
  })

  it('links every changed file to its diff in the pull request, and the pull request for comments', () => {
    const o = { ...golden('05-shared-component'), repo: 'acme/shop', pr: 3 }
    const { D } = workbenchOf(renderHtml(o, createLinker(o, { repo: 'acme/shop', pr: 3 })))
    const links = D.links as { pr: string; files: Record<string, string> }
    expect(links.pr).toBe('https://github.com/acme/shop/pull/3')
    expect(links.files['src/components/Card.tsx']).toMatch(/^https:\/\/github\.com\/acme\/shop\/pull\/3\/files#diff-[0-9a-f]{64}$/)
  })

  it('lists manifests and trimmed tests that add to the score among the files to review', () => {
    const o = golden('p10-contracts')
    const { D } = workbenchOf(renderHtml(o))
    const files = (D.files as { path: string }[]).map((f) => f.path)
    for (const g of D.groups as { file: string | null }[]) if (g.file !== null) expect(files).toContain(g.file)
  })

  it('shows suggested reviewers in the workbench and in their own Details tab', () => {
    const o = golden('p10-contracts')
    const html = renderHtml({ ...o, ownership: { farolReviewers: 1, head: o.head.sha, prAuthors: [], codeowners: [], reviewers: [{ name: 'Ana', score: 40, active: true, files: [] }], files: [] } })
    expect((workbenchOf(html).D.reviewers as { name: string; note: string }[])[0]).toEqual({ name: 'Ana', note: 'wrote 40% of the changed code', files: [] })
    expect(detailsOf(html)).toContain('<div class="section" id="reviewers">')
  })

  it('ships browser scripts that parse, in the order they share their names', () => {
    const scripts = ['report/wb-highlight.js', 'report/wb-core.js', 'report/wb-views.js', 'report/wb-pages.js'].map((name) => ASSETS[name] ?? '')
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- a syntax check, never called
    expect(() => new Function(scripts.join('\n'))).not.toThrow()
    const html = renderHtml(golden('p10-contracts'))
    expect(html.indexOf(scripts[0] ?? '')).toBeLessThan(html.indexOf(scripts[1] ?? ''))
    expect(html.indexOf(scripts[1] ?? '')).toBeLessThan(html.indexOf(scripts[2] ?? ''))
  })

  it('splits the score into the same parts and points as the PR comment', () => {
    for (const scenario of ['p10-contracts', 'signals-coverage-lint', '05-shared-component']) {
      const o = golden(scenario)
      const out = { ...o, signals: { ...o.signals, security: { ...o.signals.security, findings: (o.files[0] ? [{ path: o.files[0].path, line: 3, severity: 'high' as const, rule: 'bandit' as const, message: 'S608 sql', text: 'q' }] : []) } } }
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the page's own core script on its data
      const run = new Function('window', 'localStorage', 'document', `${ASSETS['report/wb-core.js'] ?? ''}\nreturn { GROUPS, POINTS0 }`) as (w: unknown, s: unknown, d: unknown) => { GROUPS: { id: string }[]; POINTS0: Map<string, number> }
      const { GROUPS, POINTS0 } = run({ FAROL: workbenchOf(renderHtml(out)) }, { getItem: () => null, setItem: () => undefined }, { addEventListener: () => undefined })
      const page = GROUPS.map((g) => POINTS0.get(g.id) ?? 0).sort((a, b) => b - a)
      expect(reviewParts(mergeScore(out).items).map((p) => p.points).sort((a, b) => b - a)).toEqual(page)
    }
  })
})
