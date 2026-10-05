import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliDir = fileURLToPath(new URL('../', import.meta.url));
const script = join(cliDir, 'scripts/third-party-notices.mjs');

interface Result {
  packages: string[];
  problems: string[];
}
/** The generator, on a package directory holding a `dist/metafile-esm.json`. */
function generate(dir: string, flags: string[] = []) {
  const run = spawnSync('node', [script, dir, '--json', ...flags], { encoding: 'utf8' });
  return {
    status: run.status,
    result: run.stdout ? (JSON.parse(run.stdout) as Result) : undefined,
  };
}

interface FakePackage {
  name?: string;
  version?: string;
  license?: unknown;
  /** The license and NOTICE files it ships, by file name. */
  files?: Record<string, string>;
}

/**
 * A package directory whose `dist/metafile-esm.json` says the bundle inlined one file from
 * each of `packages`, laid out the way pnpm lays out a store: the generator has to walk up
 * from the file to the manifest exactly as it does for the real bundle.
 */
function bundle(packages: FakePackage[], extraInputs: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'uptide-notices-'));
  const inputs: Record<string, { bytesInOutput: number }> = {};
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  for (const pkg of packages) {
    const root = `node_modules/.pnpm/${(pkg.name ?? 'x').replace('/', '+')}@${pkg.version}/node_modules/${pkg.name}`;
    const manifest: Record<string, unknown> = { name: pkg.name, version: pkg.version };
    if (pkg.license !== undefined) manifest.license = pkg.license;
    write(`${root}/package.json`, JSON.stringify(manifest));
    // A nested manifest with no name, which the walk up must step over.
    write(`${root}/dist/package.json`, JSON.stringify({ type: 'commonjs' }));
    for (const [name, text] of Object.entries(pkg.files ?? {})) write(`${root}/${name}`, text);
    write(`${root}/dist/index.js`, 'export const x = 1;\n');
    inputs[`${root}/dist/index.js`] = { bytesInOutput: 20 };
  }
  for (const [path, text] of Object.entries(extraInputs)) {
    write(path, text);
    inputs[path] = { bytesInOutput: 20 };
  }
  // A first-party file, which is not a notice: it belongs to Uptide.
  write('src/index.ts', 'export const y = 1;\n');
  inputs['src/index.ts'] = { bytesInOutput: 20 };
  write(
    'dist/metafile-esm.json',
    JSON.stringify({ inputs: {}, outputs: { 'dist/index.js': { inputs } } }),
  );
  return dir;
}

const MIT = { LICENSE: 'MIT License\n\nCopyright (c) someone\n' };

describe('third-party notices for what the bundle actually contains', () => {
  it('names every third-party package in this build, and nothing first-party', () => {
    const { status, result } = generate(cliDir);
    expect(result?.problems).toEqual([]);
    expect(status).toBe(0);
    // The engine, the compiler it drives, and the CLI's own runtime dependencies.
    for (const pkg of [
      'ts-morph@28.0.0',
      '@ts-morph/common@0.29.0',
      'semver@7.8.5',
      'commander@15.0.0',
      'picocolors@1.1.1',
    ])
      expect(result?.packages, pkg).toContain(pkg);
    // TypeScript has no package of its own in the bundle: @ts-morph/common vendors it.
    expect(result?.packages.some((pkg) => pkg.startsWith('typescript@'))).toBe(true);
    expect(result?.packages.some((pkg) => pkg.startsWith('uptide'))).toBe(false);
  });

  it('carries the full license text of each one, and the compiler Apache notice', () => {
    const notices = readFileSync(join(cliDir, 'THIRD-PARTY-NOTICES'), 'utf8');
    const { result } = generate(cliDir);
    for (const entry of result?.packages ?? []) {
      const [name, version] = [entry.slice(0, entry.lastIndexOf('@')), entry.split('@').pop()];
      expect(notices, entry).toContain(`${name} ${version}`);
    }
    // Not a summary: the operative words of each license body are in the file.
    expect(notices).toContain('Permission is hereby granted, free of charge');
    expect(notices).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION');
    expect(notices).toContain('Copyright (c) Microsoft Corporation. All rights reserved.');
    expect(notices).toContain('SPDX-License-Identifier: Apache-2.0');
    expect(notices).toContain('SPDX-License-Identifier: BlueOak-1.0.0');
  });

  it('is in step with the current build: the committed build never ships a stale file', () => {
    expect(generate(cliDir, ['--check']).status).toBe(0);
  });

  it('is shipped, with LICENSE and NOTICE, by the published package', () => {
    const manifest = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'));
    expect(manifest.files).toContain('THIRD-PARTY-NOTICES');
    expect(manifest.files).toContain('NOTICE');
    // Build bookkeeping, not something a consumer installs.
    expect(manifest.files).toContain('!dist/metafile-*.json');
    expect(manifest.license).toBe('Apache-2.0');
  });

  it('fails when a bundled package ships no license text', () => {
    const dir = bundle([
      { name: 'stated', version: '1.0.0', license: 'MIT', files: MIT },
      { name: 'bare', version: '2.0.0', license: 'MIT' },
    ]);
    const { status, result } = generate(dir);
    expect(status).toBe(1);
    expect(result?.problems).toEqual(['bare@2.0.0: is bundled but ships no license text']);
  });

  it('fails when a bundled package states no license at all', () => {
    const dir = bundle([{ name: 'silent', version: '1.0.0', files: MIT }]);
    const { status, result } = generate(dir);
    expect(status).toBe(1);
    expect(result?.problems).toEqual(['silent@1.0.0: is bundled but states no license']);
  });

  it('fails when a bundled license is outside the allowlist', () => {
    const dir = bundle([
      { name: 'copyleft', version: '3.1.0', license: 'GPL-3.0-only', files: MIT },
      { name: 'unclear', version: '1.0.0', license: 'SEE LICENSE IN LICENSE', files: MIT },
      { name: 'dual-bad', version: '1.0.0', license: 'GPL-2.0-only AND MIT', files: MIT },
    ]);
    const { status, result } = generate(dir);
    expect(status).toBe(1);
    expect(result?.problems).toEqual([
      'copyleft@3.1.0: is bundled under "GPL-3.0-only", which is not on the allowlist',
      'dual-bad@1.0.0: is bundled under "GPL-2.0-only AND MIT", which is not on the allowlist',
      'unclear@1.0.0: is bundled under "SEE LICENSE IN LICENSE", which is not on the allowlist',
    ]);
  });

  it('accepts every license on the allowlist, however it is expressed', () => {
    const allowed = [
      '0BSD',
      'Apache-2.0',
      'BSD-2-Clause',
      'BSD-3-Clause',
      'BlueOak-1.0.0',
      'ISC',
      'MIT',
      '(MIT OR GPL-3.0-only)',
      'MIT AND ISC',
    ];
    const dir = bundle(
      allowed.map((license, index) => ({
        name: `ok-${index}`,
        version: '1.0.0',
        license,
        files: MIT,
      })),
    );
    const { status, result } = generate(dir);
    expect(result?.problems).toEqual([]);
    expect(status).toBe(0);
    expect(result?.packages).toHaveLength(allowed.length);
  });

  it('writes nothing when there is a problem, so a bad build cannot be packed', () => {
    const dir = bundle([{ name: 'bare', version: '1.0.0', license: 'MIT' }]);
    expect(generate(dir).status).toBe(1);
    expect(() => readFileSync(join(dir, 'THIRD-PARTY-NOTICES'))).toThrow();
  });

  it('fails when a vendored entry no longer matches the bundle', () => {
    // @ts-morph/common is bundled, but not the file that carries the compiler: the entry
    // describing the vendored TypeScript has gone stale and must not disappear silently.
    const dir = bundle([
      { name: '@ts-morph/common', version: '9.9.9', license: 'MIT', files: MIT },
    ]);
    const { status, result } = generate(dir);
    expect(status).toBe(1);
    expect(result?.problems).toEqual([
      'typescript: vendored in @ts-morph/common, but dist/typescript.js is not in this bundle — the entry in VENDORED is stale',
    ]);
  });

  it('fails when a bundled file under node_modules belongs to no package', () => {
    const dir = bundle([{ name: 'fine', version: '1.0.0', license: 'MIT', files: MIT }], {
      'node_modules/orphan.js': 'export const z = 1;\n',
    });
    const { status, result } = generate(dir);
    expect(status).toBe(1);
    expect(result?.problems).toEqual([
      'node_modules/orphan.js: is bundled from node_modules but belongs to no package',
    ]);
  });

  it('fails when there is no metafile to read the bundle from', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptide-notices-'));
    const { status, result } = generate(dir);
    expect(status).toBe(1);
    expect(result?.problems).toEqual([
      'dist/metafile-esm.json: missing — run tsup first (it writes the metafile)',
    ]);
  });

  it('fails when the bundle names no third-party package, rather than shipping an empty file', () => {
    const dir = bundle([]);
    const { status, result } = generate(dir);
    expect(status).toBe(1);
    expect(result?.problems).toEqual([
      'dist/metafile-esm.json: names no third-party package in the bundle',
    ]);
  });

  it('ignores a file the bundler read but tree-shook away entirely', () => {
    const dir = bundle([{ name: 'kept', version: '1.0.0', license: 'MIT', files: MIT }]);
    const metafile = join(dir, 'dist/metafile-esm.json');
    const parsed = JSON.parse(readFileSync(metafile, 'utf8'));
    mkdirSync(join(dir, 'node_modules/.pnpm/dropped@1.0.0/node_modules/dropped'), {
      recursive: true,
    });
    parsed.inputs['node_modules/.pnpm/dropped@1.0.0/node_modules/dropped/index.js'] = {};
    parsed.outputs['dist/index.js'].inputs[
      'node_modules/.pnpm/dropped@1.0.0/node_modules/dropped/index.js'
    ] = { bytesInOutput: 0 };
    writeFileSync(metafile, JSON.stringify(parsed));
    const { status, result } = generate(dir);
    expect(result?.problems).toEqual([]);
    expect(result?.packages).toEqual(['kept@1.0.0']);
    expect(status).toBe(0);
  });

  it('is reproducible: the same bundle renders the same bytes', () => {
    const dir = bundle([{ name: 'one', version: '1.0.0', license: 'MIT', files: MIT }]);
    expect(generate(dir).status).toBe(0);
    const first = readFileSync(join(dir, 'THIRD-PARTY-NOTICES'), 'utf8');
    expect(generate(dir).status).toBe(0);
    expect(readFileSync(join(dir, 'THIRD-PARTY-NOTICES'), 'utf8')).toBe(first);
    // No absolute path from the machine that built it.
    expect(first).not.toContain(dir);
  });
});
