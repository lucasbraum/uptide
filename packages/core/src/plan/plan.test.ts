import { describe, expect, it } from 'vitest';
import type { CheckReport, PackageReport, PlanGroup } from '../domain/report.js';
import { effortOf, type PeerLookup, planUpgrades } from './plan.js';

const group = (
  by: Partial<PlanGroup['by']>,
  severity: PlanGroup['severity'] = 'breaking',
): PlanGroup => {
  const full = { rule: 0, agent: 0, manual: 0, ...by };
  const sites = full.rule + full.agent + full.manual;
  return {
    rule: 'r',
    title: 't',
    severity,
    by: full,
    sites,
    fixes: sites,
    locations: [],
    detail: '',
  };
};
const pkg = (
  name: string,
  installed: string,
  target: string,
  over: Partial<PackageReport> = {},
): PackageReport => ({
  workspace: '.',
  name,
  installed,
  latest: target,
  target,
  majorsBehind: 1,
  findings: [],
  callSitesChecked: 3,
  unanalyzed: [],
  status: 'safe',
  tier: 'generic',
  notes: [],
  timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
  ...over,
});
const report = (packages: PackageReport[]): CheckReport =>
  ({ repo: '/repo', workspaces: ['.'], packages, summary: {} }) as CheckReport;
const targets =
  (table: Record<string, Record<string, string>>) =>
  (name: string): Record<string, string> =>
    table[name] ?? {};
const noPeers: PeerLookup = { ofTarget: () => ({}), installed: {} };
const names = (plan: ReturnType<typeof planUpgrades>): string[][] =>
  plan.steps.map((s) => s.packages.map((p) => p.name));

describe('effort from findings', () => {
  it('counts breaking sites by who migrates them, and sizes the work by the hands-on ones', () => {
    expect(effortOf({ plan: [] })).toEqual({
      level: 'none',
      byRule: 0,
      byAgent: 0,
      manual: 0,
      unconfirmed: 0,
    });
    expect(effortOf({ plan: [group({ rule: 24 })] }).level).toBe('small');
    expect(effortOf({ plan: [group({ rule: 24, agent: 4 })] })).toMatchObject({
      level: 'small',
      byRule: 24,
      byAgent: 4,
    });
    expect(effortOf({ plan: [group({ agent: 6 })] }).level).toBe('medium');
    expect(effortOf({ plan: [group({ agent: 20, manual: 6 })] }).level).toBe('large');
    // Deprecations cost nothing now; unconfirmed sites are something to look at.
    expect(effortOf({ plan: [group({ rule: 9 }, 'deprecated')] }).level).toBe('none');
    expect(effortOf({ plan: [group({ manual: 2 }, 'unverified')] })).toMatchObject({
      level: 'small',
      unconfirmed: 2,
    });
  });
});

describe('the upgrade plan', () => {
  it('bumps what touches nothing together first, then the rest from least to most work', () => {
    const plan = planUpgrades(
      report([
        pkg('stripe', '14.25.0', '23.0.0', {
          tier: 'verified',
          status: 'breaking',
          plan: [group({ rule: 1, agent: 8 })],
        }),
        pkg('vitest', '3.2.4', '5.0.3'),
        pkg('zod', '3.25.76', '4.6.5', {
          tier: 'verified',
          status: 'breaking',
          plan: [group({ rule: 24, agent: 4 })],
        }),
        pkg('typescript', '5.9.3', '6.0.2'),
        pkg('left-pad', '1.3.0', '1.3.0', { notes: ['up to date'] }),
      ]),
      noPeers,
    );
    expect(names(plan)).toEqual([['typescript', 'vitest'], ['zod'], ['stripe']]);
    expect(plan.steps.map((s) => [s.order, s.effort, s.together])).toEqual([
      [1, 'none', 'no-impact'],
      [2, 'small', undefined],
      [3, 'medium', undefined],
    ]);
  });

  it('puts a package after the peer its target needs, and says why', () => {
    const peers: PeerLookup = {
      ofTarget: targets({ 'react-dom': { react: '^19.0.0' } }),
      installed: {},
    };
    const plan = planUpgrades(
      report([
        pkg('react-dom', '18.3.1', '19.2.0'),
        pkg('react', '18.3.1', '19.2.0', { status: 'breaking', plan: [group({ agent: 3 })] }),
      ]),
      peers,
    );
    // react-dom alone would be "no impact", but it cannot go before react.
    expect(names(plan)).toEqual([['react'], ['react-dom']]);
    expect(plan.steps[1]?.constraints).toEqual([
      {
        from: 'react-dom',
        fromVersion: '19.2.0',
        on: 'react',
        range: '^19.0.0',
        effect: 'before',
        reason: 'react-dom 19.2.0 needs react ^19.0.0 (installed: 18.3.1): upgrade react first',
      },
    ]);
  });

  it('ties two packages whose targets need each other into one step', () => {
    const peers: PeerLookup = {
      ofTarget: targets({ 'react-dom': { react: '^19.0.0' }, react: { 'react-dom': '^19.0.0' } }),
      installed: {},
    };
    const plan = planUpgrades(
      report([pkg('react', '18.3.1', '19.2.0'), pkg('react-dom', '18.3.1', '19.2.0')]),
      peers,
    );
    expect(names(plan)).toEqual([['react', 'react-dom']]);
    expect(plan.steps[0]).toMatchObject({ together: 'peer' });
    expect(plan.steps[0]?.constraints.map((c) => c.effect)).toContain('together');
  });

  it('upgrades what depends on a package first when its new version accepts both', () => {
    // An installed plugin pins eslint ^8; its target accepts 8 and 9: plugin first, then eslint.
    const peers: PeerLookup = {
      ofTarget: targets({ 'eslint-plugin-x': { eslint: '^8.0.0 || ^9.0.0' } }),
      installed: { 'eslint-plugin-x': { version: '1.0.0', peers: { eslint: '^8.0.0' } } },
    };
    const plan = planUpgrades(
      report([pkg('eslint', '8.57.0', '9.12.0'), pkg('eslint-plugin-x', '1.0.0', '2.0.0')]),
      peers,
    );
    expect(names(plan)).toEqual([['eslint-plugin-x'], ['eslint']]);
    expect(plan.steps[1]?.constraints[0]?.reason).toBe(
      'eslint-plugin-x 1.0.0 needs eslint ^8.0.0: upgrade eslint-plugin-x to 2.0.0 first, which accepts eslint 9.12.0',
    );
  });

  it('names a peer range nothing in the plan satisfies as blocked, and still plans', () => {
    const peers: PeerLookup = {
      ofTarget: () => ({}),
      installed: { 'old-plugin': { version: '1.0.0', peers: { eslint: '^8.0.0' } } },
    };
    const plan = planUpgrades(report([pkg('eslint', '8.57.0', '9.12.0')]), peers);
    expect(names(plan)).toEqual([['eslint']]);
    expect(plan.steps[0]?.constraints).toEqual([
      expect.objectContaining({
        effect: 'blocked',
        reason:
          'old-plugin 1.0.0 needs eslint ^8.0.0, and eslint 9.12.0 is outside it; old-plugin has no upgrade in this plan',
      }),
    ]);
  });

  it('lists what was not analyzed apart, with the reason, and keeps a release group in one step', () => {
    const plan = planUpgrades(
      report([
        pkg('next', '14.2.0', '16.0.0', {
          status: 'skipped',
          skipReason: 'TIME_BUDGET',
          notes: ['time budget reached before this dependency'],
        }),
        pkg('pg', '8.11.0', '8.11.0', {
          status: 'skipped',
          skipReason: 'REGISTRY_HTTP_ERROR',
          target: '9.0.0',
          notes: ['could not fetch pg@9.0.0: HTTP 503'],
        }),
        pkg('@aws-sdk/*', '3.600.0', '3.900.0', {
          members: [
            { name: '@aws-sdk/client-s3', installed: '3.600.0', target: '3.900.0' },
            { name: '@aws-sdk/lib-storage', installed: '3.600.0', target: '3.900.0' },
          ],
          status: 'breaking',
          plan: [group({ agent: 2 })],
        }),
      ]),
      noPeers,
    );
    expect(plan.notPlanned).toEqual([
      { name: 'next', installed: '14.2.0', reason: 'not analyzed: out of time' },
      {
        name: 'pg',
        installed: '8.11.0',
        reason: 'not analyzed: could not fetch pg@9.0.0: HTTP 503',
      },
    ]);
    expect(names(plan)).toEqual([['@aws-sdk/client-s3', '@aws-sdk/lib-storage']]);
  });
});
