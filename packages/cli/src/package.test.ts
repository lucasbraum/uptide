import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
const bin = `${root}dist/index.js`;

describe('published package', () => {
  it('is one package named uptide with no runtime dependencies', () => {
    expect(manifest.name).toBe('uptide');
    expect(manifest.bin).toEqual({ uptide: './dist/index.js' });
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.engines.node).toBe('>=20');
    expect(manifest.files).toEqual(['dist']);
  });

  // `turbo run test` builds first; a bare `vitest` on a fresh clone has no dist yet.
  it.skipIf(!existsSync(bin))('bundles the engine and its worker into dist', () => {
    const files = readdirSync(`${root}dist`);
    // The engine resolves `./worker.js` relative to its own chunk: everything stays flat.
    expect(files).toContain('worker.js');
    expect(files).toContain('list-worker.js');
    expect(files.every((f) => f.endsWith('.js'))).toBe(true);
    const sources = files.map((f) => readFileSync(`${root}dist/${f}`, 'utf8')).join('\n');
    expect(sources).not.toMatch(/from\s*["']@uptide\/core["']/);
    expect(sources).not.toMatch(
      /from\s*["'](ts-morph|commander|picocolors|semver|ignore|picomatch)["']/,
    );
  });

  it.skipIf(!existsSync(bin))('reports the package version, not the engine constant', () => {
    const out = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
    expect(out.trim()).toBe(manifest.version);
  });
});

it.skipIf(!existsSync(bin))(
  'uses the installed CLI version in --version and HTML even after post-build versioning',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'uptide-installed-version-'));
    try {
      cpSync(`${fileURLToPath(new URL('..', import.meta.url))}dist`, join(root, 'dist'), {
        recursive: true,
      });
      const version = '0.9.8-next.20261004';
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'uptide', version, type: 'module' }),
      );
      const consumer = join(root, 'consumer');
      mkdirSync(consumer);
      writeFileSync(join(consumer, 'package.json'), '{"name":"empty-app"}');
      writeFileSync(join(consumer, 'package-lock.json'), '{}');
      const installed = join(root, 'dist/index.js');
      expect(
        execFileSync(process.execPath, [installed, '--version'], { encoding: 'utf8' }).trim(),
      ).toBe(version);
      execFileSync(process.execPath, [installed, 'list', '--html', 'report.html', '--ci'], {
        cwd: consumer,
        env: { ...process.env, UPTIDE_TELEMETRY: '0' },
        stdio: 'pipe',
      });
      expect(readFileSync(join(consumer, 'report.html'), 'utf8')).toContain(
        `Uptide CLI ${version}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
