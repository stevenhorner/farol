import { isAbsolute, posix } from 'node:path'
import { HELPER_EXTENSIONS, SCRIPT_EXTENSIONS } from '../config/languages.js'

// Razor views and .proto files compile into generated classes: coverage tools never report their own lines.
const CODE_EXTENSIONS = new Set([...SCRIPT_EXTENSIONS, ...HELPER_EXTENSIONS].filter((e) => e !== '.cshtml' && e !== '.proto'))

/** Code files (not declarations): the only files coverage and suppressions apply to (helper languages have their own readers). */
export function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.has(posix.extname(path)) && !path.endsWith('.d.ts')
}

/**
 * Repo-relative path of a report entry. Absolute paths are made relative to the repository root; relative paths
 * are taken relative to the project directory (where the tests and the linter run). Backslashes become `/`.
 * `canonical` resolves symlinks (reports may use a symlinked path, git always gives the real one).
 */
export function reportPathToRepo(raw: string, repoRoot: string, projectPrefix: string, canonical: (path: string) => string = (x) => x): string | undefined {
  const p = canonical(raw).replaceAll('\\', '/')
  const root = repoRoot.replaceAll('\\', '/')
  if (isAbsolute(p) || /^[A-Za-z]:\//.test(p)) {
    if (!p.startsWith(`${root}/`)) return undefined
    return p.slice(root.length + 1)
  }
  return posix.normalize(posix.join(projectPrefix, p))
}

/** Groups sorted line numbers into contiguous ranges. */
export function toRanges(lines: readonly number[]): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = ranges[ranges.length - 1]
    if (last && line === last.end + 1) last.end = line
    else if (!last || line > last.end) ranges.push({ start: line, end: line })
  }
  return ranges
}
