import { expect, it } from 'vitest';
import type { PackageReport } from '../domain/report.js';
import { verdictOf } from './verdict.js';

const report = (over: Partial<PackageReport>): PackageReport =>
  ({
    name: 'zod',
    workspace: '.',
    installed: '3.25.76',
    target: '4.6.5',
    latest: '4.6.5',
    findings: [],
    status: 'safe',
    ...over,
  }) as PackageReport;
const compile = {
  baselineErrors: 0,
  unresolvedInTarget: [],
  unresolvedFiles: [],
  unattributed: [],
};

it('states the breaking count and what verified it, zero included', () => {
  expect(verdictOf(report({ compile: { ...compile, newErrors: 0 } }))).toEqual({
    breaking: 0,
    compiledAgainst: '4.6.5',
    newErrors: 0,
    summary: '0 breaking · compiled against 4.6.5: 0 new type errors',
  });
  const breaking = { severity: 'breaking' } as PackageReport['findings'][number];
  expect(
    verdictOf(report({ findings: [breaking, breaking], compile: { ...compile, newErrors: 1 } }))
      .summary,
  ).toBe('2 breaking · compiled against 4.6.5: 1 new type error');
});

it('says why the types were not verified, and keeps a stored report without a count honest', () => {
  expect(
    verdictOf(report({ compile: { ...compile, skipped: 'invalid tsconfig: x' } })).summary,
  ).toBe('0 breaking · types not verified: invalid tsconfig: x');
  expect(verdictOf(report({}), 'compile check off (--no-compile)')).toEqual({
    breaking: 0,
    notVerified: 'compile check off (--no-compile)',
    summary: '0 breaking · types not verified: compile check off (--no-compile)',
  });
  // Stored before newErrors was kept: it was compiled, the count is unknown, none is invented.
  expect(verdictOf(report({ compile })).summary).toBe('0 breaking · compiled against 4.6.5');
});
