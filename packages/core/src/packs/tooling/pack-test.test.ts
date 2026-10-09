import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { CheckReport, Finding } from '../../domain/report.js';
import { aiPack } from '../ai/index.js';
import type { PackVerification } from '../contract.js';
import { registeredPacks } from '../index.js';
import { predictedSites, testPack } from './pack-test.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const verification = JSON.parse(
  readFileSync(fileURLToPath(new URL('../ai/verification.json', import.meta.url)), 'utf8'),
) as PackVerification;

it('fails a pack with a companion that has no source, and scores nothing', async () => {
  const pack = { ...aiPack, companions: [{ name: 'ai-sdk-ollama', source: '' }] };
  const report = await testPack({ dir: 'ai', pack, verification }, { root, fixturesOnly: true });
  expect(report.problems).toEqual([
    'companions[0] "ai-sdk-ollama": source must be the https URL of the official migration guide or changelog that says it moves with ai',
  ]);
  expect(report.passed).toBe(false);
});

it('passes every registered pack: each companion it names carries its source', async () => {
  for (const entry of registeredPacks()) {
    const report = await testPack(entry, { root, fixturesOnly: true });
    expect(report.problems, entry.pack.name).toEqual([]);
  }
});

it('scores an anchored finding at its anchor; the call sites listed as evidence are not sites', () => {
  const finding = (file: string, line: number, over: Partial<Finding> = {}): Finding => ({
    change: {
      package: 'ai',
      from: '6.0.0',
      to: '7.0.0',
      path: 'TS2345',
      kind: 'type',
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
      symbolPath: 'TS2345',
      access: 'read',
      via: 'inferred',
      snippet: '',
    },
    severity: 'breaking',
    confidence: 1,
    fixability: 'unknown',
    reason: 'compile error',
    ...over,
  });
  const anchor = finding('packages/lib/hook.ts', 6, {
    change: { ...finding('', 0).change, kind: 'cause', path: 'cause:ref' },
    anchorOnly: true,
    downstream: [
      { file: 'apps/a/src/x.tsx', line: 11, code: 2345, message: 'm' },
      { file: 'apps/b/src/y.tsx', line: 59, code: 2345, message: 'm' },
    ],
  });
  // A pack finding that happens to land on an evidence line is not scored either.
  const onEvidence = finding('apps/a/src/x.tsx', 11, { rule: 'tool-context' });
  const report: CheckReport = {
    repo: '/repo',
    workspaces: ['apps/a', 'apps/b', 'packages/lib'],
    packages: [
      {
        workspace: '*',
        name: 'ai',
        installed: '6.0.0',
        latest: '7.0.0',
        target: '7.0.0',
        majorsBehind: 1,
        findings: [anchor, onEvidence],
        callSitesChecked: 3,
        unanalyzed: [],
        status: 'breaking',
        notes: [],
        timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
        plan: [
          {
            rule: 'tool-context',
            title: 't',
            severity: 'breaking',
            by: { rule: 0, agent: 2, manual: 0 },
            sites: 2,
            fixes: 2,
            locations: [
              { file: 'apps/a/src/x.tsx', line: 11 },
              { file: 'packages/lib/hook.ts', line: 6 },
            ],
            detail: '',
          },
        ],
      },
    ],
    summary: {
      packagesNeedingAttention: 1,
      breaking: 1,
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
  expect(predictedSites(report, aiPack).map((s) => `${s.file}:${s.line} ${s.rule}`)).toEqual([
    'packages/lib/hook.ts:6 tool-context',
  ]);
});
