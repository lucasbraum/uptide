import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ts } from 'ts-morph';
import { expect, it } from 'vitest';
import type { Finding } from '../../domain/report.js';
import type { Usage } from '../../domain/usage.js';
import { between, parseChangelog, type StripeCatalog } from './changelog.js';
import catalog from './changelog.v1.json' with { type: 'json' };
import {
  PERIOD_HELPER,
  sdkApiVersion,
  stripeConcerns,
  stripePack,
  widenFixtureCast,
} from './index.js';
import {
  aboveDeclaration,
  calledResources,
  clientPins,
  evidencedEntries,
  mockFollowUps,
  payloadApiVersions,
  periodFixtureEdits,
  pinAssertions,
  pinClient,
  resourceEntries,
  sharedPeriodHelper,
  unpinnedClients,
  usedProducts,
} from './relevance.js';

it('distinguishes SDK, literal/API aliases and response fields without a mechanical API-version bump', () => {
  const finding = {
    change: { path: 'Stripe.LatestApiVersion', kind: 'type', from: '22.5.0', to: '22.6.2' },
    usage: { compileError: 'apiVersion changed' },
  } as Finding;
  const field = {
    ...finding,
    change: { ...finding.change, path: 'Stripe.Subscription#current_period_end' },
  };
  const context = {
    from: '22.5.0',
    to: '22.6.2',
    includeDeprecated: false,
    apiVersions: { from: '2026-07-29.dahlia', to: '2026-08-26.dahlia' },
  };
  const concerns = stripeConcerns([finding, field], context);
  expect(concerns.apiVersion.pins).toContain(finding);
  expect(concerns.apiVersion.fields).toContain(field);
  expect(concerns.sdkSurface).toContain(field);
  expect(stripePack.transform('unchanged', finding, context).applied).toBe(false);
  const sections = stripePack.reviewSections?.(context) ?? [];
  // Every entry is somewhere: evidenced in the lines, the rest in the lists that may shorten.
  expect(
    [...(sections[0]?.lines ?? []), ...(sections[0]?.lists ?? []).flatMap((l) => l.items)].filter(
      (l) => l.startsWith('- '),
    ),
  ).toHaveLength(concerns.apiVersion.entries.length);
  // A run with no subscription-period site has no subscription decision to make.
  expect(sections.map((s) => s.title)).toEqual([
    'Stripe API changelog',
    'Also check outside the code',
  ]);
  expect(sections[1]?.lines.join(' ')).toContain('Stripe dashboard');
  // Decisions are the pack's `decisions`, rendered once; never a review section of their own.
  const withPeriod = stripePack.reviewSections?.(context, ['subscription-period']) ?? [];
  expect(withPeriod.map((s) => s.title)).not.toContain('Decisions for you');
  expect(stripePack.decisions?.(context, ['subscription-period'])?.[0]).toContain(
    'billing period now comes from one item',
  );
});
it('follows the pinned constant in tests that assert it, and never touches payload api_version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stripe-follow-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'src/container.test.ts'),
      [
        'import { STRIPE_API_VERSION } from "./container.js";',
        'it("pins", () => {',
        '  expect(STRIPE_API_VERSION).toBe("2026-07-29.dahlia");',
        '  expect(other).toBe("2026-07-29.dahlia");',
        '});',
        'const event = { api_version: "2026-07-29.dahlia" };',
        'new Stripe("sk", { apiVersion: "2026-07-29.dahlia" });',
      ].join('\n'),
    );
    const versions = { from: '2026-07-29.dahlia', to: '2026-08-26.dahlia' };
    const finding = {
      change: { path: 'Stripe.LatestApiVersion' },
      usage: {
        file: 'src/container.ts',
        line: 68,
        snippet: 'export const STRIPE_API_VERSION: Stripe.LatestApiVersion = "2026-07-29.dahlia";',
      },
    } as Finding;
    const context = {
      from: '22.5.0',
      to: '22.6.2',
      includeDeprecated: false,
      apiVersions: versions,
    };
    const edits = stripePack.followUps?.({ root: dir, workspaces: ['.'], finding, context });
    // The assertion on the constant follows it; the client uses the constant, already imported
    // here. Another value and the payload `api_version` are left alone.
    expect(edits).toEqual([
      {
        file: 'src/container.test.ts',
        line: 3,
        before: '  expect(STRIPE_API_VERSION).toBe("2026-07-29.dahlia");',
        after: '  expect(STRIPE_API_VERSION).toBe("2026-08-26.dahlia");',
        reason: 'the assertion on `STRIPE_API_VERSION` follows the constant to 2026-08-26.dahlia',
      },
      {
        file: 'src/container.test.ts',
        line: 7,
        before: 'new Stripe("sk", { apiVersion: "2026-07-29.dahlia" });',
        after: 'new Stripe("sk", { apiVersion: STRIPE_API_VERSION });',
        reason: 'this client uses `STRIPE_API_VERSION` instead of repeating the API version',
      },
    ]);
    // A file that does not import the constant yet gets the import, written the way it writes its own.
    mkdirSync(join(dir, 'src/adapters/stripe'), { recursive: true });
    writeFileSync(
      join(dir, 'src/adapters/stripe/Webhook.test.ts'),
      [
        'import Stripe from "stripe";',
        '',
        'import { Webhook } from "./Webhook.js";',
        '',
        'const payload = { api_version: "2026-07-29.dahlia" };',
        'const stripe = new Stripe("sk_test", { apiVersion: "2026-07-29.dahlia" });',
      ].join('\n'),
    );
    const site = { file: 'src/container.ts', declaration: finding.usage.snippet };
    expect(
      clientPins(dir, ['.'], site, versions).filter((e) => e.file.includes('Webhook')),
    ).toEqual([
      {
        file: 'src/adapters/stripe/Webhook.test.ts',
        line: 6,
        before: 'const stripe = new Stripe("sk_test", { apiVersion: "2026-07-29.dahlia" });',
        after: 'const stripe = new Stripe("sk_test", { apiVersion: STRIPE_API_VERSION });',
        reason: 'this client uses `STRIPE_API_VERSION` instead of repeating the API version',
        also: [
          {
            line: 3,
            before: 'import { Webhook } from "./Webhook.js";',
            after:
              'import { STRIPE_API_VERSION } from "../../container.js";\nimport { Webhook } from "./Webhook.js";',
          },
        ],
      },
    ]);
    // A constant that is not exported cannot be imported: the literal follows the version instead.
    const local = {
      file: 'src/container.ts',
      declaration: 'const V: Stripe.LatestApiVersion = "2026-07-29.dahlia";',
    };
    expect(clientPins(dir, ['.'], local, versions)[0]?.after).toBe(
      'const stripe = new Stripe("sk_test", { apiVersion: "2026-08-26.dahlia" });',
    );
    // A site that is not the pin, or a line that does not declare a constant, has nothing to follow.
    const field = { ...finding, change: { path: 'Stripe.Subscription#status' } } as Finding;
    expect(
      stripePack.followUps?.({ root: dir, workspaces: ['.'], finding: field, context }),
    ).toEqual([]);
    expect(pinAssertions(dir, ['.'], 'apiVersion: "2026-07-29.dahlia",', versions)).toEqual([]);
    // An assisted patch that rewrites a payload version is rejected, whatever else it fixes.
    const original =
      'const event = { api_version: "2026-07-29.dahlia" };\nconst v = "2026-07-29.dahlia";';
    expect(
      stripePack.validateAssisted?.(original.replaceAll('07-29', '08-26'), finding, '', original),
    ).toMatch(/Do not change api_version values/);
    expect(
      stripePack.validateAssisted?.(
        original.replace('v = "2026-07-29.dahlia"', 'v = "2026-08-26.dahlia"'),
        finding,
        '',
        original,
      ),
    ).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('lists webhook payload api_version values as a decision, never as something to rewrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stripe-payload-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'src/webhook.test.ts'),
      'const event = {\n  api_version: "2026-07-29.dahlia",\n};\nconst other = { "api_version": \'2026-07-29.dahlia\' };\n',
    );
    mkdirSync(join(dir, 'node_modules/x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/x/a.ts'), 'const e = { api_version: "2020-01-01" };');
    const payloadVersions = payloadApiVersions(dir, ['.']);
    expect(payloadVersions).toEqual([
      { file: 'src/webhook.test.ts', line: 2, value: '2026-07-29.dahlia' },
      { file: 'src/webhook.test.ts', line: 4, value: '2026-07-29.dahlia' },
    ]);
    const context = {
      from: '22.5.0',
      to: '22.6.2',
      includeDeprecated: false,
      apiVersions: { from: '2026-07-29.dahlia', to: '2026-08-26.dahlia' },
      payloadVersions,
    };
    expect(stripePack.decisions?.(context, ['api-version'])).toEqual([
      '- `api_version` stays `2026-07-29.dahlia` in 2 webhook payload fixtures: `src/webhook.test.ts` (lines 2, 4). They reflect the API version configured on the webhook endpoint, which this upgrade does not change; update them when you roll the endpoint.',
    ]);
    expect(stripePack.decisions?.({ ...context, payloadVersions: [] }, [])).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('extracts the pinned API date from both old and new SDK declaration layouts without executing them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stripe-pin-'));
  try {
    mkdirSync(join(dir, 'types'));
    writeFileSync(join(dir, 'types/lib.d.ts'), "export type LatestApiVersion = '2023-10-16';");
    expect(sdkApiVersion(dir)).toBe('2023-10-16');
    mkdirSync(join(dir, 'cjs'));
    writeFileSync(
      join(dir, 'cjs/apiVersion.d.ts'),
      'export declare const ApiVersion = "2026-08-26.dahlia";',
    );
    expect(sdkApiVersion(dir)).toBe('2026-08-26.dahlia');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('parses release boundaries, deduplicates entries and fails closed when coverage is missing', () => {
  const parsed = parseChangelog(
    '## 2026-08-26.dahlia\n| [A](https://docs.stripe.com/changelog/a.md) | Billing | Breaking | api |\n## 2026-08-26.preview\n| [B](https://docs.stripe.com/changelog/b.md) | Connect | Non-breaking | api |',
  );
  const c: StripeCatalog = {
    schema: 1,
    source: 'fixture',
    sha256: 'fixture',
    generatedAt: 'fixture',
    ...parsed,
  };
  expect(between(c, '2026-07-29.dahlia', '2026-08-26.dahlia').map((e) => e.title)).toEqual(['A']);
  expect(() => between(c, '2026-07-29.dahlia', '2099-01-01.future')).toThrow('absent');
  expect(() => parseChangelog('<html>not markdown</html>')).toThrow('format changed');
  expect(
    between(catalog as StripeCatalog, '2023-10-16', '2026-08-26.dahlia').length,
  ).toBeGreaterThan(100);
});

it('matches resource/field metadata and handled event literals, leaving unrelated changes collapsed', async () => {
  const { handledEvents, relevantEntries } = await import('./relevance.js');
  const events = handledEvents(
    "switch(event.type){case 'customer.subscription.updated':break;} if(event.type==='checkout.session.completed'){} const unrelated='payout.created';",
  );
  expect(events).toEqual(['customer.subscription.updated', 'checkout.session.completed']);
  const entries = between(catalog as StripeCatalog, '2023-10-16', '2026-08-26.dahlia');
  const selected = relevantEntries(
    entries,
    ['Stripe.Subscription#current_period_end', 'Stripe.Checkout.SessionsResource#create'],
    events,
  );
  expect(selected.some((e) => e.title.includes('item-level billing periods'))).toBe(true);
  expect(selected.length).toBeLessThan(entries.length);
  const sections = stripePack.reviewSections?.({
    from: '14.25.0',
    to: '22.6.2',
    includeDeprecated: false,
    apiVersions: { from: '2023-10-16', to: '2026-08-26.dahlia' },
    usagePaths: ['Stripe.Subscription#current_period_end'],
    eventTypes: events,
  });
  const text = sections?.[0]?.lines.join('\n') ?? '';
  expect(text).toContain('0 of 502 affect your code');
  // The second layer: changes to the resources the code uses, counted, breaking first.
  const { usedResources, resourceEntries } = await import('./relevance.js');
  const used = usedResources(['Stripe.Subscription#current_period_end'], events);
  expect(used).toEqual(['checkout', 'subscription', 'customer']);
  const byResource = resourceEntries(entries, [], used);
  expect(byResource.length).toBeGreaterThan(20);
  expect(byResource.length).toBeLessThan(entries.length);
  expect(byResource.findIndex((e) => !e.breaking)).toBeGreaterThanOrEqual(
    byResource.filter((e) => e.breaking).length,
  );
  const list = sections?.[0]?.lists?.[0];
  expect(list?.summary).toBe(
    `${byResource.length} changes to resources you use (${byResource.filter((e) => e.breaking).length} breaking): checkout, subscription, customer`,
  );
  expect(list?.items).toHaveLength(byResource.length);
  expect(list?.more).toContain(
    "[Stripe's changelog](https://docs.stripe.com/changelog), 2023-10-16 → 2026-08-26.dahlia",
  );
  expect(usedResources(['Stripe.SubscriptionSchedulesResource#create'], [])).toEqual([
    'subscription_schedule',
  ]);
  // The collapsed lists are data now; the renderer writes their blocks, shortened to fit.
  expect(sections?.[0]?.lines.join('\n')).not.toContain('<details>');
});

it('supplies the pinned API date and period migration evidence, and requires explicit single-item review', () => {
  const f = {
    change: { path: 'Stripe.Subscription#current_period_end', kind: 'removed' },
    usage: { file: 'billing.ts', line: 18, compileError: 'current_period_end removed' },
  } as Finding;
  const context = {
    from: '14.25.0',
    to: '22.6.2',
    includeDeprecated: false,
    apiVersions: { from: '2023-10-16', to: '2026-08-26.dahlia' },
    evidence: [{ path: f.change.path, kind: 'field' as const, file: 'billing.ts', line: 18 }],
  };
  expect(stripePack.guide(f, context)).toContain('2026-08-26.dahlia');
  expect(stripePack.guide(f, context)).toContain('Adds subscription item-level billing periods');
  expect(
    stripePack.validateAssisted?.('return s.items.data[0].current_period_end', f, ''),
  ).toContain('single-item');
  expect(
    stripePack.validateAssisted?.(
      `// Same values for a single-item subscription; the latest-ending item for multi-item.\n${PERIOD_HELPER}`,
      f,
      'multi-item subscriptions use the latest-ending item',
    ),
  ).toBeUndefined();
});

it('requires concrete field/method/param/event evidence, not resource-name overlap', async () => {
  const { evidencedEntries } = await import('./relevance.js');
  const entries = between(catalog as StripeCatalog, '2023-10-16', '2026-08-26.dahlia');
  expect(
    evidencedEntries(entries, [
      {
        path: 'Stripe.SubscriptionsResource#retrieve',
        kind: 'method',
        file: 'billing.ts',
        line: 17,
      },
    ]),
  ).toEqual([]);
  const field = {
    path: 'Stripe.Subscription#current_period_end',
    kind: 'field' as const,
    file: 'billing.ts',
    line: 18,
  };
  const selected = evidencedEntries(entries, [field]);
  expect(selected.length).toBeLessThan(20);
  expect(selected.some((e) => e.entry.title.includes('item-level billing periods'))).toBe(true);
  expect(selected.every((e) => e.evidence.includes(field))).toBe(true);
});
it('rejects new failure paths, sentinels and local copies; the helper is undefined with no items', () => {
  const f = { change: { path: 'Stripe.Subscription#current_period_end' }, usage: {} } as Finding;
  expect(stripePack.validateAssisted?.('throw new Error("no item")', f, '')).toContain(
    'Never introduce',
  );
  expect(stripePack.validateAssisted?.('return null', f, '')).toContain('Never introduce');
  // The helper the guide dictates, as the agent will write it: start and end from one item.
  const period = new Function(
    `${ts.transpileModule(PERIOD_HELPER.replace(/^export /m, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; return subscriptionPeriod;`,
  )() as (s: {
    items: { data: { current_period_start: number; current_period_end: number }[] };
  }) => { start: number; end: number } | undefined;
  const sub = (...items: [number, number][]) => ({
    items: {
      data: items.map(([current_period_start, current_period_end]) => ({
        current_period_start,
        current_period_end,
      })),
    },
  });
  expect(period(sub([10, 42]))).toEqual({ start: 10, end: 42 });
  // Both from the latest-ending item, never a max of ends with a min of starts.
  expect(period(sub([10, 42], [30, 55]))).toEqual({ start: 30, end: 55 });
  // No sentinel: the caller decides what no items means where it stands.
  expect(period(sub())).toBeUndefined();
  const start = {
    change: { path: 'Stripe.Subscription#current_period_start' },
    usage: {},
  } as Finding;
  const use = '// single-item\nconst period = subscriptionPeriod(subscription);\n';
  expect(
    stripePack.validateAssisted?.(
      '// single-item\nconst end = s.items.data.reduce((m, i) => Math.max(m, i.current_period_end), 0);',
      start,
      'multi-item',
    ),
  ).toContain('same item');
  expect(
    stripePack.validateAssisted?.(`${use}${PERIOD_HELPER}`, start, 'multi-item'),
  ).toBeUndefined();
  // A first-item read the file already had is not the patch's doing.
  const existing = 'const id = sub.items.data[0]?.price.id;\n';
  expect(
    stripePack.validateAssisted?.(
      `${existing}${use}${PERIOD_HELPER}`,
      start,
      'multi-item',
      existing,
    ),
  ).toBeUndefined();
  expect(
    stripePack.validateAssisted?.(
      `${existing}${use}${PERIOD_HELPER}\nconst first = s.items.data[0];`,
      start,
      'multi-item',
      existing,
    ),
  ).toContain('first item');
  // A later site in the same file reads the local an earlier edit made; no second call needed.
  const earlier = 'const period = subscriptionPeriod(subscription);\n';
  expect(
    stripePack.validateAssisted?.(
      `${earlier}// single-item\nconst end = new Date(period.end * 1000);\n`,
      start,
      'multi-item',
      earlier,
      {
        from: '14.25.0',
        to: '23.0.0',
        includeDeprecated: false,
        helpers: [{ name: 'subscriptionPeriod', file: 'x', specifiers: {} }],
      },
    ),
  ).toBeUndefined();
  // A timestamp must never fall back to 0; the "no items" throw is the one allowed.
  expect(
    stripePack.validateAssisted?.(
      `${use}const end = period?.end ?? 0;\n${PERIOD_HELPER}`,
      start,
      'multi-item',
    ),
  ).toContain('No sentinel');
  expect(
    stripePack.validateAssisted?.(
      `${use}if (!period) throw new Error(\`subscription \${sub.id} has no items\`);\n${PERIOD_HELPER}`,
      start,
      'multi-item',
    ),
  ).toBeUndefined();
  // With the helper placed in the shared module, a local copy is refused and the import expected.
  const shared = {
    from: '14.25.0',
    to: '23.0.0',
    includeDeprecated: false,
    helpers: [
      {
        name: 'subscriptionPeriod',
        file: 'packages/core/src/ee/billing/stripe.ts',
        specifiers: { ui: '@acme/core' },
      },
    ],
  };
  const uiSite = { ...start, usage: { file: 'ui/src/route.ts' } } as Finding;
  expect(
    stripePack.validateAssisted?.(`${use}${PERIOD_HELPER}`, uiSite, 'multi-item', '', shared),
  ).toContain('import it');
  expect(
    stripePack.validateAssisted?.(
      `import { subscriptionPeriod } from "@acme/core";\n${use}`,
      uiSite,
      'multi-item',
      '',
      shared,
    ),
  ).toBeUndefined();
  expect(stripePack.guide(uiSite, shared)).toContain(
    'import { subscriptionPeriod } from "@acme/core"',
  );
  expect(stripePack.guide(uiSite)).toContain('Define it once');
});

it('places subscriptionPeriod once in the client module the sites can import, and re-exports it through the barrel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stripe-shared-'));
  try {
    const write = (file: string, text: string) => {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), text);
    };
    write('packages/core/package.json', JSON.stringify({ name: '@acme/core' }));
    write(
      'packages/core/src/ee/billing/stripe.ts',
      'import Stripe from "stripe";\nexport const stripe = new Stripe("sk");\n',
    );
    write(
      'packages/core/src/ee/billing/index.ts',
      'export { stripe } from "./stripe.ts";\nexport { PLANS } from "./plans.ts";\n',
    );
    write('packages/core/src/index.ts', 'export * from "./ee/billing/index.ts";\n');
    write(
      'ui/package.json',
      JSON.stringify({ name: 'ui', dependencies: { '@acme/core': 'workspace:*' } }),
    );
    write(
      'worker/package.json',
      JSON.stringify({ name: 'worker', dependencies: { stripe: '14.25.0' } }),
    );
    const finding = (file: string, path: string, snippet: string): Finding =>
      ({ change: { path }, usage: { file, line: 1, snippet } }) as unknown as Finding;
    const findings = [
      finding(
        'packages/core/src/ee/billing/stripe.ts',
        'Stripe.StripeConfig#apiVersion',
        'export const stripe = new Stripe("sk");',
      ),
      finding(
        'ui/src/app/api/billing/webhook/route.ts',
        'Stripe.Subscription#current_period_end',
        'x',
      ),
      finding(
        'packages/core/src/ee/billing/report.ts',
        'Stripe.Subscription#current_period_start',
        'y',
      ),
    ];
    const placed = stripePack.sharedHelpers?.({
      root: dir,
      workspaces: ['packages/core', 'ui', 'worker'],
      findings,
      context: { from: '14.25.0', to: '23.0.0', includeDeprecated: false },
    });
    expect(placed).toHaveLength(1);
    const { helper, edits } = (placed ?? [])[0] as NonNullable<typeof placed>[number];
    expect(helper).toEqual({
      name: 'subscriptionPeriod',
      file: 'packages/core/src/ee/billing/stripe.ts',
      specifiers: { ui: '@acme/core', 'packages/core': './stripe.ts' },
    });
    expect(edits.map((e) => e.file)).toEqual([
      'packages/core/src/ee/billing/stripe.ts',
      'packages/core/src/ee/billing/index.ts',
    ]);
    expect(edits[0]?.text).toContain(`\n\n${PERIOD_HELPER}\n`);
    expect(edits[1]?.text).toBe(
      'export { stripe, subscriptionPeriod } from "./stripe.ts";\nexport { PLANS } from "./plans.ts";\n',
    );
    // No period site: nothing to place. Already there: nothing to place.
    expect(
      stripePack.sharedHelpers?.({
        root: dir,
        workspaces: ['packages/core', 'ui'],
        findings: [findings[0] as Finding],
        context: { from: '14.25.0', to: '23.0.0', includeDeprecated: false },
      }),
    ).toEqual([]);
    writeFileSync(join(dir, 'packages/core/src/ee/billing/stripe.ts'), edits[0]?.text ?? '');
    expect(
      stripePack.sharedHelpers?.({
        root: dir,
        workspaces: ['packages/core', 'ui', 'worker'],
        findings,
        context: { from: '14.25.0', to: '23.0.0', includeDeprecated: false },
      }),
    ).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('reports a client created without apiVersion as a runtime API-version change, worded from the whole repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stripe-unpinned-'));
  try {
    for (const [sdk, version] of [
      ['installed', '2023-10-16'],
      ['target', '2026-09-30.endive'],
    ] as const) {
      mkdirSync(join(dir, sdk, 'cjs'), { recursive: true });
      writeFileSync(
        join(dir, sdk, 'cjs/apiVersion.d.ts'),
        `export declare const ApiVersion = "${version}";`,
      );
    }
    const construct = (file: string, line: number, snippet: string): Usage => ({
      file,
      line,
      column: 1,
      endLine: line,
      endColumn: 1,
      symbolPath: 'Stripe.new()',
      access: 'construct',
      snippet,
      via: 'direct',
    });
    const files: Record<string, string> = {
      'core/src/stripe.ts':
        "import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.KEY);\n",
      'core/src/pinned.ts':
        "import Stripe from 'stripe';\nexport const stripe = new Stripe(key, { apiVersion: '2023-10-16' });\n",
      'core/src/spread.ts':
        "import Stripe from 'stripe';\nexport const stripe = new Stripe(key, { ...options });\n",
      'core/src/elsewhere.ts':
        "import Stripe from 'stripe';\nconst options = { apiVersion: '2023-10-16' as const };\nexport const stripe = new Stripe(key, options);\n",
      'core/src/unknown.ts':
        "import Stripe from 'stripe';\nexport const stripe = new Stripe(key, options);\n",
    };
    const usages = Object.entries(files).map(([file, text]) =>
      construct(
        file.replace('core/', ''),
        text.split('\n').findIndex((l) => l.includes('new Stripe')) + 1,
        'new Stripe(...)',
      ),
    );
    const read = (file: string) => files[file];
    expect(
      unpinnedClients(usages, (file) => read(join('core', file))).map((c) => `${c.file}:${c.line}`),
    ).toEqual(['src/stripe.ts:2', 'src/unknown.ts:2']);
    const findings =
      stripePack.runtimeFindings?.({
        root: '/repo',
        workspace: 'core',
        from: '14.25.0',
        to: '23.0.0',
        installedDir: join(dir, 'installed'),
        targetDir: join(dir, 'target'),
        usages,
        read,
      }) ?? [];
    expect(
      findings.map(
        (f) => `${f.usage.file}:${f.usage.line} ${f.rule} ${f.fixability} ${f.change.source}`,
      ),
    ).toEqual([
      'src/stripe.ts:2 api-version-unpinned manual pack',
      'src/unknown.ts:2 api-version-unpinned manual pack',
    ]);
    expect(findings[0]?.reason).toBe(
      'API version changes from 2023-10-16 to 2026-09-30.endive at runtime',
    );
    // The same SDK on both sides changes nothing at runtime.
    expect(
      stripePack.runtimeFindings?.({
        root: '/repo',
        workspace: 'core',
        from: '14.25.0',
        to: '14.26.0',
        installedDir: join(dir, 'installed'),
        targetDir: join(dir, 'installed'),
        usages,
        read,
      }),
    ).toEqual([]);
    // Worded once the repository's evidence is in: the fields another workspace reads.
    const context = {
      from: '14.25.0',
      to: '23.0.0',
      includeDeprecated: false,
      apiVersions: { from: '2023-10-16', to: '2026-09-30.endive' },
      evidence: [
        {
          path: 'Stripe.Subscription#current_period_end',
          kind: 'field' as const,
          file: 'ui/src/webhook.ts',
          line: 44,
        },
        {
          path: 'Stripe.Subscription#current_period_end',
          kind: 'field' as const,
          file: 'ui/src/webhook.ts',
          line: 44,
        },
        {
          path: 'Stripe.Subscription#current_period_start',
          kind: 'field' as const,
          file: 'ui/src/webhook.ts',
          line: 65,
        },
      ],
    };
    const words = stripePack.describeFinding?.(findings[0] as Finding, context);
    expect(words?.reason).toMatch(
      /^API version changes from 2023-10-16 to 2026-09-30\.endive at runtime: 1 of \d+ API changes touch what this repository reads$/,
    );
    expect(words?.details).toEqual([
      '2025-03-31.basil: Adds subscription item-level billing periods and removes subscription-level periods — ui/src/webhook.ts:44,65',
    ]);
    expect(stripePack.planNote?.('api-version-unpinned', context)).toBe(
      '1 API change since 2023-10-16 affects your code',
    );
    const [choice] = stripePack.decisions?.(context, ['api-version-unpinned']) ?? [];
    expect(choice).toContain(
      "(a) the small one, stay on stripe 14.25.0 and write `apiVersion: '2023-10-16'`",
    );
    expect(choice).toContain('`npx uptide fix --only stripe --pin-current-api`');
    expect(choice).toContain(
      "(b) the full one, this PR: stripe 23.0.0, `apiVersion: '2026-09-30.endive'`",
    );
    expect(choice).toContain('Not offered: stripe 23.0.0 pinned to `2023-10-16`, because');
    expect(stripePack.decisions?.(context, ['sdk-surface'])).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("pins a client in the file's own style, and leaves pinned clients and options built elsewhere alone", () => {
  expect(pinClient('const s = new Stripe(key);\n', 1, '2026-09-30.endive')).toBe(
    "const s = new Stripe(key, { apiVersion: '2026-09-30.endive' });\n",
  );
  expect(
    pinClient(
      'import Stripe from "stripe";\nconst s = new Stripe(key, { maxNetworkRetries: 2 });\n',
      2,
      '2023-10-16',
    ),
  ).toBe(
    'import Stripe from "stripe";\nconst s = new Stripe(key, { apiVersion: "2023-10-16", maxNetworkRetries: 2 });\n',
  );
  expect(pinClient('new Stripe(key, {\n    timeout: 5,\n  });\n', 1, '2023-10-16')).toBe(
    "new Stripe(key, {\n    apiVersion: '2023-10-16',\n    timeout: 5,\n  });\n",
  );
  expect(pinClient('new Stripe(key, {});\n', 1, '2023-10-16')).toBe(
    "new Stripe(key, { apiVersion: '2023-10-16' });\n",
  );
  expect(
    pinClient("new Stripe(key, { apiVersion: '2023-10-16' });\n", 1, '2026-09-30.endive'),
  ).toBeUndefined();
  expect(pinClient('new Stripe(key, options);\n', 1, '2023-10-16')).toBeUndefined();
  expect(pinClient('const x = 1;\n', 1, '2023-10-16')).toBeUndefined();
  // The upgrade pins the target version by rule; without the versions nothing is applied.
  const finding = {
    rule: 'api-version-unpinned',
    change: { path: 'Stripe.StripeConfig#apiVersion', kind: 'type' },
    usage: { line: 1, snippet: 'new Stripe(key)' },
  } as unknown as Finding;
  const context = { from: '14.25.0', to: '23.0.0', includeDeprecated: false };
  expect(stripePack.transform('new Stripe(key);\n', finding, context)).toMatchObject({
    applied: false,
  });
  expect(
    stripePack.transform('new Stripe(key);\n', finding, {
      ...context,
      apiVersions: { from: '2023-10-16', to: '2026-09-30.endive' },
    }),
  ).toMatchObject({
    applied: true,
    rule: 'api-version-unpinned',
    text: "new Stripe(key, { apiVersion: '2026-09-30.endive' });\n",
  });
});

it("moves a test fixture's billing period onto its items, where the migrated code reads it", () => {
  const dir = mkdtempSync(join(tmpdir(), 'stripe-fixture-'));
  try {
    mkdirSync(join(dir, 'ui/src'), { recursive: true });
    writeFileSync(
      join(dir, 'ui/src/webhook.test.ts'),
      [
        'const now = 1;',
        'const sub = {',
        '  id: "sub_1",',
        '  current_period_start: now,',
        '  current_period_end: now + 2_592_000,',
        '  items: { data: [{ price: { id: "price_1" } }, { price: { id: "price_2" }, current_period_end: 9 }] },',
        '};',
        'const other = { items: { data: [{}] } };',
        '',
      ].join('\n'),
    );
    const edits = periodFixtureEdits(dir, 'ui/src/webhook.test.ts');
    expect(edits).toEqual([
      {
        file: 'ui/src/webhook.test.ts',
        line: 6,
        before:
          '  items: { data: [{ price: { id: "price_1" } }, { price: { id: "price_2" }, current_period_end: 9 }] },',
        after:
          '  items: { data: [{ price: { id: "price_1" }, current_period_start: now, current_period_end: now + 2_592_000 }, { price: { id: "price_2" }, current_period_end: 9 }] },',
        reason:
          'the fixture now carries the billing period on its item, where the API puts it since 2025-03-31.basil; the migrated code reads it there',
        rule: 'subscription-period',
      },
    ]);
    expect(
      stripePack.testFollowUps?.({
        root: dir,
        workspaces: ['ui'],
        failing: ['src/webhook.test.ts'],
        context: { from: '14.25.0', to: '23.0.0', includeDeprecated: false },
      }),
    ).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('turns a wholesale module mock into a partial one when the migrated code imports the shared helper', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stripe-mock-'));
  try {
    mkdirSync(join(dir, 'ui/src'), { recursive: true });
    const test = [
      'import { vi } from "vitest";',
      'vi.mock("@acme/core", () => ({',
      '  prisma: {},',
      '}));',
      'vi.mock("next/headers", () => ({',
      '  headers: async () => new Map(),',
      '}));',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'ui/src/webhook.test.ts'), test);
    const output =
      'Error: [vitest] No "subscriptionPeriod" export is defined on the "@acme/core" mock. Did you forget to return it from "vi.mock"?';
    expect(mockFollowUps(dir, 'ui/src/webhook.test.ts', output, 'subscriptionPeriod')).toEqual([
      {
        file: 'ui/src/webhook.test.ts',
        line: 2,
        before: 'vi.mock("@acme/core", () => ({',
        after:
          'vi.mock("@acme/core", async (importOriginal) => ({\n  ...(await importOriginal<typeof import("@acme/core")>()),',
        reason:
          'the test mocks @acme/core wholesale and the migrated code now imports subscriptionPeriod from it; the mock starts from the real module and overrides what it did before',
        rule: 'subscription-period',
      },
    ]);
    expect(mockFollowUps(dir, 'ui/src/webhook.test.ts', 'all green', 'subscriptionPeriod')).toEqual(
      [],
    );
    expect(
      stripePack.testFollowUps?.({
        root: dir,
        workspaces: ['ui'],
        failing: ['src/webhook.test.ts'],
        output,
        context: {
          from: '14.25.0',
          to: '23.0.0',
          includeDeprecated: false,
          helpers: [
            {
              name: 'subscriptionPeriod',
              file: 'packages/core/src/ee/billing/stripe.ts',
              specifiers: { ui: '@acme/core' },
            },
          ],
        },
      }),
    ).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('counts a resource change only for products the code calls, and explains a compiler error by the entry that names its member', () => {
  const entries = between(catalog as StripeCatalog, '2023-10-16', '2026-09-30.endive');
  // What a billing integration calls: subscriptions, schedules, checkout, the portal, customers.
  const evidence = [
    {
      path: 'Stripe.SubscriptionsResource#update',
      kind: 'method' as const,
      file: 'ui/change-plan.ts',
      line: 150,
    },
    {
      path: 'Stripe.SubscriptionsResource#update#billing_cycle_anchor',
      kind: 'param' as const,
      file: 'ui/change-plan.ts',
      line: 159,
      compiler: true as const,
    },
    {
      path: 'Stripe.SubscriptionSchedulesResource#create',
      kind: 'method' as const,
      file: 'ui/change-plan.ts',
      line: 190,
    },
    {
      path: 'Stripe.Checkout.SessionsResource#create',
      kind: 'method' as const,
      file: 'ui/checkout.ts',
      line: 40,
    },
    {
      path: 'Stripe.BillingPortal.SessionsResource#create',
      kind: 'method' as const,
      file: 'ui/portal.ts',
      line: 20,
    },
    {
      path: 'Stripe.CustomersResource#create',
      kind: 'method' as const,
      file: 'ui/checkout.ts',
      line: 30,
    },
    // A field read on a returned object, and a type merely named: not calls.
    { path: 'Stripe.Account#id', kind: 'field' as const, file: 'ui/x.ts', line: 1 },
  ];
  const used = calledResources(evidence, ['customer.subscription.updated']);
  expect(used).toEqual([
    'checkout',
    'billing_portal',
    'subscription_schedule',
    'subscription',
    'customer',
  ]);
  expect(usedProducts(used)).toEqual(['Billing', 'Checkout', 'Payments']);
  const evidenced = evidencedEntries(entries, evidence);
  // The compiler error on `billing_cycle_anchor` is explained by the breaking entries that name it.
  const anchor = evidenced.find((e) => e.entry.url.includes('polymorphic-billing-cycle-anchor'));
  expect(anchor?.evidence).toEqual([evidence[1]]);
  // Without the compiler's word, a name in a title is not evidence.
  const unconfirmed = evidencedEntries(
    entries,
    evidence.map(({ compiler: _c, ...e }) => e),
  );
  expect(unconfirmed.some((e) => e.entry.url.includes('polymorphic-billing-cycle-anchor'))).toBe(
    false,
  );
  // Non-breaking entries that merely mention the anchor are not "affects your code".
  expect(evidenced.every((e) => e.entry.breaking || e.evidence.some((x) => !x.compiler))).toBe(
    true,
  );
  const byResource = resourceEntries(
    entries,
    evidenced.map((e) => e.entry),
    used,
  );
  const tags = new Set(byResource.flatMap((e) => e.products.split(',').map((t) => t.trim())));
  for (const product of ['Connect', 'Issuing', 'Treasury', 'Terminal']) {
    // Present only on entries that also carry a product the code uses.
    for (const e of byResource.filter((x) => x.products.includes(product)))
      expect(/Billing|Checkout|Payments|All products/.test(e.products)).toBe(true);
  }
  expect(tags.has('Billing')).toBe(true);
  expect(byResource.every((e) => !/^Connect$|^Issuing$|^Treasury$/.test(e.products.trim()))).toBe(
    true,
  );
});

const castFixture = [
  "import type Stripe from 'stripe';",
  'const subscription = {',
  "  id: 'sub_1',",
  '  current_period_start: 100,',
  '  current_period_end: 200,',
  '} as Stripe.Subscription;',
  'const done = { id: 1 } as unknown as Stripe.Invoice;',
  '',
].join('\n');
const castSite = (over: Partial<Usage> = {}): Finding =>
  ({
    change: { path: 'TS2352' },
    usage: {
      file: 'src/billing/renewal.test.ts',
      line: 2,
      column: 22,
      compileCode: 2352,
      ...over,
    },
  }) as Finding;

it('widens a direct cast a test already had, and nothing else', () => {
  const widened = widenFixtureCast(castFixture, castSite());
  expect(widened?.rule).toBe('fixture-cast');
  expect(widened?.text).toContain('} as unknown as Stripe.Subscription;');
  // One cast changed, the rest of the file byte for byte.
  expect(widened?.text.replace('as unknown as Stripe.Subscription', 'as Stripe.Subscription')).toBe(
    castFixture,
  );
  const context = { from: '14.25.0', to: '23.0.0', includeDeprecated: false };
  expect(stripePack.transform(castFixture, castSite(), context)).toMatchObject({
    applied: true,
    rule: 'fixture-cast',
  });
  // A compiler-only finding names its code in the change path.
  const compilerOnly = { ...castSite(), usage: { ...castSite().usage, compileCode: undefined } };
  expect(widenFixtureCast(castFixture, compilerOnly as Finding)?.rule).toBe('fixture-cast');
  // Application code, another diagnostic, or a cast that already goes through unknown: no rule.
  expect(
    widenFixtureCast(castFixture, castSite({ file: 'src/billing/renewal.ts' })),
  ).toBeUndefined();
  expect(
    widenFixtureCast(castFixture, {
      ...castSite({ compileCode: 2339 }),
      change: { path: 'TS2339' },
    } as Finding),
  ).toBeUndefined();
  expect(widenFixtureCast(castFixture, castSite({ line: 7, column: 14 }))).toBeUndefined();
  // No cast at the site: the rule never introduces one.
  expect(
    widenFixtureCast("const s: Stripe.Subscription = { id: 'sub_1' };\n", castSite({ line: 1 })),
  ).toBeUndefined();
});

it('gives a fixture with only the old period fields the item that carries them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stripe-fixture-items-'));
  try {
    writeFileSync(join(dir, 'renewal.test.ts'), castFixture);
    expect(periodFixtureEdits(dir, 'renewal.test.ts')).toEqual([
      {
        file: 'renewal.test.ts',
        line: 5,
        before: '  current_period_end: 200,',
        after:
          '  current_period_end: 200,\n  items: { data: [{ current_period_start: 100, current_period_end: 200 }] },',
        reason:
          'the fixture now carries the billing period on an item, where the API puts it since 2025-03-31.basil; the migrated code reads it there',
        rule: 'subscription-period',
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const renewalModule = [
  "import type Stripe from 'stripe';",
  '',
  'export interface Renewal {',
  '  renewsAt: Date;',
  '}',
  '',
  '/** The billing period a customer is in, as the account page shows it. */',
  'export function renewalOf(subscription: Stripe.Subscription): Renewal {',
  '  return { renewsAt: new Date(subscription.current_period_end * 1000) };',
  '}',
  '',
].join('\n');

it('inserts a helper above the doc comment of the function that needs it', () => {
  const placed = aboveDeclaration(renewalModule, 9, 'export function helper() {}');
  expect(placed?.line).toBe(7);
  expect(placed?.text).toContain(
    [
      'export function helper() {}',
      '',
      '/** The billing period a customer is in, as the account page shows it. */',
      'export function renewalOf(subscription: Stripe.Subscription): Renewal {',
    ].join('\n'),
  );
  // Line comments directly above the function travel with it too.
  const lineComment = renewalModule.replace(
    '/** The billing period',
    '// Period.\n/** The billing period',
  );
  expect(aboveDeclaration(lineComment, 10, 'const helper = 1;')?.text).toContain(
    'const helper = 1;\n\n// Period.\n/** The billing period',
  );
  expect(aboveDeclaration(renewalModule, 1, 'x')).toBeUndefined();
});

it('places subscriptionPeriod in the file of the site when no client module is in reach', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stripe-in-place-'));
  try {
    mkdirSync(join(dir, 'src/billing'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"app"}');
    writeFileSync(join(dir, 'src/billing/renewal.ts'), renewalModule);
    const site = {
      change: { path: 'Stripe.Subscription#current_period_end' },
      usage: { file: 'src/billing/renewal.ts', line: 9, snippet: 'return {' },
    } as Finding;
    const placed = sharedPeriodHelper(dir, ['.'], [site], PERIOD_HELPER);
    expect(placed?.helper).toEqual({
      name: 'subscriptionPeriod',
      file: 'src/billing/renewal.ts',
      specifiers: { '.': './renewal.ts' },
    });
    const text = placed?.edits[0]?.text ?? '';
    expect(text.indexOf('export function subscriptionPeriod')).toBeLessThan(
      text.indexOf('/** The billing period a customer is in'),
    );
    expect(text).toContain(
      '/** The billing period a customer is in, as the account page shows it. */\nexport function renewalOf(',
    );
    const helpers = placed ? [placed.helper] : [];
    const shared = { from: '14.25.0', to: '23.0.0', includeDeprecated: false, helpers };
    // In the helper's own file there is nothing to import; elsewhere the path is per site.
    expect(stripePack.guide(site, shared)).toContain('already defined in this file');
    const other = { ...site, usage: { ...site.usage, file: 'src/routes/account.ts' } } as Finding;
    expect(stripePack.guide(other, shared)).toContain(
      'import { subscriptionPeriod } from "../billing/renewal.ts"',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
