import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { UptideError } from './errors.js';

/** The `packages` a workspace file declares, and which file declared them. */
function declaredPatterns(root: string): { file: string; patterns: string[] } | undefined {
  const strings = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
  const yaml = join(root, 'pnpm-workspace.yaml');
  if (existsSync(yaml)) {
    let doc: unknown;
    try {
      doc = parse(readFileSync(yaml, 'utf8'));
    } catch (err) {
      throw new UptideError(
        'INVALID_WORKSPACE',
        `pnpm-workspace.yaml is not valid YAML: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`,
      );
    }
    // pnpm reads only this file; a `packages` key is optional (catalogs and settings alone are fine).
    return {
      file: 'pnpm-workspace.yaml',
      patterns: strings((doc as { packages?: unknown } | null)?.packages),
    };
  }
  let pkg: { workspaces?: unknown };
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return undefined; // no package.json: no workspaces
  }
  // npm and yarn: an array, or yarn's `{ packages: [...], nohoist: [...] }`.
  const workspaces = pkg.workspaces;
  if (workspaces === undefined) return undefined;
  return {
    file: 'package.json "workspaces"',
    patterns: strings(
      Array.isArray(workspaces) ? workspaces : (workspaces as { packages?: unknown })?.packages,
    ),
  };
}

/**
 * A glob as a RegExp over `/`-separated paths relative to the root: `*` and `?` stay inside
 * one segment, `**` spans any number of them. Brace sets (`{a,b}`) and character classes are
 * not supported; no workspace seen so far uses them.
 */
export function globRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Never a workspace package, and often huge: not descended into by a wildcard. */
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', 'bower_components']);

/**
 * The directories holding a package.json that one pattern matches. Only the pattern's static
 * prefix is walked (`packages/*` reads `packages/` one level deep), as deep as the pattern
 * reaches; a `**` has no depth limit, and a leading one walks the whole repository.
 */
function matchingDirs(root: string, pattern: string): string[] {
  const segments = pattern.split('/');
  const firstGlob = segments.findIndex((s) => /[*?]/.test(s));
  if (firstGlob === -1) return existsSync(join(root, pattern, 'package.json')) ? [pattern] : [];
  const rest = segments.slice(firstGlob);
  const re = globRegExp(pattern);
  const found: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth === 0) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return; // a missing or unreadable prefix matches nothing
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue;
      const dir = rel ? `${rel}/${entry.name}` : entry.name;
      if (re.test(dir) && existsSync(join(root, dir, 'package.json'))) found.push(dir);
      walk(dir, depth - 1);
    }
  };
  walk(
    segments.slice(0, firstGlob).join('/'),
    rest.some((s) => s.includes('**')) ? Infinity : rest.length,
  );
  return found;
}

function resolveWorkspaces(root: string): string[] {
  const declared = declaredPatterns(root);
  if (!declared) return ['.'];
  // `.` and `./` name the root, which is always a workspace.
  const clean = (p: string): string => p.replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  const include = declared.patterns.filter((p) => !p.startsWith('!')).map(clean);
  const exclude = declared.patterns
    .filter((p) => p.startsWith('!'))
    .map((p) => globRegExp(clean(p.slice(1))));
  if (include.length === 0) return ['.'];
  const found = new Set([
    '.',
    ...include
      .filter((pattern) => pattern !== '.')
      .flatMap((pattern) => matchingDirs(root, pattern))
      .filter((dir) => !exclude.some((re) => re.test(dir))),
  ]);
  if (found.size === 1 && !include.includes('.'))
    throw new UptideError(
      'INVALID_WORKSPACE',
      `${declared.file} declares packages (${declared.patterns.join(', ')}) but none of them matches a directory with a package.json; fix the patterns, or Uptide would check only the root`,
    );
  return [...found].sort();
}

/** Per root, for the life of the process: probes call this for every directory they walk. */
const resolved = new Map<string, string[] | UptideError>();

/**
 * Workspace packages declared by pnpm-workspace.yaml (`packages:`) or package.json
 * `workspaces` (npm, yarn), matched as globs with `!` exclusions. The root is a workspace
 * too; directories without a package.json are not packages. A workspace file that is not
 * YAML, or declares packages none of which exist, is an INVALID_WORKSPACE error: checking
 * the root alone would look like a clean result. For list, check and fix; a probe of some
 * other directory uses `workspacePackagesOrRoot`.
 */
export function workspacePackagesOf(root: string): string[] {
  let result = resolved.get(root);
  if (!result) {
    try {
      result = resolveWorkspaces(root);
    } catch (err) {
      if (!(err instanceof UptideError)) throw err;
      result = err;
    }
    resolved.set(root, result);
  }
  if (result instanceof UptideError) throw result;
  return [...result];
}

/** `workspacePackagesOf` for a probe: a directory whose workspace file is broken is just its root. */
export function workspacePackagesOrRoot(root: string): string[] {
  try {
    return workspacePackagesOf(root);
  } catch (err) {
    if (err instanceof UptideError && err.code === 'INVALID_WORKSPACE') return ['.'];
    throw err;
  }
}
