import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ignore from 'ignore';
import picomatch from 'picomatch';
import { configConsumers, configValue, lintStaged } from './config.js';

export interface IgnoreRule {
  base: string;
  reason: string;
  test: (file: string) => { ignored: boolean; unignored: boolean };
  prune: boolean;
}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const defaults = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.yarn',
  'bower_components',
  'vendor',
]);
export const defaultSkip = (name: string): string | undefined =>
  defaults.has(name)
    ? `default: ${name}`
    : /(?:\.min\.js|\.bundle\.js|\.map)$/i.test(name)
      ? 'generated files (*.min.js, *.bundle.js, *.map)'
      : undefined;

/** Rules are local to the directory that declares them. Prune ignored directories without
 * enumerating their contents; report directory counts separately from known file counts. */
export function directoryRules(dir: string, entries: string[]): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const file of ['.gitignore', '.eslintignore', '.prettierignore']) {
    if (!entries.includes(file)) continue;
    const matcher = ignore().add(readFileSync(join(dir, file), 'utf8'));
    rules.push({
      base: dir,
      reason: file === '.gitignore' ? '.gitignore' : file,
      test: (path) => matcher.test(path),
      prune: true,
    });
  }
  const globs = (patterns: string[], reason: string): void => {
    if (!patterns.length) return;
    const matchers = patterns.map((pattern) => {
      const negated = pattern.startsWith('!');
      const glob = (negated ? pattern.slice(1) : pattern).replace(/^\.\//, '');
      const match = picomatch(glob.endsWith('/') ? `${glob}**` : glob, { dot: true });
      return { negated, match };
    });
    rules.push({
      base: dir,
      reason,
      prune: !patterns.some((p) => p.startsWith('!')),
      test: (file) => {
        let ignored = false,
          unignored = false;
        for (const { negated, match } of matchers)
          if (match(file) || (file.endsWith('/') && match(file.slice(0, -1)))) {
            ignored = !negated;
            unignored = negated;
          }
        return { ignored, unignored };
      },
    });
  };
  if (entries.includes('package.json')) {
    try {
      const data = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      globs(strings(data.standard?.ignore), 'standard.ignore');
      globs(lintStaged(data['lint-staged']).ignores, 'lint-staged.ignore');
    } catch {
      /* Manifest validation belongs to discovery; ignore malformed optional settings. */
    }
  }
  for (const file of entries.filter((name) => configConsumers(name).includes('lint-staged'))) {
    globs(
      lintStaged(configValue(file, readFileSync(join(dir, file), 'utf8'))).ignores,
      'lint-staged.ignore',
    );
  }
  return rules;
}
export function ignoredBy(
  path: string,
  directory: boolean,
  rules: IgnoreRule[],
): string | undefined {
  let gitIgnored = false;
  for (const rule of rules) {
    if (directory && !rule.prune) continue;
    const local = relative(rule.base, path).replaceAll('\\', '/') + (directory ? '/' : '');
    const result = rule.test(local);
    if (rule.reason === '.gitignore') {
      if (result.ignored) gitIgnored = true;
      else if (result.unignored) gitIgnored = false;
    } else if (result.ignored) return rule.reason;
  }
  return gitIgnored ? '.gitignore' : undefined;
}
