import { describe, expect, it } from 'vitest';
import type { ApiSurface } from '../domain/surface.js';
import type { CompileDiagnostic } from '../domain/usage.js';
import { normalizeMessage, unattributedFindings } from './unattributed.js';

const diag = (over: Partial<CompileDiagnostic>): CompileDiagnostic => ({
  file: 'src/a.ts',
  line: 1,
  column: 1,
  endLine: 1,
  endColumn: 2,
  code: 2339,
  message: "Property 'issues' does not exist on type 'ZodError'.",
  snippet: 'err.issues',
  ...over,
});
const surface: ApiSurface = {
  package: 'zod',
  version: '4.0.0',
  extractedAt: '',
  adapter: 'typescript',
  symbols: [
    { path: 'ZodError', kind: 'class', signature: 'class', exportedFrom: ['.'], file: 'core.d.ts' },
    { path: 'Shaky', kind: 'class', signature: 'class', exportedFrom: ['.'], file: 'shaky.d.ts' },
  ],
};
const meta = { package: 'zod', from: '3.0.0', to: '4.0.0' };

describe('unattributed compile errors', () => {
  it('normalizes quoted identifiers so the same error on two types is one group', () => {
    expect(normalizeMessage("Property 'a' does not exist on type 'B'.\nDetail")).toBe(
      "Property '_' does not exist on type '_'.",
    );
  });

  it('is a breaking finding with unknown fixability and a fixed reason', () => {
    const [f] = unattributedFindings([diag({})], meta, surface, []);
    expect(f).toMatchObject({
      severity: 'breaking',
      fixability: 'unknown',
      reason: 'compile error not attributed to a known API change',
      change: { path: 'TS2339', notes: "Property '_' does not exist on type '_'." },
      usage: { file: 'src/a.ts', line: 1, via: 'inferred', compileError: diag({}).message },
    });
  });

  it('is unverified when the message names a type declared in an unresolved target file', () => {
    const [f] = unattributedFindings(
      [diag({ message: "Property 'x' does not exist on type 'Shaky'." })],
      meta,
      surface,
      ['shaky.d.ts'],
    );
    expect(f?.severity).toBe('unverified');
    const [g] = unattributedFindings([diag({})], meta, surface, ['shaky.d.ts']);
    expect(g?.severity).toBe('breaking');
  });
});

describe('root-cause clusters', () => {
  it('collapses diagnostics traced to one repo declaration into one finding at that declaration', () => {
    const cause = {
      name: 'parseBody',
      file: 'src/http/parse.ts',
      line: 12,
      reason: 'whose type changed from `() => number` to `() => unknown`',
    };
    const out = unattributedFindings(
      [
        diag({
          file: 'src/a.ts',
          line: 3,
          message: "'data' is of type 'unknown'.",
          code: 18046,
          cause,
        }),
        diag({
          file: 'src/b.ts',
          line: 9,
          message: "'parsed' is of type 'unknown'.",
          code: 18046,
          cause,
        }),
        diag({ file: 'src/c.ts', line: 1, message: 'Something else.' }),
      ],
      meta,
      surface,
      [],
      'packages/api/',
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.downstream).toEqual([
      {
        file: 'packages/api/src/a.ts',
        line: 3,
        code: 18046,
        message: "'data' is of type 'unknown'.",
      },
      {
        file: 'packages/api/src/b.ts',
        line: 9,
        code: 18046,
        message: "'parsed' is of type 'unknown'.",
      },
    ]);
    expect(out[0]).toMatchObject({
      severity: 'breaking',
      fixability: 'unknown',
      change: {
        path: 'cause:parseBody',
        kind: 'cause',
        notes:
          '2 errors caused by `parseBody` (packages/api/src/http/parse.ts:12), whose type changed from `() => number` to `() => unknown`. Fix here first.',
      },
      usage: { file: 'src/http/parse.ts', line: 12 },
    });
    expect(out[1]?.change.path).toBe('TS2339');
  });
});
