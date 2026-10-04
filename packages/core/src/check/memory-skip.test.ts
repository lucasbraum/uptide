import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('./memory.js', () => ({
  freeMemoryBytes: () => 512 * 1024 ** 2,
  estimateScopedHeapMb: () => 8192,
  memoryPolicy: () => ({ workers: 1, heapMb: 200, budgetMb: 307 }),
}));
vi.mock('../fetch/npm-fetcher.js', () => ({
  createNpmFetcher: () => ({
    resolve: async () => '2.0.0',
    fetch: async () => {
      throw new Error('must skip before fetching');
    },
  }),
  releasePackage: async () => {},
}));

import { check } from './check.js';

it('skips an oversized workspace before creating a compiler or fetching tarballs', async () => {
  const result = await check({
    cwd: resolve(import.meta.dirname, '../../../../fixtures/repos/synthetic-consumer'),
    only: ['synthetic'],
  });
  expect(result.packages[0]).toMatchObject({
    name: 'synthetic',
    target: '2.0.0',
    status: 'skipped',
    skipReason: 'MEMORY_BUDGET',
  });
  expect(result.packages[0]?.notes[0]).toContain('8192 MB');
  expect(result.packages[0]?.notes[0]).toContain('200 MB');
  expect(result.summary.failed).toBe(1);
});
