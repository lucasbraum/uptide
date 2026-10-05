// Host side of the smoke test: build and pack the CLI, then run it in a clean container.
// Usage: pnpm smoke [node-image-tag]
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const tag = process.argv[2] ?? '22';
// Fail before building or packing, both for a missing executable and an unavailable daemon.
const docker = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
if (docker.error || docker.status !== 0) {
  console.error('Docker is required for pnpm smoke');
  process.exit(1);
}

function run(bin, args, cwd) {
  const result = spawnSync(bin, args, { cwd, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(
      `smoke: ${bin} ${args.join(' ')} failed (${result.error?.message ?? result.signal ?? result.status})`,
    );
    process.exit(1);
  }
}
run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=uptide'], join(here, '../../..'));
const out = mkdtempSync(join(tmpdir(), 'uptide-smoke-'));
// `pnpm pack` rewrites workspace: specifiers, as `pnpm publish` will.
run('pnpm', ['pack', '--pack-destination', out], join(here, '..'));
const container = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--volume',
    `${out}:/tarball`,
    '--volume',
    `${here}:/smoke:ro`,
    // The full image: git and yarn classic are part of it, pnpm is installed inside.
    `node:${tag}`,
    'node',
    '/smoke/in-container.mjs',
    '/tarball',
    '/smoke/fixtures',
    '/tarball/results.json',
  ],
  { stdio: 'inherit' },
);
const path = join(out, 'results.json');
const report = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
const failed = container.error || container.status !== 0 || !report || report.failures.length > 0;
// The container prints full diagnostics to the log. Preserve the assertion failures in
// Actions' summary too, instead of ending with an opaque execFileSync exception.
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const failures = report?.failures ?? [
    'Container did not produce results.json; see the smoke step log.',
  ];
  appendFileSync(
    summary,
    `## Smoke: Node ${tag}\n\n${failed ? 'Failed' : 'Passed'}${report ? ` (${report.results.length} fixtures, ${report.failures.length} failed assertions)` : ''}.\n\n${failed ? failures.map((failure) => `~~~text\n${failure}\n~~~\n`).join('\n') : ''}`,
  );
}
if (report) console.log(`smoke: results saved to ${path}`);
if (failed) {
  console.error(
    `smoke: ${report?.failures.length ? `${report.failures.length} assertion(s) failed; see the diagnostics above` : `container failed (${container.error?.message ?? container.signal ?? container.status}); see the log above`}`,
  );
  process.exit(1);
}
