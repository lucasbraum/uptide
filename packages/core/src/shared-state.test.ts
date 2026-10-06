import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { loadedRepo } from './adapters/typescript/repo.js';
import { resetSharedState } from './shared-state.js';

const CONSUMER = resolve(import.meta.dirname, '../../../fixtures/repos/synthetic-consumer');

it('discards the consumer program on reset: the next package gets a fresh program and checker', () => {
  const before = loadedRepo(CONSUMER);
  // Cached between packages while nothing failed.
  expect(loadedRepo(CONSUMER)).toBe(before);
  resetSharedState();
  const after = loadedRepo(CONSUMER);
  expect(after).not.toBe(before);
  expect(after.project.getProgram()).not.toBe(before.project.getProgram());
  expect(after.project.getSourceFiles().map((f) => f.getFilePath())).toEqual(
    before.project.getSourceFiles().map((f) => f.getFilePath()),
  );
});
