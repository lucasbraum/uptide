import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { UptideError } from '../errors.js';
import { command, git } from './process.js';
import { publicationBlockers } from './publish.js';
import { editDiff, prBody } from './report.js';
import { normalizeRemote, refreshReview } from './run.js';
import type { FixReport } from './types.js';

interface PrBodyOptions {
  cwd: string;
  pr: string;
  run?: string;
  preview?: boolean;
}
interface PrBodyIO {
  command: typeof command;
  git: typeof git;
  /** The build rendering the body; injected by tests. */
  tool?: { uptideDirty: boolean };
}
/** Upgrade old stored runs with representative patches from their retained local history. */
export function retainedDiffs(report: FixReport, readGit = git): FixReport {
  const result = structuredClone(report);
  if (
    result.sites.every(
      (s) => s.diff || s.resolvedBy || s.reason.startsWith('diagnostic resolved by an earlier'),
    )
  )
    return result;
  let commits: { sha: string; subject: string }[];
  try {
    commits = readGit(result.repo, 'log', '--format=%H%x09%s', result.head ?? 'HEAD', '-100')
      .split('\n')
      .map((line) => {
        const [sha = '', ...subject] = line.split('\t');
        return { sha, subject: subject.join('\t') };
      });
  } catch {
    return result;
  }
  for (const site of result.sites) {
    if (site.diff) continue;
    const file = site.finding.usage.file;
    // Exact subject is the stored site identity, independent of later line shifts.
    const commit = commits.find(
      (c) =>
        c.subject ===
        (site.outcome === 'mechanical'
          ? `fix(${result.package}): apply mechanical migrations`
          : `fix(${result.package}): migrate ${file}:${site.finding.usage.line}`),
    );
    if (!commit) continue;
    try {
      if (site.outcome === 'mechanical') {
        const before = readGit(result.repo, 'show', `${commit.sha}^:${file}`);
        const after = readGit(result.repo, 'show', `${commit.sha}:${file}`);
        // One representative changed block, rather than the entire file's migration.
        const patch = editDiff(before, after);
        const oldLine = before.split('\n')[site.finding.usage.line - 1]?.trim();
        const removed = patch.split('\n').indexOf(`- ${oldLine}`);
        const oldLines = patch.split('\n').filter((line) => line.startsWith('- '));
        const newLines = patch.split('\n').filter((line) => line.startsWith('+ '));
        const at = oldLines.indexOf(`- ${oldLine}`);
        site.diff =
          removed >= 0 && oldLines.length === newLines.length
            ? [oldLines[at], newLines[at]].join('\n')
            : readGit(result.repo, 'diff', '--unified=0', `${commit.sha}^`, commit.sha, '--', file)
                .split(/(?=^@@)/m)
                .slice(0, 2)
                .join('');
      } else {
        site.diff = readGit(
          result.repo,
          'diff',
          '--unified=3',
          `${commit.sha}^`,
          commit.sha,
          '--',
          file,
        );
        const accepted = site.attempts?.findLast((a) => a.outcome === 'accepted');
        if (accepted) accepted.diff = site.diff;
      }
    } catch {
      /* Old checkout may no longer retain its base; report the missing evidence. */
    }
  }
  return result;
}

/** Where runs made in a private clone are kept: inside the repository's `.git`, per branch. */
function runDir(cwd: string, branch: string, readGit: typeof git): string {
  let dir = '.git';
  try {
    dir = readGit(cwd, 'rev-parse', '--git-common-dir') || '.git';
  } catch {
    // Not a repository: the path below will simply not exist.
  }
  return join(isAbsolute(dir) ? dir : resolve(cwd, dir), 'uptide', branch.replaceAll('/', '__'));
}

/** Renders a stored run. The only remote mutation is gh pr edit --body-file. */
export async function updatePrBody(
  options: PrBodyOptions,
  io: PrBodyIO = { command, git },
): Promise<{ body: string; url: string; updated: boolean }> {
  const cwd = resolve(options.cwd);
  if (!/^\d+$/.test(options.pr)) throw new Error('--pr must be a pull request number');
  // The PR is the one in the repository `origin` names. In a fork, `gh` would otherwise look
  // at the parent's pull request of the same number.
  let origin: string | undefined;
  try {
    origin = /github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/.exec(
      io.git(cwd, 'remote', 'get-url', 'origin'),
    )?.[1];
  } catch {
    origin = undefined;
  }
  const inRepo = origin ? ['--repo', origin] : [];
  const view = await io.command(cwd, 'gh', [
    'pr',
    'view',
    options.pr,
    ...inRepo,
    '--json',
    'url,headRefName,headRefOid',
  ]);
  if (view.code) throw new Error(`cannot read PR: ${view.output}`);
  const pr = JSON.parse(view.output) as { url: string; headRefName: string; headRefOid: string };
  // The run named explicitly, the legacy one in the checkout, or the one kept inside `.git`
  // for the PR's branch (where runs made in a private clone are stored).
  const stored =
    options.run ??
    (existsSync(join(cwd, '.uptide/report.json'))
      ? join(cwd, '.uptide/report.json')
      : join(runDir(cwd, pr.headRefName, io.git), 'report.json'));
  let report: FixReport;
  try {
    report = JSON.parse(readFileSync(resolve(stored), 'utf8')) as FixReport;
  } catch {
    throw new Error(`no stored migration run for ${pr.headRefName} (looked in ${stored})`);
  }
  if (
    !Array.isArray(report.sites) ||
    !report.verification ||
    !report.package ||
    !report.target ||
    !report.branch
  )
    throw new Error('not a stored migration run');
  if (report.branch !== pr.headRefName || (report.prUrl && report.prUrl !== pr.url))
    throw new Error('stored run does not match the selected PR');
  // A run belongs to one repository: the PR must live where the run's checkout pushes.
  if (report.remote && !pr.url.startsWith(`${report.remote}/pull/`))
    throw new Error('stored run belongs to another repository');
  // A legacy run has no recorded SHA. Recover it from its retained checkout before rendering.
  let head = report.head;
  if (!head) {
    try {
      head = io.git(report.repo, 'rev-parse', 'HEAD');
    } catch {
      throw new Error('legacy run needs its retained checkout to verify the PR commit');
    }
    const remote = normalizeRemote(io.git(report.repo, 'remote', 'get-url', 'origin'));
    if (!pr.url.startsWith(`${remote}/pull/`))
      throw new Error('stored run belongs to another repository');
  }
  if (head !== pr.headRefOid)
    throw new Error(
      'PR head differs from the stored run; rerun verification before updating its description',
    );
  refreshReview(report);
  const body = prBody(retainedDiffs({ ...report, head }, io.git));
  if (!options.preview) {
    // The same gate as opening a PR: a failed or irreproducible run never reaches GitHub.
    const blockers = publicationBlockers(report, io.tool);
    if (blockers.length)
      throw new UptideError(
        'PUBLICATION_REFUSED',
        `PR description not updated: ${blockers.join('; ')}. Use --preview to read the body locally.`,
      );
    const temp = mkdtempSync(join(tmpdir(), 'uptide-pr-body-'));
    try {
      const file = join(temp, 'body.md');
      writeFileSync(file, body);
      let edited = await io.command(cwd, 'gh', [
        'pr',
        'edit',
        options.pr,
        ...inRepo,
        '--body-file',
        file,
      ]);
      // `gh pr edit` queries classic project cards and fails outright on repositories where
      // GitHub retired them. The REST endpoint changes the same field and nothing else.
      const repository = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(pr.url)?.[1];
      if (edited.code && /projectCards|Projects \(classic\)/.test(edited.output) && repository)
        edited = await io.command(cwd, 'gh', [
          'api',
          '--method',
          'PATCH',
          `repos/${repository}/pulls/${options.pr}`,
          '--field',
          `body=@${file}`,
          '--silent',
        ]);
      if (edited.code) throw new Error(`cannot update PR description: ${edited.output}`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  return { body, url: pr.url, updated: !options.preview };
}
