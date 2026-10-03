import { describe, expect, it } from 'vitest';
import {
  callSignature,
  constructSignature,
  element,
  indexSignature,
  instanceMember,
  joinPath,
  leafOf,
  parentOf,
  scoped,
  splitPath,
  staticMember,
  topLevel,
} from './path.js';

describe('path builders', () => {
  it('builds the shapes documented in architecture.md', () => {
    const params = staticMember('Stripe', 'SubscriptionCreateParams');
    expect(params).toBe('Stripe.SubscriptionCreateParams');
    const items = instanceMember(params, 'items');
    expect(element(items)).toBe('Stripe.SubscriptionCreateParams#items[]');
    expect(instanceMember(element(items), 'quantity')).toBe(
      'Stripe.SubscriptionCreateParams#items[]#quantity',
    );
    expect(indexSignature('Headers', 'string')).toBe('Headers#[string]');
    expect(callSignature('Parser')).toBe('Parser#()');
    expect(constructSignature('Parser')).toBe('Parser.new()');
    expect(scoped('express', instanceMember('Request', 'user'))).toBe('"express":Request#user');
  });

  it('quotes names that are not identifiers', () => {
    expect(instanceMember('Headers', 'content-type')).toBe('Headers#"content-type"');
    expect(instanceMember('X', 'a.b#c')).toBe('X#"a.b#c"');
    expect(topLevel('default')).toBe('default');
  });
});

describe('splitPath / joinPath', () => {
  const cases = [
    'Stripe',
    'Stripe.SubscriptionCreateParams#items[]#quantity',
    'Headers#"content-type"',
    'X#"a.b#c"#d',
    '"express":Request#user',
    '"./server":Client.create',
    'Parser.new()',
    'Headers#[string]',
  ];
  for (const path of cases) {
    it(`round-trips ${path}`, () => {
      expect(joinPath(splitPath(path))).toBe(path);
    });
  }

  it('separates scope from segments', () => {
    expect(splitPath('"express":Request#user')).toEqual({
      scope: 'express',
      segments: ['Request', '#user'],
    });
    expect(splitPath('A.b#c[]#d')).toEqual({ segments: ['A', '.b', '#c', '[]', '#d'] });
  });
});

describe('parentOf / leafOf', () => {
  it('walks up one level at a time', () => {
    const p = 'Stripe.SubscriptionCreateParams#items[]#quantity';
    expect(parentOf(p)).toBe('Stripe.SubscriptionCreateParams#items[]');
    expect(parentOf(parentOf(p) as string)).toBe('Stripe.SubscriptionCreateParams#items');
    expect(parentOf('Stripe')).toBeUndefined();
    expect(parentOf('"express":Request#user')).toBe('"express":Request');
    expect(parentOf('"express":Request')).toBeUndefined();
  });

  it('does not split inside quoted segments', () => {
    expect(parentOf('X#"a.b#c"#d')).toBe('X#"a.b#c"');
    expect(parentOf('X#"a.b#c"')).toBe('X');
    expect(leafOf('X#"a.b#c"')).toBe('a.b#c');
  });

  it('returns unquoted leaves', () => {
    expect(leafOf('Stripe.SubscriptionCreateParams#items[]#quantity')).toBe('quantity');
    expect(leafOf('Parser.new()')).toBe('new()');
    expect(leafOf('A#b[]')).toBe('[]');
    expect(leafOf('Stripe')).toBe('Stripe');
  });
});
