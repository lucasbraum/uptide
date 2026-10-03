import { describe, expect, it } from 'vitest';
import type { ApiSurface, ApiSymbol } from '../domain/surface.js';
import { diffSurfaces } from './diff.js';

type Sym = Partial<ApiSymbol> & { path: string; signature: string };

function surface(version: string, symbols: Sym[]): ApiSurface {
  return {
    package: 'demo',
    version,
    extractedAt: '2026-09-27T00:00:00.000Z',
    adapter: 'typescript',
    symbols: symbols.map((s) => ({ kind: 'property', exportedFrom: ['.'], ...s })),
  };
}

const A = (symbols: Sym[]) => surface('1.0.0', symbols);
const B = (symbols: Sym[]) => surface('2.0.0', symbols);

describe('diffSurfaces', () => {
  it('reports removal and addition, stamped with package and versions', () => {
    const changes = diffSurfaces(
      A([{ path: 'old', kind: 'function', signature: '(): void' }]),
      B([{ path: 'brandNew', kind: 'function', signature: '(x: number): string' }]),
    );
    expect(changes).toEqual([
      expect.objectContaining({
        package: 'demo',
        from: '1.0.0',
        to: '2.0.0',
        path: 'brandNew',
        kind: 'added',
        severity: 'additive',
        after: '(x: number): string',
        confidence: 1,
      }),
      expect.objectContaining({
        path: 'old',
        kind: 'removed',
        severity: 'breaking',
        before: '(): void',
        confidence: 1,
      }),
    ]);
    expect(changes[1]?.replacement).toBeUndefined();
  });

  it('hints a rename with identical signature but still emits removed + added', () => {
    const changes = diffSurfaces(
      A([
        { path: 'Client#fetchAll', kind: 'method', signature: '(page: number): Promise<Item[]>' },
      ]),
      B([{ path: 'Client#listAll', kind: 'method', signature: '(page: number): Promise<Item[]>' }]),
    );
    const removed = changes.find((c) => c.kind === 'removed');
    const added = changes.find((c) => c.kind === 'added');
    expect(removed).toMatchObject({
      path: 'Client#fetchAll',
      replacement: 'Client#listAll',
      severity: 'breaking',
    });
    expect(removed?.confidence).toBeLessThan(1);
    expect(added).toMatchObject({ path: 'Client#listAll', severity: 'additive' });
    expect(changes.some((c) => c.kind === 'renamed')).toBe(false);
  });

  it('does not hint on a trivial signature unless the names resemble each other', () => {
    const unrelated = diffSurfaces(
      A([{ path: 'Config#analyticsId', signature: 'string' }]),
      B([{ path: 'Config#outputFileTracingRoot', signature: 'string' }]),
    );
    expect(unrelated.find((c) => c.kind === 'removed')?.replacement).toBeUndefined();
    const related = diffSurfaces(
      A([{ path: 'Config#analyticsId', signature: 'string' }]),
      B([{ path: 'Config#analyticsID', signature: 'string' }]),
    );
    expect(related.find((c) => c.kind === 'removed')?.replacement).toBe('Config#analyticsID');
  });

  it('does not hint when the same-parent candidate is ambiguous', () => {
    const changes = diffSurfaces(
      A([{ path: 'Client#a', kind: 'method', signature: '(): void' }]),
      B([
        { path: 'Client#b', kind: 'method', signature: '(): void' },
        { path: 'Client#c', kind: 'method', signature: '(): void' },
      ]),
    );
    expect(changes.find((c) => c.kind === 'removed')?.replacement).toBeUndefined();
  });

  it('matches a renamed container on name and members, and propagates to its members', () => {
    const changes = diffSurfaces(
      A([
        { path: 'ParseOpts', kind: 'interface', signature: 'interface' },
        { path: 'ParseOpts#strict', signature: 'boolean', optional: true },
        { path: 'ParseOpts#mode', signature: 'string' },
      ]),
      B([
        { path: 'ParseOptions', kind: 'interface', signature: 'interface' },
        { path: 'ParseOptions#strict', signature: 'boolean', optional: true },
        { path: 'ParseOptions#mode', signature: 'string' },
      ]),
    );
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    expect(byPath.ParseOpts).toMatchObject({
      kind: 'removed',
      replacement: 'ParseOptions',
      confidence: 0.8,
    });
    expect(byPath['ParseOpts#strict']).toMatchObject({
      kind: 'removed',
      replacement: 'ParseOptions#strict',
    });
  });

  it('does not match containers on an identical header alone', () => {
    const changes = diffSurfaces(
      A([
        {
          path: 'S.InvoiceitemUpdatedEvent',
          kind: 'interface',
          signature: 'interface extends EventBase',
        },
        { path: 'S.InvoiceitemUpdatedEvent#type', signature: "'invoiceitem.updated'" },
      ]),
      B([
        {
          path: 'S.InvoiceOverdueEvent',
          kind: 'interface',
          signature: 'interface extends EventBase',
        },
        { path: 'S.InvoiceOverdueEvent#type', signature: "'invoice.overdue'" },
        {
          path: 'S.BillingAlertTriggeredEvent',
          kind: 'interface',
          signature: 'interface extends EventBase',
        },
        { path: 'S.BillingAlertTriggeredEvent#type', signature: "'billing.alert.triggered'" },
      ]),
    );
    expect(
      changes.find((c) => c.path === 'S.InvoiceitemUpdatedEvent')?.replacement,
    ).toBeUndefined();
  });

  it('copies aliasOf onto changes', () => {
    const changes = diffSurfaces(
      A([
        { path: 'create', kind: 'function', signature: '(): void' },
        { path: 'make', kind: 'function', signature: '(): void', aliasOf: 'create' },
      ]),
      B([
        { path: 'create', kind: 'function', signature: '(a?: string): void' },
        { path: 'make', kind: 'function', signature: '(a?: string): void', aliasOf: 'create' },
      ]),
    );
    expect(changes.map((c) => [c.path, c.aliasOf])).toEqual([
      ['create', undefined],
      ['make', 'create'],
    ]);
  });

  it('copies visibility onto changes', () => {
    const changes = diffSurfaces(
      A([
        {
          path: 'C#warn',
          kind: 'method',
          signature: 'protected (m: string): void',
          visibility: 'protected',
        },
        { path: 'hidden', kind: 'function', signature: '(): void', visibility: 'internal' },
      ]),
      B([
        {
          path: 'C#warn',
          kind: 'method',
          signature: 'protected (m: string, level: number): void',
          visibility: 'protected',
        },
      ]),
    );
    expect(changes.map((c) => [c.path, c.visibility])).toEqual([
      ['C#warn', 'protected'],
      ['hidden', 'internal'],
    ]);
  });

  it('optional -> required is `required` and breaking', () => {
    const changes = diffSurfaces(
      A([{ path: 'Opts#mode', signature: 'string', optional: true }]),
      B([{ path: 'Opts#mode', signature: 'string' }]),
    );
    expect(changes).toEqual([
      expect.objectContaining({ path: 'Opts#mode', kind: 'required', severity: 'breaking' }),
    ]);
  });

  it('required -> optional is additive', () => {
    const changes = diffSurfaces(
      A([{ path: 'Opts#mode', signature: 'string' }]),
      B([{ path: 'Opts#mode', signature: 'string', optional: true }]),
    );
    expect(changes).toEqual([
      expect.objectContaining({ path: 'Opts#mode', kind: 'type', severity: 'additive' }),
    ]);
  });

  it('union widened is additive, narrowed is breaking', () => {
    const widened = diffSurfaces(
      A([{ path: 'Mode', kind: 'type', signature: "type = 'a' | 'b'" }]),
      B([{ path: 'Mode', kind: 'type', signature: "type = 'a' | 'b' | 'c'" }]),
    );
    expect(widened[0]).toMatchObject({ kind: 'widened', severity: 'additive', confidence: 0.6 });
    const narrowed = diffSurfaces(
      A([{ path: 'Opts#mode', signature: "'a' | 'b' | 'c'" }]),
      B([{ path: 'Opts#mode', signature: "'a' | 'b'" }]),
    );
    expect(narrowed[0]).toMatchObject({ kind: 'narrowed', severity: 'breaking', confidence: 0.7 });
  });

  it('newly deprecated symbol yields a jsdoc-sourced deprecated change', () => {
    const changes = diffSurfaces(
      A([{ path: 'parse', kind: 'function', signature: '(): void' }]),
      B([{ path: 'parse', kind: 'function', signature: '(): void', deprecated: 'use parseAsync' }]),
    );
    expect(changes).toEqual([
      expect.objectContaining({
        path: 'parse',
        kind: 'deprecated',
        severity: 'deprecated',
        source: 'jsdoc',
        notes: 'use parseAsync',
      }),
    ]);
  });

  it('deprecated symbol later removed is a breaking removal that says so', () => {
    const changes = diffSurfaces(
      A([{ path: 'parse', kind: 'function', signature: '(): void', deprecated: true }]),
      B([]),
    );
    expect(changes).toEqual([
      expect.objectContaining({
        path: 'parse',
        kind: 'removed',
        severity: 'breaking',
        notes: 'was deprecated',
      }),
    ]);
  });

  it('a symbol moved between subpaths but still reachable from the root is not a change', () => {
    const changes = diffSurfaces(
      A([{ path: 'parse', kind: 'function', signature: '(): void', exportedFrom: ['.', './v1'] }]),
      B([{ path: 'parse', kind: 'function', signature: '(): void', exportedFrom: ['.', './v2'] }]),
    );
    expect(changes).toEqual([]);
  });

  it('a symbol that lost every entry point it had is `moved`, pointing at the new entry point', () => {
    const changes = diffSurfaces(
      A([{ path: 'parse', kind: 'function', signature: '(): void', exportedFrom: ['.'] }]),
      B([
        {
          path: 'parse',
          kind: 'function',
          signature: '(): void',
          exportedFrom: ['./v3', './core'],
        },
      ]),
    );
    expect(changes).toEqual([
      expect.objectContaining({
        path: 'parse',
        kind: 'moved',
        severity: 'breaking',
        replacement: './core',
        confidence: 0.95,
      }),
    ]);
    expect(changes[0]?.notes).toMatch(/now exported from \.\/v3, \.\/core/);
  });

  it('a moved symbol whose signature also changed reports both', () => {
    const changes = diffSurfaces(
      A([{ path: 'parse', kind: 'function', signature: '(): void', exportedFrom: ['.'] }]),
      B([
        { path: 'parse', kind: 'function', signature: '(a: string): void', exportedFrom: ['./v3'] },
      ]),
    );
    expect(changes.map((c) => c.kind).sort()).toEqual(['moved', 'signature']);
  });

  it('a const arrow becoming a function declaration with the same parameters is no change', () => {
    const changes = diffSurfaces(
      A([
        {
          path: 'string',
          kind: 'variable',
          signature: 'const (params?: RawCreateParams) => ZodString',
        },
      ]),
      B([{ path: 'string', kind: 'function', signature: '(params?: RawCreateParams): ZodString' }]),
    );
    expect(changes).toEqual([]);
  });

  it('a method becoming a function-typed property with the same shape is no change; a real difference is a plain signature change', () => {
    const same = diffSurfaces(
      A([{ path: 'S#all', kind: 'method', signature: '<T>(values: Array<T>): Promise<T[]>' }]),
      B([{ path: 'S#all', kind: 'property', signature: '<T>(values: Array<T>) => Promise<T[]>' }]),
    );
    expect(same).toEqual([]);
    const different = diffSurfaces(
      A([{ path: 'S#all', kind: 'method', signature: '(values: string[]): void' }]),
      B([
        { path: 'S#all', kind: 'property', signature: '(values: string[], extra: number) => void' },
      ]),
    );
    expect(different[0]).toMatchObject({
      kind: 'signature',
      severity: 'breaking',
      before: '(values: string[]): void',
    });
    expect(different[0]?.notes).not.toMatch(/declaration kind/);
  });

  it('a property that stops being callable is a plain type change; a called variable says so', () => {
    const property = diffSurfaces(
      A([{ path: 'C#paramsSerializer', signature: '(params: any) => string', optional: true }]),
      B([{ path: 'C#paramsSerializer', signature: 'Custom | Options', optional: true }]),
    );
    expect(property[0]).toMatchObject({ kind: 'type', before: '(params: any) => string' });
    expect(property[0]?.notes).not.toMatch(/callable/);
    const variable = diffSurfaces(
      A([{ path: 'run', kind: 'variable', signature: 'const () => void' }]),
      B([{ path: 'run', kind: 'variable', signature: 'const string' }]),
    );
    expect(variable[0]).toMatchObject({
      kind: 'type',
      severity: 'breaking',
      notes: 'no longer callable',
    });
  });

  it('a pure type parameter rename is no change', () => {
    const changes = diffSurfaces(
      A([
        { path: 'pipeline', kind: 'variable', signature: 'const <A, B>(a: A, b: B) => Pipe<A, B>' },
      ]),
      B([{ path: 'pipeline', kind: 'function', signature: '<X, Y>(a: X, b: Y): Pipe<X, Y>' }]),
    );
    expect(changes).toEqual([]);
  });

  it('a symbol that stops being callable still reports the kind change', () => {
    const gone = diffSurfaces(
      A([{ path: 'f', kind: 'function', signature: '(): void' }]),
      B([{ path: 'f', kind: 'variable', signature: 'const string' }]),
    );
    expect(gone[0]?.notes).toMatch(/declaration kind changed from function to variable/);
  });

  it('a declaration kind change is a signature change whose severity depends on the kinds', () => {
    const toAlias = diffSurfaces(
      A([{ path: 'Opts', kind: 'interface', signature: 'interface' }]),
      B([{ path: 'Opts', kind: 'type', signature: 'type = Base & Extra' }]),
    );
    expect(toAlias[0]).toMatchObject({
      kind: 'signature',
      severity: 'additive',
      confidence: 0.7,
      notes: expect.stringMatching(/interface to type/),
    });
    const valueToType = diffSurfaces(
      A([{ path: 'BRAND', kind: 'variable', signature: 'const unique symbol' }]),
      B([{ path: 'BRAND', kind: 'type', signature: 'type<T>' }]),
    );
    expect(valueToType[0]).toMatchObject({
      kind: 'signature',
      severity: 'breaking',
      confidence: 1,
    });
  });

  it('signature and deprecation on the same symbol produce two changes', () => {
    const changes = diffSurfaces(
      A([{ path: 'f', kind: 'function', signature: '(a: string): void' }]),
      B([
        {
          path: 'f',
          kind: 'function',
          signature: '(a: string, b?: number): void',
          deprecated: true,
        },
      ]),
    );
    expect(changes.map((c) => [c.kind, c.severity])).toEqual([
      ['signature', 'additive'],
      ['deprecated', 'deprecated'],
    ]);
  });
});
