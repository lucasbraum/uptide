import { describe, expect, it } from 'vitest';
import type { Change } from '../domain/change.js';
import { foldForDisplay } from './fold.js';

const change = (c: Partial<Change> & { path: string; kind: Change['kind'] }): Change => ({
  package: 'p',
  from: '1',
  to: '2',
  severity: 'breaking',
  source: 'types',
  confidence: 1,
  ...c,
});

describe('foldForDisplay', () => {
  it('hides members of a removed ancestor, alias duplicates and non-public symbols', () => {
    const changes = [
      change({ path: 'Axios', kind: 'removed' }),
      change({ path: 'Axios#get', kind: 'removed' }),
      change({ path: 'Axios#interceptors#request', kind: 'removed' }),
      change({ path: 'parse', kind: 'signature' }),
      change({ path: 'z.parse', kind: 'signature', aliasOf: 'parse' }),
      change({ path: 'other', kind: 'signature', aliasOf: 'missing' }),
      change({ path: 'C#warn', kind: 'signature', visibility: 'protected' }),
    ];
    const folded = foldForDisplay(changes);
    expect(folded.shown.map((c) => c.path)).toEqual(['Axios', 'parse', 'other']);
    expect(folded.hidden.impliedByRemoval.map((c) => c.path)).toEqual([
      'Axios#get',
      'Axios#interceptors#request',
    ]);
    expect(folded.hidden.aliasDuplicates.map((c) => c.path)).toEqual(['z.parse']);
    expect(folded.hidden.nonPublic.map((c) => c.path)).toEqual(['C#warn']);
  });

  it('keeps an alias change when the canonical path did not change the same way', () => {
    const folded = foldForDisplay([
      change({ path: 'z.parse', kind: 'signature', aliasOf: 'parse' }),
    ]);
    expect(folded.shown).toHaveLength(1);
  });
});
