import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { NoTypesError } from '../../errors.js';

export interface EntryPoint {
  /** "." or "./subpath" */
  entry: string;
  /** Absolute path to the declaration file. */
  file: string;
}

type ExportsValue = string | null | ExportsValue[] | { [key: string]: ExportsValue };

const DECLARATION = /\.d\.(c|m)?ts$/;

/** `./dist/index.js` -> `./dist/index.d.ts`, honoring the module flavour. */
function siblingDeclaration(file: string): string | undefined {
  if (DECLARATION.test(file)) return file;
  const m = /\.(m|c)?(j|t)sx?$/.exec(file);
  if (!m) return undefined;
  return `${file.slice(0, m.index)}.d.${m[1] ?? ''}ts`;
}

function resolveTypesFile(dir: string, target: string): string | undefined {
  const candidate = siblingDeclaration(target);
  if (!candidate) return undefined;
  const abs = resolve(dir, candidate);
  return existsSync(abs) ? abs : undefined;
}

/** Conditions are tried in this order, then any others as declared. ESM is what modern consumers see; CommonJS declarations often wrap everything in `export =`. */
const PREFERRED_CONDITIONS = ['types', 'import', 'default'];

/**
 * Walks a conditions object the way Node does, but prefers a `types` condition at any
 * level because that is what consumers' compilers see, and prefers the ESM view over
 * `require`. Falls back to the first target that has a declaration file next to it.
 */
function resolveFromExports(dir: string, value: ExportsValue): string | undefined {
  if (value === null) return undefined;
  if (typeof value === 'string') return resolveTypesFile(dir, value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = resolveFromExports(dir, item);
      if (found) return found;
    }
    return undefined;
  }
  const keys = Object.keys(value);
  const ordered = [
    ...PREFERRED_CONDITIONS.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !PREFERRED_CONDITIONS.includes(k)),
  ];
  for (const key of ordered) {
    const found = resolveFromExports(dir, value[key] as ExportsValue);
    if (found) return found;
  }
  return undefined;
}

/**
 * Without an `exports` map any file is importable, and two conventions carry real API:
 * a top-level `foo.d.ts` (next/navigation) and a top-level directory with its own
 * package.json pointing at types (expo-camera/legacy). Deeper paths are ignored: they are
 * usually build output that nobody is meant to import.
 */
function implicitSubpaths(dir: string, rootFile: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of names) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      const nested = join(full, 'package.json');
      if (!existsSync(nested)) continue;
      let pkg: { types?: string; typings?: string; main?: string };
      try {
        pkg = JSON.parse(readFileSync(nested, 'utf8')) as typeof pkg;
      } catch {
        continue;
      }
      for (const c of [pkg.types, pkg.typings, pkg.main]) {
        const file = typeof c === 'string' ? resolveTypesFile(full, c) : undefined;
        if (file) {
          out.set(`./${entry}`, file);
          break;
        }
      }
      continue;
    }
    const m = /^(.+?)\.d\.(c|m)?ts$/.exec(entry);
    if (!m || m[1] === 'index') continue;
    if (rootFile !== undefined && resolve(full) === rootFile) continue;
    out.set(`./${m[1]}`, resolve(full));
  }
  return out;
}

export function resolveEntryPoints(dir: string, name: string, version: string): EntryPoint[] {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    types?: string;
    typings?: string;
    main?: string;
    exports?: ExportsValue;
  };
  const found = new Map<string, string>();

  const exportsField = pkg.exports;
  if (exportsField !== undefined) {
    const isSubpathMap =
      typeof exportsField === 'object' &&
      exportsField !== null &&
      !Array.isArray(exportsField) &&
      Object.keys(exportsField).every((k) => k.startsWith('.'));
    const map: Record<string, ExportsValue> = isSubpathMap
      ? (exportsField as Record<string, ExportsValue>)
      : { '.': exportsField };
    for (const [subpath, value] of Object.entries(map)) {
      // Patterns need a directory listing to enumerate; milestone 1 skips them.
      if (subpath.includes('*')) continue;
      const file = resolveFromExports(dir, value);
      if (file) found.set(subpath, file);
    }
  }

  if (!found.has('.')) {
    // `types`, `typings`, the declaration next to `main`, an `index.d.ts` in main's directory, a root `index.d.ts`.
    const mainDir =
      typeof pkg.main === 'string' ? join(dirname(pkg.main), 'index.d.ts') : undefined;
    const candidates = [pkg.types, pkg.typings, pkg.main, mainDir, 'index.d.ts'].filter(
      (c): c is string => typeof c === 'string',
    );
    for (const c of candidates) {
      const file = resolveTypesFile(dir, c);
      if (file) {
        found.set('.', file);
        break;
      }
    }
  }

  if (exportsField === undefined) {
    for (const [subpath, file] of implicitSubpaths(dir, found.get('.'))) {
      if (!found.has(subpath)) found.set(subpath, file);
    }
  }

  if (found.size === 0) throw new NoTypesError(name, version);
  return [...found.entries()]
    .map(([entry, file]) => ({ entry, file }))
    .sort((a, b) => (a.entry === '.' ? -1 : b.entry === '.' ? 1 : a.entry.localeCompare(b.entry)));
}
