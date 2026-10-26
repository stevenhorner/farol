import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportCommand } from '../../src/cli/report.js'
import { FIXTURES_DIR } from '../helpers/repo.js'

const golden = (scenario: string) => join(FIXTURES_DIR, scenario, 'expected.json')

/** What reportCommand writes to stdout. */
async function printed(options: Parameters<typeof reportCommand>[0]): Promise<string> {
  let text = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string, done?: (error?: Error | null) => void) => {
    text += chunk
    done?.()
    return true
  }) as typeof process.stdout.write)
  try {
    expect(await reportCommand(options)).toBe(0)
  } finally {
    spy.mockRestore()
  }
  return text
}

describe('report command', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints the comment with the commits since the last push, as "farol comment" posts it', async () => {
    const text = await printed({ in: golden('05-shared-component'), sinceIn: golden('01-new-route'), sinceReportUrl: 'https://example.com/since.html', reportUrl: 'https://example.com/full.html' })
    expect(text.startsWith('<!-- farol -->\n')).toBe(true)
    expect(text).toContain('[Open the review workbench](https://example.com/full.html)')
    expect(text).toContain('Since the last push')
    expect(text).toContain('https://example.com/since.html')
  })

  it('accepts only an https link for the report of the commits since the last push', async () => {
    await expect(reportCommand({ in: golden('05-shared-component'), sinceIn: golden('01-new-route'), sinceReportUrl: 'http://example.com/x' })).rejects.toThrow(/https/)
  })
})
