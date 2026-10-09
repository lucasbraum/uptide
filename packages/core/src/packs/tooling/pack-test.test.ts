import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { aiPack } from '../ai/index.js';
import type { PackVerification } from '../contract.js';
import { registeredPacks } from '../index.js';
import { testPack } from './pack-test.js';

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
