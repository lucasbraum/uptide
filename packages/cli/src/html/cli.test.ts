import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { run, VERSION } from '../cli.js';
import { checkResult, fakeEngine, memoryIo, npmRepo } from '../test-utils.js';
import { browserCommand, openHtml } from './write.js';

vi.mock('./write.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./write.js')>()),
  openHtml: vi.fn(async () => {}),
}));
const roots: string[] = [];
const files: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const file of files.splice(0)) rmSync(file, { force: true });
  vi.clearAllMocks();
});
it('writes to the OS temp directory, retains terminal output and never opens in a pipe', async () => {
  const root = npmRepo();
  roots.push(root);
  const before = readdirSync(root);
  const io = memoryIo({ cwd: root });
  expect(
    await run(['check', '--html', '--open'], io, fakeEngine({ check: async () => checkResult() })),
  ).toBe(0);
  const path = io.stderr().match(/HTML report: (.*)\n/)?.[1];
  expect(path).toBeTruthy();
  assert(path);
  files.push(path);
  expect(path.startsWith(join(tmpdir(), 'uptide'))).toBe(true);
  const html = readFileSync(path, 'utf8');
  expect(html).toContain('<!doctype html>');
  const cliVersion = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ).version;
  expect(VERSION).toBe(cliVersion);
  expect(html).toContain(`Uptide CLI ${cliVersion}`);
  expect(html).toContain('npx uptide');
  expect(html).not.toContain('--cwd');
  expect(readdirSync(root)).toEqual(before);
  expect(io.stdout()).toContain('Next');
  expect(openHtml).not.toHaveBeenCalled();
});
it.each([
  { ci: true, tty: true },
  { ci: false, tty: false },
  { ci: false, tty: true },
])('opens only when interactive (%j)', async ({ ci, tty }) => {
  const root = npmRepo();
  roots.push(root);
  const path = join(root, 'report.html');
  const io = memoryIo({ cwd: root, outTty: tty, errTty: tty });
  await run(['check', '--html', path, '--open', ...(ci ? ['--ci'] : [])], io, fakeEngine());
  expect(existsSync(path)).toBe(true);
  expect(openHtml).toHaveBeenCalledTimes(!ci && tty ? 1 : 0);
});
it('keeps JSON stdout pure and preserves breaking exit status', async () => {
  const root = npmRepo();
  roots.push(root);
  const io = memoryIo({ cwd: root });
  expect(
    await run(
      ['check', '--json', '--html', 'report.html'],
      io,
      fakeEngine({ check: async () => checkResult({ breaking: 2 }) }),
    ),
  ).toBe(1);
  expect(JSON.parse(io.stdout()).summary.breaking).toBe(2);
  expect(io.stderr()).toContain('HTML report:');
});
it('writes a clean HTML report when the repo declares no supported dependency', async () => {
  const root = npmRepo();
  roots.push(root);
  const io = memoryIo({ cwd: root });
  await run(
    ['check', '--html', 'report.html'],
    io,
    fakeEngine({ declared: async () => new Map() }),
  );
  expect(readFileSync(join(root, 'report.html'), 'utf8')).toContain('Nothing to upgrade');
  expect(io.stderr().trim().split('\n').at(-1)).toContain('HTML report:');
});
it('requires --html for --open and reports write failures', async () => {
  const root = npmRepo();
  roots.push(root);
  const io = memoryIo({ cwd: root });
  expect(await run(['check', '--open'], io, fakeEngine())).toBe(2);
  expect(io.stderr()).toContain('--open requires --html');
  expect(await run(['check', '--html', root], io, fakeEngine())).toBe(2);
});
it('opens a literal path with platform-specific commands without shell interpolation', () => {
  expect(browserCommand('/tmp/a b.html', 'darwin')).toEqual(['open', ['/tmp/a b.html']]);
  expect(browserCommand('/tmp/a b.html', 'linux')).toEqual(['xdg-open', ['/tmp/a b.html']]);
  expect(browserCommand('C:\\a b.html', 'win32')[1]).toEqual([
    '/d',
    '/s',
    '/c',
    'start',
    '""',
    '"C:\\a b.html"',
  ]);
  expect(() => browserCommand('C:\\%BAD%&x.html', 'win32')).toThrow('manually');
});
