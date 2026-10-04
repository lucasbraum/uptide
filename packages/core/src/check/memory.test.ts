import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { estimateScopedHeapMb, memoryPolicy } from './memory.js';

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

it('falls back to serial with the full reservation when two scoped programs cannot fit', () => {
  const policy = memoryPolicy(4 * 1024 ** 3, 8, 8, 1400, {});
  expect(policy.workers).toBe(1);
  expect(policy.heapMb).toBeGreaterThanOrEqual(1400);
});

it('estimates reachable imports rather than all source and installed declaration files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uptide-memory-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: [] } }));
    const root = join(dir, 'root.ts');
    writeFileSync(root, 'export {};');
    const initial = estimateScopedHeapMb(dir, [root]);
    mkdirSync(join(dir, 'node_modules/unrelated'), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules/unrelated/index.d.ts'),
      'export const x: number;\n'.repeat(100000),
    );
    writeFileSync(join(dir, 'unrelated.ts'), '// irrelevant\n'.repeat(100000));
    expect(estimateScopedHeapMb(dir, [root])).toBe(initial);
    writeFileSync(root, "import './unrelated';");
    expect(estimateScopedHeapMb(dir, [root])).toBeGreaterThan(initial);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
