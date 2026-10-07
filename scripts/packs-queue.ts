/**
 * packs/queue.json: the next packages worth a pack, ranked by what app developers migrate
 * by hand.
 *
 *   pnpm packs:queue [--size=25]
 *
 * 1. Direct use. A package counts once for each repository that declares it in a
 *    package.json (dependencies, devDependencies or optionalDependencies): the repositories
 *    of fixtures/corpus.json and the pinned public applications of packs-queue-sample.ts.
 *    Total npm downloads put what everything pulls in transitively on top (undici,
 *    google-auth-library); a declaration is someone choosing the package and upgrading it.
 *    Weekly downloads only break ties.
 * 2. One entry per upgrade. Packages that move together are merged and named after their
 *    hub: the links `list` draws (src/list/groups.ts: an exact pin both move together, a peer
 *    the latest version needs moved, a scope family), plus `@types/x` with `x` as `list`
 *    pairs them, a facade with what it re-exports (react-router-dom with react-router), and
 *    packages released in lockstep (react and react-dom, next and eslint-config-next). Two
 *    rules are narrower than `list`'s, which groups one repository's upgrade: a scope family
 *    links only members released in lockstep (`@tanstack/react-query` and
 *    `@tanstack/react-table` upgrade on their own), and a peer link attaches only a plugin to
 *    its host (eslint-plugin-x to eslint; react-router keeps its own entry and says it needs
 *    react moved).
 * 3. Something to migrate. `to` is the hub's latest major, `from` the major most sample
 *    repositories behind it declare. Fewer than three repositories behind: left out, the
 *    migration has happened. No breaking change between the two type surfaces (the diff
 *    `check` runs): left out, the major changes nothing a pack would rewrite (clsx 2, nanoid
 *    6). The count of breaking changes is in `why`.
 * 4. Codemods. A package whose official codemod covers the breaking changes end to end is
 *    left out; one whose codemod covers part of them says so and counts half.
 * 5. Out: packages with a pack already (and what moves with them), anything declared in
 *    fewer than three sample repositories, and NOT_A_PACK below.
 *
 * Status: `verified` or `candidate` from the pack registry when a pack covers the upgrade;
 * `in-progress` is kept from the existing file (someone said so in an issue); else `todo`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { diffPackage, packStatus, registeredPacks } from '@uptide/core';
import type { Manifest } from '../packages/core/src/list/evidence.js';
import { dependencyGroups } from '../packages/core/src/list/groups.js';
import type { ListedDependency } from '../packages/core/src/list/list.js';
import { declaredIn, manifestsOf, SAMPLE } from './packs-queue-sample.js';

const REGISTRY = 'https://registry.npmjs.org';
/** Declared in fewer sample repositories than this, a package is not ranked. */
const MIN_REPOS = 3;

/** Declared everywhere, but no API a pack would migrate. */
const NOT_A_PACK: Record<string, string> = {
  typescript:
    'the compiler every pack verifies with: its upgrades change compiler options and checks, not calls',
  '@types/node': 'the types of Node itself: the upgrade is the runtime, not a package',
};

/**
 * Official codemods for the upgrade `to` names, from each project's own migration guide.
 * `all`: the codemod covers every breaking change, so a pack adds nothing (left out).
 * `some`: it covers part of them, and the rest is migrated by hand (the entry counts half).
 */
const CODEMODS: Record<string, { to: number; url: string; covers: 'all' | 'some'; note: string }> =
  {
    next: {
      to: 16,
      url: 'https://nextjs.org/docs/app/guides/upgrading/version-16',
      covers: 'some',
      note: '`@next/codemod upgrade` moves config, middleware to proxy and stabilized APIs; async request APIs and caching changes are reviewed by hand',
    },
    react: {
      to: 19,
      url: 'https://react.dev/blog/2024/04/25/react-19-upgrade-guide',
      covers: 'some',
      note: '`react/19/migration-recipe` and `types-react-codemod preset-19` cover render, string refs, act and removed types; the guide lists the rest as manual',
    },
    tailwindcss: {
      to: 4,
      url: 'https://tailwindcss.com/docs/upgrade-guide',
      covers: 'some',
      note: '`@tailwindcss/upgrade` converts config to CSS and renames utilities; custom plugins and changed defaults are manual',
    },
    eslint: {
      to: 10,
      url: 'https://eslint.org/docs/latest/use/migrate-to-10.0.0',
      covers: 'some',
      note: '`@eslint/migrate-config` converts .eslintrc to a flat config; removed APIs, rules and plugin compatibility are manual',
    },
    express: {
      to: 5,
      url: 'https://expressjs.com/en/guide/migrating-5',
      covers: 'some',
      note: 'the `@expressjs/v5-migration-recipe` codemods cover removed method signatures; path syntax, promise handling and changed request properties are manual',
    },
  };

interface Entry {
  package: string;
  /** The packages upgraded with it, hub first. */
  members: string[];
  from: string;
  to: string;
  why: string;
  status: 'todo' | 'in-progress' | 'candidate' | 'verified';
  /** Sample repositories declaring any member directly. */
  repos: number;
  /** Of those, the ones declaring the hub below `to`. */
  reposBehind: number;
  weeklyDownloads: number;
  codemod?: string;
}

const size = Number(process.argv.find((a) => a.startsWith('--size='))?.slice(7) ?? 25);
const root = join(import.meta.dirname, '..');
const file = join(root, 'packs', 'queue.json');
const previous: Entry[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).queue : [];

async function json<T>(url: string, accept = 'application/json'): Promise<T | undefined> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { accept } });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 404) return undefined;
    if (attempt >= 6 || ![429, 500, 502, 503, 504].includes(res.status))
      throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}
/** `fn` over `items`, `limit` at a time. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}
const encode = (name: string): string => name.replace('/', '%2F');

// 1. Direct declarations, per repository.
const corpus = JSON.parse(readFileSync(join(root, 'fixtures', 'corpus.json'), 'utf8')) as {
  repo: string;
  commit: string;
}[];
const repos = [...corpus.map((c) => [c.repo, c.commit] as const), ...SAMPLE];
/** package → repository → majors it declares there. */
const declared = new Map<string, Map<string, Set<number>>>();
for (const [repo, commit] of repos) {
  console.error(`reading ${repo}@${commit.slice(0, 12)}`);
  for (const [name, majors] of declaredIn(manifestsOf(repo, commit))) {
    const by = declared.get(name) ?? new Map<string, Set<number>>();
    by.set(repo, majors);
    declared.set(name, by);
  }
}
const own = new Set(registeredPacks().map((e) => e.pack.name));
const named = [...declared].filter(([name, by]) => by.size >= MIN_REPOS && !(name in NOT_A_PACK));

// 2. The latest version of each, then the full version list of those someone is behind on.
console.error(`${named.length} packages in ${MIN_REPOS}+ repositories: reading npm`);
const latest = new Map<string, Manifest>();
await pool(named, 16, async ([name]) => {
  const manifest = await json<Manifest>(`${REGISTRY}/${encode(name)}/latest`);
  if (manifest?.version) latest.set(name, manifest);
});
const majorOfVersion = (version: string): number => Number(version.split('.')[0]);
const behind = (name: string): Map<string, number> => {
  const to = majorOfVersion(latest.get(name)?.version ?? '0');
  const out = new Map<string, number>();
  for (const [repo, majors] of declared.get(name) ?? []) {
    const lowest = Math.min(...majors);
    if (Number.isFinite(lowest) && lowest < to) out.set(repo, lowest);
  }
  return out;
};
type Packument = {
  versions?: Record<string, Manifest>;
  'dist-tags'?: Record<string, string>;
};
const packuments = new Map<string, Packument>();
/** What `name`'s latest version re-exports: a dependency pinned at its own version. */
const reexports = (name: string): string | undefined => {
  const m = latest.get(name);
  return Object.entries(m?.dependencies ?? {}).find(
    ([dep, range]) => range === m?.version && latest.has(dep),
  )?.[0];
};
const outdated = named.filter(
  ([name]) =>
    latest.has(name) &&
    (behind(name).size > 0 ||
      // A types package moves with its runtime package, and what a facade re-exports with
      // the facade (react-router-dom → react-router): keep them to merge.
      name.startsWith('@types/') ||
      named.some(([other]) => behind(other).size > 0 && reexports(other) === name)),
);
await pool(outdated, 8, async ([name]) => {
  const doc = await json<Packument>(
    `${REGISTRY}/${encode(name)}`,
    'application/vnd.npm.install-v1+json',
  );
  if (doc?.versions) packuments.set(name, doc);
});
const STABLE = /^\d+\.\d+\.\d+$/;
const stable = new Map<string, string[]>();
const stableVersions = (name: string): string[] => {
  let versions = stable.get(name);
  if (!versions) {
    versions = Object.keys(packuments.get(name)?.versions ?? {}).filter((v) => STABLE.test(v));
    stable.set(name, versions);
  }
  return versions;
};
/** The newest release of `major`: the version an app behind on it has. */
const newestOf = (name: string, major: number): string | undefined =>
  stableVersions(name)
    .filter((v) => majorOfVersion(v) === major)
    .sort((a, b) => {
      const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
      return (x[0] ?? 0) - (y[0] ?? 0) || (x[1] ?? 0) - (y[1] ?? 0) || (x[2] ?? 0) - (y[2] ?? 0);
    })
    .at(-1);
/** The major most repositories behind it declare. */
const fromMajor = (name: string): number | undefined => {
  const counts = new Map<number, number>();
  for (const major of behind(name).values()) counts.set(major, (counts.get(major) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
};

// 3. Groups: what `list` links, plus types and lockstep releases.
const names = [...packuments.keys()];
const listed = (name: string): ListedDependency | undefined => {
  const to = latest.get(name)?.version;
  const from = fromMajor(name);
  const current = from === undefined ? undefined : newestOf(name, from);
  if (!to || !current) return undefined;
  return {
    name,
    current,
    latest: to,
    change: 'major',
    tier: 'generic',
    majorGap: majorOfVersion(to) - majorOfVersion(current),
    classification: 'used',
    reasons: [],
    workspaces: ['.'],
    usage: {
      files: declared.get(name)?.size ?? 0,
      callSites: 0,
      references: 0,
      topSymbols: [],
      workspaces: ['.'],
    },
  } as ListedDependency;
};
const rows = new Map(names.flatMap((n) => (listed(n) ? [[n, listed(n) as ListedDependency]] : [])));
const manifestAt = (name: string, version: string): Manifest =>
  packuments.get(name)?.versions?.[version] ?? {};
const scopeOf = (name: string): string | undefined =>
  name.startsWith('@') && !name.startsWith('@types/') ? name.split('/')[0] : undefined;
/**
 * Released together: the same latest version and nearly the same release history (react and
 * react-dom, next and eslint-config-next). Matching versions alone can be coincidence (a
 * short history fits inside a long one), so it takes 20 shared releases, 80% of the shorter
 * history (react predates react-dom), and histories of comparable length.
 */
const sharedHistory = (a: string, b: string): { shared: number; short: number; long: number } => {
  const [x, y] = [new Set(stableVersions(a)), new Set(stableVersions(b))];
  return {
    shared: [...x].filter((v) => y.has(v)).length,
    short: Math.min(x.size, y.size),
    long: Math.max(x.size, y.size),
  };
};
const lockstep = (a: string, b: string): boolean => {
  if (latest.get(a)?.version !== latest.get(b)?.version) return false;
  const { shared, short, long } = sharedHistory(a, b);
  return shared >= 20 && shared >= 0.8 * short && short >= 0.5 * long;
};
const parent = new Map(names.map((n) => [n, n]));
const find = (n: string): string => {
  let r = n;
  while (parent.get(r) !== r) r = parent.get(r) as string;
  return r;
};
const why = new Map<string, Set<string>>();
const join2 = (a: string, b: string, reason: string): void => {
  parent.set(find(a), find(b));
  for (const n of [a, b]) why.set(n, (why.get(n) ?? new Set()).add(reason));
};
const pins = (m: Manifest): string[] =>
  Object.entries(m.dependencies ?? {})
    .filter(([, v]) => /^\d+\.\d+\.\d+/.test(v))
    .map(([d]) => d);
/** `host` is a required peer of `dependent`'s latest version (an optional one moves nothing). */
const peerOf = (dependent: Manifest, host: string): boolean =>
  host in (dependent.peerDependencies ?? {}) &&
  !(dependent.peerDependenciesMeta as Record<string, { optional?: boolean }> | undefined)?.[host]
    ?.optional;
/** dependent → the hosts `list` says it needs moved. */
const hosts = new Map<string, string[]>();
for (const [i, a] of names.entries())
  for (const b of names.slice(i + 1)) {
    const [ra, rb] = [rows.get(a), rows.get(b)];
    const scoped = scopeOf(a) !== undefined && scopeOf(a) === scopeOf(b);
    if (lockstep(a, b)) {
      join2(a, b, scoped ? `${scopeOf(a)} released in lockstep` : 'released in lockstep');
      continue;
    }
    if (!ra || !rb) continue;
    const [ta, tb] = [manifestAt(a, ra.latest), manifestAt(b, rb.latest)];
    // Only pairs `list` could link outside a family: a required peer, or an exact pin in common.
    const [aNeedsB, bNeedsA] = [peerOf(ta, b), peerOf(tb, a)];
    if (!aNeedsB && !bNeedsA && !pins(ta).some((d) => pins(tb).includes(d))) continue;
    const metadata = new Map([
      [a, [manifestAt(a, ra.current)]],
      [b, [manifestAt(b, rb.current)]],
    ]);
    const targets = new Map([
      [a, { ...ta, peerDependencies: aNeedsB ? ta.peerDependencies : {} }],
      [b, { ...tb, peerDependencies: bNeedsA ? tb.peerDependencies : {} }],
    ]);
    const reason = dependencyGroups([{ ...ra }, { ...rb }], metadata, targets)[0]?.reason ?? '';
    // A shared pin: moving one alone leaves two copies of what both pin.
    const shared = reason
      .split(', ')
      .filter((r) => r.startsWith('shared '))
      .join(', ');
    if (shared) join2(a, b, shared);
    else if (reason.includes('peer link')) {
      if (aNeedsB) hosts.set(a, [...(hosts.get(a) ?? []), b]);
      if (bNeedsA) hosts.set(b, [...(hosts.get(b) ?? []), a]);
    }
  }
// `@types/react` moves with `react`, `@types/scope__name` with `@scope/name`.
for (const name of names.filter((n) => n.startsWith('@types/'))) {
  const runtime = name.slice('@types/'.length).replace(/^([^_]+)__/, '@$1/');
  if (parent.has(runtime)) join2(name, runtime, `types for ${runtime}`);
}

/**
 * A peer link attaches a plugin to its host: a package named as one (eslint-plugin-x,
 * prettier-plugin-x, @vitejs/plugin-react) joins the host its name starts from, unless it
 * already moves with something else (eslint-config-next is released with next). A library
 * that needs its peer moved (react-router, which needs react 19) keeps its own entry: its
 * pack migrates its own API, and `why` names the peer.
 */
const PLUGIN = /(?:^|[-/])(?:plugin|config|preset|loader)(?:[-/]|$)/;
const needs = new Map<string, string[]>();
for (const [dependent, needed] of hosts) {
  const bare = (n: string) => n.replace(/^@[^/]+\//, '');
  const host = PLUGIN.test(dependent)
    ? needed
        .filter((h) => dependent.includes(bare(h)))
        .sort((x, y) => dependent.indexOf(bare(x)) - dependent.indexOf(bare(y)))[0]
    : undefined;
  const alone = names.filter((n) => find(n) === find(dependent)).length === 1;
  if (host && alone) join2(dependent, host, `plugin of ${host}`);
  else needs.set(dependent, needed);
}
/**
 * A facade moves with what it re-exports: react-router-dom 7 is react-router at the same
 * version, motion is framer-motion. Its users migrate to the package it re-exports, which
 * is the hub. Pinning a dependency that happens to share the version is no facade
 * (eslint-config-next 16.4.0 pinning globals 16.4.0): a facade was released with what it
 * re-exports, 20 shared releases and 80% of the shorter history.
 */
const facades = new Map<string, string>();
for (const name of names) {
  const target = reexports(name);
  const history = target ? sharedHistory(name, target) : undefined;
  if (
    target &&
    parent.has(target) &&
    history &&
    history.shared >= 20 &&
    history.shared >= 0.8 * history.short
  ) {
    facades.set(name, target);
    join2(name, target, `${name} re-exports ${target}`);
  }
}

// 4. Entries: one per group, named after its hub, ranked by direct use.
const components = new Map<string, string[]>();
for (const n of names) components.set(find(n), [...(components.get(find(n)) ?? []), n]);
const entries: (Entry & { score: number; versions: [string, string]; stand?: string })[] = [];
for (const members of components.values()) {
  if (members.some((m) => own.has(m))) continue;
  const runtime = members.filter((m) => !m.startsWith('@types/') && packuments.has(m));
  if (runtime.length === 0) continue;
  const repoSet = new Set(members.flatMap((m) => [...(declared.get(m)?.keys() ?? [])]));
  // The hub: what the facades re-export, else the member most repositories declare (react,
  // not react-dom; next, not eslint-config-next).
  const used = (m: string) => declared.get(m)?.size ?? 0;
  const targets = new Set(members.flatMap((m) => facades.get(m) ?? []));
  const hub = [...runtime].sort(
    (a, b) =>
      Number(targets.has(b)) - Number(targets.has(a)) || used(b) - used(a) || a.localeCompare(b),
  )[0];
  const hubLatest = hub && latest.get(hub)?.version;
  if (!hub || !hubLatest) continue;
  const to = majorOfVersion(hubLatest);
  // Behind: repositories declaring the hub, or a facade of it, below its latest major.
  const behindRepos = new Map<string, number>();
  for (const m of [hub, ...members.filter((m) => facades.get(m) === hub)])
    for (const [repo, majors] of declared.get(m) ?? []) {
      const lowest = Math.min(...majors);
      if (Number.isFinite(lowest) && lowest < to)
        behindRepos.set(repo, Math.min(lowest, behindRepos.get(repo) ?? lowest));
    }
  if (behindRepos.size < MIN_REPOS) {
    console.error(`left out ${hub}: ${behindRepos.size} sample repositories behind ${to}`);
    continue;
  }
  const counts = new Map<number, number>();
  for (const major of behindRepos.values()) counts.set(major, (counts.get(major) ?? 0) + 1);
  const from = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] as number;
  const fromVersion = newestOf(hub, from) ?? `${from}.0.0`;
  const codemod = CODEMODS[hub]?.to === to ? CODEMODS[hub] : undefined;
  if (codemod?.covers === 'all') {
    console.error(`left out ${hub}: ${codemod.note} (${codemod.url})`);
    continue;
  }
  const pack = registeredPacks().find((e) => e.pack.name === hub);
  const covered = pack?.pack.supports(fromVersion, hubLatest) ? pack : undefined;
  const kept = previous.find((p) => p.package === hub && p.to === `>=${to} <${to + 1}`)?.status;
  const typesOf = `@types/${hub.replace(/^@([^/]+)\//, '$1__')}`;
  entries.push({
    package: hub,
    members: [hub, ...members.filter((m) => m !== hub).sort()],
    from: `>=${from} <${from + 1}`,
    to: `>=${to} <${to + 1}`,
    why: '',
    status: covered ? packStatus(covered) : kept === 'in-progress' ? 'in-progress' : 'todo',
    repos: repoSet.size,
    reposBehind: behindRepos.size,
    weeklyDownloads: 0,
    ...(codemod ? { codemod: `${codemod.url} (${codemod.note})` } : {}),
    score: repoSet.size * (codemod ? 0.5 : 1),
    versions: [fromVersion, hubLatest],
    ...(members.includes(typesOf) ? { stand: typesOf } : {}),
  });
}
entries.sort((a, b) => b.score - a.score || a.package.localeCompare(b.package));

/**
 * What a pack would migrate: the breaking changes `check` finds between the two type
 * surfaces (the diff Uptide runs on every upgrade). A major that changes none (clsx 2,
 * nanoid 6: ESM-only, a newer Node) leaves nothing to rewrite. A package without types is
 * read through its `@types` member (express → @types/express). Cached per version pair.
 */
const diffCache = join(homedir(), '.cache', 'uptide', 'queue-diff');
async function breakingChanges(
  name: string,
  from: string,
  to: string,
): Promise<number | undefined> {
  const file = join(diffCache, `${name.replace('/', '__')}@${from}..${to}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).breaking;
  try {
    const changes = await diffPackage({ name, from, to });
    const breaking = changes.filter((c) => c.severity === 'breaking').length;
    mkdirSync(diffCache, { recursive: true });
    writeFileSync(file, JSON.stringify({ breaking }));
    return breaking;
  } catch (err) {
    console.error(`${name} ${from} → ${to}: ${(err as Error).message.split('\n')[0]}`);
    return undefined;
  }
}
const ranked: (typeof entries)[number][] = [];
const api = new Map<string, string>();
for (const e of entries) {
  // Every entry tied with the last place is read, so ties are decided by downloads below.
  if (ranked.length >= size && e.score < (ranked[size - 1]?.score ?? 0)) break;
  console.error(`diffing ${e.package} ${e.versions[0]} → ${e.versions[1]}`);
  let breaking = await breakingChanges(e.package, ...e.versions);
  let via = '';
  if (breaking === undefined && e.stand) {
    const major = (v: string) => majorOfVersion(v);
    const standFrom = newestOf(e.stand, major(e.versions[0]));
    const standTo = latest.get(e.stand)?.version;
    if (standFrom && standTo) {
      breaking = await breakingChanges(e.stand, standFrom, standTo);
      via = ` (${e.stand} ${standFrom} → ${standTo})`;
    }
  }
  if (breaking === 0) {
    console.error(`left out ${e.package}: no breaking API change${via}`);
    continue;
  }
  api.set(
    e.package,
    breaking === undefined
      ? 'API change not measured (no type declarations)'
      : `${breaking} breaking API change${breaking === 1 ? '' : 's'} from ${e.versions[0]} to ${e.versions[1]}${via}`,
  );
  ranked.push(e);
}
// Downloads break ties only, so they are read for tied entries that can still place. The
// registry's search carries them (the weekly count api.npmjs.org gives), so the script needs
// registry.npmjs.org alone; it rate-limits, hence two at a time.
const cut = ranked[Math.min(size, ranked.length) - 1]?.score ?? 0;
const scores = ranked.map((e) => e.score);
const tied = ranked.filter(
  (e) => e.score >= cut && scores.indexOf(e.score) !== scores.lastIndexOf(e.score),
);
await pool(tied, 2, async (e) => {
  const page = await json<{
    objects: { package: { name: string }; downloads?: { weekly?: number } }[];
  }>(`${REGISTRY}/-/v1/search?text=${encodeURIComponent(e.package)}&size=20`);
  e.weeklyDownloads =
    page?.objects.find((o) => o.package.name === e.package)?.downloads?.weekly ?? 0;
});
const queue = ranked
  .sort(
    (a, b) =>
      b.score - a.score ||
      b.weeklyDownloads - a.weeklyDownloads ||
      a.package.localeCompare(b.package),
  )
  .slice(0, size)
  .map(({ score: _score, versions: _versions, stand: _stand, ...e }) => {
    const together = e.members.length > 1 ? `; upgraded with ${e.members.slice(1).join(', ')}` : '';
    const reasons = [
      ...(why.get(e.package) ?? []),
      ...(needs.get(e.package) ?? []).map((h) => `needs ${h} moved`),
    ];
    return {
      ...e,
      why: `declared directly in ${e.repos} of ${repos.length} sample repositories, ${e.reposBehind} of them on an older major; ${api.get(e.package)}${together}${reasons.length ? ` (${reasons.join(', ')})` : ''}`,
    };
  });
writeFileSync(
  file,
  `${JSON.stringify(
    {
      $comment:
        'Generated by `pnpm packs:queue`: ranked by how many sample repositories (fixtures/corpus.json and scripts/packs-queue-sample.ts, pinned public applications) declare the package directly, weekly downloads breaking ties; packages that upgrade together are one entry named after their hub. Pick one, say so in a pack-request issue, and follow CONTRIBUTING.md, "Write a pack".',
      generated: new Date().toISOString().slice(0, 10),
      sample: repos.length,
      queue,
    },
    null,
    2,
  )}\n`,
);
// As the repository formats it (the local Biome, never a downloaded one).
execFileSync(join(root, 'node_modules', '.bin', 'biome'), ['format', '--write', file], {
  stdio: 'ignore',
});
console.log(`${file}: ${queue.length} packages`);
for (const e of queue)
  console.log(
    `  ${String(e.repos).padStart(2)} repos (${String(e.reposBehind).padStart(2)} behind)  ${e.package} ${e.from} → ${e.to}${e.members.length > 1 ? `  + ${e.members.slice(1).join(', ')}` : ''}${e.codemod ? `  codemod: ${e.codemod}` : ''}`,
  );
