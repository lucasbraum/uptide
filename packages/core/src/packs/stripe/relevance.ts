import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { createTypescriptAdapter } from '../../adapters/typescript/index.js';
import type { Finding } from '../../domain/report.js';
import { type Usage, usagePaths } from '../../domain/usage.js';
import type { FollowUp, MigrationEvidence, SharedHelper } from '../types.js';
import type { StripeEntry } from './changelog.js';

export interface StripeTouches {
  resources: string[];
  fields: string[];
  params: string[];
  events: string[];
  methods?: string[];
}
const resources = [
  'checkout',
  'billing_portal',
  'subscription_schedule',
  'subscription_item',
  'subscription',
  'customer',
  'invoice',
  'payment_intent',
  'payment_method',
  'payment_link',
  'price',
  'product',
  'charge',
  'refund',
  'dispute',
  'payout',
  'balance',
  'account',
  'tax',
  'coupon',
  'promotion_code',
  'setup_intent',
  'invoice_item',
  'usage_record',
  'meter',
  'event',
  'webhook',
];
function words(text: string) {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[_./#-]/g, ' ')
    .replace(/\b([a-z]+)s\b/g, '$1');
}
/** Explicit conservative metadata from title/URL; unclassified entries remain in the full disclosure. */
export function entryTouches(entry: Pick<StripeEntry, 'title' | 'url'>): StripeTouches {
  const text = words(`${entry.title} ${entry.url}`);
  const fields = [...new Set(`${entry.title} ${entry.url}`.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])];
  if (entry.url.includes('/deprecate-subscription-current-period-start-and-end'))
    fields.push('current_period_start', 'current_period_end');
  return {
    resources: resources.filter((r) => text.includes(words(r))),
    fields,
    params: fields,
    events: [...new Set(entry.title.match(/\b[a-z]+(?:\.[a-z_]+){2,}\b/g) ?? [])],
  };
}
/** Resource names alone are not evidence: require a matching method, member, parameter or event. */
export function evidencedEntries(entries: StripeEntry[], evidence: MigrationEvidence[]) {
  return entries
    .map((entry) => {
      const t = entry.touches ?? entryTouches(entry);
      const matches = evidence.filter((e) => {
        if (e.kind === 'event') return t.events.includes(e.path);
        const member = e.path.split(/[.#]/).at(-1) ?? '';
        const sameResource = t.resources.some((r) => words(e.path).includes(words(r)));
        if (e.kind === 'method') return (t.methods ?? []).includes(e.path);
        if (sameResource && (e.kind === 'param' ? t.params : t.fields).includes(member))
          return true;
        // A compile error at the site means something breaking happened to this member. A
        // breaking entry on the same resource that names it in words ("billing cycle anchor"
        // for `billing_cycle_anchor`) is that change; one-word names are too common to trust.
        return (
          e.compiler === true &&
          entry.breaking &&
          sameResource &&
          member.includes('_') &&
          ` ${words(`${entry.title} ${entry.url}`)} `.includes(` ${words(member)} `)
        );
      });
      return { entry, evidence: matches };
    })
    .filter((e) => e.evidence.length)
    .sort(
      (a, b) =>
        b.evidence.length - a.evidence.length ||
        Number(b.entry.breaking) - Number(a.entry.breaking) ||
        a.entry.url.localeCompare(b.entry.url),
    );
}
/**
 * The resources the code touches, by name: from the symbol paths it uses
 * (`Stripe.SubscriptionSchedulesResource#create` → subscription schedule) and the webhook events
 * it handles (`customer.subscription.updated` → customer, subscription). Longer names win over
 * their prefixes: a subscription schedule is not a subscription.
 */
/**
 * The products each resource belongs to, in the changelog's own product tags. An entry about
 * Connect accounts, Issuing or Treasury mentions "customer" and "account" too; it concerns a
 * repository only when the repository calls something of that product.
 */
const PRODUCTS: Record<string, string[]> = {
  checkout: ['Checkout'],
  billing_portal: ['Billing'],
  subscription_schedule: ['Billing'],
  subscription_item: ['Billing'],
  subscription: ['Billing'],
  invoice: ['Billing', 'Invoicing'],
  invoice_item: ['Billing', 'Invoicing'],
  usage_record: ['Billing'],
  meter: ['Billing'],
  coupon: ['Billing'],
  promotion_code: ['Billing'],
  price: ['Billing', 'Checkout', 'Paymentlinks'],
  product: ['Billing', 'Checkout', 'Paymentlinks'],
  customer: ['Billing', 'Payments'],
  payment_intent: ['Payments'],
  payment_method: ['Payments'],
  setup_intent: ['Payments'],
  charge: ['Payments'],
  refund: ['Payments'],
  dispute: ['Payments'],
  payment_link: ['Paymentlinks'],
  payout: ['Payouts'],
  balance: ['Payouts'],
  account: ['Connect'],
  tax: ['Tax'],
};
/** The product tags of the resources the code calls; entries of other products are not about it. */
export function usedProducts(used: string[]): string[] {
  return [...new Set(used.flatMap((r) => PRODUCTS[r] ?? []))].sort();
}
/**
 * What the code actually calls: methods it invokes and parameters it passes, plus the webhook
 * events it handles. A type it merely names, or a field it reads on a returned object, does
 * not make it a user of that resource's API.
 */
export function calledResources(evidence: MigrationEvidence[], events: string[]): string[] {
  return usedResources(
    evidence.filter((e) => e.kind === 'method' || e.kind === 'param').map((e) => e.path),
    events,
  ).filter((r) => r !== 'event' && r !== 'webhook');
}
export function usedResources(paths: string[], events: string[]): string[] {
  const texts = [...paths, ...events].map((t) => ` ${words(t)} `);
  const found = new Set<string>();
  // Longest names first, each one consumed from the text it matched.
  for (const r of [...resources].sort((a, b) => b.length - a.length)) {
    const name = ` ${words(r)} `;
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i] as string;
      if (!t.includes(name)) continue;
      found.add(r);
      texts[i] = t.replaceAll(name, ' ');
    }
  }
  return resources.filter((r) => found.has(r));
}
/**
 * The second layer under the evidenced entries: changes to a resource the code uses, with no
 * method, field, parameter or event of the code named in them. Not evidence, so they are
 * collapsed with a count, breaking ones first; nothing a reader of billing code wants to miss.
 */
export function resourceEntries(
  entries: StripeEntry[],
  evidenced: StripeEntry[],
  used: string[],
): StripeEntry[] {
  const names = used.map((r) => words(r));
  const products = usedProducts(used);
  return (
    entries
      .filter((e) => !evidenced.includes(e))
      // The entry's own product tags decide first: Connect, Issuing or Treasury entries are
      // dropped for a repository that calls nothing of those products.
      .filter((e) => {
        const tags = e.products.split(',').map((t) => t.trim());
        return tags.includes('All products') || tags.some((t) => products.includes(t));
      })
      .filter((e) => {
        const touched = (e.touches ?? entryTouches(e)).resources.map((r) => words(r));
        const text = ` ${words(`${e.title} ${e.url}`)} `;
        return names.some(
          (n) => touched.includes(n) || text.includes(` ${n} `) || text.includes(` ${n}s `),
        );
      })
      .sort(
        (a, b) =>
          Number(b.breaking) - Number(a.breaking) ||
          b.version.localeCompare(a.version) ||
          a.url.localeCompare(b.url),
      )
  );
}
export function relevantEntries(entries: StripeEntry[], paths: string[], events: string[]) {
  return evidencedEntries(entries, [
    ...paths.map((path) => ({ path, kind: 'field' as const, file: '', line: 0 })),
    ...events.map((path) => ({ path, kind: 'event' as const, file: '', line: 0 })),
  ]).map((e) => e.entry);
}
export function handledEvents(source: string): string[] {
  const file = new Project({ useInMemoryFileSystem: true }).createSourceFile('events.ts', source);
  return file
    .getDescendantsOfKind(SyntaxKind.StringLiteral)
    .filter((l) => {
      const p = l.getParent();
      if (Node.isCaseClause(p)) {
        const sw = p.getFirstAncestorByKind(SyntaxKind.SwitchStatement);
        return /\.type$/.test(sw?.getExpression().getText() ?? '');
      }
      return (
        Node.isBinaryExpression(p) &&
        ['===', '=='].includes(p.getOperatorToken().getText()) &&
        /\.type$/.test(p.getLeft().getText())
      );
    })
    .map((l) => l.getLiteralValue())
    .filter((s) => /^[a-z_]+(?:\.[a-z_]+)+$/.test(s));
}
/**
 * Evidence that a workspace's code touches an API surface: resolved SDK calls, members read or
 * written, parameters passed to those calls, and webhook event names it handles. Works from
 * usages the caller already scanned, so `check` pays for no second program.
 */
export function stripeEvidence(root: string, workspace: string, usages: Usage[]) {
  const paths = new Set<string>(),
    events = new Set<string>();
  const evidence: MigrationEvidence[] = [];
  for (const usage of usages)
    for (const path of usagePaths(usage)) {
      paths.add(path);
      if (['call', 'read', 'write'].includes(usage.access))
        evidence.push({
          path,
          kind: usage.access === 'call' ? 'method' : usage.access === 'write' ? 'param' : 'field',
          file: join(workspace, usage.file),
          line: usage.line,
        });
    }
  for (const file of new Set(usages.map((u) => u.file))) {
    let source: string;
    try {
      source = readFileSync(join(root, workspace, file), 'utf8');
    } catch {
      continue;
    }
    const ast = new Project({ useInMemoryFileSystem: true }).createSourceFile('source.ts', source);
    for (const event of handledEvents(source)) {
      events.add(event);
      for (const literal of ast
        .getDescendantsOfKind(SyntaxKind.StringLiteral)
        .filter((l) => l.getLiteralValue() === event))
        evidence.push({
          path: event,
          kind: 'event',
          file: join(workspace, file),
          line: literal.getStartLineNumber(),
        });
    }
    // Parameter evidence is rooted in an actual resolved SDK call, never a free-floating key.
    for (const call of ast.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const usage = usages.find(
        (u) =>
          u.file === file &&
          u.access === 'call' &&
          u.line === call.getExpression().getStartLineNumber() &&
          u.snippet.includes(call.getExpression().getText()),
      );
      if (!usage) continue;
      for (const arg of call.getArguments().filter(Node.isObjectLiteralExpression))
        for (const property of arg.getDescendantsOfKind(SyntaxKind.PropertyAssignment))
          evidence.push({
            path: `${usage.symbolPath}#${property.getName()}`,
            kind: 'param',
            file: join(workspace, file),
            line: property.getStartLineNumber(),
          });
    }
  }
  return { usagePaths: [...paths], eventTypes: [...events], evidence };
}
const SOURCE = /\.[cm]?[jt]sx?$/;
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.uptide']);

/**
 * `new Stripe(key)` → `new Stripe(key, { apiVersion: '<version>' })`, or the property added
 * first in an options literal that lacks it. The file's own quote style; nothing else moves.
 * Undefined when the line holds no client to pin (already pinned, or options built elsewhere).
 */
export function pinClient(text: string, line: number, version: string): string | undefined {
  const ast = new Project({ useInMemoryFileSystem: true }).createSourceFile('source.ts', text);
  const node = ast
    .getDescendantsOfKind(SyntaxKind.NewExpression)
    .find((n) => n.getStartLineNumber() === line);
  if (!node) return undefined;
  const quote =
    (text.match(/from\s*"/g)?.length ?? 0) > (text.match(/from\s*'/g)?.length ?? 0) ? '"' : "'";
  const pin = `apiVersion: ${quote}${version}${quote}`;
  const args = node.getArguments();
  const options = args[1];
  if (args.length === 1) {
    const first = args[0] as Node;
    return `${text.slice(0, first.getEnd())}, { ${pin} }${text.slice(first.getEnd())}`;
  }
  if (!options || !Node.isObjectLiteralExpression(options)) return undefined;
  if (options.getProperty('apiVersion')) return undefined;
  const open = options.getStart() + 1;
  const first = options.getProperties()[0];
  if (!first) return `${text.slice(0, open)} ${pin} ${text.slice(open).replace(/^\s*/, '')}`;
  // Multi-line literal: a line of its own, with the first property's indentation.
  const multiline = text.slice(open, first.getStart()).includes('\n');
  const indent = multiline ? (/^[ \t]*/.exec(text.slice(first.getStartLinePos()))?.[0] ?? '') : '';
  const at = first.getStart();
  return multiline
    ? `${text.slice(0, at)}${pin},\n${indent}${text.slice(at)}`
    : `${text.slice(0, at)}${pin}, ${text.slice(at)}`;
}

export interface UnpinnedClient {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  snippet: string;
}
/**
 * `new Stripe(key)` with no `apiVersion`: the client speaks whatever API version the SDK
 * defaults to, so the SDK bump changes server responses and webhook payloads at runtime with
 * no compiler error anywhere. A pin is an `apiVersion` property in the options literal; options
 * built elsewhere (a variable, a spread) are taken as pinned when the file mentions `apiVersion`.
 */
export function unpinnedClients(
  usages: Usage[],
  read: (file: string) => string | undefined,
): UnpinnedClient[] {
  const found: UnpinnedClient[] = [];
  const constructs = usages.filter(
    (u) => u.access === 'construct' && /^(?:Stripe|default)(?:\.new\(\))?$/.test(u.symbolPath),
  );
  for (const file of new Set(constructs.map((u) => u.file))) {
    const source = read(file);
    if (source === undefined) continue;
    const ast = new Project({ useInMemoryFileSystem: true }).createSourceFile('source.ts', source);
    const mentionsPin = /\bapiVersion\b/.test(source);
    for (const node of ast.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      const line = node.getStartLineNumber();
      if (!constructs.some((u) => u.file === file && u.line === line)) continue;
      const options = node.getArguments()[1];
      let pinned: boolean;
      if (options === undefined) pinned = false;
      else if (Node.isObjectLiteralExpression(options))
        pinned =
          options.getProperties().some((p) => Node.isSpreadAssignment(p)) ||
          options.getProperty('apiVersion') !== undefined;
      else pinned = mentionsPin;
      if (pinned) continue;
      const end = node.getEnd();
      found.push({
        file,
        line,
        column: node.getStart() - node.getStartLinePos() + 1,
        endLine: ast.getLineAndColumnAtPos(end).line,
        endColumn: ast.getLineAndColumnAtPos(end).column,
        snippet: (source.split('\n')[line - 1] ?? '').trim(),
      });
    }
  }
  return found;
}
/**
 * `api_version: "2026-07-29.dahlia"` inside payload objects: webhook fixtures and recorded
 * events. They mirror what the endpoint is configured to send, so an SDK upgrade must not
 * rewrite them; the PR lists them as a decision instead.
 */
export function payloadApiVersions(
  root: string,
  workspaces: string[],
): { file: string; line: number; value: string }[] {
  const found: { file: string; line: number; value: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (SOURCE.test(entry.name)) {
        const lines = readFileSync(path, 'utf8').split('\n');
        lines.forEach((text, i) => {
          const m = /\bapi_version["']?\s*:\s*["'](\d{4}-\d{2}-\d{2}(?:\.[\w-]+)?)["']/.exec(text);
          if (m?.[1]) found.push({ file: relative(root, path), line: i + 1, value: m[1] });
        });
      }
    }
  };
  for (const workspace of workspaces) {
    // A root workspace would walk the others again.
    if (workspace === '.' && workspaces.length > 1) continue;
    try {
      walk(join(root, workspace));
    } catch {
      // An unreadable directory has nothing to report.
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
/**
 * Tests that assert the old value of the constant an API-version site declares:
 * `expect(STRIPE_API_VERSION).toBe("2026-07-29.dahlia")`. The assertion is about the
 * constant, so it follows the constant. Payload `api_version` values are a different thing
 * and are never touched here.
 */
export function pinAssertions(
  root: string,
  workspaces: string[],
  declaration: string,
  versions: { from: string; to: string },
): FollowUp[] {
  const name = /\bconst\s+([A-Za-z_$][\w$]*)\b[^=]*=\s*["'`]/.exec(declaration)?.[1];
  if (!name || !declaration.includes(versions.from)) return [];
  const escaped = versions.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assertion = new RegExp(
    `(\\bexpect\\(\\s*${name}\\s*\\)\\s*\\.\\s*(?:toBe|toEqual|toStrictEqual)\\(\\s*["'\`])${escaped}(["'\`]\\s*\\))`,
  );
  const found: FollowUp[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (SOURCE.test(entry.name)) {
        readFileSync(path, 'utf8')
          .split('\n')
          .forEach((text, i) => {
            if (!assertion.test(text)) return;
            found.push({
              file: relative(root, path),
              line: i + 1,
              before: text,
              after: text.replace(assertion, `$1${versions.to}$2`),
              reason: `the assertion on \`${name}\` follows the constant to ${versions.to}`,
            });
          });
      }
    }
  };
  for (const workspace of workspaces) {
    if (workspace === '.' && workspaces.length > 1) continue;
    try {
      walk(join(root, workspace));
    } catch {
      // An unreadable directory has nothing to follow.
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
/**
 * Other SDK clients pinned to the old version by a repeated literal:
 * `new Stripe(key, { apiVersion: "2026-07-29.dahlia" })` in a test. They stand for the same
 * client the application configures, so they use the application's constant: importing it
 * (when it is exported) means the next bump does not break them again. `api_version` in a
 * payload is a different property and is never matched.
 */
export function clientPins(
  root: string,
  workspaces: string[],
  site: { file: string; declaration: string },
  versions: { from: string; to: string },
): FollowUp[] {
  const name = /\bconst\s+([A-Za-z_$][\w$]*)\b[^=]*=\s*["'`]/.exec(site.declaration)?.[1];
  if (!name || !site.declaration.includes(versions.from)) return [];
  const exported = /^\s*export\s+const\b/.test(site.declaration);
  const escaped = versions.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const literal = new RegExp(`(\\bapiVersion\\s*:\\s*)(["'\`])${escaped}\\2`);
  const found: FollowUp[] = [];
  const visit = (path: string): void => {
    const file = relative(root, path);
    if (file === site.file) return;
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    const hits = lines.flatMap((line, i) => (literal.test(line) ? [i] : []));
    if (hits.length === 0) return;
    const imported = new RegExp(`\\bimport\\b[^;]*\\b${name}\\b`).test(text);
    const importEdit =
      exported && !imported ? importOf(name, path, join(root, site.file), lines) : undefined;
    hits.forEach((i, n) => {
      const before = lines[i] as string;
      found.push({
        file,
        line: i + 1,
        before,
        after: exported
          ? before.replace(literal, `$1${name}`)
          : before.replace(literal, `$1$2${versions.to}$2`),
        reason: exported
          ? `this client uses \`${name}\` instead of repeating the API version`
          : `this client follows the API version to ${versions.to}`,
        ...(n === 0 && importEdit ? { also: [importEdit] } : {}),
      });
    });
  };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (SOURCE.test(entry.name)) visit(path);
    }
  };
  for (const workspace of workspaces) {
    if (workspace === '.' && workspaces.length > 1) continue;
    try {
      walk(join(root, workspace));
    } catch {
      // An unreadable directory has nothing to follow.
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** An import of `name` written the way the file writes its own: quotes, semicolon, extension. */
function importOf(
  name: string,
  file: string,
  target: string,
  lines: string[],
): { line: number; before: string; after: string } | undefined {
  const source = new Project({ useInMemoryFileSystem: true }).createSourceFile(
    'file.ts',
    lines.join('\n'),
  );
  const imports = source.getImportDeclarations();
  const last = imports.at(-1);
  if (!last) return undefined;
  const relatives = imports.filter((d) => d.getModuleSpecifierValue().startsWith('.'));
  const sample = (relatives[0] ?? last).getText();
  const quote = sample.includes("'") ? "'" : '"';
  const semicolon = sample.trimEnd().endsWith(';') ? ';' : '';
  const style = relatives[0]?.getModuleSpecifierValue() ?? '';
  let specifier = relative(dirname(file), target).split('\\').join('/');
  if (!specifier.startsWith('.')) specifier = `./${specifier}`;
  specifier = specifier.replace(/\.[cm]?tsx?$/, /\.[cm]?js$/.test(style) ? '.js' : '');
  const statement = `import { ${name} } from ${quote}${specifier}${quote}${semicolon}`;
  // Next to the file's other relative imports: parents before siblings, the usual order.
  const first = relatives[0];
  if (first && specifier.startsWith('../') && !first.getModuleSpecifierValue().startsWith('../')) {
    const at = first.getStartLineNumber();
    const before = lines[at - 1] as string;
    return { line: at, before, after: `${statement}\n${before}` };
  }
  const anchor = (relatives.at(-1) ?? last).getEndLineNumber();
  const before = lines[anchor - 1] as string;
  return { line: anchor, before, after: `${before}\n${statement}` };
}
export async function stripeUsageContext(root: string, workspaces: string[], version: string) {
  const typescriptAdapter = createTypescriptAdapter();
  const paths = new Set<string>(),
    events = new Set<string>();
  const evidence: MigrationEvidence[] = [];
  for (const workspace of workspaces) {
    const repo = { dir: join(root, workspace) };
    const surface = await typescriptAdapter.installedSurface(repo, 'stripe', version);
    if (!surface) continue;
    const scan = await typescriptAdapter.findUsages(repo, 'stripe', surface);
    const found = stripeEvidence(root, workspace, scan.usages);
    for (const path of found.usagePaths) paths.add(path);
    for (const event of found.eventTypes) events.add(event);
    evidence.push(...found.evidence);
  }
  return {
    usagePaths: [...paths],
    eventTypes: [...events],
    evidence: [...new Map(evidence.map((e) => [JSON.stringify(e), e])).values()],
  };
}

/**
 * Test fixtures that still shape a subscription the old way: `current_period_start/end` on
 * the subscription, items without them. The migrated code reads the items, so such a test
 * fails on the migration, not on a bug. Each single-line item literal gains the two fields
 * with the same initializers. The subscription-level ones stay: a webhook from an endpoint
 * on an older API version still carries them.
 */
export function periodFixtureEdits(root: string, file: string): FollowUp[] {
  let text: string;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    return [];
  }
  if (!/current_period_(?:start|end)/.test(text)) return [];
  const lines = text.split('\n');
  const ast = new Project({ useInMemoryFileSystem: true }).createSourceFile('fixture.ts', text);
  const edits: FollowUp[] = [];
  const seen = new Set<number>();
  for (const literal of ast.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const start = literal.getProperty('current_period_start');
    const end = literal.getProperty('current_period_end');
    const items = literal.getProperty('items');
    if (!start || !end) continue;
    if (!Node.isPropertyAssignment(start) || !Node.isPropertyAssignment(end)) continue;
    if (!items) {
      // A partial fixture with only the old fields: it gains the one item that carries them,
      // on a line of its own after the last of the two, when each property has its own line.
      const last = start.getStartLineNumber() > end.getStartLineNumber() ? start : end;
      const line = last.getEndLineNumber();
      const before = lines[line - 1] as string;
      if (last.getStartLineNumber() !== line || seen.has(line)) continue;
      if (literal.getStartLineNumber() === line || literal.getEndLineNumber() === line) continue;
      seen.add(line);
      const indent = /^\s*/.exec(before)?.[0] ?? '';
      const kept = /,\s*(?:\/\/.*)?$/.test(before) ? before : before.replace(/\s*$/, ',');
      edits.push({
        file,
        line,
        before,
        after: `${kept}\n${indent}items: { data: [{ current_period_start: ${start.getInitializer()?.getText() ?? '0'}, current_period_end: ${end.getInitializer()?.getText() ?? '0'} }] },`,
        reason:
          'the fixture now carries the billing period on an item, where the API puts it since 2025-03-31.basil; the migrated code reads it there',
        rule: 'subscription-period',
      });
      continue;
    }
    if (!Node.isPropertyAssignment(items)) continue;
    const bag = items.getInitializer();
    if (!bag || !Node.isObjectLiteralExpression(bag)) continue;
    const data = bag.getProperty('data');
    const list = data && Node.isPropertyAssignment(data) ? data.getInitializer() : undefined;
    if (!list || !Node.isArrayLiteralExpression(list)) continue;
    for (const item of list.getElements()) {
      if (!Node.isObjectLiteralExpression(item)) continue;
      if (item.getProperty('current_period_end')) continue;
      const line = item.getStartLineNumber();
      if (item.getEndLineNumber() !== line || seen.has(line)) continue;
      seen.add(line);
      const before = lines[line - 1] as string;
      const close = before.lastIndexOf('}', item.getEnd() - item.getStartLinePos());
      if (close < 0) continue;
      const head = before.slice(0, close).replace(/,?\s*$/, '');
      const fields = `current_period_start: ${start.getInitializer()?.getText() ?? '0'}, current_period_end: ${end.getInitializer()?.getText() ?? '0'}`;
      const body = head.endsWith('{') ? `${head} ${fields} ` : `${head}, ${fields} `;
      edits.push({
        file,
        line,
        before,
        after: `${body}${before.slice(close)}`,
        reason:
          'the fixture now carries the billing period on its item, where the API puts it since 2025-03-31.basil; the migrated code reads it there',
        rule: 'subscription-period',
      });
    }
  }
  return edits;
}

/**
 * `declaration` inserted above the top-level statement that contains `line`, and above that
 * statement's own leading comment block: a doc comment stays attached to its function, and
 * the helper does not inherit it. Undefined when the line is in no top-level statement.
 */
export function aboveDeclaration(
  text: string,
  line: number,
  declaration: string,
): { text: string; line: number } | undefined {
  const ast = new Project({ useInMemoryFileSystem: true }).createSourceFile('home.ts', text);
  const statement = ast
    .getStatements()
    .find((s) => s.getStartLineNumber() <= line && line <= s.getEndLineNumber());
  if (!statement || Node.isImportDeclaration(statement)) return undefined;
  const lines = text.split('\n');
  // `getStartLineNumber` skips JSDoc; line comments directly above belong to it as well.
  let at = statement.getStartLineNumber(true);
  while (at > 1 && /^\s*(?:\/\/|\/\*|\*)/.test(lines[at - 2] as string)) at--;
  lines.splice(at - 1, 0, ...declaration.split('\n'), '');
  return { text: lines.join('\n'), line: at };
}

/**
 * Where `subscriptionPeriod` lives so every migrated file imports one copy: the module that
 * creates the Stripe client (`new Stripe(...)`) in a workspace the other site workspaces
 * depend on through `workspace:`, with its name re-exported through the package's barrels
 * when they export by name. Each workspace gets the specifier it already uses for that
 * package, or a relative path inside the helper's own workspace.
 */
export function sharedPeriodHelper(
  root: string,
  workspaces: string[],
  findings: Finding[],
  declaration: string,
): { helper: SharedHelper; edits: { file: string; text: string; line?: number }[] } | undefined {
  const name = 'subscriptionPeriod';
  const periodSites = findings.filter((f) => /current_period_(?:start|end)/.test(f.change.path));
  if (periodSites.length === 0) return undefined;
  const ownerOf = (file: string): string | undefined =>
    workspaces
      .filter((w) => w === '.' || file.startsWith(`${w}/`))
      .sort((a, b) => b.length - a.length)[0];
  const siteWorkspaces = [...new Set(periodSites.map((f) => ownerOf(f.usage.file) ?? '.'))];
  const manifestOf = (w: string): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(join(root, w, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      return {};
    }
  };
  const dependsOn = (w: string, pkg: string): boolean =>
    ['dependencies', 'devDependencies'].some((s) => {
      const spec = (manifestOf(w)[s] as Record<string, string> | undefined)?.[pkg];
      return typeof spec === 'string' && /^(?:workspace|link|file):/.test(spec);
    });
  // The client module: a `new Stripe(` site in a workspace every site workspace can reach.
  const clients = findings.filter((f) =>
    /^new Stripe\(|= new Stripe\(|\? new Stripe\(/.test(f.usage.snippet.trim()),
  );
  const candidates = [...new Set(clients.map((f) => f.usage.file))]
    .map((file) => ({ file, workspace: ownerOf(file) ?? '.' }))
    .filter(({ workspace }) => {
      const pkg = manifestOf(workspace).name;
      return siteWorkspaces.every(
        (w) => w === workspace || (typeof pkg === 'string' && dependsOn(w, pkg)),
      );
    });
  // No client module every site can reach: when the sites share one workspace, the helper
  // goes in the file of the first site, above the function that reads the period.
  const first = [...periodSites].sort(
    (x, y) => x.usage.file.localeCompare(y.usage.file) || x.usage.line - y.usage.line,
  )[0] as Finding;
  const inPlace = !candidates[0] && siteWorkspaces.length === 1;
  const home =
    candidates[0] ??
    (inPlace ? { file: first.usage.file, workspace: siteWorkspaces[0] as string } : undefined);
  if (!home) return undefined;
  let text: string;
  try {
    text = readFileSync(join(root, home.file), 'utf8');
  } catch {
    return undefined;
  }
  if (new RegExp(`\\bfunction ${name}\\b`).test(text)) return undefined;
  const placed = inPlace
    ? aboveDeclaration(text, first.usage.line, declaration)
    : { text: `${text.replace(/\s*$/, '\n')}\n${declaration}\n`, line: text.split('\n').length };
  if (!placed) return undefined;
  const edits: { file: string; text: string; line?: number }[] = [
    { file: home.file, text: placed.text, line: placed.line },
  ];
  // Barrels that export this module by name: the name joins them. `export *` needs nothing.
  for (
    let dir = dirname(join(root, home.file));
    dir.startsWith(join(root, home.workspace));
    dir = dirname(dir)
  ) {
    for (const index of ['index.ts', 'index.tsx', 'index.mts']) {
      const barrel = join(dir, index);
      if (!existsSync(barrel) || barrel === join(root, home.file)) continue;
      const source = readFileSync(barrel, 'utf8');
      const relativeModule = relative(dir, join(root, home.file)).replace(/\.[cm]?[jt]sx?$/, '');
      const named = new RegExp(
        `export\\s*\\{([^}]*)\\}\\s*from\\s*(["'])\\.\\/${relativeModule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.[cm]?[jt]sx?|\\.js)?\\2`,
      );
      const m = named.exec(source);
      if (!m) continue;
      if (m[1]?.includes(name)) break;
      const inner = (m[1] as string).replace(/\s*$/, '');
      const joined = inner.endsWith(',')
        ? `${inner} ${name} `
        : `${inner.trim() ? `${inner}, ` : ' '}${name} `;
      edits.push({
        file: relative(root, barrel),
        text: source.replace(m[0], m[0].replace(m[1] as string, joined)),
      });
    }
    if (dir === join(root, home.workspace)) break;
  }
  const specifiers: Record<string, string> = {};
  const pkg = manifestOf(home.workspace).name;
  for (const w of siteWorkspaces) {
    if (w === home.workspace) {
      const from = periodSites.find((f) => ownerOf(f.usage.file) === w)?.usage.file ?? home.file;
      const rel = relative(dirname(from), home.file).replace(/\.[cm]?[jt]sx?$/, '');
      specifiers[w] = `${rel.startsWith('.') ? rel : `./${rel}`}.ts`;
    } else if (typeof pkg === 'string') specifiers[w] = pkg;
  }
  return { helper: { name, file: home.file, specifiers }, edits };
}

/**
 * A test that mocks the helper's module wholesale (`vi.mock("@acme/core", () => ({...}))`)
 * fails once the migrated code imports the helper from it: the mock has no such export. The
 * factory then starts from the real module and keeps overriding what it overrode before, the
 * partial mock vitest documents. Only mocks the runner named as missing the export are touched.
 */
export function mockFollowUps(
  root: string,
  file: string,
  output: string,
  name: string,
): FollowUp[] {
  const missing = new Set(
    [...output.matchAll(/No "(\w+)" export is defined on the "([^"]+)" mock/g)]
      .filter((m) => m[1] === name)
      .map((m) => m[2] as string),
  );
  if (missing.size === 0) return [];
  let text: string;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    return [];
  }
  const edits: FollowUp[] = [];
  text.split('\n').forEach((line, i) => {
    const m = /^(\s*)vi\.mock\((["'])([^"']+)\2,\s*\(\)\s*=>\s*\(\{\s*$/.exec(line);
    if (!m || !missing.has(m[3] as string)) return;
    const [, indent, quote, specifier] = m as unknown as [string, string, string, string];
    edits.push({
      file,
      line: i + 1,
      before: line,
      after: `${indent}vi.mock(${quote}${specifier}${quote}, async (importOriginal) => ({\n${indent}  ...(await importOriginal<typeof import(${quote}${specifier}${quote})>()),`,
      reason: `the test mocks ${specifier} wholesale and the migrated code now imports ${name} from it; the mock starts from the real module and overrides what it did before`,
      rule: 'subscription-period',
    });
  });
  return edits;
}
