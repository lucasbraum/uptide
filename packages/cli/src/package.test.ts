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
    // The bundle, the legal assets that must travel with it, and nothing of the build.
    expect(manifest.files).toEqual([
      'dist',
      '!dist/metafile-*.json',
      'NOTICE',
      'THIRD-PARTY-NOTICES',
    ]);
  });

  // `turbo run test` builds first; a bare `vitest` on a fresh clone has no dist yet.
  it.skipIf(!existsSync(bin))('bundles the engine and its worker into dist', () => {
    const files = readdirSync(`${root}dist`);
    const code = files.filter((f) => f.endsWith('.js'));
    // The engine resolves `./worker.js` relative to its own chunk: everything stays flat.
    expect(code).toContain('worker.js');
    expect(code).toContain('list-worker.js');
    // Beside the bundle, only the bundler's record of what went into it, which
    // scripts/third-party-notices.mjs reads and `files` keeps out of the tarball.
    expect(files.filter((f) => !f.endsWith('.js'))).toEqual(['metafile-esm.json']);
    const sources = code.map((f) => readFileSync(`${root}dist/${f}`, 'utf8')).join('\n');
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
  'embeds the build-time manifest version in --version, HTML and telemetry',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'uptide-installed-version-'));
    try {
      cpSync(`${fileURLToPath(new URL('..', import.meta.url))}dist`, join(root, 'dist'), {
        recursive: true,
      });
      const version = manifest.version;
      const changedAfterBuild = '0.9.8-next.20261004';
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'uptide', version: changedAfterBuild, type: 'module' }),
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
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(root, 'config'),
          UPTIDE_TELEMETRY: '1',
          // Save the local event without contacting a telemetry service.
          UPTIDE_TELEMETRY_HOST: 'http://disabled.invalid',
        },
        stdio: 'pipe',
      });
      expect(readFileSync(join(consumer, 'report.html'), 'utf8')).toContain(
        `Uptide CLI ${version}`,
      );
      const event = JSON.parse(
        readFileSync(join(root, 'config/uptide/telemetry-last.json'), 'utf8'),
      );
      expect(event.properties.version).toBe(version);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
