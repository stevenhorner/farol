import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OutputSchema, type Output } from '../../src/output/schema.js'
import { MAX_COMMENT_LENGTH, renderReport } from '../../src/report/markdown.js'
import { FEEDBACK_OPTIONS, MARKER } from '../../src/report/strings.js'
import { FIXTURES_DIR } from '../helpers/repo.js'

function golden(scenario: string, file = 'expected.json'): Output {
  const o = OutputSchema.parse(JSON.parse(readFileSync(join(FIXTURES_DIR, scenario, file), 'utf8')))
  // Golden files carry SHA placeholders; give the footer a realistic commit.
  return { ...o, head: { ...o.head, sha: '0123456789abcdef0123456789abcdef01234567' } }
}

const CASES: Record<string, string> = {
  isolated: '01-new-route',
  'touches-existing': '05-shared-component',
  global: '10-global-css',
  unknown: '11-routes-from-map',
}

describe('report markdown', () => {
  for (const [cls, scenario] of Object.entries(CASES)) {
    it(`renders a ${cls} PR`, async () => {
      const md = renderReport(golden(scenario))
      expect(md.startsWith(`${MARKER}\n`)).toBe(true)
      await expect(md).toMatchFileSnapshot(`./__snapshots__/${cls}.md`)
    })
  }

  it('renders every signal when reports were provided', async () => {
    await expect(renderReport(golden('signals-coverage-lint'))).toMatchFileSnapshot('./__snapshots__/signals.md')
    await expect(renderReport(golden('signals-suppressions'))).toMatchFileSnapshot('./__snapshots__/suppressions.md')
  })

  it('keeps the class out of the title and the signals, inside the collapsed block only', () => {
    const md = renderReport(golden('05-shared-component'))
    const [before = '', after = ''] = md.split('<summary>Classification')
    expect(before).not.toContain('touches-existing')
    expect(after).toContain('`touches-existing`')
    expect(md).toContain('**Diff coverage:** not verified')
    for (const label of FEEDBACK_OPTIONS) expect(after).toContain(`- [ ] ${label}`)
  })

  it('stays under the GitHub limit, cutting long lists with "and N more"', () => {
    const base = golden('05-shared-component')
    const affected = Array.from({ length: 5000 }, (_, i) => ({
      key: `/ > page-${i}`,
      path: `/page-${i}`,
      hasChildren: false,
      via: [{ file: 'src/components/Card.tsx', chain: [`src/pages/very/long/directory/name/Page${i}.tsx`, 'src/components/Card.tsx'] }],
    }))
    const huge: Output = { ...base, routes: { ...base.routes, affected }, reasons: Array.from({ length: 3000 }, (_, i) => ({ code: 'existing-file-modified' as const, file: `src/f${i}.ts`, detail: 'x'.repeat(200) })) }
    const md = renderReport(huge)
    expect(md.length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH)
    expect(md).toContain('- and ')
    expect(md.startsWith(MARKER)).toBe(true)
    expect(md).toContain(FEEDBACK_OPTIONS[2])
    expect(renderReport(base).length).toBeLessThan(MAX_COMMENT_LENGTH)
  })

  it('escapes HTML in details', () => {
    const md = renderReport(golden('11-routes-from-map'))
    expect(md).toContain('element: &lt;Page /&gt;')
  })
})

describe('report link', () => {
  it('puts the HTML report link at the top and only accepts https URLs', () => {
    const o = golden('05-shared-component')
    expect(renderReport(o, undefined, undefined, 'https://github.com/acme/shop/actions/runs/1/artifacts/2')).toContain('📄 **[Open the review workbench](https://github.com/acme/shop/actions/runs/1/artifacts/2)**')
    expect(() => renderReport(o, undefined, undefined, 'javascript:alert(1)')).toThrow(/https/)
  })
})
