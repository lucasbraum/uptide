/**
 * packs/queue.json: the next packages worth a pack, from public npm data only.
 *
 *   pnpm packs:queue [--size=25]
 *
 * Candidates are the most downloaded packages the registry's search returns for a few broad
 * queries, minus type stubs and build tooling (their upgrades break configuration, not the
 * code that calls them), and minus what is pulled in transitively rather than imported: a
 * package downloaded more than 50,000 times a week per package that depends on it
 * (agent-base, content-type) is a dependency of dependencies. For each: weekly downloads
 * (the search result) and the breaking majors published in the last two years (the
 * packument's release dates), at most three counted (beyond that a package ships majors on a
 * schedule, and a pack per major is not what it needs). The score is the product, roughly how
 * many upgrades a pack would serve. `from → to` is the latest major and the
 * one before it. Status: `verified` or `candidate` from the pack registry when a pack covers
 * that upgrade; `in-progress` is kept from the existing file (someone said so in an issue);
 * anything else is `todo`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packStatus, registeredPacks } from '@uptide/core';

const REGISTRY = 'https://registry.npmjs.org';
const QUERIES = [
  'keywords:typescript',
  'keywords:sdk',
  'keywords:api',
  'keywords:react',
  'keywords:validation',
  'keywords:orm',
  'keywords:database',
  'keywords:http',
  'keywords:ai',
  'keywords:framework',
];
/** Build and test tooling: an upgrade changes its configuration, not the code that imports it. */
const TOOLING =
  /^(?:typescript|eslint|prettier|webpack|vite|vitest|jest|jest-.*|@angular-devkit\/.*|@angular\/cli|@vitejs\/.*|rollup|esbuild|tsup|turbo|@babel\/.*|@swc\/.*|@typescript-eslint\/.*|eslint-.*|postcss|tailwindcss|autoprefixer|nodemon|ts-node|tsx|lerna|nx|@nx\/.*|husky|lint-staged|rimraf|cross-env|dotenv|concurrently|npm|pnpm|yarn|typedoc|@types\/.*|tslib|core-js|regenerator-runtime|@biomejs\/biome|playwright|@playwright\/test|cypress|storybook|@storybook\/.*|sass|less|terser|webpack-cli|babel-.*|ts-jest|mocha|chai|sinon|nyc|c8|semver|debug|ms|chalk|picocolors|commander|yargs|minimist)$/;

interface Entry {
  package: string;
  from: string;
  to: string;
  why: string;
  status: 'todo' | 'in-progress' | 'candidate' | 'verified';
  weeklyDownloads: number;
  breakingMajors2y: number;
}

const size = Number(process.argv.find((a) => a.startsWith('--size='))?.slice(7) ?? 25);
const root = join(import.meta.dirname, '..');
const file = join(root, 'packs', 'queue.json');
const previous: Entry[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).queue : [];

async function json<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.ok) return (await res.json()) as T;
    if (attempt >= 3 || ![429, 500, 502, 503, 504].includes(res.status))
      throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

/** Weekly downloads per dependent package above which a package is reached transitively. */
const TRANSITIVE = 50_000;
const MAX_MAJORS = 3;
const weekly = new Map<string, number>();
for (const query of QUERIES) {
  for (let from = 0; from < 500; from += 250) {
    const page = await json<{
      objects: { package: { name: string }; downloads?: { weekly?: number } }[];
    }>(
      `${REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=250&from=${from}&popularity=1.0&quality=0.0&maintenance=0.0`,
    );
    for (const o of page.objects) {
      const downloads = o.downloads?.weekly ?? 0;
      const dependents = Number(o.dependents ?? 0);
      if (TOOLING.test(o.package.name) || downloads > TRANSITIVE * Math.max(dependents, 1))
        continue;
      weekly.set(o.package.name, downloads);
    }
  }
}
const top = [...weekly].sort((a, b) => b[1] - a[1]).slice(0, 300);

const now = Date.now();
const twoYears = 2 * 365 * 24 * 3600 * 1000;
const entries: Entry[] = [];
for (const [name, downloads] of top) {
  const doc = await json<{ time?: Record<string, string>; 'dist-tags'?: { latest?: string } }>(
    `${REGISTRY}/${name.replace('/', '%2F')}`,
  ).catch(() => undefined);
  const latest = doc?.['dist-tags']?.latest;
  if (!doc?.time || !latest) continue;
  // The first stable release of each major, when it came out.
  const firsts = new Map<number, number>();
  for (const [version, at] of Object.entries(doc.time)) {
    const m = /^(\d+)\.\d+\.\d+$/.exec(version);
    if (!m) continue;
    const major = Number(m[1]);
    const time = Date.parse(at);
    if (!firsts.has(major) || time < (firsts.get(major) as number)) firsts.set(major, time);
  }
  const latestMajor = Number(latest.split('.')[0]);
  const recent = [...firsts].filter(
    ([major, at]) => major >= 1 && major <= latestMajor && now - at <= twoYears,
  );
  if (recent.length === 0 || latestMajor < 1) continue;
  const from = `>=${latestMajor - 1} <${latestMajor}`;
  const to = `>=${latestMajor} <${latestMajor + 1}`;
  const pack = registeredPacks().find((e) => e.pack.name === name);
  const covered = pack?.pack.supports(`${latestMajor - 1}.99.99`, `${latestMajor}.0.0`)
    ? pack
    : undefined;
  const kept = previous.find((p) => p.package === name && p.to === to)?.status;
  const majors = recent.map(([m]) => m).sort((a, b) => a - b);
  entries.push({
    package: name,
    from,
    to,
    why: `${recent.length} breaking major${recent.length === 1 ? '' : 's'} in two years (${majors.join(', ')}), ${downloads.toLocaleString('en-US')} downloads a week`,
    status: covered ? packStatus(covered) : kept === 'in-progress' ? 'in-progress' : 'todo',
    weeklyDownloads: downloads,
    breakingMajors2y: Math.min(recent.length, MAX_MAJORS),
  });
}
const queue = entries
  .sort(
    (a, b) =>
      b.weeklyDownloads * b.breakingMajors2y - a.weeklyDownloads * a.breakingMajors2y ||
      a.package.localeCompare(b.package),
  )
  .slice(0, size);
writeFileSync(
  file,
  `${JSON.stringify(
    {
      $comment:
        'Generated by `pnpm packs:queue` from public npm data: weekly downloads (registry search) times breaking majors in the last two years (registry release dates). Pick one, say so in a pack-request issue, and follow CONTRIBUTING.md, "Write a pack".',
      generated: new Date().toISOString().slice(0, 10),
      queue,
    },
    null,
    2,
  )}\n`,
);
console.log(`${file}: ${queue.length} packages`);
for (const e of queue)
  console.log(`  ${e.status.padEnd(11)} ${e.package} ${e.from} → ${e.to}  ${e.why}`);
