import { z } from 'zod'
import { compareSpecs, ManifestParseError, sortChanges, type DependencyChange, type ManifestDiff } from '../classify/dependencies.js'
import { compareStrings } from '../output/order.js'

/** A project file as the C# helper reads it (`cshelper manifest`). */
export const CsManifestSchema = z.object({
  packages: z.array(z.object({ name: z.string(), version: z.string(), section: z.enum(['dependencies', 'devDependencies']) })),
  other: z.record(z.string(), z.string()),
})

export type CsManifest = z.infer<typeof CsManifestSchema>

/**
 * Items whose addition changes no build setting: a new file to compile or copy, a global using, a reference to another
 * project of the repository. Changing or removing an existing one is still a manifest change.
 */
const ADDITIVE_ITEMS = ['Compile', 'Content', 'None', 'EmbeddedResource', 'Folder', 'Using', 'ProjectReference']

/**
 * A NuGet version as a range farol can compare: `1.2.3` (at least 1.2.3) and `[1.0,2.0)` (from 1.0) by their lowest
 * version; floating (`1.*`) and MSBuild-computed (`$(Version)`) versions cannot be compared.
 */
export function nugetSpec(version: string): string {
  const v = version.trim()
  if (v === '' || v.includes('*') || v.includes('$(')) return `unknown:${v}`
  if (v.startsWith('[') || v.startsWith('(')) return v.slice(1).split(',')[0]?.trim() || `unknown:${v}`
  return v
}

/** Dependency changes between the base and head versions of a .csproj or Directory.Packages.props (null: no file). */
export function diffNuGet(manifest: string, base: unknown, head: unknown): ManifestDiff {
  const parse = (value: unknown, label: string): CsManifest => {
    if (value === null) return { packages: [], other: {} }
    const parsed = CsManifestSchema.safeParse(value)
    if (!parsed.success) throw new ManifestParseError(`the ${label} version could not be read`)
    return parsed.data
  }
  const before = parse(base, 'base')
  const after = parse(head, 'head')
  const key = (p: CsManifest['packages'][number]): string => p.name.toLowerCase()
  const beforeByName = new Map(before.packages.map((p) => [key(p), p]))
  const afterByName = new Map(after.packages.map((p) => [key(p), p]))
  const changes: DependencyChange[] = []
  for (const [name, b] of beforeByName) {
    const a = afterByName.get(name)
    if (!a) {
      changes.push({ manifest, name: b.name, section: b.section, change: 'removed', from: b.version, to: null, bump: null, direction: null, critical: true })
      continue
    }
    if (a.section !== b.section) {
      changes.push({ manifest, name: a.name, section: a.section, change: 'moved', from: b.version, to: a.version, fromSection: b.section, bump: null, direction: null, critical: b.section === 'dependencies' })
      continue
    }
    if (a.version === b.version) continue
    const from = nugetSpec(b.version)
    const to = nugetSpec(a.version)
    changes.push({ manifest, name: a.name, section: a.section, change: 'updated', from: b.version, to: a.version, ...compareSpecs(from, to), ...(from.startsWith('unknown:') || to.startsWith('unknown:') ? { note: 'floating or computed version: compare the resolved packages' } : {}) })
  }
  for (const [name, a] of afterByName) {
    if (!beforeByName.has(name)) changes.push({ manifest, name: a.name, section: a.section, change: 'added', from: null, to: a.version, bump: null, direction: null, critical: false })
  }
  const otherFields = new Set<string>()
  for (const [k, v] of Object.entries(before.other)) if (after.other[k] !== v) otherFields.add(k)
  for (const k of Object.keys(after.other)) {
    if (k in before.other) continue
    const item = /^item:([^:]+):Include=/.exec(k)?.[1]
    if (item === undefined || !ADDITIVE_ITEMS.includes(item)) otherFields.add(k)
  }
  return { manifest, changes: sortChanges(changes), otherFields: [...otherFields].sort(compareStrings) }
}
