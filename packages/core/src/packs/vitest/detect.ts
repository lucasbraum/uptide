import { Node, Project, type SourceFile, SyntaxKind } from 'ts-morph';
import type { Finding } from '../../domain/report.js';
import { onReset } from '../../shared-state.js';
import type { SourceSite } from '../contract.js';
import type { TransformResult } from '../types.js';

/**
 * Sites no type diff reports for vitest 4 → 5, found in the source of a file that uses the
 * package: what the compiler only sees through a global declaration, and what a config file
 * says as data.
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

function siteAt(source: SourceFile, node: Node, name: string): SourceSite {
  const { line, column } = source.getLineAndColumnAtPos(node.getStart());
  return { line, column, snippet: (source.getFullText().split('\n')[line - 1] ?? '').trim(), name };
}

const VITEST_MODULES = new Set(['vitest', '@vitest/expect']);

/**
 * A custom matcher declared the way Vitest 4 read it, so its types no longer reach `expect`:
 * `declare global { namespace jest { interface Matchers<R> { ... } } }` is not read at all in
 * Vitest 5, and `declare module 'vitest' { interface Assertion<T> }` or `Matchers<R>` must now
 * have the same two type parameters as Vitest's own (`Matchers<R, T>`). The site is the
 * declaration a person edits: the `declare global` block, or the interface.
 */
export function matcherAugmentationSites(text: string): SourceSite[] {
  if (!/\bMatchers\b|\bAssertion\b/.test(text)) return [];
  const source = parse(text);
  const sites: SourceSite[] = [];
  for (const block of source.getDescendantsOfKind(SyntaxKind.ModuleDeclaration)) {
    const name = block.getName();
    if (name === 'global') {
      const jest = block
        .getDescendantsOfKind(SyntaxKind.ModuleDeclaration)
        .find((m) => m.getName() === 'jest');
      const matchers = jest
        ?.getDescendantsOfKind(SyntaxKind.InterfaceDeclaration)
        .some((i) => i.getName() === 'Matchers');
      if (matchers) sites.push(siteAt(source, block, 'jest.Matchers'));
    } else if (VITEST_MODULES.has(name.replace(/^['"]|['"]$/g, ''))) {
      for (const declaration of block.getDescendantsOfKind(SyntaxKind.InterfaceDeclaration)) {
        const interfaceName = declaration.getName();
        if (interfaceName !== 'Assertion' && interfaceName !== 'Matchers') continue;
        if (declaration.getTypeParameters().length !== 2)
          sites.push(siteAt(source, declaration, `${interfaceName}`));
      }
    }
  }
  return sites.sort((a, b) => a.line - b.line);
}

/**
 * The import that registers jest-dom's matchers for Vitest: `import '@testing-library/jest-dom'`
 * or `'@testing-library/jest-dom/vitest'`. Their types merge into the one-parameter
 * `Assertion<T>` (or the global `jest.Matchers`) of Vitest 4, so at Vitest 5 the matchers
 * register at runtime and stop typing. `/matchers` imports are the way forward, not a site.
 */
export function jestDomRegistrationSites(text: string): SourceSite[] {
  if (!text.includes('@testing-library/jest-dom')) return [];
  const sites: SourceSite[] = [];
  text.split('\n').forEach((line, i) => {
    const match =
      /^(\s*)import\s+(['"])@testing-library\/jest-dom(?:\/vitest)?\2\s*;?\s*(?:\/\/.*)?$/.exec(
        line,
      );
    if (match)
      sites.push({
        line: i + 1,
        column: (match[1] ?? '').length + 1,
        snippet: line.trim(),
        name: '@testing-library/jest-dom',
      });
  });
  return sites;
}

/**
 * Glob entries of `coverage.include` and `coverage.exclude` that name a bare directory
 * (`'src/config'`). Vitest 4 matched them against absolute paths with picomatch's `contains`;
 * Vitest 5 matches the path relative to the project root, and a pattern with no wildcard is a
 * directory that matches what is inside it. An entry with a file extension names a file and
 * matches as before.
 */
export function bareCoveragePatternSites(text: string): SourceSite[] {
  if (!/\bcoverage\b/.test(text)) return [];
  const source = parse(text);
  const sites: SourceSite[] = [];
  for (const property of source.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (property.getName() !== 'coverage') continue;
    const config = property.getInitializer();
    if (!config || !Node.isObjectLiteralExpression(config)) continue;
    for (const key of ['include', 'exclude']) {
      const entry = config.getProperty(key);
      const list = entry && Node.isPropertyAssignment(entry) ? entry.getInitializer() : undefined;
      if (!list || !Node.isArrayLiteralExpression(list)) continue;
      for (const element of list.getElements()) {
        if (!Node.isStringLiteral(element) && !Node.isNoSubstitutionTemplateLiteral(element))
          continue;
        const value = element.getLiteralText();
        const last = value.split('/').pop() ?? '';
        if (/[*?[\]{}!]/.test(value) || last === '' || last.includes('.')) continue;
        sites.push(siteAt(source, element, value));
      }
    }
  }
  return sites.sort((a, b) => a.line - b.line);
}

/** The entry points Vitest 5 removes, and where the guide sends each import. */
const REMOVED_ENTRYPOINTS: Record<string, string | undefined> = {
  'vitest/coverage': 'vitest/node',
  'vitest/reporters': 'vitest/node',
  'vitest/environments': 'vitest/runtime',
  'vitest/snapshot': 'vitest/runtime',
  // `TestRunner` from 'vitest', or `@vitest/mocker`: not a swap of the specifier.
  'vitest/runners': undefined,
  'vitest/suite': undefined,
  'vitest/mocker': undefined,
  'vitest/internal/module-runner': undefined,
};

const ENTRYPOINT =
  /(\b(?:from|import|require|mock|doMock|importActual)\s*\(?\s*)(['"])(vitest\/(?:coverage|reporters|environments|snapshot|runners|suite|mocker|internal\/module-runner))\2/g;

/** The removed entry points the guide replaces by another specifier, or (`manual`) by something else. */
export function removedEntrypointSites(text: string, manual = false): SourceSite[] {
  if (!text.includes('vitest/')) return [];
  const sites: SourceSite[] = [];
  text.split('\n').forEach((line, i) => {
    for (const match of line.matchAll(ENTRYPOINT)) {
      if ((REMOVED_ENTRYPOINTS[match[3] as string] === undefined) !== manual) continue;
      sites.push({
        line: i + 1,
        column: (match.index ?? 0) + (match[1] ?? '').length + 1,
        snippet: line.trim(),
        name: match[3] as string,
      });
    }
  });
  return sites;
}

/** `'vitest/reporters'` at the reported site becomes `'vitest/node'`, as the guide says. */
export function replaceEntrypoint(text: string, finding: Pick<Finding, 'usage'>): TransformResult {
  const lines = text.split('\n');
  const line = lines[finding.usage.line - 1];
  if (line === undefined) return { text, applied: false, reason: 'the reported line is gone' };
  for (const match of line.matchAll(ENTRYPOINT)) {
    const start = (match.index ?? 0) + (match[1] ?? '').length;
    if (start + 1 !== finding.usage.column) continue;
    const specifier = match[3] as string;
    const to = REMOVED_ENTRYPOINTS[specifier];
    if (!to)
      return {
        text,
        applied: false,
        reason: `\`${specifier}\` has no drop-in replacement: the guide moves its exports elsewhere`,
      };
    const quote = match[2] as string;
    lines[finding.usage.line - 1] =
      `${line.slice(0, start)}${quote}${to}${quote}${line.slice(start + specifier.length + 2)}`;
    return {
      text: lines.join('\n'),
      applied: true,
      reason: `\`${specifier}\` is removed in Vitest 5: its exports come from \`${to}\``,
    };
  }
  return { text, applied: false, reason: 'the reported site is not a removed vitest entry point' };
}
