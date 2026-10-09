import { describe, expect, it } from 'vitest';
import type { Finding } from '../domain/report.js';
import type { DiagnosticCause } from '../domain/usage.js';
import { joinSharedRoots } from './shared-root.js';

const cause: DiagnosticCause = {
  name: 'ref',
  file: 'packages/editor/src/lib/hooks/useTransform.ts',
  line: 6,
  reason:
    'whose parameter `ref: RefObject<HTMLElement>` no longer accepts what the target gives it',
  anchorOnly: true,
};
const meta = { package: 'react', from: '18.3.1', to: '19.2.1' };

const lone = (file: string, line: number, over: Partial<Finding> = {}): Finding => ({
  change: {
    ...meta,
    path: 'TS2345',
    kind: 'type',
    severity: 'breaking',
    source: 'types',
    confidence: 1,
  },
  usage: {
    file,
    line,
    column: 1,
    endLine: line,
    endColumn: 1,
    symbolPath: 'TS2345',
    access: 'read',
    snippet: '',
    via: 'inferred',
    compileError: 'Argument of type X is not assignable to parameter of type Y.',
  },
  sharedCause: cause,
  severity: 'breaking',
  confidence: 1,
  fixability: 'unknown',
  reason: 'compile error not attributed to a known API change',
  ...over,
});

/** The anchor one workspace already reports (two of its own sites trip the parameter). */
const anchor: Finding = {
  change: {
    ...meta,
    path: 'cause:ref',
    kind: 'cause',
    severity: 'breaking',
    source: 'types',
    confidence: 1,
  },
  usage: {
    file: cause.file,
    line: cause.line,
    column: 1,
    endLine: cause.line,
    endColumn: 1,
    symbolPath: 'cause:ref',
    access: 'read',
    snippet: '',
    via: 'inferred',
  },
  downstream: [
    { file: 'packages/editor/src/lib/a.tsx', line: 3, code: 2345, message: 'x' },
    { file: 'packages/editor/src/lib/b.tsx', line: 4, code: 2345, message: 'x' },
  ],
  anchorOnly: true,
  callSites: 2,
  severity: 'breaking',
  confidence: 1,
  fixability: 'assisted',
  reason: cause.reason,
};

describe('joinSharedRoots', () => {
  it('adds a lone site of another workspace to the anchor already reported for the declaration', () => {
    const out = joinSharedRoots([anchor, lone('apps/examples/src/x.tsx', 11)]);
    expect(out).toHaveLength(1);
    expect(out[0]?.callSites).toBe(3);
    expect(out[0]?.downstream?.map((d) => `${d.file}:${d.line}`)).toEqual([
      'packages/editor/src/lib/a.tsx:3',
      'packages/editor/src/lib/b.tsx:4',
      'apps/examples/src/x.tsx:11',
    ]);
    expect(out[0]?.change.notes).toContain('3 errors caused by `ref`');
  });

  it('makes one anchor of two lone sites in different workspaces, under the rule that claimed them', () => {
    const out = joinSharedRoots([
      lone('apps/examples/src/x.tsx', 11, { rule: 'ref-object-nullable' }),
      lone('packages/tldraw/src/y.tsx', 59, { rule: 'ref-object-nullable' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      usage: { file: cause.file, line: 6 },
      anchorOnly: true,
      callSites: 2,
      rule: 'ref-object-nullable',
    });
  });

  it('leaves a site no other shares as its own finding, without the candidate', () => {
    const other = lone('apps/examples/src/x.tsx', 11);
    const out = joinSharedRoots([other]);
    expect(out).toHaveLength(1);
    expect(out[0]?.usage.file).toBe('apps/examples/src/x.tsx');
    expect(out[0]?.sharedCause).toBeUndefined();
  });

  it('keeps sites of different declarations apart', () => {
    const elsewhere = { ...cause, file: 'packages/editor/src/lib/hooks/other.ts' };
    const out = joinSharedRoots([
      lone('apps/examples/src/x.tsx', 11),
      lone('packages/tldraw/src/y.tsx', 59, { sharedCause: elsewhere }),
    ]);
    expect(out.map((f) => `${f.usage.file}:${f.usage.line}`)).toEqual([
      'apps/examples/src/x.tsx:11',
      'packages/tldraw/src/y.tsx:59',
    ]);
  });
});
