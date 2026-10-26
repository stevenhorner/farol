import { scoreGroups, type ScoreItem } from './merge-score.js'

/** Kinds of score items checked on their own, at their line, rather than by reviewing their file. */
export const FINDING_KINDS: ReadonlySet<ScoreItem['kind']> = new Set(['security', 'lint'])

/**
 * One part of the merge score as the reviewer clears it: a file (reviewed), a finding (checked at its line), a
 * contract change, a vulnerable dependency, or an analysis problem. The HTML report builds the same parts in the
 * browser (assets/report/wb-core.js, GROUPS): the PR comment and the report must count alike.
 */
export interface ReviewPart {
  kind: 'file' | 'finding' | 'contract' | 'vulnerability' | 'unread' | 'other'
  /** The reviewed file, or the file of a finding. */
  file: string | null
  line: number | null
  items: ScoreItem[]
  /** Risk of the part on its own, 0–100: ranks files into tiers, stable while others are reviewed. */
  own: number
  /** Whole-number share of the merge score; all shares add up to the score. */
  points: number
  /** Checked by hand before approving, above every file: findings, contract changes, vulnerable dependencies and what farol could not read. */
  must: boolean
}

/** Tiers of files by their own points, as in the report. */
export const HIGH_TIER = 20
export const MEDIUM_TIER = 5

const logOf = (items: readonly ScoreItem[]): number => items.reduce((s, i) => s - Math.log(1 - i.weight), 0)
const ownOf = (items: readonly ScoreItem[]): number => Math.round(100 * (1 - Math.exp(-logOf(items))))

/** Parts of the score with their shares (log attribution, largest remainder), largest share first. */
export function reviewParts(items: readonly ScoreItem[]): ReviewPart[] {
  const parts: Omit<ReviewPart, 'points'>[] = []
  for (const g of scoreGroups(items)) {
    const rest = g.items.filter((i) => !(g.file !== null && (FINDING_KINDS.has(i.kind) || i.kind === 'unknown')))
    if (rest.length > 0) {
      const all = (kind: ScoreItem['kind']): boolean => rest.every((i) => i.kind === kind)
      const kind = g.file !== null ? 'file' : all('contract') ? 'contract' : all('vulnerability') ? 'vulnerability' : all('unknown') ? 'unread' : 'other'
      parts.push({ kind, file: g.file, line: null, items: rest, own: ownOf(rest), must: kind === 'contract' || kind === 'vulnerability' || kind === 'unread' })
    }
    if (g.file !== null) {
      for (const i of g.items.filter((x) => FINDING_KINDS.has(x.kind))) parts.push({ kind: 'finding', file: g.file, line: i.line ?? null, items: [i], own: ownOf([i]), must: true })
      // Something farol could not read: checked by hand, not by reviewing the file.
      for (const i of g.items.filter((x) => x.kind === 'unknown')) parts.push({ kind: 'unread', file: g.file, line: null, items: [i], own: ownOf([i]), must: true })
    }
  }
  const logs = parts.map((p) => logOf(p.items))
  const total = logs.reduce((a, b) => a + b, 0)
  const score = 100 * (1 - Math.exp(-total))
  const rows = parts.map((p, i) => {
    const v = total === 0 ? 0 : (score * (logs[i] ?? 0)) / total
    return { part: p, v, points: Math.floor(v) }
  })
  let left = Math.round(score) - rows.reduce((a, r) => a + r.points, 0)
  for (const r of [...rows].sort((a, b) => b.v - b.points - (a.v - a.points))) {
    if (left <= 0) break
    r.points++
    left--
  }
  return rows.map((r) => ({ ...r.part, points: r.points })).sort((a, b) => b.points - a.points || b.own - a.own)
}

/** Tier of a file part by its own points. */
export function tierOf(part: Pick<ReviewPart, 'own'>): 'high' | 'medium' | 'skim' {
  return part.own >= HIGH_TIER ? 'high' : part.own >= MEDIUM_TIER ? 'medium' : 'skim'
}
