import { Kind, type DocumentNode } from 'graphql'
import { backendFileImpact, type BackendFileImpact } from '../backend/impact.js'
import type { BackendTable } from '../backend/entrypoints.js'
import { diffResolvers, resolverEntries } from '../backend/resolvers.js'
import { diffSdl, parseSdl, sdlSources } from '../backend/schema.js'
import type { AnalysisRole } from '../classify/roles.js'
import { readFiles } from '../git/index.js'
import type { ChangedFile } from '../git/types.js'
import type { RouteTable } from '../routes/types.js'
import type { Context } from './context.js'
import { graphqlContractChanges, type EntryContractChange } from '../contracts/graphql.js'

/** All type system definitions of a file (a .graphql file or every gql`…` template of a TS/JS file), as one document. */
function fileSchema(file: string, code: string | undefined): DocumentNode | null {
  if (code === undefined) return null
  const docs = sdlSources(file, code).sources.map((s) => parseSdl(s).doc).filter((d) => d !== null)
  if (docs.length === 0) return null
  return { kind: Kind.DOCUMENT, definitions: docs.flatMap((d) => d.definitions) }
}

/**
 * Impact of every changed schema or resolver file: the SDL and the resolvers/endpoints of its base and head versions,
 * each parsed on its own, are compared member by member.
 */
export async function backendImpacts(
  ctx: Context,
  table: BackendTable,
  files: readonly ChangedFile[],
  roleOf: (path: string) => AnalysisRole | 'outside',
  baseSha: string,
  headSha: string,
): Promise<{ impacts: Map<string, BackendFileImpact>; baseRoutes: RouteTable; contracts: { changes: EntryContractChange[]; problem?: string } }> {
  const targets = files.filter((f) => f.status === 'modified' && (roleOf(f.path) === 'schema' || roleOf(f.path) === 'resolvers'))
  const paths = targets.map((f) => f.path)
  const base = await readFiles(ctx.repoRoot, baseSha, paths)
  const head = await readFiles(ctx.repoRoot, headSha, paths)
  const impacts = new Map<string, BackendFileImpact>()
  const addedOperations = new Set<string>()
  for (const f of targets) {
    const before = base.get(f.path)
    const after = head.get(f.path)
    const isCode = !f.path.endsWith('.graphql') && !f.path.endsWith('.gql')
    const schema = diffSdl(fileSchema(f.path, before), fileSchema(f.path, after))
    let resolvers: Parameters<typeof backendFileImpact>[2]
    if (isCode && before !== undefined && after !== undefined) {
      const b = resolverEntries(f.path, before, table.typeFields, ctx.config.backend.rest, ctx.config.backend.cli)
      const h = resolverEntries(f.path, after, table.typeFields, ctx.config.backend.rest, ctx.config.backend.cli)
      if (b.entries.length + h.entries.length > 0) resolvers = { ...diffResolvers(b, h), keys: [...new Set([...b.entries, ...h.entries].map((e) => e.key))] }
    }
    const impact = backendFileImpact(table, schema.added.length + schema.removed.length + schema.changed.length > 0 ? schema : undefined, resolvers)
    impacts.set(f.path, impact)
    for (const op of impact.addedOperations) addedOperations.add(op)
  }
  // New root fields and endpoints are the backend's new routes: the base table is the head table without them.
  for (const f of files) {
    if (f.status === 'added' && (roleOf(f.path) === 'schema' || roleOf(f.path) === 'resolvers')) {
      const after = (await readFiles(ctx.repoRoot, headSha, [f.path])).get(f.path)
      const schema = diffSdl(null, fileSchema(f.path, after))
      for (const m of schema.added) if (table.rootTypes.has(m.slice(0, m.indexOf('.'))) && m.includes('.')) addedOperations.add(m)
      if (after !== undefined && !f.path.endsWith('.graphql')) for (const e of resolverEntries(f.path, after, table.typeFields, ctx.config.backend.rest, ctx.config.backend.cli).entries) if (e.key.includes(' ')) addedOperations.add(e.key)
    }
  }
  return { impacts, baseRoutes: { routes: table.operations.filter((r) => !addedOperations.has(r.key)), dynamic: [], sources: [] }, contracts: await schemaContracts(ctx, table, files, baseSha) }
}

/**
 * Contract changes of the GraphQL schema: the head schema against the base one, which is the head schema with every
 * changed SDL file in its base version (added files left out, deleted ones put back).
 */
async function schemaContracts(ctx: Context, table: BackendTable, files: readonly ChangedFile[], baseSha: string): Promise<{ changes: EntryContractChange[]; problem?: string }> {
  if (table.schemaDocs.length === 0) return { changes: [] }
  const sdlFile = (p: string): boolean => /\.(graphql|gql|ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(p)
  const touched = files.filter((f) => table.schemaFiles.has(f.path) || (f.status !== 'added' && sdlFile(f.oldPath ?? f.path)))
  if (touched.length === 0) return { changes: [] }
  const changed = new Set(touched.flatMap((f) => [f.path, f.oldPath ?? f.path]))
  const base = await readFiles(ctx.repoRoot, baseSha, touched.filter((f) => f.status !== 'added').map((f) => f.oldPath ?? f.path))
  const baseDocs = [...table.schemaDocs.filter((d) => !changed.has(d.file)).map((d) => d.doc), ...[...base].map(([file, code]) => fileSchema(file, code)).filter((d) => d !== null)]
  try {
    return { changes: graphqlContractChanges(baseDocs, table.schemaDocs.map((d) => d.doc)) }
  } catch (error) {
    // A schema graphql-js cannot build (types defined elsewhere, interpolated SDL): no comparison, said so.
    return { changes: [], problem: `GraphQL contracts not compared: ${error instanceof Error ? error.message : String(error)}` }
  }
}
