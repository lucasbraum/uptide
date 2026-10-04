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
  expect(html).toContain('<h2>@nestjs/cli</h2>');
  expect(html).toContain('<span>→ 12.x</span>');
  expect(html).not.toContain('package-command');
  expect(html).toContain(
    'title="uptide check cookie-plugin" aria-label="uptide check cookie-plugin"',
  );
  const standalone =
    html.match(/<article class="member-grid has-command">[\s\S]*?<\/article>/g) ?? [];
  expect(standalone.length).toBe(
    report.packages.length - report.groups.reduce((n, g) => n + g.members.length, 0),
  );
  expect(
    standalone.every(
      (row) => row.includes('class="copy copy-icon"') && !row.includes('class="term command"'),
    ),
  ).toBe(true);
  expect(html).toContain(`Uptide CLI ${VERSION}`);
  expect(html.indexOf('<h2>@nestjs/*</h2>')).toBeLessThan(html.indexOf('02 / Packages'));
  expect(html.match(/class="pkg-name">@nestjs\/common</g)).toHaveLength(1);
  expect(html).toContain('10.4.0 → 12.0.0</div><div class="gap">major ×2');
  expect(html).toContain('1 file · 1 reference');
  expect(html).toContain('peer of @nestjs/platform-fastify');
  expect(html).not.toContain('referenced ·');
  expect(html).not.toContain('Top symbols:');
  expect(html).toContain('<code>uptide check --group nestjs</code>');
  expect(html).toMatch(/<details class="notes"><summary>03 \/ Tooling/);
  expect(html).toMatch(/<details class="notes"><summary>04 \/ Possibly unused/);
  expect(html.match(/<code>uptide check --group nestjs<\/code>/g)).toHaveLength(1);
  expect(html.match(/data-copy hidden/g)?.length).toBe(
    report.packages.length - report.groups.reduce((n, g) => n + g.members.length - 1, 0),
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
