import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Companion, companionsOf, peerConflictOf } from '../check/companions.js';
import { compareVersions, parseVersion } from '../check/version.js';
import type { PackageFetcher } from '../domain/io.js';
import { UptideError } from '../errors.js';
import { createNpmFetcher } from '../fetch/npm-fetcher.js';
import { loadRegistryConfig } from '../fetch/npmrc.js';
import { satisfies } from '../fetch/range.js';
import type { Manifest } from '../list/evidence.js';
import { activePack } from '../packs/index.js';
import { UPTIDE_COMMAND } from '../version.js';
import { type ManagerKind, packageManager } from './managers/manager.js';
import { fixDependencies } from './range-preflight.js';
import type { FixOptions, FixServices } from './run.js';
import { type ResolvedTarget, resolveTarget } from './target.js';
import { validateVersionRanges } from './versions.js';

export interface PeerBlocker {
  name: string;
  version: string;
  peer: string;
  range: string;
  target: string;
  newer?: string;
  allowed: boolean;
}
export interface PeerPlan {
  target: string;
  targetSource: ResolvedTarget['source'];
  companions: Companion[];
  conflicts: PeerBlocker[];
}
type Manifests = NonNullable<PackageFetcher['manifests']>;

/** The lowest stable upgrade that explicitly declares support for this peer target. */
export function compatiblePeerVersion(
  versions: Awaited<ReturnType<Manifests>>,
  installed: string,
  peer: string,
  target: string,
): string | undefined {
  return Object.keys(versions)
    .filter(
      (v) =>
        parseVersion(v) !== undefined &&
        parseVersion(v)?.pre === undefined &&
        compareVersions(v, installed) > 0,
    )
    .sort(compareVersions)
    .find((v) => {
      const range = versions[v]?.peerDependencies?.[peer];
      return range !== undefined && satisfies(target, range);
    });
}

export const peerDescription = (p: PeerBlocker): string =>
  `${p.name} ${p.version} declares ${p.peer} ${p.range}, which rejects ${p.target}`;

/** Read-only planning, shared by direct callers and the CLI before its private clone. */
export async function peerPreflight(
  options: FixOptions,
  services?: FixServices,
  read = (file: string) => readFileSync(join(options.cwd, file), 'utf8'),
): Promise<PeerPlan | undefined> {
  if (options.pinCurrentApi) return;
  const { installed } = fixDependencies(options.cwd, read);
  const deps = [...installed.values()];
  const pack = options.pack ?? activePack(options.only);
  const hosts = [options.only, ...(pack?.companions?.map((c) => c.name) ?? [])];
  if (
    !deps.some((d) => hosts.some((name) => d.manifest.peerDependencies?.[name])) &&
    !options.also?.length &&
    !options.allowPeer?.length
  )
    return;
  const fetcher = createNpmFetcher({ config: loadRegistryConfig({ cwd: options.cwd }) });
  const fetch = services?.manifests ?? fetcher.manifests;
  if (!fetch) throw new Error('Registry manifests are required to plan peers');
  const cache = new Map<string, ReturnType<Manifests>>();
  const manifests: Manifests = (name) => {
    let pending = cache.get(name);
    if (!pending) {
      pending = fetch(name);
      cache.set(name, pending);
    }
    return pending;
  };
  const { version: target, source: targetSource } = await resolveTarget(
    pack ?? { name: options.only, defaultTarget: '' },
    options.target,
    services?.resolve ?? fetcher.resolve,
  );
  const plan = await companionsOf({
    name: options.only,
    target,
    installed: deps,
    manifests,
    lockstep: pack?.companions?.map((c) => c.name) ?? [],
  });
  const moves = [{ name: options.only, to: target }, ...plan.companions];
  const conflicts: PeerBlocker[] = [];
  for (const dep of deps) {
    if (moves.some((m) => m.name === dep.name)) continue;
    for (const host of moves) {
      if (!dep.manifest.peerDependencies?.[host.name]) continue;
      if (
        !deps.some(
          (d) => d.name === host.name && d.workspaces.some((w) => dep.workspaces.includes(w)),
        )
      )
        continue;
      const versions = await manifests(dep.name);
      if (!peerConflictOf(dep, host.name, host.to, versions)) continue;
      const range = (versions[dep.version] ?? dep.manifest).peerDependencies?.[host.name];
      if (!range) continue;
      conflicts.push({
        name: dep.name,
        version: dep.version,
        peer: host.name,
        range,
        target: host.to,
        newer: compatiblePeerVersion(versions, dep.version, host.name, host.to),
        allowed: options.allowPeer?.includes(dep.name) ?? false,
      });
    }
  }
  const companions: Companion[] = [];
  for (const name of new Set(options.also ?? [])) {
    const blocked = conflicts.filter((p) => p.name === name);
    if (!blocked.length)
      throw new UptideError(
        'INCONSISTENT_UPGRADE',
        `${name} is not a peer blocker of ${options.only}; name only the peer upgrades suggested by the plan.`,
      );
    const versions = await manifests(name);
    const version = Object.keys(versions)
      .filter(
        (v) =>
          parseVersion(v) !== undefined &&
          parseVersion(v)?.pre === undefined &&
          blocked.every(
            (p) =>
              compareVersions(v, p.version) > 0 &&
              !!versions[v]?.peerDependencies?.[p.peer] &&
              satisfies(p.target, versions[v]?.peerDependencies?.[p.peer] as string),
          ),
      )
      .sort(compareVersions)[0];
    if (!version)
      throw new UptideError(
        'INCONSISTENT_UPGRADE',
        `${name} has no newer release accepting the target peers.`,
      );
    companions.push({
      name,
      from: blocked[0]?.version as string,
      to: version,
      reason: `explicit peer upgrade accepting ${blocked.map((p) => `${p.peer} ${p.target}`).join(', ')}`,
    });
  }
  const remaining = conflicts.filter((p) => !companions.some((c) => c.name === p.name));
  for (const name of options.allowPeer ?? [])
    if (!remaining.some((p) => p.name === name))
      throw new UptideError(
        'INCONSISTENT_UPGRADE',
        `--allow-peer ${name}: no conflicting installed peer with that name in this upgrade.`,
      );
  validateVersionRanges(
    options.cwd,
    companions.map((c) => c.name),
    read,
  );
  const describe = (p: PeerBlocker) =>
    `${peerDescription(p)}. ${p.allowed ? 'Explicitly allowed; a manifest override will be written.' : p.newer ? `${p.name} ${p.newer} accepts it; run ${UPTIDE_COMMAND} fix ${options.only} ${p.name}.` : `No newer compatible release; explicitly accept the risk with --allow-peer ${p.name}.`}`;
  const blocked = remaining.filter((p) => !p.allowed);
  if (packageManager(options.cwd).kind === 'npm' && blocked.length)
    throw new UptideError(
      'INCONSISTENT_UPGRADE',
      `Peer blockers (before cloning):\n${blocked.map(describe).join('\n')}`,
    );
  for (const peer of remaining)
    options.onProgress?.({
      phase: 'resolve',
      state: 'done',
      warning: true,
      package: peer.name,
      detail: describe(peer),
    });
  return { target, targetSource, companions, conflicts: remaining };
}

/** Root-only manager settings; preserve existing overrides and unrelated entries. */
type OverrideManifest = Pick<
  Manifest,
  'dependencies' | 'devDependencies' | 'optionalDependencies'
> & {
  overrides?: Record<string, string | Record<string, string>>;
  pnpm?: { peerDependencyRules?: { allowedVersions?: Record<string, string> } };
  resolutions?: Record<string, string>;
};
export function allowPeerOverrides(
  manifest: OverrideManifest,
  manager: ManagerKind,
  peers: PeerBlocker[],
): void {
  for (const p of peers.filter((p) => p.allowed)) {
    if (manager === 'npm') {
      manifest.overrides ??= {};
      const overrides = manifest.overrides;
      const before = overrides[p.name];
      const entry: Record<string, string> =
        typeof before === 'string' ? { '.': before } : { ...before };
      const direct = (['dependencies', 'devDependencies', 'optionalDependencies'] as const).some(
        (s) => manifest[s]?.[p.peer],
      );
      entry[p.peer] = direct ? `$${p.peer}` : p.target;
      overrides[p.name] = entry;
    } else if (manager === 'pnpm') {
      manifest.pnpm ??= {};
      manifest.pnpm.peerDependencyRules ??= {};
      const rules = manifest.pnpm.peerDependencyRules;
      rules.allowedVersions ??= {};
      rules.allowedVersions[`${p.name}>${p.peer}`] = p.target;
    } else {
      manifest.resolutions ??= {};
      manifest.resolutions[`${p.name}/${p.peer}`] = p.target;
    }
  }
}

export function writePeerOverrides(root: string, peers: PeerBlocker[]): string[] {
  if (!peers.some((p) => p.allowed)) return [];
  const file = join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  allowPeerOverrides(manifest, packageManager(root).kind, peers);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return [file];
}
