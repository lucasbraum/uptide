import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDependencies } from '@uptide/core';
import { afterEach, expect, it, vi } from 'vitest';
import { run, VERSION } from '../cli.js';
import { fakeEngine, memoryIo } from '../test-utils.js';
import { css, js } from './assets.js';
import { renderListHtml } from './list.js';
import { openHtml } from './write.js';

vi.mock('./write.js', async (original) => ({
  ...(await original<typeof import('./write.js')>()),
  openHtml: vi.fn(async () => {}),
}));
const root = fileURLToPath(new URL('../../../../fixtures/repos/nest-discovery/', import.meta.url));
const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8')) as Record<
  string,
  {
    latest: string;
    peerDependencies?: Record<string, string>;
    targetPeerDependencies?: Record<string, string>;
    bin?: Record<string, string>;
  }
>;
const discover = (details = false) =>
  listDependencies({
    cwd: root,
    details,
    fetcher: {
      resolve: async (name) => registry[name]?.latest ?? '1.0.0',
      metadata: async (name, version) => {
        const m = registry[name];
        return {
          ...m,
          peerDependencies:
            version === m?.latest
              ? (m.targetPeerDependencies ?? m.peerDependencies)
              : m?.peerDependencies,
        };
      },
    },
  });
const options = {
  version: VERSION,
  date: '2026-10-04T12:00:00Z',
  timeZone: 'America/Los_Angeles',
  header: { repo: 'synthetic-nest-api', manager: 'pnpm', packages: 0, ms: 1 },
};
const files: string[] = [];
afterEach(() => {
  for (const file of files.splice(0)) rmSync(file, { force: true });
  vi.clearAllMocks();
});

it('renders the Nest report with shared check styling, groups first, copy commands and private defaults', async () => {
  const report = await discover(true);
  const html = renderListHtml(JSON.parse(JSON.stringify(report)), {
    ...options,
    cwd: '/private/project',
  });
  expect(html).toContain(css);
  expect(html).toContain(`<script>${js}</script>`);
  expect(html).toContain(`script-src 'sha256-${createHash('sha256').update(js).digest('base64')}'`);
  expect(html).toContain('pnpm');
  expect(html).toContain('<strong>32</strong><span class="label">Major</span>');
  expect(html).toContain('Generated Oct 4, 2026');
  expect(html).toContain('<strong>1</strong><span class="label">Groups</span>');
  expect(html.match(/<h2>@nestjs\/\*<\/h2>/g)).toHaveLength(1);
  // The CLI is part of the @nestjs family, which says why it is a group.
  expect(html).not.toContain('<h2>@nestjs/cli</h2>');
  expect(html).toContain('<span>@nestjs family, peer link</span>');
  expect(html).toContain('<span>→ 12.x</span>');
  expect(html).not.toContain('package-command');
  expect(html).toContain(
    'title="npx uptide check cookie-plugin" aria-label="npx uptide check cookie-plugin"',
  );
  const standalone =
    html.match(/<article class="member-grid has-command"[^>]*>[\s\S]*?<\/article>/g) ?? [];
  expect(standalone.length).toBe(
    report.packages.length - report.groups.reduce((n, g) => n + g.members.length, 0),
  );
  expect(
    standalone.every(
      (row) => row.includes('class="copy copy-icon"') && !row.includes('class="term command"'),
    ),
  ).toBe(true);
  expect(html).toContain(`Uptide CLI ${VERSION}`);
  // Priorities (01), then Groups (02), then Packages (03).
  expect(html.indexOf('01 / Priorities')).toBeLessThan(html.indexOf('<h2>@nestjs/*</h2>'));
  expect(html.indexOf('<h2>@nestjs/*</h2>')).toBeLessThan(html.indexOf('03 / Packages'));
  expect(html.match(/class="pkg-name">@nestjs\/common</g)).toHaveLength(1);
  expect(html).toContain('10.4.0 → 12.0.0</div><div class="gap">major ×2');
  expect(html).toContain('1 file · 1 reference');
  expect(html).toContain('peer of @nestjs/platform-fastify');
  expect(html).not.toContain('referenced ·');
  expect(html).not.toContain('Top symbols:');
  expect(html).toContain('<code>npx uptide check --group nestjs</code>');
  expect(html).toMatch(/<details class="notes" data-block><summary>04 \/ Tooling/);
  expect(html).toMatch(/<details class="notes" data-block><summary>05 \/ Possibly unused/);
  // Once as the top priority, once on the group itself.
  expect(html.match(/<code>npx uptide check --group nestjs<\/code>/g)).toHaveLength(2);
  expect(html.match(/data-copy hidden/g)?.length).toBe(
    report.packages.length -
      report.groups.reduce((n, g) => n + g.members.length - 1, 0) +
      (report.priorities?.length ?? 0),
  );
  expect(html).not.toContain('consider removing');
  expect(html).not.toContain('UnusedDecorator');
  expect(html).not.toContain('src/main.ts');
  expect(html).not.toContain(root);
  expect(html).not.toContain('/private/project');
  expect(html).not.toContain('app.register');
  const details = renderListHtml(report, { ...options, details: true });
  expect(details).toContain('<li>src/main.ts</li>');
  expect(details).not.toContain('app.register');
});

it('escapes repository data and hides paths in failures unless details are requested', async () => {
  const report = await discover();
  const attack = '</script><img src=x onerror=alert(1)>';
  const first = report.packages[0];
  if (!first) throw new Error('missing fixture');
  first.name = attack;
  report.failures.push({ name: 'missing', reason: 'ENOENT /private/repo/path/package.json' });
  const html = renderListHtml(report, { ...options, header: { ...options.header, repo: attack } });
  expect(html).not.toContain(attack);
  expect(html).toContain('&lt;/script&gt;&lt;img');
  expect(html).not.toContain('/private/repo/path');
  expect(html.match(/<script>/g)).toHaveLength(1);
  expect(html).toContain("connect-src 'none'");
  expect(renderListHtml(report, { ...options, details: true })).toContain('/private/repo/path');
});

it.each([
  { tty: false, ci: false },
  { tty: true, ci: true },
  { tty: true, ci: false },
])(
  'writes beside check reports, keeps JSON pure and honors open behavior (%j)',
  async ({ tty, ci }) => {
    const list = vi.fn(async ({ details }: { details?: boolean }) => discover(details));
    const io = memoryIo({ cwd: root, outTty: tty, errTty: tty });
    const code = await run(
      ['list', '--json', '--html', '--open', '--details', ...(ci ? ['--ci'] : [])],
      io,
      fakeEngine({ list }),
    );
    expect(code).toBe(0);
    expect(list).toHaveBeenCalledWith({ cwd: root.replace(/\/$/, ''), details: true });
    expect(JSON.parse(io.stdout()).packages.length).toBe(32);
    const path = io.stderr().match(/HTML report: (.*)\n/)?.[1];
    expect(path).toBeTruthy();
    if (!path) throw new Error('no report');
    files.push(path);
    expect(path.startsWith(join(tmpdir(), 'uptide'))).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('<li>src/main.ts</li>');
    expect(openHtml).toHaveBeenCalledTimes(tty && !ci ? 1 : 0);
  },
);

it('does not write without --html, rejects --open alone and preserves partial-discovery exit status', async () => {
  const list = vi.fn(async () => discover());
  const io = memoryIo({ cwd: root });
  expect(await run(['list'], io, fakeEngine({ list }))).toBe(0);
  expect(io.stderr()).not.toContain('HTML report:');
  expect(await run(['list', '--open'], io, fakeEngine({ list }))).toBe(2);
  expect(list).toHaveBeenCalledTimes(1);
  const partial = await discover();
  partial.failures.push({ name: 'missing', reason: 'offline' });
  const partialIo = memoryIo({ cwd: root });
  expect(await run(['list', '--html'], partialIo, fakeEngine({ list: async () => partial }))).toBe(
    2,
  );
  const path = partialIo.stderr().match(/HTML report: (.*)\n/)?.[1];
  if (!path) throw new Error('no partial report');
  files.push(path);
  expect(readFileSync(path, 'utf8')).toContain('Incomplete discovery');
  expect(await run(['list', '--html', root], io, fakeEngine({ list }))).toBe(2);
});

it('gives every tile the count of rows its filter shows, and every package exactly one row', async () => {
  const report = await discover();
  // Give every filter something to count: a verified pack, a patch release and a priority.
  const [first, second] = report.packages.filter((p) => p.classification === 'tooling');
  if (!first || !second) throw new Error('fixture needs two tooling packages');
  first.tier = 'verified';
  second.change = 'patch';
  report.priorities = [
    {
      name: 'nestjs',
      group: 'nestjs',
      packages: ['@nestjs/common', second.name],
      signal: 'deprecated',
      urgency: 4,
      effort: 1,
      reason: 'deprecated: use v12',
    },
  ];
  const html = renderListHtml(report, { version: VERSION, date: '2026-10-06T00:00:00Z' });
  const rows = [...html.matchAll(/<article class="member-grid[^"]*"([^>]*)>/g)].map(
    (m) => m[1] ?? '',
  );
  expect(rows).toHaveLength(report.packages.length);
  const tiles = new Map(
    [...html.matchAll(/data-filter="(\w+)" aria-pressed="false"><strong>(\d+)<\/strong>/g)].map(
      (m) => [m[1], Number(m[2])],
    ),
  );
  const shown: Record<string, (attrs: string) => boolean> = {
    all: () => true,
    major: (a) => a.includes('data-change="major"'),
    minor: (a) => a.includes('data-change="minor"'),
    patch: (a) => a.includes('data-change="patch"'),
    tooling: (a) => a.includes('data-section="tooling"'),
    unused: (a) => a.includes('data-section="unused"'),
    priority: (a) => a.includes('data-priority'),
    verified: (a) => a.includes('data-verified'),
  };
  expect([...tiles.keys()].sort()).toEqual([...Object.keys(shown), 'groups'].sort());
  for (const [filter, test] of Object.entries(shown))
    expect([filter, rows.filter(test).length]).toEqual([filter, tiles.get(filter)]);
  // Groups counts groups: the sections its filter shows.
  expect(html.match(/<section class="package" data-group>/g)?.length).toBe(tiles.get('groups'));
  // Every major is a row somewhere, though PACKAGES lists only the used ungrouped ones.
  expect(tiles.get('major')).toBe(report.packages.filter((p) => p.change === 'major').length);
  expect(
    rows.filter((a) => a.includes('data-section="used"') && a.includes('"major"')).length,
  ).toBeLessThan(tiles.get('major') ?? 0);
  expect(html).toContain(
    '<li class="priority-row signal-deprecated"><div class="pkg-name">nestjs</div><div class="reason">deprecated: use v12</div>',
  );
  // Still one offline file: the only script is inline and pinned by the CSP hash.
  expect(html).not.toMatch(/<script[^>]+src=|https?:\/\/(?!www\.w3\.org)/);
});
