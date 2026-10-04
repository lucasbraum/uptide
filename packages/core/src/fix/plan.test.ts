import { describe, expect, it } from 'vitest';
import type { Change } from '../domain/change.js';
import type { Finding, PackageReport } from '../domain/report.js';
import type { Usage } from '../domain/usage.js';
import { stripePack } from '../packs/stripe/index.js';
import { zodPack } from '../packs/zod/index.js';
import { planPackage } from './plan.js';

const finding = (
  change: Partial<Change>,
  usage: Partial<Usage>,
  rest: Partial<Omit<Finding, 'change' | 'usage'>> = {},
): Finding => ({
  severity: 'breaking',
  confidence: 0.9,
  fixability: 'manual',
  reason: 'changed',
  ...rest,
  change: {
    package: 'zod',
    from: '3.25.76',
    to: '4.6.5',
    path: 'string',
    kind: 'signature',
    severity: 'breaking',
    source: 'types',
    confidence: 0.9,
    ...change,
  },
  usage: {
    file: 'src/schemas.ts',
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 2,
    symbolPath: 'string',
    access: 'call',
    snippet: '',
    via: 'direct',
    ...usage,
  },
});

const pkg = (findings: Finding[], over: Partial<PackageReport> = {}): PackageReport => ({
  workspace: '.',
  name: 'zod',
  installed: '3.25.76',
  latest: '4.6.5',
  target: '4.6.5',
  majorsBehind: 1,
  findings,
  callSitesChecked: findings.length,
  unanalyzed: [],
  status: 'breaking',
  notes: [],
  timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
  ...over,
});

const SCHEMAS = [
  "import { z } from 'zod';",
  "export const name = z.string({ required_error: 'Name is required' });",
  'export const address = z.string().ip();',
  'export const mail = z.string().email();',
  'export const strict = z.string().min(1).email();',
].join('\n');
const ADAPTER = [
  "import { type ZodType, type ZodTypeDef } from 'zod';",
  'export class Adapter<T> {',
  '  constructor(private schema: ZodType<T, ZodTypeDef, unknown>) {}',
  '  parse(x: unknown) { return this.schema.parse(x); }',
  '}',
].join('\n');
const read = (file: string): string | undefined =>
  ({ 'src/schemas.ts': SCHEMAS, 'src/adapter.ts': ADAPTER })[file];

describe('planPackage', () => {
  it('labels each rule by what the pack transform does in a dry run', () => {
    const plan = planPackage(
      pkg([
        finding(
          { path: 'string' },
          { line: 2, column: 21, compileError: 'No overload matches this call.' },
        ),
        finding(
          { path: 'ZodString#ip', kind: 'removed' },
          {
            line: 3,
            column: 35,
            compileError: "Property 'ip' does not exist on type 'ZodString'.",
          },
        ),
      ]),
      zodPack,
      read,
    );
    expect(plan.map((g) => [g.rule, g.title, g.by, g.sites, g.fixes])).toEqual([
      [
        'error-params',
        'New error API (required_error → error)',
        { rule: 1, agent: 0, manual: 0 },
        1,
        1,
      ],
      ['ip', '.ip() removed', { rule: 0, agent: 1, manual: 0 }, 1, 1],
    ]);
    expect(plan[1]?.detail).toBe("Property 'ip' does not exist on type 'ZodString'.");
    expect(plan[1]?.locations).toEqual([{ file: 'src/schemas.ts', line: 3 }]);
  });

  it('folds the errors of one file into the per-file rule: one fix, several errors', () => {
    const plan = planPackage(
      pkg([
        finding(
          { path: 'ZodType' },
          {
            file: 'src/adapter.ts',
            line: 3,
            column: 31,
            compileError: "Type 'unknown' does not satisfy the constraint 'ZodTypeDef'.",
          },
        ),
        finding(
          { path: 'TS2724', kind: 'type' },
          {
            file: 'src/adapter.ts',
            line: 1,
            column: 1,
            compileCode: 2724,
            compileError: "'\"zod\"' has no exported member named 'ZodTypeDef'.",
          },
        ),
        // A root-cause anchor stands for the errors under it; each is a site of the same fix.
        finding(
          { path: 'cause:schema', kind: 'cause' },
          { file: 'src/adapter.ts', line: 3, column: 3 },
          {
            downstream: [
              {
                file: 'src/adapter.ts',
                line: 4,
                code: 2345,
                message: "Argument of type 'unknown'.",
              },
            ],
          },
        ),
      ]),
      zodPack,
      read,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      rule: 'types',
      title: 'ZodTypeDef removed',
      by: { rule: 0, agent: 3, manual: 0 },
      sites: 3,
      fixes: 1,
    });
  });

  it('plans deprecations apart, with the names as written and what a rule takes', () => {
    const deprecated = (line: number, column: number): Finding =>
      finding(
        { path: 'ZodString#email', kind: 'deprecated', severity: 'deprecated' },
        { line, column },
        { severity: 'deprecated', reason: 'Use `z.email()` instead.' },
      );
    const plan = planPackage(pkg([deprecated(4, 30), deprecated(5, 39)]), zodPack, read);
    // `z.string().email()` is a rule; `z.string().min(1).email()` is not rooted at z.string().
    expect(plan.map((g) => [g.severity, g.rule, g.by, g.symbols])).toEqual([
      ['deprecated', 'string-format', { rule: 1, agent: 0, manual: 0 }, { '.email': 1 }],
      ['deprecated', 'ZodString#email', { rule: 0, agent: 1, manual: 0 }, { '.email': 1 }],
    ]);
  });

  it('without a pack, sends confirmed breaking sites to the agent and nothing to a rule', () => {
    const removed = finding({ package: 'sharp', path: 'sharp.cache', kind: 'removed' }, {});
    const noPack = planPackage(pkg([removed], { name: 'sharp' }));
    expect(noPack[0]).toMatchObject({
      rule: 'sharp.cache',
      title: 'sharp.cache removed',
      by: { rule: 0, agent: 1, manual: 0 },
    });
    // What nothing confirmed is nobody's to migrate unasked.
    const unconfirmed = planPackage(
      pkg([{ ...removed, severity: 'unverified' }], { name: 'sharp' }),
    );
    expect(unconfirmed[0]?.by).toEqual({ rule: 0, agent: 0, manual: 1 });
    // zod 4 → 4 is outside the pack: no rule is promised; it is a generic upgrade.
    const sameMajor = planPackage(
      pkg([finding({ path: 'string' }, { line: 2, column: 21 })], { installed: '4.0.0' }),
      zodPack,
      read,
    );
    expect(sameMajor[0]?.by).toEqual({ rule: 0, agent: 1, manual: 0 });
  });

  it('keeps a pack finding marked manual as a decision, under the rule the pack named', () => {
    const unpinned = finding(
      {
        package: 'stripe',
        from: '14.25.0',
        to: '23.0.0',
        path: 'Stripe.StripeConfig#apiVersion',
        kind: 'type',
        source: 'pack',
        confidence: 1,
      },
      {
        file: 'src/stripe.ts',
        line: 2,
        symbolPath: 'Stripe.StripeConfig#apiVersion',
        access: 'construct',
      },
      { confidence: 1, rule: 'api-version-unpinned', reason: 'API version changes at runtime' },
    );
    const plan = planPackage(
      pkg([unpinned], { name: 'stripe', installed: '14.25.0', target: '23.0.0' }),
      stripePack,
      () => "import Stripe from 'stripe';\nexport const stripe = new Stripe(key);\n",
    );
    expect(plan[0]).toMatchObject({
      rule: 'api-version-unpinned',
      title: 'client without apiVersion: the API version changes at runtime',
      by: { rule: 0, agent: 0, manual: 1 },
      detail: 'API version changes at runtime',
    });
  });

  it('gives compiler-only findings a plain title and keeps the raw message as detail', () => {
    const plan = planPackage(
      pkg(
        [
          finding(
            { package: 'sharp', path: 'TS2554', kind: 'type' },
            { compileCode: 2554, compileError: 'Expected 2 arguments, but got 1.' },
          ),
        ],
        { name: 'sharp' },
      ),
    );
    expect(plan[0]).toMatchObject({
      title: 'A call passes the wrong number of arguments',
      detail: 'Expected 2 arguments, but got 1.',
    });
  });

  it('names the value and the types when every site of a compiler-only rule says the same', () => {
    const site = (line: number, snippet: string, compileError: string): Finding =>
      finding(
        { package: 'stripe', path: 'TS2322', kind: 'type', source: 'types', confidence: 1 },
        { file: 'src/route.ts', line, snippet, compileError, compileCode: 2322 },
        { confidence: 1, reason: 'type error' },
      );
    const one = planPackage(
      pkg(
        [
          site(
            159,
            'billing_cycle_anchor: "now",',
            "Type 'string' is not assignable to type 'BillingCycleAnchor'.",
          ),
        ],
        { name: 'stripe' },
      ),
    );
    expect(one[0]?.title).toBe(
      'billing_cycle_anchor no longer accepts a string (expects BillingCycleAnchor)',
    );
    const two = planPackage(
      pkg(
        [
          site(
            159,
            'billing_cycle_anchor: "now",',
            "Type 'string' is not assignable to type 'BillingCycleAnchor'.",
          ),
          site(
            200,
            'proration_behavior: "x",',
            "Type 'string' is not assignable to type 'ProrationBehavior'.",
          ),
        ],
        { name: 'stripe' },
      ),
    );
    expect(two[0]?.title).toBe('A value no longer has the expected type');
    const argument = planPackage(
      pkg(
        [
          finding(
            { package: 'stripe', path: 'TS2345', kind: 'type', confidence: 1 },
            {
              line: 3,
              snippet: 'retrieve(id)',
              compileError:
                "Argument of type 'number' is not assignable to parameter of type 'string'.",
              compileCode: 2345,
            },
            { confidence: 1 },
          ),
        ],
        { name: 'stripe' },
      ),
    );
    expect(argument[0]?.title).toBe('An argument of type number no longer matches string');
  });

  it('leaves out findings under 50% confidence, info and additive ones', () => {
    const plan = planPackage(
      pkg([
        finding({ path: 'ZodString#ip', kind: 'removed' }, { line: 3 }, { confidence: 0.4 }),
        finding({ path: 'string' }, { line: 2 }, { severity: 'info' }),
      ]),
      zodPack,
      read,
    );
    expect(plan).toEqual([]);
  });
});

describe('stripe plan note', () => {
  const apiVersions = { from: '2026-07-29.dahlia', to: '2026-09-30.endive' };
  const context = { from: '22.5.0', to: '23.0.0', includeDeprecated: false, apiVersions };
  it('counts the API changelog entries with evidence in the code', () => {
    expect(stripePack.planNote?.('api-version', { ...context, evidence: [] })).toMatch(
      /^none of the \d+ API changes since 2026-07-29\.dahlia has evidence in your code$/,
    );
    expect(stripePack.planNote?.('sdk-surface', context)).toBeUndefined();
    expect(
      stripePack.planNote?.('api-version', { ...context, apiVersions: undefined }),
    ).toBeUndefined();
  });
});
