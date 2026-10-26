import type { ChangedFile } from '../git/types.js'
import { compareStrings } from '../output/order.js'
import type { SuppressionKind, SuppressionsSignal } from '../output/schema.js'

/** Suppressions read from the comments and directives the C# helper prints (Roslyn trivia, so strings never match). */
const CSHARP_SUPPRESSIONS: [RegExp, SuppressionKind][] = [
  [/^#\s*pragma\s+warning\s+disable\b/, 'pragma-warning-disable'],
  [/^#\s*nullable\s+disable\b/, 'nullable-disable'],
  [/^\/\/\s*ReSharper\s+disable\b/, 'resharper-disable'],
]

/** `#pragma warning disable`, `#nullable disable` and `// ReSharper disable` on the lines a PR adds to C# files. */
export function csharpSuppressions(files: readonly ChangedFile[], comments: readonly { file: string; line: number; text: string }[]): SuppressionsSignal['items'] {
  const added = new Map(files.map((f) => [f.path, new Set(f.added.map((l) => l.line))]))
  const items: SuppressionsSignal['items'] = []
  for (const c of comments) {
    if (!added.get(c.file)?.has(c.line)) continue
    const kind = CSHARP_SUPPRESSIONS.find(([pattern]) => pattern.test(c.text))?.[1]
    if (kind) items.push({ path: c.file, line: c.line, kind, text: c.text.slice(0, 200) })
  }
  return items.sort((a, b) => compareStrings(a.path, b.path) || a.line - b.line)
}
