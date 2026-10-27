import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
export const BASE_APP_DIR = join(FIXTURES_DIR, '_base-app')
/** Backend scenarios (`b1-…`) start from the base API instead of the base app. */
export const BASE_API_DIR = join(FIXTURES_DIR, '_base-api')
/** Go scenarios (`g1-…`) start from a stdlib-only Go module (analyzed offline). */
export const BASE_GO_DIR = join(FIXTURES_DIR, '_base-go')
/** Python scenarios (`p1-…`) start from a small FastAPI project (src layout). */
export const BASE_PY_DIR = join(FIXTURES_DIR, '_base-py')
/** C# scenarios (`c1-…`) start from a small ASP.NET Core solution (web project, class library, test project). */
export const BASE_CS_DIR = join(FIXTURES_DIR, '_base-cs')

let clock = 0

/** Environment that makes commits byte-identical on every machine: fixed identity, dates and no user config. */
function gitEnv(): NodeJS.ProcessEnv {
  const date = new Date(Date.UTC(2026, 0, 1) + clock * 60_000).toISOString()
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'farol',
    GIT_AUTHOR_EMAIL: 'farol@example.com',
    GIT_COMMITTER_NAME: 'farol',
    GIT_COMMITTER_EMAIL: 'farol@example.com',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  }
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, env: gitEnv(), encoding: 'utf8' })
}

export class TestRepo {
  constructor(readonly dir: string) {}

  write(path: string, content: string): void {
    const full = join(this.dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }

  read(path: string): string {
    return readFileSync(join(this.dir, path), 'utf8')
  }

  remove(path: string): void {
    rmSync(join(this.dir, path), { recursive: true, force: true })
  }

  /** Copies a directory over the working tree. */
  overlay(sourceDir: string): void {
    if (existsSync(sourceDir)) cpSync(sourceDir, this.dir, { recursive: true })
  }

  /** Stages everything and commits; returns the new SHA. Dates advance one minute per commit. */
  commit(message: string): string {
    clock++
    git(this.dir, 'add', '-A')
    git(this.dir, 'commit', '-q', '--allow-empty', '--no-verify', '-m', message)
    return this.sha('HEAD')
  }

  sha(ref: string): string {
    return git(this.dir, 'rev-parse', ref).trim()
  }

  git(...args: string[]): string {
    return git(this.dir, ...args)
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true })
  }
}

/** Creates an empty repository on branch `main` in a fresh temporary directory. */
export function createRepo(): TestRepo {
  clock = 0
  const dir = mkdtempSync(join(tmpdir(), 'farol-test-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return new TestRepo(dir)
}

export interface ScenarioRepo {
  repo: TestRepo
  base: string
  head: string
}

/**
 * Builds the repository of a scenario: the shared base app plus `<scenario>/base/` is committed on `main`,
 * then `<scenario>/head/` is applied (and every path in `<scenario>/deleted.txt` removed) on branch `feature`.
 */
export function createScenarioRepo(scenario: string): ScenarioRepo {
  const scenarioDir = join(FIXTURES_DIR, scenario)
  if (!existsSync(scenarioDir)) throw new Error(`fixture ${scenario} not found in ${FIXTURES_DIR}`)
  const repo = createRepo()
  repo.overlay(/^b\d/.test(scenario) ? BASE_API_DIR : /^g\d/.test(scenario) ? BASE_GO_DIR : /^p\d/.test(scenario) ? BASE_PY_DIR : /^c\d/.test(scenario) ? BASE_CS_DIR : BASE_APP_DIR)
  repo.overlay(join(scenarioDir, 'base'))
  const base = repo.commit('base')
  repo.git('checkout', '-q', '-b', 'feature')
  const deleted = join(scenarioDir, 'deleted.txt')
  if (existsSync(deleted)) {
    for (const line of readFileSync(deleted, 'utf8').split('\n')) {
      const path = line.trim()
      if (path !== '' && !path.startsWith('#')) repo.remove(path)
    }
  }
  repo.overlay(join(scenarioDir, 'head'))
  const head = repo.commit('head')
  return { repo, base, head }
}
