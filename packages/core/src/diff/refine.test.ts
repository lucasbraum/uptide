import { describe, expect, it } from 'vitest';
import type { TypeComparison } from '../domain/adapter.js';
import type { ApiSurface, ApiSymbol } from '../domain/surface.js';
import type { UnclassifiedChange } from './classify.js';
import { normalizeTypeParams, refineWithTypes, WIDENED_NOTE } from './refine.js';

const surface = (
  symbols: (Partial<ApiSymbol> & { path: string; kind: ApiSymbol['kind'] })[],
): ApiSurface => ({
  package: 'p',
  version: '2',
  extractedAt: '',
  adapter: 'fake',
  symbols: symbols.map((s) => ({ signature: '', exportedFrom: ['.'], ...s })),
});

const change = (path: string, kind: 'signature' | 'type' = 'type'): UnclassifiedChange => ({
  package: 'p',
  from: '1',
  to: '2',
  path,
  kind,
  source: 'types',
  confidence: 1,
  before: 'x',
  after: 'y',
});

const cmp = (
  relation: TypeComparison['relation'],
  extra: Partial<TypeComparison> = {},
): TypeComparison => ({
  relation,
  callable: false,
  ...extra,
});

describe('refineWithTypes', () => {
  it('drops equivalent changes and leaves unresolved ones alone', () => {
    const s = surface([
      { path: 'a', kind: 'property' },
      { path: 'b', kind: 'property' },
    ]);
    const out = refineWithTypes([change('a'), change('b')], new Map([['a', cmp('equivalent')]]), s);
    expect(out.map((c) => c.path)).toEqual(['b']);
    expect(out[0]?.severity).toBeUndefined();
  });

  it('unknown-direction property: widened additive 0.6 with note, narrowed breaking 0.7', () => {
    const s = surface([
      { path: 'P#a', kind: 'property' },
      { path: 'P#b', kind: 'property' },
    ]);
    const out = refineWithTypes(
      [change('P#a'), change('P#b')],
      new Map([
        ['P#a', cmp('widened')],
        ['P#b', cmp('narrowed')],
      ]),
      s,
    );
    expect(out[0]).toMatchObject({
      kind: 'widened',
      severity: 'additive',
      confidence: 0.6,
      notes: WIDENED_NOTE,
    });
    expect(out[1]).toMatchObject({ kind: 'narrowed', severity: 'breaking', confidence: 0.7 });
  });

  it('outputs invert: readonly property or variable widened is breaking, narrowed additive', () => {
    const s = surface([
      { path: 'P#r', kind: 'property', signature: 'readonly string' },
      { path: 'v', kind: 'variable' },
    ]);
    const out = refineWithTypes(
      [change('P#r'), change('v')],
      new Map([
        ['P#r', cmp('widened')],
        ['v', cmp('narrowed')],
      ]),
      s,
    );
    expect(out[0]).toMatchObject({ kind: 'widened', severity: 'breaking' });
    expect(out[1]).toMatchObject({ kind: 'narrowed', severity: 'additive' });
  });

  it('callback: a parameter now always provided and a this parameter added are additive', () => {
    const s = surface([{ path: 'C#onEnd', kind: 'property' }]);
    const out = refineWithTypes(
      [change('C#onEnd')],
      new Map([
        [
          'C#onEnd',
          cmp('incompatible', {
            callable: true,
            signatures: [
              {
                parameters: [
                  {
                    name: 'headers',
                    relation: 'equivalent',
                    optionalBefore: true,
                    optionalAfter: false,
                  },
                ],
                returnType: 'equivalent',
                thisParameter: { relation: 'added', after: 'Ctx' },
              },
            ],
          }),
        ],
      ]),
      s,
    );
    expect(out[0]).toMatchObject({ severity: 'additive' });
    expect(out[0]?.notes).toBe(
      "this parameter added (Ctx); callback parameter 'headers' now always provided",
    );
  });

  it('a call-signature-only interface is a callback; one with members is called', () => {
    const s = surface([
      { path: 'Adapter', kind: 'interface' },
      { path: 'Adapter#()', kind: 'method' },
      { path: 'Instance', kind: 'interface' },
      { path: 'Instance#()', kind: 'method' },
      { path: 'Instance#get', kind: 'method' },
    ]);
    const narrowedParam = () =>
      cmp('widened', {
        callable: true,
        signatures: [
          {
            parameters: [
              { name: 'config', relation: 'narrowed', optionalBefore: false, optionalAfter: false },
            ],
            returnType: 'equivalent',
          },
        ],
      });
    const out = refineWithTypes(
      [change('Adapter#()', 'signature'), change('Instance#()', 'signature')],
      new Map([
        ['Adapter#()', narrowedParam()],
        ['Instance#()', narrowedParam()],
      ]),
      s,
    );
    expect(out[0]).toMatchObject({ severity: 'additive', confidence: 0.6 });
    expect(out[1]).toMatchObject({ severity: 'breaking' });
  });

  it('callback: widened parameter breaking, narrowed parameter additive 0.6', () => {
    const s = surface([
      { path: 'C#onA', kind: 'property' },
      { path: 'C#onB', kind: 'property' },
    ]);
    const sig = (relation: 'widened' | 'narrowed') => ({
      parameters: [{ name: 'e', relation, optionalBefore: false, optionalAfter: false }],
      returnType: 'equivalent' as const,
    });
    const out = refineWithTypes(
      [change('C#onA'), change('C#onB')],
      new Map([
        ['C#onA', cmp('incompatible', { callable: true, signatures: [sig('widened')] })],
        ['C#onB', cmp('incompatible', { callable: true, signatures: [sig('narrowed')] })],
      ]),
      s,
    );
    expect(out[0]).toMatchObject({ severity: 'breaking' });
    expect(out[0]?.notes).toMatch(/must accept more/);
    expect(out[1]).toMatchObject({ severity: 'additive', confidence: 0.6 });
  });

  it('names every differing parameter, not just the first', () => {
    const s = surface([{ path: 'f', kind: 'function' }]);
    const out = refineWithTypes(
      [change('f', 'signature')],
      new Map([
        [
          'f',
          cmp('incompatible', {
            callable: true,
            signatures: [
              {
                parameters: [
                  {
                    name: 'data',
                    relation: 'equivalent',
                    optionalBefore: false,
                    optionalAfter: false,
                  },
                  {
                    name: 'headers',
                    relation: 'equivalent',
                    optionalBefore: true,
                    optionalAfter: false,
                  },
                  { name: 'status', relation: 'added', optionalBefore: false, optionalAfter: true },
                ],
                returnType: 'equivalent',
                thisParameter: { relation: 'added', after: 'Ctx' },
              },
            ],
          }),
        ],
      ]),
      s,
    );
    expect(out[0]?.severity).toBe('breaking');
    expect(out[0]?.notes).toBe(
      "parameter 'headers' became required; this parameter added (Ctx); optional parameter 'status' added",
    );
  });

  it('callable: widened parameter additive 0.8 without note; required parameter added breaking', () => {
    const s = surface([
      { path: 'f', kind: 'function' },
      { path: 'g', kind: 'function' },
    ]);
    const out = refineWithTypes(
      [change('f', 'signature'), change('g', 'signature')],
      new Map([
        [
          'f',
          cmp('narrowed', {
            callable: true,
            signatures: [
              {
                parameters: [
                  { name: 'a', relation: 'widened', optionalBefore: false, optionalAfter: false },
                ],
                returnType: 'equivalent',
              },
            ],
          }),
        ],
        [
          'g',
          cmp('incompatible', {
            callable: true,
            signatures: [
              {
                parameters: [
                  { name: 'a', relation: 'added', optionalBefore: false, optionalAfter: false },
                ],
                returnType: 'equivalent',
              },
            ],
          }),
        ],
      ]),
      s,
    );
    expect(out[0]).toMatchObject({ kind: 'signature', severity: 'additive', confidence: 0.8 });
    expect(out[0]?.notes).toBeUndefined();
    expect(out[1]).toMatchObject({ severity: 'breaking' });
  });

  it('keeps declaration-kind changes textual unless interface/type alias are equivalent', () => {
    const s = surface([
      { path: 'X', kind: 'type' },
      { path: 'Y', kind: 'variable' },
    ]);
    const kindChange = (path: string, note: string): UnclassifiedChange => ({
      ...change(path, 'signature'),
      notes: note,
    });
    const out = refineWithTypes(
      [
        kindChange('X', 'declaration kind changed from interface to type'),
        kindChange('Y', 'declaration kind changed from class to variable'),
      ],
      new Map([
        ['X', cmp('equivalent')],
        ['Y', cmp('equivalent')],
      ]),
      s,
    );
    expect(out.map((c) => c.path)).toEqual(['Y']);
    expect(out[0]?.severity).toBeUndefined();
  });
});

describe('generic fallback', () => {
  it('renames type parameters positionally', () => {
    expect(normalizeTypeParams('<T>(v: Array<T>): T').normalized).toBe('<T0>(v: Array<T0>): T0');
    expect(normalizeTypeParams('<U extends X>(v: Array<U>): U').normalized).toBe(
      '<T0 extends X>(v: Array<T0>): T0',
    );
    expect(normalizeTypeParams('type<K, V = string> = Map<K, V>').normalized).toBe(
      'type<T0, T1 = string> = Map<T0, T1>',
    );
    expect(normalizeTypeParams('(v: string): void').generic).toBe(false);
  });

  it('drops generic signatures that only differ by type parameter names, flags the rest at 0.7', () => {
    const s = surface([
      { path: 'f', kind: 'function' },
      { path: 'g', kind: 'function' },
    ]);
    const gen = (path: string, before: string, after: string): UnclassifiedChange => ({
      ...change(path, 'signature'),
      before,
      after,
    });
    const out = refineWithTypes(
      [
        gen('f', '<T>(v: Array<T>): T', '<U>(v: Array<U>): U'),
        gen('g', '<T>(v: T): T', '<U>(v: U[]): U'),
      ],
      new Map([
        ['f', cmp('incompatible', { callable: true })],
        ['g', cmp('incompatible', { callable: true })],
      ]),
      s,
    );
    expect(out.map((c) => c.path)).toEqual(['g']);
    expect(out[0]).toMatchObject({
      kind: 'type',
      severity: 'breaking',
      confidence: 0.7,
      notes: 'generic signatures differ',
    });
  });
});

describe('type parameter loss', () => {
  it('is breaking at 0.6 even when the checker calls the types compatible', () => {
    const s = surface([{ path: 'M#use', kind: 'method' }]);
    const out = refineWithTypes(
      [
        {
          ...change('M#use', 'signature'),
          before: '<T = V>(f?: (v: V) => T): number',
          after: '(f?: (v: V) => V): number',
        },
      ],
      new Map([
        [
          'M#use',
          cmp('equivalent', { callable: true, typeParameterCounts: { before: [1], after: [0] } }),
        ],
      ]),
      s,
    );
    expect(out[0]).toMatchObject({
      kind: 'signature',
      severity: 'breaking',
      confidence: 0.6,
      notes: 'explicit type arguments will no longer compile',
    });
  });
});
