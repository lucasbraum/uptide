import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Real compiler programs, git repositories and worker threads: several tests take 3-6 s
    // on a CI runner, too close to vitest's 5 s default. Explicit per-test timeouts still win.
    testTimeout: 20_000,
  },
});
