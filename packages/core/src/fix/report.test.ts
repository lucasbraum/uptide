import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commentSummary } from '../action/run.js';
import type { CheckReport } from '../domain/report.js';
import { GENERIC_NOTE } from '../packs/generic.js';
import { stripePack } from '../packs/stripe/index.js';
import {
  apiChangeSummary,
  errorSummary,
  formatFix,
  migrationBody,
  migrationRisk,
  PR_BODY_BUDGET,
  prBody,
  renderMigration,
} from './report.js';
import type { FixReport } from './types.js';

function first<T>(items: T[] | undefined): T {
  const value = items?.[0];
  if (!value) throw new Error('missing fixture item');
  return value;
}
function fixture(name: string): FixReport {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), 'utf8'));
}
function visible(body: string): string {
  let depth = 0;
  return body
    .split('\n')
    .filter((line) => {
      const opens = (line.match(/<details>/g) ?? []).length;
      const closes = (line.match(/<\/details>/g) ?? []).length;
      const hidden = depth > 0 || opens > 0;
      depth += opens - closes;
      return !hidden;
    })
    .join('\n');
}
for (const name of ['storefront-zod', 'stripe'])
  describe(name, () => {
    it('snapshots the full PR description and compact terminal/comment summary', () => {
      const report = fixture(name);
      expect(prBody(report)).toMatchSnapshot();
      expect(formatFix(report)).toMatchSnapshot();
    });
    it('keeps paths, reasoning, probes and run metadata collapsed', () => {
      const report = fixture(name),
        body = prBody(report),
        top = visible(body);
      expect(top.match(/^\| \*\*/gm)).toHaveLength(5);
      // A decision names the file it is about; everything else above the fold stays path-free.
      expect(top.replace(/### Decisions for you\n[\s\S]*?(?=\n### |$)/, '')).not.toMatch(
        /packages\/|src\/|seed|methodology|tokens|claude|Diagnostic|earlier accepted edit/,
      );
      expect(body).toContain('<details><summary>Verification details</summary>');
      expect(body).toContain('<details><summary>Run details</summary>');
      expect(body).toContain('```diff');
      expect(top).toContain('### What changed');
      expect(formatFix(report)).not.toMatch(
        /<details>|### Worth a look|### Decisions|sampled inputs|No tests ran/,
      );
    });
    it('shares the compact renderer with the GitHub sticky comment', () => {
      const report = fixture(name);
      const check = { packages: [] } as unknown as CheckReport;
      const comment = commentSummary(
        [
          {
            name: report.package as 'zod' | 'stripe',
            from: first(report.sites).finding.change.from,
            to: report.target,
            workspaces: ['.'],
          },
        ],
        [check],
        [report],
        'Done.',
      );
      expect(comment).toContain(renderMigration(report, 'compact'));
    });
  });
it('matches the storefront counts and folds the two resolved diagnostics into one fix', () => {
  const body = prBody(fixture('storefront-zod'));
  expect(body).toContain('29 sites in 8 files · 25 auto-fixed · 4 fixed by the agent (LLM)');
  expect(body).toContain('✅ 5 tests in 3 files passed');
  // The one test that asserted zod 3's default wording was updated, and the owner is told.
  expect(visible(body)).toContain(
    '`packages/shared/src/monitoring.test.ts:21` `"Required"` → `"Invalid input: expected string, received undefined"`',
  );
  expect(body).toContain('9 schemas identical · 2 not checked · 21/21 custom-message assertions');
  // The two schemas that import the shared workspace package are named, not silently dropped.
  expect(body).toContain(
    '`signUpSchema` and `createOrderSchema`: behavior not checked (they import another schema file)',
  );
  expect(body).toContain('1 fix, 3 errors · by the agent (LLM)');
  expect(body.match(/^\*\*\d+\./gm)).toHaveLength(4);
  expect(body).not.toContain('diagnostic resolved by an earlier');
  expect(body).toContain('orders.ts` (6)');
});
it('groups stripe API literals and period-end accesses, with actionable business decisions', () => {
  const body = prBody(fixture('stripe'));
  expect(body.match(/^\*\*\d+\./gm)).toHaveLength(2);
  expect(body).toContain('### Decisions for you');
  expect(visible(body)).toContain("items ending `[100, 200]` → that item's `{ start, end }`");
  expect(visible(body)).toContain('what no items means');
  expect(visible(body)).not.toContain('Stripe API changelog');
});
function ruleOnly(): FixReport {
  const report = fixture('storefront-zod');
  report.sites = report.sites.filter(
    (s) => s.outcome === 'mechanical' && s.rule === 'error-params',
  );
  delete report.decisions;
  report.sites.forEach((s) => {
    s.finding.usage.file = 'plain.ts';
  });
  report.behavior = (report.behavior ?? []).filter((b) => !b.skipped);
  report.verification.tests.forEach((t) => {
    t.status = 'passed';
  });
  return report;
}
it('omits empty review and decision sections for a fully verified rule-only run', () => {
  const report = ruleOnly();
  expect(migrationRisk(report)).toEqual({ level: 'Low', reason: 'rule-only; all verified' });
  expect(prBody(report)).not.toContain('### Worth a look');
  expect(prBody(report)).not.toContain('### Decisions for you');
});
it('computes medium risk for agent edits, sensitive paths, missing tests and unchecked schemas', () => {
  for (const change of [
    (r: FixReport) => {
      first(r.sites).outcome = 'agent';
    },
    (r: FixReport) => {
      first(r.sites).finding.usage.file = 'src/auth/login.ts';
    },
    (r: FixReport) => {
      first(r.sites).finding.usage.file = 'src/billing.ts';
    },
    (r: FixReport) => {
      r.verification.tests = [];
    },
    (r: FixReport) => {
      first(r.behavior).skipped = 'import unavailable';
    },
  ]) {
    const report = ruleOnly();
    change(report);
    expect(migrationRisk(report).level).toBe('Medium');
  }
});
it('computes high risk for unverified sites, manual work, behavior differences and failed verification', () => {
  for (const change of [
    (r: FixReport) => {
      first(r.sites).finding.severity = 'unverified';
    },
    (r: FixReport) => {
      first(r.sites).outcome = 'manual';
    },
    (r: FixReport) => {
      r.verification.passed = false;
    },
    (r: FixReport) => {
      first(r.behavior).differences = [
        { kind: 'acceptance', input: '', before: true, after: false },
      ];
    },
    (r: FixReport) => {
      first(r.behavior).messageChecks = [
        {
          site: 'plain.ts:1',
          path: ['email'],
          input: 'missing',
          status: 'different',
          before: 'required',
          after: 'invalid',
        },
      ];
    },
  ]) {
    const report = ruleOnly();
    change(report);
    expect(migrationRisk(report).level).toBe('High');
    expect(visible(prBody(report))).toContain('Review required before merging.');
  }
});
it('shows a minimal behavior difference in the actionable review list', () => {
  const report = ruleOnly();
  first(report.behavior).differences = [
    { kind: 'acceptance', input: {}, before: false, after: true },
  ];
  expect(visible(prBody(report))).toContain('minimal example `{}` → before `false`, after `true`');
});
it('groups mixed mechanical and agent sites of the same rule only once', () => {
  const report = ruleOnly();
  first(report.sites).outcome = 'agent';
  expect(prBody(report).match(/^\*\*\d+\./gm)).toHaveLength(1);
});

it('limits coverage notes to multi-field objects and omits redundant missing-test logs', () => {
  const report = fixture('storefront-zod');
  report.behavior = [
    {
      file: 'schemas.ts',
      schema: 'objectCoverage',
      schemaKind: 'object',
      inputs: 200,
      identical: 200,
      validInputs: 1,
      differences: [],
    },
    {
      file: 'schemas.ts',
      schema: 'emailField',
      schemaKind: 'single-field',
      inputs: 200,
      identical: 200,
      validInputs: 1,
      differences: [],
    },
    {
      file: 'schemas.ts',
      schema: 'oneFieldObject',
      schemaKind: 'single-field',
      inputs: 200,
      identical: 200,
      validInputs: 1,
      differences: [],
    },
    {
      file: 'schemas.ts',
      schema: 'enumChoice',
      schemaKind: 'enum',
      inputs: 200,
      identical: 200,
      validInputs: 1,
      differences: [],
    },
    {
      file: 'schemas.ts',
      schema: 'literalChoice',
      schemaKind: 'literal',
      inputs: 200,
      identical: 200,
      validInputs: 1,
      differences: [],
    },
  ];
  // A workspace without tests: its "missing" log would repeat what the table says.
  for (const run of [...report.verification.tests, ...report.verification.baselineTests]) {
    run.status = 'missing';
    run.output = 'no test script';
  }
  const body = prBody(report);
  expect(body.match(/fewer than 20 valid inputs/g)).toHaveLength(1);
  expect(body).toContain('objectCoverage | 200 | 200 | 1 | 0; fewer than 20 valid inputs');
  expect(body).not.toContain('**Tests: packages/api**');
  expect(body).not.toContain('**Tests: packages/shared**');
  expect(body).toContain('| packages/api | missing | missing |');
  report.verification.tests[0] = {
    workspace: 'packages/api',
    status: 'failed',
    output: 'assertion failed',
  };
  expect(prBody(report)).toContain('**Tests: packages/api**');
  expect(prBody(report)).toContain('assertion failed');
});
it('shows the verifier version, tool commit and PR commit separately inside Run details', () => {
  const report = fixture('storefront-zod');
  const body = prBody(report);
  const details = body.split('<details><summary>Run details</summary>')[1];
  expect(details).toContain('Uptide 0.1.0');
  expect(details).toContain(`Uptide commit: \`${report.uptideCommit}\``);
  expect(details).toContain(`Verified commit: \`${report.head}\``);
  expect(visible(body)).not.toContain(report.uptideCommit ?? 'missing');
});
it('keeps the behavior evidence complete, including both webhook schemas and all custom messages', () => {
  const report = fixture('storefront-zod');
  const schemas = (report.behavior ?? []).filter(
    (b) => b.schema !== '(reported site)' && !b.skipped,
  );
  expect(schemas).toHaveLength(9);
  expect(schemas.reduce((n, b) => n + b.inputs, 0)).toBe(1800);
  expect(schemas.reduce((n, b) => n + b.identical, 0)).toBe(1800);
  expect(schemas.every((b) => !b.skipped && b.schemaKind && !b.differences.length)).toBe(true);
  const checks = schemas
    .flatMap((b) => b.messageChecks ?? [])
    .filter((c) => c.status !== 'default');
  expect(checks).toHaveLength(21);
  expect(checks.every((c) => c.status === 'identical')).toBe(true);
  for (const schema of ['paymentWebhookSchema', 'shipmentWebhookSchema']) {
    expect(schemas.find((b) => b.schema === schema)?.identical).toBe(200);
    expect(schemas.find((b) => b.schema === schema)?.loadedModules).toContain(
      'packages/api/src/routes/webhooks.ts',
    );
  }
});

describe('runs are scoped to their own repository', () => {
  const site = (file: string, line: number, over: Partial<FixReport['sites'][number]> = {}) =>
    ({
      outcome: 'agent',
      reason: 'migrated',
      ...over,
      finding: {
        severity: 'breaking',
        confidence: 1,
        fixability: 'assisted',
        reason: 'type incompatible',
        change: {
          package: 'stripe',
          from: '22.5.0',
          to: '22.6.2',
          path: 'Stripe.LatestApiVersion',
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
          endColumn: 2,
          symbolPath: 'Stripe.LatestApiVersion',
          access: 'write',
          snippet:
            'export const STRIPE_API_VERSION: Stripe.LatestApiVersion = "2026-07-29.dahlia";',
          via: 'direct',
        },
      },
    }) as FixReport['sites'][number];
  const run = (over: Partial<FixReport>): FixReport => ({
    repo: '/work/other',
    package: 'stripe',
    from: '22.5.0',
    target: '22.6.2',
    branch: 'uptide/stripe-22.6.2',
    sites: [],
    verification: {
      baseline: [],
      target: [],
      after: [],
      newErrors: [],
      baselineTests: [],
      tests: [{ workspace: 'packages/api', status: 'passed', output: '' }],
      passed: true,
    },
    llm: { inputTokens: 0, outputTokens: 0, costUsd: 0, available: true },
    timingMs: 1000,
    prBody: '/work/other/.uptide/pr-body.md',
    notes: [],
    ...over,
  });

  it('renders two stripe repositories in one process without one leaking into the other', () => {
    // Repository A: the fixture consumer, which migrated subscription period accesses.
    const a = fixture('stripe');
    // Repository B: only pins the API version; its review material comes from its own rules.
    const context = {
      from: '22.5.0',
      to: '22.6.2',
      includeDeprecated: false,
      apiVersions: { from: '2026-07-29.dahlia', to: '2026-08-26.dahlia' },
      payloadVersions: [
        { file: 'packages/api/src/webhook.test.ts', line: 12, value: '2026-07-29.dahlia' },
      ],
    };
    const rules = ['api-version'];
    const b = run({
      sites: [site('packages/api/src/modules/billing/container.ts', 68, { rule: 'api-version' })],
      reviewSections: stripePack.reviewSections?.(context, rules) ?? [],
      decisions: stripePack.decisions?.(context, rules) ?? [],
    });
    const first = prBody(a);
    const other = prBody(b);
    // B says nothing A's run decided, and names none of A's files.
    for (const foreign of [
      'current_period_end',
      'Subscription billing period',
      'latest-ending item',
      'empty item list',
      'empty items',
      'src/billing.ts',
    ])
      expect(other, foreign).not.toContain(foreign);
    // B's own decision is there, and only there.
    expect(other).toContain('### Decisions for you');
    expect(other).toContain('`api_version` stays `2026-07-29.dahlia` in 1 webhook payload fixture');
    expect(first).not.toContain('webhook.test.ts');
    expect(first).not.toContain('container.ts');
    // Rendering B changed nothing about A: no state survives between runs.
    expect(prBody(a)).toBe(first);
    expect(prBody(b)).toBe(other);
  });

  it('says in the verdict and the summary table when no API change affects the code', () => {
    const body = prBody(
      run({
        sites: [site('packages/api/src/modules/billing/container.ts', 68, { rule: 'api-version' })],
        apiChanges: {
          from: '2026-07-29.dahlia',
          to: '2026-08-26.dahlia',
          total: 12,
          relevant: 0,
          breaking: 0,
        },
        verification: {
          baseline: [],
          target: [{ file: 'a.ts', line: 1, column: 1, code: 2322, message: 'x' }],
          after: [],
          newErrors: [],
          baselineTests: [],
          tests: [{ workspace: 'packages/api', status: 'passed', output: '' }],
          passed: true,
        },
      }),
    );
    expect(body).toContain(
      '**Ready for review.** The code was migrated to stripe 22.6.2 in `api`. Types compile. 12 API changes, none affect your code, all additive between 2026-07-29.dahlia and 2026-08-26.dahlia.',
    );
    // Nothing in the body contradicts that: the risk, the rule summary and what is left to check.
    expect(body).toContain(
      '| **Risk** | Medium: billing path; API version bump with additive changes only |',
    );
    expect(body).toContain(
      '| **Changes** | 1 site in 1 file · 0 auto-fixed · 1 fixed by the agent (LLM) |',
    );
    expect(body).toContain(
      "### Worth a look\n\n- Check the webhook endpoint's API version in the Stripe Dashboard before deploying.",
    );
    for (const contradiction of [
      'behavior changes',
      'Runtime behavior was not checked',
      'runtime behavior needs review',
      'needs review',
      'Coordinate the API-version rollout',
    ])
      expect(body, contradiction).not.toContain(contradiction);
    // A breaking or relevant entry keeps the stricter wording.
    const risky = prBody(
      run({
        sites: [site('packages/api/src/modules/billing/container.ts', 68, { rule: 'api-version' })],
        apiChanges: { from: 'a', to: 'b', total: 12, relevant: 2, breaking: 1 },
      }),
    );
    expect(risky).toContain('| **Risk** | High: behavior changes |');
    expect(risky).toContain('Runtime behavior was not checked');
    expect(risky).toContain('Coordinate the API-version rollout');
    expect(body).toContain(
      '| **Behavior** | ✅ 12 API changes, none affect your code, all additive |',
    );
    // One error is one error.
    expect(body).toContain('| **Types** | ✅ 1 error after the bump → 0 |');
    expect(body).toContain('| **Tests** | ✅ 1 workspace passed |');
  });

  it('names widened fixture casts as their own change', () => {
    const body = prBody(
      run({
        package: 'stripe',
        sites: [
          site('src/billing/renewal.test.ts', 7, {
            outcome: 'mechanical',
            rule: 'fixture-cast',
            reason: 'the test already cast this partial fixture to Stripe.Subscription',
          }),
        ],
      }),
    );
    expect(body).toMatch(/^\*\*1\. Test fixture casts widened\*\* · 1 site · auto-fixed$/m);
    expect(body).toContain('the same cast now goes through `unknown`');
  });

  it('adds the workspaces up: one total of tests and files', () => {
    const passed = (workspace: string, summary: string) => ({
      workspace,
      status: 'passed' as const,
      output: '',
      summary,
    });
    const tests = [
      passed('packages/api', '3 tests in 2 files'),
      passed('packages/shared', '2 tests in 1 file'),
    ];
    const body = prBody(
      run({
        verification: {
          baseline: [],
          target: [],
          after: [],
          newErrors: [],
          baselineTests: tests,
          tests,
          passed: true,
        },
      }),
    );
    expect(body).toContain('| **Tests** | ✅ 5 tests in 3 files passed |');
  });

  it('reports what ran: the counts, how the scope was chosen and the command', () => {
    const tests = [
      {
        workspace: '.',
        status: 'passed' as const,
        output: '',
        command: 'vitest related --run --passWithNoTests packages/api/src/container.ts',
        scope: 'vitest tests related to 1 affected file, vitest.config.ts',
        covers: ['packages/api', 'packages/shared'],
        summary: '270 tests in 41 files',
      },
    ];
    const body = prBody(
      run({
        verification: {
          baseline: [],
          target: [],
          after: [],
          newErrors: [],
          baselineTests: tests,
          tests,
          passed: true,
        },
      }),
    );
    expect(body).toContain('| **Tests** | ✅ 270 related tests passed |');
    const rerun = prBody(
      run({
        verification: {
          baseline: [],
          target: [],
          after: [],
          newErrors: [],
          baselineTests: tests,
          tests: [
            {
              ...(tests[0] as (typeof tests)[number]),
              retried: ['src/routes/session.e2e.test.ts'],
            },
          ],
          passed: true,
        },
      }),
    );
    expect(rerun).toContain(
      '| **Tests** | ✅ 270 related tests passed · 1 unrelated test failed once and passed on rerun |',
    );
    expect(rerun).toContain(
      'failed once outside the affected files and passed on rerun: `src/routes/session.e2e.test.ts`',
    );
    expect(body).toContain(
      '- `.`: vitest tests related to 1 affected file, vitest.config.ts, covering `packages/api`, `packages/shared` — `vitest related --run --passWithNoTests packages/api/src/container.ts` — 270 tests in 41 files passed',
    );
    const none = prBody(
      run({
        verification: {
          baseline: [],
          target: [],
          after: [],
          newErrors: [],
          baselineTests: [],
          tests: [
            {
              workspace: 'packages/api',
              status: 'missing',
              output: '',
              scope: 'no test script, and no vitest or jest configuration covers this workspace',
              covers: ['packages/api'],
            },
          ],
          passed: true,
        },
      }),
    );
    expect(none).toContain(
      '| **Tests** | ⚠️ no tests ran: no test script or runner configuration for `api` |',
    );
  });

  it('counts the integration tests that were not run and says how to include them', () => {
    const body = prBody(
      run({
        verification: {
          baseline: [],
          target: [],
          after: [],
          newErrors: [],
          baselineTests: [],
          tests: [
            {
              workspace: '.',
              status: 'passed',
              output: '',
              command: 'vitest related --run --config vitest.uptide-unit.config.mjs src/a.ts',
              scope: 'vitest unit tests related to 1 affected file, vitest.config.ts',
              covers: ['packages/api'],
              summary: '8 tests in 2 files',
              notRun: { files: 61, needs: ['Postgres', 'Redis'] },
            },
          ],
          passed: true,
        },
      }),
    );
    expect(body).toContain(
      '| **Tests** | ✅ 8 related unit tests passed · ⚠️ 61 integration test files not run |',
    );
    expect(body).toContain(
      '- 61 integration test files not run (need Postgres/Redis). Run with `--with-services` to include them.',
    );
    const withServices = prBody(
      run({
        verification: {
          baseline: [],
          target: [],
          after: [],
          newErrors: [],
          baselineTests: [],
          tests: [
            {
              workspace: '.',
              status: 'passed',
              output: '',
              command: 'vitest related --run src/a.ts',
              scope: 'vitest tests related to 1 affected file, vitest.config.ts',
              summary: '191 tests in 13 files',
              services: {
                names: ['Postgres'],
                targets: ['postgresql://***@localhost:5432/app_test'],
              },
            },
          ],
          passed: true,
        },
      }),
    );
    expect(withServices).toContain('| **Tests** | ✅ 191 related tests passed |');
    expect(withServices).toContain(
      'ran against Postgres (postgresql://***@localhost:5432/app_test)',
    );
    expect(withServices).not.toContain('integration test file');
  });

  it('words the changelog count for every case', () => {
    const facts = { from: 'a', to: 'b', total: 12, relevant: 0, breaking: 0 };
    expect(apiChangeSummary(facts)).toBe('12 API changes, none affect your code, all additive');
    expect(apiChangeSummary({ ...facts, breaking: 2 })).toBe(
      '12 API changes, none affect your code, 2 breaking for surfaces you do not use',
    );
    expect(apiChangeSummary({ ...facts, relevant: 3 })).toBe(
      '3 of 12 API changes affect your code',
    );
    expect(apiChangeSummary({ ...facts, relevant: 1 })).toBe(
      '1 of 12 API changes affects your code',
    );
    expect(apiChangeSummary({ ...facts, total: 1 })).toBe(
      '1 API change, none affects your code, additive',
    );
    expect(apiChangeSummary({ ...facts, total: 0 })).toBe('no API changes');
  });

  it('describes a zod migration from its own files, never from another repository', () => {
    const storefront = prBody(fixture('storefront-zod'));
    const other = prBody(
      run({
        repo: '/work/shop',
        package: 'zod',
        from: '3.25.76',
        target: '4.6.5',
        branch: 'uptide/zod-4.6.5',
        verification: {
          baseline: [],
          target: [],
          after: [],
          newErrors: [],
          baselineTests: [],
          tests: [],
          passed: true,
        },
        sites: [
          site('src/queue/JobConsumer.ts', 9, {
            rule: 'types',
            diff: '- constructor(private schema: ZodType<Job, ZodTypeDef, unknown>) {}\n+ constructor(private schema: ZodType<Job, unknown>) {}',
          }),
        ],
      }),
    );
    expect(other).toContain('`JobConsumer` now types schemas as `ZodType<Job, unknown>`');
    expect(other).toContain('Smoke-test the routes that use the changed schemas before merging.');
    for (const foreign of ['AzureServiceBus', 'TMessage', 'onboarding', 'instances', 'packages/'])
      expect(other, foreign).not.toContain(foreign);
    expect(storefront).not.toContain('JobConsumer');
  });
});

it('names a compiler-only rule by what it expected, keeps e.g. inside a sentence, and tells a pre-existing test failure apart', () => {
  const report = fixture('stripe');
  const site = first(report.sites);
  report.sites = [
    {
      ...site,
      rule: 'TS2322',
      outcome: 'agent',
      finding: {
        ...site.finding,
        change: { ...site.finding.change, path: 'TS2322', kind: 'type' },
        usage: {
          ...site.finding.usage,
          snippet: 'billing_cycle_anchor: "now",',
          compileCode: 2322,
          compileError: "Type 'string' is not assignable to type 'BillingCycleAnchor'.",
        },
      },
      attempts: [
        {
          attempt: 1,
          outcome: 'accepted',
          before: [],
          after: [],
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          explanation:
            'The param changed from a plain string (e.g. "now") to an object. Nothing else moved.',
          diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
        },
      ],
    },
  ];
  report.verification.tests = [
    { workspace: 'core', status: 'failed', output: '', preexisting: ['src/index.test.ts'] },
  ];
  const body = prBody(report);
  expect(body).toContain(
    '**1. billing_cycle_anchor no longer accepts a string (expects BillingCycleAnchor)**',
  );
  expect(body).toContain('The param changed from a plain string (e.g. "now") to an object.');
  expect(body).toContain(
    '- Tests in `core` were failing before this change (`index.test.ts`); not caused here',
  );
});

it("keeps a PR description under GitHub's limit: what matters first, the rest counted and linked, nothing cut mid-block", () => {
  const report = fixture('stripe');
  const context = {
    from: '14.25.0',
    to: '23.0.0',
    includeDeprecated: false,
    apiVersions: { from: '2023-10-16', to: '2026-09-30.endive' },
    usagePaths: [
      'Stripe.Subscription#current_period_end',
      'Stripe.Checkout.SessionsResource#create',
    ],
    eventTypes: ['customer.subscription.updated'],
    evidence: [
      {
        path: 'Stripe.Subscription#current_period_end',
        kind: 'field' as const,
        file: 'ui/src/webhook.ts',
        line: 44,
      },
    ],
  };
  report.reviewSections = stripePack.reviewSections?.(context, ['subscription-period']);
  // A long test log, the kind a real suite prints.
  report.verification.tests = [
    {
      workspace: 'ui',
      status: 'passed',
      output: 'ok line\n'.repeat(4000),
      summary: '7 tests in 1 file',
    },
  ];
  const full = migrationBody(report);
  const body = prBody(report);
  expect(full.length).toBeGreaterThan(100_000);
  expect(body.length).toBeLessThanOrEqual(PR_BODY_BUDGET);
  // Kept, in order: the verdict and table, what changed, decisions, the evidenced entry.
  expect(body).toContain('| **Risk** |');
  expect(body).toContain('### What changed');
  expect(body).toContain('### Decisions for you');
  expect(body).toContain('evidence: `ui/src/webhook.ts:44`');
  // The list of resource changes starts with breaking entries and says what it left out.
  const list = body.slice(body.indexOf('changes to resources you use'));
  const firstNonBreaking = list.indexOf('— non-breaking;');
  expect(list.slice(0, firstNonBreaking)).toContain('— breaking;');
  expect(body).toMatch(
    /- … \d+ more not shown here: \[Stripe's changelog\]\(https:\/\/docs\.stripe\.com\/changelog\), 2023-10-16 → 2026-09-30\.endive\./,
  );
  expect(body).toContain(
    "_Test output (passed) left out: this description is at GitHub's size limit._",
  );
  // A description is read on GitHub: it never points at a file on the author's machine.
  expect(body).not.toMatch(/report\.html|stored run|\.git\//);
  // Decisions once; commands with the published dist-tag.
  expect(body.match(/Decisions for you/g)).toHaveLength(1);
  expect(body).not.toMatch(/npx uptide(?!@next)/);
  // Nothing is cut inside a block.
  const count = (pattern: RegExp) => (body.match(pattern) ?? []).length;
  expect(count(/<details>/g)).toBe(count(/<\/details>/g));
  expect(count(/^```/gm) % 2).toBe(0);
  // The page has all of it.
  expect(full).toContain('ok line');
  expect(full).not.toContain('more not shown here');
});

describe('a bump that needed no code changes', () => {
  const at = (code: number, message: string) => ({
    file: 'packages/api/src/index.ts',
    line: 1,
    column: 1,
    code,
    message,
  });
  const nodeTypes = [
    ...Array.from({ length: 40 }, () => at(2688, "Cannot find type definition file for 'node'.")),
    ...Array.from({ length: 34 }, () =>
      at(
        2591,
        "Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.",
      ),
    ),
    at(2322, "Type 'string' is not assignable to type 'number'."),
  ];
  const report = (): FixReport => {
    const base = fixture('storefront-zod');
    return {
      ...base,
      package: 'vitest',
      tier: 'generic',
      sites: [],
      // What the generic pack says of agent edits, recorded with the run: there were none.
      notes: [GENERIC_NOTE('vitest')],
      verification: {
        ...base.verification,
        baseline: nodeTypes,
        target: nodeTypes,
        after: nodeTypes,
        newErrors: [],
        passed: true,
      },
    };
  };

  it('says only versions and the lockfile changed, and drops what speaks of edits', () => {
    const body = prBody(report());
    expect(body).toContain('No code changes were needed; only versions and the lockfile changed.');
    expect(body).not.toContain('written by the agent');
    expect(body).not.toContain('### What changed');
    expect(body).toContain('| **Changes** | none: versions and lockfile only |');
    const clean = report();
    clean.verification = { ...clean.verification, baseline: [], target: [], after: [] };
    delete clean.behavior;
    expect(prBody(clean)).toContain(
      'No code changes were needed; only versions and the lockfile changed. Types compile and the tests pass.',
    );
    expect(migrationRisk(report())).toEqual({
      level: 'Low',
      reason: 'no code changes; types and tests verified',
    });
  });

  it('counts pre-existing errors by kind in one line, and lists at most ten', () => {
    expect(errorSummary(nodeTypes, 'pre-existing error')).toBe(
      '75 pre-existing errors (74 × TS2688/TS2591 missing Node types, 1 × TS2322)',
    );
    const body = prBody(report());
    expect(body).toContain(
      '**75 pre-existing errors (74 × TS2688/TS2591 missing Node types, 1 × TS2322)**',
    );
    expect(body).toContain('<details><summary>First 10 of 75</summary>');
    expect(body).toContain('- … and 65 more');
    expect(
      body.split('\n').filter((l) => l.startsWith('- packages/api/src/index.ts:1')),
    ).toHaveLength(10);
  });

  it('joins three workspaces with commas and one "and"', () => {
    const base = fixture('storefront-zod');
    const tests = ['apps/web', 'apps/worker', 'packages/api'].map((workspace) => ({
      ...first(base.verification.tests),
      workspace,
      covers: [workspace],
    }));
    const body = prBody({ ...base, verification: { ...base.verification, tests } });
    expect(body).toContain('in `web`, `worker` and `api`.');
  });
});
