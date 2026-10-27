import { compareStrings } from '../output/order.js'

export const CLASSIFICATIONS = ['global', 'unknown', 'touches-existing', 'isolated'] as const
export type Classification = (typeof CLASSIFICATIONS)[number]

/**
 * Closed list of reason codes, in report order. Documented in docs/reasons.md.
 * `effect` is the class a reason forces (first match wins: global > unknown > touches-existing), or `info`.
 */
export const REASONS = {
  'global-file-changed': 'global',
  'manifest-changed': 'global',
  'dependency-critical': 'global',
  'lockfile-only-change': 'global',
  'analysis-error': 'unknown',
  'parse-error': 'unknown',
  'dynamic-route': 'unknown',
  'unresolved-import': 'unknown',
  'routes-not-additive': 'touches-existing',
  'schema-not-additive': 'touches-existing',
  'resolvers-not-additive': 'touches-existing',
  'barrel-not-additive': 'touches-existing',
  'i18n-not-additive': 'touches-existing',
  'existing-file-modified': 'touches-existing',
  'existing-file-unreachable': 'touches-existing',
  'existing-file-renamed': 'touches-existing',
  'existing-file-deleted': 'touches-existing',
  'infra-file-changed': 'touches-existing',
  'client-file-changed': 'touches-existing',
  'new-file-reached-by-existing-route': 'touches-existing',
  'tests-modified': 'info',
  'type-only-change': 'info',
  'declarations-additive': 'info',
  'dependency-changed': 'info',
  'lockfile-changed': 'info',
  'route-added': 'info',
  'routes-additive': 'info',
  'schema-additive': 'info',
  'resolvers-additive': 'info',
  'barrel-additive': 'info',
  'i18n-additive': 'info',
  'new-file-in-new-route': 'info',
  'new-file-disconnected': 'info',
  'client-file-added': 'info',
  'file-excluded': 'info',
  'outside-project': 'info',
  'no-existing-code-touched': 'info',
} as const satisfies Record<string, Classification | 'info'>

export type ReasonCode = keyof typeof REASONS
export const REASON_CODES = Object.keys(REASONS) as [ReasonCode, ...ReasonCode[]]

export interface Reason {
  code: ReasonCode
  file?: string
  detail: string
}

export function reason(code: ReasonCode, detail: string, file?: string): Reason {
  return file === undefined ? { code, detail } : { code, file, detail }
}

/** First matching class: global, then unknown, then touches-existing, else isolated. */
export function classificationFrom(reasons: readonly Reason[]): Classification {
  for (const cls of ['global', 'unknown', 'touches-existing'] as const) if (reasons.some((r) => REASONS[r.code] === cls)) return cls
  return 'isolated'
}

const RANK = new Map(REASON_CODES.map((code, i) => [code, i]))

/** Deterministic order: by code (report order), then file, then detail; duplicates removed. */
export function sortReasons(reasons: readonly Reason[]): Reason[] {
  const unique = new Map(reasons.map((r) => [`${r.code}\0${r.file ?? ''}\0${r.detail}`, r]))
  return [...unique.values()].sort((a, b) => (RANK.get(a.code) ?? 0) - (RANK.get(b.code) ?? 0) || compareStrings(a.file ?? '', b.file ?? '') || compareStrings(a.detail, b.detail))
}
