import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { command } from './process.js';
import type { LintResult } from './types.js';

/** A formatter or linter the repository itself uses, and how to run it on a list of files. */
interface StyleTool {
  name: 'biome' | 'prettier' | 'eslint';
  /** Rewrites the files in place. Absent for a tool that only checks. */
  format?: (files: string[]) => string;
  /** Exits non-zero when the files do not pass. */
  lint: (files: string[]) => string;
}

const quote = (arg: string): string =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
const list = (files: string[]): string => files.map(quote).join(' ');
const has = (root: string, names: string[]): boolean =>
  names.some((name) => existsSync(join(root, name)));
const manifest = (root: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
};
const installed = (root: string, bin: string): boolean =>
  existsSync(join(root, 'node_modules/.bin', bin));

/**
 * What the repository formats and lints with, from its own configuration files and installed
 * binaries: biome, prettier, eslint. Nothing is assumed: a tool without both a configuration
 * at the repository root and a binary in `node_modules/.bin` is not used.
 */
export function detectStyle(root: string): StyleTool[] {
  const tools: StyleTool[] = [];
  if (has(root, ['biome.json', 'biome.jsonc']) && installed(root, 'biome'))
    tools.push({
      name: 'biome',
      format: (files) => `biome format --write ${list(files)}`,
      // `check` is what a repository's own `lint` script runs: formatting, lint rules, imports.
      lint: (files) => `biome check ${list(files)}`,
    });
  const prettierConfig =
    has(root, [
      '.prettierrc',
      '.prettierrc.json',
      '.prettierrc.yaml',
      '.prettierrc.yml',
      '.prettierrc.js',
      '.prettierrc.cjs',
      '.prettierrc.mjs',
      'prettier.config.js',
      'prettier.config.cjs',
      'prettier.config.mjs',
      'prettier.config.ts',
    ]) || manifest(root).prettier !== undefined;
  if (prettierConfig && installed(root, 'prettier'))
    tools.push({
      name: 'prettier',
      format: (files) => `prettier --write ${list(files)}`,
      lint: (files) => `prettier --check ${list(files)}`,
    });
  const eslintConfig =
    has(root, [
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
      '.eslintrc',
      '.eslintrc.json',
      '.eslintrc.js',
      '.eslintrc.cjs',
      '.eslintrc.yaml',
      '.eslintrc.yml',
    ]) || manifest(root).eslintConfig !== undefined;
  if (eslintConfig && installed(root, 'eslint'))
    tools.push({ name: 'eslint', lint: (files) => `eslint ${list(files)}` });
  return tools;
}

const run = (root: string, script: string, timeoutMs: number) =>
  command(root, process.env.SHELL ?? '/bin/sh', ['-c', script], timeoutMs, {
    PATH: [join(root, 'node_modules/.bin'), process.env.PATH].join(':'),
  });
const present = (root: string, files: string[]): string[] =>
  [...new Set(files)].filter((file) => existsSync(join(root, file))).sort();
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

/**
 * Runs the repository's formatter on the files the migration edited, and on nothing else: a
 * formatter let loose on the whole repository would bury the migration in unrelated changes.
 * Returns the names of the formatters that ran.
 */
export async function formatFiles(
  root: string,
  files: string[],
  timeoutMs = 120_000,
): Promise<string[]> {
  const targets = present(root, files);
  if (targets.length === 0) return [];
  const ran: string[] = [];
  for (const tool of detectStyle(root)) {
    if (!tool.format) continue;
    await run(root, tool.format(targets), timeoutMs);
    ran.push(tool.name);
  }
  return ran;
}

/**
 * Runs the repository's lint on the files the migration edited. A `baseline` (the same files
 * before the migration) tells a failure the migration introduced from one that was there.
 */
export async function lintFiles(
  root: string,
  files: string[],
  baseline: LintResult[] = [],
  timeoutMs = 120_000,
): Promise<LintResult[]> {
  const targets = present(root, files);
  if (targets.length === 0) return [];
  const results: LintResult[] = [];
  for (const tool of detectStyle(root)) {
    const script = tool.lint(targets);
    const result = await run(root, script, timeoutMs);
    const before = baseline.find((b) => b.tool === tool.name);
    results.push({
      tool: tool.name,
      status:
        !result.code && !result.timeout
          ? 'passed'
          : before?.status === 'failed'
            ? 'pre-existing'
            : 'failed',
      command: script,
      files: targets.length,
      output:
        result.code || result.timeout
          ? result.output.replace(ANSI, '').split(root).join('<repo>').slice(-4000)
          : '',
    });
  }
  return results;
}
