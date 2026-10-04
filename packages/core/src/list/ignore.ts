import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ignore from 'ignore';

export interface IgnoreRule {
  base: string;
  test: (file: string) => { ignored: boolean; unignored: boolean; rule?: { pattern: string } };
}
const defaults = new Set([
  'node_modules',
  '.git',
  'coverage',
  'dist',
  'build',
  'bower_components',
  'vendor',
]);
export const defaultSkip = (name: string): string | undefined =>
  defaults.has(name)
    ? `default: ${name}`
    : /(?:\.min\.js|\.bundle\.js|\.map)$/i.test(name)
      ? 'generated files (*.min.js, *.bundle.js, *.map)'
      : undefined;

/** Formatting/linting exclusions say nothing about runtime usage. Only Git rules apply. */
export function directoryRules(dir: string, entries: string[]): IgnoreRule[] {
  if (!entries.includes('.gitignore')) return [];
  const matcher = ignore().add(readFileSync(join(dir, '.gitignore'), 'utf8'));
  return [{ base: dir, test: (path) => matcher.test(path) }];
}
export function ignoredBy(
  path: string,
  directory: boolean,
  rules: IgnoreRule[],
): string | undefined {
  let pattern: string | undefined;
  for (const rule of rules) {
    const local = relative(rule.base, path).replaceAll('\\', '/') + (directory ? '/' : '');
    const result = rule.test(local);
    if (result.ignored) pattern = result.rule?.pattern ?? '(matching pattern unavailable)';
    else if (result.unignored) pattern = undefined;
  }
  return pattern;
}
