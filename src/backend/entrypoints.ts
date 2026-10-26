import type { DocumentNode } from 'graphql'
import { posix } from 'node:path'
import { compareStrings, sortedUnique } from '../output/order.js'
import type { ProjectProgram } from '../project/program.js'
import type { RouteEntry } from '../routes/types.js'
import { definedGlobals, usesGlobal } from './globals.js'
import { ENUM_MARKER, entryNodes, resolverAnchors } from './resolvers.js'
import picomatch from 'picomatch'
import { buildSchemaGraph, operationsOf, parseSdl, sdlSources, type SdlProblem } from './schema.js'

/** The entry points of a backend, in the same shape as a route table: one entry per operation or endpoint. */
export interface BackendTable {
  /** GraphQL root operations and REST endpoints; `modules` are the modules their resolvers use. */
  operations: RouteEntry[]
  /** For each operation, the resolver keys it can run (its own and those of every type it can return). */
  resolverKeys: Map<string, Set<string>>
  /** For each GraphQL operation, the types it can return. */
  operationTypes: Map<string, Set<string>>
  /** Root operation type names. */
  rootTypes: Set<string>
  /** Every type name of the schema (to recognize resolver maps). */
  typeNames: Set<string>
  /** Fields of each type: a resolver map member must name a real field. */
  typeFields: Map<string, Set<string>>
  /** Files with resolver maps or REST handlers, and files with SDL. */
  resolverFiles: Set<string>
  schemaFiles: Set<string>
  /** Every SDL document of the head, with its file (the schema the contracts are compared on). */
  schemaDocs: { doc: DocumentNode; file: string }[]
  /** `global.X = …` assignments: global name → module. */
  globals: Map<string, string>
  problems: SdlProblem[]
}

export interface BackendInput {
  project: ProjectProgram
  repoRoot: string
  /** Repo-relative paths of every file of the head tree (for .graphql files the program does not contain). */
  files: readonly string[]
  read: (repoPath: string) => string | undefined
  /** Whether a repo-relative file counts (tests, stories, excluded and outside-project files do not). */
  isOrigin: (repoPath: string) => boolean
  graphql: boolean
  rest: boolean
  cli: boolean
  /** Context properties → provider file globs (repo-relative). */
  context: Readonly<Record<string, readonly string[]>>
}

export function buildBackendTable(input: BackendInput): BackendTable {
  const root = input.repoRoot.replaceAll('\\', '/')
  const rel = (fileName: string): string => posix.relative(root, fileName.replaceAll('\\', '/'))
  const isProjectFile = (fileName: string): boolean => {
    const p = fileName.replaceAll('\\', '/')
    return p.startsWith(`${root}/`) && !p.includes('/node_modules/')
  }
  const programFiles = input.project.program.getSourceFiles().filter((sf) => isProjectFile(sf.fileName) && !sf.isDeclarationFile && input.isOrigin(rel(sf.fileName)))

  // Schema: .graphql files of the tree and gql`…` templates of the program files.
  const problems: SdlProblem[] = []
  const docs: { doc: NonNullable<ReturnType<typeof parseSdl>['doc']>; file: string }[] = []
  const schemaFiles = new Set<string>()
  if (input.graphql) {
    const candidates = [...input.files.filter((f) => (f.endsWith('.graphql') || f.endsWith('.gql')) && input.isOrigin(f)), ...programFiles.map((sf) => rel(sf.fileName))]
    for (const file of sortedUnique(candidates)) {
      const code = input.read(file)
      if (code === undefined) continue
      const found = sdlSources(file, code)
      problems.push(...found.problems)
      for (const source of found.sources) {
        const parsed = parseSdl(source)
        if (parsed.problem) problems.push(parsed.problem)
        if (parsed.doc) {
          docs.push({ doc: parsed.doc, file })
          schemaFiles.add(file)
        }
      }
    }
  }
  const schema = buildSchemaGraph(docs)
  const typeNames = new Set<string>([...schema.fields.keys(), ...schema.possible.keys()])
  const typeFields = new Map([...schema.fields.entries()].map(([t, f]) => [t, new Set(f.keys())]))
  for (const t of schema.possible.keys()) if (!typeFields.has(t)) typeFields.set(t, new Set())
  for (const e of schema.enums) typeFields.set(e, new Set([ENUM_MARKER]))
  const operations = input.graphql ? operationsOf(schema) : []

  const globals = new Map<string, string>()
  for (const sf of programFiles) for (const name of definedGlobals(sf)) globals.set(name, rel(sf.fileName))

  // Context injection: `loaders.X…` → the provider whose directory or file name matches X, else every provider.
  const providers = new Map(
    Object.entries(input.context).map(([key, globs]) => {
      const match = picomatch([...globs], { dot: true })
      return [key, input.files.filter((f) => match(f))]
    }),
  )
  const contextOf = (chain: readonly string[]): string[] => {
    for (const [key, files] of providers) {
      const parts = key.split('.')
      for (let i = 0; i <= 1; i++) {
        if (parts.every((p, j) => chain[i + j] === p)) {
          const next = (chain[i + parts.length] ?? '').toLowerCase()
          const matching = files.filter((f) => f.toLowerCase().split('/').some((seg) => seg.replace(/\.[^.]+$/, '').replaceAll(/[-_]/g, '') === next.replaceAll(/[-_]/g, '')))
          return next !== '' && matching.length > 0 ? matching : files
        }
      }
    }
    return []
  }
  // Resolvers and REST handlers, with the modules their code uses.
  const checker = input.project.program.getTypeChecker()
  const anchors = new Map<string, { file: string; modules: Set<string>; computed?: RouteEntry['computed'] }>()
  const resolverFiles = new Set<string>()
  for (const sf of programFiles) {
    for (const { key, node, value, computed } of entryNodes(sf, typeFields, input.rest, input.cli)) {
      const file = rel(sf.fileName)
      resolverFiles.add(file)
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      const entry = anchors.get(key) ?? { file, modules: new Set<string>() }
      // Every registration of a computed key counts: a changed one in any file makes the route unknown.
      if (computed) entry.computed = [...(entry.computed ?? []), { file, line, detail: `${key}: path computed at run time` }]
      for (const m of resolverAnchors(value, checker, isProjectFile, rel, globals, contextOf)) if (m !== file) entry.modules.add(m)
      anchors.set(key, entry)
    }
  }

  const byType = new Map<string, string[]>()
  for (const key of anchors.keys()) {
    const type = key.includes('.') && !key.includes(' ') ? key.slice(0, key.indexOf('.')) : ''
    if (type !== '') byType.set(type, [...(byType.get(type) ?? []), key])
  }
  const resolverKeys = new Map<string, Set<string>>()
  const operationTypes = new Map<string, Set<string>>(operations.map((op) => [op.key, op.reachableTypes]))
  const entries: RouteEntry[] = []
  for (const op of operations) {
    const keys = new Set<string>([op.key, ...[...op.reachableTypes].flatMap((t) => byType.get(t) ?? [])].filter((k) => anchors.has(k)))
    resolverKeys.set(op.key, keys)
    const modules = sortedUnique([...keys].flatMap((k) => [...(anchors.get(k)?.modules ?? [])]))
    // The resolver file is not an anchor: only the code the resolvers run is (a resolver file often serves many operations).
    entries.push({ key: op.key, path: op.key, index: false, entry: null, modules, layouts: [] })
  }
  for (const [key, value] of anchors) {
    if (!key.includes(' ')) continue
    resolverKeys.set(key, new Set([key]))
    entries.push({ key, path: key, index: false, entry: null, modules: sortedUnique(value.modules), layouts: [], ...(value.computed ? { computed: value.computed } : {}) })
  }
  entries.sort((a, b) => compareStrings(a.key, b.key))
  return { operations: entries, resolverKeys, operationTypes, rootTypes: new Set(Object.values(schema.roots)), typeNames, typeFields, resolverFiles, schemaFiles, schemaDocs: docs, globals, problems: problems.sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line) }
}

/** Global edges for the import graph: every program file that reads a global points at the module defining it. */
export function globalUses(project: ProjectProgram, globals: ReadonlyMap<string, string>, rel: (fileName: string) => string, isProjectFile: (fileName: string) => boolean): { from: string; to: string }[] {
  if (globals.size === 0) return []
  const checker = project.program.getTypeChecker()
  const edges: { from: string; to: string }[] = []
  for (const sf of project.program.getSourceFiles()) {
    if (!isProjectFile(sf.fileName) || sf.isDeclarationFile) continue
    const from = rel(sf.fileName)
    for (const [name, to] of globals) {
      if (to !== from && sf.text.includes(name) && usesGlobal(sf, name, checker)) edges.push({ from, to })
    }
  }
  return edges
}
