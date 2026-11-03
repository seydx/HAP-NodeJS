import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**'],
      exclude: [
        'src/accessories/**',
        'src/lib/definitions/generate-definitions.ts',
        'src/lib/definitions/generator-configuration.ts',
        'src/test-utils/**',
      ],
    },
    // HAPStorage tests change the working directory, which worker threads do not allow
    pool: 'forks',
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 10000,
  },
})
