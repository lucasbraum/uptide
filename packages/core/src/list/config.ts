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
    ...['lint-staged', 'simple-git-hooks'].map((field) => ({
      text: stringValues(manifest[field]).join('\n'),
      reason: `hook/task command in package.json ${field}`,
    })),
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
  if (/(?:^|\/)\.husky\//.test(file)) literals = text.replace(/^\s*#.*$/gm, '');
  else if (/\.(?:ya?ml|json)$/.test(label) || /^\.[\w-]+rc$/.test(label) || label === '.standard') {
    // JSON is a YAML subset. Unknown tags remain data; aliases have a bounded expansion.
    const document = parseDocument(text, { customTags: [], logLevel: 'silent' });
    try {
      literals = document.errors.length
        ? label.endsWith('.json')
          ? literalTokens(text)
          : ''
        : stringValues(document.toJS({ maxAliasCount: 50 })).join('\n');
    } catch {
      literals = '';
    }
  } else literals = literalTokens(text);

  if (
    consumers.some((name) => ['husky', 'lint-staged', 'simple-git-hooks'].includes(name)) ||
    /(?:^|\/)\.husky\//.test(file)
  )
    tasks?.push({ text: literals, reason: `hook/task command in ${label}` });
  if (/(?:^|\/)karma\.conf\.[^/]+$/.test(file)) karmaEvidence(file, text, names, add);
  return literals;
}
