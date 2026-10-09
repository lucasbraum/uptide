import { describe, expect, it } from 'vitest';
import type { Finding, PackageReport } from '../domain/report.js';
import { planPackage } from '../fix/plan.js';
import { sitesOf } from './check.js';
import { callSitesLine, foldSharedRoots, groupRootCauses } from './root-cause.js';

it('groups missing TypeScript API members without losing sites or unrelated diagnostics', () => {
  const finding = (line: number, code = 2339): Finding => ({
    change: {
      package: 'typescript',
      from: '6.0.3',
      to: '7.0.2',
      path: `member${line}`,
      kind: 'removed',
      severity: 'breaking',
      source: 'types',
      confidence: 1,
    },
    usage: {
      file: 'api.ts',
      line,
      column: 1,
      endLine: line,
      endColumn: 4,
      symbolPath: `member${line}`,
      access: 'read',
      via: 'direct',
      snippet: 'ts.member',
      compileCode: code,
      compileError: 'missing member',
    },
    severity: 'breaking',
    confidence: 1,
    fixability: 'assisted',
    reason: 'missing',
    evidence: 'compiler',
  });
  const report: PackageReport = {
    name: 'typescript',
    installed: '6.0.3',
    target: '7.0.2',
    latest: '7.0.2',
    workspace: '.',
    majorsBehind: 1,
    findings: [finding(1), finding(2), finding(3, 2345)],
    status: 'breaking',
    callSitesChecked: 3,
    unanalyzed: [],
    notes: [],
    timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
  };
  groupRootCauses(report);
  expect(report.findings).toHaveLength(2);
  expect(sitesOf(report.findings[0] as Finding)).toBe(2);
  expect(report.findings[0]?.downstream?.map((s) => s.line)).toEqual([1, 2]);
  expect(planPackage(report).find((g) => g.rule === 'typescript-no-js-api')).toMatchObject({
    sites: 2,
    title: 'TypeScript 7 has no JavaScript compiler API in its main entry',
  });
  const withoutEvidence = {
    ...report,
    findings: [finding(1), { ...finding(2), evidence: undefined }],
  };
  groupRootCauses(withoutEvidence);
  expect(withoutEvidence.findings[0]?.change.kind).toBe('removed');
});

describe('foldSharedRoots', () => {
  const root = {
    name: 'ref',
    file: 'packages/editor/src/useTransform.ts',
    line: 6,
    reason:
      "whose parameter `ref: RefObject<HTMLElement>` no longer accepts what the target gives it; widen the parameter's type there",
  };
  const site = (file: string, line: number, over: Partial<Finding> = {}): Finding => ({
    change: {
      package: 'react',
      from: '18.3.1',
      to: '19.2.1',
      path: 'TS2345',
      kind: 'type',
      severity: 'breaking',
      source: 'types',
      confidence: 1,
      evidence: 'checker',
    },
    usage: {
      file,
      line,
      column: 16,
      endLine: line,
      endColumn: 20,
      symbolPath: 'TS2345',
      access: 'read',
      via: 'inferred',
      snippet: 'useTransform(rSvg, x, y)',
      compileCode: 2345,
      compileError: "Argument of type 'RefObject<SVGSVGElement | null>' is not assignable",
    },
    root,
    severity: 'breaking',
    confidence: 1,
    fixability: 'unknown',
    reason: 'compile error not attributed to a known API change',
    evidence: 'compiler',
    rule: 'ref-object-nullable',
    ...over,
  });
  const workspaces = new Map<Finding, string>();
  const at = (workspace: string, f: Finding): Finding => {
    workspaces.set(f, workspace);
    return f;
  };

  it('folds sites in different workspaces that trace to one declaration into one anchored finding', () => {
    const a = at('apps/examples', site('apps/examples/src/Custom.tsx', 11));
    const b = at('packages/tldraw', site('packages/tldraw/src/Foreground.tsx', 59));
    const other = at('apps/examples', site('apps/examples/src/Other.tsx', 3, { root: undefined }));
    const out = foldSharedRoots([a, other, b], (f) => workspaces.get(f));
    expect(out).toHaveLength(2);
    const anchor = out[0] as Finding;
    expect(anchor).toMatchObject({
      change: { kind: 'cause', path: 'cause:ref', severity: 'breaking' },
      usage: { file: root.file, line: 6, symbolPath: 'cause:ref' },
      anchorOnly: true,
      root,
      severity: 'breaking',
      fixability: 'assisted',
      reason: root.reason,
      rule: 'ref-object-nullable',
      evidence: 'compiler',
      details: ['2 call sites in 2 workspaces'],
    });
    expect(anchor.change.notes).toBe(
      `2 errors caused by \`ref\` in ${root.file}:6: ${root.reason}. One edit there resolves them.`,
    );
    expect(anchor.downstream).toEqual([
      {
        file: 'apps/examples/src/Custom.tsx',
        line: 11,
        column: 16,
        snippet: 'useTransform(rSvg, x, y)',
        code: 2345,
        message: "Argument of type 'RefObject<SVGSVGElement | null>' is not assignable",
        workspace: 'apps/examples',
      },
      expect.objectContaining({
        file: 'packages/tldraw/src/Foreground.tsx',
        line: 59,
        workspace: 'packages/tldraw',
      }),
    ]);
    expect(sitesOf(anchor)).toBe(1);
    expect(out[1]).toBe(other);
  });

  it('leaves a site alone at its root, and joins a site to the anchor another workspace already produced', () => {
    const alone = site('apps/examples/src/Custom.tsx', 11);
    expect(foldSharedRoots([alone], () => 'apps/examples')).toEqual([alone]);
    const anchor: Finding = {
      ...site(root.file, 6, { fixability: 'assisted', reason: root.reason }),
      change: { ...site('', 0).change, kind: 'cause', path: 'cause:ref' },
      anchorOnly: true,
      downstream: [
        {
          file: 'packages/editor/src/A.tsx',
          line: 4,
          code: 2345,
          message: 'm',
          workspace: 'packages/editor',
        },
        {
          file: 'packages/editor/src/B.tsx',
          line: 9,
          code: 2345,
          message: 'm',
          workspace: 'packages/editor',
        },
      ],
    };
    const out = foldSharedRoots([anchor, at('apps/examples', alone)], (f) => workspaces.get(f));
    expect(out).toHaveLength(1);
    expect(out[0]?.downstream?.map((d) => `${d.file}:${d.line}`)).toEqual([
      'apps/examples/src/Custom.tsx:11',
      'packages/editor/src/A.tsx:4',
      'packages/editor/src/B.tsx:9',
    ]);
    expect(out[0]?.details).toEqual(['3 call sites in 2 workspaces']);
  });

  it('counts workspaces only when the sites span more than one', () => {
    expect(callSitesLine([{ file: 'a', line: 1, code: 1, message: '' }])).toBe('1 call site');
    expect(
      callSitesLine([
        { file: 'a', line: 1, code: 1, message: '', workspace: 'x' },
        { file: 'b', line: 1, code: 1, message: '', workspace: 'x' },
      ]),
    ).toBe('2 call sites');
  });
});
