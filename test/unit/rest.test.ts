import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { restNodes } from '../../src/backend/rest.js'

const keys = (code: string) => restNodes(ts.createSourceFile('app.ts', code, ts.ScriptTarget.Latest, true)).map((n) => [n.key, n.computed ?? false])

describe('REST endpoints', () => {
  it('keeps a computed path with the expression in braces, marked as computed', () => {
    expect(keys("app.get('/a', h)\napp.post(hook('stripe'), async () => 1)\nrouter.get(`/v1/${name}`, h)")).toEqual([
      ['GET /a', false],
      ["POST {hook('stripe')}", true],
      ['GET {`/v1/${name}`}', true],
    ])
    expect(keys("fastify.route({ method: 'PUT', url: base + '/x', handler: h })")).toEqual([["PUT {base + '/x'}", true]])
  })

  it('does not read calls on other receivers as routes', () => {
    expect(keys('cache.get(key, () => compute())\nmap.delete(id, () => 1)')).toEqual([])
  })
})
