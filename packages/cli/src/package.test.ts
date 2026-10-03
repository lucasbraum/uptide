import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
    expect(files.every((f) => f.endsWith('.js'))).toBe(true);
    const sources = files.map((f) => readFileSync(`${root}dist/${f}`, 'utf8')).join('\n');
    expect(sources).not.toMatch(/from\s*["']@uptide\/core["']/);
    expect(sources).not.toMatch(/from\s*["'](ts-morph|commander|picocolors|semver)["']/);
  });

  it.skipIf(!existsSync(bin))('reports the package version, not the engine constant', () => {
    const out = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
    expect(out.trim()).toBe(manifest.version);
  });
});
