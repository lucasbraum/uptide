import { ts } from 'ts-morph';
import { expect, it } from 'vitest';
import { resolveCompiler } from './verify.js';

it('prefers the consumer compiler to the bundled compiler', () => {
  const consumer = { ...ts, version: 'consumer' };
  expect(
    resolveCompiler('/consumer', ts, (path) => {
      expect(path).toBe('/consumer/package.json');
      return consumer;
    }),
  ).toBe(consumer);
});
it('uses the bundled compiler when the consumer has no TypeScript', () => {
  expect(
    resolveCompiler('/consumer', ts, () => {
      throw new Error('not installed');
    }),
  ).toBe(ts);
});
it('explains how to recover if neither compiler exists', () => {
  expect(() =>
    resolveCompiler('/consumer', null as unknown as typeof ts, () => {
      throw new Error('missing');
    }),
  ).toThrow('TypeScript compiler unavailable');
});
