const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Texts of the top of the PR comment: the same reading as the HTML report's summary and side rail. */
export const COMMENT_TEXT = {
  title: (score: number, level: string, verdict: string) => `### farol · merge risk ${score}/100 (${level}) · ${verdict}`,
  verdict: { pass: '✓ fast track', quick: '◐ quick review', careful: '⚠ careful review' } as const,
  ready: '✓ Low risk and nothing to check by hand: likely safe to approve.',
  workbench: (url: string) => `📄 **[Open the review workbench](${url})**: mark files as reviewed and the score drops; copy the results back here.`,
  shadow: 'farol only informs: it never approves or blocks.',
  must: '**Must check** (by hand, before approving)',
  contract: (keys: string) => `Breaking API change: ${keys}`,
  contractDangerous: (keys: string) => `API change that may affect clients: ${keys}`,
  security: (where: string, severity: string, rule: string, message: string) => `Security finding at ${where}: ${severity} ${rule}, ${message}`,
  lint: (where: string, rule: string, message: string) => `Lint error at ${where}: ${rule}, ${message}`,
  vulnerability: (title: string) => `Vulnerable dependency: ${title}`,
  unread: (title: string) => `farol could not read this, check it by hand: ${title}`,
  files: (score: number) => `**Files by risk** (points are each part's share of the ${score})`,
  tier: { high: '🔴', medium: '🟠' } as const,
  file: (points: number, coverage: string | null, reach: string | null) => `**${points}**${coverage ? ` · ${coverage}` : ''}${reach ? ` · ${reach}` : ''}`,
  reach: (n: number, total: number, many: string) => `${n} of ${total} ${many}`,
  rest: (skim: number, tests: number) => [skim > 0 ? `${plural(skim, 'file', 'files')} to skim` : '', tests > 0 ? plural(tests, 'test file', 'test files') : ''].filter((x) => x !== '').join(', '),
  restLine: (what: string, points: number, alone: boolean) => `- ${alone ? '' : 'and '}${what}: ${points} ${points === 1 ? 'point' : 'points'} together`,
  other: (what: string, points: number) => `- ${what}: **${points}**`,
  tested: (ratio: string, covered: number, total: number) => `**New code tested:** ${ratio} (${covered} of ${total} changed lines)`,
  testedWithout: (ratio: string, files: number) => `, ${ratio} without ${plural(files, 'file', 'files')} not in the coverage report`,
  leftOut: (files: number) => ` · ${plural(files, 'file', 'files')} left out of coverage on purpose`,
  allSignals: 'All signals',
} as const
