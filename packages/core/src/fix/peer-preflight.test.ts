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
          ? 'upgrade to 1.2.0 (accepts zod 4): add plugin to the command'
          : 'plugin 1.0.0 declares zod ^3, which rejects 4.6.5. no release accepts zod 4',
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
    expect(onProgress.mock.calls[0]?.[0].detail).toContain('upgrade to 1.2.0 (accepts zod 4)');
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
    expect(upgrade?.allowedPeers).toEqual(['plugin']);
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

it('collects allowed, leader, companion and proposed-extra blockers, then prints one command that passes', async () => {
  const { root, services } = fixture('npm', true);
  const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const packages = {
    blocked: { version: '1.0.0', peerDependencies: { zod: '^3' } },
    runtime: { version: '3.25.76', peerDependencies: { zod: '^3' } },
    runtimePlugin: { version: '1.0.0', peerDependencies: { runtime: '^3' } },
    observer: { version: '1.0.0', peerDependencies: { plugin: '<1.2' } },
  };
  for (const [name, manifest] of Object.entries(packages)) {
    json.dependencies[name] = manifest.version;
    mkdirSync(join(root, 'node_modules', name));
    writeFileSync(
      join(root, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, ...manifest }),
    );
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify(json));
  const registry: Awaited<ReturnType<NonNullable<PackageFetcher['manifests']>>> = {};
  const original = services.manifests;
  services.manifests = vi.fn(async (name) => {
    if (name === 'runtime')
      return {
        '3.25.76': packages.runtime,
        '4.6.5': { peerDependencies: { zod: '^4' } },
      } as typeof registry;
    if (name in packages) {
      const m = packages[name as keyof typeof packages];
      return { [m.version]: m };
    }
    return original(name);
  });
  let message = '';
  try {
    await peerPreflight(
      { cwd: root, only: 'zod', target: '4.6.5', fixer: null, allowPeer: ['blocked'] },
      services,
    );
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain('blocked 1.0.0 declares zod ^3');
  expect(message).toContain('Explicitly allowed');
  expect(message).toContain('plugin 1.0.0 declares zod ^3');
  expect(message).toContain('runtimePlugin 1.0.0 declares runtime ^3');
  expect(message).toContain('observer 1.0.0 declares plugin <1.2');
  expect(message.match(/Next:/g)).toHaveLength(1);
  expect(message).toContain(
    'Next: npx uptide fix zod plugin --target 4.6.5 --no-llm --allow-peer blocked --allow-peer runtimePlugin --allow-peer observer',
  );
  const plan = await peerPreflight(
    {
      cwd: root,
      only: 'zod',
      target: '4.6.5',
      fixer: null,
      also: ['plugin'],
      allowPeer: ['blocked', 'runtimePlugin', 'observer'],
    },
    services,
  );
  expect(plan?.companions.map((c) => c.name).sort()).toEqual(['plugin', 'runtime']);
  expect(plan?.conflicts.every((p) => p.allowed)).toBe(true);
});

it('inspects an explicitly added member at its target version and chooses a release accepting every target', async () => {
  const { root, services } = fixture('npm', true);
  const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  json.dependencies.runtime = '3.25.76';
  writeFileSync(join(root, 'package.json'), JSON.stringify(json));
  mkdirSync(join(root, 'node_modules/runtime'));
  writeFileSync(
    join(root, 'node_modules/runtime/package.json'),
    JSON.stringify({ version: '3.25.76', peerDependencies: { zod: '^3' } }),
  );
  services.manifests = vi.fn(async (name): ReturnType<NonNullable<PackageFetcher['manifests']>> => {
    if (name === 'zod') return { '4.6.5': {} };
    if (name === 'runtime') return { '4.6.5': { peerDependencies: { zod: '^4' } } };
    return {
      ...versions,
      '1.2.0': { peerDependencies: { zod: '^4', runtime: '^3' } },
      '1.3.0': { peerDependencies: { zod: '^4', runtime: '^4' } },
    };
  });
  const plan = await peerPreflight(
    { cwd: root, only: 'zod', target: '4.6.5', also: ['plugin'] },
    services,
  );
  expect(plan?.companions.find((c) => c.name === 'plugin')?.to).toBe('1.3.0');
  expect(plan?.conflicts).toEqual([]);
});

it('finds a types-companion blocker even when no installed package peers on the leader', async () => {
  const { root, services } = fixture('npm');
  const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  json.dependencies['@types/zod'] = '3.25.76';
  writeFileSync(join(root, 'package.json'), JSON.stringify(json));
  mkdirSync(join(root, 'node_modules/@types/zod'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules/@types/zod/package.json'),
    JSON.stringify({ version: '3.25.76' }),
  );
  writeFileSync(
    join(root, 'node_modules/plugin/package.json'),
    JSON.stringify({ version: '1.0.0', peerDependencies: { '@types/zod': '^3' } }),
  );
  services.manifests = vi.fn(async (name): ReturnType<NonNullable<PackageFetcher['manifests']>> => {
    if (name === 'zod' || name === '@types/zod') return { '3.25.76': {}, '4.6.5': {} };
    return { '1.0.0': { peerDependencies: { '@types/zod': '^3' } } };
  });
  await expect(
    peerPreflight({ cwd: root, only: 'zod', target: '4.6.5' }, services),
  ).rejects.toThrow('plugin 1.0.0 declares @types/zod ^3, which rejects 4.6.5');
});
