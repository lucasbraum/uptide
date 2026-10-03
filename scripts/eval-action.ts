/** Local Renovate PR simulation: real check/fix/tsc/tests/git push, an in-process GitHub API double. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { githubComments, type PullEvent } from '../packages/core/src/action/github.ts';
import { type ActionServices, runAction } from '../packages/core/src/action/run.ts';
import { check } from '../packages/core/src/check/check.ts';
import { command, git } from '../packages/core/src/fix/process.ts';
import { diagnostics, testWorkspaces } from '../packages/core/src/fix/verify.ts';
import { install } from '../packages/core/src/fix/versions.ts';

const out = resolve(
  process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'eval-out/action-demo',
);
const root = join(out, 'repo'),
  remote = join(out, 'origin.git');
if (existsSync(join(root, '.git')))
  throw new Error('Use a fresh --out directory; existing demo is retained');
mkdirSync(out, { recursive: true });
cpSync('fixtures/repos/action-consumer', root, { recursive: true });
git(root, 'init', '-b', 'main');
git(root, 'config', 'user.name', 'Uptide demo');
git(root, 'config', 'user.email', 'uptide@example.test');
assert.equal(
  (await command(root, 'pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts'])).code,
  0,
  'fixture lockfile generation',
);
git(root, 'add', '.');
git(root, 'commit', '-m', 'demo: zod 3 schema with custom messages');
const base = git(root, 'rev-parse', 'HEAD');
execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
git(root, 'remote', 'add', 'origin', remote);
git(root, 'push', '-u', 'origin', 'main');
const branch = 'renovate/zod-4.x';
git(root, 'switch', '-c', branch);
const p = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
p.dependencies.zod = '4.6.5';
writeFileSync(join(root, 'package.json'), `${JSON.stringify(p, null, 2)}\n`);
assert.equal(
  (await command(root, 'pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts'])).code,
  0,
  'fixture lockfile generation',
);
git(root, 'add', 'package.json', 'pnpm-lock.yaml');
git(root, 'commit', '-m', 'chore(deps): update dependency zod to v4');
git(root, 'push', '-u', 'origin', branch);
const head = git(root, 'rev-parse', 'HEAD');
const event: PullEvent = {
  action: 'opened',
  number: 1,
  repository: { full_name: 'demo/uptide-action-demo' },
  pull_request: {
    user: { login: 'renovate[bot]' },
    head: { sha: head, ref: branch, repo: { full_name: 'demo/uptide-action-demo' } },
    base: { sha: base, repo: { full_name: 'demo/uptide-action-demo' } },
  },
};
writeFileSync(join(out, 'event.json'), JSON.stringify(event, null, 2));
const posted: { id: number; body: string; user: { type: string } }[] = [];
let creates = 0,
  updates = 0;
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  let data: unknown;
  if (req.url?.includes('/pulls/'))
    data = { head: { sha: git(root, 'ls-remote', remote, `refs/heads/${branch}`).split(/\s/)[0] } };
  else if (req.method === 'GET') data = posted;
  else if (req.method === 'POST') {
    creates++;
    posted.push({ id: 1, body: body.body, user: { type: 'Bot' } });
    data = posted[0];
  } else if (req.method === 'PATCH') {
    updates++;
    assert(posted[0]);
    posted[0].body = body.body;
    data = posted[0];
  } else {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(data));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const address = server.address();
assert(address && typeof address === 'object');
try {
  const comments = githubComments(
    event.repository.full_name,
    1,
    'local-test-token',
    `http://127.0.0.1:${address.port}`,
  );
  const options = {
    cwd: root,
    repository: event.repository.full_name,
    event,
    only: ['zod' as const],
    paths: ['src/**'],
    fix: true,
    apiKey: 'mechanical-test-no-api-call',
    remote,
  };
  const result = await runAction(options, comments);
  assert(result.commit, 'expected one migration commit');
  assert.equal(result.fixes[0]?.llm.inputTokens, 0);
  assert.equal(creates, 1);
  assert.equal(posted.length, 1);
  assert(updates >= 1);
  assert.equal(git(root, 'rev-parse', `${result.commit}^`), head);
  assert.equal(
    git(root, 'log', '-1', '--format=%s', result.commit),
    'uptide: migrate code for zod 4.6.5',
  );
  assert.equal(git(root, 'diff', '--name-only', head, result.commit), 'src/schema.ts');
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  writeFileSync(join(out, 'comment.md'), posted[0]?.body ?? '');
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  writeFileSync(join(out, 'migration.diff'), `${git(root, 'diff', head, result.commit)}\n`);
  console.log(posted[0]?.body);
  console.log(
    `\nLocal origin: ${remote}\nCommit: ${result.commit}\nSticky comment: ${creates} created, ${updates} updated`,
  );
  // A failure after the pack's own verification still must not publish to the PR.
  let pushes = 0;
  const services: ActionServices = {
    check,
    install,
    tests: testWorkspaces,
    diagnostics: (dir, ws) => [
      ...diagnostics(dir, ws),
      ...(basename(dir) === 'head'
        ? [
            {
              file: 'src/schema.ts',
              line: 1,
              column: 1,
              code: 9999,
              message: 'injected final verification failure',
            },
          ]
        : []),
    ],
    push: async () => {
      pushes++;
    },
  };
  const failed = await runAction(
    options,
    { head: async () => head, comment: async () => {} },
    services,
  );
  assert.equal(pushes, 0);
  assert.equal(failed.commit, undefined);
  assert.match(failed.comment, /PR-head verification failed/);
  console.log('Failure-path test: final PR-head verification failure produces no push.');
  // Keep both the original bump and the migrated branch for the human-hosted demo.
  git(root, 'fetch', 'origin');
  git(root, 'branch', 'uptide-demo-result', result.commit);
  writeFileSync(
    join(out, 'README.md'),
    `# Local Uptide Action demo\n\nNo GitHub repository was created or pushed. main is the zod 3 baseline; ${branch} is the untouched Renovate-style bump; uptide-demo-result contains the verified single migration commit.\n\nAfter creating an empty public GitHub repository:\n\n\`\`\`sh\ncd ${root}\ngit remote rename origin local-test\ngit remote add origin https://github.com/YOUR_ORG/uptide-action-demo.git\ngit push -u origin main ${branch}\n\`\`\`\n\nA human-authored PR intentionally fails the bot-author gate. Enable Renovate/Dependabot to open the real bot PR. Add the example workflow with the published Uptide commit pinned; no pretend hosted Action run is claimed here.\n`,
  );
} finally {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}
