/** Trusted Action entry point. Consumer work is confined to temporary git worktrees. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { githubComments, type PullEvent } from '../packages/core/src/action/github.ts';
import { type ActionServices, runAction } from '../packages/core/src/action/run.ts';
import { check } from '../packages/core/src/check/check.ts';
import { diagnostics, testWorkspaces } from '../packages/core/src/fix/verify.ts';
import { install } from '../packages/core/src/fix/versions.ts';

const env = process.env;
const token = env.UPTIDE_GITHUB_TOKEN ?? '';
const apiKey = env.UPTIDE_ANTHROPIC_API_KEY || undefined;
// Credentials stay in the orchestrator and are never inherited by installs/tests.
for (const key of Object.keys(env))
  if (/(?:TOKEN|SECRET|API_KEY|PASSWORD)/i.test(key)) delete env[key];
env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'uptide[bot]';
env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'uptide@users.noreply.github.com';
if (!token) throw new Error('github-token is required for the sticky PR comment');
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8')) as PullEvent;
const only = (env.UPTIDE_ONLY ?? 'zod,stripe').split(/[\s,]+/).filter(Boolean);
if (only.some((p) => p !== 'zod' && p !== 'stripe')) throw new Error('only supports zod,stripe');
const repository = env.GITHUB_REPOSITORY ?? '';
const api = env.GITHUB_API_URL ?? 'https://api.github.com';
const comments = githubComments(repository, event.number, token, api);
const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
const remote = `${server}/${repository}.git`;
const services: ActionServices = {
  // PR-derived names are always explicit; discovery is a separate CLI step (uptide list).
  check,
  install,
  diagnostics,
  tests: testWorkspaces,
  async push(root, _remote, branch) {
    // Temporary HTTP configuration: never persist a token in .git/config or put it in argv.
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', 'push', remote, `HEAD:refs/heads/${branch}`],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...env,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `http.${server}/.extraheader`,
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
        },
      },
    );
  },
};
const result = await runAction(
  {
    cwd: env.GITHUB_WORKSPACE ?? '.',
    repository,
    event,
    only: only as ('zod' | 'stripe')[],
    paths: (env.UPTIDE_PATHS ?? '')
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    fix: env.UPTIDE_FIX === 'true',
    apiKey,
    remote,
  },
  comments,
  services,
);
console.log(result.comment);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${result.comment}\n`);
if (env.GITHUB_OUTPUT)
  appendFileSync(
    env.GITHUB_OUTPUT,
    `commit=${result.commit ?? ''}\nskipped=${result.skipped ?? ''}\n`,
  );
writeFileSync(
  join(env.RUNNER_TEMP ?? '/tmp', 'uptide-action-result.json'),
  JSON.stringify(result, null, 2),
);
