import ts from 'typescript'
import { compareStrings, sortedUnique } from '../output/order.js'
import { parseIsolated } from '../project/parse.js'
import { cliNodes } from './cli.js'
import { restNodes } from './rest.js'

/** One resolver of a resolver map: `Type.field` and the code that implements it. */
export interface ResolverEntry {
  key: string
  file: string
  line: number
  /** Normalized source text of the resolver (to compare base and head). */
  text: string
}

function propName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
  return undefined
}

function normalized(node: ts.Node, sf: ts.SourceFile): string {
  return node.getText(sf).replace(/\s+/g, ' ').trim()
}

function unwrap(e: ts.Expression): ts.Expression {
  let x = e
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression
  return x
}

/** Field name marking an enum in the type-fields map: its resolver maps internal values. */
export const ENUM_MARKER = '__values'

/** Resolver members every type may have besides its fields. */
const META_FIELDS = new Set(['__resolveReference', '__resolveType', '__isTypeOf'])

/**
 * The value node of each `Type: { field: … }` member of resolver maps found anywhere in a file. A member counts only
 * when it names a field of that type in the schema, so registries keyed by type names (loaders) are not resolvers.
 */
export function resolverNodes(sf: ts.SourceFile, typeFields: ReadonlyMap<string, ReadonlySet<string>>): { key: string; node: ts.Node; value: ts.Node }[] {
  const out: { key: string; node: ts.Node; value: ts.Node }[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue
        const type = propName(prop.name)
        const inner = unwrap(prop.initializer)
        const fields = type === undefined ? undefined : typeFields.get(type)
        // Enum value maps (`Status: { ACTIVE: 1 }` or `Status: STATUS_VALUES`) resolve the whole enum.
        if (fields?.has(ENUM_MARKER)) {
          out.push({ key: `${type ?? ''}.${ENUM_MARKER}`, node: prop, value: prop.initializer })
          continue
        }
        if (fields === undefined || !ts.isObjectLiteralExpression(inner)) continue
        for (const member of inner.properties) {
          const field = member.name ? propName(member.name) : undefined
          if (field === undefined || (!fields.has(field) && !META_FIELDS.has(field))) continue
          const value = ts.isPropertyAssignment(member) ? member.initializer : ts.isShorthandPropertyAssignment(member) ? member.name : member
          out.push({ key: `${type}.${field}`, node: member, value })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** Entry points defined in a file: GraphQL resolvers (`Type.field`), REST handlers (`GET /path`) and CLI commands (`CLI name`). */
export function entryNodes(sf: ts.SourceFile, typeFields: ReadonlyMap<string, ReadonlySet<string>>, rest: boolean, cli = false): { key: string; node: ts.Node; value: ts.Node; computed?: true }[] {
  return [...resolverNodes(sf, typeFields), ...(rest ? restNodes(sf) : []), ...(cli ? cliNodes(sf) : [])]
}

/** Resolver entries of a file, parsed on its own (used for the base and the head of changed files). */
export function resolverEntries(file: string, code: string, typeFields: ReadonlyMap<string, ReadonlySet<string>>, withRest = true, withCli = false): { entries: ResolverEntry[]; rest: string[]; imports: Set<string> } {
  const { sourceFile: sf } = parseIsolated(file, code)
  const nodes = entryNodes(sf, typeFields, withRest, withCli)
  const entries = nodes.map(({ key, node }) => ({ key, file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: normalized(node, sf) }))
  // Everything outside the resolver members (helpers, module-level code), for "did anything else change". Imports are
  // compared as bindings: adding one is not a change to what existed.
  const imports = new Set<string>()
  const removed: [number, number][] = nodes.map(({ node }) => [node.getStart(sf), node.end])
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause
      const spec = statement.moduleSpecifier.text
      if (!clause) imports.add(`${spec}|`)
      if (clause?.name) imports.add(`${spec}|default as ${clause.name.text}`)
      const named = clause?.namedBindings
      if (named && ts.isNamespaceImport(named)) imports.add(`${spec}|* as ${named.name.text}`)
      if (named && ts.isNamedImports(named)) for (const el of named.elements) imports.add(`${spec}|${(el.propertyName ?? el.name).text} as ${el.name.text}`)
      removed.push([statement.getStart(sf), statement.end])
    }
  }
  // The rest of the file as comparable items: every top-level statement, and every property of top-level object
  // literals on its own, with the resolver members blanked out. Adding a property or a statement is not a change.
  const blank = (node: ts.Node): string => {
    let text = code.slice(node.getStart(sf), node.end)
    const offset = node.getStart(sf)
    for (const [start, end] of removed.filter(([a, b]) => a >= offset && b <= node.end).sort((a, b) => b[0] - a[0])) text = text.slice(0, start - offset) + text.slice(end - offset)
    return stripComments(text).replace(/\s+/g, ' ').replace(/,(\s*,)+/g, ',').replace(/\{\s*,/g, '{').replace(/,\s*\}/g, '}').trim()
  }
  const items: string[] = []
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) continue
    const object = topLevelObject(statement)
    if (!object) {
      items.push(blank(statement))
      continue
    }
    for (const prop of object.properties) items.push(blank(prop))
    items.push(blank(statement).replace(blank(object), '{}'))
  }
  return { entries: entries.sort((a, b) => compareStrings(a.key, b.key)), rest: items, imports }
}

/** Code without comments (they never change behavior), tokenized with the TypeScript scanner so strings stay intact. */
export function stripComments(code: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, code)
  let out = ''
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) continue
    out += scanner.getTokenText()
  }
  return out
}

/** The object literal a top-level statement defines (`const X = {…}`, `export default {…}`, `module.exports = {…}`). */
function topLevelObject(statement: ts.Statement): ts.ObjectLiteralExpression | undefined {
  let value: ts.Expression | undefined
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) value = statement.declarationList.declarations[0]?.initializer
  else if (ts.isExportAssignment(statement)) value = statement.expression
  else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) value = statement.expression.right
  const inner = value ? unwrap(value) : undefined
  return inner && ts.isObjectLiteralExpression(inner) ? inner : undefined
}

export interface ResolverChanges {
  added: string[]
  removed: string[]
  changed: string[]
  /** Code outside the resolver members changed (imports, helpers, module-level code): every resolver may be affected. */
  restChanged: boolean
}

/** Resolver-level comparison of a changed resolver file: only resolvers whose own code changed are affected. */
export function diffResolvers(base: ReturnType<typeof resolverEntries>, head: ReturnType<typeof resolverEntries>): ResolverChanges {
  const before = new Map(base.entries.map((e) => [e.key, e.text]))
  const after = new Map(head.entries.map((e) => [e.key, e.text]))
  return {
    added: [...after.keys()].filter((k) => !before.has(k)).sort(compareStrings),
    removed: [...before.keys()].filter((k) => !after.has(k)).sort(compareStrings),
    changed: [...before.keys()].filter((k) => after.has(k) && after.get(k) !== before.get(k)).sort(compareStrings),
    restChanged: base.rest.some((item) => !head.rest.includes(item)) || [...base.imports].some((i) => !head.imports.has(i)),
  }
}

/** `a.b.c` → ['a', 'b', 'c'] (empty when the chain does not start with an identifier or `this`). */
export function accessChain(node: ts.PropertyAccessExpression): string[] {
  const parts: string[] = []
  let current: ts.Expression = node
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text)
    current = current.expression
  }
  if (ts.isIdentifier(current)) parts.unshift(current.text)
  else if (current.kind === ts.SyntaxKind.ThisKeyword) parts.unshift('this')
  else return []
  return parts
}

const TYPE_ONLY = new Set([ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.PropertySignature, ts.SyntaxKind.MethodSignature, ts.SyntaxKind.TypeParameter, ts.SyntaxKind.TypeLiteral])

/**
 * Project modules a resolver uses: every identifier in its code resolved with the type checker to its declaration
 * (through imports and re-exports), following functions declared in the same file. Free identifiers that name a
 * global set with `global.X = …` count as uses of the module that sets it.
 */
export function resolverAnchors(
  value: ts.Node,
  checker: ts.TypeChecker,
  isProjectFile: (fileName: string) => boolean,
  rel: (fileName: string) => string,
  globals: ReadonlyMap<string, string>,
  context: (chain: readonly string[]) => readonly string[] = () => [],
): string[] {
  const own = value.getSourceFile()
  const modules = new Set<string>()
  const seen = new Set<ts.Node>()
  const visit = (node: ts.Node): void => {
    // Types never run: annotations and type-only declarations are not uses.
    if (ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return
    // `loaders.Brand.byId(…)`: a context property injected at runtime, mapped by the configuration.
    if (ts.isPropertyAccessExpression(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) {
      for (const m of context(accessChain(node))) modules.add(m)
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node)
      const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
      // JS expando assignments (`process.env.X = …` somewhere) are not declarations of the identifier.
      const decls = (target?.declarations ?? []).filter((d) => !TYPE_ONLY.has(d.kind) && !ts.isBinaryExpression(d) && !ts.isPropertyAccessExpression(d) && !ts.isElementAccessExpression(d) && !ts.isIdentifier(d))
      if (decls.every((d) => d.getSourceFile().isDeclarationFile) && globals.has(node.text)) {
        modules.add(globals.get(node.text) ?? '')
        return
      }
      for (const d of decls) {
        const sf = d.getSourceFile()
        if (sf === own) {
          // A helper of the same file: its code is part of the resolver.
          const body = ts.isFunctionDeclaration(d) ? d : ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) ? d.initializer : undefined
          if (body && !seen.has(body)) {
            seen.add(body)
            visit(body)
          }
        } else if (isProjectFile(sf.fileName)) {
          modules.add(rel(sf.fileName))
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  seen.add(value)
  visit(value)
  return sortedUnique(modules)
}
