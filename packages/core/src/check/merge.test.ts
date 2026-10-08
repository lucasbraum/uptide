import { describe, expect, it } from 'vitest';
import type { ApiSurface } from '../domain/surface.js';
import type { CompileSignal, Usage } from '../domain/usage.js';
import { mergeSignals, symbolFromMessage } from './merge.js';

const surface: ApiSurface = {
  package: 'synthetic',
  version: '1.0.0',
  extractedAt: '',
  adapter: 'typescript',
  symbols: [
    { path: 'Item', kind: 'interface', signature: 'interface', exportedFrom: ['.'] },
    { path: 'Item#legacyId', kind: 'property', signature: 'string', exportedFrom: ['.'] },
    { path: 'parseLegacy', kind: 'function', signature: '(): Item', exportedFrom: ['.'] },
  ],
};
const usage: Usage = {
  file: 'src/a.ts',
  line: 6,
  column: 18,
  endLine: 6,
  endColumn: 28,
  symbolPath: 'makeClient',
  canonicalPath: 'createClient',
  access: 'call',
  snippet: '',
  via: 'direct',
};
const signal = (diagnostics: CompileSignal['diagnostics']): CompileSignal => ({
  diagnostics,
  baselineErrors: 0,
  coverage: { compiled: 1, total: 1, skipped: [] },
  unresolvedInTarget: [],
  unresolvedFiles: [],
  linkedDependencies: [],
  unsatisfiedDependencies: [],
  timing: { baselineMs: 1, overlayMs: 1, dependenciesMs: 0 },
});
const diag = (
  file: string,
  line: number,
  column: number,
  message: string,
  endColumn = column + 5,
) => ({
  file,
  line,
  column,
  endLine: line,
  endColumn,
  code: 1,
  message,
  snippet: 'const x = 1;',
});

describe('mergeSignals', () => {
  it('a diagnostic overlapping a usage confirms it and keeps its certainty', () => {
    const out = mergeSignals(
      [usage],
      signal([diag('src/a.ts', 6, 20, 'Expected 2 arguments, but got 1.')]),
      surface,
    );
    expect(out.usages).toHaveLength(1);
    expect(out.usages[0]).toMatchObject({
      via: 'direct',
      compileError: 'Expected 2 arguments, but got 1.',
    });
    expect(out.unattributed).toEqual([]);
  });

  it('a diagnostic naming a package symbol becomes an inferred usage', () => {
    const out = mergeSignals(
      [usage],
      signal([diag('src/b.ts', 3, 10, "Property 'legacyId' does not exist on type 'Item'.")]),
      surface,
    );
    expect(out.usages).toHaveLength(2);
    expect(out.usages[1]).toMatchObject({
      file: 'src/b.ts',
      line: 3,
      symbolPath: 'Item#legacyId',
      via: 'inferred',
      access: 'read',
    });
  });

  it('a diagnostic overlapping nothing joins same-line usages that a change explains', () => {
    const request: Usage = {
      ...usage,
      line: 11,
      column: 20,
      endLine: 11,
      endColumn: 27,
      symbolPath: 'Axios#interceptors#request',
      canonicalPath: undefined,
      access: 'read',
    };
    const typeRef: Usage = {
      ...request,
      column: 42,
      endColumn: 60,
      symbolPath: 'AxiosRequestConfig',
      access: 'typeRef',
    };
    const out = mergeSignals(
      [request, typeRef],
      signal([
        diag(
          'src/a.ts',
          11,
          33,
          "Argument of type '(config: AxiosRequestConfig) => AxiosRequestConfig' is not assignable to parameter of type '(value: InternalAxiosRequestConfig) => ...'.",
          66,
        ),
      ]),
      surface,
      new Set(['Axios#interceptors#request']),
    );
    expect(
      out.usages.find((u) => u.symbolPath === 'Axios#interceptors#request')?.compileError,
    ).toMatch(/^Argument of type/);
    expect(out.unattributed).toEqual([]);
  });

  it('an assignability error is a write of the named type', () => {
    const out = mergeSignals(
      [],
      signal([diag('src/b.ts', 3, 10, "Type '{ a: string; }' is not assignable to type 'Item'.")]),
      surface,
    );
    expect(out.usages[0]).toMatchObject({ symbolPath: 'Item', via: 'inferred', access: 'write' });
  });

  it('a diagnostic naming nothing known is returned as unattributed', () => {
    const out = mergeSignals(
      [usage],
      signal([diag('src/c.ts', 1, 1, "Type 'string' is not assignable to type 'number'.")]),
      surface,
    );
    expect(out.usages).toHaveLength(1);
    expect(out.unattributed).toHaveLength(1);
  });

  it('without a signal, Signal A stands alone unchanged', () => {
    expect(mergeSignals([usage], undefined, surface)).toEqual({
      usages: [usage],
      unattributed: [],
    });
  });
});

describe('symbolFromMessage', () => {
  it('maps the two message shapes to known paths only', () => {
    expect(symbolFromMessage("Property 'legacyId' does not exist on type 'Item'.", surface)).toBe(
      'Item#legacyId',
    );
    expect(
      symbolFromMessage("Property 'nope' does not exist on type 'Item'.", surface),
    ).toBeUndefined();
    expect(
      symbolFromMessage("Module '\"synthetic\"' has no exported member 'parseLegacy'.", surface),
    ).toBe('parseLegacy');
    expect(symbolFromMessage('Expected 2 arguments, but got 1.', surface)).toBeUndefined();
    expect(
      symbolFromMessage("Type '{ a: string; }' is not assignable to type 'Item'.", surface),
    ).toBe('Item');
    expect(
      symbolFromMessage(
        "Argument of type 'X' is not assignable to parameter of type 'Item<string>'.",
        surface,
      ),
    ).toBe('Item');
  });
});
