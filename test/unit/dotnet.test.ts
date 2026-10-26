import { describe, expect, it } from 'vitest'
import { ManifestParseError } from '../../src/classify/dependencies.js'
import { parseConfig } from '../../src/config/load.js'
import { CSHARP_DEFAULT_EXCLUDE, CSHARP_DEFAULT_ROLES } from '../../src/config/schema.js'
import { createRoleMatcher } from '../../src/classify/roles.js'
import { diffNuGet, nugetSpec } from '../../src/dotnet/nuget.js'
import { csharpSuppressions } from '../../src/signals/dotnet.js'
import type { ChangedFile } from '../../src/git/types.js'

const manifest = (packages: [string, string, ('dependencies' | 'devDependencies')?][], other: Record<string, string> = {}) => ({
  packages: packages.map(([name, version, section]) => ({ name, version, section: section ?? 'dependencies' })),
  other,
})

describe('NuGet versions', () => {
  it('compares a range by its lowest version and cannot compare floating or computed versions', () => {
    expect(nugetSpec('1.2.3')).toBe('1.2.3')
    expect(nugetSpec('[1.0,2.0)')).toBe('1.0')
    expect(nugetSpec('(,2.0]')).toMatch(/^unknown:/)
    expect(nugetSpec('1.*')).toMatch(/^unknown:/)
    expect(nugetSpec('$(SerilogVersion)')).toMatch(/^unknown:/)
  })
})

describe('diffNuGet', () => {
  it('reports package changes like npm dependencies', () => {
    const diff = diffNuGet(
      'App.csproj',
      manifest([['Polly', '8.4.1'], ['Serilog', '3.1.1'], ['Old.Package', '1.0.0'], ['StyleCop.Analyzers', '1.1.118', 'devDependencies']]),
      manifest([['Polly', '8.4.2'], ['serilog', '4.0.0'], ['New.Package', '1.0.0'], ['StyleCop.Analyzers', '1.2.0-beta.556', 'devDependencies']]),
    )
    expect(diff.changes.map((c) => `${c.change} ${c.name} ${c.bump ?? '-'} ${c.critical}`)).toEqual([
      'added New.Package - false',
      'removed Old.Package - true',
      'updated Polly patch false',
      'updated StyleCop.Analyzers minor false',
      'updated serilog major true',
    ])
  })

  it('treats a floating version as critical', () => {
    const diff = diffNuGet('App.csproj', manifest([['Polly', '8.4.1']]), manifest([['Polly', '8.*']]))
    expect(diff.changes[0]).toMatchObject({ bump: 'unknown', critical: true })
  })

  it('reports build settings, but not new files or project references, as other fields', () => {
    const base = manifest([], { 'property:TargetFramework': 'net8.0', 'item:Compile:Remove=Legacy/**': '' })
    const head = manifest([], {
      'property:TargetFramework': 'net10.0',
      'item:Content:Include=seed.json': 'CopyToOutputDirectory=Always',
      'item:ProjectReference:Include=../Lib/Lib.csproj': '',
      'Target:CopyAssets': '<Target Name="CopyAssets" />',
    })
    expect(diffNuGet('App.csproj', base, head).otherFields).toEqual(['Target:CopyAssets', 'item:Compile:Remove=Legacy/**', 'property:TargetFramework'])
  })

  it('reads an added or deleted project file', () => {
    expect(diffNuGet('App.csproj', null, manifest([['Polly', '8.4.1']])).changes.map((c) => c.change)).toEqual(['added'])
    expect(diffNuGet('App.csproj', manifest([['Polly', '8.4.1']]), null).changes.map((c) => c.change)).toEqual(['removed'])
  })

  it('rejects output it cannot read', () => {
    expect(() => diffNuGet('App.csproj', { packages: 'x' }, null)).toThrow(ManifestParseError)
  })
})

describe('C# suppressions', () => {
  it('reads #pragma warning disable, #nullable disable and ReSharper comments on added lines', () => {
    const file: ChangedFile = { path: 'src/A.cs', status: 'modified', added: [{ line: 3, text: '' }, { line: 5, text: '' }, { line: 9, text: '' }], removed: [] } as unknown as ChangedFile
    const items = csharpSuppressions([file], [
      { file: 'src/A.cs', line: 3, text: '#pragma warning disable CS0618' },
      { file: 'src/A.cs', line: 4, text: '#nullable disable' },
      { file: 'src/A.cs', line: 5, text: '// ReSharper disable once UnusedMember.Global' },
      { file: 'src/A.cs', line: 9, text: '// a plain comment' },
    ])
    expect(items.map((i) => `${i.line} ${i.kind}`)).toEqual(['3 pragma-warning-disable', '5 resharper-disable'])
  })
})

describe('C# configuration', () => {
  it('takes the C# roles and excludes', () => {
    const config = parseConfig('{"language":"csharp","surface":"backend","csharp":{"configurations":["Release"],"defines":["FULL"]}}', 'c')
    expect(config.roles).toEqual(CSHARP_DEFAULT_ROLES)
    expect(config.exclude).toEqual(CSHARP_DEFAULT_EXCLUDE)
    expect(config.csharp).toEqual({ projects: [], configurations: ['Release'], defines: ['FULL'], entryCalls: [], viewRoots: [] })
    expect(() => parseConfig('{"language":"csharp","surface":"backend","csharp":{"defines":["NOT VALID"]}}', 'c')).toThrow(/C# identifier/)
  })

  it('gives wwwroot files the client role, except vendored and minified files', () => {
    const role = createRoleMatcher(parseConfig('{"language":"csharp","surface":"backend"}', 'c'))
    expect(role('src/Web/wwwroot/js/site.js')).toBe('client')
    expect(role('src/Web/wwwroot/lib/jquery/jquery.js')).toBe('excluded')
    expect(role('src/Web/wwwroot/js/site.min.js')).toBe('excluded')
    expect(role('src/Web.Tests/HomeTests.cs')).toBe('test')
    expect(role('Directory.Build.props')).toBe('global')
    expect(role('src/Web/Controllers/HomeController.cs')).toBe('source')
  })
})
