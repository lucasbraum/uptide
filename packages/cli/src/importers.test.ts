import type { PackageReport } from '@uptide/core';
import { describe, expect, it } from 'vitest';
import { analyzedImporters, importerNotes } from './importers.js';

const pkg = (over: Partial<PackageReport>): PackageReport => ({
  workspace: '*',
  name: 'stripe',
  installed: '14.25.0',
  latest: '23.0.0',
  target: '23.0.0',
  majorsBehind: 9,
  findings: [],
  callSitesChecked: 12,
  unanalyzed: [],
  status: 'breaking',
  notes: [],
  timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
  ...over,
});

describe('importer notes', () => {
  it('names an undeclared importer and where its copy comes from, and an importer it could not analyze', () => {
    const p = pkg({
      importers: [
        { workspace: 'packages/core', declared: true, analyzed: true },
        { workspace: 'ui', declared: false, via: '@acme/core', analyzed: true },
        { workspace: 'worker', declared: true, analyzed: true },
        { workspace: '.', declared: false, analyzed: false, reason: 'does not resolve from .' },
        { workspace: 'ee/agent', declared: true, analyzed: false, reason: 'no lockfile' },
      ],
    });
    expect(importerNotes(p)).toEqual([
      'ui · imports stripe without declaring it (resolved via @acme/core)',
      'root · imports stripe without declaring it, not analyzed: does not resolve from .',
      'ee/agent · imports stripe, not analyzed: no lockfile',
    ]);
    expect(analyzedImporters(p)).toBe('packages/core, ui (undeclared, via @acme/core), worker');
  });

  it('says nothing when every importer declares the package and was analyzed', () => {
    const p = pkg({
      importers: [
        { workspace: 'api', declared: true, analyzed: true },
        { workspace: 'web', declared: true, analyzed: true },
      ],
    });
    expect(importerNotes(p)).toEqual([]);
    expect(analyzedImporters(p)).toBe('api, web');
    expect(analyzedImporters(pkg({}))).toBeUndefined();
  });
});
