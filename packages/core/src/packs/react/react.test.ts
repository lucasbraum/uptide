import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { runFixtures } from '../tooling/fixtures.js';
import { reactPack } from './index.js';

it('react: every fixture rewrites and detects exactly its marked sites', () => {
  const result = runFixtures(reactPack, fileURLToPath(new URL('.', import.meta.url)));
  expect(result.cases.length).toBeGreaterThan(0);
  expect(result.unknown).toEqual([]);
  expect(result.rewriteFailures).toEqual([]);
  expect(result.falsePositives).toEqual([]);
  expect(result.falseNegatives).toEqual([]);
});
