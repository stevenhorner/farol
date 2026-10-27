import { createReachIndex, reachFrom, routesReaching } from '../classify/reach.js'
import type { Context } from './context.js'
import { isHelperLanguage } from '../config/languages.js'
import { writeStdout } from './run.js'
import { loadWorkspace, projectToRepoPath } from './workspace.js'
import { DeclGraph, declRouteTable } from '../decls/impact.js'
import { readLangTree } from './lang-workspace.js'

export interface ImpactResult {
  file: string
  inGraph: boolean
  routes: { key: string; path: string; via: string[] }[]
  dynamicRoutes: { file: string; line: number; detail: string }[]
}

export async function computeImpact(ctx: Context, file: string, ref: string | undefined): Promise<ImpactResult> {
  const target = projectToRepoPath(ctx, file)
  if (isHelperLanguage(ctx.config.language)) {
    // Helper languages (Go, Python): entry points whose code reaches any declaration of the file (declaration-level reach).
    const out = await readLangTree(ctx, ref)
    const graph = new DeclGraph(out)
    const starts = out.decls.flatMap((d, i) => (d.file === target ? [i] : []))
    const reached = graph.entriesReaching(starts)
    const routes = out.entries.filter((e) => reached.has(e.key)).map((e) => ({ key: e.key, path: e.key, via: reached.get(e.key) ?? [] }))
    return { file: target, inGraph: out.files.includes(target), routes, dynamicRoutes: declRouteTable(out).dynamic }
  }
  const ws = await loadWorkspace(ctx, ref)
  const reach = reachFrom(createReachIndex(ws.graph), target)
  return {
    file: target,
    inGraph: ws.graph.nodes.includes(target),
    routes: routesReaching(reach, ws.routes.routes).map((h) => ({ key: h.route.key, path: h.route.path, via: h.via })),
    dynamicRoutes: ws.routes.dynamic,
  }
}

export async function impactCommand(ctx: Context, file: string, ref: string | undefined): Promise<number> {
  const result = await computeImpact(ctx, file, ref)
  await writeStdout(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}
