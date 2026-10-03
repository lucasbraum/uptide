import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { command } from '../process.js';
import { assertManagerAvailable } from './availability.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function fixture(pm: string, lockfile: string, text: string) {
  const root = mkdtempSync(join(tmpdir(), 'manager-available-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: pm }));
  writeFileSync(join(root, lockfile), text);
  return root;
}
it('explains exactly how to activate a missing Yarn Berry version without downloading it silently', async () => {
  const root = fixture('yarn@4.9.2', 'yarn.lock', '__metadata:\n  version: 8\n');
  const probe = vi.fn<typeof command>(async () => ({
    code: 1,
    output: 'not installed',
    timeout: false,
  }));
  await expect(assertManagerAvailable(root, probe)).rejects.toMatchObject({
    code: 'PACKAGE_MANAGER_UNAVAILABLE',
    message: expect.stringContaining(
      'Next: corepack enable yarn && corepack prepare yarn@4.9.2 --activate',
    ),
  });
  expect(probe.mock.calls[0]?.[0]).toBe(root);
});
it('rejects a classic binary for a Berry lockfile even without an explicit packageManager', async () => {
  const root = fixture('', 'yarn.lock', '__metadata:\n  version: 8\n');
  await expect(
    assertManagerAvailable(root, async () => ({ code: 0, output: '1.22.22\n', timeout: false })),
  ).rejects.toMatchObject({ code: 'PACKAGE_MANAGER_VERSION' });
});
it('reports an unavailable npm version, and accepts the exact declared version', async () => {
  const root = fixture('npm@10.9.4', 'package-lock.json', '{"lockfileVersion":3,"packages":{}}');
  await expect(
    assertManagerAvailable(root, async () => ({ code: 0, output: '9.0.0', timeout: false })),
  ).rejects.toThrow('corepack prepare npm@10.9.4 --activate');
  expect(
    (
      await assertManagerAvailable(root, async () => ({
        code: 0,
        output: '10.9.4',
        timeout: false,
      }))
    ).kind,
  ).toBe('npm');
});
