import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Command } from 'commander'
import { z } from 'zod'
import { UsageError } from '../config/load.js'

/** Name of the file that can hold every CLI parameter. */
export const FAROL_FILE = '.farol.json'

const str = z.string().min(1)
const globs = z.array(str)
const pr = z.number().int().positive()

/** Every CLI parameter, globally and per command. Unknown keys are errors (typos would silently do nothing). */
export const FarolFileSchema = z
  .object({
    $schema: z.string().optional(),
    config: str.optional(),
    cwd: str.optional(),
    verbose: z.boolean().optional(),
    analyze: z.object({ base: str, head: str, coverage: str, eslint: str, out: str, ignore: globs, coverageIgnore: globs, audit: str, usage: str, pr, since: str, reviewers: z.boolean(), cacheDir: str, cache: z.boolean() }).partial().strict().optional(),
    report: z.object({ in: str, repo: str, pr, reportUrl: str, reviewers: str, sinceIn: str, sinceReportUrl: str }).partial().strict().optional(),
    html: z.object({ in: str, out: str, repo: str, pr, reviewers: str }).partial().strict().optional(),
    comment: z.object({ in: str, pr, repo: str, reportUrl: str, reviewers: str, new: z.boolean(), sinceIn: str, sinceReportUrl: str }).partial().strict().optional(),
    routes: z.object({ ref: str }).partial().strict().optional(),
    impact: z.object({ file: str, ref: str }).partial().strict().optional(),
    history: z.object({ since: str, branch: str, out: str, ignore: globs, firstParent: z.boolean() }).partial().strict().optional(),
    calibrate: z.object({ history: globs, window: pr, out: str }).partial().strict().optional(),
    usage: z.object({ out: str, days: pr }).partial().strict().optional(),
    reviewers: z.object({ in: str, out: str }).partial().strict().optional(),
  })
  .strict()

export type FarolFile = z.infer<typeof FarolFileSchema>
export type CommandName = 'analyze' | 'report' | 'html' | 'comment' | 'routes' | 'impact' | 'history' | 'calibrate' | 'usage' | 'reviewers'

/** Keys holding file paths: resolved against the directory of the .farol.json file. */
const PATH_KEYS: Record<CommandName | 'global', readonly string[]> = {
  global: ['config', 'cwd'],
  analyze: ['coverage', 'eslint', 'audit', 'usage', 'out', 'cacheDir'],
  report: ['in', 'reviewers', 'sinceIn'],
  html: ['in', 'out', 'reviewers'],
  comment: ['in', 'reviewers', 'sinceIn'],
  routes: [],
  impact: [],
  history: ['out'],
  calibrate: ['out'],
  usage: ['out'],
  reviewers: ['in', 'out'],
}

/** Nearest `.farol.json` from `start` up to the repository root (the first directory with `.git`). */
export function findFarolFile(start: string): string | undefined {
  let dir = resolve(start)
  for (;;) {
    const candidate = join(dir, FAROL_FILE)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (existsSync(join(dir, '.git')) || parent === dir) return undefined
    dir = parent
  }
}

export interface LoadedFarolFile {
  path: string
  data: FarolFile
}

export function loadFarolFile(path: string): LoadedFarolFile {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new UsageError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}; fix the JSON or pass --farol-file`)
  }
  const parsed = FarolFileSchema.safeParse(raw)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.length === 0 ? '(root)' : i.path.map(String).join('.')}: ${i.code === 'unrecognized_keys' ? `unknown key(s) ${i.keys.map((k) => `"${k}"`).join(', ')}` : i.message}`)
    throw new UsageError(`invalid ${FAROL_FILE} at ${path}:\n${lines.join('\n')}`)
  }
  return { path, data: parsed.data }
}

/**
 * Options of a command with the .farol.json values filled in: a flag given on the command line always wins; a value
 * from the .farol.json replaces a default. Paths from the .farol.json are made absolute against its directory.
 */
export function mergeOptions<T extends object>(cmd: Command, cliOptions: T, values: Record<string, unknown> | undefined, pathKeys: readonly string[], farolFilePath: string | undefined): T {
  if (!values || farolFilePath === undefined) return cliOptions
  const merged: Record<string, unknown> = { ...(cliOptions as Record<string, unknown>) }
  const dir = dirname(farolFilePath)
  for (const [key, value] of Object.entries(values)) {
    if (key === '$schema' || typeof value === 'object' && value !== null && !Array.isArray(value)) continue
    if (cmd.getOptionValueSource(key) === 'cli') continue
    merged[key] = pathKeys.includes(key) && typeof value === 'string' && !isAbsolute(value) ? resolve(dir, value) : value
  }
  return merged as T
}

export function pathKeys(name: CommandName | 'global'): readonly string[] {
  return PATH_KEYS[name]
}

/** Fails with a usage error when a required parameter came neither from the command line nor from the .farol.json. */
export function required<T>(value: T | undefined, flag: string, command: CommandName): T {
  if (value === undefined || value === '') throw new UsageError(`missing ${flag}: pass it on the command line or set "${command}.${flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}" in ${FAROL_FILE}`)
  return value
}
