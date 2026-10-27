import { describe, expect, it } from 'vitest'
import { ECOSYSTEM_FILES } from '../../src/classify/dependencies.js'
import { helperDir } from '../../src/cli/lang-workspace.js'
import { parseConfig, UsageError } from '../../src/config/load.js'
import { HELPER_EXTENSIONS, HELPER_LANGUAGES, isHelperLanguage, isHelperSource, LANGUAGES, SCRIPT_EXTENSIONS } from '../../src/config/languages.js'
import { GO_DEFAULT_EXCLUDE } from '../../src/config/schema.js'
import { isCodeFile } from '../../src/signals/paths.js'

describe('language table', () => {
  it('has one helper entry per language except TypeScript, each with a helper directory shipped with farol', () => {
    expect(LANGUAGES.filter(isHelperLanguage)).toEqual(Object.keys(HELPER_LANGUAGES))
    for (const info of Object.values(HELPER_LANGUAGES)) expect(() => helperDir(info.helper)).not.toThrow()
  })

  it('gives every language its manifests and lockfiles', () => {
    expect(Object.keys(ECOSYSTEM_FILES).sort()).toEqual([...LANGUAGES].sort())
  })

  it('keeps helper extensions apart from each other and from TypeScript', () => {
    const all = [...SCRIPT_EXTENSIONS, ...HELPER_EXTENSIONS]
    expect(new Set(all).size).toBe(all.length)
    // Razor views are code, but coverage tools report the classes they compile to, never their own lines.
    for (const ext of all) expect(isCodeFile(`src/a${ext}`)).toBe(ext !== '.cshtml')
  })

  it('tells which files a helper reads', () => {
    expect(isHelperSource('go', 'cmd/api/main.go')).toBe(true)
    expect(isHelperSource('go', 'app/main.py')).toBe(false)
    expect(isHelperSource('python', 'app/main.py')).toBe(true)
  })

  it('names the language in configuration errors and applies its default excludes', () => {
    for (const [language, info] of Object.entries(HELPER_LANGUAGES)) {
      expect(() => parseConfig(JSON.stringify({ language }), 'c')).toThrow(UsageError)
      expect(() => parseConfig(JSON.stringify({ language }), 'c')).toThrow(`a ${info.label} project is a backend`)
    }
    expect(parseConfig('{"language":"go","surface":"backend"}', 'c').exclude).toEqual(GO_DEFAULT_EXCLUDE)
    expect(parseConfig('{"language":"go","surface":"backend","exclude":["x/**"]}', 'c').exclude).toEqual(['x/**'])
    expect(parseConfig('{"language":"python","surface":"backend"}', 'c').exclude).toEqual([])
  })
})
