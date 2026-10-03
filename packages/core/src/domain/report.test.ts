import { describe, expect, it } from 'vitest';
import { requireFindUsages } from '../check/capabilities.js';
import { AdapterCapabilityError } from '../errors.js';
import type { LanguageAdapter } from './adapter.js';
import type { Change } from './change.js';
import type { Finding } from './report.js';
import type { ApiSurface } from './surface.js';
import { USAGE_CERTAINTY, type Usage } from './usage.js';

const surfaceStub: ApiSurface = {
  package: 'p',
  version: '1',
  extractedAt: '',
  adapter: 'fake',
  symbols: [],
};

/**
 * The direction table in docs/architecture.md before any matching code exists: a
 * `widened` change is additive on its own, and breaking once we see the consumer READ the
 * member. This is the first case step 4's `match` has to reproduce.
 */
describe('Finding', () => {
  const change: Change = {
    package: 'axios',
    from: '0.27.2',
    to: '1.7.0',
    path: 'AxiosRequestConfig#signal',
    kind: 'widened',
    severity: 'additive',
    before: 'AbortSignal',
    after: 'GenericAbortSignal',
    source: 'types',
    confidence: 0.6,
    notes: 'type widened; breaking if the member is read by the consumer',
  };
  const usage: Usage = {
    file: 'src/http.ts',
    line: 12,
    column: 5,
    endLine: 12,
    endColumn: 18,
    symbolPath: 'AxiosRequestConfig#signal',
    access: 'read',
    snippet: 'const s = config.signal.reason;',
    via: 'direct',
  };

  it('may carry a severity that differs from its change once the direction of use is known', () => {
    const finding: Finding = {
      change,
      usage,
      severity: 'breaking',
      confidence: change.confidence * USAGE_CERTAINTY[usage.via],
      fixability: 'assisted',
      reason: 'widened type is read by the consumer',
    };
    expect(finding.change.severity).toBe('additive');
    expect(finding.severity).toBe('breaking');
    expect(finding.confidence).toBeCloseTo(0.6);
  });

  it('the check pipeline refuses an adapter without findUsages instead of reporting no impact', () => {
    const adapter: LanguageAdapter = { id: 'fake', extractSurface: async () => surfaceStub };
    expect(() => requireFindUsages(adapter)).toThrow(AdapterCapabilityError);
    expect(() => requireFindUsages(adapter)).toThrow(/does not implement findUsages/);
  });

  it('usage certainty is fixed per via', () => {
    expect(USAGE_CERTAINTY).toEqual({
      direct: 1,
      alias: 0.95,
      reexport: 0.95,
      destructure: 0.9,
      inferred: 0.8,
      require: 0.85,
    });
  });
});
