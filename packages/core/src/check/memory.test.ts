import { expect, it } from 'vitest';
import { memoryPolicy } from './memory.js';

it('bounds concurrency by memory, CPU and explicit maximum, allowing native overhead', () => {
  const GB = 1024 ** 3;
  for (const free of [0.25, 1, 4, 8, 32]) {
    const p = memoryPolicy(free * GB, 8, 6, 1024, { UPTIDE_WORKER_HEAP_MB: '64000' });
    expect(p.workers).toBeLessThanOrEqual(6);
    expect(p.workers * p.heapMb * 1.4).toBeLessThanOrEqual(free * 1024 * 0.6);
  }
  expect(memoryPolicy(32 * GB, 2, 8, 1024, {}).workers).toBe(2);
  expect(memoryPolicy(32 * GB, 8, 1, 1024, {}).workers).toBe(1);
  expect(memoryPolicy(0.25 * GB, 8, 8, 1024, {}).heapMb).toBeLessThan(512);
});
