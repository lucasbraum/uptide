import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type PackageReport, UptideError } from '@uptide/core';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { checkResult, fakeEngine, memoryIo, npmRepo, pnpmGitRepo, tempRepo } from './test-utils.js';

/** Run and return what a user sees: exit code and stderr. */
async function fail(
  argv: string[],
  cwd: string,
  engine = fakeEngine(),
  env: Record<string, string> = { ANTHROPIC_API_KEY: 'test-key' },
): Promise<{ code: number; stderr: string; stdout: string; engine: typeof engine }> {
  const io = memoryIo({ cwd, env });
  const code = await run(argv, io, engine);
  return { code, stderr: io.stderr(), stdout: io.stdout(), engine };
}

const manifest = JSON.stringify({ name: 'shop', dependencies: { zod: '^3.23.8' } });

describe('friendly failures: each says what to run next', () => {
  it('no TypeScript/JS project', async () => {
    const cwd = tempRepo({ 'notes.txt': '' });
    for (const argv of [[], ['check', 'zod', 'stripe'], ['fix', '--only', 'zod']]) {
      const { code, stderr } = await fail(argv, cwd);
      expect(code).toBe(2);
      expect(stderr).toContain(`error: no package.json in ${cwd} or any parent directory`);
      expect(stderr).toContain('Next: cd path/to/your/project && npx uptide');
    }
  });

  it('no lockfile: install with the declared package manager, npm otherwise', async () => {
    const npm = await fail(['check', 'zod', 'stripe'], tempRepo({ 'package.json': manifest }));
    expect(npm.code).toBe(2);
    expect(npm.stderr).toContain('error: no lockfile found for');
    expect(npm.stderr).toContain('Next: npm install\n');
    const pnpm = await fail(
      ['check', 'zod', 'stripe'],
      tempRepo({ 'package.json': '{"packageManager":"pnpm@10.17.1"}' }),
    );
    expect(pnpm.stderr).toContain('Next: pnpm install\n');
  });

  it('unsupported package manager: binary bun lockfile', async () => {
    const { code, stderr } = await fail(
      ['check', 'zod', 'stripe'],
      tempRepo({ 'package.json': manifest, 'bun.lockb': '' }),
    );
    expect(code).toBe(2);
    expect(stderr).toContain('bun.lockb is a binary lockfile, which uptide cannot read');
    expect(stderr).toContain('Next: bun install --save-text-lockfile');
  });

  it("unsupported package manager: Yarn Plug'n'Play", async () => {
    const { code, stderr } = await fail(
      ['check', 'zod', 'stripe'],
      tempRepo({ 'package.json': manifest, 'yarn.lock': '', '.pnp.cjs': '' }),
    );
    expect(code).toBe(2);
    expect(stderr).toContain("uses Yarn Plug'n'Play, which is not supported");
    expect(stderr).toContain('Next: yarn config set nodeLinker node-modules && yarn install');
  });

  it('unsupported package manager for fix: points at check, which works', async () => {
    const root = tempRepo({ 'package.json': manifest, 'bun.lock': '{}' });
    const { code, stderr, engine } = await fail(['fix', '--only', 'zod'], root);
    expect(code).toBe(2);
    expect(stderr).toContain('error: fix does not support bun repositories yet');
    expect(stderr).toContain('Next: npx uptide check zod --details');
    expect(engine.calls).toEqual([]);
  });

  it.each([
    ['package-lock.json', 'npm ci'],
    ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
    ['yarn.lock', 'yarn install --frozen-lockfile'],
  ])('missing node_modules with %s: %s', async (lockfile, next) => {
    const { code, stderr, engine } = await fail(
      ['check', 'zod', 'stripe'],
      tempRepo({ 'package.json': manifest, [lockfile]: '' }),
    );
    expect(code).toBe(2);
    expect(stderr).toContain('✖ Dependencies');
    expect(stderr).toContain('error: zod and stripe are in the lockfile but not installed');
    expect(stderr).toContain(`Next: ${next}\n`);
    expect(engine.calls).toEqual([]);
  });

  it('missing Berry installation names the immutable install command', async () => {
    const { code, stderr } = await fail(
      ['check', 'zod', 'stripe'],
      tempRepo({
        'package.json': manifest,
        'yarn.lock': '__metadata:\n  version: 8\n',
        '.yarnrc.yml': 'nodeLinker: node-modules\n',
      }),
    );
    expect(code).toBe(2);
    expect(stderr).toContain('Next: yarn install --immutable');
  });

  it('finds a hoisted install from a workspace package', async () => {
    const cwd = tempRepo({
      'package.json': '{"name":"mono"}',
      'pnpm-lock.yaml': '',
      'packages/api/package.json': manifest,
      'node_modules/zod/package.json': '{}',
      'node_modules/stripe/package.json': '{}',
    });
    const engine = fakeEngine({ workspaces: async () => ['.', 'packages/api'] });
    expect((await fail(['check', 'zod', 'stripe'], cwd, engine)).code).toBe(0);
  });

  it('declared but missing from the lockfile', async () => {
    const engine = fakeEngine({ installed: async () => new Map() });
    const { code, stderr } = await fail(['check', '--only', 'zod'], npmRepo(), engine);
    expect(code).toBe(2);
    expect(stderr).toContain('error: zod is declared in package.json but missing from');
    expect(stderr).toContain('Next: npm install\n');
  });

  it('a repository without zod or stripe is checked like any other', async () => {
    const cwd = tempRepo({
      'package.json': '{"name":"mono"}',
      'pnpm-lock.yaml': '',
      'node_modules/react/package.json': '{"name":"react","version":"18.3.1"}',
    });
    const engine = fakeEngine({
      workspaces: async () => ['.', 'packages/a', 'packages/b'],
      declared: async () => new Map([['react', '^18.0.0']]),
      installed: async () => new Map([['react', '18.3.1']]),
    });
    const { code, stdout } = await fail(['check', 'react'], cwd, engine);
    expect(code).toBe(0);
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]).toMatchObject({ only: ['react'] });
    expect(stdout).toContain('Nothing to upgrade: every checked dependency is up to date.');
  });

  it('a dependency asked for by name that is not there: exit 2', async () => {
    const engine = fakeEngine({ declared: async () => new Map([['zod', '^3.23.8']]) });
    const { code, stderr } = await fail(['check', '--only', 'stripe'], npmRepo(), engine);
    expect(code).toBe(2);
    expect(stderr).toContain('error: stripe is not a dependency of shop');
    expect(stderr).toContain('Next: npx uptide\n');
  });

  it('no network: the engine skipped everything because the registry is unreachable', async () => {
    const report = checkResult();
    report.packages = [
      {
        workspace: '.',
        name: 'zod',
        installed: '3.23.8',
        latest: '3.23.8',
        target: '3.23.8',
        majorsBehind: 0,
        findings: [],
        callSitesChecked: 0,
        unanalyzed: [],
        status: 'skipped',
        skipReason: 'REGISTRY_UNREACHABLE',
        notes: ['registry disconnected'],
        timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
      },
    ];
    const { code, stderr, stdout } = await fail(
      ['check', 'zod', 'stripe'],
      npmRepo(),
      fakeEngine({ check: async () => report }),
    );
    expect(code).toBe(2);
    expect(stderr).toContain('✖ Analysis of zod, stripe');
    expect(stderr).toContain('error: cannot reach the npm registry');
    expect(stderr).toContain('Next: npm ping');
    expect(stdout).toBe('');
  });

  it('one dependency fails: the others are reported, the failed one is named, and the exit code says incomplete', async () => {
    const report = checkResult();
    const base = {
      workspace: '.',
      majorsBehind: 0,
      findings: [],
      unanalyzed: [],
      timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
    };
    report.packages = [
      {
        ...base,
        name: 'zod',
        installed: '3.23.8',
        latest: '4.6.5',
        target: '4.6.5',
        callSitesChecked: 12,
        status: 'safe',
        notes: [],
      },
      {
        ...base,
        name: 'stripe',
        installed: '14.25.0',
        latest: '14.25.0',
        target: '14.25.0',
        callSitesChecked: 0,
        status: 'skipped',
        skipReason: 'REGISTRY_HTTP_ERROR',
        notes: [
          'could not resolve latest: https://registry.npmjs.org/stripe/latest: HTTP 429, rate limited; the registry asks to wait 145s',
        ],
      },
    ];
    const { code, stderr, stdout } = await fail(
      ['check', 'zod', 'stripe'],
      npmRepo(),
      fakeEngine({ check: async () => report }),
    );
    expect(code).toBe(2);
    // The report is there: zod was analyzed and has its row.
    expect(stdout).toMatch(/zod +3\.23\.8 → 4\.6\.5 .*✓ no impact/);
    expect(stdout).toContain('Not analyzed');
    expect(stdout).toContain(
      '✗ stripe 14.25.0: could not resolve latest: https://registry.npmjs.org/stripe/latest: HTTP 429, rate limited; the registry asks to wait 145s',
    );
    expect(stdout).not.toMatch(/^stripe +14/m);
    expect(stderr).not.toContain('error:');
  });

  it('breaking found and a dependency failed: breaking is the answer (exit 1)', async () => {
    const report = checkResult({ breaking: 2 });
    const failedOne = (): PackageReport => ({
      workspace: '.',
      name: 'stripe',
      installed: '14.25.0',
      latest: '14.25.0',
      target: '14.25.0',
      majorsBehind: 0,
      findings: [],
      callSitesChecked: 0,
      unanalyzed: [],
      status: 'skipped',
      skipReason: 'REGISTRY_HTTP_ERROR',
      notes: ['could not resolve latest: HTTP 503'],
      timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
    });
    const breaking: PackageReport = { ...failedOne(), name: 'zod', status: 'breaking', notes: [] };
    delete breaking.skipReason;
    report.packages = [failedOne(), breaking];
    const { code } = await fail(
      ['check', 'zod', 'stripe'],
      npmRepo(),
      fakeEngine({ check: async () => report }),
    );
    expect(code).toBe(1);
  });

  it('a registry error thrown by the engine is the same failure', async () => {
    const engine = fakeEngine({
      check: async () => {
        throw new UptideError(
          'REGISTRY_HTTP_ERROR',
          'https://registry.npmjs.org/zod/latest: HTTP 503',
        );
      },
    });
    const { code, stderr } = await fail(['check', 'zod', 'stripe'], npmRepo(), engine);
    expect(code).toBe(2);
    expect(stderr).toContain('error: the npm registry answered HTTP 503');
    expect(stderr).toContain('Next: run the same command again in a minute');
  });

  it('no network: the engine throws a connection error', async () => {
    const engine = fakeEngine({
      check: async () => {
        throw new UptideError('REGISTRY_UNREACHABLE', 'registry disconnected');
      },
    });
    const { code, stderr } = await fail(['check', 'zod', 'stripe'], npmRepo(), engine);
    expect(code).toBe(2);
    expect(stderr).toContain('error: cannot reach the npm registry');
    expect(stderr).toContain('(registry disconnected)');
  });

  it('no network on the status page: the lockfile half is still shown', async () => {
    const engine = fakeEngine({
      latest: async () => {
        throw new Error('fetch failed');
      },
    });
    const { code, stdout } = await fail([], npmRepo(), engine);
    expect(code).toBe(0);
    expect(stdout).toContain('3.23.8 installed, latest unknown');
    expect(stdout).toContain('Could not reach the npm registry (fetch failed)');
    expect(stdout).toContain('Next: npm ping');
  });

  it('missing ANTHROPIC_API_KEY: fix still runs with the rules', async () => {
    const { code, stderr, engine } = await fail(
      ['fix', '--only', 'zod'],
      pnpmGitRepo(),
      fakeEngine(),
      {},
    );
    expect(code).toBe(0);
    expect(stderr).toContain(
      'note: no selected-provider API key is set (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY); assisted fixes are off.',
    );
    expect(stderr).toContain('Rule-based fixes still run');
    expect(stderr).toContain('Next: npx uptide fix zod');
    expect(engine.calls).toHaveLength(1);
  });

  it('fix outside git, below the root, or on a dirty tree', async () => {
    const plain = tempRepo({
      'package.json': manifest,
      'pnpm-lock.yaml': '',
      'node_modules/zod/package.json': '{}',
    });
    const outside = await fail(['fix', '--only', 'zod'], plain);
    expect(outside.code).toBe(2);
    expect(outside.stderr).toContain('is not a git repository');
    expect(outside.stderr).toContain('Next: git init && git add -A && git commit -m "baseline"');

    const root = pnpmGitRepo({ 'packages/api/package.json': manifest });
    const below = await fail(['fix', '--only', 'zod'], join(root, 'packages/api'));
    expect(below.code).toBe(2);
    expect(below.stderr).toContain('error: fix has to run at the project root');
    expect(below.stderr).toContain(`Next: npx uptide fix --only zod --cwd ${root}`);

    writeFileSync(join(root, 'scratch.ts'), '');
    const dirty = await fail(['fix', '--only', 'zod'], root);
    expect(dirty.code).toBe(2);
    expect(dirty.stderr).toContain('error: the working tree has uncommitted changes');
    expect(dirty.stderr).toContain('Next: git stash --include-untracked');
    expect(dirty.engine.calls).toEqual([]);
  });
});
