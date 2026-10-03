import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { git } from './process.js';
import { fix } from './run.js';
import { isServiceTest, serviceNeeds, unitConfig } from './services.js';
import { describeServices, planTests, testWorkspaces } from './verify.js';

const scratch = mkdtempSync(join(tmpdir(), 'uptide-services-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A monorepo with one root vitest config whose global setup resets a test database. */
function repo(runner: 'vitest' | 'jest' = 'vitest', config = `${runner}.config.ts`) {
  const root = mkdtempSync(join(scratch, 'repo-'));
  const write = (file: string, text: string, mode?: number) => {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text, mode ? { mode } : {});
  };
  write('package.json', JSON.stringify({ name: 'mono' }));
  write(config, 'export default { test: { globalSetup: ["./test/global-setup.ts"] } };');
  write(
    'test/global-setup.ts',
    [
      'import pg from "pg";',
      'const url = process.env.DATABASE_URL_TEST ?? "postgresql://app:secret@localhost:5432/app_test";',
      'export async function setup() { await new pg.Pool({ connectionString: url }).query("DROP SCHEMA public CASCADE"); }',
    ].join('\n'),
  );
  // A stand-in runner that records what it was asked and which config file existed at the time.
  write(
    `node_modules/.bin/${runner}`,
    '#!/bin/sh\necho "ARGS $*"\nls vitest.uptide-unit.config.mjs 2>/dev/null\necho "      Tests  4 passed (4)"\n',
    0o755,
  );
  write('packages/api/package.json', JSON.stringify({ name: 'api' }));
  write('packages/api/src/billing.ts', 'export const a = 1;');
  write('packages/api/src/billing.test.ts', '');
  write('packages/api/src/billing.integration.test.ts', '');
  write('packages/api/src/routes.e2e.test.ts', '');
  write('packages/api/e2e/flow.test.ts', '');
  return root;
}
const files = ['packages/api/src/billing.ts'];

describe('classifying tests without running them', () => {
  it('tells integration and end-to-end files from unit tests by name', () => {
    for (const file of [
      'src/a.integration.test.ts',
      'src/a.e2e.test.ts',
      'src/a.int.test.tsx',
      'src/a.e2e.spec.js',
      'packages/api/e2e/flow.test.ts',
      'integration/db.spec.ts',
    ])
      expect(isServiceTest(file), file).toBe(true);
    for (const file of ['src/a.test.ts', 'src/integration.ts', 'src/e2eHelpers.test.ts'])
      expect(isServiceTest(file), file).toBe(false);
  });

  it('reads the services and targets from the global setup, with credentials masked', () => {
    const root = repo();
    const needs = serviceNeeds(root, root, 'vitest.config.ts', ['packages/api'], {});
    expect(needs).toEqual({
      files: [
        'packages/api/e2e/flow.test.ts',
        'packages/api/src/billing.integration.test.ts',
        'packages/api/src/routes.e2e.test.ts',
      ],
      services: ['Postgres'],
      targets: ['DATABASE_URL_TEST (not set)', 'postgresql://***@localhost:5432/app_test'],
      setups: ['./test/global-setup.ts'],
    });
    const set = serviceNeeds(root, root, 'vitest.config.ts', ['packages/api'], {
      DATABASE_URL_TEST: 'postgresql://me:pw@db.internal:5432/real',
    });
    expect(set.targets).toContain('DATABASE_URL_TEST=postgresql://***@db.internal:5432/real');
    expect(JSON.stringify(set)).not.toContain('pw');
  });

  it('writes a unit-only configuration that drops the global setup only when it reaches a service', () => {
    const strict = unitConfig('vitest.config.ts', true);
    expect(strict).toContain("import base from './vitest.config.ts';");
    expect(strict).toContain('const { globalSetup, ...rest } = test;');
    expect(strict).toContain('"**/*.integration.test.*"');
    expect(unitConfig('vitest.config.ts', false)).toContain('const { ...rest } = test;');
  });
});

describe('tests that need services are opt-in', () => {
  it('runs only unit tests by default, through a configuration without the global setup', async () => {
    const root = repo();
    const [plan] = planTests(
      root,
      ['packages/api'],
      [...files, 'packages/api/src/routes.e2e.test.ts'],
    );
    // The affected e2e file is not handed to the runner either.
    expect(plan?.command).toBe(
      'vitest related --run --passWithNoTests --config vitest.uptide-unit.config.mjs packages/api/src/billing.ts',
    );
    expect(plan?.scope).toBe('vitest unit tests related to 1 affected file, vitest.config.ts');
    expect(plan?.notRun).toEqual({ files: 3, needs: ['Postgres'] });
    const [result] = await testWorkspaces(root, ['packages/api'], 10_000, files);
    expect(result).toMatchObject({
      status: 'passed',
      summary: '4 tests',
      notRun: { files: 3, needs: ['Postgres'] },
    });
    // The configuration existed while the runner ran, and is gone afterwards.
    expect(result?.output).toContain('vitest.uptide-unit.config.mjs');
    expect(() => git(root, 'init')).not.toThrow();
    expect(git(root, 'status', '--porcelain', '--', 'vitest.uptide-unit.config.mjs')).toBe('');
  });

  it('runs everything with the real configuration only when asked, and records what it reached', async () => {
    const root = repo();
    const [plan] = planTests(root, ['packages/api'], files, { withServices: true });
    expect(plan?.command).toBe(
      'vitest related --run --passWithNoTests packages/api/src/billing.ts',
    );
    expect(plan?.write).toBeUndefined();
    expect(plan?.notRun).toBeUndefined();
    const [result] = await testWorkspaces(root, ['packages/api'], 10_000, files, {
      withServices: true,
    });
    expect(result?.services?.names).toEqual(['Postgres']);
    expect(result?.services?.targets).toContain('postgresql://***@localhost:5432/app_test');
    expect(result?.output).not.toContain('vitest.uptide-unit.config.mjs');
  });

  it('runs nothing when the setup cannot be taken out, and says how to include it', async () => {
    // jest has no way to drop a global setup from outside; neither has a vitest workspace file.
    for (const [runner, config] of [
      ['jest', 'jest.config.ts'],
      ['vitest', 'vitest.workspace.ts'],
    ] as const) {
      const root = repo(runner, config);
      const [result] = await testWorkspaces(root, ['packages/api'], 10_000, files);
      expect(result?.status).toBe('missing');
      expect(result?.command).toBeUndefined();
      expect(result?.scope).toBe(
        `not run: the ${runner} setup in ${config} connects to Postgres; pass --with-services to include it`,
      );
      expect(result?.notRun).toEqual({ files: 3, needs: ['Postgres'] });
    }
  });

  it('leaves a repository without service tests exactly as before', () => {
    const root = repo();
    writeFileSync(join(root, 'vitest.config.ts'), 'export default {};');
    for (const file of [
      'src/billing.integration.test.ts',
      'src/routes.e2e.test.ts',
      'e2e/flow.test.ts',
    ])
      rmSync(join(root, 'packages/api', file));
    const [plan] = planTests(root, ['packages/api'], files);
    expect(plan?.command).toBe(
      'vitest related --run --passWithNoTests packages/api/src/billing.ts',
    );
    expect(plan?.notRun).toBeUndefined();
    expect(describeServices(root, ['packages/api'])).toEqual([]);
  });

  it('names the services and targets and refuses --with-services without --yes', async () => {
    const root = repo();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    git(root, 'init');
    git(root, 'config', 'user.email', 'test@example.test');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'baseline');
    let checked = false;
    const services = {
      check: async () => {
        checked = true;
        throw new Error('should not get this far');
      },
      install: async () => {},
      diagnostics: () => [],
      tests: async () => [],
    };
    await expect(fix({ cwd: root, only: 'zod', withServices: true }, services)).rejects.toThrow(
      /--with-services would run tests against:\n {2}Postgres: 3 integration or end-to-end test files, global setup \.\/test\/global-setup\.ts runs against it and may reset data\n {4}DATABASE_URL_TEST[^\n]*\n {4}postgresql:\/\/\*\*\*@localhost:5432\/app_test\nNothing ran\. Add --yes to confirm/,
    );
    expect(checked).toBe(false);
    // With --yes the confirmation is given and the run goes on to its next precondition.
    await expect(
      fix({ cwd: root, only: 'zod', withServices: true, yes: true }, services),
    ).rejects.toThrow(/no supported lockfile found/);
  });
});
