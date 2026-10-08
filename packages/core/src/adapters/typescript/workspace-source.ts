import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { ts } from 'ts-morph';

/**
 * A workspace dependency (`link:`, `workspace:`, `file:`) is consumed through its built
 * `dist/*.d.ts`, which is whatever the last build left there: `packages/api` type-checked
 * against a `shared/dist` built on zod 3 reports thirty-five zod 4 errors that are not
 * api's. The source is the truth, so the dependency's entry points are mapped to it:
 * `types`/`exports` targets under the dependency's `outDir` are rewritten under its
 * `rootDir` (tsconfig), or `dist/` to `src/` when there is no tsconfig, and offered to the
 * compiler as `paths`. What cannot be mapped keeps the dist, with a warning when that
 * dist is older than the source it was built from.
 */

export interface WorkspaceSourceMap {
  /** `paths` entries for the compiler: specifier -> [absolute source file]. */
  paths: Record<string, string[]>;
  warnings: string[];
}

interface Manifest {
  types?: string;
  typings?: string;
  exports?: unknown;
}

const LINK = /^(link|workspace|file):/;

function typesTargets(manifest: Manifest): Map<string, string> {
  const out = new Map<string, string>();
  const main = manifest.types ?? manifest.typings;
  if (main) out.set('.', main);
  const visit = (key: string, value: unknown): void => {
    if (typeof value === 'string') {
      if (value.endsWith('.d.ts') || value.endsWith('.d.mts') || value.endsWith('.d.cts')) {
        if (!out.has(key)) out.set(key, value);
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.startsWith('.')) visit(k, v);
      else if (k === 'types' || k === 'import' || k === 'default' || k === 'require') visit(key, v);
    }
  };
  if (manifest.exports) visit('.', manifest.exports);
  return out;
}

function buildDirs(depDir: string): { rootDir: string; outDir: string } | undefined {
  const tsconfig = join(depDir, 'tsconfig.json');
  if (!existsSync(tsconfig)) return undefined;
  const parsed = ts.readConfigFile(tsconfig, (p) => readFileSync(p, 'utf8'));
  if (!parsed.config) return undefined;
  const options = ts.parseJsonConfigFileContent(parsed.config, ts.sys, depDir).options;
  if (!options.outDir || !options.rootDir) return undefined;
  return { rootDir: resolve(depDir, options.rootDir), outDir: resolve(depDir, options.outDir) };
}

/** `dist/container/index.d.ts` -> `src/container/index.ts` (or .tsx), when that file exists. */
function sourceFor(depDir: string, distFile: string): string | undefined {
  const abs = resolve(depDir, distFile);
  const dirs = buildDirs(depDir);
  const candidates: string[] = [];
  if (dirs && abs.startsWith(`${dirs.outDir}/`))
    candidates.push(join(dirs.rootDir, relative(dirs.outDir, abs)));
  if (abs.includes('/dist/')) candidates.push(abs.replace('/dist/', '/src/'));
  for (const c of candidates) {
    const base = c.replace(/\.d\.(m|c)?ts$/, '');
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
      if (existsSync(base + ext)) return base + ext;
    }
  }
  return undefined;
}

function newestMtime(dir: string, depth = 0): number {
  let newest = 0;
  try {
    for (const entry of readdirSafe(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (entry !== 'node_modules' && depth < 6)
          newest = Math.max(newest, newestMtime(p, depth + 1));
      } else if (/\.(ts|tsx|mts|cts)$/.test(entry) && !entry.endsWith('.d.ts')) {
        newest = Math.max(newest, st.mtimeMs);
      }
    }
  } catch {
    // unreadable: nothing newer known
  }
  return newest;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The dependency's directory: the symlink under the workspace's node_modules or an ancestor's
 * (Yarn and npm hoist workspace links to the root), or the link target itself.
 */
function linkedDir(repoDir: string, name: string, specifier: string): string | undefined {
  for (let dir = repoDir; ; dir = dirname(dir)) {
    const viaNodeModules = join(dir, 'node_modules', name);
    if (existsSync(viaNodeModules)) {
      try {
        return realpathSync(viaNodeModules);
      } catch {
        // dangling link
      }
    }
    if (dirname(dir) === dir) break;
  }
  const m = /^(?:link|file):(.+)$/.exec(specifier);
  if (m) {
    const target = resolve(repoDir, m[1] as string);
    if (existsSync(target)) return realpathSync(target);
  }
  return undefined;
}

/**
 * The map covers the workspace's own linked dependencies and, through them, theirs: a source
 * entry of `@tldraw/editor` re-exports from `@tldraw/utils`, which must map to source too or
 * every name that passes through it is missing. Each package is visited once.
 */
export function workspaceSourceMap(
  repoDir: string,
  installed: Map<string, string>,
): WorkspaceSourceMap {
  const paths: Record<string, string[]> = {};
  const warnings: string[] = [];
  const queue: { from: string; name: string; specifier: string }[] = [...installed]
    .filter(([, specifier]) => LINK.test(specifier))
    .map(([name, specifier]) => ({ from: repoDir, name, specifier }));
  const seen = new Set<string>();
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { from, name, specifier } = next;
    if (seen.has(name)) continue;
    seen.add(name);
    const depDir = linkedDir(from, name, specifier);
    if (!depDir) continue;
    let manifest: Manifest & {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    try {
      manifest = JSON.parse(readFileSync(join(depDir, 'package.json'), 'utf8')) as typeof manifest;
    } catch {
      continue;
    }
    for (const [dep, range] of Object.entries({
      ...manifest.peerDependencies,
      ...manifest.dependencies,
    }))
      if (LINK.test(range) && !seen.has(dep))
        queue.push({ from: depDir, name: dep, specifier: range });
    let mapped = 0;
    let unmapped: string | undefined;
    for (const [subpath, distFile] of typesTargets(manifest)) {
      if (subpath.includes('*')) continue;
      const source = sourceFor(depDir, distFile);
      const specifierKey = subpath === '.' ? name : `${name}/${subpath.slice(2)}`;
      if (source) {
        paths[specifierKey] = [source];
        mapped++;
      } else {
        unmapped ??= distFile;
      }
    }
    if (mapped === 0 && unmapped !== undefined) {
      const distPath = resolve(depDir, unmapped);
      const dirs = buildDirs(depDir);
      const srcDir = dirs?.rootDir ?? join(depDir, 'src');
      try {
        const distTime = statSync(distPath).mtimeMs;
        if (newestMtime(srcDir) > distTime) {
          warnings.push(
            `${name}: compiled against its built ${relative(depDir, distPath)}, which is older than its source; rebuild it or the results may be stale`,
          );
        }
      } catch {
        // no dist either: the compiler will say so
      }
    }
  }
  return { paths, warnings };
}

/** `paths` the tsconfig already declares, so the workspace mapping adds to them instead of replacing them. */
export function declaredPaths(tsconfig: string): {
  paths: Record<string, string[]>;
  baseUrl?: string;
} {
  const parsed = ts.readConfigFile(tsconfig, (p) => readFileSync(p, 'utf8'));
  if (!parsed.config) return { paths: {} };
  const options = ts.parseJsonConfigFileContent(parsed.config, ts.sys, dirname(tsconfig)).options;
  return { paths: options.paths ?? {}, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) };
}
