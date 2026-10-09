import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { CheckReport } from '../../domain/report.js';
import { aiPack } from '../ai/index.js';
import type { PackVerification } from '../contract.js';
import { definePack } from '../contract.js';
import { registeredPacks } from '../index.js';
import { predictedSites, scoreSites, testPack } from './pack-test.js';

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

it('scores an anchored finding at its declaration; the call sites under it are neither true nor false positives', () => {
  const pack = definePack({
    meta: {
      package: 'react',
      from: '>=18 <19',
      to: '>=19 <20',
      sources: [{ title: 'guide', url: 'https://example.com' }],
      maintainer: 'uptide-dev',
    },
    rules: [],
    instructions: '',
  });
  const decl = { file: 'packages/editor/src/lib/hooks/useTransform.ts', line: 6 };
  const call = { file: 'apps/examples/src/x.tsx', line: 11 };
  const report = {
    packages: [
      {
        workspace: '*',
        name: 'react',
        findings: [
          {
            change: { path: 'cause:ref', kind: 'cause' },
            usage: decl,
            anchorOnly: true,
            callSites: 2,
            downstream: [
              { ...call, code: 2345, message: 'x' },
              { file: 'packages/tldraw/src/y.tsx', line: 59, code: 2345, message: 'x' },
            ],
          },
        ],
        // A call site that is also planned on its own (say, by a rule's detect) is still evidence.
        plan: [
          { rule: 'cause:ref', severity: 'breaking', locations: [decl] },
          { rule: 'TS2345', severity: 'breaking', locations: [call] },
        ],
      },
    ],
  } as unknown as CheckReport;
  const predicted = predictedSites(report, pack);
  expect(predicted.map((s) => `${s.file}:${s.line}`)).toEqual([`${decl.file}:${decl.line}`]);
  const score = scoreSites(predicted, [{ ...decl, rule: 'generic' }]);
  expect(score.falsePositives).toEqual([]);
  expect(score.falseNegatives).toEqual([]);
});
