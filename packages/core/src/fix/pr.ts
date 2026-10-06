import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { UPTIDE_COMMAND } from '../version.js';
import { storedRunFile } from './isolate.js';
import { command, git, projectRoot } from './process.js';
import { publish } from './publish.js';
import { prBody } from './report.js';
import { refreshReview } from './run.js';
import type { FixReport } from './types.js';

export interface PrOptions {
  cwd: string;
  /** The migration branch; default: the one checked out. */
  branch?: string;
  /** `owner/name`; default: the repository `origin` points at, a fork included. */
  repo?: string;
  draft?: boolean;
  yes?: boolean;
}

/**
 * `uptide pr`: publish a finished run. The stored run for the branch is loaded from the
 * repository's .git, the branch must still be the verified commit (else `uptide verify`),
 * the plan says which repository the PR goes to, and `--yes` pushes and opens it with the
 * stored body. The report remembers the PR.
 */
export async function openPr(
  options: PrOptions,
  print: (text: string) => void = console.log,
  io: Parameters<typeof publish>[2] = { git, command, print },
): Promise<{ url: string; report: FixReport }> {
  const { top, root } = projectRoot(options.cwd);
  const branch = options.branch ?? git(root, 'branch', '--show-current');
  if (!branch)
    throw new Error(
      `name the migration branch: ${UPTIDE_COMMAND} pr --branch uptide/<package>-<version>`,
    );
  const stored = storedRunFile(top, branch);
  if (!stored)
    throw new Error(
      `no stored migration run for ${branch} in this repository; run \`${UPTIDE_COMMAND} fix\` first, or \`${UPTIDE_COMMAND} verify --branch ${branch}\``,
    );
  const report = JSON.parse(readFileSync(stored, 'utf8')) as FixReport;
  if (report.branch !== branch)
    throw new Error(`the stored run is for ${report.branch}, not ${branch}`);
  // The description is rendered again from the stored run: a run made by an older build
  // may have stored one that no longer fits GitHub's limit.
  refreshReview(report);
  report.prBody = join(dirname(stored), 'pr-body.md');
  writeFileSync(report.prBody, prBody(report));
  const url = await publish(report, options.yes, io, {
    cwd: top,
    ...(options.repo ? { repo: options.repo } : {}),
    ...(options.draft === undefined ? {} : { draft: options.draft }),
  });
  report.prUrl = url;
  writeFileSync(stored, JSON.stringify(report, null, 2));
  return { url, report };
}
