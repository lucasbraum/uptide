import type { Change, CheckReport, Finding, PackageReport, Usage } from '@uptide/core';
import { describe, expect, it } from 'vitest';
import { formatCheckDetails as formatCheck } from './format-check-details.js';

type Over = Partial<Omit<Finding, 'change' | 'usage'>> & {
  change: Partial<Change>;
  usage: Partial<Usage>;
};
const finding = ({ change, usage, ...rest }: Over): Finding => ({
  severity: 'breaking',
  confidence: 1,
  fixability: 'mechanical',
  reason: '',
  ...rest,
  change: {
    package: 'stripe',
    from: '14.2.0',
    to: '17.1.0',
    path: 'x',
    kind: 'removed',
    severity: 'breaking',
    source: 'types',
    confidence: 1,
    ...change,
  },
  usage: {
    file: 'src/a.ts',
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 2,
    symbolPath: 'x',
    access: 'call',
    snippet: '',
    via: 'direct',
    ...usage,
  },
});

const report: CheckReport = {
  repo: '/repo',
  workspaces: ['.'],
  packages: [
    {
      workspace: '.',
      name: 'stripe',
      installed: '14.2.0',
      latest: '17.1.0',
      target: '17.1.0',
      majorsBehind: 3,
      callSitesChecked: 34,
      unanalyzed: [],
      status: 'breaking',
      notes: [],
      timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
      findings: [
        finding({
          reason: 'removed',
          change: {
            path: 'Stripe.SubscriptionCreateParams#items[]#quantity',
            kind: 'removed',
            replacement: 'Stripe.SubscriptionCreateParams#items[]#quantities[]',
          },
          usage: {
            file: 'src/billing/subscriptions.ts',
            line: 42,
            snippet: 'stripe.subscriptions.create({ items: [{ quantity }] })',
          },
        }),
        finding({
          severity: 'deprecated',
          reason: 'use paymentMethods instead',
          change: { path: 'Stripe.Customer#sources', kind: 'deprecated', severity: 'deprecated' },
          usage: { file: 'src/customers/sync.ts', line: 15, snippet: 'customer.sources' },
        }),
        finding({
          severity: 'additive',
          fixability: 'none',
          change: { path: 'Stripe#x', kind: 'widened', severity: 'additive' },
          usage: { file: 'src/z.ts', line: 3, snippet: 'ignored' },
        }),
        finding({
          confidence: 0.4,
          fixability: 'unknown',
          change: { path: 'Stripe#low', kind: 'type' },
          usage: { file: 'src/low.ts', line: 9, snippet: 'low', via: 'inferred' },
        }),
      ],
    },
    {
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
    },
    {
      workspace: '.',
      name: 'lodash',
      installed: '4.17.20',
      latest: '4.17.21',
      target: '4.17.21',
      majorsBehind: 0,
      findings: [],
      callSitesChecked: 0,
      unanalyzed: [],
      status: 'no-types',
      notes: ['no type declarations, cannot analyze'],
      timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
    },
  ],
  summary: {
    packagesNeedingAttention: 1,
    breaking: 2,
    deprecated: 1,
    unverified: 0,
    unaffected: 1,
    notImported: 0,
    partiallyAnalyzed: 0,
    autoFixable: 2,
  },
};

describe('formatCheckDetails', () => {
  it('renders every site with its snippet and reason', () => {
    const out = formatCheck(report, { color: false });
    expect(out).toBe(
      [
        'stripe  14.2.0 → 17.1.0   (3 majors behind)',
        '',
        '  BREAKING  1 call site in 1 file',
        '  ✗ src/billing/subscriptions.ts:42    stripe.subscriptions.create({ items: [{ quantity }] })',
        '      Stripe.SubscriptionCreateParams#items[]#quantity removed → Stripe.SubscriptionCreateParams#items[]#quantities[] mechanical',
        '',
        '  DEPRECATED  1 call site',
        '  ! src/customers/sync.ts:15           customer.sources',
        '      Stripe.Customer#sources deprecated: use paymentMethods instead mechanical',
        '  1 low-confidence finding hidden (use --all)',
        '',
        'twilio  5.0.1 → 5.3.0',
        '  ✓ no impact on your code (12 call sites checked)',
        '',
        'lodash  4.17.20 → 4.17.21  no type declarations, cannot analyze',
        '',
        'Summary: 1 package needs attention · 2 breaking · 1 deprecated · 1 unaffected',
        '         2 of 3 findings are mechanical',
        '',
      ].join('\n'),
    );
  });

  it('shows unverified findings in their own section and counts them apart', () => {
    const unverified: CheckReport = {
      ...report,
      summary: { ...report.summary, breaking: 0, unverified: 1 },
      packages: [
        {
          ...(report.packages[0] as PackageReport),
          findings: [
            finding({
              severity: 'unverified',
              reason:
                'removed; the declaration file has unresolved imports in the target, compile check inconclusive',
              change: { path: 'Stripe#x', kind: 'removed' },
              usage: { file: 'src/x.ts', line: 3, snippet: 'x' },
            }),
          ],
        },
      ],
    };
    const out = formatCheck(unverified, { color: false });
    expect(out).toContain('  UNVERIFIED  1 call site (verification incomplete)');
    expect(out).toContain('  ? src/x.ts:3');
    expect(out).toContain('      Stripe#x removed');
    expect(out).not.toContain('✓ no impact');
    expect(out).toContain('· 0 breaking · 1 deprecated · 1 unverified · 1 unaffected');
  });

  it('titles a release group with its member count', () => {
    const [stripe] = report.packages as [PackageReport];
    const grouped: CheckReport = {
      ...report,
      packages: [
        {
          ...stripe,
          name: '@aws-sdk/*',
          members: [
            { name: '@aws-sdk/client-s3', installed: '3.1076.0', target: '3.1141.0' },
            { name: '@aws-sdk/core', installed: '3.1076.0', target: '3.1141.0' },
          ],
          installed: '3.1076.0',
          target: '3.1141.0',
          majorsBehind: 0,
          findings: [],
          status: 'safe',
        },
      ],
    };
    expect(formatCheck(grouped, { color: false })).toContain(
      '@aws-sdk/* (2 packages)  3.1076.0 → 3.1141.0',
    );
  });

  it('is quiet about workspace links and private packages, and names DefinitelyTyped packages', () => {
    const [stripe] = report.packages as [PackageReport];
    const quiet: CheckReport = {
      ...report,
      packages: [
        {
          ...stripe,
          name: '@me/shared',
          installed: 'link:../shared',
          status: 'workspace',
          findings: [],
          notes: [],
        },
        {
          ...stripe,
          name: '@me/private',
          status: 'private',
          findings: [],
          notes: ['not on the registry'],
        },
        { ...stripe, name: '@me/other', status: 'private', findings: [], notes: ['registry auth'] },
        { ...stripe, name: 'pg', status: 'no-types', findings: [], notes: ['types in @types/pg'] },
      ],
    };
    const out = formatCheck(quiet, { color: false });
    expect(out).not.toContain('@me/shared');
    expect(out).toContain('pg  14.2.0 → 17.1.0  types in @types/pg, not analyzed');
    expect(out).toContain(
      '2 private packages skipped: registry auth or not on the registry (@me/other, @me/private)',
    );
  });

  it('groups packages by workspace when there is more than one', () => {
    const [stripe, twilio, lodash] = report.packages as [
      PackageReport,
      PackageReport,
      PackageReport,
    ];
    const multi: CheckReport = {
      ...report,
      workspaces: ['.', 'packages/app'],
      packages: [
        { ...stripe, workspace: '.', findings: [], status: 'safe' },
        { ...twilio, workspace: 'packages/app' },
        { ...lodash, workspace: 'packages/app', notes: ['up to date'], status: 'safe' },
      ],
    };
    const out = formatCheck(multi, { color: false });
    expect(out.split('\n').filter((l) => l !== '')).toEqual([
      '(root)',
      'stripe  14.2.0 → 17.1.0   (3 majors behind)',
      '  ✓ no impact on your code (34 call sites checked)',
      'packages/app',
      'twilio  5.0.1 → 5.3.0',
      '  ✓ no impact on your code (12 call sites checked)',
      'Summary: 1 package needs attention · 2 breaking · 1 deprecated · 1 unaffected',
      '         2 of 3 findings are mechanical',
    ]);
  });

  it('never lists info findings, even with --all; they only count as hidden', () => {
    const info: CheckReport = {
      ...report,
      packages: [
        {
          ...(report.packages[0] as PackageReport),
          findings: [
            finding({
              severity: 'info',
              confidence: 0.3,
              fixability: 'none',
              change: { path: 'Stripe#demoted', kind: 'type' },
              usage: { file: 'src/demoted.ts', line: 2, snippet: 'demoted' },
            }),
          ],
          status: 'safe',
        },
      ],
    };
    for (const all of [false, true]) {
      const out = formatCheck(info, { color: false, all });
      expect(out).not.toContain('src/demoted.ts');
      expect(out).toContain('✓ no impact on your code');
      expect(out).toContain('1 low-confidence finding hidden (use --all)');
    }
  });

  it('--all shows low-confidence findings and never additive ones', () => {
    const out = formatCheck(report, { color: false, all: true });
    expect(out).toContain('src/low.ts:9');
    expect(out).toContain('(40%)');
    expect(out).not.toContain('src/z.ts');
    expect(out).not.toContain('hidden');
  });
});

describe('shared entries and quiet notes', () => {
  it('lists a catalog entry once under the shared section, with every note', () => {
    const [stripe] = report.packages as [PackageReport];
    const shared: CheckReport = {
      ...report,
      workspaces: ['.', 'packages/api', 'packages/shared'],
      packages: [
        {
          ...stripe,
          workspace: '*',
          workspaces: ['packages/api', 'packages/shared'],
          source: 'catalog',
          findings: [],
          status: 'safe',
          notes: [
            '2 unresolved modules inside stripe, results may be incomplete',
            '34 pre-existing type errors at the installed version (subtracted)',
          ],
        },
      ],
    };
    const quiet = formatCheck(shared, { color: false });
    expect(quiet).toContain('(shared across workspaces)');
    expect(quiet).toContain(
      'stripe  14.2.0 → 17.1.0   (3 majors behind)   · catalog · packages/api, packages/shared',
    );
    expect(quiet).toContain('34 pre-existing type errors');
    expect(quiet).toContain('unresolved modules');
  });

  it('never prints a green check over unanalyzed sites', () => {
    const [stripe] = report.packages as [PackageReport];
    const site = (line: number) => ({ file: 'src/legacy.js', line, kind: 'require' as const });
    const partial: CheckReport = {
      ...report,
      packages: [
        {
          ...stripe,
          findings: [],
          status: 'partial',
          callSitesChecked: 12,
          unanalyzed: [site(3), site(9)],
          notes: ['2 sites not analyzed (require/dynamic import)'],
        },
        {
          ...stripe,
          name: 'file-type',
          findings: [],
          status: 'unknown',
          callSitesChecked: 0,
          unanalyzed: [site(1), site(2), site(3), site(4)],
          notes: [],
        },
      ],
      summary: { ...report.summary, partiallyAnalyzed: 2 },
    };
    const out = formatCheck(partial, { color: false });
    expect(out).toContain('  ✓ no impact in 12 analyzed sites · ⚠ 2 sites not analyzed');
    expect(out).toContain('  ? unknown: 4 of 4 sites not analyzed (require/dynamic import)');
    expect(out).not.toContain('no impact on your code');
    expect(out).toContain('· 2 partially analyzed');
  });
});

describe('skip reasons', () => {
  it('prints the real reason a package could not be diffed', () => {
    const [stripe] = report.packages as [PackageReport];
    const untyped: CheckReport = {
      ...report,
      packages: [
        {
          ...stripe,
          name: 'joi',
          installed: '13.7.0',
          target: '17.13.3',
          status: 'no-types',
          findings: [],
          notes: [
            'installed 13.7.0 ships no type declarations, 17.13.3 does; only load sites and the manifest were analyzed',
          ],
        },
      ],
    };
    expect(formatCheck(untyped, { color: false })).toContain(
      'joi  13.7.0 → 17.13.3  installed 13.7.0 ships no type declarations, 17.13.3 does; only load sites and the manifest were analyzed',
    );
  });
});

it('runtime notes hide unused keys, count them once across loaders, and --all lists them', () => {
  const p = {
    ...(report.packages[0] as PackageReport),
    runtime: [
      {
        package: 'stripe',
        node: 'v22.20.0',
        nodeSource: 'repository' as const,
        usedKeys: ['used'],
        changes: [
          {
            kind: 'key-removed' as const,
            key: 'used',
            loader: 'require' as const,
            detail: 'used removed',
          },
          {
            kind: 'key-removed' as const,
            key: 'unused',
            loader: 'require' as const,
            detail: 'unused removed',
          },
          {
            kind: 'key-removed' as const,
            key: 'unused',
            loader: 'import' as const,
            detail: 'unused removed',
          },
        ],
      },
    ],
  };
  const r = { ...report, packages: [p] };
  expect(formatCheck(r)).toContain('used removed');
  expect(formatCheck(r)).not.toContain(': unused removed');
  expect(formatCheck(r)).toContain('1 unused exports removed');
  expect(formatCheck(r, { all: true })).toContain(': unused removed');
});

it('prints one native warning for a package regardless of how many findings it contains', () => {
  const p: PackageReport = {
    ...(report.packages[0] as PackageReport),
    runtime: [
      {
        package: 'stripe',
        node: 'v22.20.0',
        nodeSource: 'current',
        changes: [],
        inconclusive: 'target copy: install script "install" is never run',
      },
    ],
  };
  const text = formatCheck({ ...report, packages: [p] });
  expect(text.match(/native package, runtime probe skipped/g)).toHaveLength(1);
});
