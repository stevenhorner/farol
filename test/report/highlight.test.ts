import { describe, expect, it } from 'vitest'
import { ASSETS } from '../../src/report/html-assets.js'

type State = { cls: string; close: string } | null
type Lang = object | null
type Highlighter = {
  highlightLine: (text: string, lang: Lang, state: State) => { html: string; state: State }
  langOf: (path: string) => Lang
}
// eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the page's own highlighting script
const load = new Function(`${ASSETS['report/wb-highlight.js'] ?? ''}\nreturn { highlightLine, langOf }`) as () => Highlighter
const { highlightLine, langOf } = load()

describe('syntax highlighting of diff lines', () => {
  it('marks keywords, strings, numbers, types and calls, and escapes everything else', () => {
    const { html } = highlightLine('const n: Item = load("a<b", 42) // done', langOf('src/a.ts'), null)
    expect(html).toBe('<span class="t-kw">const</span> n: <span class="t-type">Item</span> = <span class="t-fn">load</span>(<span class="t-str">&quot;a&lt;b&quot;</span>, <span class="t-num">42</span>) <span class="t-com">// done</span>')
  })

  it('carries an open block comment or multi-line string to the next lines', () => {
    const ts = langOf('a.tsx')
    const first = highlightLine('x = 1 /* starts', ts, null)
    expect(first.state).toEqual({ cls: 'com', close: '*/' })
    const second = highlightLine('ends */ y', ts, first.state)
    expect(second.html).toBe('<span class="t-com">ends */</span> y')
    expect(second.state).toBeNull()
    const py = langOf('m.py')
    const doc = highlightLine('"""Doc with # no comment', py, null)
    expect(doc.state).toEqual({ cls: 'str', close: '"""' })
    expect(highlightLine('end""" # note', py, doc.state).html).toBe('<span class="t-str">end&quot;&quot;&quot;</span> <span class="t-com"># note</span>')
  })

  it('highlights C# and Razor views', () => {
    expect(highlightLine('public async Task<int> Count() => await orders.CountAsync(); // all', langOf('src/A.cs'), null).html).toBe(
      '<span class="t-kw">public</span> <span class="t-kw">async</span> <span class="t-type">Task</span>&lt;<span class="t-kw">int</span>&gt; <span class="t-fn">Count</span>() =&gt; <span class="t-kw">await</span> orders.<span class="t-fn">CountAsync</span>(); <span class="t-com">// all</span>',
    )
    expect(langOf('Views/Home/Index.cshtml')).toBe(langOf('src/A.cs'))
  })

  it('reads a hash inside a Python string as text, decorators as names, and leaves unknown files plain', () => {
    expect(highlightLine('@router.get("/#x")', langOf('r.py'), null).html).toBe('<span class="t-fn">@router.get</span>(<span class="t-str">&quot;/#x&quot;</span>)')
    expect(langOf('styles.css')).toBeNull()
    expect(highlightLine('a < b', null, null).html).toBe('a &lt; b')
  })
})
