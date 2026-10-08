import { describe, expect, it } from 'vitest';
import type { Finding, RuntimeReport } from '../domain/report.js';
import { stripePack } from '../packs/stripe/index.js';
import { zodPack } from '../packs/zod/index.js';
import { isBehind, rankCandidates } from './rank.js';
import { confirmBreaking, evidenceOf, tierOf } from './tier.js';

const finding = (
  change: Partial<Finding['change']>,
  usage: Partial<Finding['usage']> = {},
): Finding =>
  ({
    severity: 'breaking',
    confidence: 1,
    fixability: 'assisted',
    reason: 'signature changed',
    change: {
      package: 'sharp',
      path: 'sharp.resize',
      kind: 'signature',
      source: 'types',
      ...change,
    },
    usage: { file: 'src/a.ts', line: 3, symbolPath: 'sharp.resize', access: 'call', ...usage },
  }) as Finding;

describe('tiers', () => {
  it('is verified only where a pack covers the upgrade', () => {
    const packs = [zodPack, stripePack];
    expect(tierOf(packs, 'zod', '3.25.76', '4.6.5')).toBe('verified');
    expect(tierOf(packs, 'stripe', '14.25.0', '23.0.0')).toBe('verified');
    // The zod pack is about 3 → 4; another zod upgrade has no pack behind it.
    expect(tierOf(packs, 'zod', '4.0.0', '4.6.5')).toBe('generic');
    expect(tierOf(packs, 'express', '4.21.2', '5.2.1')).toBe('generic');
  });
});

describe('evidence for a breaking finding', () => {
  const runtime = {
    package: 'sharp',
    node: 'v22.20.0',
    nodeSource: 'current',
    changes: [{ kind: 'key-removed', key: 'cache', loader: 'import', detail: 'cache is gone' }],
  } as RuntimeReport;

  it('names the compiler, the runtime probe, the module format or the removed export', () => {
    expect(evidenceOf(finding({}, { compileError: 'Expected 2 arguments, but got 1.' }))).toBe(
      'compiler',
    );
    expect(evidenceOf(finding({ path: 'TS2345', kind: 'type' }))).toBe('compiler');
    expect(evidenceOf(finding({ path: '.', kind: 'module-format' }, { access: 'import' }))).toBe(
      'module-format',
    );
    expect(
      evidenceOf(
        finding({ path: 'cache', kind: 'removed' }, { symbolPath: 'cache', access: 'call' }),
        runtime,
      ),
    ).toBe('runtime');
    expect(
      evidenceOf(
        finding({ path: 'cache', kind: 'removed' }, { symbolPath: 'cache', access: 'import' }),
      ),
    ).toBe('removed-export');
    // The declarations changed and nothing else says the code breaks.
    expect(evidenceOf(finding({}))).toBeUndefined();
    // A member of something still exported is not a removed export.
    expect(
      evidenceOf(finding({ path: 'Sharp#cache', kind: 'removed' }, { access: 'import' })),
    ).toBeUndefined();
  });

  it('keeps breaking only what has evidence; the rest is unverified, with the reason', () => {
    const confirmed = finding({}, { compileError: 'Expected 2 arguments, but got 1.' });
    const bare = finding({});
    const deprecated = { ...finding({ kind: 'deprecated' }), severity: 'deprecated' } as Finding;
    const out = confirmBreaking([confirmed, bare, deprecated], (f) => evidenceOf(f));
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      ['breaking', 'compiler'],
      ['unverified', undefined],
      ['deprecated', undefined],
    ]);
    expect(out[1]?.reason).toBe(
      'signature changed; not confirmed by the compiler or the runtime probe',
    );
  });
});

describe('ranking what to analyze first', () => {
  it('puts major upgrades first, then the most imported, and is stable', () => {
    const ranked = rankCandidates([
      { name: 'lodash', installed: '4.17.20', latest: '4.17.21', importSites: 40 },
      { name: 'express', installed: '4.21.2', latest: '5.2.1', importSites: 3 },
      { name: 'zod', installed: '3.25.76', latest: '4.6.5', importSites: 12 },
      { name: 'ghost', installed: '1.0.0', importSites: 12 },
      { name: 'axios', installed: '1.7.0', latest: '1.9.0', importSites: 12 },
    ]);
    expect(ranked.map((c) => c.name)).toEqual(['zod', 'express', 'lodash', 'axios', 'ghost']);
    expect(isBehind({ installed: '1.0.0', latest: '1.0.0' })).toBe(false);
    expect(isBehind({ installed: '1.0.0' })).toBe(false);
  });
});
