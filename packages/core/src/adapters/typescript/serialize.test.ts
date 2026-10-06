import { ts } from 'ts-morph';
import { expect, it } from 'vitest';
import { printCompilerNode } from './serialize.js';

it('prints cleanly after a print that threw halfway', () => {
  // The printer writes `Partial<`, then fails on the argument: a stack overflow did this on main,
  // and every later print started with what the failed one had written.
  const f = ts.factory;
  const boom = f.createIdentifier('Boom');
  Object.defineProperty(boom, 'escapedText', {
    get() {
      throw new RangeError('Maximum call stack size exceeded');
    },
  });
  expect(() =>
    printCompilerNode(f.createTypeReferenceNode('Partial', [f.createTypeReferenceNode(boom)])),
  ).toThrow('Maximum call stack size exceeded');
  expect(printCompilerNode(f.createTypeReferenceNode('Logger'))).toBe('Logger');
});
