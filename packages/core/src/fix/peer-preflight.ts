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
  const installedNames = new Set(deps.map((d) => d.name));
  // A peer may reject a discovered companion even when nobody peers on the leader.
  if (
    !deps.some((d) =>
      Object.keys(d.manifest.peerDependencies ?? {}).some((name) => installedNames.has(name)),
    ) &&
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
  const base = new Map<string, Companion>([
    [
      options.only,
      {
        name: options.only,
        from: deps.find((d) => d.name === options.only)?.version ?? '',
        to: target,
        reason: 'requested upgrade',
      },
    ],
    ...plan.companions.map((c) => [c.name, c] as const),
  ]);
  const requested = new Set(options.also ?? []);
  const allowed = new Set(options.allowPeer ?? []);
  const history = new Map<string, PeerBlocker>();

  // Inspect the target manifest of a moving member too: its new peers may block another move.
  const conflictsOf = async (moves: Map<string, Companion>): Promise<PeerBlocker[]> => {
    const found = new Map<string, PeerBlocker>();
    for (const dep of deps) {
      const move = moves.get(dep.name);
      if (
        !move &&
        !Object.keys(dep.manifest.peerDependencies ?? {}).some((name) => moves.has(name))
      )
        continue;
      const versions = await manifests(dep.name);
      const version = move?.to ?? dep.version;
      const current = versions[version] ?? dep.manifest;
      for (const host of moves.values()) {
        if (dep.name === host.name || !current.peerDependencies?.[host.name]) continue;
        if (
          !deps.some(
            (d) => d.name === host.name && d.workspaces.some((w) => dep.workspaces.includes(w)),
          )
        )
          continue;
        if (!peerConflictOf({ ...dep, version, manifest: current }, host.name, host.to, {}))
          continue;
        const peer: PeerBlocker = {
          name: dep.name,
          version,
          peer: host.name,
          range: current.peerDependencies[host.name] as string,
          target: host.to,
          allowed: allowed.has(dep.name),
        };
        found.set(`${dep.name}@${version}>${host.name}@${host.to}`, peer);
      }
    }
    // One release must accept every target peer, not a different release per rejected range.
    for (const peer of found.values()) {
      if (base.has(peer.name)) continue;
      const versions = await manifests(peer.name);
      const rejected = [...found.values()].filter((p) => p.name === peer.name);
      peer.newer = Object.keys(versions)
        .filter((v) => {
          if (
            !parseVersion(v) ||
            parseVersion(v)?.pre !== undefined ||
            compareVersions(v, peer.version) <= 0
          )
            return false;
          const ranges = versions[v]?.peerDependencies ?? {};
          return (
            rejected.every((p) => ranges[p.peer] !== undefined) &&
            [...moves.values()].every(
              (m) => ranges[m.name] === undefined || satisfies(m.to, ranges[m.name] as string),
            )
          );
        })
        .sort(compareVersions)[0];
    }
    return [...found.values()];
  };
  const remember = (peers: PeerBlocker[]) => {
    for (const p of peers) history.set(`${p.name}@${p.version}>${p.peer}@${p.target}`, p);
  };
  const add = async (moves: Map<string, Companion>, peer: PeerBlocker) => {
    const to = peer.newer as string;
    moves.set(peer.name, {
      name: peer.name,
      from: deps.find((d) => d.name === peer.name)?.version ?? peer.version,
      to,
      reason: `explicit peer upgrade accepting ${peer.peer} ${peer.target}`,
    });
    const linked = await companionsOf({
      name: peer.name,
      target: to,
      installed: deps,
      manifests,
      lockstep: activePack(peer.name)?.companions?.map((c) => c.name) ?? [],
    });
    for (const c of linked.companions) if (!moves.has(c.name)) moves.set(c.name, c);
  };
  const resolveExtras = async (extras: Set<string>) => {
    const moves = new Map(base);
    for (;;) {
      const peers = await conflictsOf(moves);
      remember(peers);
      const next = peers.find((p) => extras.has(p.name) && p.newer !== undefined);
      if (!next) return { moves, peers };
      await add(moves, next);
    }
  };
  const actual = await resolveExtras(requested);
  const invalid = [...requested].filter(
    (name) => !actual.moves.has(name) && !actual.peers.some((p) => p.name === name),
  );
  if (invalid.length)
    throw new UptideError(
      'INCONSISTENT_UPGRADE',
      `${invalid.join(', ')}: not a peer blocker of this upgrade; name only the peer upgrades suggested by the plan.`,
    );
  for (const name of allowed)
    if (!actual.peers.some((p) => p.name === name))
      throw new UptideError(
        'INCONSISTENT_UPGRADE',
        `--allow-peer ${name}: no conflicting installed peer with that name in this upgrade.`,
      );
  const companions = [...actual.moves.values()].filter((c) => c.name !== options.only);
  validateVersionRanges(
    options.cwd,
    companions.map((c) => c.name),
    read,
  );
  const describe = (p: PeerBlocker) => {
    const accepts = `${p.peer} ${parseVersion(p.target)?.major ?? p.target}`;
    return `${peerDescription(p)}. ${p.allowed ? 'Explicitly allowed; a manifest override will be written.' : p.newer ? `upgrade to ${p.newer} (accepts ${accepts}): add ${p.name} to the command` : `no release accepts ${accepts}: use --allow-peer ${p.name}`}`;
  };
  if (packageManager(options.cwd).kind === 'npm' && actual.peers.some((p) => !p.allowed)) {
    // Look ahead through suggested upgrades so the one command includes their blockers as well.
    const extras = new Set(requested);
    const allowances = new Set(allowed);
    for (;;) {
      const preview = await resolveExtras(extras);
      const next = preview.peers.find((p) => !allowances.has(p.name));
      if (!next) {
        for (const name of allowances)
          if (!preview.peers.some((p) => p.name === name)) allowances.delete(name);
        break;
      }
      if (next.newer && !extras.has(next.name)) extras.add(next.name);
      else allowances.add(next.name);
    }
    const command = [
      UPTIDE_COMMAND,
      'fix',
      options.only,
      ...extras,
      '--target',
      target,
      ...(options.fixer === null ? ['--no-llm'] : []),
      ...[...allowances].flatMap((name) => ['--allow-peer', name]),
    ].join(' ');
    throw new UptideError(
      'INCONSISTENT_UPGRADE',
      `Peer blockers (before cloning):\n${[...history.values()].map(describe).join('\n')}\n\nNext: ${command}`,
    );
  }
  for (const peer of actual.peers)
    options.onProgress?.({
      phase: 'resolve',
      state: 'done',
      warning: true,
      package: peer.name,
      detail: describe(peer),
    });
  return { target, targetSource, companions, conflicts: actual.peers };
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
