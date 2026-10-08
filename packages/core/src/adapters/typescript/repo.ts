import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Project, type ResolutionHostFactory, ts } from 'ts-morph';
import type { RepoDir } from '../../domain/adapter.js';
import { UptideError } from '../../errors.js';
import { onReset } from '../../shared-state.js';
import { repositoryTypescriptMajor, typescriptFiveDefaults } from './legacy-options.js';
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
  /** The repository's own tsconfig.json, when it has one. */
  tsconfig: string | undefined;
  /** Without one, the nearest tsconfig.json above it (a monorepo root's that includes this workspace): its options apply, not its file list. */
  inheritedTsconfig: string | undefined;
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

/** The nearest tsconfig.json strictly above `dir`, as a workspace without its own is configured by. */
export function inheritedTsconfigOf(dir: string): string | undefined {
  for (let current = dirname(resolve(dir)); ; current = dirname(current)) {
    const candidate = join(current, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;
    if (dirname(current) === current) return undefined;
  }
}

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
  const installed = new Map(lockfile?.installed ?? []);
  // A workspace package is declared as `workspace:*`, `link:` or `file:`; what the lockfile
  // records for it differs by manager (pnpm `link:../x`, Yarn `0.0.0-use.local`, npm nothing).
  // The declared specifier says what it is, and that is what the rest of the engine reads.
  for (const [name, spec] of declared)
    if (
      /^(workspace|link|file):/.test(spec) &&
      !/^(workspace|link|file):/.test(installed.get(name) ?? '')
    )
      installed.set(name, spec);
  return { dir, packageJson, lockfile, installed };
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
  // A repository on TypeScript 5 is read with TypeScript 5's defaults for what its tsconfig
  // leaves unset (legacy-options.ts); one on TypeScript 6 with the compiler's own.
  const major = repositoryTypescriptMajor(dir);
  const legacyDefaults = (config: string): ts.CompilerOptions =>
    major === undefined || major < 6 ? typescriptFiveDefaults(declaredOptions(config)) : {};
  const inherited = existsSync(tsconfig) ? undefined : inheritedTsconfigOf(dir);
  if (existsSync(tsconfig)) {
    const declared = sourcePaths ? declaredPaths(tsconfig) : { paths: {} };
    const legacy = legacyDefaults(tsconfig);
    project = new Project({
      tsConfigFilePath: tsconfig,
      skipAddingFilesFromTsConfig: rootFiles !== undefined,
      skipFileDependencyResolution: true,
      resolutionHost: formatAwareResolution,
      compilerOptions: {
        ...legacy,
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
    // No tsconfig of its own: the options of the one above it (a monorepo root's `include`
    // often covers the workspace), over the defaults below; the file list is the workspace's.
    project = new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        allowJs: false,
        ...(inherited ? { ...legacyDefaults(inherited), ...declaredOptions(inherited) } : {}),
        noEmit: true,
        skipLibCheck: true,
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
  if (rootFiles !== undefined) {
    project.addSourceFilesAtPaths(rootFiles);
    // A scoped program still needs what the tsconfig declares globally: the ambient
    // declaration files it includes (`vite-env.d.ts`, `css.d.ts`, `global.d.ts`) are what
    // make `*.module.css` imports and `declare global` names resolve. Nothing imports them.
    if (existsSync(tsconfig)) project.addSourceFilesAtPaths(ambientDeclarations(tsconfig));
  }
  project.resolveSourceFileDependencies();
  return {
    dir,
    packageJson,
    lockfile,
    installed,
    project,
    tsconfig: existsSync(tsconfig) ? tsconfig : undefined,
    inheritedTsconfig: inherited,
    includesJs: project.getCompilerOptions().allowJs === true,
    warnings: sources.warnings,
  };
}

/** The options a tsconfig sets, through its `extends` chain: what is unset gets a default. */
function declaredOptions(tsconfig: string): ts.CompilerOptions {
  try {
    const parsed = ts.readConfigFile(tsconfig, (p) => readFileSync(p, 'utf8'));
    if (!parsed.config) return {};
    // The config's path is what the compiler's default type roots are relative to.
    return ts.parseJsonConfigFileContent(
      parsed.config,
      ts.sys,
      dirname(tsconfig),
      undefined,
      tsconfig,
    ).options;
  } catch {
    return {};
  }
}

/** The `.d.ts` files a tsconfig includes from the repository itself, never from node_modules. */
function ambientDeclarations(tsconfig: string): string[] {
  try {
    const parsed = ts.readConfigFile(tsconfig, (p) => readFileSync(p, 'utf8'));
    if (!parsed.config) return [];
    const { fileNames } = ts.parseJsonConfigFileContent(parsed.config, ts.sys, dirname(tsconfig));
    return fileNames.filter((f) => /\.d\.[cm]?ts$/.test(f) && !f.includes('/node_modules/'));
  } catch {
    return [];
  }
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
