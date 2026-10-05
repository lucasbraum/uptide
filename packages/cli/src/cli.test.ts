import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import {
  checkResult,
  ESC,
  fakeEngine,
  fixReport,
  memoryIo,
  npmRepo,
  pnpmGitRepo,
  tempRepo,
} from './test-utils.js';

describe('uptide (no command)', () => {
  it('shows where zod and stripe stand and points at check', async () => {
    const io = memoryIo({ cwd: npmRepo() });
    expect(await run([], io, fakeEngine())).toBe(0);
    expect(io.stdout()).toContain('zod     3.23.8 installed, latest 4.6.5, 1 major behind');
    expect(io.stdout()).toContain('stripe  14.25.0 installed, latest 22.6.2, 8 majors behind');
    expect(io.stdout()).toContain('Run `uptide list`, then `uptide check <package>` for impact.');
    expect(io.stderr()).toMatch(/✔ Repository {2}shop \(npm\) \(\d+ms\)/);
  });

  it('names the package manager, the workspaces and catalog pins', async () => {
    const cwd = tempRepo({
      'package.json': '{"name":"mono","packageManager":"pnpm@10.17.1"}',
      'pnpm-lock.yaml': '',
      'packages/api/package.json': '{}',
      'packages/web/package.json': '{}',
    });
    const engine = fakeEngine({
      workspaces: async () => ['.', 'packages/api', 'packages/web'],
      declared: async (dir) =>
        new Map<string, string>(dir.endsWith('api') ? [['zod', 'catalog:']] : []),
      installed: async () => new Map([['zod', '3.23.8']]),
    });
    const io = memoryIo({ cwd });
    expect(await run([], io, engine)).toBe(0);
    expect(io.stdout()).toContain('Manager     pnpm, 2 workspace packages');
    expect(io.stdout()).toMatch(/zod {5}3\.23\.8 installed.* {2}packages\/api \(catalog\)/);
    expect(io.stdout()).toContain('stripe  not a dependency');
  });

  it('prints the same facts as JSON with --json', async () => {
    const io = memoryIo({ cwd: npmRepo() });
    expect(await run(['--json'], io, fakeEngine())).toBe(0);
    const status = JSON.parse(io.stdout());
    expect(status.packageManager).toBe('npm');
    expect(status.dependencies[0]).toMatchObject({
      name: 'zod',
      installed: '3.23.8',
      latest: '4.6.5',
      majorsBehind: 1,
    });
  });

  it('still answers when the registry is unreachable', async () => {
    const io = memoryIo({ cwd: npmRepo() });
    const engine = fakeEngine({
      latest: async () => {
        throw new Error('fetch failed');
      },
    });
    expect(await run([], io, engine)).toBe(0);
    expect(io.stdout()).toContain('zod     3.23.8 installed, latest unknown');
  });

  it('rejects an unknown command with exit code 2', async () => {
    const io = memoryIo({ cwd: npmRepo() });
    expect(await run(['upgrade'], io, fakeEngine())).toBe(2);
    expect(io.stderr()).toContain("error: unknown command 'upgrade'");
  });
});

describe('uptide check', () => {
  it('requires names before touching the repository and removes the implicit budget', async () => {
    const engine = fakeEngine();
    const missing = memoryIo({ cwd: '/does-not-exist' });
    expect(await run(['check'], missing, engine)).toBe(2);
    expect(missing.stderr()).toContain('uptide list');
    expect(engine.calls).toEqual([]);
    const cwd = npmRepo();
    const io = memoryIo({ cwd });
    expect(await run(['check', 'zod', 'stripe'], io, engine)).toBe(0);
    expect(engine.calls).toEqual([
      {
        cwd,
        targets: {},
        only: ['zod', 'stripe'],
        compile: true,
        runtime: true,
        allDeps: undefined,
      },
    ]);
    expect(await run(['check', 'zod', '--max-time', '60'], memoryIo({ cwd }), engine)).toBe(2);
    expect(io.stdout()).toContain('npx uptide check zod stripe --details');
  });

  it('prints only the start line and the final timing as progress, without a terminal', async () => {
    const io = memoryIo({ cwd: npmRepo() });
    await run(['check', 'zod', 'stripe'], io, fakeEngine());
    expect(io.stderr()).toMatch(/^uptide check · shop \(npm\)\ndone in \d+ms\n$/);
    const ci = memoryIo({ cwd: npmRepo(), outTty: true, errTty: true });
    await run(['check', 'zod', 'stripe', '--ci'], ci, fakeEngine());
    expect(ci.stderr()).toMatch(/^uptide check · shop \(npm\)\ndone in \d+ms\n$/);
  });

  it('leaves no progress line behind on a terminal', async () => {
    const io = memoryIo({ cwd: npmRepo(), outTty: true, errTty: true });
    await run(['check', 'zod', 'stripe'], io, fakeEngine());
    expect(io.stderr()).not.toContain('\n');
  });

  it('prints one line per phase with --verbose', async () => {
    const io = memoryIo({ cwd: npmRepo() });
    await run(['check', 'zod', 'stripe', '--verbose'], io, fakeEngine());
    expect(io.stderr()).toContain('✔ Repository  shop (npm)');
    expect(io.stderr()).toMatch(/✔ Analysis of zod, stripe {2}0 breaking, 0 deprecated \(/);
    expect(io.stderr()).not.toContain('done in');
  });

  it('renders every site with --details', async () => {
    const io = memoryIo({ cwd: npmRepo() });
    await run(['check', 'zod', 'stripe', '--details'], io, fakeEngine());
    expect(io.stdout()).toContain('Summary: 0 packages need attention');
    expect(io.stdout()).toContain(
      '  npx uptide check zod stripe    the summary, one line per change\n',
    );
  });

  it('repeats --cwd and --only in the suggested commands', async () => {
    const cwd = npmRepo();
    const io = memoryIo({ cwd: '/' });
    await run(['check', '--cwd', cwd, '--only', 'zod'], io, fakeEngine());
    expect(io.stdout()).toContain(`  npx uptide check zod --details --cwd ${cwd}`);
  });

  it('exits 1 when a breaking change reaches the code', async () => {
    const engine = fakeEngine({ check: async () => checkResult({ breaking: 3 }) });
    const io = memoryIo({ cwd: npmRepo() });
    expect(await run(['check', 'zod', 'stripe'], io, engine)).toBe(1);
  });

  it('exits 2 when the engine cannot answer, with the reason on stderr', async () => {
    const engine = fakeEngine({
      check: async () => {
        throw new Error('adapter exploded');
      },
    });
    const io = memoryIo({ cwd: npmRepo() });
    expect(await run(['check', 'zod', 'stripe'], io, engine)).toBe(2);
    expect(io.stderr()).toContain('✖ Analysis of zod, stripe');
    expect(io.stderr()).toContain('error: adapter exploded');
    expect(io.stdout()).toBe('');
  });

  it('passes --only, --target and --cwd through', async () => {
    const cwd = npmRepo();
    const engine = fakeEngine();
    const io = memoryIo({ cwd: '/' });
    await run(['check', '--cwd', cwd, '--only', 'zod', '--target', '4.6.5'], io, engine);
    expect(engine.calls[0]).toMatchObject({ cwd, only: ['zod'], targets: { zod: '4.6.5' } });
    await run(['check', 'zod', 'stripe', '--cwd', cwd, '--target', 'zod@4.0.0'], io, engine);
    expect(engine.calls[1]).toMatchObject({ only: ['zod', 'stripe'], targets: { zod: '4.0.0' } });
  });

  it('refuses a bare --target version when several packages are selected', async () => {
    const io = memoryIo({ cwd: npmRepo() });
    expect(await run(['check', 'zod', 'stripe', '--target', '4.6.5'], io, fakeEngine())).toBe(2);
    expect(io.stderr()).toContain('--target 4.6.5: expected <package>@<version> or latest');
  });

  it('keeps stdout pure JSON with --json; progress goes to stderr', async () => {
    const io = memoryIo({ cwd: npmRepo() });
    expect(await run(['check', 'zod', 'stripe', '--json'], io, fakeEngine())).toBe(0);
    expect(JSON.parse(io.stdout()).summary.breaking).toBe(0);
    expect(io.stderr()).toContain('uptide check · shop (npm)');
  });

  it('prints one timing line per analyzed dependency with --verbose', async () => {
    const report = checkResult();
    report.packages = [
      {
        workspace: '.',
        name: 'zod',
        installed: '3.23.8',
        latest: '4.6.5',
        target: '4.6.5',
        majorsBehind: 1,
        findings: [],
        callSitesChecked: 2,
        unanalyzed: [],
        status: 'safe',
        notes: [],
        timing: { fetchMs: 1200, diffMs: 300, usagesMs: 2100, compileMs: 0 },
      },
    ];
    const io = memoryIo({ cwd: npmRepo() });
    await run(
      ['check', 'zod', 'stripe', '--verbose'],
      io,
      fakeEngine({ check: async () => report }),
    );
    expect(io.stderr()).toContain('  zod 3.23.8 → 4.6.5: fetch 1.2s, diff 300ms, usages 2.1s\n');
  });
});

describe('color and --ci', () => {
  const terminal = { outTty: true, errTty: true };
  it('colors a terminal', async () => {
    const io = memoryIo({ cwd: npmRepo(), ...terminal });
    await run(['check', 'zod', 'stripe'], io, fakeEngine());
    expect(io.stdout()).toContain(ESC);
  });
  it.each([
    ['--ci', ['check', 'zod', 'stripe', '--ci'], {}],
    ['--no-color', ['check', 'zod', 'stripe', '--no-color'], {}],
    ['NO_COLOR', ['check', 'zod', 'stripe'], { NO_COLOR: '1' }],
  ])('emits no escape codes on stdout with %s', async (_name, argv, env) => {
    const io = memoryIo({ cwd: npmRepo(), ...terminal, env });
    await run(argv, io, fakeEngine());
    expect(io.stdout()).not.toContain(ESC);
  });
  it('emits nothing but plain lines anywhere with --ci', async () => {
    const io = memoryIo({ cwd: npmRepo(), ...terminal });
    await run(['check', 'zod', 'stripe', '--ci'], io, fakeEngine());
    expect(io.stderr()).not.toContain(ESC);
    expect(io.stderr()).not.toContain('\r');
  });
});

describe('uptide fix', () => {
  it('exits 0 when the migration verifies and 1 when it does not', async () => {
    const cwd = pnpmGitRepo();
    const engine = fakeEngine();
    expect(await run(['fix', '--only', 'zod'], memoryIo({ cwd }), engine)).toBe(0);
    expect(engine.calls[0]).toMatchObject({ cwd, only: 'zod' });
    const failing = fakeEngine({ fix: async () => fixReport(false) });
    const io = memoryIo({ cwd });
    expect(await run(['fix', '--only', 'zod'], io, failing)).toBe(1);
    expect(io.stdout()).toContain('High: unverified sites');
  });

  it('says why a PR was not opened and that the branch stays local', async () => {
    const refused = {
      ...fixReport(false),
      publication: { refused: ['verification failed: 1 new type error'] },
    };
    const io = memoryIo({ cwd: pnpmGitRepo() });
    const code = await run(
      ['fix', '--only', 'zod', '--pr', '--yes', '--no-llm'],
      io,
      fakeEngine({ fix: async () => refused }),
    );
    expect(code).toBe(1);
    expect(io.stderr()).toContain(
      'PR not opened: verification failed: 1 new type error.\nBranch uptide/zod-4.6.5 stays local; nothing was pushed.\n',
    );
  });

  it('says what differs from the remote before the run, and exits 1 when a --pr run must not start', async () => {
    const cwd = pnpmGitRepo();
    const seen: unknown[] = [];
    const engine = fakeEngine({
      preflight: (_cwd, options) => {
        seen.push(options);
        if (options.pr && !options.base)
          throw new Error(
            'main is 23 commits ahead of origin/main. Push it first (`git push origin main`) so the PR only contains the migration, or pass --base <branch>.',
          );
        return {
          head: 'a'.repeat(40),
          notes: ['main is 23 commits ahead of origin/main; migrating your local state'],
        };
      },
    });
    const io = memoryIo({ cwd });
    expect(await run(['fix', 'zod'], io, engine)).toBe(0);
    // Once: printed before the run, and the engine is told not to put it in the report again.
    expect(io.stderr().split('migrating your local state')).toHaveLength(2);
    expect(engine.calls.at(-1)).toMatchObject({ preflightShown: true });
    const refused = memoryIo({ cwd });
    const calls = engine.calls.length;
    expect(await run(['fix', 'zod', '--pr', '--yes'], refused, engine)).toBe(1);
    expect(refused.stderr()).toContain(
      'error: main is 23 commits ahead of origin/main. Push it first',
    );
    expect(engine.calls.length).toBe(calls);
    await run(
      ['fix', 'zod', '--pr', '--yes', '--base', 'release', '--allow-dirty'],
      memoryIo({ cwd }),
      engine,
    );
    expect(seen.at(-1)).toEqual({ pr: true, base: 'release', allowDirty: true });
    expect(engine.calls.at(-1)).toMatchObject({ pr: true, base: 'release', allowDirty: true });
  });

  it('prints the FixReport with --json', async () => {
    const io = memoryIo({ cwd: pnpmGitRepo() });
    await run(['fix', '--only', 'zod', '--json', '--target', 'zod@4.6.5'], io, fakeEngine());
    expect(JSON.parse(io.stdout()).branch).toBe('uptide/zod-4.6.5');
  });

  it('exits 2 without --only, or with more than one dependency', async () => {
    expect(await run(['fix'], memoryIo({ cwd: pnpmGitRepo() }), fakeEngine())).toBe(2);
    const io = memoryIo({ cwd: pnpmGitRepo() });
    expect(await run(['fix', '--only', 'zod,stripe'], io, fakeEngine())).toBe(2);
    expect(io.stderr()).toContain('--only zod,stripe: fix upgrades one dependency at a time');
  });

  it('a generic package without an agent: says what it cannot do, and nothing happens', async () => {
    for (const [argv, env, why, next] of [
      [
        ['fix', '--only', 'react'],
        {},
        'no selected-provider API key is set',
        'Next: uptide fix react',
      ],
      [
        ['fix', '--only', 'react', '--no-llm'],
        { ANTHROPIC_API_KEY: 'test-key' },
        'assisted fixes are off (--no-llm)',
        'Next: uptide check react --details',
      ],
    ] as const) {
      const engine = fakeEngine();
      const io = memoryIo({ cwd: pnpmGitRepo(), env });
      expect(await run([...argv], io, engine)).toBe(2);
      expect(io.stderr()).toContain(
        `error: react has no migration pack, so every fix would come from the agent, and ${why}`,
      );
      expect(io.stderr()).toContain('Nothing was changed: no clone, no branch, no install.');
      expect(io.stderr()).toContain(next);
      expect(engine.calls).toEqual([]);
    }
  });

  it('a generic package with an agent: runs under a cost limit and says so', async () => {
    const cwd = pnpmGitRepo({
      'package.json': JSON.stringify({
        name: 'shop',
        packageManager: 'pnpm@10.17.1',
        dependencies: { react: '^18.0.0' },
      }),
      'node_modules/react/package.json': '{"name":"react","version":"18.3.1"}',
    });
    const engine = fakeEngine({
      declared: async () => new Map([['react', '^18.0.0']]),
      installed: async () => new Map([['react', '18.3.1']]),
      fix: async (request) => {
        engine.calls.push(request);
        return {
          ...fixReport(true),
          package: 'react',
          tier: 'generic',
          llm: {
            available: true,
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0.6,
            costLimit: { limitUsd: 1, notAttempted: 3 },
          },
        };
      },
    });
    const io = memoryIo({ cwd, env: { ANTHROPIC_API_KEY: 'test-key' } });
    await run(['fix', '--only', 'react'], io, engine);
    expect(engine.calls).toEqual([expect.objectContaining({ only: 'react', llm: true })]);
    expect(io.stderr()).toContain(
      'react has no migration pack (generic tier): every fix comes from the agent, up to $1.00 (--max-cost)',
    );
    expect(io.stdout()).toContain(
      "  Tier      generic: no migration pack; every edit is the agent's, kept on the compiler's word. Review each one.",
    );
    expect(io.stdout()).toContain(
      '  Agent     stopped at $1.00 (--max-cost): 3 sites not completed',
    );
    // --max-cost reaches the engine; nonsense is refused.
    await run(
      ['fix', '--only', 'react', '--max-cost', '2.5'],
      memoryIo({ cwd, env: { ANTHROPIC_API_KEY: 'k' } }),
      engine,
    );
    expect(engine.calls.at(-1)).toMatchObject({ maxCostUsd: 2.5 });
    const bad = memoryIo({ cwd, env: { ANTHROPIC_API_KEY: 'k' } });
    expect(await run(['fix', '--only', 'react', '--max-cost', 'lots'], bad, engine)).toBe(2);
    expect(bad.stderr()).toContain('--max-cost lots: expected an amount in USD');
  });
});

describe('uptide verify', () => {
  it('verifies the branch again and exits by the result', async () => {
    const cwd = pnpmGitRepo();
    const asked: unknown[] = [];
    const engine = fakeEngine({
      verify: async (request) => {
        asked.push(request);
        return { ...fixReport(true), head: 'abcdef1234567890' };
      },
    });
    const io = memoryIo({ cwd });
    expect(await run(['verify'], io, engine)).toBe(0);
    expect(asked).toEqual([{ cwd }]);
    // A report without `source` (an engine that ran in place) prints no clone line.
    expect(io.stderr()).not.toContain('temporary clone');
    expect(io.stderr()).toContain(
      '✔ Verification of the migration branch  verification passed at abcdef12',
    );
    const failing = fakeEngine({ verify: async () => fixReport(false) });
    expect(await run(['verify'], memoryIo({ cwd }), failing)).toBe(1);
  });
  it('passes the branch, --with-services, --push and --yes through, and says where it ran', async () => {
    const cwd = pnpmGitRepo();
    const asked: unknown[] = [];
    const engine = fakeEngine({
      verify: async (request) => {
        asked.push(request);
        return {
          ...fixReport(true),
          source: cwd,
          repo: cwd,
          clone: { path: '/tmp/uptide-runs/run-x/repo', kept: false },
        };
      },
    });
    const io = memoryIo({ cwd });
    await run(
      ['verify', '--branch', 'uptide/zod-4.6.5', '--with-services', '--push', '--yes'],
      io,
      engine,
    );
    expect(asked).toEqual([
      { cwd, branch: 'uptide/zod-4.6.5', withServices: true, push: true, yes: true },
    ]);
    expect(io.stderr()).toContain(
      'Ran in a temporary clone, removed now that the run is over.\nYour checkout was not touched: same branch, files, hooks and git config.\n',
    );
  });
  it('warns when the checkout changed during the run', async () => {
    const cwd = pnpmGitRepo();
    const engine = fakeEngine({
      fix: async () => ({
        ...fixReport(true),
        source: cwd,
        repo: '/tmp/uptide-runs/run-x/repo',
        clone: {
          path: '/tmp/uptide-runs/run-x/repo',
          kept: true,
          reason: 'your checkout changed during the run',
        },
        sourceChanged: ['git hooks were added or changed'],
      }),
    });
    const io = memoryIo({ cwd });
    await run(['fix', '--only', 'zod', '--no-llm'], io, engine);
    expect(io.stderr()).toContain(
      'Warning: your checkout changed during the run: git hooks were added or changed.',
    );
    // A kept clone is always named, with the reason and how it goes away.
    expect(io.stderr()).toContain(
      'Temporary clone kept: /tmp/uptide-runs/run-x/repo\n  your checkout changed during the run; `uptide clean` removes kept clones older than 7 days.',
    );
  });
  it('ends with the summary and the next commands, never the PR body', async () => {
    const engine = fakeEngine({
      fix: async () => ({
        ...fixReport(true),
        source: '/repo',
        base: 'main',
        html: '/repo/.git/uptide/uptide__zod-4.6.5/report.html',
      }),
    });
    const io = memoryIo({ cwd: pnpmGitRepo() });
    expect(await run(['fix', '--only', 'zod', '--no-llm'], io, engine)).toBe(0);
    expect(io.stdout()).toContain('uptide fix · zod');
    expect(io.stdout()).toContain('  Risk      ');
    expect(io.stdout()).toContain('pr --branch uptide/zod-4.6.5');
    // A path outside the working directory stays absolute, so it works as typed.
    expect(io.stdout()).toContain('open /repo/.git/uptide/uptide__zod-4.6.5/report.html');
    expect(io.stdout()).not.toContain('### What changed');
    expect(io.stdout()).not.toContain('## Upgrade');
  });
  it('pr: prints the plan without --yes, opens the PR with it, and names the stale branch', async () => {
    const asked: unknown[] = [];
    const engine = fakeEngine({
      pr: async (request, print) => {
        asked.push(request);
        print('Publication plan\nOpening the PR on: me/fork (a fork of them/upstream)');
        if (!request.yes) throw new Error('publication requires --yes; nothing pushed');
        return { url: 'https://github.com/me/fork/pull/3', report: fixReport(true) };
      },
    });
    const cwd = pnpmGitRepo();
    const io = memoryIo({ cwd });
    expect(await run(['pr', '--branch', 'uptide/zod-4.6.5'], io, engine)).toBe(0);
    expect(io.stderr()).toContain('Opening the PR on: me/fork (a fork of them/upstream)');
    expect(io.stderr()).toContain('Nothing pushed. Add --yes');
    const yes = memoryIo({ cwd });
    expect(
      await run(
        ['pr', '--branch', 'uptide/zod-4.6.5', '--repo', 'them/upstream', '--yes'],
        yes,
        engine,
      ),
    ).toBe(0);
    expect(yes.stdout()).toBe('https://github.com/me/fork/pull/3\n');
    expect(asked[1]).toMatchObject({
      branch: 'uptide/zod-4.6.5',
      repo: 'them/upstream',
      yes: true,
      draft: false,
    });
  });

  it('refuses a --target for a package not selected, before any work', async () => {
    const engine = fakeEngine();
    const io = memoryIo({ cwd: pnpmGitRepo() });
    expect(
      await run(['fix', '--only', 'zod', '--target', 'stripe@23.0.0', '--no-llm'], io, engine),
    ).toBe(2);
    expect(io.stderr()).toContain(
      '--target stripe@23.0.0: stripe is not among the packages selected (zod)',
    );
    expect(engine.calls).toEqual([]);
    const check = memoryIo({ cwd: pnpmGitRepo() });
    expect(await run(['check', '--only', 'zod', '--target', 'stripe@23.0.0'], check, engine)).toBe(
      2,
    );
    expect(check.stderr()).toContain('is not among the packages selected');
  });
  it('--pr: settles GitHub and the target repository before cloning, and says so', async () => {
    const engine = fakeEngine({
      publishTarget: async () => ({ nameWithOwner: 'me/fork', base: 'main', parent: 'them/app' }),
    });
    const io = memoryIo({ cwd: pnpmGitRepo() });
    expect(await run(['fix', '--only', 'zod', '--pr', '--no-llm'], io, engine)).toBe(0);
    expect(io.stderr()).toContain(
      '--pr without --yes: the publication plan is printed, nothing is pushed.',
    );
    expect(io.stderr()).toContain('PR will be opened on me/fork (base main), a fork of them/app');
    const signedOut = fakeEngine({
      publishTarget: async () => {
        throw new Error('--pr needs GitHub CLI signed in; run `gh auth login`');
      },
    });
    const out = memoryIo({ cwd: pnpmGitRepo() });
    expect(await run(['fix', '--only', 'zod', '--pr', '--no-llm'], out, signedOut)).toBe(2);
    expect(out.stderr()).toContain('gh auth login');
    expect(signedOut.calls).toEqual([]);
  });

  it('passes --keep through', async () => {
    const asked: unknown[] = [];
    const engine = fakeEngine({
      fix: async (request) => {
        asked.push(request);
        return fixReport(true);
      },
    });
    await run(
      ['fix', '--only', 'zod', '--no-llm', '--keep'],
      memoryIo({ cwd: pnpmGitRepo() }),
      engine,
    );
    expect(asked[0]).toMatchObject({ keep: true });
  });
  it('exits 2 when the engine does not provide it', async () => {
    const io = memoryIo({ cwd: pnpmGitRepo() });
    expect(await run(['verify'], io, fakeEngine())).toBe(2);
    expect(io.stderr()).toContain('verify is not available');
  });
});

describe('uptide clean', () => {
  it('removes kept clones older than seven days by default and lists the rest', async () => {
    const asked: number[] = [];
    const engine = fakeEngine({
      clean: (days) => {
        asked.push(days);
        return { removed: ['/tmp/uptide-runs/run-old'], kept: ['/tmp/uptide-runs/run-new'] };
      },
    });
    const io = memoryIo();
    expect(await run(['clean'], io, engine)).toBe(0);
    expect(asked).toEqual([7]);
    expect(io.stdout()).toBe(
      'removed /tmp/uptide-runs/run-old\n1 temporary clone removed, 1 newer than 7 days kept.\n  kept /tmp/uptide-runs/run-new\n',
    );
    await run(['clean', '--days', '0'], memoryIo(), engine);
    expect(asked).toEqual([7, 0]);
    const bad = memoryIo();
    expect(await run(['clean', '--days', 'soon'], bad, engine)).toBe(2);
    expect(bad.stderr()).toContain('--days soon: expected a number of days');
  });
});

describe('uptide pr-body', () => {
  it('exits 2 while the engine does not provide it', async () => {
    const io = memoryIo({ cwd: npmRepo() });
    expect(await run(['pr-body', '--pr', '82'], io, fakeEngine())).toBe(2);
    expect(io.stderr()).toContain('pr-body is not available in this build');
  });

  it('prints the body, or the whole result with --json', async () => {
    const cwd = npmRepo();
    const engine = fakeEngine({
      updatePrBody: async (opts) => ({
        body: `# body for ${opts.pr} in ${opts.cwd}\n`,
        updated: !opts.preview,
        url: 'https://example.test/pr/82',
      }),
    });
    const io = memoryIo({ cwd });
    expect(await run(['pr-body', '--pr', '82', '--preview'], io, engine)).toBe(0);
    expect(io.stdout()).toBe(`# body for 82 in ${cwd}\n`);
    expect(io.stderr()).toContain('Preview only; PR unchanged: https://example.test/pr/82');
    const json = memoryIo({ cwd });
    await run(['pr-body', '--pr', '82', '--json'], json, engine);
    expect(JSON.parse(json.stdout())).toMatchObject({ updated: true });
  });
});

describe('--help', () => {
  it.each(['check', 'zod', 'stripe', 'fix', 'pr-body'])(
    '%s documents the shared flags and exit codes',
    async (command) => {
      const io = memoryIo();
      expect(await run([command, '--help'], io, fakeEngine())).toBe(0);
      const help = io.stdout();
      for (const flag of ['--cwd <dir>', '--json', '--ci', '--no-color'])
        expect(help).toContain(flag);
      expect(help).toContain('Examples:');
      expect(help).toMatch(/Exit codes:\n {2}0 .*\n {2}1 .*\n {2}2 {2}uptide could not answer/);
    },
  );

  it('check and fix both take --only and --target', async () => {
    for (const command of ['check', 'fix']) {
      const io = memoryIo();
      await run([command, '--help'], io, fakeEngine());
      expect(io.stdout()).toContain('--only <');
      expect(io.stdout()).toContain('--target <');
    }
  });

  it('exits 2 on an unknown option and 0 on --version', async () => {
    const io = memoryIo();
    expect(await run(['check', 'zod', 'stripe', '--frobnicate'], io, fakeEngine())).toBe(2);
    expect(io.stderr()).toContain("unknown option '--frobnicate'");
    expect(await run(['--version'], memoryIo(), fakeEngine())).toBe(0);
  });
});

it('selects each provider from its key, passes model and the universal budget, and prints spend', async () => {
  for (const [provider, key, model] of [
    ['anthropic', 'ANTHROPIC_API_KEY', 'claude-sonnet-5-5'],
    ['openai', 'OPENAI_API_KEY', 'gpt-6.1-sol'],
    ['gemini', 'GEMINI_API_KEY', 'gemini-3.8-flash'],
  ] as const) {
    const engine = fakeEngine();
    const io = memoryIo({ cwd: pnpmGitRepo(), env: { [key]: 'test-key' } });
    expect(await run(['fix', 'zod'], io, engine)).toBe(0);
    expect(engine.calls[0]).toMatchObject({ provider, model, maxCostUsd: 1 });
    expect(io.stderr()).toContain(`LLM: ${provider} / ${model}`);
    expect(io.stderr()).toContain('LLM spend: $');
    expect(io.stderr()).not.toContain('test-key');
  }
});

it('flags override environment and unknown models warn before the engine starts', async () => {
  const engine = fakeEngine();
  const io = memoryIo({
    cwd: pnpmGitRepo(),
    env: {
      OPENAI_API_KEY: 'test',
      GEMINI_API_KEY: 'test',
      UPTIDE_PROVIDER: 'gemini',
      UPTIDE_MODEL: 'env-model',
    },
  });
  expect(
    await run(
      ['fix', 'zod', '--provider', 'openai', '--model', 'custom', '--max-cost', '2'],
      io,
      engine,
    ),
  ).toBe(0);
  expect(engine.calls[0]).toMatchObject({ provider: 'openai', model: 'custom', maxCostUsd: 2 });
  expect(io.stderr()).toContain('highest listed rates');
});

it('rejects key-like repository config before the engine, even with --no-llm', async () => {
  const cwd = pnpmGitRepo();
  writeFileSync(
    join(cwd, 'uptide.config.json'),
    JSON.stringify({ provider: 'openai', apiKey: 'PRIVATE_CREDENTIAL' }),
  );
  const io = memoryIo({ cwd });
  const engine = fakeEngine();
  expect(await run(['fix', 'zod', '--no-llm'], io, engine)).toBe(2);
  expect(io.stderr()).toContain('key-like setting');
  expect(io.stderr()).not.toContain('PRIVATE_CREDENTIAL');
  expect(engine.calls).toEqual([]);
  expect(io.stderr()).toContain('LLM spend: $0.000000');
});
