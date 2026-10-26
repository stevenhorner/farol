import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { commentCommand } from '../../src/cli/comment.js'
import { GitHubClient, GitHubError, nextPageUrl, type IssueComment } from '../../src/github/client.js'
import { preserveFeedback, upsertComment } from '../../src/github/comment.js'
import { renderReport } from '../../src/report/markdown.js'
import { FEEDBACK_OPTIONS, MARKER } from '../../src/report/strings.js'
import { OutputSchema } from '../../src/output/schema.js'
import { FIXTURES_DIR } from '../helpers/repo.js'

interface Call {
  method: string
  url: string
  body?: string
}

/** Fake GitHub: serves comments in pages of `perPage` and records every request. */
function fakeGitHub(initial: IssueComment[], perPage = 2, failWith?: { status: number; message: string }) {
  const comments = [...initial]
  const calls: Call[] = []
  const impl = vi.fn((input: string, init?: RequestInit): Promise<Response> => Promise.resolve(respond(input, init)))
  function respond(input: string, init?: RequestInit): Response {
    const url = input
    const method = init?.method ?? 'GET'
    calls.push({ method, url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
    if (failWith) return new Response(JSON.stringify({ message: failWith.message }), { status: failWith.status, statusText: 'Forbidden' })
    if (method === 'GET') {
      const page = Number(new URL(url).searchParams.get('page') ?? '1')
      const slice = comments.slice((page - 1) * perPage, page * perPage)
      const headers: Record<string, string> = {}
      if (page * perPage < comments.length) headers.link = `<https://api.github.com/repos/acme/shop/issues/7/comments?per_page=100&page=${page + 1}>; rel="next", <https://api.github.com/x?page=9>; rel="last"`
      return new Response(JSON.stringify(slice), { status: 200, headers })
    }
    const { body } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { body: string }
    if (method === 'POST') {
      const created = { id: 100, body, html_url: 'https://github.com/acme/shop/pull/7#issuecomment-100' }
      comments.push(created)
      return new Response(JSON.stringify(created), { status: 201 })
    }
    const id = Number(url.split('/').pop())
    const target = comments.find((c) => c.id === id)
    if (!target) return new Response('{}', { status: 404, statusText: 'Not Found' })
    target.body = body
    return new Response(JSON.stringify(target), { status: 200 })
  }
  return { impl: impl as unknown as typeof fetch, calls, comments }
}

const other = (id: number): IssueComment => ({ id, body: `LGTM ${id}`, html_url: `https://github.com/c/${id}` })
const client = (impl: typeof fetch) => new GitHubClient({ token: 't0k3n', repo: 'acme/shop', fetch: impl })

function body(commit: string): string {
  const output = OutputSchema.parse(JSON.parse(readFileSync(join(FIXTURES_DIR, '05-shared-component', 'expected.json'), 'utf8')))
  return renderReport({ ...output, head: { ...output.head, sha: commit } })
}

describe('comment', () => {
  it('creates the comment when no comment has the marker', async () => {
    const gh = fakeGitHub([other(1), other(2), other(3)])
    const result = await upsertComment(client(gh.impl), 7, body('a'.repeat(40)))
    expect(result).toEqual({ action: 'created', url: 'https://github.com/acme/shop/pull/7#issuecomment-100' })
    expect(gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.github.com/repos/acme/shop/issues/7/comments?per_page=100',
      'GET https://api.github.com/repos/acme/shop/issues/7/comments?per_page=100&page=2',
      'POST https://api.github.com/repos/acme/shop/issues/7/comments',
    ])
    const init = vi.mocked(gh.impl).mock.calls[0]?.[1]
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer t0k3n')
  })

  it('finds the marker on a later page and updates that comment', async () => {
    const existing = { id: 42, body: body('a'.repeat(40)), html_url: 'https://github.com/acme/shop/pull/7#issuecomment-42' }
    const gh = fakeGitHub([other(1), other(2), other(3), other(4), existing], 2)
    const result = await upsertComment(client(gh.impl), 7, body('b'.repeat(40)))
    expect(result.action).toBe('updated')
    expect(gh.calls.filter((c) => c.method === 'GET')).toHaveLength(3)
    expect(gh.calls.at(-1)).toMatchObject({ method: 'PATCH', url: 'https://api.github.com/repos/acme/shop/issues/comments/42' })
    expect(gh.comments.find((c) => c.id === 42)?.body).toContain('analyzed commit bbbbbbbbbbbb')
  })

  it('keeps the feedback boxes reviewers ticked when the analyzed commit changes', async () => {
    const ticked = body('a'.repeat(40)).replace(`- [ ] ${FEEDBACK_OPTIONS[1]}`, `- [x] ${FEEDBACK_OPTIONS[1]}`)
    const gh = fakeGitHub([{ id: 42, body: ticked, html_url: 'u' }])
    await upsertComment(client(gh.impl), 7, body('c'.repeat(40)))
    const updated = gh.comments[0]?.body ?? ''
    expect(updated).toContain('analyzed commit cccccccccccc')
    expect(updated).toContain(`- [x] ${FEEDBACK_OPTIONS[1]}`)
    expect(updated).toContain(`- [ ] ${FEEDBACK_OPTIONS[0]}`)
    expect(updated).toContain(`- [ ] ${FEEDBACK_OPTIONS[2]}`)
  })

  it('does not touch the comment when nothing changed', async () => {
    const same = body('a'.repeat(40)).replace(`- [ ] ${FEEDBACK_OPTIONS[0]}`, `- [x] ${FEEDBACK_OPTIONS[0]}`)
    const gh = fakeGitHub([{ id: 42, body: same, html_url: 'u' }])
    expect((await upsertComment(client(gh.impl), 7, body('a'.repeat(40)))).action).toBe('unchanged')
    expect(gh.calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('explains HTTP errors', async () => {
    const gh = fakeGitHub([], 2, { status: 403, message: 'Resource not accessible by integration' })
    const error = await upsertComment(client(gh.impl), 7, 'x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitHubError)
    expect((error as GitHubError).message).toBe(
      'GitHub API GET https://api.github.com/repos/acme/shop/issues/7/comments?per_page=100 failed: 403 Forbidden (Resource not accessible by integration); the token lacks permission (the job needs "permissions: pull-requests: write"; pull requests from forks only get a read-only token)',
    )
  })

  it('preserveFeedback ignores unknown checkboxes and keeps the rest of the body', () => {
    const old = `${MARKER}\n- [x] something else\n- [x] ${FEEDBACK_OPTIONS[2]}`
    const next = `${MARKER}\nnew\n- [ ] something else\n- [ ] ${FEEDBACK_OPTIONS[2]}`
    expect(preserveFeedback(old, next)).toBe(`${MARKER}\nnew\n- [ ] something else\n- [x] ${FEEDBACK_OPTIONS[2]}`)
  })

  it('parses Link headers', () => {
    expect(nextPageUrl('<https://a/x?page=2>; rel="next", <https://a/x?page=5>; rel="last"')).toBe('https://a/x?page=2')
    expect(nextPageUrl('<https://a/x?page=1>; rel="prev"')).toBeUndefined()
    expect(nextPageUrl(null)).toBeUndefined()
  })

  it('the command validates its inputs before calling GitHub', async () => {
    const input = join(FIXTURES_DIR, '05-shared-component', 'expected.json')
    await expect(commentCommand({ in: input, pr: 'abc' }, {})).rejects.toThrow('--pr must be a pull request number')
    await expect(commentCommand({ in: input, pr: '7' }, {})).rejects.toThrow('repository unknown')
    await expect(commentCommand({ in: input, pr: '7' }, { GITHUB_REPOSITORY: 'acme/shop' })).rejects.toThrow('GITHUB_TOKEN is not set')
    const gh = fakeGitHub([])
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await expect(commentCommand({ in: input, pr: '7' }, { GITHUB_REPOSITORY: 'acme/shop', GITHUB_TOKEN: 'x', GITHUB_API_URL: 'https://ghe.local/api/v3/' }, gh.impl)).resolves.toBe(0)
    stderr.mockRestore()
    expect(gh.calls[0]?.url).toBe('https://ghe.local/api/v3/repos/acme/shop/issues/7/comments?per_page=100')
  })

  it('--new posts a new comment on every push, with the commits since the last push on top', async () => {
    const input = join(FIXTURES_DIR, '05-shared-component', 'expected.json')
    const since = join(FIXTURES_DIR, '06-optional-prop', 'expected.json')
    const gh = fakeGitHub([{ id: 1, body: `${MARKER}\nold`, html_url: 'https://github.com/acme/shop/pull/7#issuecomment-1' }])
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await commentCommand({ in: input, pr: '7', new: true, sinceIn: since, reportUrl: 'https://example.com/full', sinceReportUrl: 'https://example.com/since' }, { GITHUB_REPOSITORY: 'acme/shop', GITHUB_TOKEN: 'x' }, gh.impl)
    stderr.mockRestore()
    expect(gh.calls.map((c) => c.method)).toEqual(['POST'])
    const body = (JSON.parse(gh.calls[0]?.body ?? '{}') as { body: string }).body
    expect(body).toContain('[Open the review workbench](https://example.com/full)')
    expect(body).toContain('🔁 **Since the last push**')
    expect(body).toContain('[Report of these commits (HTML)](https://example.com/since)')
    await expect(commentCommand({ in: input, pr: '7', sinceReportUrl: 'http://x' }, { GITHUB_REPOSITORY: 'acme/shop', GITHUB_TOKEN: 'x' }, gh.impl)).rejects.toThrow('--since-report-url must be an https URL')
  })
})
