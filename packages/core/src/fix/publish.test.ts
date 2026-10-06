import { expect, it } from 'vitest';
import { publicationBlockers, publish, publishTarget } from './publish.js';
import { publishVerified } from './run.js';
import type { FixReport } from './types.js';

const report = {
  repo: '/repo',
  package: 'zod',
  target: '4.6.5',
  branch: 'uptide/zod-4.6.5',
  verification: { passed: true },
  prBody: '/repo/.uptide/pr-body.md',
} as FixReport;
function mock() {
  const calls: string[][] = [];
  const printed: string[] = [];
  return {
    calls,
    printed,
    io: {
      git: (_root: string, ...args: string[]) => {
        calls.push(['git', ...args]);
        if (args[0] === 'branch') return report.branch;
        if (args[0] === 'remote') return 'https://github.com/owner/demo.git';
        return 'abc';
      },
      command: async (_root: string, bin: string, args: string[]) => {
        calls.push([bin, ...args]);
        return {
          code: 0,
          timeout: false,
          output:
            (args[0] === 'label' || args[0] === 'pr') && args[1] === 'list'
              ? '[]'
              : args[0] === 'repo'
                ? JSON.stringify(
                    args[2] === 'them/upstream'
                      ? { defaultBranchRef: { name: 'main' }, nameWithOwner: 'them/upstream' }
                      : {
                          defaultBranchRef: { name: 'main' },
                          nameWithOwner: 'owner/demo',
                          isFork: true,
                          parent: { name: 'upstream', owner: { login: 'them' } },
                        },
                  )
                : 'https://github.com/owner/demo/pull/1',
        };
      },
      print: (s: string) => printed.push(s),
      readBody: (): string => '## Upgrade zod\n',
    },
  };
}
it('prints a reviewable plan but never pushes or changes labels without --yes', async () => {
  const m = mock();
  await expect(publish(report, false, m.io)).rejects.toThrow('--yes');
  expect(m.printed.join('')).toContain('Diffstat:');
  expect(m.calls.some((c) => c.includes('push') || c.includes('label'))).toBe(false);
});
it('uses the default branch, a draft and the uptide label; never merges or requests reviewers', async () => {
  const m = mock();
  expect(await publish(report, true, m.io)).toContain('/pull/1');
  const args = m.calls.find((c) => c[1] === 'pr' && c[2] === 'create');
  expect(args).toContain('--draft');
  expect(args).toContain('--base');
  expect(args).toContain('main');
  expect(args).toContain('uptide');
  expect(m.calls.flat()).not.toContain('--reviewer');
  expect(m.calls.flat()).not.toContain('merge');
});
it('rejects failed verification before any remote calls', async () => {
  const m = mock();
  await expect(
    publish({ ...report, verification: { ...report.verification, passed: false } }, true, m.io),
  ).rejects.toThrow('unverified');
  expect(m.calls).toEqual([]);
});

it('names what failed, and refuses a run produced by a dirty Uptide checkout', async () => {
  const clean = { uptideDirty: false };
  const failed = {
    ...report,
    verification: {
      passed: false,
      newErrors: [{ file: 'a.ts', line: 1, column: 1, code: 2322, message: 'x' }],
      tests: [{ workspace: 'packages/api', status: 'failed', output: '' }],
    },
  } as unknown as FixReport;
  expect(publicationBlockers(report, clean)).toEqual([]);
  expect(publicationBlockers(failed, clean)).toEqual([
    'verification failed: 1 new type error, tests failed in packages/api',
  ]);
  expect(publicationBlockers({ ...report, verificationPending: true }, clean)).toEqual([
    'verification has not run',
  ]);
  for (const dirty of [
    publicationBlockers({ ...report, uptideDirty: true }, clean),
    publicationBlockers(report, { uptideDirty: true }),
  ])
    expect(dirty).toEqual([expect.stringMatching(/checkout with uncommitted changes/)]);
  const m = mock();
  await expect(publish({ ...report, uptideDirty: true }, true, m.io)).rejects.toThrow(
    /uncommitted changes/,
  );
  expect(m.calls).toEqual([]);
});
it('treats gh empty search output as no label and creates it before pushing', async () => {
  const m = mock();
  const command = m.io.command;
  m.io.command = async (root, bin, args) =>
    args[0] === 'label' && args[1] === 'list'
      ? { code: 0, timeout: false, output: '' }
      : command(root, bin, args);
  await publish(report, true, m.io);
  expect(m.calls.some((c) => c[1] === 'label' && c[2] === 'create')).toBe(true);
});

it('extracts only the PR URL when gh warns about the deliberately untracked report', async () => {
  const m = mock();
  const command = m.io.command;
  m.io.command = async (root, bin, args) =>
    args[0] === 'pr'
      ? {
          code: 0,
          timeout: false,
          output: 'Warning: 1 uncommitted change\nhttps://github.com/owner/demo/pull/1\n',
        }
      : command(root, bin, args);
  expect(await publish(report, true, m.io)).toBe('https://github.com/owner/demo/pull/1');
});

it("publishes a stored run from the user's repository: the fork itself by default, the parent only when named", async () => {
  const m = mock();
  const stored = { ...report, head: 'abc' };
  expect(await publish(stored, true, m.io, { cwd: '/user/repo', draft: false })).toContain(
    '/pull/1',
  );
  expect(m.printed.join('')).toContain(
    'Opening the PR on: owner/demo (a fork of them/upstream; pass --repo them/upstream to open it there)',
  );
  const create = m.calls.find((c) => c[1] === 'pr' && c[2] === 'create') as string[];
  expect(create).toContain('owner/demo');
  expect(create).not.toContain('--draft');
  expect(create[create.indexOf('--head') + 1]).toBe('uptide/zod-4.6.5');
  expect(m.calls).toContainEqual([
    'git',
    'push',
    '--set-upstream',
    'origin',
    'uptide/zod-4.6.5:uptide/zod-4.6.5',
  ]);
  // The branch is not checked out there, so the current branch is never consulted.
  expect(m.calls.some((c) => c[1] === 'branch')).toBe(false);
  const upstream = mock();
  await publish(stored, true, upstream.io, { cwd: '/user/repo', repo: 'them/upstream' });
  const onParent = upstream.calls.find((c) => c[1] === 'pr' && c[2] === 'create') as string[];
  expect(onParent).toContain('them/upstream');
  expect(onParent[onParent.indexOf('--head') + 1]).toBe('owner:uptide/zod-4.6.5');
  // A branch that moved since the run is not published.
  const moved = mock();
  await expect(
    publish({ ...report, head: 'def' }, true, moved.io, { cwd: '/user/repo' }),
  ).rejects.toThrow('run `npx uptide verify --branch uptide/zod-4.6.5` first');
  expect(moved.calls.some((c) => c.includes('push'))).toBe(false);
});

it('resolves where a --pr run will open its PR before any work, and needs gh signed in', async () => {
  const m = mock();
  expect(await publishTarget('/user/repo', undefined, m.io)).toEqual({
    nameWithOwner: 'owner/demo',
    base: 'main',
    parent: 'them/upstream',
  });
  expect(await publishTarget('/user/repo', 'them/upstream', m.io)).toMatchObject({
    nameWithOwner: 'them/upstream',
  });
  expect(m.calls[0]).toEqual(['gh', 'auth', 'status']);
  const signedOut = mock();
  const command = signedOut.io.command;
  signedOut.io.command = async (cwd, bin, args) =>
    args[0] === 'auth'
      ? { code: 1, timeout: false, output: 'You are not logged into any GitHub hosts.' }
      : command(cwd, bin, args);
  await expect(publishTarget('/user/repo', undefined, signedOut.io)).rejects.toThrow(
    'run `gh auth login`',
  );
});

it('records a publish step that fails instead of throwing, and treats a missing --yes as a plan', async () => {
  const failing = mock();
  const command = failing.io.command;
  failing.io.command = async (cwd, bin, args) =>
    args[0] === 'pr'
      ? { code: 1, timeout: false, output: 'HTTP 502: Bad Gateway' }
      : command(cwd, bin, args);
  const run = { ...report, head: 'abc', notes: [] as string[] } as FixReport;
  await publishVerified(
    run,
    { tool: { uptideDirty: false }, yes: true, cwd: '/user/repo' },
    failing.io,
  );
  expect(run.prUrl).toBeUndefined();
  expect(run.publication).toEqual({
    refused: [],
    failed: 'gh pr create failed: HTTP 502: Bad Gateway',
  });
  expect(run.notes.at(-1)).toContain(
    '`npx uptide pr --branch uptide/zod-4.6.5 --yes` retries the publish step alone',
  );
  const planned = { ...report, head: 'abc', notes: [] as string[] } as FixReport;
  await publishVerified(planned, { tool: { uptideDirty: false }, cwd: '/user/repo' }, mock().io);
  expect(planned.publication).toBeUndefined();
  expect(planned.notes.at(-1)).toContain('Publication plan printed, nothing pushed (no --yes)');
  // The plan is kept on the run for the caller to print; nothing is written under a spinner.
  expect(planned.publicationLog).toContain('Publication plan\nBranch: uptide/zod-4.6.5');
});

it('never fails a verified run over the label: opens the PR without it and says so once', async () => {
  // HTTP 404 on POST /labels: a token that can read the repository but not write labels.
  const m = mock();
  const command = m.io.command;
  m.io.command = async (cwd, bin, args) =>
    args[0] === 'label' && args[1] === 'create'
      ? {
          code: 1,
          timeout: false,
          output: 'HTTP 404: Not Found (https://api.github.com/repos/owner/demo/labels)',
        }
      : command(cwd, bin, args);
  expect(await publish(report, true, m.io)).toContain('/pull/1');
  const create = m.calls.find((c) => c[1] === 'pr' && c[2] === 'create') as string[];
  expect(create).not.toContain('--label');
  expect(m.printed.filter((p) => p.startsWith('Warning:'))).toEqual([
    'Warning: the `uptide` label could not be created (HTTP 404: Not Found (https://api.github.com/repos/owner/demo/labels)); opening the PR without it.',
  ]);
  // The label exists but cannot be applied: one retry without it.
  const apply = mock();
  const base = apply.io.command;
  let attempts = 0;
  apply.io.command = async (cwd, bin, args) => {
    if (args[0] === 'label' && args[1] === 'list')
      return { code: 0, timeout: false, output: '[{"name":"uptide"}]' };
    if (args[0] === 'pr' && args.includes('--label') && ++attempts)
      return { code: 1, timeout: false, output: "could not add label: 'uptide' not found" };
    return base(cwd, bin, args);
  };
  expect(await publish(report, true, apply.io)).toContain('/pull/1');
  expect(attempts).toBe(1);
  expect(apply.printed.some((p) => p.includes('could not be applied'))).toBe(true);
});

it('refuses --pr before any work when the account cannot push, or the token cannot see the repository', async () => {
  const readOnly = mock();
  const command = readOnly.io.command;
  readOnly.io.command = async (cwd, bin, args) =>
    args[0] === 'repo'
      ? {
          code: 0,
          timeout: false,
          output: JSON.stringify({
            defaultBranchRef: { name: 'main' },
            nameWithOwner: 'owner/demo',
            viewerPermission: 'READ',
          }),
        }
      : command(cwd, bin, args);
  const refused = await publishTarget('/user/repo', undefined, readOnly.io).catch(
    (e: Error) => e.message,
  );
  expect(refused).toContain(
    '--pr needs push access to owner/demo; this account has read access only.',
  );
  expect(refused).toContain('gh repo fork owner/demo --clone');
  expect(refused).toContain('https://github.com/orgs/owner/sso');
  expect(refused).toContain('Nothing was cloned or changed.');
  const hidden = mock();
  const view = hidden.io.command;
  hidden.io.command = async (cwd, bin, args) =>
    args[0] === 'auth'
      ? { code: 0, timeout: false, output: "  - Token scopes: 'gist', 'read:org'" }
      : args[0] === 'repo'
        ? {
            code: 1,
            timeout: false,
            output:
              "GraphQL: Could not resolve to a Repository with the name 'owner/demo'. (repository)",
          }
        : view(cwd, bin, args);
  const unseen = await publishTarget('/user/repo', undefined, hidden.io).catch(
    (e: Error) => e.message,
  );
  expect(unseen).toContain(
    '--pr cannot reach https://github.com/owner/demo.git with the GitHub token',
  );
  expect(unseen).toContain(
    "the token lacks the `repo` scope (it does: its scopes are 'gist', 'read:org'): gh auth refresh -h github.com -s repo",
  );
  expect(unseen).toContain(
    'owner enforces SSO and the token is not authorized for it: https://github.com/orgs/owner/sso',
  );
});

it('checks the description size before anything is pushed', async () => {
  const m = mock();
  m.io.readBody = () => 'x'.repeat(65_537);
  await expect(publish(report, true, m.io)).rejects.toThrow(
    'the PR description is 65,537 characters; GitHub accepts 65,536. Nothing was pushed.',
  );
  expect(m.calls.some((c) => c.includes('push') || c[1] === 'pr')).toBe(false);
});

it('is idempotent: no second push of the verified commit, and an open PR gets its body updated', async () => {
  const m = mock();
  const git = m.io.git;
  m.io.git = (root, ...args) =>
    args[0] === 'ls-remote' ? `${'a'.repeat(40)}\trefs/heads/uptide/zod-4.6.5` : git(root, ...args);
  const command = m.io.command;
  m.io.command = async (cwd, bin, args) =>
    args[0] === 'pr' && args[1] === 'list'
      ? {
          code: 0,
          timeout: false,
          output: '[{"number":7,"url":"https://github.com/owner/demo/pull/7"}]',
        }
      : command(cwd, bin, args);
  // The mock's rev-parse answers 'abc'; make the remote agree with it.
  m.io.git = (root, ...args) =>
    args[0] === 'ls-remote'
      ? `${'abc'.padEnd(40, '0')}\trefs/heads/uptide/zod-4.6.5`
      : args[0] === 'rev-parse'
        ? 'abc'.padEnd(40, '0')
        : git(root, ...args);
  const url = await publish({ ...report, head: 'abc'.padEnd(40, '0') }, true, m.io, {
    cwd: '/user/repo',
  });
  expect(url).toBe('https://github.com/owner/demo/pull/7');
  expect(m.calls.some((c) => c.includes('push'))).toBe(false);
  expect(m.calls.some((c) => c[1] === 'pr' && c[2] === 'create')).toBe(false);
  expect(m.calls).toContainEqual([
    'gh',
    'pr',
    'edit',
    '7',
    '--repo',
    'owner/demo',
    '--body-file',
    '/repo/.uptide/pr-body.md',
  ]);
  expect(m.printed.join('\n')).toContain('already on origin at abc000000000; not pushed again.');
  expect(m.printed.join('\n')).toContain('its description was updated');
});
