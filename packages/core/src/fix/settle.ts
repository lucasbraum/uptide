import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { type ProgressListener, progress } from '../domain/progress.js';
import type { Finding } from '../domain/report.js';
import type { FollowUp, MigrationPack, PackContext } from '../packs/types.js';
import { git } from './process.js';
import { formatFiles, lintFiles } from './style.js';
import type { FixDiagnostic, FixSite, LintResult, TestResult } from './types.js';
import { failedTestFiles, type TestOptions } from './verify.js';

export function safeFile(root: string, file: string): string {
  if (isAbsolute(file) || file.split(/[\\/]/).includes('..') || file.includes('\0'))
    throw new Error(`patch path outside repository: ${file}`);
  const path = resolve(root, file);
  const actual = realpathSync(path);
  if (!actual.startsWith(`${realpathSync(root)}/`))
    throw new Error(`patch symlink escapes repository: ${file}`);
  return path;
}
export function commit(root: string, message: string, files: string[]): void {
  if (!files.length) return;
  git(root, 'add', '--', ...files.map((f) => relative(root, f)));
  if (git(root, 'diff', '--cached', '--name-only')) git(root, 'commit', '-m', message);
}

/** A follow-up edit that was applied: what a pack's decisions quote as before and after. */
export interface Followed {
  rule: string;
  file: string;
  line: number;
  before: string;
  after: string;
}

/** Applies a pack's follow-up edits per file, bottom-up, one commit per file; returns how many. */
export function applyFollowUps(input: {
  root: string;
  pack: string;
  edits: FollowUp[];
  base: Finding;
  rule: string | undefined;
  /** What the edits follow, for the commit subject: a site, or "the failing tests". */
  origin: string;
  sites: FixSite[];
  followed: Followed[];
  affected: string[];
}): number {
  const { root, rule } = input;
  let applied = 0;
  const byFile = new Map<string, FollowUp[]>();
  for (const edit of input.edits) byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit]);
  for (const [name, group] of byFile) {
    const file = safeFile(root, name);
    const lines = readFileSync(file, 'utf8').split('\n');
    // Bottom-up, so an inserted import does not move the lines still to be edited.
    const changes = group
      .flatMap((e) => [{ line: e.line, before: e.before, after: e.after }, ...(e.also ?? [])])
      .sort((x, y) => y.line - x.line);
    if (changes.some((c) => lines[c.line - 1] !== c.before)) continue;
    for (const c of changes) lines[c.line - 1] = c.after;
    writeFileSync(file, lines.join('\n'));
    commit(root, `fix(${input.pack}): follow ${input.origin} in ${name}`, [file]);
    if (!input.affected.includes(name)) input.affected.push(name);
    for (const edit of group) {
      applied++;
      if (rule)
        input.followed.push({
          rule,
          file: name,
          line: edit.line,
          before: edit.before,
          after: edit.after,
        });
      input.sites.push({
        finding: {
          ...input.base,
          usage: {
            ...input.base.usage,
            file: name,
            line: edit.line,
            column: 1,
            snippet: edit.before.trim(),
            compileError: undefined,
            compileCode: undefined,
          },
        },
        outcome: 'mechanical',
        reason: edit.reason,
        ...(rule ? { rule } : {}),
        diff: [
          ...(edit.also ?? []).map(
            (x) =>
              `+ ${x.after
                .split('\n')
                .find((l) => l !== x.before)
                ?.trim()}`,
          ),
          `- ${edit.before.trim()}`,
          `+ ${edit.after.trim()}`,
        ].join('\n'),
      });
    }
  }
  return applied;
}

export interface SettleInput {
  root: string;
  pack: MigrationPack;
  context: PackContext;
  workspaces: string[];
  sites: FixSite[];
  followed: Followed[];
  /** Files the tests are scoped to; follow-up files are added as they are edited. */
  affected: string[];
  /** Workspaces whose tests run; default: every workspace. Diagnostics always cover them all. */
  testWorkspaces?: string[];
  from: string;
  target: string;
  baselineLint: LintResult[];
  services: {
    diagnostics(root: string, workspaces: string[]): FixDiagnostic[];
    tests(
      root: string,
      workspaces: string[],
      timeoutMs?: number,
      files?: string[],
      options?: TestOptions,
    ): Promise<TestResult[]>;
    format?(root: string, files: string[]): Promise<string[]>;
    lint?(root: string, files: string[], baseline?: LintResult[]): Promise<LintResult[]>;
  };
  onProgress?: ProgressListener;
  testTimeoutMs?: number;
  /** Also run tests that need services, with the repository's global setup. Default false. */
  withServices?: boolean;
}

/**
 * Everything between "the edits are in" and "this is the verified state", the same for a
 * fresh migration and for re-verifying a branch that got new commits: format the files the
 * migration edited with the repository's formatter, run the related tests, let the pack fix
 * a test that fails for a behaviour change it knows (and run the tests again), type-check,
 * and lint the edited files with the repository's own tools.
 */
export async function settle(input: SettleInput): Promise<{
  tests: TestResult[];
  after: FixDiagnostic[];
  lint: LintResult[];
  formatted: string[];
}> {
  const { root, pack, services, workspaces } = input;
  const verify = <T>(detail: string, work: () => T | Promise<T>): Promise<T> =>
    progress(input.onProgress, { phase: 'verify', package: pack.name, detail }, work);
  const names = (list: string[]): string =>
    list.map((w) => (w === '.' ? 'root' : (w.split('/').pop() ?? w))).join(', ');
  const edited = (): string[] => [
    ...new Set(input.sites.filter((s) => s.outcome !== 'manual').map((s) => s.finding.usage.file)),
  ];
  const formatted = new Set<string>();
  /**
   * Only the files the migration edited: a repository-wide format would bury the migration.
   * Formatting runs after each round of edits (the tests and the lint see formatted files)
   * but is committed once, at the end: one `style` commit, not one per round.
   */
  const touched = new Set<string>();
  const format = async (): Promise<void> => {
    const files = edited();
    if (files.length === 0) return;
    const ran = await (services.format ?? formatFiles)(root, files);
    if (!git(root, 'status', '--porcelain', '--', ...files)) return;
    for (const tool of ran) formatted.add(tool);
    for (const file of files) touched.add(file);
  };
  const commitFormat = (): void => {
    const files = [...touched].filter((f) => git(root, 'status', '--porcelain', '--', f));
    if (files.length === 0) return;
    commit(
      root,
      `style(${pack.name}): format the files the migration edited`,
      files.map((f) => safeFile(root, f)),
    );
  };
  await verify('format', format);
  const runTests = (): Promise<TestResult[]> =>
    verify(`tests (${names(input.testWorkspaces ?? workspaces)})`, () =>
      services.tests(
        root,
        input.testWorkspaces ?? workspaces,
        input.testTimeoutMs,
        input.affected,
        {
          withServices: input.withServices === true,
        },
      ),
    );
  let tests = await runTests();
  // A test the migrated code made fail, for a behaviour change the pack knows and no compiler
  // error shows: the pack proposes the edit and the repository's own tests judge it.
  const failedRuns = tests.filter((t) => t.status === 'failed');
  if (pack.testFollowUps && failedRuns.length > 0) {
    const edits = pack.testFollowUps({
      root,
      workspaces,
      failing: failedRuns.flatMap((t) => failedTestFiles(t.output)),
      output: failedRuns.map((t) => t.output).join('\n'),
      context: input.context,
    });
    const rules = [...new Set(edits.map((e) => e.rule ?? 'default-messages'))];
    let applied = 0;
    for (const rule of rules) {
      const what =
        rule === 'default-messages' ? 'default error messages' : 'test fixtures of the old shape';
      applied += applyFollowUps({
        root,
        pack: pack.name,
        edits: edits.filter((e) => (e.rule ?? 'default-messages') === rule),
        base: {
          severity: 'breaking',
          confidence: 1,
          fixability: 'mechanical',
          reason: `${what} changed`,
          change: {
            package: pack.name,
            from: input.from,
            to: input.target,
            path: what,
            kind: 'type',
            severity: 'breaking',
            source: 'types',
            confidence: 1,
          },
          usage: {
            file: '',
            line: 1,
            column: 1,
            endLine: 1,
            endColumn: 1,
            symbolPath: what,
            access: 'read',
            snippet: '',
            via: 'inferred',
          },
        },
        rule,
        origin: 'the failing tests',
        sites: input.sites,
        followed: input.followed,
        affected: input.affected,
      });
    }
    if (applied > 0) {
      await verify('format', format);
      tests = await runTests();
    }
  }
  commitFormat();
  const after = await verify(`types (${names(workspaces)})`, () =>
    services.diagnostics(root, workspaces),
  );
  const lint = await verify('lint', () =>
    (services.lint ?? lintFiles)(root, edited(), input.baselineLint),
  );
  return { tests, after, lint, formatted: [...formatted].sort() };
}
