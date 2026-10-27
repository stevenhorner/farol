import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnalysisRole } from '../classify/roles.js'
import { readFiles } from '../git/index.js'
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
