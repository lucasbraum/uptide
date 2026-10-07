import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CallExpression,
  type Expression,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
  ts,
} from 'ts-morph';
import type { Finding } from '../../domain/report.js';
import { satisfies } from '../../fetch/range.js';
import { onReset } from '../../shared-state.js';
import type { Pack, PackMeta } from '../contract.js';
import type { PackContext, TransformResult } from '../types.js';
import { zodGuide } from './guide.js';
import { defaultMessageSites } from './messages.js';

const params: Record<string, number> = {
  string: 0,
  number: 0,
  boolean: 0,
  bigint: 0,
  date: 0,
  symbol: 0,
  undefined: 0,
  null: 0,
  void: 0,
  any: 0,
  unknown: 0,
  never: 0,
  enum: 1,
  nativeEnum: 1,
  object: 1,
  strictObject: 1,
  literal: 1,
  array: 1,
  tuple: 1,
  union: 1,
  discriminatedUnion: 2,
  record: 2,
  map: 2,
  set: 1,
};
const formats = new Set(['email', 'uuid', 'url', 'base64', 'datetime']);
interface Edit {
  start: number;
  end: number;
  text: string;
}
function edit(text: string, changes: Edit[]): string {
  for (const c of changes.sort((a, b) => b.start - a.start))
    text = text.slice(0, c.start) + c.text + text.slice(c.end);
  return text;
}
function namespace(node: Expression): boolean {
  if (!Node.isIdentifier(node)) return false;
  const declaration = node.getSymbol()?.getDeclarations()[0];
  const imported = declaration?.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
  if (!imported || !/^zod(?:\/v3)?$/.test(imported.getModuleSpecifierValue())) return false;
  return (
    Node.isNamespaceImport(declaration) ||
    Node.isImportClause(declaration) ||
    (Node.isImportSpecifier(declaration) && declaration.getName() === 'z')
  );
}
function factory(call: CallExpression): string | undefined {
  const expression = call.getExpression();
  if (Node.isPropertyAccessExpression(expression)) {
    const receiver = expression.getExpression();
    if (
      namespace(receiver) ||
      (Node.isPropertyAccessExpression(receiver) &&
        receiver.getName() === 'coerce' &&
        namespace(receiver.getExpression()))
    )
      return expression.getName();
  }
  if (Node.isIdentifier(expression)) {
    const declaration = expression.getSymbol()?.getDeclarations()[0];
    if (
      declaration &&
      Node.isImportSpecifier(declaration) &&
      /^zod(?:\/v3)?$/.test(declaration.getImportDeclaration().getModuleSpecifierValue())
    )
      return declaration.getName();
  }
  return undefined;
}
function errorTransform(text: string, call: CallExpression): TransformResult | undefined {
  const name = factory(call);
  if (name === undefined || params[name] === undefined) return;
  const argument = call.getArguments()[params[name] as number];
  if (!argument || !Node.isObjectLiteralExpression(argument)) return;
  const properties = argument.getProperties();
  const required = argument.getProperty('required_error');
  const invalid = argument.getProperty('invalid_type_error');
  if (!required && !invalid) return;
  const skip = (reason: string) => ({ text, applied: false, reason });
  if (argument.getProperty('error') || argument.getProperty('errorMap'))
    return skip('existing error/errorMap needs manual merging');
  if (
    properties.some(
      (p) =>
        Node.isSpreadAssignment(p) ||
        (Node.isPropertyAssignment(p) && Node.isComputedPropertyName(p.getNameNode())),
    )
  )
    return skip('spread or computed params need manual review');
  if (
    (required && !Node.isPropertyAssignment(required)) ||
    (invalid && !Node.isPropertyAssignment(invalid))
  )
    return skip('non-property error option needs manual review');
  const req =
    required && Node.isPropertyAssignment(required) ? required.getInitializer() : undefined;
  const inv = invalid && Node.isPropertyAssignment(invalid) ? invalid.getInitializer() : undefined;
  const a = req?.getText() ?? 'undefined';
  const b = inv?.getText() ?? 'undefined';
  const literal = (n: Node | undefined) =>
    !n || Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n);
  const value = `(iss) => iss.input === undefined ? ${a} : ${b}`;
  if (!literal(req) || !literal(inv)) {
    // Evaluate the original object intact: other initializers may observe side effects too.
    const capture = `(<T extends { required_error?: string; invalid_type_error?: string }>(options: T) => { const { required_error, invalid_type_error, ...rest } = options; return { ...rest, error: (iss: { input: unknown }) => iss.input === undefined ? required_error : invalid_type_error }; })(${argument.getText()})`;
    return {
      text: edit(text, [{ start: argument.getStart(), end: argument.getEnd(), text: capture }]),
      applied: true,
      rule: 'error-params',
      reason: 'capture error expressions and other options in original evaluation order',
    };
  }
  const first = [required, invalid]
    .filter((p): p is NonNullable<typeof p> => !!p)
    .sort((x, y) => x.getStart() - y.getStart())[0];
  if (!first) return;
  const comments: string[] = [];
  for (const property of [required, invalid]
    .filter((p): p is NonNullable<typeof p> => !!p)
    .sort((x, y) => x.getStart() - y.getStart())) {
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      property.getText(),
    );
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      if (token === ts.SyntaxKind.SingleLineCommentTrivia)
        comments.push(`${scanner.getTokenText()}\n`);
      if (token === ts.SyntaxKind.MultiLineCommentTrivia)
        comments.push(`${scanner.getTokenText()} `);
    }
  }
  const changes: Edit[] = [
    { start: first.getStart(), end: first.getEnd(), text: `${comments.join('')}error: ${value}` },
  ];
  for (const p of [required, invalid]) {
    if (!p || p === first) continue;
    const comma = /^\s*,/.exec(text.slice(p.getEnd()));
    changes.push({ start: p.getStart(), end: p.getEnd() + (comma?.[0].length ?? 0), text: '' });
  }
  return {
    text: edit(text, changes),
    applied: true,
    rule: 'error-params',
    reason: 'preserve missing/invalid input messages with error',
  };
}
function formatTransform(text: string, call: CallExpression): TransformResult | undefined {
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression) || !formats.has(expression.getName())) return;
  const root = expression.getExpression();
  if (
    !Node.isCallExpression(root) ||
    factory(root) !== 'string' ||
    root.getArguments().length !== 0
  )
    return {
      text,
      applied: false,
      reason: 'format chain is not directly rooted at z.string() without options',
    };
  const rootExpression = root.getExpression();
  if (
    !Node.isPropertyAccessExpression(rootExpression) ||
    !namespace(rootExpression.getExpression())
  )
    return { text, applied: false, reason: 'format migration requires a zod namespace binding' };
  if (/\/\*|\/\//.test(text.slice(root.getStart(), expression.getEnd())))
    return {
      text,
      applied: false,
      reason: 'comments inside the format receiver require manual placement',
    };
  const name = expression.getName() === 'datetime' ? 'iso.datetime' : expression.getName();
  const changes: Edit[] = [
    {
      start: expression.getStart(),
      end: expression.getEnd(),
      text: `${rootExpression.getExpression().getText()}.${name}`,
    },
  ];
  for (const argument of call.getArguments()) {
    if (!Node.isObjectLiteralExpression(argument)) continue;
    const message = argument.getProperty('message');
    if (message && Node.isPropertyAssignment(message)) {
      if (argument.getProperty('error'))
        return { text, applied: false, reason: 'both message and error require manual review' };
      changes.push({
        start: message.getNameNode().getStart(),
        end: message.getNameNode().getEnd(),
        text: 'error',
      });
    }
  }
  return {
    text: edit(text, changes),
    applied: true,
    rule: 'string-format',
    reason: 'use top-level format factory, preserving arguments and subsequent chain',
  };
}
/**
 * The transform never mutates the tree (edits are string splices), so one parse serves every
 * finding of a file. `check` dry-runs each site against the same text; without this, a plan
 * of a hundred sites paid for a hundred parses.
 */
const parsed = new Map<string, SourceFile>();
onReset(() => parsed.clear());
function parse(text: string): SourceFile {
  let source = parsed.get(text);
  if (!source) {
    source = new Project({ useInMemoryFileSystem: true }).createSourceFile('consumer.ts', text);
    if (parsed.size >= 16) parsed.delete(parsed.keys().next().value as string);
    parsed.set(text, source);
  }
  return source;
}
/** Runs `each` on the calls around the reported site, innermost first, until one answers. */
function atSite(
  text: string,
  finding: Finding,
  each: (call: CallExpression) => TransformResult | undefined,
): TransformResult {
  const source = parse(text);
  const lines = text.split('\n');
  const offset =
    lines.slice(0, finding.usage.line - 1).reduce((n, l) => n + l.length + 1, 0) +
    finding.usage.column -
    1;
  const calls = source
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((c) => c.getStart() <= offset && c.getEnd() >= offset)
    .sort((a, b) => a.getWidth() - b.getWidth());
  for (const call of calls) {
    const result = each(call);
    if (result) return result;
  }
  return { text, applied: false, reason: 'no safe mechanical transform for this reported site' };
}
function transform(text: string, finding: Finding, context: PackContext): TransformResult {
  if (!zodPack.supports(context.from, context.to))
    return { text, applied: false, reason: 'pack supports zod 3 to 4 only' };
  const rule = zodPack.rules.find(
    (r) => r.kinds.includes(finding.change.kind) && r.symbols.test(finding.change.path),
  );
  if (!rule?.rewrite)
    return { text, applied: false, reason: 'no mechanical rule for this change kind and symbol' };
  return rule.rewrite(text, finding, context);
}
const meta: PackMeta = {
  package: 'zod',
  from: '>=3 <4',
  to: '>=4 <5',
  sources: [
    { title: 'Zod 4 migration guide', url: 'https://zod.dev/v4/changelog' },
    { title: 'Zod 4 release notes', url: 'https://zod.dev/v4' },
  ],
  maintainer: 'uptide-dev',
};
export const zodPack: Pack = {
  name: 'zod',
  meta,
  defaultTarget: '4.6.5',
  supports: (from, to) => satisfies(from, meta.from) && satisfies(to, meta.to),
  rules: [
    {
      id: 'error-params',
      summary: 'required_error and invalid_type_error become one error callback',
      severity: 'breaking',
      kinds: ['signature', 'type', 'required'],
      symbols:
        /string|number|boolean|bigint|date|symbol|undefined|null|void|any|unknown|never|enum|object|literal|array|tuple|union|record|map|set|TS(?:2353|2769|2345)/,
      guide: zodGuide.errors,
      rewrite: (text, finding) => atSite(text, finding, (call) => errorTransform(text, call)),
    },
    {
      id: 'string-format',
      summary: 'z.string().email() and the other formats move to top-level factories',
      severity: 'deprecated',
      kinds: ['deprecated'],
      symbols: /#(email|uuid|url|base64|datetime)$/,
      guide: zodGuide.formats,
      rewrite: (text, finding, context) =>
        atSite(text, finding, (call) =>
          context.includeDeprecated ? formatTransform(text, call) : undefined,
        ),
    },
    {
      id: 'ip',
      summary: 'z.string().ip() was removed: z.ipv4(), z.ipv6() or their union',
      severity: 'breaking',
      kinds: ['removed'],
      symbols: /#ip$/,
      guide: zodGuide.ip,
    },
    {
      id: 'types',
      summary: 'ZodType generics and ZodTypeDef changed; type-level code is migrated by the agent',
      severity: 'breaking',
      kinds: ['type', 'signature', 'removed', 'narrowed', 'cause'],
      symbols: /./,
      guide: zodGuide.generics,
      perFile: true,
    },
  ],
  behavior: [
    {
      id: 'default-messages',
      summary:
        'Zod 4 words its default error messages differently; code and tests matching the old text keep compiling',
      reported: ['decision', 'test-follow-up'],
    },
  ],
  instructions: zodGuide.generics,
  transform,
  guide: (f) =>
    zodPack.rules.find((r) => r.kinds.includes(f.change.kind) && r.symbols.test(f.change.path))
      ?.guide ?? zodGuide.generics,
  scanContext: (root, workspaces) => ({ defaultMessages: defaultMessageSites(root, workspaces) }),
  testFollowUps({ root, failing, context, output }) {
    const edits = [];
    // The whole zod 4 sentences the runner printed ("Received: ..."): they name the type,
    // which the scan cannot know.
    const printed = [
      ...new Set((output ?? '').match(/Invalid input: expected [\w ]+?, received \w+/g) ?? []),
    ];
    for (const site of context.defaultMessages ?? []) {
      if (site.replacement === undefined) continue;
      if (!failing.some((f) => site.file === f || site.file.endsWith(`/${f}`))) continue;
      let before: string | undefined;
      try {
        before = readFileSync(join(root, site.file), 'utf8').split('\n')[site.line - 1];
      } catch {
        continue;
      }
      if (before === undefined || !before.includes(site.text)) continue;
      // `stringContaining("received undefined")` holds for any type. An exact matcher
      // (`toBe`, `toEqual`) needs the whole sentence: it is taken from the failure when
      // exactly one was printed, and otherwise the assertion is left for a person.
      const partial = /\b(?:stringContaining|stringMatching|toContain|toMatch|toThrow)\(/.test(
        before,
      );
      const whole = printed.filter((sentence) => sentence.endsWith(site.replacement as string));
      if (!partial && whole.length !== 1) continue;
      const replacement = partial ? site.replacement : (whole[0] as string);
      edits.push({
        file: site.file,
        line: site.line,
        before,
        after: before.replace(site.text, replacement),
        reason: `zod 4 says "${site.now}" where zod 3 said "${site.text}"; the assertion follows`,
      });
    }
    return edits;
  },
  decisions(context, _rules, followed = []) {
    const lines: string[] = [];
    const updated = followed.filter((f) => f.rule === 'default-messages');
    const literal = (text: string) => /(["'`])((?:\\.|(?!\1).)*)\1/.exec(text)?.[0];
    if (updated.length)
      lines.push(
        `- Zod 4 words its default error messages differently, and a test of the migrated code failed on it. Updated ${updated.length} assertion${updated.length === 1 ? '' : 's'}: ${updated
          .map((u) => {
            const site = context.defaultMessages?.find(
              (d) => d.file === u.file && d.line === u.line,
            );
            // What was written: the whole sentence for an exact matcher, else the fragment.
            const whole = /Invalid input: expected [\w ]+?, received \w+/.exec(u.after)?.[0];
            const written = whole ?? site?.replacement ?? literal(u.after) ?? '';
            return `\`${u.file}:${u.line}\` \`"${site?.text ?? literal(u.before) ?? ''}"\` → \`"${written}"\`${site && !whole ? ` (zod 4 says "${site.now}")` : ''}`;
          })
          .join(
            '; ',
          )}. Confirm that nothing outside the tests reads this text: logs, alerts, dead-letter descriptions, API responses.`,
      );
    const rest = (context.defaultMessages ?? []).filter(
      (d) => !updated.some((u) => u.file === d.file && u.line === d.line),
    );
    if (rest.length)
      lines.push(
        `- ${rest.length} other place${rest.length === 1 ? ' depends' : 's depend'} on a zod default message, which zod 4 words differently, and ${rest.length === 1 ? 'was' : 'were'} not changed: ${rest
          .slice(0, 8)
          .map((d) => `\`${d.file}:${d.line}\` \`"${d.text}"\``)
          .join('; ')}${rest.length > 8 ? `; and ${rest.length - 8} more` : ''}.`,
      );
    return lines;
  },
  reviewNotes: () => [
    'Review validation behaviour and custom messages; compilation alone cannot prove runtime equivalence.',
    'Migration reference: https://zod.dev/v4/changelog',
  ],
};
