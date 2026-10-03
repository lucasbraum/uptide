import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { check } from '../check/check.js';
import type { CheckReport } from '../domain/report.js';
import { anthropicFixer } from '../fix/anthropic.js';
import { git } from '../fix/process.js';
import { renderMigration } from '../fix/report.js';
import { type FixServices, fix } from '../fix/run.js';
import type { FixReport } from '../fix/types.js';
import { diagnostics, newDiagnostics, testWorkspaces } from '../fix/verify.js';
import { install } from '../fix/versions.js';
import {
  detectUpgrades,
  matchesPaths,
  resolutionFile,
  type SupportedPackage,
  type Upgrade,
} from './detect.js';
import { eligible, type PullComments, type PullEvent } from './github.js';

export interface ActionOptions {
  cwd: string;
  repository: string;
  event: PullEvent;
  only: SupportedPackage[];
  paths: string[];
  fix: boolean;
  apiKey?: string;
  remote?: string;
}
export interface ActionResult {
  comment: string;
  commit?: string;
  reports: CheckReport[];
  fixes: FixReport[];
  skipped?: string;
}
export interface ActionServices extends FixServices {
  push(root: string, remote: string, branch: string): Promise<void>;
}
const defaults: ActionServices = {
  check,
  install,
  diagnostics,
  tests: testWorkspaces,
  async push(root, remote, branch) {
    git(root, 'push', remote, `HEAD:refs/heads/${branch}`);
  },
};
const packageSections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
function scoped(report: CheckReport, paths: string[]): CheckReport {
  return {
    ...report,
    packages: report.packages.map((p) => ({
      ...p,
      findings: p.findings.flatMap((f) => {
        if (f.change.kind === 'cause') {
          const downstream = (f.downstream ?? []).filter((d) => matchesPaths(d.file, paths));
          return downstream.length ? [{ ...f, downstream }] : [];
        }
        return matchesPaths(
          p.workspace === '.' || p.workspace === '*'
            ? f.usage.file
            : join(p.workspace, f.usage.file),
          paths,
        )
          ? [f]
          : [];
      }),
    })),
  };
}
export function commentSummary(
  upgrades: Upgrade[],
  reports: CheckReport[],
  fixes: FixReport[],
  note: string,
): string {
  const lines = ['## Uptide', ''];
  for (let i = 0; i < reports.length; i++) {
    const report = reports[i],
      upgrade = upgrades[i];
    if (!report || !upgrade) continue;
    const migrated = fixes.find((f) => f.package === upgrade.name && f.target === upgrade.to);
    const summary: FixReport = migrated ?? {
      repo: report.repo,
      package: upgrade.name,
      from: upgrade.from,
      target: upgrade.to,
      branch: '',
      sites: report.packages.flatMap((p) =>
        p.findings
          .filter((f) => ['breaking', 'deprecated', 'unverified'].includes(f.severity))
          .flatMap((f) =>
            f.change.kind === 'cause'
              ? (f.downstream ?? []).map((d) => ({
                  finding: {
                    ...f,
                    change: { ...f.change, kind: 'type' as const, path: `TS${d.code}` },
                    usage: { ...f.usage, file: d.file, line: d.line, compileError: d.message },
                  },
                  outcome: 'manual' as const,
                  reason: d.message,
                }))
              : [
                  {
                    finding: {
                      ...f,
                      usage: {
                        ...f.usage,
                        file:
                          p.workspace === '.' || p.workspace === '*'
                            ? f.usage.file
                            : join(p.workspace, f.usage.file),
                      },
                    },
                    outcome: 'manual' as const,
                    reason: f.reason,
                  },
                ],
          ),
      ),
      verificationPending: true,
      verification: {
        baseline: [],
        target: [],
        after: [],
        newErrors: [],
        baselineTests: [],
        tests: [],
        passed: false,
      },
      llm: { available: false, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      timingMs: 0,
      prBody: '',
      notes: [],
    };
    lines.push(renderMigration(summary, 'compact'));
    for (const p of report.packages)
      if (['skipped', 'no-types', 'unknown', 'partial', 'private'].includes(p.status))
        lines.push(`Analysis incomplete: ${p.name} (${p.status}).`);
  }
  lines.push('', '<details><summary>Action status</summary>', '', note, '', '</details>');
  return lines.join('\n').replace(/@/g, '＠');
}
/** PR-head source, base dependency graph for comparison; final verification uses the exact PR-head graph. */
export async function runAction(
  options: ActionOptions,
  comments: PullComments,
  services: ActionServices = defaults,
): Promise<ActionResult> {
  const reason = eligible(options.event, options.repository);
  if (reason) return { skipped: reason, comment: reason, reports: [], fixes: [] };
  const cwd = resolve(options.cwd),
    pr = options.event.pull_request;
  if (git(cwd, 'rev-parse', 'HEAD') !== pr.head.sha)
    throw new Error('checkout must be the exact pull-request head SHA');
  git(cwd, 'check-ref-format', `refs/heads/${pr.head.ref}`);
  const temp = mkdtempSync(join(tmpdir(), 'uptide-action-'));
  const base = join(temp, 'base'),
    stage = join(temp, 'head'),
    analysis = join(temp, 'analysis');
  const created: string[] = [],
    branches: string[] = [];
  const add = (dir: string, sha: string) => {
    git(cwd, 'worktree', 'add', '--detach', dir, sha);
    created.push(dir);
  };
  const reports: CheckReport[] = [],
    fixes: FixReport[] = [];
  let upgrades: Upgrade[] = [];
  let note = 'Check only. Set fix: true and provide ANTHROPIC_API_KEY to migrate.';
  try {
    add(base, pr.base.sha);
    add(stage, pr.head.sha);
    const changed = git(cwd, 'diff', '--name-only', pr.base.sha, pr.head.sha).split('\n');
    upgrades = detectUpgrades(base, stage, changed, options.only, options.paths);
    if (!upgrades.length) {
      await comments.comment('No supported dependency bump in the selected paths.');
      return {
        comment: 'No supported dependency bump in the selected paths.',
        reports,
        fixes,
        skipped: 'no supported bump',
      };
    }
    if (new Set(upgrades.map((u) => u.name)).size !== upgrades.length)
      throw new Error('multiple target versions of one package require separate PRs');
    const stageStart = git(stage, 'rev-parse', 'HEAD');
    const baseline: ReturnType<typeof diagnostics> = [];
    for (const upgrade of upgrades) {
      add(analysis, pr.head.sha);
      // Keep all PR-head source and scripts. Restore only dependency declarations and resolution files.
      for (const file of changed.filter(resolutionFile)) {
        const original = join(base, file),
          dest = join(analysis, file);
        if (!existsSync(original) || !existsSync(dest))
          throw new Error(`added/deleted resolution file needs manual review: ${file}`);
        if (file.endsWith('package.json')) {
          const a = JSON.parse(readFileSync(original, 'utf8')),
            b = JSON.parse(readFileSync(dest, 'utf8'));
          for (const key of [...packageSections, 'resolutions', 'overrides', 'pnpm']) {
            if (a[key] === undefined) delete b[key];
            else b[key] = a[key];
          }
          writeFileSync(dest, `${JSON.stringify(b, null, 2)}\n`);
        } else writeFileSync(dest, readFileSync(original));
      }
      git(analysis, 'add', '--all');
      if (git(analysis, 'diff', '--cached', '--name-only'))
        git(
          analysis,
          '-c',
          'user.name=uptide[bot]',
          '-c',
          'user.email=uptide@users.noreply.github.com',
          'commit',
          '-m',
          'Uptide comparison: PR source with base dependency graph',
        );
      await services.install(analysis);
      if (git(analysis, 'status', '--porcelain'))
        throw new Error(
          'baseline install changed resolution files; check cannot use a reproducible base',
        );
      const seed = git(analysis, 'rev-parse', 'HEAD');
      const report = scoped(
        await services.check({
          cwd: analysis,
          only: [upgrade.name],
          targets: { [upgrade.name]: upgrade.to },
          runtime: false,
          workspaceConcurrency: 1,
        }),
        options.paths,
      );
      reports.push(report);
      await comments.comment(
        commentSummary(upgrades, reports, fixes, 'Analysis complete; verification pending.'),
      );
      if (options.fix && options.apiKey) {
        const branch = `uptide/${upgrade.name}-${upgrade.to}`;
        if (git(cwd, 'branch', '--list', branch))
          throw new Error(`migration branch already exists: ${branch}`);
        branches.push(branch);

        const result = await fix(
          {
            cwd: analysis,
            only: upgrade.name,
            target: upgrade.to,
            fixer: anthropicFixer(options.apiKey),
          },
          { ...services, check: async () => report },
        );
        fixes.push(result);
        baseline.push(...result.verification.baseline);
        if (result.verification.passed && result.sites.every((s) => s.outcome !== 'manual')) {
          const files = git(analysis, 'diff', '--name-only', seed, 'HEAD')
            .split('\n')
            .filter((f) => !resolutionFile(f) && f);
          if (files.some((f) => !matchesPaths(f, options.paths)))
            throw new Error('migration touched a file outside paths');
          if (files.length) {
            const patch = `${git(analysis, 'diff', '--binary', seed, 'HEAD', '--', ...files)}\n`;
            const patchFile = join(temp, 'changes.patch');
            writeFileSync(patchFile, patch);
            git(stage, 'apply', '--index', patchFile);
          }
        }
      }
      git(cwd, 'worktree', 'remove', '--force', analysis);
      created.splice(created.indexOf(analysis), 1);
    }
    let commit: string | undefined;
    if (options.fix && !options.apiKey)
      note = 'No ANTHROPIC_API_KEY: fixes were not attempted; findings remain manual.';
    if (fixes.length) {
      const pass =
        fixes.length === upgrades.length &&
        fixes.every((f) => f.verification.passed && f.sites.every((s) => s.outcome !== 'manual'));
      if (!pass) note = 'Verification incomplete: no commit pushed. Manual sites are listed above.';
      else if (!git(stage, 'diff', '--cached', '--name-only'))
        note = 'No code changes needed; no commit created.';
      else {
        // Re-check actual PR-head manifests/lockfile, never the comparison worktree's rewritten graph.
        await services.install(stage);
        const workspaces = [...new Set(upgrades.flatMap((u) => u.workspaces))];
        const after = services.diagnostics(stage, workspaces);
        const errors = newDiagnostics(baseline, after);
        const tests = await services.tests(stage, workspaces, 120_000);
        const passed =
          errors.length === 0 &&
          tests.every((t) => ['passed', 'missing'].includes(t.status)) &&
          !git(stage, 'diff', '--name-only') &&
          !git(stage, 'ls-files', '--others', '--exclude-standard');
        // Summaries must describe the actual PR-head check, including a failed final gate.
        for (const f of fixes)
          f.verification = { ...f.verification, baseline, after, newErrors: errors, tests, passed };
        if (!passed)
          note = `PR-head verification failed (${errors.length} new errors); no commit pushed.`;
        else {
          if ((await comments.head()) !== pr.head.sha)
            throw new Error('PR head advanced during verification; rerun on the new head');
          const subject = `uptide: migrate code for ${upgrades.map((u) => `${u.name} ${u.to}`).join(', ')}`;
          git(
            stage,
            '-c',
            'user.name=uptide[bot]',
            '-c',
            'user.email=uptide@users.noreply.github.com',
            'commit',
            '-m',
            subject,
          );
          if (git(stage, 'rev-parse', 'HEAD^') !== stageStart)
            throw new Error('migration is not one commit on the PR head');
          await services.push(stage, options.remote ?? 'origin', pr.head.ref);
          commit = git(stage, 'rev-parse', 'HEAD');
          note = `Verification PASS. Pushed one commit: \`${commit}\` (${subject}). No force-push, merge or reviewer request.`;
        }
      }
    }
    const comment = commentSummary(upgrades, reports, fixes, note);
    await comments.comment(comment);
    return { comment, commit, reports, fixes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const comment = commentSummary(
      upgrades,
      reports,
      fixes,
      `Stopped; no further push attempted: ${message}`,
    );
    await comments.comment(comment);
    throw error;
  } finally {
    for (const dir of created.reverse()) git(cwd, 'worktree', 'remove', '--force', dir);
    for (const branch of branches)
      if (git(cwd, 'branch', '--list', branch)) git(cwd, 'branch', '-D', branch);
    rmSync(temp, { recursive: true, force: true });
  }
}
