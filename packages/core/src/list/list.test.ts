import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { listDependencies } from './list.js';
import { scanImports } from './scan.js';

const roots: string[] = [];
const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'uptide-discovery-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'app',
      dependencies: { zod: '3.25.76', minor: '1.0.0', tool: '1.0.0', missing: '1.0.0' },
    }),
  );
  writeFileSync(
    join(root, 'index.tsx'),
    `import { z as schema } from 'zod';
import type { ZodType } from 'zod';
import Minor from 'minor/subpath';
schema.string(); new Minor(); <Minor />;
// import ghost from 'tool';
const text = "require('tool')";
`,
  );
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('discovers without installation, resolves metadata once per name and retains failures', async () => {
  const cwd = fixture();
  const resolve = vi.fn(async (name: string) => {
    if (name === 'missing') throw new Error('registry unavailable');
    return name === 'zod' ? '4.6.5' : name === 'minor' ? '1.1.0' : '2.0.0';
  });
  const result = await listDependencies({ cwd, fetcher: { resolve } });
  expect(resolve).toHaveBeenCalledTimes(4);
  expect(result.packages.map((p) => p.name)).toEqual(['zod', 'tool', 'minor']);
  expect(result.packages[0]).toMatchObject({
    current: '3.25.76',
    change: 'major',
    tier: 'verified',
    workspaces: ['.'],
    usage: {
      files: 1,
      callSites: 1,
      topSymbols: [
        { name: 'z.string', count: 1 },
        { name: 'ZodType', count: 0 },
        { name: 'z', count: 0 },
      ],
    },
  });
  expect(result.packages[1]?.usage.files).toBe(0);
  expect(result.packages[2]?.usage.callSites).toBe(2);
  expect(result.failures).toEqual([{ name: 'missing', reason: 'registry unavailable' }]);
  expect((await listDependencies({ cwd, fetcher: { resolve } })).packages).toEqual(result.packages);
});

it('recognizes literal import forms, skips comments, generated files and symlink cycles', () => {
  const cwd = fixture();
  mkdirSync(join(cwd, 'node_modules'));
  writeFileSync(join(cwd, 'node_modules', 'ignored.ts'), "import x from 'tool'; x();");
  symlinkSync(cwd, join(cwd, 'cycle'), 'dir');
  writeFileSync(
    join(cwd, 'other.cts'),
    `import z = require('zod'); z.string();
const { make: build } = require('other'); build();
const mod = await import('dynamic/subpath'); mod.run();
export { x } from 'reexport';
`,
  );
  const scan = scanImports(cwd, ['zod', 'tool', 'other', 'dynamic', 'reexport'], ['.']);
  expect(scan.get('zod')?.callSites).toBe(2);
  expect(scan.get('tool')).toBeUndefined();
  expect(scan.get('other')?.symbols.make).toBe(1);
  expect(scan.get('dynamic')?.symbols.run).toBe(1);
  expect(scan.get('reexport')?.files).toEqual(['other.cts']);
});

it('deduplicates names across workspaces, skips internal names and keeps distinct current versions', async () => {
  const cwd = fixture();
  mkdirSync(join(cwd, 'packages/a'), { recursive: true });
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      name: 'root',
      workspaces: ['packages/*'],
      dependencies: { zod: '3.25.76', internal: '*' },
    }),
  );
  writeFileSync(
    join(cwd, 'packages/a/package.json'),
    JSON.stringify({ name: 'internal', dependencies: { zod: '3.24.0' } }),
  );
  writeFileSync(join(cwd, 'packages/a/use.ts'), "import { z } from 'zod'; z.string();");
  const resolve = vi.fn(async () => '4.6.5');
  const result = await listDependencies({ cwd, fetcher: { resolve } });
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(result.failures).toEqual([]);
  expect(result.packages.map((p) => p.current)).toEqual(['3.24.0', '3.25.76']);
  expect(result.packages[0]?.usage.workspaces).toEqual(['.', 'packages/a']);
});
