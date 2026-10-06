import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Project, type ResolutionHostFactory, ts } from 'ts-morph';
import type { RepoDir } from '../../domain/adapter.js';
import { UptideError } from '../../errors.js';
import { onReset } from '../../shared-state.js';
import { type Lockfile, readLockfile } from './lockfile.js';
import { declaredPaths, workspaceSourceMap } from './workspace-source.js';

/**
 * A consumer repository, loaded read-only: package.json for declared dependencies, the
 * lockfile (this package's importer, even when the lockfile sits at a workspace root)
 * for installed versions, and a ts-morph project built from the repo's own tsconfig
 * (paths, include, project references one level down) or a synthesized one. Nothing in
 * the repository is executed.
 */

export interface LoadedRepo {
  dir: string;
  packageJson: {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  lockfile: Lockfile | undefined;
  /** name -> exact installed version for this package's direct dependencies (from the lockfile). */
  installed: Map<string, string>;
  project: Project;
  tsconfig: string | undefined;
  /** `allowJs` from the tsconfig: whether `.js`/`.jsx` files are part of the project and the scan. */
  includesJs: boolean;
  /** Workspace dependencies compiled from their built output because no source could be mapped, when that output is stale. */
  warnings: string[];
}

/** Nearest ancestor (or `cwd` itself) that has a package.json. */
export function findRepoRoot(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const SYNTHETIC_EXCLUDES = ['**/node_modules/**', '**/dist/**', '**/build/**'];

const repos = new Map<string, LoadedRepo>();
// A program or checker a failed analysis was inside may be half updated: reload them.
onReset(() => repos.clear());

/** `loadRepo`, cached by directory: a parsed program is reused across every package checked in a workspace. */
export function loadedRepo(dir: string, rootFiles?: string[]): LoadedRepo {
  dir = realpathSync(dir);
  rootFiles = rootFiles?.map((file) => realpathSync(file));
  const key = JSON.stringify([dir, rootFiles?.slice().sort()]);
  let repo = repos.get(key);
  if (!repo) {
    repo = loadRepo(dir, rootFiles);
    repos.set(key, repo);
  }
  return repo;
}

/** Forget a cached repository (after a workspace is done, in tests, or after the user edits files). */
export function forgetRepo(dir: string): void {
  for (const key of repos.keys()) if (JSON.parse(key)[0] === dir) repos.delete(key);
}

/**
 * Whether a file is one of the repository's own, and not handed to another workspace package.
 * The program reports real paths; an excluded directory may be named through a symlink
 * (`/var/...` for `/private/var/...` on macOS), so both forms are tried.
 */
export function ownsFile(repoRef: RepoDir, path: string): boolean {
  return !(repoRef.exclude ?? []).some(
    (d) => path.startsWith(`${d}/`) || path.startsWith(`${realDir(d)}/`),
  );
}

const realDirs = new Map<string, string>();
function realDir(dir: string): string {
  let real = realDirs.get(dir);
  if (real === undefined) {
    try {
      real = realpathSync(dir);
    } catch {
      real = dir;
    }
    realDirs.set(dir, real);
  }
  return real;
}

/** package.json plus lockfile: what is installed, without parsing a single source file. */
export function readInstalled(
  cwd: string,
): Pick<LoadedRepo, 'dir' | 'packageJson' | 'lockfile' | 'installed'> {
  const dir = findRepoRoot(cwd);
  if (!dir)
    throw new UptideError(
      'NO_PROJECT',
      `${cwd}: no package.json found here or in any parent directory`,
    );
  const packageJson = JSON.parse(
    readFileSync(join(dir, 'package.json'), 'utf8'),
  ) as LoadedRepo['packageJson'];
  const declared = new Map(
    Object.entries({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
      ...packageJson.optionalDependencies,
    }),
  );
  const lockfile = readLockfile(dir, declared);
  return { dir, packageJson, lockfile, installed: new Map(lockfile?.installed ?? []) };
}

/**
 * Under Node16/NodeNext a package answers `import` and `require` with different declaration
 * files (stripe 22 ships `esm/` and `cjs/`). ts-morph parses files without their module
 * format, so every import would read as CommonJS and land on the `require` declarations,
 * which the package's surface (read as a modern consumer sees it) does not describe: no
 * usage would be found. Each import is resolved in the format of the file that writes it,
 * which the nearest package.json `type` and the extension decide, as `tsc` does.
 */
const formatAwareResolution: ResolutionHostFactory = (host, getOptions) => {
  const formats = new Map<string, ts.ResolutionMode>();
  return {
    resolveModuleNames(names, containingFile, _reused, redirected, options) {
      const opts = options ?? getOptions();
      const nodeish =
        opts.moduleResolution === ts.ModuleResolutionKind.Node16 ||
        opts.moduleResolution === ts.ModuleResolutionKind.NodeNext;
      let mode: ts.ResolutionMode;
      if (nodeish) {
        if (!formats.has(containingFile))
          formats.set(
            containingFile,
            ts.getImpliedNodeFormatForFile(containingFile, undefined, host, opts),
          );
        mode = formats.get(containingFile);
      }
      return names.map(
        (name) =>
          ts.resolveModuleName(name, containingFile, opts, host, undefined, redirected, mode)
            .resolvedModule,
      );
    },
  };
};

export function loadRepo(cwd: string, rootFiles?: string[]): LoadedRepo {
  const { dir, packageJson, lockfile, installed } = readInstalled(cwd);

  const tsconfig = join(dir, 'tsconfig.json');
  // Workspace dependencies resolve to their source, not to whatever their last build left in dist.
  const sources = workspaceSourceMap(dir, installed);
  const sourcePaths = Object.keys(sources.paths).length > 0 ? sources.paths : undefined;
  let project: Project;
  if (existsSync(tsconfig)) {
    const declared = sourcePaths ? declaredPaths(tsconfig) : { paths: {} };
    project = new Project({
      tsConfigFilePath: tsconfig,
      skipAddingFilesFromTsConfig: rootFiles !== undefined,
      skipFileDependencyResolution: true,
      resolutionHost: formatAwareResolution,
      compilerOptions: {
        noEmit: true,
        skipLibCheck: true,
        ...(sourcePaths ? { paths: { ...declared.paths, ...sourcePaths } } : {}),
      },
    });
    // Project references one level down: their files are part of what this repo compiles.
    for (const ref of rootFiles === undefined ? readReferences(tsconfig) : []) {
      try {
        project.addSourceFilesFromTsConfig(ref);
      } catch {
        // A missing referenced project is the repo's problem, not ours.
      }
    }
  } else {
    project = new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowJs: false,
        ...(sourcePaths ? { paths: sourcePaths } : {}),
      },
    });
    if (rootFiles === undefined)
      project.addSourceFilesAtPaths([
        join(dir, '**/*.ts'),
        join(dir, '**/*.tsx'),
        ...SYNTHETIC_EXCLUDES.map((e) => `!${join(dir, e)}`),
      ]);
  }
  if (rootFiles !== undefined) project.addSourceFilesAtPaths(rootFiles);
  project.resolveSourceFileDependencies();
  return {
    dir,
    packageJson,
    lockfile,
    installed,
    project,
    tsconfig: existsSync(tsconfig) ? tsconfig : undefined,
    includesJs: project.getCompilerOptions().allowJs === true,
    warnings: sources.warnings,
  };
}

function readReferences(tsconfig: string): string[] {
  try {
    const parsed = ts.readConfigFile(tsconfig, (p) => readFileSync(p, 'utf8'));
    const refs = (parsed.config as { references?: { path: string }[] })?.references ?? [];
    return refs.map((r) => {
      const p = resolve(dirname(tsconfig), r.path);
      return p.endsWith('.json') ? p : join(p, 'tsconfig.json');
    });
  } catch {
    return [];
  }
}

export { workspacePackagesOf } from '../../workspaces.js';
