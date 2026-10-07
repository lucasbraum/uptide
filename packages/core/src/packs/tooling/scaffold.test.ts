import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import type { Pack, PackVerification } from '../contract.js';
import { testPack } from './pack-test.js';
import { parseRegistry, renderRegistry } from './registry-file.js';
import { scaffoldPack } from './scaffold.js';

const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
const packs = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'uptide-pack-new-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * A checkout in miniature: the generated pack imports `../contract.js` and
 * `../tooling/fixtures.js`, which forward to this tree's, and the checkout's biome and
 * vitest are reachable as they are for a contributor.
 */
function miniCheckout(): string {
  const home = join(root, 'packages', 'core', 'src', 'packs');
  mkdirSync(join(home, 'tooling'), { recursive: true });
  writeFileSync(join(home, 'registry.ts'), renderRegistry([]));
  writeFileSync(join(home, 'contract.ts'), `export * from '${join(packs, 'contract.ts')}';\n`);
  writeFileSync(
    join(home, 'tooling', 'fixtures.ts'),
    `export * from '${join(packs, 'tooling', 'fixtures.ts')}';\n`,
  );
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'));
  copyFileSync(join(repo, 'biome.json'), join(root, 'biome.json'));
  copyFileSync(join(repo, '.gitignore'), join(root, '.gitignore'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  return home;
}

it('pack new scaffolds a pack that lints, passes its own test and pack test; one added rule keeps it passing', async () => {
  const home = miniCheckout();
  const result = scaffoldPack({ root, package: 'toy-lib', from: '>=1 <2', to: '>=2 <3' });
  expect(result).toMatchObject({ dir: 'toy-lib', constant: 'toyLibPack', formatted: true });
  expect(parseRegistry(readFileSync(join(home, 'registry.ts'), 'utf8'))).toEqual([
    { dir: 'toy-lib', name: 'toyLibPack' },
  ]);
  expect(() => scaffoldPack({ root, package: 'toy-lib', from: '>=1 <2', to: '>=2 <3' })).toThrow(
    /already exists/,
  );

  // Lint: the checkout's biome accepts every generated file as it is.
  const biome = spawnSync(
    join(repo, 'node_modules', '.bin', 'biome'),
    ['check', '--no-errors-on-unmatched', 'packages'],
    { cwd: root, encoding: 'utf8' },
  );
  expect(biome.stdout + biome.stderr).toContain('No fixes applied');
  expect(biome.status).toBe(0);

  // Add one rule: a note the compiler cannot see, detected in the source, with its fixture.
  const index = join(home, 'toy-lib', 'index.ts');
  writeFileSync(
    index,
    readFileSync(index, 'utf8').replace(
      '  behavior: [],',
      `  behavior: [
    {
      id: 'retry-default',
      summary: 'connect() retries three times by default in 2.x; it never retried in 1.x',
      reported: ['finding'],
      detect: (text) =>
        text.split('\\n').flatMap((line, i) => {
          const at = line.indexOf('connect(');
          return at >= 0 && !line.includes('retries:')
            ? [{ line: i + 1, column: at + 1, snippet: line.trim() }]
            : [];
        }),
    },
  ],`,
    ),
  );
  mkdirSync(join(home, 'toy-lib', 'fixtures', 'retry-default'), { recursive: true });
  writeFileSync(
    join(home, 'toy-lib', 'fixtures', 'retry-default', 'before.ts'),
    [
      "import { connect } from 'toy-lib';",
      '',
      "export const a = connect('db'); // @uptide retry-default",
      "export const b = connect('db', { retries: 0 }); // @uptide retry-default keep",
      '',
    ].join('\n'),
  );

  const pack = ((await import(index)) as { toyLibPack: Pack }).toyLibPack;
  const verification = JSON.parse(
    readFileSync(join(home, 'toy-lib', 'verification.json'), 'utf8'),
  ) as PackVerification;
  const report = await testPack({ dir: 'toy-lib', pack, verification }, { root });
  expect(report.problems).toEqual([]);
  expect(report.fixtures.cases).toEqual(['example-rename', 'retry-default']);
  expect(report.fixtures.rules['retry-default']).toEqual({
    truePositives: 1,
    falsePositives: 0,
    falseNegatives: 0,
  });
  expect(report.fixtures.rewriteFailures).toEqual([]);
  expect(report).toMatchObject({ status: 'candidate', stale: false, passed: true });

  // The generated test, run by the checkout's vitest as `pnpm test` would.
  const vitest = spawnSync(
    join(repo, 'node_modules', '.bin', 'vitest'),
    ['run', '--root', join(root, 'packages', 'core'), 'src/packs/toy-lib'],
    { cwd: root, encoding: 'utf8' },
  );
  expect(vitest.stdout).toMatch(/1 passed/);
  expect(vitest.status).toBe(0);
}, 120_000);

it('a fixture marker naming no rule, or a rewrite that misses after.ts, fails pack test', async () => {
  const { zodPack } = await import('../zod/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'uptide-pack-fixture-'));
  try {
    mkdirSync(join(dir, 'fixtures', 'bad'), { recursive: true });
    writeFileSync(
      join(dir, 'fixtures', 'bad', 'before.ts'),
      "import { z } from 'zod';\nexport const s = z.string({ required_error: 'A' }); // @uptide error-params at:z.string\nexport const t = 1; // @uptide no-such-rule\n",
    );
    writeFileSync(join(dir, 'fixtures', 'bad', 'after.ts'), 'not what the rule writes\n');
    const { runFixtures } = await import('./fixtures.js');
    const result = runFixtures(zodPack, dir);
    expect(result.unknown).toEqual([
      { file: 'fixtures/bad/before.ts', line: 3, rule: 'no-such-rule' },
    ]);
    expect(result.rewriteFailures[0]?.message).toMatch(/differs from after\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
