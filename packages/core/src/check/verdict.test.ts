import { expect, it } from 'vitest';
import type { PackageReport } from '../domain/report.js';
import { coverageLine, verdictOf } from './verdict.js';

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

it('says the types are partly verified when some files that use the package were not compiled', () => {
  const coverage = {
    compiled: 12,
    total: 40,
    workspaces: 2,
    skipped: [
      { reason: 'not in the workspace tsconfig', count: 20 },
      { reason: 'most files cannot resolve their imports at the installed version', count: 8 },
    ],
  };
  expect(coverageLine(coverage)).toBe(
    'compiled 12 of 40 files in 2 workspaces; skipped: not in the workspace tsconfig (20), most files cannot resolve their imports at the installed version (8)',
  );
  expect(verdictOf(report({ compile: { ...compile, newErrors: 0, coverage } }))).toEqual({
    breaking: 0,
    compiledAgainst: '4.6.5',
    newErrors: 0,
    partlyVerified: coverageLine(coverage),
    summary: `0 breaking · types partly verified: ${coverageLine(coverage)}`,
  });
  // Every file compiled: the clean verdict, with the coverage printed beside it.
  const full = { compiled: 1, total: 1, workspaces: 1, skipped: [] };
  expect(coverageLine(full)).toBe('compiled 1 of 1 file in 1 workspace');
  expect(verdictOf(report({ compile: { ...compile, newErrors: 0, coverage: full } })).summary).toBe(
    '0 breaking · compiled against 4.6.5: 0 new type errors',
  );
});
