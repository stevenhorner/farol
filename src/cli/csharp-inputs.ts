import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import type { AnalysisRole } from '../classify/roles.js'
import { UsageError } from '../config/load.js'
import { isTestProject } from '../dotnet/nuget.js'
import { listFiles, readFiles } from '../git/index.js'
import type { ChangedFile } from '../git/types.js'
import type { Context } from './context.js'
import { readCsXml } from './lang-workspace.js'

/**
 * A Cobertura XML coverage report (coverlet's default) converted to JSON by the C# helper, in a temporary file the
 * coverage reader understands; any other report (coverlet JSON) is returned as it is.
 */
export async function coberturaAsJson(path: string | undefined): Promise<string | undefined> {
  if (path === undefined || !existsSync(path)) return path
  const text = readFileSync(path, 'utf8')
  if (!text.trimStart().startsWith('<')) return path
  const out = join(mkdtempSync(join(tmpdir(), 'farol-cobertura-')), 'cobertura.json')
  writeFileSync(out, JSON.stringify(await readCsXml('cobertura', text)))
  return out
}

/**
 * Base and head of changed .resx files with the i18n role, as JSON objects (resource name → value), so the i18n rule
 * compares them like translation JSON. A file the helper cannot read keeps its text: the rule then reports it.
 */
export async function resxAsJson(ctx: Context, files: readonly ChangedFile[], roleOf: (path: string) => AnalysisRole | 'outside', baseSha: string, headSha: string): Promise<{ base: Map<string, string>; head: Map<string, string> }> {
  const resx = files.filter((f) => f.status === 'modified' && f.path.endsWith('.resx') && roleOf(f.path) === 'i18n')
  const convert = async (texts: Map<string, string>): Promise<Map<string, string>> =>
    new Map(await Promise.all([...texts].map(async ([path, text]) => [path, await readCsXml('resx', text).then((j) => JSON.stringify(j), () => text)] as const)))
  return {
    base: await convert(await readFiles(ctx.repoRoot, baseSha, resx.map((f) => f.path))),
    head: await convert(await readFiles(ctx.repoRoot, headSha, resx.map((f) => f.path))),
  }
}

/**
 * Changed Directory.Build.props/.targets files with the global role that only test projects import: every .csproj
 * below their directory, in the base and in the head, is a test project (by its role or its content). MSBuild imports
 * them only into the projects below them, so they describe how tests build, like a test project's .csproj. A project
 * that cannot be read is not a test project (the file stays global).
 */
export async function testOnlyBuildFiles(ctx: Context, files: readonly ChangedFile[], roleOf: (path: string) => AnalysisRole | 'outside', baseSha: string, headSha: string): Promise<Set<string>> {
  const candidates = files.filter((f) => DIRECTORY_BUILD.has(posix.basename(f.path)) && roleOf(f.path) === 'global')
  const result = new Set<string>()
  if (candidates.length === 0) return result
  const sides = await Promise.all([baseSha, headSha].map(async (sha) => {
    const projects = (await listFiles(ctx.repoRoot, sha)).filter((p) => p.endsWith('.csproj'))
    const texts = await readFiles(ctx.repoRoot, sha, projects.filter((p) => roleOf(p) !== 'test'))
    return new Map(await Promise.all(projects.map(async (p) => [p, roleOf(p) === 'test' || isTestProject(await manifestOf(texts.get(p)))] as const)))
  }))
  for (const f of candidates) {
    const dirs = [posix.dirname(f.oldPath ?? f.path), posix.dirname(f.path)]
    const below = (p: string): boolean => dirs.some((d) => d === '.' || p.startsWith(`${d}/`))
    const projects = sides.flatMap((side) => [...side].filter(([p]) => below(p)))
    if (projects.length > 0 && projects.every(([, test]) => test)) result.add(f.path)
  }
  return result
}

const DIRECTORY_BUILD = new Set(['Directory.Build.props', 'Directory.Build.targets'])

/** A project file parsed by the C# helper, or null when it cannot be read. */
async function manifestOf(text: string | undefined): Promise<unknown> {
  if (text === undefined) return null
  try {
    return await readCsXml('manifest', text)
  } catch (error) {
    if (error instanceof UsageError) throw error
    return null
  }
}
