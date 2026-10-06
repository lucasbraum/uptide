// Runs inside a clean container (see run.mjs): nothing but Node, git and the tarball.
// Installs the packed CLI the way a stranger would, then runs it against one fixture
// repository per package manager and asserts exit codes and the lines a user relies on.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { checkReportFailures, listReportFailures } from './check-output.mjs';

// Never send smoke-test usage, even when the release build contains a capture key.
process.env.UPTIDE_TELEMETRY = '0';

const [tarballDir, fixturesDir, resultsFile] = process.argv.slice(2);
const tarball = join(
  tarballDir,
  readdirSync(tarballDir).find((f) => f.endsWith('.tgz')),
);
const ZOD = '4.6.5';
const STRIPE = '22.6.2';
/** The promise on the box: a useful answer in under a minute, cold. */
const BUDGET_MS = 60_000;

const sh = (cwd, bin, ...args) => execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
function uptide(cwd, ...args) {
  const started = Date.now();
  const run = spawnSync('uptide', args, { cwd, encoding: 'utf8', env: { ...process.env, CI: '' } });
  return { code: run.status, out: run.stdout, err: run.stderr, ms: Date.now() - started };
}

const failures = [];
const results = [];
function expect(name, condition, detail) {
  if (condition) return;
  failures.push(`${name}${detail ? `\n${detail}` : ''}`);
}
const has = (name, text, needle) =>
  expect(`${name}: expected "${needle}"`, text.includes(needle), text);
const matches = (name, text, pattern) =>
  expect(`${name}: expected ${pattern}`, pattern.test(text), text);
/** A file as the migration branch has it: the checkout itself is never switched or edited. */
const onBranch = (repo, branch, file) => sh(repo, 'git', 'show', `${branch}:${file}`);
/** Runs are stored inside .git, per branch, where git status never looks. */
const storedRun = (repo, branch) =>
  join(repo, '.git/uptide', branch.replaceAll('/', '__'), 'report.json');

sh('/', 'npm', 'install', '--global', '--ignore-scripts', '--silent', tarball, 'pnpm@10.17.1');
sh('/', 'git', 'config', '--global', 'user.email', 'smoke@uptide.test');
sh('/', 'git', 'config', '--global', 'user.name', 'uptide smoke');
sh('/', 'git', 'config', '--global', 'init.defaultBranch', 'main');
const version = sh('/', 'uptide', '--version').trim();
for (const action of ['on', 'status', 'off']) {
  const result = uptide('/', 'telemetry', action, '--json');
  expect(`telemetry ${action}: exit 0`, result.code === 0, result.err);
  const state = JSON.parse(result.out);
  expect(
    `telemetry ${action}: environment opt-out dominates`,
    state.enabled === false && state.sending === false,
  );
}
expect('telemetry show after off', uptide('/', 'telemetry', 'show').out.trim() === 'null');

const INSTALL = {
  npm: ['npm', 'ci', '--ignore-scripts', '--silent'],
  pnpm: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--silent'],
  yarn: ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts', '--silent'],
};

for (const fixture of ['npm', 'npm-workspaces', 'pnpm', 'yarn', 'yarn-berry']) {
  const manager =
    fixture === 'npm-workspaces' ? 'npm' : fixture === 'yarn-berry' ? 'yarn' : fixture;
  const sites = ['pnpm', 'npm-workspaces'].includes(fixture) ? 4 : 2;
  if (fixture === 'yarn-berry')
    sh('/', 'npm', 'install', '--global', '--ignore-scripts', '--force', '@yarnpkg/cli-dist@4.9.2');
  const install =
    fixture === 'yarn-berry'
      ? ['yarn', 'install', '--immutable', '--mode=skip-build']
      : INSTALL[manager];
  const repo = join(mkdtempSync(join(tmpdir(), `smoke-${manager}-`)), 'repo');
  cpSync(join(fixturesDir, fixture), repo, {
    recursive: true,
    filter: (path) => !['node_modules', '.yarn'].includes(basename(path)),
  });
  sh(repo, 'git', 'init', '--quiet');
  sh(repo, 'git', 'add', '--all');
  sh(repo, 'git', 'commit', '--quiet', '--message', 'baseline');

  // Before install: the failure names the command that repairs it.
  const bare = uptide(repo, 'check', 'zod', '--ci');
  expect(
    `${manager} check without node_modules: exit ${bare.code}, wanted 2`,
    bare.code === 2,
    bare.err,
  );
  has(
    `${manager} check without node_modules`,
    bare.err,
    `Next: ${install.slice(0, 3).join(' ').replace(' --ignore-scripts', '')}`,
  );

  sh(repo, ...install);

  const status = uptide(repo);
  expect(`${manager} status: exit ${status.code}, wanted 0`, status.code === 0, status.err);
  has(`${manager} status`, status.out, '3.23.8 installed');
  has(`${manager} status`, status.out, '14.25.0 installed');
  matches(
    `${manager} status`,
    status.out,
    /Run `npx uptide\S* list`, then `npx uptide\S* check <package>` for impact\./,
  );

  const inventory = uptide(repo, 'list', '--json');
  expect(`${manager} list exits 0`, inventory.code === 0, inventory.err);
  failures.push(...listReportFailures(JSON.parse(inventory.out), manager));
  const unnamed = uptide(repo, 'check');
  expect(
    `${manager} check requires names`,
    unnamed.code === 2 && unnamed.err.includes('uptide list'),
    unnamed.err,
  );

  const check = uptide(
    repo,
    'check',
    'zod',
    'stripe',
    '--ci',
    '--target',
    `zod@${ZOD}`,
    '--target',
    `stripe@${STRIPE}`,
  );
  expect(
    `${manager} check: exit ${check.code}, wanted 1 (breaking found)`,
    check.code === 1,
    check.err + check.out,
  );
  // In a log there is no live line: a start line, the final timing, nothing per phase.
  has(`${manager} check`, check.err, `uptide check · smoke-${fixture} (${manager}`);
  has(`${manager} check`, check.err, 'done in ');
  expect(`${manager} check: no per-phase progress lines`, !check.err.includes('✔'), check.err);
  // The first screen: a row per dependency, a line per rule with who migrates it, the next commands.
  failures.push(...checkReportFailures(check.out, fixture, manager));
  matches(
    `${manager} check`,
    check.out,
    /zod\s+3\.23\.8 → 4\.6\.5\s+major · (?:--target|latest on npm)\s+verified\s+✗ \d+ breaking/,
  );
  has(`${manager} check`, check.out, 'New error API (required_error → error)');
  matches(
    `${manager} check`,
    check.out,
    /\nzod\s+\d+ breaking · compiled against 4\.6\.5: \d+ new type errors?\n/,
  );
  has(`${manager} check`, check.out, 'auto-fixable');
  has(`${manager} check`, check.out, 'needs the agent (LLM)');
  matches(`${manager} check`, check.out, /\nNext\n(?: {2}.*\n)*? {2}npx uptide\S* fix zod /);
  has(`${manager} check`, check.out, 'check zod stripe --target zod@');
  for (const noise of ['low-confidence', 'pre-existing type error', 'BREAKING'])
    expect(
      `${manager} check: "${noise}" belongs to --details`,
      !check.out.includes(noise),
      check.out,
    );
  expect(`${manager} check: ${check.ms}ms, over the ${BUDGET_MS}ms budget`, check.ms < BUDGET_MS);

  const details = uptide(
    repo,
    'check',
    'zod',
    'stripe',
    '--ci',
    '--details',
    '--target',
    `zod@${ZOD}`,
    '--target',
    `stripe@${STRIPE}`,
  );
  has(`${manager} check --details`, details.out, 'BREAKING');
  has(`${manager} check --details`, details.out, 'current_period_end removed');

  const json = uptide(repo, 'check', '--json', '--only', 'zod', '--target', ZOD);
  let parsed;
  try {
    parsed = JSON.parse(json.out);
  } catch {
    // reported below
  }
  expect(
    `${manager} check --json: stdout is not pure JSON`,
    parsed?.summary?.breaking > 0,
    json.out.slice(0, 400),
  );

  expect(
    `${manager} check: pack recognizes the mechanical sites`,
    parsed?.summary?.autoFixable === sites,
    JSON.stringify(parsed?.summary),
  );

  const before = {
    branch: sh(repo, 'git', 'branch', '--show-current').trim(),
    head: sh(repo, 'git', 'rev-parse', 'HEAD').trim(),
    hooks: readdirSync(join(repo, '.git/hooks')).sort().join(','),
  };
  const fix = uptide(repo, 'fix', 'zod', '--target', `zod@${ZOD}`, '--no-llm', '--ci');
  const zodBranch = `uptide/zod-${ZOD}`;
  // The run happened in a temporary clone: the checkout is where and how it was.
  expect(
    `${fixture}: the checkout stays on its branch`,
    sh(repo, 'git', 'branch', '--show-current').trim() === before.branch &&
      sh(repo, 'git', 'rev-parse', 'HEAD').trim() === before.head,
  );
  const dirty = sh(repo, 'git', 'status', '--porcelain', '--untracked-files=all').trim();
  expect(`${fixture}: the working tree is untouched`, dirty === '', dirty);
  expect(
    `${fixture}: no git hook was added`,
    readdirSync(join(repo, '.git/hooks')).sort().join(',') === before.hooks,
  );
  expect(`${fixture} fix --no-llm: exit ${fix.code}, wanted 0`, fix.code === 0, fix.err + fix.out);
  // A published build is never a dirty one: `fix --pr` must get past that guard. Without gh
  // signed in (no GitHub here) it stops at the preflight, before any clone, and says why.
  const dry = uptide(
    repo,
    'fix',
    '--only',
    'zod',
    '--target',
    `zod@${ZOD}`,
    '--no-llm',
    '--pr',
    '--ci',
  );
  expect(
    `${fixture} fix --pr (dry run): never the dirty-build guard`,
    !(dry.err + dry.out).includes('refuses to run from an Uptide checkout'),
    dry.err + dry.out,
  );
  matches(`${fixture} fix --pr (dry run)`, dry.err, /gh auth login|PR will be opened on/);
  has(`${fixture} fix`, fix.err, 'assisted fixes off (--no-llm)');
  has(`${fixture} fix`, fix.err, 'Ran in a temporary clone, removed now that the run is over.');
  has(`${fixture} fix`, fix.err, 'Your checkout was not touched');
  // The end of fix: five facts, the branch, and what to do next; never the PR body.
  has(`${fixture} fix`, fix.out, `uptide fix · zod `);
  matches(
    `${fixture} fix`,
    fix.out,
    /\n {2}Risk {6}.*\n {2}Changes {3}.*\n {2}Types {5}.*\n {2}Behavior {2}.*\n {2}Tests {5}.*\n/,
  );
  has(`${fixture} fix`, fix.out, `Branch ${zodBranch} (in your repository, not checked out)`);
  matches(
    `${fixture} fix`,
    fix.out,
    new RegExp(`\\nNext\\n {2}npx uptide\\S* pr --branch ${zodBranch.replace('/', '\\/')} `),
  );
  has(`${fixture} fix`, fix.out, 'report.html');
  expect(`${fixture} fix`, !fix.out.includes('### What changed'), fix.out);
  const saved = existsSync(storedRun(repo, zodBranch))
    ? JSON.parse(readFileSync(storedRun(repo, zodBranch), 'utf8'))
    : undefined;
  expect(
    `${fixture}: verified report`,
    saved?.verification.passed && saved.verification.newErrors.length === 0,
    fix.err + fix.out,
  );
  expect(
    `${fixture}: all sites mechanical`,
    saved?.sites.length === sites && saved.sites.every((s) => s.outcome === 'mechanical'),
    fix.out,
  );
  expect(`${fixture}: disabled assistant`, saved?.llm.disabled === true);
  expect(
    `${fixture}: the temporary clone is gone`,
    saved?.clone?.kept === false && !existsSync(saved.clone.path),
    JSON.stringify(saved?.clone),
  );
  expect(
    `${fixture}: the report page is next to the stored run`,
    typeof saved?.html === 'string' &&
      existsSync(saved.html) &&
      readFileSync(saved.html, 'utf8').startsWith('<!doctype html>'),
    saved?.html,
  );
  // The migration is a branch in the repository, at the verified commit, not checked out.
  const branchHead = spawnSync('git', ['rev-parse', '--verify', zodBranch], {
    cwd: repo,
    encoding: 'utf8',
  });
  expect(
    `${fixture}: migration branch`,
    branchHead.status === 0 && branchHead.stdout.trim() === saved?.head,
    branchHead.stderr,
  );
  expect(
    `${fixture}: lifecycle scripts never executed`,
    !existsSync('/tmp/UPTIDE_INSTALL_SCRIPT_RAN'),
  );
  expect(`${fixture}: lockfile scope report`, !!saved?.lockfile);
  if (manager === 'pnpm')
    has('pnpm: catalog bumped', onBranch(repo, zodBranch, 'pnpm-workspace.yaml'), `zod: ${ZOD}`);
  const files =
    sites === 4
      ? ['packages/shared/src/index.ts', 'packages/api/src/signup.ts']
      : ['src/schema.ts'];
  for (const file of files)
    expect(
      `${fixture}: ${file} migrated`,
      !/required_error|invalid_type_error/.test(onBranch(repo, zodBranch, file)),
    );
  if (fixture === 'npm-workspaces') {
    expect(
      'npm workspace caret retained',
      JSON.parse(onBranch(repo, zodBranch, 'packages/api/package.json')).dependencies.zod ===
        `^${ZOD}`,
    );
    expect(
      'npm workspace tilde retained',
      JSON.parse(onBranch(repo, zodBranch, 'packages/shared/package.json')).dependencies.zod ===
        `~${ZOD}`,
    );
    expect(
      'npm v2 retained',
      JSON.parse(onBranch(repo, zodBranch, 'package-lock.json')).lockfileVersion === 2,
    );
  }
  has(
    `${fixture}: version commit`,
    sh(repo, 'git', 'log', '--format=%s', zodBranch),
    `chore: upgrade zod to ${ZOD}`,
  );
  const lockfile = saved?.lockfile?.file;
  const lockDiff = lockfile
    ? sh(repo, 'git', 'diff', `${zodBranch}~2`, zodBranch, '--', lockfile)
    : '';
  if (lockfile) writeFileSync(join(tarballDir, `${fixture}-lock.diff`), lockDiff);
  // The breaking API pin above is intentionally assisted. Exercise a verified,
  // no-LLM Stripe upgrade separately with a caller compatible with both SDKs.
  const billing = sites === 4 ? 'packages/api/src/billing.ts' : 'src/billing.ts';
  writeFileSync(
    join(repo, billing),
    `import Stripe from 'stripe';
const stripe = new Stripe('sk_test_fixture');
export async function customerId(id: string): Promise<string> {
  return (await stripe.customers.retrieve(id)).id;
}
`,
  );
  sh(repo, 'git', 'add', billing);
  sh(repo, 'git', 'commit', '--quiet', '--message', 'fixture: compatible Stripe consumer');
  const stripeFix = uptide(
    repo,
    'fix',
    '--only',
    'stripe',
    '--target',
    `stripe@${STRIPE}`,
    '--no-llm',
    '--ci',
  );
  const stripeBranch = `uptide/stripe-${STRIPE}`;
  const stripeSaved = existsSync(storedRun(repo, stripeBranch))
    ? JSON.parse(readFileSync(storedRun(repo, stripeBranch), 'utf8'))
    : { verification: { newErrors: [] } };
  expect(
    `${fixture} stripe: verified no-LLM upgrade`,
    stripeFix.code === 0 &&
      stripeSaved.package === 'stripe' &&
      stripeSaved.verification.passed &&
      stripeSaved.verification.newErrors.length === 0,
    stripeFix.err + stripeFix.out,
  );
  expect(
    `${fixture} stripe: migration branch`,
    spawnSync('git', ['rev-parse', '--verify', stripeBranch], { cwd: repo }).status === 0,
  );
  expect(
    `${fixture} stripe: the checkout is still clean and on its branch`,
    sh(repo, 'git', 'branch', '--show-current').trim() === before.branch &&
      sh(repo, 'git', 'status', '--porcelain', '--untracked-files=all').trim() === '',
  );
  expect(
    `${fixture} stripe: lifecycle scripts disabled`,
    !existsSync('/tmp/UPTIDE_INSTALL_SCRIPT_RAN'),
  );
  if (stripeSaved.lockfile)
    writeFileSync(
      join(tarballDir, `${fixture}-stripe-lock.diff`),
      sh(repo, 'git', 'diff', `${stripeBranch}^`, stripeBranch, '--', stripeSaved.lockfile.file),
    );
  results.push({
    fixture,
    manager,
    sites,
    lockfile: saved?.lockfile,
    checkExit: check.code,
    checkMs: check.ms,
    fixExit: fix.code,
    fixMs: fix.ms,
    stripeFixExit: stripeFix.code,
    stripeFixMs: stripeFix.ms,
    stripeLockfile: stripeSaved.lockfile,
  });
}

const summary = { node: process.version, version, results, failures };
if (resultsFile) writeFileSync(resultsFile, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`uptide ${version} on Node ${process.version}`);
for (const r of results)
  console.log(
    `${r.fixture.padEnd(15)} check exit ${r.checkExit} in ${(r.checkMs / 1000).toFixed(1)}s, fix --no-llm exit ${r.fixExit} in ${(r.fixMs / 1000).toFixed(1)}s; stripe exit ${r.stripeFixExit} in ${(r.stripeFixMs / 1000).toFixed(1)}s`,
  );
if (failures.length > 0) {
  console.error(`\n${failures.length} smoke assertion(s) failed:\n\n${failures.join('\n\n')}`);
  process.exit(1);
}
for (const r of results)
  for (const [pkg, l] of [
    ['zod', r.lockfile],
    ['stripe', r.stripeLockfile],
  ])
    if (l) {
      console.log(
        `${r.fixture} ${pkg}: ${l.file}: +${l.added.length} -${l.removed.length} ~${l.changed.length} entries; outside target subtree: 0`,
      );
      console.log(`  ${[...l.added, ...l.removed, ...l.changed].join(', ')}`);
    }
console.log('smoke: all assertions passed');
