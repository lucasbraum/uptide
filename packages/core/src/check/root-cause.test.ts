import { expect, it } from 'vitest';
import type { Finding, PackageReport } from '../domain/report.js';
import { planPackage } from '../fix/plan.js';
import { sitesOf } from './check.js';
import { groupRootCauses } from './root-cause.js';

it('groups missing TypeScript API members without losing sites or unrelated diagnostics', () => {
  const finding = (line: number, code = 2339): Finding => ({
    change: {
      package: 'typescript',
      from: '6.0.3',
      to: '7.0.2',
      path: `member${line}`,
      kind: 'removed',
      severity: 'breaking',
      source: 'types',
      confidence: 1,
    },
    usage: {
      file: 'api.ts',
      line,
      column: 1,
      endLine: line,
      endColumn: 4,
      symbolPath: `member${line}`,
      access: 'read',
      via: 'direct',
      snippet: 'ts.member',
      compileCode: code,
      compileError: 'missing member',
    },
    severity: 'breaking',
    confidence: 1,
    fixability: 'assisted',
    reason: 'missing',
    evidence: 'compiler',
  });
  const report: PackageReport = {
    name: 'typescript',
    installed: '6.0.3',
    target: '7.0.2',
    latest: '7.0.2',
    workspace: '.',
    majorsBehind: 1,
    findings: [finding(1), finding(2), finding(3, 2345)],
    status: 'breaking',
    callSitesChecked: 3,
    unanalyzed: [],
    notes: [],
    timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
  };
  groupRootCauses(report);
  expect(report.findings).toHaveLength(2);
  expect(sitesOf(report.findings[0] as Finding)).toBe(2);
  expect(report.findings[0]?.downstream?.map((s) => s.line)).toEqual([1, 2]);
  expect(planPackage(report).find((g) => g.rule === 'typescript-no-js-api')).toMatchObject({
    sites: 2,
    title: 'TypeScript 7 has no JavaScript compiler API in its main entry',
  });
  const withoutEvidence = {
    ...report,
    findings: [finding(1), { ...finding(2), evidence: undefined }],
  };
  groupRootCauses(withoutEvidence);
  expect(withoutEvidence.findings[0]?.change.kind).toBe('removed');
});
