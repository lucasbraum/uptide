import type { UpgradePlan } from '@uptide/core';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { formatPlan } from './format-plan.js';
import { renderPlanHtml } from './html/plan.js';
import { checkResult, fakeEngine, memoryIo, npmRepo } from './test-utils.js';

const effort = (level: 'none' | 'small' | 'medium' | 'large', over = {}) => ({
  level,
  byRule: 0,
  byAgent: 0,
  manual: 0,
  unconfirmed: 0,
  ...over,
});
const plan: UpgradePlan = {
  steps: [
    {
      order: 1,
      together: 'no-impact',
      effort: 'none',
      constraints: [],
      packages: [
        {
          name: 'typescript',
          installed: '5.9.3',
          target: '6.0.2',
          tier: 'generic',
          effort: effort('none'),
        },
        {
          name: 'vitest',
          installed: '3.2.4',
          target: '5.0.3',
          tier: 'generic',
          effort: effort('none'),
        },
      ],
    },
    {
      order: 2,
      effort: 'small',
      constraints: [],
      packages: [
        {
          name: 'zod',
          installed: '3.25.76',
          target: '4.6.5',
          tier: 'verified',
          effort: effort('small', { byRule: 24, byAgent: 4 }),
        },
      ],
    },
    {
      order: 3,
      effort: 'medium',
      constraints: [
        {
          from: 'react-dom',
          fromVersion: '19.2.0',
          on: 'react',
          range: '^19.0.0',
          effect: 'before',
          reason: 'react-dom 19.2.0 needs react ^19.0.0 (installed: 18.3.1): upgrade react first',
        },
        {
          from: 'old-plugin',
          fromVersion: '1.0.0',
          on: 'react-dom',
          range: '^18.0.0',
          effect: 'blocked',
          reason:
            'old-plugin 1.0.0 needs react-dom ^18.0.0, and react-dom 19.2.0 is outside it; old-plugin has no upgrade in this plan',
        },
      ],
      packages: [
        {
          name: 'react-dom',
          installed: '18.3.1',
          target: '19.2.0',
          tier: 'generic',
          effort: effort('medium', { byAgent: 7, unconfirmed: 2 }),
        },
      ],
    },
  ],
  notPlanned: [{ name: 'next', installed: '14.2.0', reason: 'not analyzed: out of time' }],
};
const header = { repo: 'shop', manager: 'pnpm', packages: 0, ms: 12_000 };

describe('formatPlan', () => {
  it('prints the steps in order with target, tier, effort, constraints and the command', () => {
    const out = formatPlan(plan, { color: false, header, invocation: 'npx uptide', fixable: true });
    expect(out).toBe(
      [
        'uptide plan · shop (pnpm) · 12s',
        '',
        '1  Bump together: 2 packages, nothing in your code is affected',
        '   typescript 5.9.3 → 6.0.2   generic',
        '   vitest 3.2.4 → 5.0.3   generic',
        '',
        '2  zod 3.25.76 → 4.6.5   verified',
        '   small · 28 sites: 24 by rule, 4 by agent',
        '   npx uptide fix zod',
        '',
        '3  react-dom 18.3.1 → 19.2.0   generic',
        '   medium · 7 sites: 7 by agent · 2 unconfirmed to look at',
        '   peer: react-dom 19.2.0 needs react ^19.0.0 (installed: 18.3.1): upgrade react first',
        '   ✗ blocked: old-plugin 1.0.0 needs react-dom ^18.0.0, and react-dom 19.2.0 is outside it; old-plugin has no upgrade in this plan',
        '   npx uptide fix react-dom',
        '',
        'Not planned',
        '  next 14.2.0: not analyzed: out of time',
        '  npx uptide list    refresh discovery',
        '',
        'verified: migration pack · generic: no pack, breaking only if the compiler or the runtime probe confirms it',
        'Effort is an estimate from the findings: none (nothing affected), small (rules, or up to 5 sites by hand or agent), medium (up to 25), large (more).',
        '',
      ].join('\n'),
    );
    // Where fix cannot run, no command is offered.
    expect(formatPlan(plan, { color: false })).not.toContain('fix --only');
    expect(formatPlan({ steps: [], notPlanned: [] }, { color: false })).toContain(
      'Nothing to plan',
    );
  });

  it('renders the same plan as a page with no script and no network', () => {
    const html = renderPlanHtml(plan, {
      header,
      version: '0.3.0',
      date: '2026-10-02T12:00:00Z',
      timeZone: 'America/Los_Angeles',
      fixable: true,
    });
    expect(html).toContain('<h2>2. zod 3.25.76 → 4.6.5</h2>');
    expect(html).toContain('effort: medium');
    expect(html).toContain('Blocked: old-plugin 1.0.0 needs react-dom ^18.0.0');
    expect(html).toContain('next 14.2.0: not analyzed: out of time');
    expect(html).toContain('npx uptide fix zod');
    expect(html).not.toMatch(/<script|<img|<link|src=/i);
    expect(html).toContain("connect-src 'none'");
    // Names from a manifest are data, never markup.
    const hostile = structuredClone(plan);
    (hostile.steps[1] as (typeof hostile.steps)[number]).packages[0] = {
      ...(plan.steps[1]?.packages[0] as (typeof plan.steps)[number]['packages'][number]),
      name: '<img onerror=alert(1)>',
    };
    expect(
      renderPlanHtml(hostile, { header, version: '0.3.0', date: '2026-10-02T12:00:00Z' }),
    ).not.toContain('<img');
  });
});

describe('uptide plan', () => {
  it('asks the engine for discovery without implicit analysis, prints the plan, exits 0', async () => {
    const cwd = npmRepo();
    const asked: unknown[] = [];
    const engine = fakeEngine({
      plan: async (request) => {
        asked.push(request);
        return { report: checkResult(), plan };
      },
    });
    const io = memoryIo({ cwd });
    expect(await run(['plan'], io, engine)).toBe(0);
    expect(asked).toEqual([expect.objectContaining({ cwd, only: undefined })]);
    expect(io.stdout()).toMatch(/^uptide plan · shop \(npm\) · \d+ms\n/);
    expect(io.stdout()).toContain('2  zod 3.25.76 → 4.6.5   verified');
    const json = memoryIo({ cwd });
    await run(['plan', '--json', '--only', 'zod'], json, engine);
    expect(JSON.parse(json.stdout()).steps).toHaveLength(3);
    expect(asked.at(-1)).toMatchObject({ only: ['zod'] });
    expect(asked.at(-1)).not.toHaveProperty('maxTimeMs');
  });

  it('exits 2 when a dependency failed to analyze, and still prints the plan for the rest', async () => {
    const report = checkResult();
    report.packages = [
      {
        workspace: '.',
        name: 'stripe',
        installed: '14.25.0',
        latest: '14.25.0',
        target: '14.25.0',
        majorsBehind: 0,
        findings: [],
        callSitesChecked: 0,
        unanalyzed: [],
        status: 'skipped',
        skipReason: 'ANALYSIS_FAILED',
        notes: ['analysis failed: out of memory'],
        timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
      },
    ];
    const io = memoryIo({ cwd: npmRepo() });
    expect(await run(['plan'], io, fakeEngine({ plan: async () => ({ report, plan }) }))).toBe(2);
    expect(io.stdout()).toContain('2  zod 3.25.76 → 4.6.5   verified');
  });
});
