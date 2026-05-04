import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'agent/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'agent/src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'agent/src/**/*.test.ts'],
    },
  },
})
