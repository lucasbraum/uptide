import { describe, expect, it } from 'vitest';
import type { Change } from '../domain/change.js';
import type { Finding, RuntimeReport } from '../domain/report.js';
import type { RuntimeChange } from '../domain/runtime.js';
import type { Usage } from '../domain/usage.js';
import { arbitrateUnchecked } from './file-kind.js';

function finding(
  symbolPath: string,
  access: Usage['access'],
  over: Partial<Usage> = {},
  change: Partial<Change> = {},
  severity: Finding['severity'] = 'breaking',
): Finding {
  return {
    change: {
      package: 'plain',
      from: '1.0.0',
      to: '3.0.0',
      path: symbolPath,
      kind: 'removed',
      severity: 'breaking',
      source: 'types',
      confidence: 0.9,
      evidence: 'checker',
      ...change,
    },
    usage: {
      file: 'src/a.js',
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 5,
      symbolPath,
      access,
      snippet: '',
      via: 'direct',
      loader: 'require',
      checked: false,
      ...over,
    },
    severity,
    confidence: 0.9,
    fixability: 'assisted',
    reason: 'removed',
  };
}

const runtime = (changes: RuntimeChange[], inconclusive?: string): RuntimeReport => ({
  package: 'plain',
  node: 'v22.20.0',
  nodeSource: 'repository',
  changes,
  ...(inconclusive ? { inconclusive } : {}),
});

describe('arbitrateUnchecked', () => {
  it('leaves type-checked files, deprecations and module-format findings alone', () => {
    const typed = finding('legacy', 'call', { checked: undefined });
    const format = finding('.', 'import', {}, { kind: 'module-format' });
    const deprecated = finding('legacy', 'call', {}, { kind: 'deprecated' }, 'deprecated');
    const out = arbitrateUnchecked([typed, format, deprecated], runtime([]), 'plain');
    expect(out.map((f) => f.severity)).toEqual(['breaking', 'breaking', 'deprecated']);
  });

  it('confirms a removed key the site reads, and demotes one it does not', () => {
    const gone: RuntimeChange = {
      kind: 'key-removed',
      key: 'legacy',
      loader: 'require',
      detail: '`legacy` is no longer an export of require()',
    };
    const out = arbitrateUnchecked(
      [finding('legacy', 'call'), finding('hello', 'call')],
      runtime([gone]),
      'plain',
    );
    expect(out.map((f) => f.severity)).toEqual(['breaking', 'info']);
    expect(out[0]?.reason).toMatch(/confirmed at runtime \(v22\.20\.0\): `legacy` is no longer/);
    expect(out[1]?.reason).toMatch(
      /does not type-check this file, and the target loads with the same shape/,
    );
    expect(out[1]).toMatchObject({ fixability: 'none', confidence: 0.3 });
  });

  it('confirms calling the module value when the runtime says it is a namespace now', () => {
    const ns: RuntimeChange = {
      kind: 'namespace-instead',
      loader: 'require',
      detail: 'require() returned a function and now returns a namespace',
    };
    const call = finding('plain', 'call', {}, { kind: 'type' });
    const member = finding('plain.hello', 'call', {}, { kind: 'type' });
    const out = arbitrateUnchecked([call, member], runtime([ns]), 'plain');
    expect(out.map((f) => f.severity)).toEqual(['breaking', 'info']);
    // The compiler's TS2349 "not callable" on a require() root, previously only a suspicion, is now a fact.
    const shape = finding(
      'plain',
      'call',
      { compileError: 'not callable', compileCode: 2349 },
      { path: 'TS2349', kind: 'type' },
      'unverified',
    );
    expect(arbitrateUnchecked([shape], runtime([ns]), 'plain')[0]?.severity).toBe('breaking');
    expect(arbitrateUnchecked([shape], runtime([]), 'plain')[0]?.severity).toBe('info');
  });

  it('confirms a load that throws for the loader the site uses', () => {
    const throws: RuntimeChange = {
      kind: 'require-throws',
      loader: 'require',
      detail: 'require() now throws ERR_REQUIRE_ESM',
    };
    const viaRequire = finding('hello', 'call');
    const viaImport = finding('hello', 'call', { loader: 'import' });
    const out = arbitrateUnchecked([viaRequire, viaImport], runtime([throws]), 'plain');
    expect(out.map((f) => f.severity)).toEqual(['breaking', 'info']);
  });

  it('confirms a lost constructor for a `new` site only', () => {
    const lost: RuntimeChange = {
      kind: 'constructable-lost',
      loader: 'require',
      detail: 'cannot be used with `new`',
    };
    const out = arbitrateUnchecked(
      [finding('default', 'construct'), finding('default', 'call')],
      runtime([lost]),
      undefined,
    );
    expect(out.map((f) => f.severity)).toEqual(['breaking', 'info']);
  });

  it('is unverified without a probe, with an inconclusive one, or for a subpath the probe never loads', () => {
    const f = finding('legacy', 'call');
    expect(arbitrateUnchecked([f], undefined, 'plain')[0]).toMatchObject({
      severity: 'unverified',
    });
    expect(arbitrateUnchecked([f], undefined, 'plain')[0]?.reason).toMatch(/probe did not run/);
    const inc = arbitrateUnchecked([f], runtime([], 'native addon'), 'plain')[0];
    expect(inc?.reason).not.toContain('native addon');
    expect(inc?.severity).toBe('unverified');
    const sub = finding('"./sub":x', 'call');
    expect(arbitrateUnchecked([sub], runtime([]), 'plain')[0]?.reason).toMatch(
      /only loads the package root/,
    );
  });
});
