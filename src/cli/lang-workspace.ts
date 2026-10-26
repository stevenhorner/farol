import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UsageError } from '../config/load.js'
import type { BackendFileImpact } from '../backend/impact.js'
import { exportTree, treeOf } from '../git/index.js'
import { TOOL_VERSION } from '../output/tool.js'
import type { ChangedFile } from '../git/types.js'
import { declImpacts, declImportGraph, declRouteTable } from '../decls/impact.js'
import { DeclHelperSchema, type DeclHelperOutput } from '../decls/types.js'
import type { ImportGraph } from '../project/graph.js'
import type { RouteTable } from '../routes/types.js'
import type { Context } from './context.js'

const MAX_BUFFER = 1024 * 1024 * 1024

/** Every go command runs offline, with the installed (or already cached) toolchain and without cgo. */
function goEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GOPROXY: 'off', GOTOOLCHAIN: 'local', GOFLAGS: '', CGO_ENABLED: '0', GOWORK: 'off' }
  delete env.PWD
  return env
}

/** Python runs isolated (-I: no user site, no PYTHONPATH, no current directory on the path) and writes no bytecode. */
function pythonEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, [...args], { cwd, env, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr.trim() || error.message}`, { cause: error }))
      else resolve(stdout)
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

function missingTool(error: unknown, message: string): never {
  if (error instanceof Error && /ENOENT/.test((error.cause as Error | undefined)?.message ?? error.message)) throw new UsageError(message)
  throw error
}

/** Directory of a helper shipped next to dist/ (bundle) or to src/ (tests): go-helper/ or py-helper/. */
export function helperDir(name: 'go-helper' | 'py-helper'): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, name))) return join(dir, name)
    dir = dirname(dir)
  }
  throw new Error(`internal: ${name}/ not found next to farol`)
}

/** Hash of a helper's sources (every file of the directory tree): part of the build and cache keys. */
function sourceHash(dir: string): string {
  const hash = createHash('sha256')
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      if (name === '__pycache__') continue
      const full = join(d, name)
      if (statSync(full).isDirectory()) walk(full)
      else hash.update(full.slice(dir.length)).update(readFileSync(full))
    }
  }
  walk(dir)
  return hash.digest('hex').slice(0, 16)
}

/**
 * Builds the Go helper once per source version, Go version and platform, and returns the binary path. It is kept in
 * the cache directory, so CI caches that keep ~/.cache/farol skip the build.
 */
async function goHelperBinary(): Promise<string> {
  const src = helperDir('go-helper')
  let goVersion: string
  try {
    goVersion = (await run('go', ['env', 'GOVERSION'], src, { ...goEnv(), GOTOOLCHAIN: 'local' })).trim()
  } catch (error) {
    missingTool(error, 'the Go toolchain (go) is required to analyze a Go project; install it or put it on PATH')
  }
  const key = createHash('sha256').update(`${sourceHash(src)}\n${goVersion}\n${process.platform}-${process.arch}`).digest('hex').slice(0, 24)
  const dir = join(defaultCacheDir(), 'go-helper', key)
  const binary = join(dir, process.platform === 'win32' ? 'gohelper.exe' : 'gohelper')
  if (existsSync(binary)) return binary
  mkdirSync(dir, { recursive: true })
  try {
    await run('go', ['build', '-o', binary, '.'], src, { ...goEnv(), GOTOOLCHAIN: 'local' })
  } catch (error) {
    missingTool(error, 'the Go toolchain (go) is required to analyze a Go project; install it or put it on PATH')
  }
  return binary
}

/** Runs the Python helper package (py-helper/farol_py) with the given arguments. */
function runPythonHelper(args: readonly string[], cwd: string, input?: string): Promise<string> {
  const dir = helperDir('py-helper')
  const boot = 'import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module("farol_py",run_name="__main__")'
  return run('python3', ['-I', '-c', boot, dir, ...args], cwd, pythonEnv(), input).catch((error: unknown) => missingTool(error, 'Python 3.11+ (python3) is required to analyze a Python project; install it or put it on PATH'))
}

/** pyproject.toml as JSON, read with Python's tomllib (no TOML parser in farol itself). */
export async function readToml(text: string): Promise<unknown> {
  return JSON.parse(await runPythonHelper(['toml'], tmpdir(), text)) as unknown
}

/** Prints the helper JSON of a tree exported to `dir`. */
type TreeReader = (dir: string, project: string, comments: readonly string[]) => Promise<string>

async function readerFor(ctx: Context): Promise<{ label: string; version: string; read: TreeReader }> {
  if (ctx.config.language === 'go') {
    const binary = await goHelperBinary()
    return {
      label: 'Go',
      version: sourceHash(helperDir('go-helper')),
      read: async (dir, project, comments) => {
        try {
          return await run(binary, ['-root', dir, '-project', project, ...(comments.length > 0 ? ['-comments', comments.join(',')] : [])], dir, goEnv())
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`${message}${/module cache|not loaded|missing|GOPROXY=off|verifying/.test(message) ? ' (farol reads Go modules offline: run "go mod download" before analyzing)' : ''}`, { cause: error })
        }
      },
    }
  }
  const roots = ctx.config.python.roots.join(',')
  return { label: 'Python', version: sourceHash(helperDir('py-helper')), read: (dir, project, comments) => runPythonHelper(['analyze', '--root', dir, '--project', project, '--roots', roots, '--comments', comments.join(',')], dir) }
}

/** Where helper outputs are kept between runs; null disables the cache. */
export type CacheDir = string | null

/** Default cache directory: FAROL_CACHE_DIR (or the former REVSCOPE_CACHE_DIR), else $XDG_CACHE_HOME/farol, else ~/.cache/farol. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FAROL_CACHE_DIR ?? env.REVSCOPE_CACHE_DIR ?? join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'farol')
}

/** Entries kept in the cache directory (the oldest are removed beyond this). */
const CACHE_ENTRIES = 200

function prune(dir: string): void {
  const entries = readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t)
  for (const e of entries.slice(CACHE_ENTRIES)) rmSync(join(dir, e.n), { force: true })
}

interface Reader {
  label: string
  version: string
  read: TreeReader
}

async function readTree(ctx: Context, reader: Reader, sha: string, comments: readonly string[], cache: CacheDir): Promise<DeclHelperOutput> {
  const project = ctx.projectPrefix === '' ? '.' : ctx.projectPrefix
  // Same tree, same helper, same settings: same output. Base trees repeat across the runs of every PR.
  const key = cache === null ? null : createHash('sha256').update(JSON.stringify([TOOL_VERSION, reader.label, reader.version, await treeOf(ctx.repoRoot, sha), project, ctx.config.python.roots, [...comments].sort()])).digest('hex')
  const file = key === null || cache === null ? null : join(cache, `${key}.json`)
  if (file !== null && existsSync(file)) {
    const cached = DeclHelperSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (cached.success) {
      ctx.log(`${reader.label}: ${sha.slice(0, 12)} read from the cache`)
      return cached.data
    }
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'farol-tree-')))
  try {
    await exportTree(ctx.repoRoot, sha, dir)
    const stdout = await reader.read(dir, project, comments)
    const parsed = DeclHelperSchema.safeParse(JSON.parse(stdout))
    if (!parsed.success) throw new Error(`internal: unexpected ${reader.label} helper output: ${parsed.error.issues[0]?.message ?? ''}`)
    if (file !== null && cache !== null) {
      mkdirSync(cache, { recursive: true })
      writeFileSync(file, stdout)
      prune(cache)
    }
    return parsed.data
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The helper output of one tree: a git ref (exported to a temporary directory) or the working tree. */
export async function readLangTree(ctx: Context, ref: string | undefined, cache: CacheDir = null): Promise<DeclHelperOutput> {
  const reader = await readerFor(ctx)
  const { label, read } = reader
  if (ref !== undefined) return readTree(ctx, reader, ref, [], cache)
  const parsed = DeclHelperSchema.safeParse(JSON.parse(await read(ctx.repoRoot, ctx.projectPrefix === '' ? '.' : ctx.projectPrefix, [])))
  if (!parsed.success) throw new Error(`internal: unexpected ${label} helper output: ${parsed.error.issues[0]?.message ?? ''}`)
  return parsed.data
}

export interface LangWorkspace {
  base: DeclHelperOutput
  head: DeclHelperOutput
  graph: ImportGraph
  headRoutes: RouteTable
  /** Head entry points that already existed (the base table, as the classifier compares tables). */
  baseRoutes: RouteTable
  impacts: Map<string, BackendFileImpact>
}

const EXTENSIONS = { go: '.go', python: '.py' } as const

/**
 * Reads base and head with the language helper (Go or Python) and computes the declaration-level impact of every
 * changed source file.
 */
export async function loadLangWorkspace(ctx: Context, files: readonly ChangedFile[], mergeBaseSha: string, headSha: string, isSource: (path: string) => boolean, timings: Record<string, number>, clock: () => number, cache: CacheDir = null): Promise<LangWorkspace> {
  let t = clock()
  const reader = await readerFor(ctx)
  const { label } = reader
  timings.helperSetup = Math.round(clock() - t)
  t = clock()
  const ext = ctx.config.language === 'go' ? EXTENSIONS.go : EXTENSIONS.python
  const changed = files.filter((f) => f.status !== 'deleted' && f.path.endsWith(ext)).map((f) => f.path)
  const [base, head] = await Promise.all([readTree(ctx, reader, mergeBaseSha, [], cache), readTree(ctx, reader, headSha, changed, cache)])
  timings.helperRead = Math.round(clock() - t)
  ctx.log(`${label}: ${head.files.length} files, ${head.decls.length} declarations, ${head.entries.length} entry points`)
  const headRoutes = declRouteTable(head)
  const baseKeys = new Set(base.entries.map((e) => e.key))
  return {
    base,
    head,
    graph: declImportGraph(head),
    headRoutes,
    baseRoutes: { ...headRoutes, routes: headRoutes.routes.filter((r) => baseKeys.has(r.key)), dynamic: [] },
    impacts: declImpacts(base, head, files, isSource),
  }
}
