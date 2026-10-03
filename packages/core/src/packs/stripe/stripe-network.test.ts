import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createNpmFetcher } from '../../fetch/npm-fetcher.js';

it.runIf(process.env.UPTIDE_NETWORK === '1')(
  'matches the checked-in Stripe upgrade ground truth using real tsc',
  async () => {
    const fixture = resolve(import.meta.dirname, '../../../../../fixtures/repos/stripe-consumer');
    const truth = JSON.parse(readFileSync(join(fixture, 'ground-truth.json'), 'utf8'));
    const root = mkdtempSync(join(tmpdir(), 'uptide-stripe-tsc-'));
    const require = createRequire(import.meta.url);
    const fetcher = createNpmFetcher();
    try {
      cpSync(fixture, root, { recursive: true });
      mkdirSync(join(root, 'node_modules/@types'), { recursive: true });
      symlinkSync(
        dirname(require.resolve('@types/node/package.json')),
        join(root, 'node_modules/@types/node'),
        'dir',
      );
      const a = await fetcher.fetch('stripe', truth.from);
      const b = await fetcher.fetch('stripe', truth.to);
      symlinkSync(a.dir, join(root, 'node_modules/stripe'), 'dir');
      const compiler = require.resolve('typescript/bin/tsc');
      const baseline = spawnSync(process.execPath, [compiler, '--noEmit', '--pretty', 'false'], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(baseline.stdout).toBe('');
      expect(baseline.status).toBe(0);
      rmSync(join(root, 'node_modules/stripe'));
      symlinkSync(b.dir, join(root, 'node_modules/stripe'), 'dir');
      const target = spawnSync(process.execPath, [compiler, '--noEmit', '--pretty', 'false'], {
        cwd: root,
        encoding: 'utf8',
      });
      const errors = [
        ...target.stdout.matchAll(/^(.+)\((\d+),(\d+)\): error TS(\d+): (.+)$/gm),
      ].map((m) => ({ file: m[1], line: Number(m[2]), code: Number(m[4]), message: m[5] }));
      expect(target.status).not.toBe(0);
      expect(errors).toEqual(truth.errors);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
