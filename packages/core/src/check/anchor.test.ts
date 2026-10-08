import { describe, expect, it } from 'vitest';
import type { Finding } from '../domain/report.js';
import { planPackage } from '../fix/plan.js';
import { selectedFindings } from '../fix/select.js';
import { definePack, ruleFor } from '../packs/contract.js';
import { sitesOf } from './check.js';

/** The JSX namespace cluster as `check` reports it: one anchor at the tsconfig, the errors under it. */
const anchor: Finding = {
  change: {
    package: 'react',
    from: '18.3.1',
    to: '19.2.1',
    path: 'cause:jsx',
    kind: 'cause',
    severity: 'breaking',
    source: 'types',
    confidence: 1,
    evidence: 'checker',
  },
  usage: {
    file: 'apps/web/tsconfig.json',
    line: 15,
    column: 1,
    endLine: 15,
    endColumn: 1,
    symbolPath: 'cause:jsx',
    access: 'read',
    snippet: '',
    via: 'inferred',
  },
  downstream: [
    {
      file: 'apps/web/src/App.tsx',
      line: 3,
      code: 7026,
      message:
        "JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.",
    },
    {
      file: 'apps/web/src/Nav.tsx',
      line: 8,
      code: 7026,
      message:
        "JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.",
    },
    {
      file: 'apps/web/src/Nav.tsx',
      line: 9,
      code: 2322,
      message: "Type 'X' is not assignable to type 'Y'.",
    },
  ],
  anchorOnly: true,
  severity: 'breaking',
  confidence: 1,
  fixability: 'assisted',
  reason: '"jsx": "preserve" reads the global JSX namespace, which @types/react no longer declares',
  evidence: 'compiler',
};
const plain: Finding = {
  ...anchor,
  anchorOnly: undefined,
  change: { ...anchor.change, path: 'cause:parse' },
};

describe('a cause that is a compiler option', () => {
  it('counts as one site, is selected and planned at the option, and lists its errors as evidence', () => {
    expect(sitesOf(anchor)).toBe(1);
    expect(sitesOf(plain)).toBe(3);
    const report = {
      repo: '',
      workspaces: ['.', 'apps/web'],
      packages: [
        {
          workspace: '.',
          name: 'react',
          installed: '18.3.1',
          latest: '19.2.1',
          target: '19.2.1',
          majorsBehind: 1,
          findings: [anchor],
          callSitesChecked: 3,
          unanalyzed: [],
          status: 'breaking' as const,
          notes: [],
          timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
        },
      ],
      summary: {} as never,
    };
    const selected = selectedFindings(report, 'react', false);
    expect(selected.map((f) => `${f.usage.file}:${f.usage.line}`)).toEqual([
      'apps/web/tsconfig.json:15',
    ]);
    const [group] = planPackage(report.packages[0] as never);
    expect(group).toMatchObject({ severity: 'breaking', sites: 1, fixes: 1 });
    expect(group?.locations).toEqual([{ file: 'apps/web/tsconfig.json', line: 15 }]);
    // Without the marker the cluster's sites are the errors themselves, as before.
    const expanded = selectedFindings(
      { ...report, packages: [{ ...report.packages[0], findings: [plain] }] } as never,
      'react',
      false,
    );
    expect(expanded).toHaveLength(3);
  });

  it('is claimed by the pack rule that claims most of the errors under it', () => {
    const pack = definePack({
      meta: {
        package: 'react',
        from: '>=18 <19',
        to: '>=19 <20',
        sources: [{ title: 'guide', url: 'https://example.invalid' }],
        maintainer: 'test',
      },
      rules: [
        {
          id: 'ref-object-nullable',
          summary: 'refs',
          severity: 'breaking',
          kinds: ['type'],
          symbols: /^TS2322$/,
          guide: 'fix the ref',
        },
        {
          id: 'global-jsx-namespace',
          summary: 'jsx',
          severity: 'breaking',
          kinds: ['type', 'signature', 'required'],
          symbols: /^TS(?:2741|2746|2786|7026)$/,
          guide: 'set jsxImportSource',
        },
      ],
      instructions: 'migrate',
    });
    expect(ruleFor(pack.rules, anchor)?.id).toBe('global-jsx-namespace');
    expect(pack.ruleOf?.(anchor)).toBe('global-jsx-namespace');
    expect(ruleFor(pack.rules, { ...anchor, downstream: [] })).toBeUndefined();
  });
});
