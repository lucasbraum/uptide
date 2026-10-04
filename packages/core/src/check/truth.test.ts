import { describe, expect, it } from 'vitest';
import type { CheckReport, Finding, PackageReport } from '../domain/report.js';
import { formatTruthTable, scoreAgainstTruth } from './truth.js';

const finding = (
  path: string,
  file: string,
  line: number,
  extra: Partial<Finding> = {},
): Finding => ({
  change: {
    package: 'zod',
    from: '3',
    to: '4',
    path,
    kind: 'signature',
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
    symbolPath: path,
    access: 'call',
    snippet: '',
    via: 'direct',
  },
  severity: 'breaking',
  confidence: 1,
  fixability: 'assisted',
  reason: '',
  ...extra,
});

describe('scoreAgainstTruth', () => {
  it('counts sites, not anchors; attribution needs a diff change', () => {
    const pkg: PackageReport = {
      workspace: 'packages/api',
      name: 'zod',
      installed: '3',
      latest: '4',
      target: '4',
      majorsBehind: 1,
      findings: [
        finding('string', 'src/a.ts', 12),
        finding('TS2769', 'src/a.ts', 21),
        finding('cause:parseBody', 'src/lib.ts', 5, {
          change: {
            package: 'zod',
            from: '3',
            to: '4',
            path: 'cause:parseBody',
            kind: 'cause',
            severity: 'breaking',
            source: 'types',
            confidence: 1,
          },
          downstream: [{ file: 'packages/api/src/b.ts', line: 9, code: 18046, message: '' }],
        }),
        finding('ZodString#ip', 'src/c.ts', 3, { severity: 'info' }),
      ],
      callSitesChecked: 4,
      unanalyzed: [],
      status: 'breaking',
      notes: [],
      timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
    };
    const report: CheckReport = {
      repo: '/r',
      workspaces: ['.', 'packages/api'],
      packages: [pkg],
      summary: {
        packagesNeedingAttention: 1,
        breaking: 3,
        deprecated: 0,
        unverified: 0,
        unaffected: 0,
        notImported: 0,
        partiallyAnalyzed: 0,
        autoFixable: 0,
        skippedForTime: 0,
        failed: 0,
      },
    };
    const [score] = scoreAgainstTruth(report, [
      {
        package: 'zod',
        target: '4',
        workspace: 'packages/api',
        errors: [
          { file: 'packages/api/src/a.ts', line: 12, code: 2769 },
          { file: 'packages/api/src/a.ts', line: 21, code: 2769 },
          { file: 'packages/api/src/d.ts', line: 1, code: 2769 },
        ],
      },
    ]);
    expect(score).toMatchObject({
      real: 3,
      predicted: 3,
      hits: 2,
      attributed: 1,
      anchors: 1,
      misses: ['packages/api/src/d.ts:1'],
      falsePositives: ['packages/api/src/b.ts:9'],
    });
    expect(score?.precision).toBeCloseTo(2 / 3);
    expect(score?.recall).toBeCloseTo(2 / 3);
    expect(score?.attributionRate).toBeCloseTo(1 / 3);
    expect(score?.runtime).toBeUndefined();
  });

  it('scores a pack finding against the runtime sites, never as a compiler false positive', () => {
    const unpinned = (file: string, line: number): Finding =>
      finding('Stripe.StripeConfig#apiVersion', file, line, {
        change: {
          package: 'stripe',
          from: '14.25.0',
          to: '23.0.0',
          path: 'Stripe.StripeConfig#apiVersion',
          kind: 'type',
          severity: 'breaking',
          source: 'pack',
          confidence: 1,
        },
        rule: 'api-version-unpinned',
        fixability: 'manual',
      });
    const pkg = (workspace: string, findings: Finding[]): PackageReport => ({
      workspace,
      name: 'stripe',
      installed: '14.25.0',
      latest: '23.0.0',
      target: '23.0.0',
      majorsBehind: 9,
      findings,
      callSitesChecked: findings.length,
      unanalyzed: [],
      status: 'breaking',
      notes: [],
      timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
    });
    const report: CheckReport = {
      repo: '/r',
      workspaces: ['packages/core', 'worker'],
      packages: [
        pkg('packages/core', [unpinned('src/stripe.ts', 4)]),
        pkg('worker', [unpinned('src/meter.ts', 44), finding('TS2694', 'src/x.test.ts', 9)]),
      ],
      summary: {
        packagesNeedingAttention: 1,
        breaking: 3,
        deprecated: 0,
        unverified: 0,
        unaffected: 0,
        notImported: 0,
        partiallyAnalyzed: 0,
        autoFixable: 0,
        skippedForTime: 0,
        failed: 0,
      },
    };
    const scores = scoreAgainstTruth(report, [
      {
        package: 'stripe',
        target: '23.0.0',
        workspace: 'packages/core',
        errors: [],
        runtime: [{ file: 'packages/core/src/stripe.ts', line: 4, rule: 'api-version-unpinned' }],
      },
      {
        package: 'stripe',
        target: '23.0.0',
        workspace: 'worker',
        errors: [],
        runtime: [{ file: 'worker/src/other.ts', line: 1, rule: 'api-version-unpinned' }],
      },
    ]);
    expect(scores[0]).toMatchObject({
      predicted: 0,
      falsePositives: [],
      runtime: { real: 1, predicted: 1, hits: 1, misses: [], falsePositives: [] },
    });
    expect(scores[1]).toMatchObject({
      predicted: 1,
      falsePositives: ['worker/src/x.test.ts:9'],
      runtime: {
        real: 1,
        predicted: 1,
        hits: 0,
        misses: ['worker/src/other.ts:1 api-version-unpinned'],
        falsePositives: ['worker/src/meter.ts:44 api-version-unpinned'],
      },
    });
    const table = formatTruthTable(scores);
    expect(table).toContain('runtime 1/1 (1 predicted)');
    expect(table).toContain(
      'stripe / worker runtime misses: worker/src/other.ts:1 api-version-unpinned',
    );
  });
});
