import { describe, expect, it } from 'vitest';
import { consumerCopySatisfies, scopeOf } from './target-deps.js';

describe('consumerCopySatisfies', () => {
  it('accepts a consumer copy inside the range', () => {
    expect(consumerCopySatisfies('axios', 'form-data', '^4.0.0', '4.0.1')).toBe(true);
    expect(consumerCopySatisfies('axios', 'form-data', '^4.0.0', '3.0.1')).toBe(false);
    expect(consumerCopySatisfies('axios', 'form-data', '^4.0.0', undefined)).toBe(false);
  });

  it("never accepts the consumer's copy of a same-scope package, even inside the range", () => {
    expect(consumerCopySatisfies('vitest', '@vitest/runner', '^5.0.0', '5.0.0')).toBe(false);
    expect(consumerCopySatisfies('@scope/widget', '@scope/core', '^1', '1.4.0')).toBe(false);
    expect(consumerCopySatisfies('@scope/widget', '@other/core', '^1', '1.4.0')).toBe(true);
  });

  it('scope of an unscoped package is @<name>', () => {
    expect(scopeOf('vitest')).toBe('@vitest');
    expect(scopeOf('@babel/core')).toBe('@babel');
  });
});
