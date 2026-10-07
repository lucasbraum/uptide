// The tarball about to be published suggests commands that reach it: `npx uptide@next` from
// a `next` snapshot, `npx uptide` from a `latest` release. Release runs this on the packed
// CLI after the version to publish is applied (.github/workflows/release.yml), so it proves
// the artifact, not the tree the tests ran on. It needs Node, npm and git; the run itself is
// offline (`fix` in a bun repository stops before any network).
// Usage: node packages/cli/smoke/check-invocation.mjs <tarball>
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expectedInvocation, invocationFailures } from './check-output.mjs';

const tarball = process.argv[2];
if (!tarball) {
  console.error('usage: node packages/cli/smoke/check-invocation.mjs <tarball>');
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), 'uptide-invocation-'));
try {
  const prefix = join(scratch, 'install');
  execFileSync(
    'npm',
    [
      'install',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--silent',
      resolve(tarball),
    ],
    { stdio: 'inherit' },
  );
  const bin = join(prefix, 'node_modules/.bin/uptide');
  const env = { ...process.env, UPTIDE_TELEMETRY: '0', CI: '' };
  // The version npm will publish it under, and the one the build says it is: a tarball
  // packed without rebuilding after the snapshot version would disagree.
  const version = JSON.parse(
    readFileSync(join(prefix, 'node_modules/uptide/package.json'), 'utf8'),
  ).version;
  const built = execFileSync(bin, ['--version'], { encoding: 'utf8', env }).trim();
  const expected = expectedInvocation(version);

  const repo = join(scratch, 'repo');
  execFileSync('git', ['init', '--quiet', repo]);
  writeFileSync(
    join(repo, 'package.json'),
    '{"name":"invocation","dependencies":{"zod":"3.23.8"}}\n',
  );
  writeFileSync(join(repo, 'bun.lock'), '{}\n');
  const run = spawnSync(bin, ['fix', '--only', 'zod'], { cwd: repo, encoding: 'utf8', env });
  const output = `${run.stdout}${run.stderr}`;
  const failures = [
    ...(built === version
      ? []
      : [
          `uptide --version says ${built}, the package is ${version}: rebuild after setting the version`,
        ]),
    ...(run.status === 2
      ? []
      : [`fix in a bun repository: exit ${run.status}, wanted 2\n${output}`]),
    ...(output.includes(`Next: ${expected} check zod --details`)
      ? []
      : [`fix in a bun repository: expected "Next: ${expected} check zod --details"\n${output}`]),
    ...invocationFailures('fix in a bun repository', output, version),
  ];
  if (failures.length) {
    console.error(
      `uptide ${version}: ${failures.length} failed assertion(s)\n\n${failures.join('\n\n')}`,
    );
    process.exit(1);
  }
  console.log(`uptide ${version} suggests "${expected}": ${output.match(/Next: .*/)?.[0]}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
