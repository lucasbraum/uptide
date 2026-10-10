import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { PackageFetcher } from '../domain/io.js';
import { isolatedFix } from './isolate.js';
import type { ManagerKind } from './managers/manager.js';
import {
  allowPeerOverrides,
  compatiblePeerVersion,
  type PeerBlocker,
  peerPreflight,
} from './peer-preflight.js';
import { git } from './process.js';
import { prBody } from './report.js';
import { fix } from './run.js';
import { zodFixture } from './test-fixture.js';

const scratch = mkdtempSync(join(tmpdir(), 'uptide-peers-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const versions = {
  '1.0.0': { peerDependencies: { zod: '^3' } },
  '3.0.0': { peerDependencies: { zod: '^4' } },
  '1.1.0-beta.1': { peerDependencies: { zod: '^4' } },
  '1.2.0': { peerDependencies: { zod: '^3 || ^4' } },
  '1.1.0': {},
};
const blocker: PeerBlocker = {
  name: 'plugin',
  version: '1.0.0',
  peer: 'zod',
  range: '^3',
  target: '4.6.5',
  allowed: true,
};
function fixture(manager: 'npm' | 'pnpm' | 'yarn' = 'npm', newer = false) {
  const f = zodFixture(scratch);
  const json = JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8'));
  json.dependencies.plugin = '^1';
  writeFileSync(join(f.root, 'package.json'), JSON.stringify(json));
  mkdirSync(join(f.root, 'node_modules/plugin'));
  writeFileSync(
    join(f.root, 'node_modules/plugin/package.json'),
    JSON.stringify({ name: 'plugin', version: '1.0.0', ...versions['1.0.0'] }),
  );
  if (manager !== 'pnpm') rmSync(join(f.root, 'pnpm-lock.yaml'));
  if (manager === 'npm')
    writeFileSync(
      join(f.root, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': json,
          'node_modules/zod': { version: '3.25.76' },
          'node_modules/plugin': { version: '1.0.0' },
        },
      }),
    );
  if (manager === 'yarn') writeFileSync(join(f.root, 'yarn.lock'), '# yarn lockfile v1\n');
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-m', 'peer fixture');
  const manifests = vi.fn<NonNullable<PackageFetcher['manifests']>>(
    async (name: string): ReturnType<NonNullable<PackageFetcher['manifests']>> =>
      name === 'zod' ? { '4.6.5': {} } : newer ? versions : { '1.0.0': versions['1.0.0'] },
  );
  return { ...f, services: { ...f.services, manifests } };
}

it('selects the lowest newer stable release with an accepting peer, not latest or a missing peer declaration', () => {
  expect(compatiblePeerVersion(versions, '1.0.0', 'zod', '4.6.5')).toBe('1.2.0');
  expect(compatiblePeerVersion(versions, '3.0.0', 'zod', '4.6.5')).toBeUndefined();
});

it.each([false, true])(
  'npm stops before clone, branch, check, install or LLM (newer=%s)',
  async (newer) => {
    const { root, services } = fixture('npm', newer);
    const runs = join(scratch, `runs-${newer}`);
    vi.stubEnv('UPTIDE_RUNS_DIR', runs);
    try {
      const check = vi.fn(services.check),
        install = vi.fn(services.install),
        spend = vi.fn();
      const before = git(root, 'branch');
      await expect(
        isolatedFix(
          { cwd: root, only: 'zod', target: '4.6.5', fixer: { id: 'test', fix: spend } },
          { ...services, check, install },
        ),
      ).rejects.toThrow(
        newer
          ? 'plugin 1.2.0 accepts it; run npx uptide fix zod plugin'
          : 'plugin 1.0.0 declares zod ^3, which rejects 4.6.5. No newer compatible release',
      );
      expect(check).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
      expect(spend).not.toHaveBeenCalled();
      expect(git(root, 'branch')).toBe(before);
      expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it('only moves an explicitly requested peer, and uses its lowest compatible release', async () => {
  const { root, services } = fixture('npm', true);
  const plan = await peerPreflight(
    { cwd: root, only: 'zod', target: '4.6.5', also: ['plugin'] },
    services,
  );
  expect(plan?.companions).toMatchObject([{ name: 'plugin', to: '1.2.0' }]);
  expect(plan?.conflicts).toEqual([]);
  expect(git(root, 'status', '--porcelain')).toBe('');
});

it.each(['pnpm', 'yarn'] as const)(
  '%s reports peers without blocking or silently upgrading them',
  async (manager) => {
    const { root, services } = fixture(manager, true);
    const onProgress = vi.fn();
    const plan = await peerPreflight(
      { cwd: root, only: 'zod', target: '4.6.5', onProgress },
      services,
    );
    expect(plan?.companions).toEqual([]);
    expect(plan?.conflicts).toMatchObject([{ name: 'plugin', allowed: false, newer: '1.2.0' }]);
    expect(onProgress.mock.calls[0]?.[0].detail).toContain('plugin 1.2.0 accepts it');
  },
);

it.each(['npm', 'pnpm', 'yarn-classic', 'yarn-berry'] as ManagerKind[])(
  '%s writes a scoped native override preserving existing configuration',
  (manager) => {
    const manifest = {
      dependencies: { zod: '^4' },
      overrides: { other: '2', plugin: { other: '3' } },
      pnpm: { peerDependencyRules: { allowedVersions: { 'other>zod': '3' } } },
      resolutions: { other: '2' },
    };
    allowPeerOverrides(manifest, manager, [blocker]);
    if (manager === 'npm')
      expect(manifest.overrides).toEqual({ other: '2', plugin: { other: '3', zod: '$zod' } });
    else if (manager === 'pnpm')
      expect(manifest.pnpm.peerDependencyRules.allowedVersions).toEqual({
        'other>zod': '3',
        'plugin>zod': '4.6.5',
      });
    else expect(manifest.resolutions).toEqual({ other: '2', 'plugin/zod': '4.6.5' });
    const untouched = structuredClone(manifest);
    allowPeerOverrides(manifest, manager, [{ ...blocker, allowed: false }]);
    expect(manifest).toEqual(untouched);
  },
);

it('preserves string npm overrides and uses an exact version for workspace-only peers', () => {
  const manifest = { overrides: { plugin: '1.0.0' } };
  allowPeerOverrides(manifest, 'npm', [blocker]);
  expect(manifest.overrides).toEqual({ plugin: { '.': '1.0.0', zod: '4.6.5' } });
});

it('allowed peers are committed with the upgrade and listed under PR risks with their declared range', async () => {
  const { root, services } = fixture('pnpm');
  const install = vi.fn(async (dir: string, upgrade: Parameters<typeof services.install>[1]) => {
    expect(upgrade?.files).toContain('package.json');
    expect(
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).pnpm.peerDependencyRules
        .allowedVersions,
    ).toEqual({ 'plugin>zod': '4.6.5' });
    return services.install(dir, upgrade);
  });
  const result = await fix(
    { cwd: root, only: 'zod', target: '4.6.5', fixer: null, allowPeer: ['plugin'] },
    { ...services, install },
  );
  expect(result.peerConflicts).toMatchObject([{ ...blocker }]);
  expect(prBody(result)).toContain('### Peer risks');
  expect(prBody(result)).toContain('plugin 1.0.0 declares zod ^3');
  expect(git(root, 'show', 'HEAD:package.json')).toContain('plugin>zod');
});

it('rejects misspelled allow-peer names rather than silently ignoring them', async () => {
  const { root, services } = fixture();
  await expect(
    peerPreflight({ cwd: root, only: 'zod', target: '4.6.5', allowPeer: ['typo'] }, services),
  ).rejects.toThrow('--allow-peer typo');
});

it('bumps an explicitly selected peer in the same upgrade and report', async () => {
  const { root, services } = fixture('pnpm', true);
  const install = vi.fn(async (dir: string, upgrade: Parameters<typeof services.install>[1]) => {
    expect(upgrade?.also).toContainEqual({ name: 'plugin', version: '1.2.0' });
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies.plugin).toBe(
      '^1',
    );
    return services.install(dir, upgrade);
  });
  const report = await fix(
    { cwd: root, only: 'zod', target: '4.6.5', fixer: null, also: ['plugin'] },
    { ...services, install },
  );
  expect(install).toHaveBeenCalledOnce();
  expect(report.companions).toMatchObject([{ name: 'plugin', from: '1.0.0', to: '1.2.0' }]);
  expect(report.peerConflicts).toBeUndefined();
});
