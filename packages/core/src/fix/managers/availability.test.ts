import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { command } from '../process.js';
import {
  assertManagerAvailable,
  COREPACK_ENV,
  needsCorepack,
  throughCorepack,
} from './availability.js';
import { packageManager, updateArgs } from './manager.js';

/** package.json pins yarn@4.7.0, Berry lockfile, node-modules linker. */
const PINNED = fileURLToPath(
  new URL('../../../../../fixtures/repos/yarn-berry-pinned', import.meta.url),
);

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
it('without yarn or corepack, says what to run and downloads nothing silently', async () => {
  const root = fixture('yarn@4.9.2', 'yarn.lock', '__metadata:\n  version: 8\n');
  const probe = vi.fn<typeof command>(async () => ({
    code: 1,
    output: 'not installed',
    timeout: false,
  }));
  await expect(assertManagerAvailable(root, probe)).rejects.toMatchObject({
    code: 'PACKAGE_MANAGER_UNAVAILABLE',
    message: expect.stringContaining('Next: corepack enable'),
  });
  expect(probe.mock.calls[0]?.[0]).toBe(root);
  // yarn, then corepack itself; never an install, never `corepack enable`.
  expect(probe.mock.calls.map((c) => [c[1], c[2][0]])).toEqual([
    ['yarn', '--version'],
    ['corepack', '--version'],
  ]);
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

describe('a pinned Yarn Berry on a machine with Yarn classic', () => {
  /** `yarn --version` answers `yarn`; `corepack --version` and `corepack yarn --version` answer the rest. */
  const answering =
    (yarn: string | undefined, corepack: string | undefined, pinned: string | undefined) =>
    async (_cwd: string, bin: string, args: string[]) => {
      const version =
        bin === 'yarn' ? yarn : bin === 'corepack' && args[0] === 'yarn' ? pinned : corepack;
      return version === undefined
        ? { code: 1, output: `${bin}: not found`, timeout: false }
        : { code: 0, output: `${version}\n`, timeout: false };
    };

  it('detects when the pinned version cannot run through the yarn on PATH', () => {
    const pm = packageManager(PINNED);
    expect(pm).toMatchObject({ kind: 'yarn-berry', requestedVersion: '4.7.0' });
    expect(needsCorepack(pm, { code: 1, output: 'not found' })).toBe(true);
    expect(needsCorepack(pm, { code: 0, output: '1.22.22\n' })).toBe(true);
    expect(needsCorepack(pm, { code: 0, output: '4.6.0\n' })).toBe(true);
    expect(needsCorepack(pm, { code: 0, output: '4.7.0\n' })).toBe(false);
    const classic = packageManager(fixture('yarn@1.22.22', 'yarn.lock', '# yarn lockfile v1\n'));
    expect(needsCorepack(classic, { code: 0, output: '1.22.22\n' })).toBe(false);
    const pnpm = packageManager(
      fixture('pnpm@10.17.1', 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n"),
    );
    expect(needsCorepack(pnpm, { code: 1, output: '' })).toBe(false);
  });

  it('runs the same install as `corepack yarn`, prompt off, without enabling corepack', () => {
    const pm = throughCorepack(packageManager(PINNED));
    expect(pm.bin).toBe('corepack');
    expect(pm.via).toBe('corepack');
    expect(pm.args).toEqual(['yarn', 'install', '--immutable', '--mode=skip-build']);
    expect(pm.env).toMatchObject({
      ...COREPACK_ENV,
      YARN_ENABLE_SCRIPTS: 'false',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    });
    expect(updateArgs(pm, PINNED, ['.'])).toEqual(['yarn', 'install', '--mode=skip-build']);
  });

  it('selects corepack when the yarn on PATH is classic and corepack can run the pin', async () => {
    const probe = vi.fn<typeof command>(answering('1.22.22', '0.34.0', '4.7.0'));
    const pm = await assertManagerAvailable(PINNED, probe);
    expect(pm).toMatchObject({ kind: 'yarn-berry', bin: 'corepack', via: 'corepack' });
    expect(pm.args).toEqual(['yarn', 'install', '--immutable', '--mode=skip-build']);
    expect(probe.mock.calls.map((c) => [c[1], ...c[2]])).toEqual([
      ['yarn', '--version'],
      ['corepack', '--version'],
      ['corepack', 'yarn', '--version'],
    ]);
    // The pinned version is fetched with the prompt off, and the pin is never rewritten.
    expect(probe.mock.calls[2]?.[4]).toMatchObject(COREPACK_ENV);
  });

  it('selects corepack when no yarn is on PATH at all', async () => {
    const pm = await assertManagerAvailable(PINNED, answering(undefined, '0.34.0', '4.7.0'));
    expect(pm.bin).toBe('corepack');
  });

  it('keeps a matching Berry on PATH as it is', async () => {
    const pm = await assertManagerAvailable(PINNED, answering('4.7.0', '0.34.0', '4.7.0'));
    expect(pm.bin).toBe('yarn');
    expect(pm.via).toBeUndefined();
  });

  it('exits before cloning with the command to run when corepack is missing', async () => {
    await expect(
      assertManagerAvailable(PINNED, answering('1.22.22', undefined, undefined)),
    ).rejects.toMatchObject({
      code: 'PACKAGE_MANAGER_UNAVAILABLE',
      message:
        'This repository pins yarn@4.7.0 (packageManager), but the yarn on PATH is 1.22.22 and corepack is not available to run the pinned version. Nothing was cloned or installed.\nNext: corepack enable',
    });
  });

  it('names COREPACK_NPM_REGISTRY only when corepack could not fetch the pinned version', async () => {
    const withCorepack = answering('1.22.22', '0.34.0', '4.7.0');
    await expect(assertManagerAvailable(PINNED, withCorepack)).resolves.toBeDefined();
    const failing = answering('1.22.22', '0.34.0', undefined);
    const error = await assertManagerAvailable(PINNED, failing).catch((e: Error) => e);
    expect(error).toMatchObject({ code: 'PACKAGE_MANAGER_UNAVAILABLE' });
    expect(String(error)).toContain('corepack could not run the pinned version');
    expect(String(error)).toContain('set COREPACK_NPM_REGISTRY to your npm mirror');
    expect(String(error)).toContain(
      'Next: corepack enable yarn && corepack prepare yarn@4.7.0 --activate',
    );
    const missing = await assertManagerAvailable(
      PINNED,
      answering('1.22.22', undefined, undefined),
    ).catch((e: Error) => e);
    expect(String(missing)).not.toContain('COREPACK_NPM_REGISTRY');
  });

  it('still refuses a corepack yarn that is not the pinned version', async () => {
    await expect(
      assertManagerAvailable(PINNED, answering('1.22.22', '0.34.0', '4.6.0')),
    ).rejects.toMatchObject({ code: 'PACKAGE_MANAGER_VERSION' });
  });
});
