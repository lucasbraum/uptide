import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaceSourceMap } from './workspace-source.js';

const ROOT = resolve(import.meta.dirname, '../../../../../fixtures/repos/workspace-consumer');

describe('workspaceSourceMap', () => {
  it('maps a linked package types entry under outDir to the file under rootDir', () => {
    const app = join(ROOT, 'packages/app');
    const map = workspaceSourceMap(
      app,
      new Map([
        ['lib', 'link:../lib'],
        ['synthetic', '1.0.0'],
      ]),
    );
    expect(map.paths).toEqual({ lib: [join(ROOT, 'packages/lib/src/index.ts')] });
    expect(map.warnings).toEqual([]);
  });

  it('falls back to dist with a warning when nothing maps and the dist is older than the source', () => {
    const repo = mkdtempSync(join(tmpdir(), 'uptide-ws-'));
    const dep = join(repo, 'dep');
    mkdirSync(join(dep, 'lib'), { recursive: true });
    mkdirSync(join(dep, 'src'), { recursive: true });
    writeFileSync(
      join(dep, 'package.json'),
      JSON.stringify({ name: 'dep', types: './lib/index.d.ts' }),
    );
    writeFileSync(join(dep, 'lib/index.d.ts'), 'export declare const x: number;\n');
    writeFileSync(join(dep, 'src/index.ts'), 'export const x = 1;\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dep, 'lib/index.d.ts'), old, old);
    const map = workspaceSourceMap(repo, new Map([['dep', 'link:./dep']]));
    expect(map.paths).toEqual({});
    expect(map.warnings).toEqual([
      'dep: compiled against its built lib/index.d.ts, which is older than its source; rebuild it or the results may be stale',
    ]);
  });

  it("follows workspace links hoisted to the root, and the linked packages' own links", () => {
    // A Yarn or npm workspace: `packages/app` depends on `@acme/ui` (workspace:*), hoisted to the
    // root node_modules as a symlink; `@acme/ui` re-exports from `@acme/core`, linked the same way.
    const repo = mkdtempSync(join(tmpdir(), 'uptide-hoist-'));
    const pkg = (name: string, deps: Record<string, string> = {}): string => {
      const dir = join(repo, 'packages', name.replace('@acme/', ''));
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name, types: './dist/index.d.ts', dependencies: deps }),
      );
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src' } }),
      );
      writeFileSync(join(dir, 'src/index.ts'), 'export const x = 1;\n');
      return dir;
    };
    const core = pkg('@acme/core');
    const ui = pkg('@acme/ui', { '@acme/core': 'workspace:*' });
    const app = pkg('@acme/app', { '@acme/ui': 'workspace:*' });
    mkdirSync(join(repo, 'node_modules', '@acme'), { recursive: true });
    symlinkSync(core, join(repo, 'node_modules', '@acme', 'core'), 'dir');
    symlinkSync(ui, join(repo, 'node_modules', '@acme', 'ui'), 'dir');
    const map = workspaceSourceMap(app, new Map([['@acme/ui', 'workspace:*']]));
    expect(map.paths).toEqual({
      '@acme/ui': [join(ui, 'src/index.ts')],
      '@acme/core': [join(core, 'src/index.ts')],
    });
  });
});
