import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckReport, Finding, PackageReport } from '@uptide/core';
import { describe, expect, it } from 'vitest';
import { formatCheck } from './format-check.js';
import { ESC } from './test-utils.js';

/** A real `check` of `fixtures/repos/storefront`, a synthetic pnpm workspace on zod 3 and stripe 14. */
const storefront = JSON.parse(
  readFileSync(join(import.meta.dirname, '__fixtures__/storefront-check.json'), 'utf8'),
) as CheckReport;
/** A real `check --only zod` of `smoke/fixtures/pnpm` (zod 3.23.8 from the catalog). */
const smoke = JSON.parse(
  readFileSync(join(import.meta.dirname, '__fixtures__/smoke-pnpm-check.json'), 'utf8'),
) as CheckReport;
const header = { repo: 'storefront', manager: 'pnpm', packages: 2, ms: 25_000 };
const shown = { color: false, header, invocation: 'npx uptide@next', fixable: ['zod', 'stripe'] };

const pkg = (over: Partial<PackageReport>): PackageReport => ({
  workspace: '.',
  name: 'twilio',
  installed: '5.0.1',
  latest: '5.3.0',
  target: '5.3.0',
  majorsBehind: 0,
  findings: [],
  callSitesChecked: 12,
  unanalyzed: [],
  status: 'safe',
  notes: [],
  timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
  ...over,
});
const removed = (file: string, line: number, over: Partial<Finding> = {}): Finding => ({
  severity: 'breaking',
  confidence: 1,
  fixability: 'manual',
  reason: 'removed',
  ...over,
  change: {
    package: 'sharp',
    from: '0.33.0',
    to: '0.35.0',
    path: 'sharp.cache',
    kind: 'removed',
    severity: 'breaking',
    source: 'types',
    confidence: 1,
  },
  usage: {
    file,
    line,
    column: 1,
    endLine: line,
    endColumn: 2,
    symbolPath: 'sharp.cache',
    access: 'call',
    snippet: 'sharp.cache(false)',
    via: 'direct',
    compileError: "Property 'cache' does not exist on type 'typeof sharp'.",
  },
});
const report = (packages: PackageReport[], workspaces = ['.']): CheckReport => ({
  repo: '/repo',
  workspaces,
  packages,
  summary: {
    packagesNeedingAttention: 0,
    breaking: 0,
    deprecated: 0,
    unverified: 0,
    unaffected: 0,
    notImported: 0,
    partiallyAnalyzed: 0,
    autoFixable: 0,
    skippedForTime: 0,
    failed: 0,
  },
});

describe('formatCheck, the first screen', () => {
  it('summarizes a real workspace: a row per dependency, a line per rule, the next commands', () => {
    expect(formatCheck(storefront, shown)).toMatchSnapshot();
  });

  it('summarizes the pnpm smoke fixture, by default and with --details', () => {
    const options = {
      color: false,
      header: { repo: 'smoke-pnpm', manager: 'pnpm', packages: 2, ms: 3100 },
      invocation: 'npx uptide@next',
      fixable: ['zod', 'stripe'],
      repeat: { only: 'zod', targets: {} },
    };
    expect(formatCheck(smoke, options)).toMatchSnapshot();
    expect(formatCheck(smoke, { ...options, details: true })).toMatchSnapshot();
  });

  it('labels every rule with what fix will do, from the plan the engine attached', () => {
    const out = formatCheck(storefront, shown);
    expect(out).toMatch(/✗ 28 breaking in 7 files {4}24 by rule · 4 by agent/);
    expect(out).toMatch(/✗ New error API \(required_error → error\) +24 sites +by rule/);
    expect(out).toMatch(/✗ ZodTypeDef removed +1 fix, 3 errors +by agent/);
    expect(out).toMatch(/✗ \.ip\(\) removed +monitoring\.ts:6 +by agent/);
    expect(out).toMatch(/✗ apiVersion no longer matches the SDK +client\.ts:9 +by agent/);
    expect(out).toMatch(/✗ Subscription billing period moved to items +2 sites +by agent/);
    // A cast the test already had is widened by rule, never by the agent.
    expect(out).toMatch(/✗ Test fixture casts widened +renewal\.test\.ts:7 +by rule/);
    expect(out).toContain('1 API change since 2023-10-16 affects your code');
  });

  it('keeps analysis chatter and raw compiler text out of the default view', () => {
    const out = formatCheck(storefront, shown);
    for (const noise of [
      'low-confidence',
      'unused exports',
      'pre-existing type error',
      'No overload matches',
      'packages/shared/src',
      'TS2',
    ])
      expect(out).not.toContain(noise);
  });

  it('shows full paths, reasons, compiler messages and notes with --details', () => {
    const out = formatCheck(storefront, { ...shown, details: true });
    expect(out.split('\n')[0]).toBe('uptide check · storefront (pnpm, 2 packages) · 25s');
    expect(out).toContain('packages/shared/src/monitoring.ts:6');
    expect(out).toContain("compiler: Property 'ip' does not exist on type 'ZodString'.");
    expect(out).toContain('1 pre-existing type error at the installed version (subtracted)');
    expect(out).toContain('Summary: 2 packages need attention · 32 breaking · 15 deprecated');
    // The way back to the short view replaces the pointer to --details.
    expect(out.trimEnd().split('\n').at(-1)).toMatch(
      /^ {2}npx uptide@next check +the summary, one line per change$/,
    );
  });

  it('names an importer the manifest does not show, and one it could not analyze, in both views', () => {
    const importers = [
      { workspace: 'packages/core', declared: true, analyzed: true },
      { workspace: 'ui', declared: false, via: '@acme/core', analyzed: true },
      { workspace: 'ee/agent', declared: true, analyzed: false, reason: 'no lockfile' },
    ];
    const stripe = pkg({
      name: 'stripe',
      workspace: '*',
      workspaces: ['packages/core', 'ui'],
      installed: '14.25.0',
      target: '23.0.0',
      status: 'breaking',
      findings: [removed('ui/src/app/api/billing/webhook/route.ts', 44)],
      importers,
    });
    const quiet = pkg({
      name: 'twilio',
      importers: [{ workspace: 'api', declared: true, analyzed: true }],
    });
    const short = formatCheck(report([stripe, quiet], ['packages/core', 'ui', 'ee/agent']), shown);
    expect(short).toContain(
      '  ⚠ ui · imports stripe without declaring it (resolved via @acme/core)',
    );
    expect(short).toContain('  ⚠ ee/agent · imports stripe, not analyzed: no lockfile');
    expect(short).not.toContain('twilio\n');
    const long = formatCheck(report([stripe, quiet], ['packages/core', 'ui', 'ee/agent']), {
      ...shown,
      details: true,
    });
    expect(long).toContain('  analyzed in packages/core, ui (undeclared, via @acme/core)');
    expect(long).toContain(
      '  ⚠ ui · imports stripe without declaring it (resolved via @acme/core)',
    );
  });

  it('gives each kind of verdict one row, and no row to what needs no decision', () => {
    const site = (line: number) => ({ file: 'src/legacy.js', line, kind: 'require' as const });
    const out = formatCheck(
      report([
        pkg({ name: 'twilio' }),
        pkg({ name: 'lodash', status: 'no-types', notes: ['types in @types/lodash'] }),
        pkg({ name: 'joi', status: 'partial', unanalyzed: [site(3), site(9)] }),
        pkg({ name: 'pg', status: 'unknown', callSitesChecked: 0, unanalyzed: [site(1)] }),
        pkg({ name: '@me/shared', status: 'workspace' }),
        pkg({ name: '@me/private', status: 'private' }),
        pkg({ name: 'never', status: 'not-imported' }),
        pkg({ name: 'current', notes: ['up to date'] }),
        pkg({
          name: 'sharp',
          installed: '0.33.0',
          target: '0.35.0',
          status: 'breaking',
          findings: [removed('src/image.ts', 4), removed('src/thumb.ts', 9)],
        }),
      ]),
      { color: false },
    );
    expect(out).toMatchSnapshot();
    // No migration pack for sharp: no rule is promised; the confirmed sites are the agent's.
    expect(out).toMatch(/sharp +0\.33\.0 → 0\.35\.0 +minor +✗ 2 breaking in 2 files {4}2 by agent/);
    expect(out).toMatch(/✗ sharp\.cache removed +2 sites +by agent/);
    for (const absent of ['@me/shared', '@me/private', 'never', 'current'])
      expect(out).not.toContain(absent);
  });

  it('names the workspace of a dependency that is not shared, and the size of a release group', () => {
    const out = formatCheck(
      report(
        [
          pkg({ workspace: 'packages/api' }),
          pkg({
            name: '@aws-sdk/*',
            members: [
              { name: '@aws-sdk/client-s3', installed: '3.1.0', target: '3.2.0' },
              { name: '@aws-sdk/core', installed: '3.1.0', target: '3.2.0' },
            ],
            workspace: '*',
          }),
        ],
        ['.', 'packages/api'],
      ),
      { color: false },
    );
    expect(out).toContain('twilio (packages/api)');
    expect(out).toContain('@aws-sdk/* (2 packages)  ');
  });

  it('says where each target came from: the npm dist-tag, or the one asked for', () => {
    const latest = formatCheck(report([pkg({ name: 'twilio' })]), shown);
    expect(latest).toContain('5.0.1 → 5.3.0   minor · latest on npm');
    const asked = formatCheck(report([pkg({ name: 'twilio', target: '5.2.0', latest: '5.3.0' })]), {
      ...shown,
      repeat: { targets: { twilio: '5.2.0' } },
    });
    expect(asked).toContain('5.0.1 → 5.2.0   minor · --target');
  });

  it('says so when there is nothing to upgrade', () => {
    const out = formatCheck(report([pkg({ notes: ['up to date'] })]), { color: false });
    expect(out).toContain('Nothing to upgrade: every checked dependency is up to date.');
    expect(out).toContain('  npx uptide check --details    every site and reason');
  });

  it('colors a terminal and stays plain otherwise', () => {
    expect(formatCheck(storefront, { ...shown, color: true })).toContain(ESC);
    expect(formatCheck(storefront, shown)).not.toContain(ESC);
  });
});

describe('the Next block', () => {
  const next = (out: string): string[] => {
    const lines = out.trimEnd().split('\n');
    return lines.slice(lines.indexOf('Next') + 1).map((l) => l.trim().replace(/ {2,}/g, ' | '));
  };

  it('ends with the exact commands for this repository', () => {
    expect(next(formatCheck(storefront, shown))).toEqual([
      'npx uptide@next fix --only zod | migrate on a new branch, verify, no push',
      'npx uptide@next fix --only stripe | migrate on a new branch, verify, no push',
      'npx uptide@next plan | the order to upgrade in, with the effort',
      'npx uptide@next check --details | every site and reason',
    ]);
  });

  it('repeats the --cwd, --only and --target the run was given', () => {
    const out = formatCheck(storefront, {
      ...shown,
      repeat: { cwd: '../storefront', only: 'zod', targets: { zod: '4.6.5' } },
    });
    expect(next(out)).toEqual([
      'npx uptide@next fix --only zod --target 4.6.5 --cwd ../storefront | migrate on a new branch, verify, no push',
      'npx uptide@next fix --only stripe --cwd ../storefront | migrate on a new branch, verify, no push',
      'npx uptide@next plan --only zod --cwd ../storefront | the order to upgrade in, with the effort',
      'npx uptide@next check --only zod --target zod@4.6.5 --details --cwd ../storefront | every site and reason',
    ]);
  });

  it('offers fix only where fix can run, and --include-deprecated when that is all there is', () => {
    // A bun repository: check works, fix does not.
    expect(next(formatCheck(storefront, { ...shown, fixable: [] }))).toEqual([
      'npx uptide@next plan | the order to upgrade in, with the effort',
      'npx uptide@next check --details | every site and reason',
    ]);
    const named = (name: string): PackageReport =>
      storefront.packages.find((p) => p.name === name) as PackageReport;
    const [stripe, zod] = [named('stripe'), named('zod')];
    const deprecatedOnly = {
      ...storefront,
      packages: [
        stripe,
        { ...zod, plan: (zod.plan ?? []).filter((g) => g.severity === 'deprecated') },
      ],
    };
    expect(next(formatCheck(deprecatedOnly, shown))).toEqual([
      'npx uptide@next fix --only stripe | migrate on a new branch, verify, no push',
      'npx uptide@next fix --only zod --include-deprecated | migrate the deprecated calls on a new branch, no push',
      'npx uptide@next plan | the order to upgrade in, with the effort',
      'npx uptide@next check --details | every site and reason',
    ]);
  });
});

describe('tiers, the time budget and failures on the first screen', () => {
  const unconfirmed = removed('src/image.ts', 4, { severity: 'unverified' });
  const generic = pkg({
    name: 'sharp',
    installed: '0.33.0',
    target: '0.35.0',
    latest: '0.35.0',
    tier: 'generic',
    status: 'breaking',
    findings: [removed('src/thumb.ts', 9), unconfirmed],
  });
  const verified = pkg({
    name: 'zod',
    installed: '3.25.76',
    target: '4.6.5',
    latest: '4.6.5',
    tier: 'verified',
  });

  it('names the tier of every row and explains the difference in one line', () => {
    const out = formatCheck(report([generic, verified]), { color: false });
    expect(out).toMatch(/sharp +0\.33\.0 → 0\.35\.0 +minor · latest on npm +generic +✗ 1 breaking/);
    expect(out).toMatch(/zod +3\.25\.76 → 4\.6\.5 +major · latest on npm +verified +✓ no impact/);
    expect(out.match(/verified: migration pack · generic: no pack/g)).toHaveLength(1);
    // Nothing generic on screen, nothing to explain.
    expect(formatCheck(report([verified]), { color: false })).not.toContain('generic: no pack');
  });

  it('keeps what nothing confirmed off the first screen of a generic package', () => {
    const out = formatCheck(report([generic]), { color: false });
    expect(out).toContain('✗ 1 breaking · 1 unconfirmed in --details');
    expect(out).not.toContain('? ');
    expect(out).not.toContain('unverified');
    const none = formatCheck(report([{ ...generic, status: 'safe', findings: [unconfirmed] }]), {
      color: false,
    });
    expect(none).toContain('✓ nothing confirmed (12 call sites) · 1 unconfirmed in --details');
    // The verified tier still shows what it could not verify.
    const kept = formatCheck(
      report([{ ...generic, name: 'zod', tier: 'verified', findings: [unconfirmed] }]),
      { color: false },
    );
    expect(kept).toContain('? 1 unverified');
  });

  it('folds many no-impact upgrades into one line', () => {
    const quiet = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((name) =>
      pkg({ name, tier: 'generic' }),
    );
    const out = formatCheck(report([generic, ...quiet]), { color: false });
    expect(out).toContain('✓ 8 more with no impact on your code: a, b, c, d, e, f, and 2 more');
    expect(out).not.toMatch(/^a +5\.0\.1/m);
    // Five or fewer keep their rows.
    expect(formatCheck(report(quiet.slice(0, 5)), { color: false })).toMatch(/^a +5\.0\.1/m);
  });

  it('lists what the budget did not reach and what failed, with how to include them', () => {
    const late = (name: string) =>
      pkg({
        name,
        tier: 'generic',
        status: 'skipped',
        skipReason: 'TIME_BUDGET',
        notes: ['time budget reached before this dependency'],
      });
    const failed = pkg({
      name: 'pg',
      installed: '8.11.0',
      tier: 'generic',
      status: 'skipped',
      skipReason: 'REGISTRY_HTTP_ERROR',
      notes: ['could not fetch pg@9.0.0: HTTP 503'],
    });
    const out = formatCheck(report([generic, late('react'), late('next'), failed]), {
      color: false,
      invocation: 'npx uptide',
      maxTime: 60,
    });
    expect(out).toContain(
      [
        'Not analyzed',
        '  ⚠ 2 behind, out of time (--max-time 60): react, next',
        '    npx uptide check --only react,next    by name, no time limit',
        '    npx uptide check --max-time 300    a longer budget (0: no limit)',
        '  ✗ pg 8.11.0: could not fetch pg@9.0.0: HTTP 503',
      ].join('\n'),
    );
    // Neither gets a row: they have no verdict.
    expect(out).not.toMatch(/^react +5/m);
    expect(out).not.toMatch(/^pg +8/m);
  });
});
