import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { UsageError } from '../config/load.js'
import { OutputSchema, type Output } from '../output/schema.js'
import { ReviewersFileSchema } from '../review/ownership.js'
import { renderHtml } from '../report/html.js'
import { renderReport } from '../report/markdown.js'
import { createLinker, type Linker } from '../report/links.js'
import { writeTextFile } from '../output/write.js'
import { writeStdout } from './run.js'

/** Reads and validates an analyze JSON; invalid input is a usage error (exit 1). */
export function readOutputFile(path: string): Output {
  const full = resolve(path)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(full, 'utf8'))
  } catch (error) {
    throw new UsageError(`cannot read ${full}: ${error instanceof Error ? error.message : String(error)}; pass the file written by "farol analyze --out"`)
  }
  const parsed = OutputSchema.safeParse(raw)
  if (!parsed.success) throw new UsageError(`${full} is not a farol analyze result (schema version 1): ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`)
  return parsed.data
}

export interface RenderOptions {
  in: string
  /** reviewers.json written by `farol reviewers`. */
  reviewers?: string
  repo?: string
  pr?: number
  /** Link to the HTML report (e.g. the workflow artifact), shown at the top of the comment. */
  reportUrl?: string
}

/** The analysis with the reviewers file merged in, when one is given. */
export function withReviewers(output: Output, path: string | undefined): Output {
  if (path === undefined) return output
  const full = resolve(path)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(full, 'utf8'))
  } catch (error) {
    throw new UsageError(`cannot read ${full}: ${error instanceof Error ? error.message : String(error)}; pass the file written by "farol reviewers --out"`)
  }
  const parsed = ReviewersFileSchema.safeParse(raw)
  if (!parsed.success) throw new UsageError(`${full} is not a farol reviewers file: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`)
  if (parsed.data.head !== null && output.head.sha !== null && parsed.data.head !== output.head.sha) throw new UsageError(`${full} was computed for commit ${parsed.data.head.slice(0, 12)}, not ${output.head.sha.slice(0, 12)}: run "farol reviewers" again`)
  return { ...output, ownership: parsed.data }
}

/** Links of a rendered report: flags win over the repository and PR recorded in the JSON. */
export function linkerFor(output: Output, options: { repo?: string | undefined; pr?: number | undefined }, env: NodeJS.ProcessEnv = process.env): Linker {
  const serverUrl = env.GITHUB_SERVER_URL
  return createLinker(output, { repo: options.repo ?? output.repo, pr: options.pr ?? output.pr, ...(serverUrl ? { serverUrl } : {}) })
}

export async function reportCommand(options: RenderOptions & { sinceIn?: string; sinceReportUrl?: string }): Promise<number> {
  const output = withReviewers(readOutputFile(options.in), options.reviewers)
  if (options.sinceReportUrl !== undefined && !options.sinceReportUrl.startsWith('https://')) throw new UsageError(`--since-report-url must be an https URL, got "${options.sinceReportUrl}"`)
  // The same comment as "farol comment" prints, for a workflow that posts it from a job of its own.
  const since = options.sinceIn === undefined ? undefined : { output: readOutputFile(options.sinceIn), ...(options.sinceReportUrl === undefined ? {} : { reportUrl: options.sinceReportUrl }) }
  await writeStdout(renderReport(output, undefined, linkerFor(output, options), options.reportUrl, since))
  return 0
}

/** Writes the single-file HTML report (stdout without --out). */
export async function htmlCommand(options: RenderOptions & { out?: string }): Promise<number> {
  const raw = withReviewers(readOutputFile(options.in), options.reviewers)
  // Flags also name the repository and PR in the page, not only in the links.
  const output = { ...raw, repo: options.repo ?? raw.repo, pr: options.pr ?? raw.pr }
  const html = renderHtml(output, linkerFor(output, options))
  if (options.out === undefined) await writeStdout(html)
  else writeTextFile(resolve(options.out), html)
  return 0
}
