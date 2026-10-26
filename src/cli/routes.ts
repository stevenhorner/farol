import type { RouteTable } from '../routes/types.js'
import type { Context } from './context.js'
import { isHelperLanguage } from '../config/languages.js'
import { writeStdout } from './run.js'
import { loadWorkspace } from './workspace.js'
import { declRouteTable } from '../decls/impact.js'
import { readLangTree } from './lang-workspace.js'

export interface RoutesResult {
  file: string
  routes: RouteTable['routes']
  dynamicRoutes: RouteTable['dynamic']
  /** Files the table was read from. */
  sources: string[]
}

export async function computeRoutes(ctx: Context, ref: string | undefined): Promise<RoutesResult> {
  if (isHelperLanguage(ctx.config.language)) {
    // Helper languages (Go, Python): the entry points the language helper finds (routes, operations, scripts and binaries).
    const table = declRouteTable(await readLangTree(ctx, ref))
    return { file: '', routes: table.routes, dynamicRoutes: table.dynamic, sources: table.sources }
  }
  const ws = await loadWorkspace(ctx, ref)
  return { file: ws.routesFile, routes: ws.routes.routes, dynamicRoutes: ws.routes.dynamic, sources: ws.routes.sources }
}

export async function routesCommand(ctx: Context, ref: string | undefined): Promise<number> {
  await writeStdout(`${JSON.stringify(await computeRoutes(ctx, ref), null, 2)}\n`)
  return 0
}
