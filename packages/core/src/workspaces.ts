import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
 * A workspace glob as a RegExp over `/`-separated paths relative to the root: `*` and `?`
 * stay inside one segment, `**` spans any number of them.
 * ponytail: no brace sets (`{a,b}`) or character classes; add them if a real workspace uses one.
 */
function globRegExp(glob: string): RegExp {
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

/** Directories below the root holding a package.json, outside node_modules and dot-directories. */
function packageDirs(root: string, rel = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.'))
      continue;
    const dir = rel ? `${rel}/${entry.name}` : entry.name;
    if (existsSync(join(root, dir, 'package.json'))) found.push(dir);
    found.push(...packageDirs(root, dir));
  }
  return found;
}

/**
 * Workspace packages declared by pnpm-workspace.yaml (`packages:`) or package.json
 * `workspaces` (npm, yarn), matched as globs with `!` exclusions. The root is a workspace
 * too; directories without a package.json are not packages. A file that declares packages
 * none of which exist is an error: checking the root alone would look like a clean result.
 */
export function workspacePackagesOf(root: string): string[] {
  const declared = declaredPatterns(root);
  if (!declared) return ['.'];
  const clean = (p: string): string => p.replace(/^\.\//, '').replace(/\/+$/, '');
  const include = declared.patterns
    .filter((p) => !p.startsWith('!'))
    .map((p) => globRegExp(clean(p)));
  const exclude = declared.patterns
    .filter((p) => p.startsWith('!'))
    .map((p) => globRegExp(clean(p.slice(1))));
  if (include.length === 0) return ['.'];
  const found = packageDirs(root).filter(
    (dir) => include.some((re) => re.test(dir)) && !exclude.some((re) => re.test(dir)),
  );
  if (found.length === 0)
    throw new UptideError(
      'INVALID_WORKSPACE',
      `${declared.file} declares packages (${declared.patterns.join(', ')}) but none of them matches a directory with a package.json; fix the patterns, or Uptide would check only the root`,
    );
  return ['.', ...found].sort();
}
