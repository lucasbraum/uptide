import { expect, it } from 'vitest';
import { mapWithSerialRetry } from './pool.js';

it('finishes parallel work before retrying memory failures, serially, preserving other results', async () => {
  let running = 0;
  let retries = 0;
  const finished: number[] = [];
  const results = await mapWithSerialRetry<number, string>(
    [0, 1, 2],
    2,
    async (item) => {
      running++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      finished.push(item);
      return item === 1 ? 'complete' : 'memory';
    },
    (r) => r === 'memory',
    async (item) => {
      expect(running).toBe(0);
      expect(finished).toHaveLength(3);
      expect(retries).toBe(0);
      retries++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      retries--;
      return `retried ${item}`;
    },
  );
  expect(results).toEqual(['retried 0', 'complete', 'retried 2']);
});

it('does not repeatedly retry a single program that already had the full budget', async () => {
  const results = await mapWithSerialRetry<number, string>(
    [0],
    1,
    async () => 'memory',
    () => true,
    async () => {
      throw new Error('must not retry');
    },
  );
  expect(results).toEqual(['memory']);
});
