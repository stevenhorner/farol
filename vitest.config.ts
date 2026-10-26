import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    globalSetup: ['test/helpers/global-setup.ts'],
    // The Go/Python helper cache of the tests never touches the user's ~/.cache.
    env: { FAROL_CACHE_DIR: join(tmpdir(), `farol-test-cache-${process.pid}`) },
    // Coverage only when asked (--coverage.enabled, as farol's own review does): every source file, loaded or not.
    coverage: { provider: 'v8', include: ['src/**/*.ts'] },
  },
})
