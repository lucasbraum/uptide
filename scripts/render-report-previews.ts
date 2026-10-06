/** Reproduce the PR's offline report fixtures: pnpm exec tsx scripts/render-report-previews.ts <output-dir> */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type CheckReport, listDependencies } from '@uptide/core';
import { formatList } from '../packages/cli/src/format-list.js';
import { renderListHtml } from '../packages/cli/src/html/list.js';
import { renderHtml } from '../packages/cli/src/html/render.js';
import { VERSION } from '../packages/cli/src/version.js';

const output = resolve(process.argv[2] ?? '/tmp/uptide-report-preview');
mkdirSync(output, { recursive: true });
const root = resolve('fixtures/repos/nest-discovery');
const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));
const list = await listDependencies({
  cwd: root,
  fetcher: {
    resolve: async (name) => registry[name].latest,
    metadata: async (name, version) => ({
      ...registry[name],
      peerDependencies:
        version === registry[name].latest
          ? (registry[name].targetPeerDependencies ?? registry[name].peerDependencies)
          : registry[name].peerDependencies,
    }),
  },
});
const common = { version: VERSION, date: '2026-10-04T19:00:00Z', timeZone: 'America/Los_Angeles' };
writeFileSync(
  join(output, 'list.html'),
  renderListHtml(list, {
    ...common,
    header: { repo: 'synthetic-nest-api', manager: 'pnpm', packages: 0, ms: 137 },
  }),
);
const check = JSON.parse(
  readFileSync('packages/cli/src/__fixtures__/storefront-check.json', 'utf8'),
) as CheckReport;
writeFileSync(
  join(output, 'check.html'),
  renderHtml(check, {
    ...common,
    root: resolve('fixtures/repos/storefront'),
    header: { repo: 'storefront', manager: 'pnpm', packages: 2, ms: 25000 },
    fixable: ['zod', 'stripe'],
  }),
);
// PRIORITIES: a synthetic app of public packages, with recorded registry and advisory data.
const prioritiesRoot = resolve('fixtures/repos/list-accuracy/priorities');
const recorded = (file: string) => JSON.parse(readFileSync(join(prioritiesRoot, file), 'utf8'));
const versions = recorded('registry.json');
const advisories = recorded('advisories.json');
const priorities = await listDependencies({
  cwd: prioritiesRoot,
  now: new Date('2026-10-04T19:00:00Z'),
  fetcher: {
    resolve: async (name) => versions[name].latest,
    metadata: async () => ({ peerDependencies: {} }),
    deprecation: async (name, version) => versions[name].versions[version]?.deprecated,
    versions: async (name) => Object.keys(versions[name].versions),
    advisories: async (query) => ({ checked: [...query.keys()], advisories }),
  },
});
const header = { repo: 'synthetic-priorities', manager: 'npm', packages: 0, ms: 412 };
writeFileSync(join(output, 'list-priorities.html'), renderListHtml(priorities, { ...common, header }));
writeFileSync(
  join(output, 'list-priorities.txt'),
  formatList(priorities, { width: 120, header: { ...header, ms: 412 } }),
);
console.log(`Rendered list, list-priorities and check in ${output}`);
