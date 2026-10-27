/**
 * The languages farol reads. TypeScript is read in process with the compiler API; every other language is read by a
 * helper written in that language, which prints the JSON of `src/decls/types.ts`. Tables keyed by `Language` or
 * `HelperLanguage` are exhaustive, so adding a language fails to compile until every table has its entry.
 */
export const LANGUAGES = ['typescript', 'go', 'python', 'csharp'] as const

export type Language = (typeof LANGUAGES)[number]

/** Languages read by a helper program instead of the TypeScript compiler. */
export type HelperLanguage = Exclude<Language, 'typescript'>

export interface HelperLanguageInfo {
  /** Name in messages ("a Go project is a backend"). */
  label: string
  /** Directory of the helper, shipped next to dist/ (see `helperDir`). */
  helper: 'go-helper' | 'py-helper' | 'cs-helper'
  /** Extensions of the source files the helper reads. */
  extensions: readonly string[]
  /** Name of the lint report in messages ("no golangci-lint report given"). */
  lintTool: string
  /** Why security is not verified when the lint report has no static analysis findings. */
  securityHint: string
}

export const HELPER_LANGUAGES: Record<HelperLanguage, HelperLanguageInfo> = {
  go: {
    label: 'Go',
    helper: 'go-helper',
    extensions: ['.go'],
    lintTool: 'golangci-lint',
    securityHint: 'Go files are checked by gosec: give a golangci-lint JSON report (with gosec enabled) as the lint report',
  },
  python: {
    label: 'Python',
    helper: 'py-helper',
    extensions: ['.py'],
    lintTool: 'ruff',
    securityHint: 'Python files are checked by flake8-bandit: give a ruff JSON report (with the S rules selected) as the lint report',
  },
  csharp: {
    label: 'C#',
    helper: 'cs-helper',
    extensions: ['.cs', '.cshtml', '.proto'],
    lintTool: 'SARIF',
    securityHint: 'C# files are checked by the .NET security analyzers (CA2100, CA3xxx, CA5xxx) or Security Code Scan: give their SARIF report as the lint report',
  },
}

export function isHelperLanguage(language: Language): language is HelperLanguage {
  return language !== 'typescript'
}

/** TypeScript and JavaScript code files. */
export const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const

/** Source files of every helper language, whatever the project's language. */
export const HELPER_EXTENSIONS: readonly string[] = Object.values(HELPER_LANGUAGES).flatMap((l) => l.extensions)

/** Whether a path is a source file the helper of `language` reads. */
export function isHelperSource(language: HelperLanguage, path: string): boolean {
  return HELPER_LANGUAGES[language].extensions.some((e) => path.endsWith(e))
}
