/**
 * Where `pnpm packs:queue` counts direct use: the repositories of fixtures/corpus.json and
 * the public TypeScript applications below, each pinned to a commit. Applications, not
 * libraries: what their package.json files declare is what app developers upgrade by hand.
 * Picked for size and variety (Next.js, Vite, Nest and Express apps, Svelte and Vue front
 * ends, monorepos and single apps); pinned to their default branch on 2026-10-07.
 *
 * Only manifests are read: each repository is fetched shallow and blobless at its commit,
 * and only its package.json and pnpm-workspace.yaml files are checked out. Nothing in it
 * is installed or run. The manifests are cached in ~/.cache/uptide/queue-sample.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const SAMPLE: readonly (readonly [repo: string, commit: string])[] = [
  ['activepieces/activepieces', 'f69620859abdc8c691f46b680786f34328992f2e'],
  ['appsmithorg/appsmith', '552488b0f380c2383e8bfa1e69408c227b963b39'],
  ['Budibase/budibase', 'c425f1900aec4224ebc86efcaeb5d25570ef4634'],
  ['calcom/cal.com', '54343aa685ae8f33159d2f485ec4a57bad5c574a'],
  ['directus/directus', '4f77933bf9551cac6b289576078783e189b8f4e3'],
  ['dubinc/dub', '9fa1627d8b4e0058bd6c3ef317ca46efc88175e2'],
  ['elie222/inbox-zero', '8520d0c644d8a0075f238e8cd1a51d4e537315c4'],
  ['ever-co/ever-gauzy', 'f51ed869adc43b68005eedaa45293fe7640c2278'],
  ['excalidraw/excalidraw', '2559257bb2bcf7f6b8815d6796ba2fd65d8f2b98'],
  ['formbricks/formbricks', '364e64e14c3d77db48eed690896d03387235ff4c'],
  ['getsentry/sentry', '2e8a3ad83b5ee61ceed617fddb2a7aaef4b34176'],
  ['grafana/grafana', 'feb85d8d93992d3b0c61edf724abcc115ac92ed0'],
  ['hcengineering/platform', '5bb9b2fea616e8ce3c6d9c92adbfb1a83f918c14'],
  ['highlight/highlight', '79c3ea3a15faad5c05e8f664d53924dca2a2907e'],
  ['homarr-labs/homarr', 'b093382d40c2adfdd850f7e5de8bb51137f6c47b'],
  ['hoppscotch/hoppscotch', '63273f8e599e73f0fb38c0739314e8d46b6bc83d'],
  ['immich-app/immich', '7e7a1de3fdd3293cb0a63d8cceb67543a90b88f5'],
  ['Infisical/infisical', 'df3f6d3f4a26b0ae5bb2cf8c985b60231ec608cf'],
  ['jellyfin/jellyfin-web', '1e507c588f353482a00333f84e36ddb7c8fc8221'],
  ['jitsi/jitsi-meet', 'b576a7f6077da7fa04c6982c7253dab5024cf308'],
  ['karakeep-app/karakeep', '75aeaaa4eb71b1d3143d7bdc6b88c66fbcfb5fea'],
  ['langgenius/dify', '5a733bd5e7931fa07e7b51d3f83e5bfebbd1985a'],
  ['lobehub/lobe-chat', 'dc9cd24864e3f13d2be2c83db970462e167d9c4e'],
  ['logto-io/logto', 'c814034401b0e13a6f461e0b0835ad3bbb84c9c2'],
  ['lukevella/rallly', 'dbb3fc72ed111ed169091c33a822d7b0bf1f35a0'],
  ['makeplane/plane', '66c95bd3f3405b4ea1e61f981c4e5f0cfe015935'],
  ['mattermost/mattermost', 'e8d7f37e923dc4d3582cdb83aefee751eab7bdba'],
  ['medusajs/medusa', 'bf69d091b2dc3f86655e3067533c953f2138e258'],
  ['mfts/papermark', 'ed19717ec02a1ac79aecf5569159aa9d2d869312'],
  ['midday-ai/midday', '51587319f26a0ffaa9dfccab1920373cb65689b7'],
  ['n8n-io/n8n', '9191cf3fb07ce6bbb7b2217592ce56372b52f6c2'],
  ['nextjs/saas-starter', '6e33e58b1e553a41fe22e6b941a7229a002de361'],
  ['nocodb/nocodb', '233b625ec200dc0bee00e15866227f29a75fe5b0'],
  ['novuhq/novu', '48e23384aef75395362f525f9c4aad9816ff3e59'],
  ['open-webui/open-webui', '8bd8b4fac5e059578ac0c74b3c18d11139f88b7d'],
  ['openstatusHQ/openstatus', 'da7aaeee3f5fc0f60e599d892b28a4856bcbf433'],
  ['outline/outline', '6e6eaf6b696cf3d71c586a4ee665e74ccd5b3228'],
  ['PostHog/posthog', 'ee764fd41ec5843a16c077812f2b0623c2f3aa03'],
  ['RocketChat/Rocket.Chat', 'e91411b589060a16acda3dd07823ace29154d063'],
  ['shadcn-ui/taxonomy', '298a8857c7128a0d121e7f699dfd729f23b3966d'],
  ['teableio/teable', '5ef2238883cad7c3980084de9a9031135fb9734f'],
  ['tldraw/tldraw', '035b741dc331bf76a4cb9af27c346be10bba2a88'],
  ['toeverything/AFFiNE', '2d4f191e679a1eb95f96fe12b95060deb35668ae'],
  ['triggerdotdev/trigger.dev', '3c7056abbd854e0c803fc7c3a95b094caee16b21'],
  ['twentyhq/twenty', 'f1c77a12cda5020e490223f042af1cee80f80c84'],
  ['umami-software/umami', 'ec0ff50388c264ed8ce46f00967e92f7e71476ae'],
  ['unkeyed/unkey', '39343cc0988e04d50ef53f8042a35fd4e2324b40'],
  ['usememos/memos', 'b1fa9aefcc22fde5774b7f6cf0b3e19fc67acc6e'],
  ['vercel/chatbot', 'c2f8235e1f3ea903ad8b7f61447c4f74164b5c58'],
  ['vercel/commerce', '3761e52e60df9c6a316e067dbfd7032e494d3634'],
];

/**
 * Manifests that describe something other than the application: examples, templates,
 * fixtures and test projects (a framework's own repository carries dozens), and anything
 * vendored.
 */
const SKIP =
  /(?:^|\/)(?:node_modules|examples?|templates?|fixtures?|__fixtures__|__mocks__|tests?|__tests__|testing|e2e|sandbox|playground|demos?|vendor|third[_-]party)\//;

/** A repository's manifests at its commit: path → text. */
export type Manifests = Record<string, string>;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 30,
  });

/** package.json and pnpm-workspace.yaml files of `repo` at `commit`, fetched once and cached. */
export function manifestsOf(repo: string, commit: string): Manifests {
  const cache = join(homedir(), '.cache', 'uptide', 'queue-sample');
  const file = join(cache, `${repo.replace('/', '__')}@${commit}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Manifests;
  const dir = mkdtempSync(join(tmpdir(), 'uptide-queue-'));
  try {
    git(dir, 'init', '--quiet');
    git(
      dir,
      'fetch',
      '--quiet',
      '--depth=1',
      '--filter=blob:none',
      `https://github.com/${repo}.git`,
      commit,
    );
    const paths = git(dir, 'ls-tree', '-r', '--name-only', 'FETCH_HEAD')
      .split('\n')
      .filter((p) => /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml)$/.test(p) && !SKIP.test(p));
    // One batched checkout fetches every blob it needs in one request per chunk.
    for (let i = 0; i < paths.length; i += 200)
      git(dir, 'checkout', 'FETCH_HEAD', '--', ...paths.slice(i, i + 200));
    const manifests: Manifests = {};
    for (const path of paths) manifests[path] = readFileSync(join(dir, path), 'utf8');
    mkdirSync(cache, { recursive: true });
    writeFileSync(file, JSON.stringify(manifests));
    return manifests;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The major a declared range starts at (`^18.2.0` → 18, `~5` → 5), when it names one. */
export function majorOf(range: string): number | undefined {
  const m = /^\s*(?:[\^~=v]|>=?)?\s*v?(\d+)(?:[.\s]|$)/.exec(range);
  return m ? Number(m[1]) : undefined;
}

/**
 * Every npm package a repository's manifests declare directly (dependencies,
 * devDependencies, optionalDependencies), with the majors they declare. `npm:` aliases count
 * as the package they alias, `catalog:` entries as the version their pnpm catalog names;
 * workspace, file, link and git specifiers are the repository's own code.
 */
export function declaredIn(manifests: Manifests): Map<string, Set<number>> {
  const catalogs = new Map<string, Record<string, string>>();
  for (const [path, text] of Object.entries(manifests))
    if (path.endsWith('pnpm-workspace.yaml'))
      for (const [name, entries] of catalogsOf(text)) catalogs.set(name, entries);
  const declared = new Map<string, Set<number>>();
  for (const [path, text] of Object.entries(manifests)) {
    if (!path.endsWith('package.json')) continue;
    let json: Record<string, Record<string, string> | undefined>;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'])
      for (const [key, raw] of Object.entries(json[section] ?? {})) {
        if (typeof raw !== 'string') continue;
        let name = key;
        let range = raw.trim();
        if (/^(?:workspace|file|link|portal|git|git\+|github|https?):/.test(range)) continue;
        if (range.includes('/') && !range.startsWith('npm:') && !range.startsWith('catalog:'))
          continue;
        const alias = /^npm:((?:@[^/@]+\/)?[^@]+)@?(.*)$/.exec(range);
        if (alias) [name, range] = [alias[1] as string, alias[2] ?? ''];
        if (range.startsWith('catalog:'))
          range = catalogs.get(range.slice('catalog:'.length) || 'default')?.[name] ?? '';
        const majors = declared.get(name) ?? new Set<number>();
        const major = majorOf(range);
        if (major !== undefined) majors.add(major);
        declared.set(name, majors);
      }
  }
  return declared;
}

const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * The catalogs of a pnpm-workspace.yaml: `catalog:` is `default`, each key of `catalogs:` its
 * own. They are flat maps of package to range, all this needs, so a line reader does.
 */
export function catalogsOf(text: string): Map<string, Record<string, string>> {
  const catalogs = new Map<string, Record<string, string>>();
  let section: 'catalog' | 'catalogs' | undefined;
  let current: Record<string, string> | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const [key = '', ...rest] = line.trim().split(':');
    const value = rest
      .join(':')
      .replace(/\s+#.*$/, '')
      .trim();
    if (indent === 0) {
      section = key === 'catalog' ? 'catalog' : key === 'catalogs' ? 'catalogs' : undefined;
      current = section === 'catalog' ? {} : undefined;
      if (current) catalogs.set('default', current);
      continue;
    }
    if (section === 'catalogs' && !value) {
      current = {};
      catalogs.set(unquote(key), current);
    } else if (current && value) current[unquote(key)] = unquote(value);
  }
  return catalogs;
}
