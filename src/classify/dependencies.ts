import { isDeepStrictEqual } from 'node:util'
import type { Language } from '../config/languages.js'
import { compareStrings } from '../output/order.js'

export const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const
/** go.mod requirements: direct (`require`) or `// indirect`. */
export const GO_SECTIONS = ['require', 'indirect'] as const
export type DependencySection = (typeof DEPENDENCY_SECTIONS)[number] | (typeof GO_SECTIONS)[number]

/** File names of lockfiles farol recognizes. */
export const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'go.sum', 'uv.lock', 'poetry.lock', 'Pipfile.lock', 'pdm.lock'])

/** File names of manifests: package.json (npm), go.mod (Go modules), pyproject.toml and requirements.txt (Python). */
export const MANIFESTS = new Set(['package.json', 'go.mod', 'pyproject.toml', 'requirements.txt'])

/** Manifests and lockfiles of each language's ecosystem. */
export const ECOSYSTEM_FILES: Record<Language, ReadonlySet<string>> = {
  typescript: new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']),
  go: new Set(['go.mod', 'go.sum']),
  python: new Set(['pyproject.toml', 'requirements.txt', 'uv.lock', 'poetry.lock', 'Pipfile.lock', 'pdm.lock']),
}

/** `range`: same base version, only the range operator changed (`^1.2.3` → `~1.2.3`). */
export type Bump = 'major' | 'minor' | 'patch' | 'range' | 'unknown'

export interface DependencyChange {
  manifest: string
  name: string
  section: DependencySection
  change: 'added' | 'removed' | 'updated' | 'moved'
  from: string | null
  to: string | null
  /** For moved dependencies: the section it left. */
  fromSection?: DependencySection
  /** Python: the extra or dependency group the requirement belongs to (a package may appear in several). */
  group?: string
  bump: Bump | null
  direction: 'upgrade' | 'downgrade' | null
  critical: boolean
  note?: string
}

export interface ManifestDiff {
  manifest: string
  changes: DependencyChange[]
  /** Top-level fields other than the dependency sections whose value changed (scripts, engines, overrides…). */
  otherFields: string[]
}

export class ManifestParseError extends Error {}

interface Version {
  major: number
  minor: number
  patch: number
}

const PROTOCOLS = ['workspace:', 'catalog:', 'file:', 'link:', 'portal:', 'git', 'http:', 'https:', 'github:']

/**
 * Lowest version a specifier allows (`^1.2.3`, `~1.2`, `>=2`, `1.x`, `npm:pkg@^3`), or null when it is not a
 * plain semver range (protocols, tags such as `latest`, `||` unions, hyphen ranges). Parsed without dependencies.
 */
export function parseVersion(spec: string): Version | null {
  let s = spec.trim()
  if (s.startsWith('npm:')) s = s.slice(s.lastIndexOf('@') + 1)
  if (s.includes('||') || s.includes(' - ') || PROTOCOLS.some((p) => s.startsWith(p))) return null
  const match = /^(?:[\^~]|[<>]=?|=)?\s*v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/.exec(s)
  if (!match) return null
  const num = (part: string | undefined): number => (part === undefined || !/^\d+$/.test(part) ? 0 : Number(part))
  return { major: num(match[1]), minor: num(match[2]), patch: num(match[3]) }
}

function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/** Bump between two specifiers, its direction, and whether it is critical. */
export function compareSpecs(from: string, to: string): { bump: Bump; direction: 'upgrade' | 'downgrade' | null; critical: boolean; note?: string } {
  const a = parseVersion(from)
  const b = parseVersion(to)
  if (!a || !b) {
    const sameProtocol = PROTOCOLS.find((p) => from.startsWith(p)) === PROTOCOLS.find((p) => to.startsWith(p)) && (from.startsWith('workspace:') || from.startsWith('catalog:'))
    if (sameProtocol) return { bump: 'range', direction: null, critical: false, note: 'workspace/catalog specifier changed' }
    return { bump: 'unknown', direction: null, critical: true, note: 'versions cannot be compared' }
  }
  const order = compareVersions(a, b)
  if (order === 0) return { bump: 'range', direction: null, critical: false }
  const direction = order < 0 ? 'upgrade' : 'downgrade'
  const bump: Bump = a.major !== b.major ? 'major' : a.minor !== b.minor ? 'minor' : 'patch'
  // Under 0.x, a minor bump is breaking (and under 0.0.x, so is a patch bump): caret ranges do not cross them.
  if (bump === 'minor' && a.major === 0 && b.major === 0) return { bump, direction, critical: true, note: 'minor bump of a 0.x version is breaking' }
  if (bump === 'patch' && a.major === 0 && b.major === 0 && a.minor === 0 && b.minor === 0) return { bump, direction, critical: true, note: 'patch bump of a 0.0.x version is breaking' }
  return { bump, direction, critical: bump === 'major', ...(direction === 'downgrade' ? { note: 'downgrade' } : {}) }
}

function parseManifest(text: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new ManifestParseError(`the ${label} version is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ManifestParseError(`the ${label} version is not a JSON object`)
  return value as Record<string, unknown>
}

function section(manifest: Record<string, unknown>, name: DependencySection): Map<string, string> {
  const value = manifest[name]
  if (typeof value !== 'object' || value === null) return new Map()
  return new Map(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))
}

const RUNTIME_SECTIONS = new Set<DependencySection>(['dependencies', 'peerDependencies'])

/** Dependency changes between the base and head versions of a package.json (null text: the file does not exist). */
export function diffManifest(manifest: string, baseText: string | null, headText: string | null): ManifestDiff {
  const base = baseText === null ? {} : parseManifest(baseText, 'base')
  const head = headText === null ? {} : parseManifest(headText, 'head')
  const removed: DependencyChange[] = []
  const added: DependencyChange[] = []
  const changes: DependencyChange[] = []
  for (const name of DEPENDENCY_SECTIONS) {
    const before = section(base, name)
    const after = section(head, name)
    for (const [pkg, from] of before) {
      const to = after.get(pkg)
      if (to === undefined) removed.push({ manifest, name: pkg, section: name, change: 'removed', from, to: null, bump: null, direction: null, critical: true })
      else if (to !== from) changes.push({ manifest, name: pkg, section: name, change: 'updated', from, to, ...compareSpecs(from, to) })
    }
    for (const [pkg, to] of after) {
      if (!before.has(pkg)) added.push({ manifest, name: pkg, section: name, change: 'added', from: null, to, bump: null, direction: null, critical: false })
    }
  }
  // A package removed from one section and added to another moved: it is critical only when it leaves the runtime.
  for (const r of removed) {
    const a = added.find((x) => x.name === r.name)
    if (!a) {
      changes.push(r)
      continue
    }
    added.splice(added.indexOf(a), 1)
    const versions = r.from === a.to || r.from === null || a.to === null ? { bump: null, direction: null, critical: false } : compareSpecs(r.from, a.to)
    const leavesRuntime = RUNTIME_SECTIONS.has(r.section) && !RUNTIME_SECTIONS.has(a.section)
    changes.push({
      manifest,
      name: r.name,
      section: a.section,
      change: 'moved',
      from: r.from,
      to: a.to,
      fromSection: r.section,
      bump: versions.bump,
      direction: versions.direction,
      critical: versions.critical || leavesRuntime,
      ...(leavesRuntime ? { note: `no longer a ${r.section} entry: not installed for consumers/production` } : 'note' in versions && versions.note ? { note: versions.note } : {}),
    })
  }
  changes.push(...added)
  const ignored = new Set<string>(DEPENDENCY_SECTIONS)
  const otherFields = [...new Set([...Object.keys(base), ...Object.keys(head)])].filter((k) => !ignored.has(k) && !isDeepStrictEqual(base[k], head[k])).sort(compareStrings)
  return { manifest, changes: sortChanges(changes), otherFields }
}

export function sortChanges(changes: readonly DependencyChange[]): DependencyChange[] {
  return [...changes].sort((a, b) => compareStrings(a.manifest, b.manifest) || compareStrings(a.name, b.name) || compareStrings(a.section, b.section) || compareStrings(a.group ?? '', b.group ?? ''))
}

/** Short label of a change for reason details: `react 18.2.0 → 19.0.0 (major)`. */
export function describeChange(c: DependencyChange): string {
  const where = c.change === 'moved' ? ` (${c.fromSection ?? '?'} → ${c.section})` : c.section === 'dependencies' || c.section === 'require' ? '' : ` (${c.section})`
  const what = c.change === 'added' ? `added ${c.to ?? ''}` : c.change === 'removed' ? `removed (was ${c.from ?? ''})` : `${c.from ?? ''} → ${c.to ?? ''}${c.bump ? ` (${c.bump})` : ''}`
  return `${c.name} ${what}${where}${c.group ? ` [${c.group}]` : ''}${c.note ? `; ${c.note}` : ''}`
}
