import type { FastifyInstance } from 'fastify'

const hook = (name: string) => `/replay/${name}`

export function registerReplay(app: FastifyInstance) {
  app.post(hook('stripe'), async () => ({ replayed: true }))
}
