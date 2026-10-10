import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src'],
    coverage: {
      include: ['src/**/*.ts', 'lib'], // @uptide coverage-patterns at:'lib'
      exclude: [
        'src/config', // @uptide coverage-patterns at:'src/config'
        "src/stubs", // @uptide coverage-patterns at:"src/stubs"
        'src/index.tsx', // @uptide coverage-patterns keep
        'src/**/*.d.ts',
        '**/*.test.{ts,tsx}',
        'src/electrical_testing', // @uptide coverage-patterns at:'src/electrical_testing'
        '!src/keep',
      ],
    },
  },
});
