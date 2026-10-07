import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { Node, Project, SyntaxKind } from 'ts-morph';
import type { Finding } from '../../domain/report.js';
import { createNpmFetcher, releasePackage } from '../../fetch/npm-fetcher.js';
import { satisfies } from '../../fetch/range.js';
import { UPTIDE_COMMAND } from '../../version.js';
import type { Pack, PackMeta } from '../contract.js';
import type { PackContext, SharedHelper } from '../types.js';
import { between, type StripeCatalog } from './changelog.js';
import catalog from './changelog.v1.json' with { type: 'json' };
import {
  calledResources,
  clientPins,
  evidencedEntries,
  mockFollowUps,
  periodFixtureEdits,
  pinAssertions,
  pinClient,
  resourceEntries,
  sharedPeriodHelper,
  stripeEvidence,
  unpinnedClients,
  usedResources,
} from './relevance.js';

export function sdkApiVersion(dir: string): string {
  for (const relative of [
    'cjs/apiVersion.d.ts',
    'esm/apiVersion.d.ts',
    'types/lib.d.ts',
    'cjs/apiVersion.js',
    'esm/apiVersion.js',
  ]) {
    const file = join(dir, relative);
    if (!existsSync(file)) continue;
    const match =
      /(?:LatestApiVersion\s*=|ApiVersion\s*=)\s*['"](\d{4}-\d{2}-\d{2}(?:\.[\w-]+)?)['"]/.exec(
        readFileSync(file, 'utf8'),
      );
    if (match?.[1]) return match[1];
  }
  throw new Error('cannot read the API version pinned by this Stripe SDK; review manually');
}
const pin = /(?:^|[.#])(?:apiVersion|LatestApiVersion)$/;
/**
 * The resources a repository uses: what it calls (methods, parameters, handled events) when
 * the evidence is at hand, else every path it names (contexts made before evidence existed).
 */
function resourcesOf(context: PackContext): string[] {
  return context.evidence?.length
    ? calledResources(context.evidence, context.eventTypes ?? [])
    : usedResources(context.usagePaths ?? [], context.eventTypes ?? []);
}
/** The deepest workspace a repository-relative file belongs to, among those the context names. */
function workspaceOf(file: string, helper: SharedHelper): string | undefined {
  return Object.keys(helper.specifiers)
    .filter((w) => w === '.' || file.startsWith(`${w}/`))
    .sort((a, b) => b.length - a.length)[0];
}
/**
 * What to do at a period site: import the shared helper when the run placed one (never
 * redefine it), or write it once; and what `undefined` means where the code stands.
 */
function relativeSpecifier(from: string, to: string): string {
  const rel = relative(dirname(from), to).replace(/\.[cm]?[jt]sx?$/, '');
  return `${rel.startsWith('.') ? rel : `./${rel}`}.ts`;
}
function periodGuide(f: Finding, context?: PackContext): string {
  const shared = context?.helpers?.find((h) => h.name === 'subscriptionPeriod');
  const workspace = shared ? workspaceOf(f.usage.file, shared) : undefined;
  const mapped = shared && workspace ? shared.specifiers[workspace] : undefined;
  // Inside the helper's own workspace the path depends on where this site's file is.
  const specifier =
    shared && mapped?.startsWith('.') ? relativeSpecifier(f.usage.file, shared.file) : mapped;
  const where =
    shared && shared.file === f.usage.file
      ? '`subscriptionPeriod` is already defined in this file, above the function that reads the period. Call it; never define a second copy and never move it.'
      : specifier
        ? `\`subscriptionPeriod\` is already exported from \`${shared?.file}\`; import it with \`import { subscriptionPeriod } from "${specifier}"\` (add the name to an existing import from "${specifier}" when the file has one). Never define a local copy.`
        : `Define it once, before the enclosing function, exactly as: ${PERIOD_HELPER}`;
  return [
    `For current_period_start or current_period_end on Subscription use the helper subscriptionPeriod(s), which returns { start, end } from the item that ends last, or undefined when the subscription has no items. ${where}`,
    'Call it once per site into a local (const period = subscriptionPeriod(subscription)) and read period.start / period.end. Never fall back to 0 or any other sentinel for a timestamp.',
    'When the helper returns undefined: where the code already handles a missing period (it fetches the full subscription), keep that path and use the undefined check for it; everywhere else throw new Error("subscription " + subscription.id + " has no items"), since Stripe never returns one. That throw is the one new failure mode allowed.',
    'Add a code comment at the site: identical to the old subscription-level values for a single-item subscription; the latest-ending item for a multi-item one. State the multi-item decision in your explanation.',
  ].join(' ');
}
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/)/;
/**
 * A test that already cast a partial fixture straight to an SDK type (`{...} as
 * Stripe.Subscription`) stops compiling when the type no longer overlaps with the literal
 * (TS2352). The author's intent is unchanged, so the cast they wrote goes through `unknown`,
 * as the compiler asks: nothing new is asserted and no diagnostic that was not already
 * waived by that cast is hidden. Only here: an existing direct cast, in a test file, at the
 * reported site. A cast the agent adds anywhere is still rejected.
 */
export function widenFixtureCast(
  text: string,
  finding: Finding,
): { text: string; applied: true; rule: string; reason: string } | undefined {
  // A compiler-only finding carries its code as the change path (`TS2352`).
  const code = finding.usage.compileCode ?? Number(/^TS(\d+)$/.exec(finding.change.path)?.[1]);
  if (code !== 2352 || !TEST_FILE.test(finding.usage.file)) return undefined;
  const ast = new Project({ useInMemoryFileSystem: true }).createSourceFile('fixture.ts', text);
  const casts = ast.getDescendantsOfKind(SyntaxKind.AsExpression).filter((cast) => {
    const type = cast.getTypeNode();
    return (
      cast.getStartLineNumber() === finding.usage.line &&
      type !== undefined &&
      type.getKind() !== SyntaxKind.UnknownKeyword &&
      // `x as unknown as T` and `x as const` are not direct casts to a type.
      !Node.isAsExpression(cast.getExpression()) &&
      type.getText() !== 'const'
    );
  });
  const column = (cast: (typeof casts)[number]): number =>
    cast.getStart() - cast.getStartLinePos() + 1;
  const cast =
    casts.find((c) => column(c) === finding.usage.column) ??
    (casts.length === 1 ? casts[0] : undefined);
  const type = cast?.getTypeNode();
  if (!cast || !type) return undefined;
  const at = type.getStart();
  return {
    text: `${text.slice(0, at)}unknown as ${text.slice(at)}`,
    applied: true,
    rule: 'fixture-cast',
    reason: `the test already cast this partial fixture to ${type.getText()}; the same cast now goes through unknown, which the compiler requires once the types stop overlapping`,
  };
}
/**
 * The replacement for the removed subscription-level period: the item that ends last, start
 * and end from that same item, so the two are always coherent. Same values as before for a
 * single-item subscription. No sentinel: undefined on an empty item list (which Stripe never
 * returns), and each call site says what that means there. Typed structurally: a file that
 * reads a subscription another package fetched has no `Stripe` namespace to name. Exported,
 * so it lives once in the shared billing module and every site imports it.
 */
export const PERIOD_HELPER =
  'type PeriodItem = { current_period_start: number; current_period_end: number };\n/**\n * The billing period of a subscription, from its items: Stripe moved current_period_start and\n * current_period_end there in API 2025-03-31.basil. The item that ends last, start and end from\n * that same item, so the period is always coherent; identical to the old subscription-level\n * values for a single-item subscription. Undefined when there are no items, which Stripe never\n * returns: the caller decides what that means where it stands.\n */\nexport function subscriptionPeriod(s: { items: { data: PeriodItem[] } }): { start: number; end: number } | undefined {\n  const latest = s.items.data.reduce<PeriodItem | undefined>(\n    (best, item) => (best === undefined || item.current_period_end > best.current_period_end ? item : best),\n    undefined,\n  );\n  return latest && { start: latest.current_period_start, end: latest.current_period_end };\n}';
/** SDK differences remain distinct from server API behaviour, even when they share a type diagnostic. */
export function stripeConcerns(findings: Finding[], context: PackContext) {
  const api = context.apiVersions;
  return {
    sdkSurface: findings.filter((f) => !pin.test(f.change.path)),
    apiVersion: {
      ...api,
      pins: findings.filter(
        (f) =>
          pin.test(f.change.path) || /apiVersion|LatestApiVersion/.test(f.usage.compileError ?? ''),
      ),
      fields: findings.filter((f) =>
        /Stripe\.(?:Checkout\.Session|Subscription|Event|\w+(?:Create|Update|Retrieve)Params)[.#]/.test(
          f.change.path,
        ),
      ),
      entries: api ? between(catalog as StripeCatalog, api.from, api.to) : [],
    },
  };
}
const SDK_GUIDE =
  'Migrate the reported Stripe SDK usage while preserving payment, subscription and webhook semantics. Use the target diagnostic and checked-in API changelog. Never remove signature verification, change monetary amounts/currency, or introduce a cast to hide incompatible data.';
const meta: PackMeta = {
  package: 'stripe',
  from: '>=14',
  // Any later version: `supports` also requires the target to be newer than what is installed.
  to: '>=14',
  sources: [
    {
      title: 'stripe-node changelog',
      url: 'https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md',
    },
    { title: 'Stripe API changelog', url: 'https://docs.stripe.com/changelog' },
    { title: 'Stripe API upgrades', url: 'https://docs.stripe.com/upgrades' },
  ],
  maintainer: 'uptide-dev',
};
export const stripePack: Pack = {
  name: 'stripe',
  meta,
  defaultTarget: '22.6.2',
  supports: (from, to) => satisfies(from, meta.from) && satisfies(to, `>${from}`),
  rules: [
    {
      id: 'api-version',
      summary: 'an apiVersion literal or LatestApiVersion the target SDK no longer accepts',
      severity: 'breaking',
      kinds: ['type', 'signature', 'narrowed', 'widened', 'required'],
      symbols: pin,
      guide:
        'Changing apiVersion changes server responses and webhook payloads. Review every intervening API changelog entry. Never update the literal mechanically or cast it to LatestApiVersion merely to compile. Confirm response and request field migrations and coordinate webhook endpoints/other services.',
    },
    {
      id: 'api-version-unpinned',
      summary: 'a client without apiVersion, whose API version the SDK bump changes at runtime',
      severity: 'breaking',
      kinds: ['type'],
      symbols: /^Stripe\.StripeConfig#apiVersion$/,
      guide:
        'This client sets no apiVersion, so the SDK bump changes the API version it speaks at runtime. Either pin the version the installed SDK defaulted to (no behaviour change) or adopt the new default and migrate every field the changelog entries touch. The owner decides; do not pick for them.',
    },
    {
      id: 'sdk-surface',
      summary: 'any other SDK type or method the target changed; migrated by the agent',
      severity: 'breaking',
      kinds: [
        'removed',
        'moved',
        'signature',
        'type',
        'required',
        'deprecated',
        'narrowed',
        'widened',
      ],
      symbols: /./,
      guide: SDK_GUIDE,
    },
    // Classified from the site's evidence after the rules above matched (`changeRule` in
    // fix/report.ts), never by kind and symbol: listed so the contract names every rule a
    // plan or a pull request can show.
    {
      id: 'subscription-period',
      summary:
        'current_period_start/end moved to subscription items (2025-03-31.basil); migrated by the agent through one shared helper, the multi-item case is a decision',
      severity: 'breaking',
      kinds: [],
      symbols: /current_period_(?:end|start)/,
      guide: 'See the subscription period guide above.',
    },
    {
      id: 'fixture-cast',
      summary:
        'a test that cast a partial fixture to an SDK type goes through unknown once the types stop overlapping (TS2352)',
      severity: 'breaking',
      kinds: [],
      symbols: /^TS2352$/,
      guide: 'Rewritten by rule: the same cast through unknown, in test files only.',
    },
  ],
  behavior: [
    {
      id: 'api-changelog',
      summary:
        'API changelog entries between the two pinned API versions, filtered to the methods, fields, parameters and events the code uses',
      reported: ['decision'],
    },
    {
      id: 'webhook-payload-versions',
      summary:
        'api_version literals in webhook payload fixtures mirror the endpoint configuration and stay as they are',
      reported: ['decision'],
    },
  ],
  instructions: SDK_GUIDE,
  transform: (text, finding, context) => {
    // A client without apiVersion says the version the target SDK's types describe: with the
    // bump that is the only honest pin. Staying on the old version is `--pin-current-api`.
    if (finding.rule === 'api-version-unpinned' && context.apiVersions) {
      const pinned = pinClient(text, finding.usage.line, context.apiVersions.to);
      if (pinned !== undefined)
        return {
          text: pinned,
          applied: true,
          rule: 'api-version-unpinned',
          reason: `apiVersion: '${context.apiVersions.to}' added, the version the target SDK's types describe`,
        };
    }
    const widened = widenFixtureCast(text, finding);
    if (widened) return widened;
    return {
      text,
      applied: false,
      reason:
        pin.test(finding.change.path) ||
        /apiVersion|LatestApiVersion/.test(finding.usage.compileError ?? '')
          ? 'API version changes runtime behaviour; assisted review required'
          : 'Stripe SDK/response-field migration requires assisted review',
    };
  },
  guide: (f, context) => {
    const general =
      stripePack.rules.find((r) => r.kinds.includes(f.change.kind) && r.symbols.test(f.change.path))
        ?.guide ?? 'Review the Stripe API upgrade before editing this usage.';
    const isPin =
      pin.test(f.change.path) || /apiVersion|LatestApiVersion/.test(f.usage.compileError ?? '');
    const entries = context?.apiVersions
      ? evidencedEntries(
          between(catalog as StripeCatalog, context.apiVersions.from, context.apiVersions.to),
          (context.evidence ?? []).filter(
            (e) => isPin || (e.file === f.usage.file && e.line === f.usage.line),
          ),
        )
      : [];
    return [
      general,
      `Target API literal: ${context?.apiVersions?.to ?? 'unknown: do not guess'}. Update literal values, never cast away the API-version constraint.`,
      'Never change `api_version` values inside webhook payloads, event objects or their test fixtures: they record the API version configured on the webhook endpoint, not the SDK pin.',
      'Patch ONLY the current reported site. When adding a helper, insert immediately before the enclosing function shown in the context, using its exact source as the patch anchor. Do not guess unshown lines or fix other evidence sites. Reuse an existing helper if provided. Never introduce throws, nulls, or new failure modes in a migration. Preserve existing payment and webhook behavior and constructEvent signature verification.',
      periodGuide(f, context),
      ...entries.map(
        ({ entry: e, evidence }) =>
          `${e.version}: "${e.title}" (${e.url}) — evidence: ${evidence.map((u) => `${u.file}:${u.line} ${u.path}`).join('; ')}`,
      ),
    ].join('\n');
  },
  validateAssisted(text, finding, explanation, original = '', context) {
    const ast = (source: string) =>
      new Project({ useInMemoryFileSystem: true }).createSourceFile('code.ts', source);
    const before = ast(original),
      after = ast(text);
    // Payload `api_version` values mirror the webhook endpoint's configuration, not the SDK.
    const payloads = (source: string) =>
      source.match(/\bapi_version["']?\s*:\s*["'][^"']+["']/g) ?? [];
    if (payloads(text).join('|') !== payloads(original).join('|'))
      return 'Do not change api_version values in webhook payloads or fixtures; they reflect the endpoint configuration.';
    // The one throw a period migration may add says why: the subscription has no items.
    const throws = (source: string) =>
      ast(source)
        .getDescendantsOfKind(SyntaxKind.ThrowStatement)
        .filter((t) => !/no items/.test(t.getText())).length;
    if (throws(text) > throws(original))
      return 'Never introduce throws, nulls or new failure modes in a migration.';
    for (const kind of [SyntaxKind.NullKeyword]) {
      const count = before.getDescendantsOfKind(kind).length;
      if (after.getDescendantsOfKind(kind).length > count)
        return 'Never introduce throws, nulls or new failure modes in a migration.';
    }
    const isPeriod = /current_period_(end|start)/.test(
      `${finding.change.path} ${finding.usage.compileError ?? ''}`,
    );
    if (!isPeriod) return undefined;
    if (!/single[- ]item/i.test(text) || !/multi[- ]item/i.test(explanation))
      return 'Document single-item equivalence in code and the multi-item decision in the explanation.';
    // Only what the patch wrote is judged: the file may already read `items.data[0]` elsewhere.
    const had = new Set(original.split('\n'));
    const added = text
      .split('\n')
      .filter((line) => !had.has(line))
      .join('\n');
    const shared = context?.helpers?.some((h) => h.name === 'subscriptionPeriod');
    if (shared && /\bfunction subscriptionPeriod\b|\bconst subscriptionPeriod\b/.test(added))
      return 'subscriptionPeriod is already exported from the shared billing module: import it, do not define a copy.';
    if (!shared && (!/\.reduce(?:<[^>]*>)?\(/.test(text) || !/current_period_end\s*>/.test(text)))
      return 'Use the deterministic helper that picks the item ending last and returns start and end from that same item.';
    // The call itself, or a read of the local an earlier edit in this file made from it.
    if (
      !/\bsubscriptionPeriod\(/.test(added) &&
      !(/\bsubscriptionPeriod\(/.test(text) && /\bperiod\.(?:start|end)\b/.test(added))
    )
      return 'Read the period through subscriptionPeriod(subscription), not from the subscription itself.';
    if (/(?:period|start|end|_at)\b[^\n]*(?:\?\?|\|\|)\s*0\b/.test(added))
      return 'No sentinel for a timestamp: handle undefined where the code stands (keep the existing fetch path, or throw "has no items"), never fall back to 0.';
    if (/Math\.(?:max|min)\(/.test(added))
      return 'Start and end must come from the same item: no separate Math.max over ends or Math.min over starts.';
    if (/\.data\s*\[\s*0\s*\]|\.length\s*!==?\s*1/.test(added))
      return 'Do not choose a first item or add a single-item failure guard.';
    return undefined;
  },
  async resolveContext(context) {
    const fetcher = createNpmFetcher();
    const a = await fetcher.fetch('stripe', context.from);
    const b = await fetcher.fetch('stripe', context.to);
    try {
      return { ...context, apiVersions: { from: sdkApiVersion(a.dir), to: sdkApiVersion(b.dir) } };
    } finally {
      await releasePackage(fetcher, a);
      await releasePackage(fetcher, b);
    }
  },
  reviewNotes: (context) => [
    `SDK ${context.from} → ${context.to}. API pin ${context.apiVersions?.from ?? 'unknown'} → ${context.apiVersions?.to ?? 'unknown'}. SDK releases pin an API date; the date can also change within a major.`,
    'Changing apiVersion can change response shapes and webhook payloads. It is never a mechanical fix.',
  ],
  followUps({ root, workspaces, finding, context }) {
    const isPin =
      pin.test(finding.change.path) ||
      /apiVersion|LatestApiVersion/.test(finding.usage.compileError ?? '');
    if (!isPin || !context.apiVersions) return [];
    return [
      ...pinAssertions(root, workspaces, finding.usage.snippet, context.apiVersions),
      ...clientPins(
        root,
        workspaces,
        { file: finding.usage.file, declaration: finding.usage.snippet },
        context.apiVersions,
      ),
    ];
  },
  sharedHelpers({ root, workspaces, findings }) {
    const placed = sharedPeriodHelper(root, workspaces, findings, PERIOD_HELPER);
    return placed ? [placed] : [];
  },
  testFollowUps({ root, workspaces, failing, output = '', context }) {
    // The runner names files relative to its workspace; try each one that could hold it.
    const candidates = (f: string): string[] => [f, ...workspaces.map((w) => join(w, f))];
    return failing.flatMap((f) => {
      const file = candidates(f).find((c) => existsSync(join(root, c)));
      if (!file) return [];
      return [
        ...periodFixtureEdits(root, file),
        ...(context.helpers ?? []).flatMap((h) => mockFollowUps(root, file, output, h.name)),
      ];
    });
  },
  apiChanges(context) {
    if (!context.apiVersions) return undefined;
    const { from, to } = context.apiVersions;
    const entries = between(catalog as StripeCatalog, from, to);
    const evidenced = evidencedEntries(entries, context.evidence ?? []).map((e) => e.entry);
    const names = resourcesOf(context);
    const byResource = resourceEntries(entries, evidenced, names);
    return {
      from,
      to,
      total: entries.length,
      relevant: evidenced.length,
      breaking: entries.filter((e) => e.breaking).length,
      ...(byResource.length
        ? {
            resources: {
              total: byResource.length,
              breaking: byResource.filter((e) => e.breaking).length,
              names,
            },
          }
        : {}),
    };
  },
  decisions(context, rules = []) {
    const choices: string[] = [];
    if (rules.includes('api-version-unpinned') && context.apiVersions) {
      const { from, to } = context.apiVersions;
      choices.push(
        `- A client was created without \`apiVersion\`, so it spoke \`${from}\`, the SDK default. Two PRs are possible: (a) the small one, stay on stripe ${context.from} and write \`apiVersion: '${from}'\` on the client, zero behaviour change: \`${UPTIDE_COMMAND} fix --only stripe --pin-current-api\`; (b) the full one, this PR: stripe ${context.to}, \`apiVersion: '${to}'\`, and the code migrated to it. Not offered: stripe ${context.to} pinned to \`${from}\`, because the new SDK's types describe \`${to}\` and the code would compile against shapes the server no longer sends.`,
      );
    }
    if (rules.includes('subscription-period'))
      choices.push(
        '- The subscription billing period now comes from one item: the item that ends last, start and end from that same item. Identical to the old subscription-level values for a single-item subscription. Items can have different periods: this chooses the latest-ending item, not a shared billing period. Confirm that this is the desired business rule.',
        '- A subscription with no items (Stripe never returns one) makes the helper return undefined: a webhook keeps its existing path of fetching the full subscription; an API route throws "subscription has no items". No sentinel timestamps. Pagination can omit items: the helper uses the returned items.data, so review subscriptions with more items than one response page.',
      );
    const kept = (context.payloadVersions ?? []).filter((p) => p.value !== context.apiVersions?.to);
    if (kept.length === 0) return choices;
    const values = [...new Set(kept.map((p) => p.value))].map((v) => `\`${v}\``).join(', ');
    const files = new Map<string, number[]>();
    for (const p of kept) files.set(p.file, [...(files.get(p.file) ?? []), p.line]);
    const where = [...files]
      .map(
        ([file, lines]) => `\`${file}\` (line${lines.length === 1 ? '' : 's'} ${lines.join(', ')})`,
      )
      .join('; ');
    return [
      ...choices,
      `- \`api_version\` stays ${values} in ${kept.length} webhook payload fixture${kept.length === 1 ? '' : 's'}: ${where}. They reflect the API version configured on the webhook endpoint, which this upgrade does not change; update them when you roll the endpoint.`,
    ];
  },
  runtimeFindings({ workspace, from, to, installedDir, targetDir, usages, read }) {
    const api = { from: sdkApiVersion(installedDir), to: sdkApiVersion(targetDir) };
    if (api.from === api.to) return [];
    const path = 'Stripe.StripeConfig#apiVersion';
    const reason = `API version changes from ${api.from} to ${api.to} at runtime`;
    return unpinnedClients(usages, (file) => read(join(workspace, file))).map((site) => ({
      change: {
        package: 'stripe',
        from,
        to,
        path,
        kind: 'type',
        severity: 'breaking',
        source: 'pack',
        confidence: 1,
        before: api.from,
        after: api.to,
      },
      usage: { ...site, symbolPath: path, access: 'construct', via: 'direct' },
      severity: 'breaking',
      confidence: 1,
      fixability: 'manual',
      reason,
      rule: 'api-version-unpinned',
    }));
  },
  describeFinding(finding, context) {
    if (finding.rule !== 'api-version-unpinned' || !context.apiVersions) return undefined;
    const { from, to } = context.apiVersions;
    const entries = between(catalog as StripeCatalog, from, to);
    const relevant = evidencedEntries(entries, context.evidence ?? []);
    return {
      reason: `API version changes from ${from} to ${to} at runtime: ${relevant.length} of ${entries.length} API changes touch what this repository reads`,
      details: relevant.map(({ entry, evidence }) => {
        const byFile = new Map<string, Set<number>>();
        for (const e of evidence) byFile.set(e.file, new Set(byFile.get(e.file) ?? []).add(e.line));
        const where = [...byFile]
          .map(([file, lines]) => `${file}:${[...lines].sort((a, b) => a - b).join(',')}`)
          .join('; ');
        return `${entry.version}: ${entry.title} — ${where}`;
      }),
    };
  },
  planContext({ root, workspace, installedDir, targetDir, usages }) {
    return {
      apiVersions: { from: sdkApiVersion(installedDir), to: sdkApiVersion(targetDir) },
      evidence: stripeEvidence(root, workspace, usages).evidence,
    };
  },
  planNote(rule, context) {
    if (!['api-version', 'api-version-unpinned'].includes(rule) || !context.apiVersions)
      return undefined;
    const entries = between(
      catalog as StripeCatalog,
      context.apiVersions.from,
      context.apiVersions.to,
    );
    const relevant = evidencedEntries(entries, context.evidence ?? []).length;
    const changes = `API change${entries.length === 1 ? '' : 's'}`;
    return relevant > 0
      ? `${relevant} API change${relevant === 1 ? '' : 's'} since ${context.apiVersions.from} affect${relevant === 1 ? 's' : ''} your code`
      : `none of the ${entries.length} ${changes} since ${context.apiVersions.from} has evidence in your code`;
  },
  reviewSections(context) {
    if (!context.apiVersions)
      throw new Error('Stripe API versions must be resolved before generating the PR');
    const entries = between(
      catalog as StripeCatalog,
      context.apiVersions.from,
      context.apiVersions.to,
    );
    const relevant = evidencedEntries(entries, context.evidence ?? []);
    const names = resourcesOf(context);
    const byResource = resourceEntries(
      entries,
      relevant.map((r) => r.entry),
      names,
    );
    const other = entries.filter(
      (e) => !relevant.some((r) => r.entry === e) && !byResource.includes(e),
    );
    const render = (e: (typeof entries)[number]) =>
      `- ${e.version}: [${e.title}](${e.url}) — ${e.breaking ? 'breaking' : 'non-breaking'}; ${e.products}`;
    const breaking = byResource.filter((e) => e.breaking).length;
    return [
      {
        title: 'Stripe API changelog',
        lines: [
          `${relevant.length} of ${entries.length} affect your code: each shown entry names a method, field, parameter or event the code uses, with where. ${byResource.length} more change resources the code uses (${breaking} breaking), listed below breaking first, then the rest.`,
          '',
          ...relevant.map(
            ({ entry, evidence }) =>
              `${render(entry)} — evidence: ${evidence.map((e) => `\`${e.file}:${e.line}\` (${e.kind} \`${e.path}\`)`).join('; ')}`,
          ),
        ],
        // In a PR body these give way from their end; the migration page keeps them whole.
        lists: [
          {
            summary: `${byResource.length} changes to resources you use (${breaking} breaking): ${names.map((n) => n.replaceAll('_', ' ')).join(', ')}`,
            items: byResource.map(render),
            more: `- … {n} more not shown here: [Stripe's changelog](https://docs.stripe.com/changelog), ${context.apiVersions.from} → ${context.apiVersions.to}.`,
          },
          {
            summary: `${other.length} other changelog entries`,
            items: other.map(render),
            more: `- … {n} more not shown here: [Stripe's changelog](https://docs.stripe.com/changelog), ${context.apiVersions.from} → ${context.apiVersions.to}.`,
          },
        ].filter((list) => list.items.length > 0),
      },
      {
        title: 'Also check outside the code',
        lines: [
          '- Webhook endpoint API versions configured in the Stripe dashboard, including replayed events.',
          '- API versions pinned by other services, workers, and consumers of webhook payloads.',
        ],
      },
    ];
  },
};
