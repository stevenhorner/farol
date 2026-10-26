/* farol report, in the browser: syntax highlighting of diff lines (TypeScript/JavaScript, Go, Python, GraphQL). A
 * small line tokenizer, no library: comments, strings, keywords, literals, numbers, types and calls. An open block
 * comment or multi-line string carries over to the next line. Loaded before wb-core.js, which uses highlightLine. */
const HL_WORDS = (s) => new Set(s.split(' '))
const HL_LANGS = {
  js: {
    kw: HL_WORDS('break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await as type interface enum implements declare readonly keyof namespace abstract private protected public satisfies infer is'),
    lit: HL_WORDS('true false null undefined NaN Infinity'),
    line: '//', block: ['/*', '*/'], quotes: '"\'`', multi: '`',
  },
  go: {
    kw: HL_WORDS('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'),
    lit: HL_WORDS('true false nil iota'),
    line: '//', block: ['/*', '*/'], quotes: '"\'`', multi: '`',
  },
  py: {
    kw: HL_WORDS('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'),
    lit: HL_WORDS('True False None self cls'),
    line: '#', block: null, quotes: '"\'', multi: '', triple: true, deco: true,
  },
  gql: {
    kw: HL_WORDS('query mutation subscription fragment on type input enum interface union scalar schema extend implements directive'),
    lit: HL_WORDS('true false null'),
    line: '#', block: null, quotes: '"', multi: '', triple: true,
  },
}
const HL_EXT = { ts: 'js', tsx: 'js', mts: 'js', cts: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', go: 'go', py: 'py', graphql: 'gql', gql: 'gql' }
/** The tokenizer of a file, by its extension, or null (shown as plain text). */
const langOf = (path) => HL_LANGS[HL_EXT[(path ?? '').split('.').pop()]] ?? null

const hlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const hlSpan = (cls, s) => (cls ? `<span class="t-${cls}">${hlEsc(s)}</span>` : hlEsc(s))
const isWordStart = (c) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$')
const isWordChar = (c) => isWordStart(c) || (c >= '0' && c <= '9')
const isDigit = (c) => c >= '0' && c <= '9'

/** The end of a quoted string that starts at i (the index after its closing quote), or -1 when it stays open. */
function closeOf(text, i, quote) {
  let j = i + quote.length
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue }
    if (text.startsWith(quote, j)) return j + quote.length
    j++
  }
  return -1
}

/**
 * One line as HTML with token spans. `state` is what the previous line left open ({ cls, close }) or null; the result
 * carries what this line leaves open. Without a tokenizer the line is only escaped.
 */
function highlightLine(text, L, state) {
  if (!L) return { html: hlEsc(text), state: null }
  let out = ''
  let i = 0
  if (state) {
    const j = closeOf(text, -state.close.length, state.close)
    if (j < 0) return { html: hlSpan(state.cls, text), state }
    out += hlSpan(state.cls, text.slice(0, j))
    i = j
    state = null
  }
  while (i < text.length) {
    const c = text[i]
    if (text.startsWith(L.line, i)) { out += hlSpan('com', text.slice(i)); break }
    if (L.block && text.startsWith(L.block[0], i)) {
      const j = text.indexOf(L.block[1], i + L.block[0].length)
      if (j < 0) return { html: out + hlSpan('com', text.slice(i)), state: { cls: 'com', close: L.block[1] } }
      out += hlSpan('com', text.slice(i, j + L.block[1].length))
      i = j + L.block[1].length
      continue
    }
    const triple = L.triple && (text.startsWith('"""', i) || text.startsWith("'''", i)) ? text.slice(i, i + 3) : null
    if (triple || L.quotes.includes(c)) {
      const quote = triple ?? c
      const j = closeOf(text, i, quote)
      if (j < 0 && (triple || L.multi.includes(c))) return { html: out + hlSpan('str', text.slice(i)), state: { cls: 'str', close: quote } }
      const end = j < 0 ? text.length : j
      out += hlSpan('str', text.slice(i, end))
      i = end
      continue
    }
    if (isDigit(c) && !isWordChar(text[i - 1])) {
      let j = i
      while (j < text.length && (isWordChar(text[j]) || text[j] === '.')) j++
      out += hlSpan('num', text.slice(i, j))
      i = j
      continue
    }
    if (L.deco && c === '@' && isWordStart(text[i + 1])) {
      let j = i + 1
      while (j < text.length && (isWordChar(text[j]) || text[j] === '.')) j++
      out += hlSpan('fn', text.slice(i, j))
      i = j
      continue
    }
    if (isWordStart(c)) {
      let j = i
      while (j < text.length && isWordChar(text[j])) j++
      const w = text.slice(i, j)
      const cls = L.kw.has(w) ? 'kw' : L.lit.has(w) ? 'lit' : text[j] === '(' ? 'fn' : w[0] >= 'A' && w[0] <= 'Z' ? 'type' : ''
      out += hlSpan(cls, w)
      i = j
      continue
    }
    out += hlEsc(c)
    i++
  }
  return { html: out, state }
}
