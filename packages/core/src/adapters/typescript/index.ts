import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { type ModuleDeclaration, Project, type SourceFile, ts } from 'ts-morph';
import type { LanguageAdapter, PackageDir, RepoDir } from '../../domain/adapter.js';
import * as P from '../../domain/path.js';
import type { ApiSurface, ApiSymbol } from '../../domain/surface.js';
import { compareTypesWithChecker } from './compat.js';
import { compileAgainstTarget, compileAgainstTargets } from './compile.js';
import { resolveEntryPoints } from './entry-points.js';
import { forgetRepo, loadedRepo, readInstalled, workspacePackagesOf } from './repo.js';
import {
  findUsagesInRepo,
  importedPackagesOf,
  installedDependenciesOf,
  installedPackageDir,
} from './usages.js';
import {
  type AliasClass,
  ambientModuleName,
  assignAliases,
  ownEntryOf,
  type Sink,
  walkModule,
} from './walk.js';

export interface TypescriptAdapterOptions {
  /** Injected clock so snapshots are stable. */
  now?: () => Date;
}

interface Collected {
  symbol: ApiSymbol;
  root: string;
}

/** Every file an entry point pulls in through imports, re-exports and reference directives. */
function reachableFiles(entry: SourceFile): SourceFile[] {
  const seen = new Set<SourceFile>([entry]);
  const queue = [entry];
  for (let i = 0; i < queue.length; i++) {
    for (const next of (queue[i] as SourceFile).getReferencedSourceFiles()) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen];
}

/** Already-scoped paths (foreign augmentations) keep their scope; a collision there is left alone. */
function rescope(path: string, entry: string): string {
  return P.splitPath(path).scope === undefined ? P.scoped(entry, path) : path;
}

/**
 * Merges the per-entry-point walks into one surface. Entry points are visited root first.
 * A path already taken by a different declaration (rule 8) moves the newcomer, with its
 * whole subtree, under a `"./subpath":` scope. A path taken by the same declaration only
 * gains another `exportedFrom` entry.
 */
function merge(
  perEntry: { entry: string; symbols: Collected[]; roots: Map<string, Set<ts.Node>> }[],
): ApiSymbol[] {
  const byPath = new Map<string, ApiSymbol>();

  // Collisions are decided over all entry points first, so the outcome does not depend on
  // which subpath happens to be visited before another (a new `./gel-core` must not steal
  // the bare `uuid` that `./pg-core` had). The root entry keeps the bare path; every other
  // entry whose declaration differs is scoped.
  const rootDecls = new Map<string, Set<ts.Node>>();
  for (const { entry, roots } of perEntry) {
    if (entry !== '.') continue;
    for (const [root, decls] of roots) rootDecls.set(root, new Set(decls));
  }
  const groups = new Map<string, Set<ts.Node>[]>();
  for (const { roots } of perEntry) {
    for (const [root, decls] of roots) {
      const list = groups.get(root) ?? [];
      const shared = list.find((g) => [...decls].some((d) => g.has(d)));
      if (shared) for (const d of decls) shared.add(d);
      else list.push(new Set(decls));
      groups.set(root, list);
    }
  }
  const collidingFor = (entry: string, roots: Map<string, Set<ts.Node>>): Set<string> => {
    const out = new Set<string>();
    if (entry === '.') return out;
    for (const [root, decls] of roots) {
      if ((groups.get(root)?.length ?? 0) < 2) continue;
      const atRoot = rootDecls.get(root);
      if (atRoot && [...decls].some((d) => atRoot.has(d))) continue;
      out.add(root);
    }
    return out;
  };

  for (const { entry, symbols, roots } of perEntry) {
    const collidingRoots = collidingFor(entry, roots);
    for (const { symbol, root } of symbols) {
      const path = collidingRoots.has(root) ? rescope(symbol.path, entry) : symbol.path;
      // The walker's declaration classes hold this same object; the final path must be visible there too.
      symbol.path = path;
      const existing = byPath.get(path);
      if (existing) {
        if (!existing.exportedFrom.includes(entry)) existing.exportedFrom.push(entry);
        continue;
      }
      byPath.set(path, { ...symbol, path, exportedFrom: [entry] });
    }
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A surface plus, for every declaration the walker emitted, `file:start` -> canonical path. Adapter-internal. */
export interface DetailedSurface {
  surface: ApiSurface;
  locations: Map<string, string>;
}

export function locationKey(fileName: string, start: number): string {
  return `${fileName}:${start}`;
}

export interface TypescriptAdapter extends LanguageAdapter {
  findUsages: NonNullable<LanguageAdapter['findUsages']>;
  /** Where the repository's compiler finds `pkg`, as a package root. */
  installedPackageDir(repo: RepoDir, pkg: string): string | undefined;
  extractSurfaceDetailed(pkg: PackageDir): Promise<DetailedSurface>;
  /** The surface of the copy of `pkg` the repository actually resolves to (installed on disk), or undefined when it cannot be resolved. */
  installedSurface(repo: RepoDir, pkg: string, version: string): Promise<ApiSurface | undefined>;
}

export function createTypescriptAdapter(opts: TypescriptAdapterOptions = {}): TypescriptAdapter {
  const now = opts.now ?? (() => new Date());
  const adapter: TypescriptAdapter = {
    id: 'typescript',
    compareTypes: compareTypesWithChecker,
    findUsages: (repo, pkg, surface) => findUsagesInRepo(adapter, repo, pkg, surface),
    compileAgainst: compileAgainstTarget,
    compileAgainstMany: compileAgainstTargets,
    async installedDependencies(repo) {
      return installedDependenciesOf(repo);
    },
    installedPackageDir(repo, pkg) {
      return installedPackageDir(repo, pkg);
    },
    async importedPackages(repo) {
      return importedPackagesOf(repo);
    },
    async workspacePackages(root) {
      return workspacePackagesOf(root.dir);
    },
    async repoWarnings(repo) {
      return loadedRepo(realpathSync(repo.dir), repo.rootFiles).warnings;
    },
    async declaredSpecifiers(repo) {
      const { packageJson } = readInstalled(realpathSync(repo.dir));
      return new Map(
        Object.entries({
          ...packageJson.dependencies,
          ...packageJson.devDependencies,
          ...packageJson.optionalDependencies,
        }),
      );
    },
    forgetRepo(repo) {
      forgetRepo(realpathSync(repo.dir));
    },
    async installedSurface(repo, pkg, version) {
      const dir = installedPackageDir(repo, pkg);
      return dir ? adapter.extractSurface({ name: pkg, version, dir }) : undefined;
    },
    async extractSurface(pkg: PackageDir): Promise<ApiSurface> {
      return (await adapter.extractSurfaceDetailed(pkg)).surface;
    },
    async extractSurfaceDetailed(pkg: PackageDir): Promise<DetailedSurface> {
      const entries = resolveEntryPoints(pkg.dir, pkg.name, pkg.version);
      const project = new Project({
        skipAddingFilesFromTsConfig: true,
        skipFileDependencyResolution: true,
        compilerOptions: {
          // Bundler resolution accepts both extensionless and `.js` relative imports in .d.ts
          // files and understands `exports` maps, which is what shipped declarations use.
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ESNext,
          skipLibCheck: true,
          noEmit: true,
          // Never pull @types from a node_modules we did not create.
          types: [],
        },
      });
      const files = entries.map((e) => ({
        entry: e.entry,
        file: project.addSourceFileAtPath(e.file),
      }));
      // Node builtins (`events`, `http`) are ambient modules of @types/node: the consumer's copy makes them resolve.
      for (const typesDir of pkg.types ?? []) {
        const index = join(typesDir, 'index.d.ts');
        if (existsSync(index)) project.addSourceFileAtPath(index);
      }
      project.resolveSourceFileDependencies();
      const checker = project.getTypeChecker();
      const byDeclaration = new Map<ts.Node, AliasClass>();

      const sinks = new Map<
        string,
        { sink: Sink; symbols: Collected[]; roots: Map<string, Set<ts.Node>> }
      >();
      const sinkFor = (entry: string) => {
        let s = sinks.get(entry);
        if (!s) {
          const symbols: Collected[] = [];
          const roots = new Map<string, Set<ts.Node>>();
          s = {
            symbols,
            roots,
            sink: {
              entry,
              packageDir: pkg.dir,
              checker,
              byDeclaration,
              rootDecls: roots,
              emit(root, symbol) {
                symbols.push({ symbol, root });
              },
            },
          };
          sinks.set(entry, s);
        }
        return s;
      };
      for (const e of entries) sinkFor(e.entry);

      // Ambient modules merge across files, so each name is walked once: own-package
      // modules under the entry their name denotes, foreign augmentations under every
      // entry whose file graph includes them.
      const ownModules = new Map<string, ModuleDeclaration>();
      const foreign = new Map<string, { mod: ModuleDeclaration; entries: Set<string> }>();
      for (const { entry, file } of files) {
        walkModule(sinkFor(entry).sink, file);
        for (const reached of reachableFiles(file)) {
          for (const mod of reached.getModules()) {
            const name = ambientModuleName(mod);
            if (name === undefined) continue;
            const own = ownEntryOf(name, pkg.name);
            if (own !== undefined) {
              if (!ownModules.has(name)) ownModules.set(name, mod);
            } else {
              const f = foreign.get(name) ?? { mod, entries: new Set<string>() };
              f.entries.add(entry);
              foreign.set(name, f);
            }
          }
        }
      }
      for (const [name, mod] of ownModules) {
        walkModule(sinkFor(ownEntryOf(name, pkg.name) as string).sink, mod);
      }
      for (const [name, { mod, entries: reachedFrom }] of foreign) {
        for (const entry of reachedFrom) walkModule(sinkFor(entry).sink, mod, name);
      }

      assignAliases(byDeclaration);
      const perEntry = [...sinks.entries()]
        .sort(([a], [b]) => (a === '.' ? -1 : b === '.' ? 1 : a < b ? -1 : 1))
        .map(([entry, s]) => ({ entry, symbols: s.symbols, roots: s.roots }));

      const surface: ApiSurface = {
        package: pkg.name,
        version: pkg.version,
        extractedAt: now().toISOString(),
        adapter: 'typescript',
        symbols: merge(perEntry),
      };
      const locations = new Map<string, string>();
      for (const [node, cls] of byDeclaration) {
        const canonical = cls.symbols.find((s) => s.aliasOf === undefined) ?? cls.symbols[0];
        if (canonical)
          locations.set(
            locationKey(node.getSourceFile().fileName, node.getStart()),
            canonical.path,
          );
      }
      return { surface, locations };
    },
  };
  return adapter;
}

export const typescriptAdapter: LanguageAdapter = createTypescriptAdapter();
