import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { workspacePackagesOf } from '../adapters/typescript/repo.js';
import type { ProgressListener } from '../domain/progress.js';
import { UptideError } from '../errors.js';
import { stripePack } from '../packs/stripe/index.js';
import type { MigrationPack, PackContext } from '../packs/types.js';
import { zodPack } from '../packs/zod/index.js';
import { uptideVersionInfo } from '../version.js';
import { git } from './process.js';
import { prBody } from './report.js';
import { confirmServices } from './run.js';
import { type Followed, settle } from './settle.js';
import type { FixReport, LintResult, TestResult } from './types.js';
import {
  diagnostics,
  newDiagnostics,
  type TestOptions,
  testWorkspaces,
  typeResolutionFailure,
} from './verify.js';

export interface ReverifyOptions {
  cwd: string;
  onProgress?: ProgressListener;
  testTimeoutMs?: number;
  /** The stored run to continue. Default: `.uptide/report.json` in `cwd`. */
  run?: string;
  pack?: MigrationPack;
  tool?: ReturnType<typeof uptideVersionInfo>;
  /** Also run tests that need services; `yes` confirms the printed services and targets. */
  withServices?: boolean;
  yes?: boolean;
}
export interface ReverifyServices {
  diagnostics(root: string, workspaces: string[]): ReturnType<typeof diagnostics>;
  tests(
    root: string,
    workspaces: string[],
    timeoutMs?: number,
    files?: string[],
    options?: TestOptions,
  ): Promise<TestResult[]>;
  format?(root: string, files: string[]): Promise<string[]>;
  lint?(root: string, files: string[], baseline?: LintResult[]): Promise<LintResult[]>;
}

/**
 * Verifies a migration branch again where it stands, and refreshes its stored run. A branch
 * that is already a pull request is never rebuilt from scratch: that would rewrite history
 * under its reviewers. Whatever is still to do is added as new commits on top (a test the
 * migrated code made fail, the formatting of the edited files), the new HEAD is verified
 * against the run's original baseline, and the run records that HEAD. Nothing is pushed.
 */
export async function reverify(
  options: ReverifyOptions,
  services: ReverifyServices = { diagnostics, tests: testWorkspaces },
): Promise<FixReport> {
  const started = Date.now();
  const root = realpathSync(resolve(options.cwd));
  confirmServices(root, options);
  const file = resolve(options.run ?? join(root, '.uptide/report.json'));
  let report: FixReport;
  try {
    report = JSON.parse(readFileSync(file, 'utf8')) as FixReport;
  } catch {
    throw new UptideError('ANALYSIS_FAILED', `no stored migration run at ${file}`);
  }
  if (!Array.isArray(report.sites) || !report.verification || !report.package || !report.branch)
    throw new UptideError('ANALYSIS_FAILED', 'not a stored migration run');
  if (git(root, 'branch', '--show-current') !== report.branch)
    throw new UptideError(
      'ANALYSIS_FAILED',
      `check out ${report.branch} first: the stored run belongs to that branch`,
    );
  // The run's own files under .uptide are untracked by design; anything else must be committed.
  const pending = git(root, 'status', '--porcelain', '--untracked-files=all')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.slice(3).startsWith('.uptide/'));
  if (pending.length)
    throw new UptideError('DIRTY_WORKING_TREE', 'uptide verify requires a clean working tree');
  const pack =
    options.pack ?? [zodPack, stripePack].find((candidate) => candidate.name === report.package);
  if (!pack) throw new Error(`no migration pack for ${report.package}`);
  const workspaces = workspacePackagesOf(root).filter((w) => {
    const p = JSON.parse(readFileSync(join(root, w, 'package.json'), 'utf8'));
    return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(
      (s) => typeof p[s]?.[pack.name] === 'string',
    );
  });
  const from = report.from ?? report.sites[0]?.finding.change.from ?? '';
  const context: PackContext = {
    from,
    to: report.target,
    includeDeprecated: false,
    ...pack.scanContext?.(root, workspaces),
  };
  const sites = report.sites;
  const known = sites.length;
  const followed: Followed[] = [];
  const affected = [...new Set(sites.map((s) => s.finding.usage.file))];
  const { tests, after, lint, formatted } = await settle({
    root,
    pack,
    context,
    workspaces,
    sites,
    followed,
    affected,
    from,
    target: report.target,
    // The files as they were before the migration are gone from this branch's tip: lint has
    // to pass outright.
    baselineLint: [],
    services,
    withServices: options.withServices === true,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.testTimeoutMs ? { testTimeoutMs: options.testTimeoutMs } : {}),
  });
  const left = git(root, 'status', '--porcelain', '--untracked-files=all')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.slice(3).startsWith('.uptide/'));
  const newErrors = newDiagnostics(report.verification.baseline, after);
  const unverified = typeResolutionFailure(root, report.verification.baseline);
  const rules = [...new Set(sites.map((s) => s.rule).filter((r): r is string => !!r))];
  const decisions = [
    ...new Set([
      ...(report.decisions ?? []),
      ...(pack.decisions?.(context, rules, followed) ?? []),
    ]),
  ];
  const result: FixReport = {
    ...report,
    repo: root,
    ...(options.tool ?? uptideVersionInfo()),
    verifiedAt: new Date().toISOString(),
    verificationTimingMs: Date.now() - started,
    head: git(root, 'rev-parse', 'HEAD'),
    sites,
    verification: {
      ...report.verification,
      after,
      newErrors,
      tests,
      ...(lint.length ? { lint } : {}),
      ...(formatted.length ? { formatted } : {}),
      ...(unverified ? { typesUnverified: unverified } : {}),
      passed:
        !unverified &&
        newErrors.length === 0 &&
        left.length === 0 &&
        tests.every((t) => t.status === 'passed' || t.status === 'missing') &&
        lint.every((l) => l.status !== 'failed'),
    },
    ...(decisions.length ? { decisions } : {}),
    notes: [
      ...report.notes.filter((n) => !n.startsWith('Verified again')),
      `Verified again at a new HEAD: ${sites.length - known} follow-up edit${sites.length - known === 1 ? '' : 's'} and ${formatted.length ? 'formatting' : 'no formatting'} were added as new commits; earlier commits are unchanged.`,
    ],
    prBody: join(root, '.uptide/pr-body.md'),
  };
  delete result.verificationPending;
  // Judged again from the stored baseline: a reason recorded by an earlier build may not hold.
  if (!unverified) delete result.verification.typesUnverified;
  delete result.publication;
  mkdirSync(dirname(result.prBody), { recursive: true });
  writeFileSync(result.prBody, prBody(result));
  writeFileSync(join(root, '.uptide/report.json'), JSON.stringify(result, null, 2));
  return result;
}
