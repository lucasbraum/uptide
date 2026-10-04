import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDependencies } from '@uptide/core';
import { expect, it, vi } from 'vitest';
import { run } from './cli.js';
import { formatList } from './format-list.js';
import { textWidth } from './terminal.js';
import { fakeEngine, memoryIo, tempRepo } from './test-utils.js';

const root = fileURLToPath(
  new URL('../../../fixtures/repos/nest-discovery/', import.meta.url),
).replace(/\/$/, '');
const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));
const discover = () =>
  listDependencies({
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

it.each([false, true])('Nest terminal design, TTY=%s', async (tty) => {
  const report = await discover();
  const io = memoryIo({ cwd: root, outTty: tty, errTty: tty, columns: 120, now: () => 137 });
  await run(['list'], io, fakeEngine({ list: async () => report }));
  expect(io.stdout()).toMatchSnapshot();
  expect(io.stdout().includes(String.fromCharCode(27))).toBe(tty);
  expect(io.stdout()).not.toContain('symbols');
  expect(io.stdout()).toContain('peer of @nestjs/platform-fastify');
});
it.each([40, 80, 100])('fits %s columns without wrapping names', async (width) => {
  const text = formatList(await discover(), { width, details: true, color: true });
  expect(text.split('\n').every((line) => textWidth(line) <= width)).toBe(true);
  if (width <= 80) expect(text).toContain('…');
});
it.each([
  { tty: true, env: { NO_COLOR: '1' } },
  { tty: false, env: { FORCE_COLOR: '1' } },
])('keeps plain output for NO_COLOR and pipes (%j)', async ({ tty, env }) => {
  const io = memoryIo({ cwd: root, outTty: tty, env });
  await run(['list'], io, fakeEngine({ list: discover }));
  expect(io.stdout() + io.stderr()).not.toContain(String.fromCharCode(27));
});
it('expands --group to full members, including peers, before validating targets and checking', async () => {
  const report = await discover();
  const group = report.groups.find((g) => g.id === 'nestjs');
  if (!group) throw new Error('missing group');
  const engine = fakeEngine({ list: async () => report });
  const check = vi.spyOn(engine, 'check');
  // Installed-package preflight uses engine metadata; the fake reports the fixture dependencies.
  engine.installed = async () => new Map(report.packages.map((p) => [p.name, p.current]));
  engine.declared = engine.installed;
  const cwd = tempRepo({
    'package.json': readFileSync(join(root, 'package.json'), 'utf8'),
    'pnpm-lock.yaml': readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'),
    ...Object.fromEntries(
      group.members.map((p) => [
        `node_modules/${p.name}/package.json`,
        JSON.stringify({ name: p.name, version: p.current }),
      ]),
    ),
  });
  const io = memoryIo({ cwd });
  const code = await run(
    ['check', '--group', 'nestjs', '--json', '--target', '@nestjs/common@12.0.0'],
    io,
    engine,
  );
  rmSync(cwd, { recursive: true, force: true });
  expect(code, io.stderr()).toBe(0);
  expect(check).toHaveBeenCalledWith(
    expect.objectContaining({
      only: group.members.map((p) => p.name),
      targets: { '@nestjs/common': '12.0.0' },
    }),
    expect.any(Function),
  );
});
it('rejects unknown or incomplete groups without analysis', async () => {
  const report = await discover();
  const check = vi.fn();
  const io = memoryIo({ cwd: root });
  expect(
    await run(['check', '--group', 'missing'], io, fakeEngine({ list: async () => report, check })),
  ).toBe(2);
  expect(io.stderr()).toContain('unknown group');
  report.failures.push({ name: 'peer', reason: 'offline' });
  expect(
    await run(['check', '--group', 'nestjs'], io, fakeEngine({ list: async () => report, check })),
  ).toBe(2);
  expect(check).not.toHaveBeenCalled();
});
