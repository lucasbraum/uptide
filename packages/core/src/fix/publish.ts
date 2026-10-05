import { readFileSync } from 'node:fs';
import { UptideError } from '../errors.js';
import { uptideVersionInfo } from '../version.js';
import { command, git } from './process.js';
import type { FixReport } from './types.js';

const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Why a run may not reach GitHub, for opening a PR and for updating one alike; empty when it
 * may. Nothing overrides this list: not `--yes`, not `--no-llm`. A failed verification names
 * what failed, and a run produced by an Uptide checkout with uncommitted changes is not
 * reproducible from its recorded commit, so it is never published either.
 */
export function publicationBlockers(
  report: FixReport,
  tool: { uptideDirty: boolean } = uptideVersionInfo(),
): string[] {
  const blockers: string[] = [];
  const v = report.verification;
  if (report.verificationPending) blockers.push('verification has not run');
  else if (!v.passed) {
    const failed = (v.tests ?? []).filter((t) => t.status === 'failed' || t.status === 'timeout');
    const reasons = [
      ...(v.typesUnverified
        ? [`types not verified (type resolution failed: ${v.typesUnverified})`]
        : []),
      ...(v.newErrors?.length ? [count(v.newErrors.length, 'new type error')] : []),
      ...(v.lint ?? [])
        .filter((l) => l.status === 'failed')
        .map((l) => `lint (${l.tool}) fails on the edited files`),
      ...failed.map(
        (t) => `tests ${t.status === 'timeout' ? 'timed out' : 'failed'} in ${t.workspace}`,
      ),
    ];
    blockers.push(
      `verification failed${reasons.length ? `: ${reasons.join(', ')}` : ' (files were left uncommitted)'}`,
    );
  }
  if (report.sourceChanged?.length)
    blockers.push(`your checkout changed during the run (${report.sourceChanged.join('; ')})`);
  if (report.uptideDirty || tool.uptideDirty)
    blockers.push(
      'Uptide ran from a checkout with uncommitted changes; rerun from a committed build so the run is reproducible',
    );
  return blockers;
}

interface PublishIO {
  git: typeof git;
  command: typeof command;
  print: (text: string) => void;
  /** The PR description as stored; the file by default. */
  readBody?: (file: string) => string;
}
/** GitHub's own limit for a PR body. */
export const GITHUB_BODY_LIMIT = 65_536;
/** The commit `origin` has for the branch, or undefined when it has none (or cannot be asked). */
function remoteBranchHead(
  cwd: string,
  branch: string,
  io: Pick<PublishIO, 'git'>,
): string | undefined {
  try {
    const line = io.git(cwd, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
    return /^([0-9a-f]{40})\s/.exec(line)?.[1];
  } catch {
    return undefined;
  }
}
const defaults: PublishIO = { git, command, print: console.log };
export interface PublishTarget {
  /** `owner/name` the PR will be opened on. */
  nameWithOwner: string;
  base: string;
  /** The parent, when the repository is a fork of one. */
  parent?: string;
}
/**
 * Before a `--pr` run clones anything: `gh` must be signed in and the target repository must
 * resolve. The target is the repository `origin` names, a fork included; its parent only when
 * asked for by name. Says where the PR will go so the user can object before any work.
 */
export async function publishTarget(
  cwd: string,
  repo?: string,
  io: Pick<PublishIO, 'git' | 'command'> = defaults,
): Promise<PublishTarget> {
  const auth = await io.command(cwd, 'gh', ['auth', 'status']);
  if (auth.code)
    throw new UptideError(
      'PUBLICATION_REFUSED',
      `--pr needs GitHub CLI signed in: ${auth.output.trim().split('\n').at(-1) ?? 'gh auth status failed'}; run \`gh auth login\``,
    );
  const remote = io.git(cwd, 'remote', 'get-url', 'origin');
  const slug = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/.exec(remote);
  const owner = slug?.[1];
  // A classic token lists its scopes; a private repository needs `repo` among them.
  const scopes = /Token scopes: (.*)$/m.exec(auth.output)?.[1];
  const lacksRepoScope = scopes !== undefined && !/'repo'/.test(scopes);
  let own: Awaited<ReturnType<typeof viewRepository>>;
  try {
    own = await viewRepository(cwd, remote, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UptideError(
      'PUBLICATION_REFUSED',
      [
        `--pr cannot reach ${remote} with the GitHub token: ${firstLine(message.replace(/^cannot resolve target repository: /, ''))}`,
        'Likely causes, and what fixes each:',
        `  the token lacks the \`repo\` scope${lacksRepoScope ? ` (it does: its scopes are ${scopes})` : ''}: gh auth refresh -h github.com -s repo`,
        ...(owner
          ? [
              `  ${owner} enforces SSO and the token is not authorized for it: https://github.com/orgs/${owner}/sso`,
            ]
          : []),
        '  the account has no access to the repository: ask for it, or run from a fork you own',
        'Nothing was cloned or changed.',
      ].join('\n'),
    );
  }
  // Publishing pushes a branch to origin: reading it is not enough.
  if (own.viewerPermission && !['WRITE', 'MAINTAIN', 'ADMIN'].includes(own.viewerPermission))
    throw new UptideError(
      'PUBLICATION_REFUSED',
      [
        `--pr needs push access to ${own.nameWithOwner ?? remote}; this account has ${own.viewerPermission.toLowerCase()} access only.`,
        'What fixes it:',
        '  ask for write access to the repository, or',
        `  fork it and run from the fork (gh repo fork ${own.nameWithOwner ?? ''} --clone), then \`uptide pr --repo ${own.nameWithOwner ?? '<owner/name>'}\` opens the PR upstream`,
        ...(owner
          ? [
              `  if you do have write access through ${owner}, authorize the token for its SSO: https://github.com/orgs/${owner}/sso`,
            ]
          : []),
        'Nothing was cloned or changed. Without --pr the migration still runs, and `uptide pr` publishes it later.',
      ].join('\n'),
    );
  const target = repo ? await viewRepository(cwd, repo, io) : own;
  if (!target.defaultBranchRef?.name || !target.nameWithOwner)
    throw new UptideError('PUBLICATION_REFUSED', 'target repository has no default branch');
  return {
    nameWithOwner: target.nameWithOwner,
    base: target.defaultBranchRef.name,
    ...(own.isFork && own.parent?.nameWithOwner ? { parent: own.parent.nameWithOwner } : {}),
  };
}
async function viewRepository(
  cwd: string,
  target: string,
  io: Pick<PublishIO, 'command'>,
): Promise<{
  defaultBranchRef?: { name: string };
  nameWithOwner?: string;
  isFork?: boolean;
  parent: { nameWithOwner: string } | null;
  viewerPermission?: string;
}> {
  const metadata = await io.command(cwd, 'gh', [
    'repo',
    'view',
    target,
    '--json',
    'defaultBranchRef,nameWithOwner,isFork,parent,viewerPermission',
  ]);
  if (metadata.code) throw new Error(`cannot resolve target repository: ${metadata.output}`);
  const parsed = JSON.parse(metadata.output) as {
    defaultBranchRef?: { name: string };
    nameWithOwner?: string;
    isFork?: boolean;
    viewerPermission?: string;
    parent?: { nameWithOwner?: string; name?: string; owner?: { login?: string } } | null;
  };
  // gh names the parent by owner and name, not as one string.
  const parent = parsed.parent
    ? (parsed.parent.nameWithOwner ??
      (parsed.parent.owner?.login && parsed.parent.name
        ? `${parsed.parent.owner.login}/${parsed.parent.name}`
        : undefined))
    : undefined;
  return { ...parsed, parent: parent ? { nameWithOwner: parent } : null };
}
const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';
/** The `uptide` label exists, or was created; never a reason to stop. */
async function ensureLabel(
  cwd: string,
  nameWithOwner: string,
  io: Pick<PublishIO, 'command'>,
): Promise<{ ok: true } | { ok: false; step: 'read' | 'created'; output: string }> {
  const labels = await io.command(cwd, 'gh', [
    'label',
    'list',
    '--repo',
    nameWithOwner,
    '--search',
    'uptide',
    '--json',
    'name',
  ]);
  if (labels.code) return { ok: false, step: 'read', output: labels.output };
  let names: { name: string }[] = [];
  try {
    names = JSON.parse(labels.output.trim() || '[]') as { name: string }[];
  } catch {
    return { ok: false, step: 'read', output: labels.output };
  }
  if (names.some((l) => l.name === 'uptide')) return { ok: true };
  const label = await io.command(cwd, 'gh', [
    'label',
    'create',
    'uptide',
    '--repo',
    nameWithOwner,
    '--description',
    'Verified dependency migration proposed by Uptide',
    '--color',
    '2563EB',
  ]);
  return label.code ? { ok: false, step: 'created', output: label.output } : { ok: true };
}
export interface PublishOptions {
  /**
   * The repository the run belongs to, when publishing a stored run from the user's checkout:
   * the branch is a ref there, not checked out. Default: the run's own clone, checked out.
   */
  cwd?: string;
  /** `owner/name` to open the PR on. Default: the repository `origin` points at, a fork included. */
  repo?: string;
  /** A draft PR; the default. */
  draft?: boolean;
}
/** No writes before the concrete publication plan and explicit --yes gate. */
export async function publish(
  report: FixReport,
  yes = false,
  io: PublishIO = defaults,
  options: PublishOptions = {},
): Promise<string> {
  const blockers = publicationBlockers(report, { uptideDirty: false });
  if (blockers.length)
    throw new UptideError(
      'PUBLICATION_REFUSED',
      `cannot publish an unverified migration: ${blockers.join('; ')}`,
    );
  const cwd = options.cwd ?? report.repo;
  const branch = report.branch;
  if (!/^uptide\//.test(branch))
    throw new Error('publication branch does not match the verified migration');
  if (options.cwd) {
    // A stored run: the branch must still be the verified commit.
    const at = io.git(cwd, 'rev-parse', branch);
    if (report.head && at !== report.head)
      throw new UptideError(
        'RUN_STALE',
        `${branch} is at ${at.slice(0, 12)}, not the verified ${report.head.slice(0, 12)}; run \`uptide verify --branch ${branch}\` first`,
      );
  } else if (io.git(cwd, 'branch', '--show-current') !== branch)
    throw new Error('publication branch does not match the verified migration');
  const head = io.git(cwd, 'rev-parse', branch);
  const remote = io.git(cwd, 'remote', 'get-url', 'origin');
  // The PR goes to the repository `origin` names, a fork included; never to a fork's parent
  // unless asked by name.
  const own = await viewRepository(cwd, remote, io);
  const target = options.repo ? await viewRepository(cwd, options.repo, io) : own;
  const { defaultBranchRef, nameWithOwner } = target;
  if (!defaultBranchRef?.name || !nameWithOwner)
    throw new Error('target repository has no default branch');
  const base = report.prBase ?? defaultBranchRef.name;
  const headRef =
    own.nameWithOwner && own.nameWithOwner !== nameWithOwner
      ? `${own.nameWithOwner.split('/')[0]}:${branch}`
      : branch;
  // Against the remote's base when it is fetched, else the local branch of that name.
  const against = [`origin/${base}`, base].find((ref) => {
    try {
      io.git(cwd, 'rev-parse', '--verify', '--quiet', ref);
      return true;
    } catch {
      return false;
    }
  });
  const commits = against
    ? io.git(cwd, 'log', '--oneline', `${against}..${branch}`)
    : '(base not fetched)';
  const stat = against ? io.git(cwd, 'diff', '--stat', `${against}...${branch}`) : '';
  io.print(
    `Publication plan\nBranch: ${branch}\nTarget remote: ${remote}\nOpening the PR on: ${nameWithOwner}${own.isFork && own.parent?.nameWithOwner ? ` (a fork of ${own.parent.nameWithOwner}; pass --repo ${own.parent.nameWithOwner} to open it there)` : ''}\nBase: ${base}\nCommits:\n${commits}\nDiffstat:\n${stat}`,
  );
  // The description is checked before anything is pushed: GitHub refuses a longer one, and a
  // refusal after the push leaves a branch with no PR.
  const body = (io.readBody ?? ((file: string) => readFileSync(file, 'utf8')))(report.prBody);
  if (body.length > GITHUB_BODY_LIMIT)
    throw new UptideError(
      'PUBLICATION_REFUSED',
      `the PR description is ${body.length.toLocaleString('en-US')} characters; GitHub accepts ${GITHUB_BODY_LIMIT.toLocaleString('en-US')}. Nothing was pushed. \`uptide pr --branch ${branch}\` renders it again within the limit`,
    );
  if (!yes) throw new Error('publication requires --yes; nothing pushed');
  if (io.git(cwd, 'rev-parse', branch) !== head)
    throw new Error('HEAD changed after publication planning');
  // The label is a convenience. A token that cannot read or create labels (no triage right,
  // an organization's SSO not authorized for it) must not cost a verified run its PR.
  const labelled = await ensureLabel(cwd, nameWithOwner, io);
  if (!labelled.ok)
    io.print(
      `Warning: the \`uptide\` label could not be ${labelled.step} (${firstLine(labelled.output)}); opening the PR without it.`,
    );
  // Idempotent: a branch already on the remote at the verified commit is not pushed again.
  const remoteHead = remoteBranchHead(cwd, branch, io);
  if (remoteHead === head)
    io.print(`${branch} is already on origin at ${head.slice(0, 12)}; not pushed again.`);
  else io.git(cwd, 'push', '--set-upstream', 'origin', `${branch}:${branch}`);
  // ...and a PR already open for the branch gets this description instead of a second PR.
  const existing = await io.command(cwd, 'gh', [
    'pr',
    'list',
    '--repo',
    nameWithOwner,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number,url',
  ]);
  let open: { number: number; url: string } | undefined;
  try {
    // An answer that cannot be read means no PR is known: one is created, as before.
    if (!existing.code)
      open = (JSON.parse(existing.output.trim() || '[]') as { number: number; url: string }[])[0];
  } catch {
    open = undefined;
  }
  if (open) {
    let edited = await io.command(cwd, 'gh', [
      'pr',
      'edit',
      String(open.number),
      '--repo',
      nameWithOwner,
      '--body-file',
      report.prBody,
    ]);
    // `gh pr edit` fails on repositories where GitHub retired classic projects; REST does not.
    if (edited.code && /projectCards|Projects \(classic\)/.test(edited.output))
      edited = await io.command(cwd, 'gh', [
        'api',
        '--method',
        'PATCH',
        `repos/${nameWithOwner}/pulls/${open.number}`,
        '--field',
        `body=@${report.prBody}`,
        '--silent',
      ]);
    if (edited.code)
      throw new Error(`cannot update the description of ${open.url}: ${edited.output}`);
    io.print(`A pull request is already open for ${branch}: its description was updated.`);
    return open.url;
  }
  const create = (label: boolean) =>
    io.command(cwd, 'gh', [
      'pr',
      'create',
      '--repo',
      nameWithOwner,
      ...(options.draft === false ? [] : ['--draft']),
      '--base',
      base,
      ...(label ? ['--label', 'uptide'] : []),
      '--title',
      report.mode === 'pin'
        ? `Pin the Stripe API version to ${report.apiVersion ?? ''}`.trim()
        : `Upgrade ${report.package} to ${report.target}`,
      '--body-file',
      report.prBody,
      '--head',
      headRef,
    ]);
  let result = await create(labelled.ok);
  if (result.code && labelled.ok && /label/i.test(result.output)) {
    // The label exists but this token may not apply it: the PR matters, the label does not.
    io.print(
      `Warning: the \`uptide\` label could not be applied (${firstLine(result.output)}); opening the PR without it.`,
    );
    result = await create(false);
  }
  if (result.code) throw new Error(`gh pr create failed: ${result.output}`);
  const url = result.output.match(/https:\/\/[^\s]+\/pull\/\d+/g)?.at(-1);
  if (!url) throw new Error(`gh did not return a pull request URL: ${result.output}`);
  return url;
}
