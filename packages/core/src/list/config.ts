import { basename } from 'node:path';
import { ts } from 'ts-morph';
import { parseDocument } from 'yaml';

export interface TaskCommands {
  text: string;
  reason: string;
}
const TOOL_FILES: [RegExp, string][] = [
  [/^\.huskyrc(?:\..+)?$/, 'husky'],
  [/^(?:\.lintstagedrc(?:\..+)?|lint-staged\.config\..+)$/, 'lint-staged'],
  [/^(?:\.prettierrc.*|prettier\.config\..+)$/, 'prettier'],
  [/^(?:\.eslintrc.*|eslint\.config\..+)$/, 'eslint'],
  [/^(?:\.stylelintrc.*|stylelint\.config\..+)$/, 'stylelint'],
  [/^(?:\.babelrc(?:\..+)?|babel\.config\..+)$/, '@babel/core'],
  [/^(?:\.commitlintrc(?:\..+)?|commitlint\.config\..+)$/, '@commitlint/cli'],
  [/^\.czrc(?:\..+)?$/, 'commitizen'],
  [/^(?:\.standard(?:rc)?(?:\..+)?|standard\.config\..+)$/, 'standard'],
  [
    /^(?:\.simple-git-hooksrc(?:\..+)?|\.?simple-git-hooks(?:\.config)?\.(?:[cm]?js|json|ya?ml))$/,
    'simple-git-hooks',
  ],
];
export const configConsumers = (file: string): string[] =>
  TOOL_FILES.filter(([pattern]) => pattern.test(basename(file))).map(([, name]) => name);

/** Only literal values: never execute JS configs, YAML tags or command substitutions. */
export function stringValues(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((child) => stringValues(child, seen));
}
export function manifestCommands(manifest: Record<string, unknown>): TaskCommands[] {
  const husky = manifest.husky;
  const hooks = husky && typeof husky === 'object' && 'hooks' in husky ? husky.hooks : undefined;
  return [
    {
      text: stringValues(hooks).join('\n'),
      reason: 'hook/task command in package.json husky.hooks',
    },
    {
      text: lintStaged(manifest['lint-staged']).commands.join('\n'),
      reason: 'lint-staged command',
    },
    {
      text: stringValues(manifest['simple-git-hooks']).join('\n'),
      reason: 'hook/task command in package.json simple-git-hooks',
    },
  ].filter((entry) => entry.text);
}
const KARMA_PACKAGES: Record<string, string[]> = {
  jasmine: ['karma-jasmine', 'jasmine-core'],
  webpack: ['karma-webpack'],
  coverage: ['karma-coverage'],
  spec: ['karma-spec-reporter'],
  Chrome: ['karma-chrome-launcher'],
  ChromeHeadless: ['karma-chrome-launcher'],
  sourcemap: ['karma-sourcemap-loader'],
};
function karmaEvidence(
  file: string,
  text: string,
  names: string[],
  add: (name: string, reason: string) => void,
): void {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const objects: ts.ObjectLiteralExpression[] = [];
  const candidates: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'set'
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isObjectLiteralExpression(argument)) objects.push(argument);
    }
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          ['frameworks', 'reporters', 'browsers', 'preprocessors', 'plugins'].includes(
            p.name.getText(source).replace(/['"]/g, ''),
          ),
      )
    )
      candidates.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const configs = objects.length ? objects : candidates;
  const strings = (node: ts.Node): string[] => {
    if (ts.isStringLiteralLike(node)) return [node.text];
    const result: string[] = [];
    // Keys in preprocessors/customLaunchers are not plugin names.
    if (ts.isPropertyAssignment(node)) return strings(node.initializer);
    ts.forEachChild(node, (child) => {
      result.push(...strings(child));
    });
    return result;
  };
  for (const config of configs) {
    let hasPlugins = false;
    for (const property of config.properties) {
      if (!property.name) continue;
      const key = property.name.getText(source).replace(/['"]/g, '');
      if (key === 'plugins') hasPlugins = true;
      if (
        !ts.isPropertyAssignment(property) ||
        ![
          'frameworks',
          'plugins',
          'reporters',
          'browsers',
          'preprocessors',
          'customLaunchers',
        ].includes(key)
      )
        continue;
      for (const token of strings(property.initializer)) {
        for (const name of KARMA_PACKAGES[token] ?? []) add(name, `Karma ${key}: ${token}`);
        if (token.startsWith('karma-')) {
          const pattern = new RegExp(
            `^${token
              .split('*')
              .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('.*')}$`,
          );
          for (const name of names.filter((name) => pattern.test(name)))
            add(name, `Karma ${key}: ${token}`);
        }
      }
    }
    if (!hasPlugins)
      for (const name of names.filter((name) => name.startsWith('karma-')))
        add(name, 'auto-loaded by Karma (plugins unset)');
  }
}

function literalTokens(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const values: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
    if (
      token === ts.SyntaxKind.StringLiteral ||
      token === ts.SyntaxKind.NoSubstitutionTemplateLiteral
    )
      values.push(scanner.getTokenValue());
  return values.join('\n');
}
/** Current glob maps and legacy v7-v9 linters maps. Ignore globs are never commands. */
export function lintStaged(value: unknown): { commands: string[]; ignores: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { commands: [], ignores: [] };
  const data = value as Record<string, unknown>;
  const linters = data.linters && typeof data.linters === 'object' ? data.linters : data;
  return {
    commands: Object.entries(linters)
      .filter(([key]) => key !== 'ignore')
      .flatMap(([, command]) =>
        typeof command === 'string'
          ? [command]
          : Array.isArray(command)
            ? command.filter((v): v is string => typeof v === 'string')
            : [],
      ),
    ignores: Array.isArray(data.ignore)
      ? data.ignore.filter((v): v is string => typeof v === 'string')
      : [],
  };
}
/** Literal exports only. Never import/execute repository JavaScript. */
export function configValue(file: string, text: string): unknown {
  if (!/\.[cm]?[jt]s$/.test(file)) {
    const document = parseDocument(text, { customTags: [], logLevel: 'silent' });
    try {
      return document.errors.length ? undefined : document.toJS({ maxAliasCount: 50 });
    } catch {
      return undefined;
    }
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, ts.Expression>();
  let exported: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      bindings.set(node.name.text, node.initializer);
    if (ts.isExportAssignment(node)) exported = node.expression;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(source) === 'module.exports'
    )
      exported = node.right;
    ts.forEachChild(node, visit);
  };
  visit(source);
  const seen = new Set<ts.Node>();
  const value = (node: ts.Expression | undefined): unknown => {
    if (!node || seen.has(node)) return undefined;
    seen.add(node);
    try {
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isIdentifier(node)) return value(bindings.get(node.text));
      if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node)
      )
        return value(node.expression);
      if (ts.isArrayLiteralExpression(node)) return node.elements.map(value);
      if (ts.isObjectLiteralExpression(node))
        return Object.fromEntries(
          node.properties.flatMap((p) =>
            ts.isPropertyAssignment(p)
              ? [[p.name.getText(source).replace(/^['"]|['"]$/g, ''), value(p.initializer)]]
              : [],
          ),
        );
      return undefined;
    } finally {
      seen.delete(node);
    }
  };
  return value(exported);
}
export function scanConfig(
  file: string,
  text: string,
  names: string[],
  evidence?: Map<string, string[]>,
  tasks?: TaskCommands[],
): string {
  const label = basename(file);
  const add = (name: string, reason: string): void => {
    if (!names.includes(name)) return;
    const reasons = evidence?.get(name) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    evidence?.set(name, reasons);
  };
  const consumers = configConsumers(file);
  for (const name of consumers) add(name, `config file ${label}`);
  let literals: string;
  if (consumers.includes('lint-staged')) {
    const config = lintStaged(configValue(file, text));
    literals = config.commands.join('\n');
    tasks?.push({ text: literals, reason: 'lint-staged command' });
  } else {
    if (/(?:^|\/)\.husky\//.test(file)) literals = text.replace(/^\s*#.*$/gm, '');
    else if (
      /\.(?:ya?ml|json)$/.test(label) ||
      /^\.[\w-]+rc$/.test(label) ||
      label === '.standard'
    ) {
      const value = configValue(file, text);
      literals =
        value === undefined && label.endsWith('.json')
          ? literalTokens(text)
          : stringValues(value).join('\n');
    } else literals = literalTokens(text);
    if (
      consumers.some((name) => ['husky', 'simple-git-hooks'].includes(name)) ||
      /(?:^|\/)\.husky\//.test(file)
    )
      tasks?.push({ text: literals, reason: `hook/task command in ${label}` });
  }
  if (/(?:^|\/)karma\.conf\.[^/]+$/.test(file)) karmaEvidence(file, text, names, add);
  return literals;
}
