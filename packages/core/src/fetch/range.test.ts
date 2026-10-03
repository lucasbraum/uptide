import { describe, expect, it } from 'vitest';
import { maxSatisfying, satisfies } from './range.js';

describe('satisfies', () => {
  it.each([
    ['1.2.3', '1.2.3', true],
    ['2.1.2', '>= 2.1.2 < 3.0.0', true],
    ['3.0.0', '>= 2.1.2 < 3.0.0', false],
    ['1.2.4', '~> 1.2.3', true],
    ['1.2.4', '= v1.2.4', true],
    ['1.3.0-beta.1', '>=1.2.0-beta.0 <2', false],
    ['1.2.0-beta.1', '>=1.2.0-beta.0 <2', true],
    ['1.2.4', '^ 1.2.3 || 2.x', true],
    ['1.2.4', '1.2.3', false],
    ['1.9.0', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.2.5', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.5.0', '~1', true],
    ['1.5.0', '1.x', true],
    ['2.0.0', '1.x', false],
    ['1.5.0', '1', true],
    ['3.1.0', '*', true],
    ['3.1.0', '', true],
    ['1.5.0', '>=1.2.0 <2', true],
    ['2.0.0', '>=1.2.0 <2', false],
    ['2.0.0', '>1', true],
    ['1.5.0', '>1', false],
    ['1.5.0', '1.2.3 - 2.3.4', true],
    ['2.3.5', '1.2.3 - 2.3.4', false],
    ['2.9.0', '1.2.3 - 2', true],
    ['3.0.0', '^1 || ^3', true],
    ['2.0.0', '^1 || ^3', false],
    ['2.0.0-beta.1', '^1', false],
    ['2.0.0-beta.1', '^2.0.0-beta.0', true],
    ['1.0.0', 'workspace:*', false],
    ['1.0.0', 'catalog:', false],
    ['1.0.0', 'npm:other@^1', false],
    ['1.0.0', 'latest', false],
  ])('%s in %s → %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
});

describe('maxSatisfying', () => {
  it('picks the highest version inside the range', () => {
    expect(maxSatisfying(['1.0.0', '1.4.2', '2.0.0-rc.1', '2.0.0', '1.9.0'], '^1')).toBe('1.9.0');
    expect(maxSatisfying(['1.0.0', '2.0.0-rc.1'], '^2')).toBeUndefined();
  });
});
