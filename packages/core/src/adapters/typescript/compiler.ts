import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { ts } from 'ts-morph';
import { UptideError } from '../../errors.js';
import { onReset } from '../../shared-state.js';

/**
 * Which TypeScript judges a repository. The repository's own compiler is authoritative: it
 * is the one its build runs, so its errors (and their positions, which moved between
 * TypeScript 4 and 6) are the ones the repository would see. The compiler ts-morph bundles
 * stands in only when the repository installs none.
 */

/**
 * The repository's own TypeScript: `node_modules/typescript` in `dir` or the nearest ancestor
 * that has one, as its own build would find it. Never `NODE_PATH` or Node's global folders:
 * a compiler the repository did not install is not its compiler, and verifying with one
 * reports errors (or deprecations) the repository never sees.
 */
export function consumerCompilerDir(dir: string): string | undefined {
  for (let current = resolve(dir); ; current = dirname(current)) {
    const manifest = join(current, 'node_modules', 'typescript', 'package.json');
    if (existsSync(manifest)) return dirname(manifest);
    if (dirname(current) === current) return undefined;
  }
}

function loadCompiler(packageDir: string): typeof ts {
  return createRequire(join(packageDir, 'package.json'))(packageDir) as typeof ts;
}

/** The consumer's compiler is authoritative; bundles carry ts-morph's compiler as fallback. */
export function resolveCompiler(
  dir: string,
  bundled: typeof ts | undefined = ts,
  load: (packageDir: string) => typeof ts = loadCompiler,
  find: (dir: string) => string | undefined = consumerCompilerDir,
): typeof ts {
  try {
    const own = find(dir);
    if (own === undefined) throw new Error('the repository installs no TypeScript');
    return load(own);
  } catch {
    if (bundled) return bundled;
    throw new UptideError(
      'TYPESCRIPT_UNAVAILABLE',
      'TypeScript compiler unavailable: install typescript in the consumer repository or reinstall the Uptide bundle',
    );
  }
}

/** A compiler and where it came from, as the coverage line names it. */
export interface Compiler {
  ts: typeof ts;
  version: string;
  /** The repository's own install, not the bundled fallback. */
  own: boolean;
}

const compilers = new Map<string, Compiler>();
// A loaded compiler module carries no analysis state; dropped with the rest all the same.
onReset(() => compilers.clear());

/**
 * The compiler `check` compiles a repository with: its own, loaded once per install
 * directory (a monorepo's workspaces share the hoisted one), else the bundled one.
 */
export function repositoryCompiler(dir: string): Compiler {
  const own = consumerCompilerDir(dir);
  const key = own ?? '';
  let compiler = compilers.get(key);
  if (!compiler) {
    const loaded = own === undefined ? ts : resolveCompiler(dir, ts, loadCompiler, () => own);
    compiler = { ts: loaded, version: loaded.version, own: loaded !== ts };
    compilers.set(key, compiler);
  }
  return compiler;
}

/** `the repo's TypeScript 4.9.5`, or `the bundled TypeScript 6.0.2`. */
export function describeCompiler(c: { version: string; own: boolean }): string {
  return `${c.own ? "the repo's" : 'the bundled'} TypeScript ${c.version}`;
}
