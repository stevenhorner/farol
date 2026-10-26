import type { FastifyInstance } from 'fastify'

const hook = (name: string) => `/webhooks/${name}`

export function registerHooks(app: FastifyInstance) {
  app.post(hook('stripe'), async () => ({ received: false }))
}
