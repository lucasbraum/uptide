// Host side of the smoke test: pack the built CLI and hand the tarball, the fixtures and
// in-container.mjs to a clean Node container. Usage: node smoke/run.mjs [node-image-tag]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const tag = process.argv[2] ?? '22';
const out = mkdtempSync(join(tmpdir(), 'uptide-smoke-'));

// `pnpm pack` rewrites workspace: specifiers, as `pnpm publish` will.
execFileSync('pnpm', ['pack', '--pack-destination', out], {
  cwd: join(here, '..'),
  stdio: 'inherit',
});
execFileSync(
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
const { failures } = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'));
process.exit(failures.length > 0 ? 1 : 0);
