import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { ts } from 'ts-morph';
import type { CompileOptions, RepoDir } from '../../domain/adapter.js';
import type {
  CompileCoverage,
  CompileDiagnostic,
  CompileSignal,
  DiagnosticCause,
} from '../../domain/usage.js';
import { satisfies } from '../../fetch/range.js';
import { onReset } from '../../shared-state.js';
import { findCause, parameterCause } from './cause.js';
import { type Compiler, repositoryCompiler } from './compiler.js';
import { jsxNamespaceCause } from './config-cause.js';
import { type LoadedRepo, loadedRepo, ownsFile } from './repo.js';
import {
  consumerCopySatisfies,
  type DependencyLinks,
  declaredRange,
  installedVersion,
  isPeerOnly,
  newLinks,
  satisfyWanted,
  type Wanted,
} from './target-deps.js';
import { resolvePackageDir } from './usages.js';

/**
 * Signal B: the repository type-checked with one package swapped for its target version.
 * Cheap, exact and coarse: the compiler will not miss a broken call, but it says "error
 * here", not "because `items[].quantity` was removed".
 *
 * Both checks always run. Only diagnostics present in the overlay and absent from the
 * baseline count (matched on file, code and message; positions are not part of the key),
 * so a repository with pre-existing errors still gets the upgrade's errors. The overlay
 * is skipped only when the baseline is structurally broken: an invalid tsconfig, or most
 * files failing to resolve their imports.
 *
 * Cost is kept proportional to the package, not the repository: the overlay program shares
 * the baseline's parsed and bound source files (only the target and its dependencies are
 * parsed fresh), and only the files that use the package, plus the files importing those,
 * are type-checked. A file that neither imports the package nor imports a file that does
 * cannot see a type of it change.
 *
 * The compiler is the repository's own (compiler.ts): its errors, at its positions, are the
 * ones the repository's build would print. The bundled compiler parses the repository for
 * Signal A either way; when it is also the one that judges, the overlay shares its program,
 * otherwise a baseline program is built once per workspace with the repository's compiler.
 */

const CANNOT_FIND_MODULE = 2307;
const CANNOT_FIND_MODULE_JSX = 2792;

function isPackageSpecifier(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

export interface Target {
  name: string;
  dir: string;
  /** The bare specifier this target answers for, when not its own name (`@types/express` for `express`). */
  specifier?: string;
}

function isBare(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/');
}

function messageOf(d: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(d.messageText, '\n');
}

/**
 * The compiler names a module by the file it resolved: the cache or node_modules path on this
 * machine. A report says which package and file, not where this machine keeps it:
 * `"typescript@7.0.2/lib/version"` instead of `"/home/me/.cache/uptide/extracted/typescript/7.0.2/lib/version"`.
 */
export function readableMessage(message: string): string {
  return message
    .replace(
      /(?:[A-Za-z]:)?[\\/][^\s"'()]*[\\/]extracted[\\/]((?:@[^\\/"'\s]+[\\/])?[^\\/"'\s]+)[\\/](\d+\.\d+\.\d+[^\\/"'\s]*)[\\/]/g,
      (_all, name: string, version: string) => `${name.replace('\\', '/')}@${version}/`,
    )
    .replace(
      /(?:[A-Za-z]:)?[\\/][^\s"'()]*[\\/]node_modules[\\/]((?:@[^\\/"'\s]+[\\/])?[^\\/"'\s]+)[\\/]/g,
      (_all, name: string) => `${name.replace('\\', '/')}/`,
    );
}

/** Identity of a diagnostic across the two checks: where, which, and what it says. */
function keyOf(d: ts.Diagnostic, repoDir: string): string {
  const file = relative(repoDir, d.file?.fileName ?? '');
  return `${file}|${d.code}|${messageOf(d).replace(/\s+/g, ' ').trim()}`;
}

function toDiagnostic(d: ts.Diagnostic, file: ts.SourceFile, repoDir: string): CompileDiagnostic {
  const start = d.start ?? 0;
  const from = file.getLineAndCharacterOfPosition(start);
  const to = file.getLineAndCharacterOfPosition(start + (d.length ?? 0));
  return {
    file: relative(repoDir, file.fileName).split('\\').join('/'),
    line: from.line + 1,
    column: from.character + 1,
    endLine: to.line + 1,
    endColumn: to.character + 1,
    code: d.code,
    message: readableMessage(messageOf(d)),
    snippet: (file.text.split('\n')[from.line] ?? '').trim(),
  };
}

function isRepoError(d: ts.Diagnostic, repoDir: string): boolean {
  if (d.category !== ts.DiagnosticCategory.Error || !d.file) return false;
  if (d.file.isDeclarationFile) return false;
  const path = d.file.fileName;
  return path.startsWith(`${repoDir}/`) && !path.includes('/node_modules/');
}

/** Semantic errors of one file, at the installed version, computed once per workspace and file. */
let baselines = new WeakMap<LoadedRepo, Map<string, ts.Diagnostic[]>>();

function baselineErrorsOf(
  repo: LoadedRepo,
  program: ts.Program,
  file: ts.SourceFile,
): ts.Diagnostic[] {
  let perFile = baselines.get(repo);
  if (!perFile) {
    perFile = new Map();
    baselines.set(repo, perFile);
  }
  let errors = perFile.get(file.fileName);
  if (!errors) {
    errors = program.getSemanticDiagnostics(file).filter((d) => isRepoError(d, repo.dir));
    perFile.set(file.fileName, errors);
  }
  return errors;
}

/** file → files importing it, over the repository's own sources, computed once per workspace. */
let importers = new WeakMap<LoadedRepo, Map<string, Set<string>>>();

function importersOf(repo: LoadedRepo): Map<string, Set<string>> {
  let map = importers.get(repo);
  if (map) return map;
  map = new Map();
  for (const file of repo.project.getSourceFiles()) {
    if (file.isDeclarationFile()) continue;
    const from = file.getFilePath();
    for (const decl of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
      const to = decl.getModuleSpecifierSourceFile()?.getFilePath();
      if (!to || to.includes('/node_modules/')) continue;
      let set = map.get(to);
      if (!set) {
        set = new Set();
        map.set(to, set);
      }
      set.add(from);
    }
  }
  importers.set(repo, map);
  return map;
}

/**
 * The files whose diagnostics can change: the ones using the package, and the ones importing
 * those. `missing` counts the requested files the program does not hold (outside the
 * workspace's tsconfig): nothing can be said about them, and the coverage says so.
 */
function filesToCheck(
  repo: LoadedRepo,
  repoRef: RepoDir,
  program: ts.Program,
  requested: string[] | undefined,
): { files: ts.SourceFile[]; missing: number } {
  const own = (f: ts.SourceFile): boolean =>
    !f.isDeclarationFile &&
    isRepoError({ category: ts.DiagnosticCategory.Error, file: f } as ts.Diagnostic, repo.dir) &&
    ownsFile(repoRef, f.fileName);
  if (!requested) return { files: program.getSourceFiles().filter(own), missing: 0 };
  const wanted = new Set<string>();
  const reverse = importersOf(repo);
  let missing = 0;
  for (const rel of requested) {
    const abs = join(repo.dir, rel);
    if (!ownsFile(repoRef, abs)) continue;
    if (!program.getSourceFile(abs)) missing++;
    wanted.add(abs);
    for (const importer of reverse.get(abs) ?? []) wanted.add(importer);
  }
  return {
    files: [...wanted]
      .map((p) => program.getSourceFile(p))
      .filter((f): f is ts.SourceFile => f !== undefined && own(f)),
    missing,
  };
}

const NOT_IN_TSCONFIG = 'not in the workspace tsconfig';

/** What became of the files asked about: compiled, or skipped and why. */
function coverageOf(
  compiler: Compiler,
  compiled: number,
  missing: number,
  skipped?: { reason: string; count: number },
): CompileCoverage {
  const reasons = [
    ...(skipped && skipped.count > 0 ? [skipped] : []),
    ...(missing > 0 ? [{ reason: NOT_IN_TSCONFIG, count: missing }] : []),
  ];
  return {
    compiled,
    total: compiled + reasons.reduce((n, r) => n + r.count, 0),
    skipped: reasons,
    compilers: [{ version: compiler.version, own: compiler.own }],
  };
}

/** A baseline nobody can subtract from: bad config, or most files unable to see their imports. */
function structuralFailure(
  program: ts.Program,
  files: ts.SourceFile[],
  baseline: ts.Diagnostic[],
): string | undefined {
  const config = program.getConfigFileParsingDiagnostics();
  if (config.length > 0)
    return `invalid tsconfig: ${messageOf(config[0] as ts.Diagnostic).split('\n')[0]}`;
  const unresolvable = new Set(
    baseline
      .filter((d) => d.code === CANNOT_FIND_MODULE || d.code === CANNOT_FIND_MODULE_JSX)
      .map((d) => d.file?.fileName),
  ).size;
  if (files.length > 0 && unresolvable / files.length > 0.5) {
    return `${unresolvable} of ${files.length} files cannot resolve their imports at the installed version; compile signal skipped`;
  }
  return undefined;
}

/** The skip reason as the coverage names it: short, without the counts the message carries. */
function skipReasonOf(skipped: string): string {
  if (skipped.startsWith('invalid tsconfig')) return 'invalid tsconfig';
  if (skipped.includes('cannot resolve their imports'))
    return 'most files cannot resolve their imports at the installed version';
  return skipped.split(';')[0] ?? skipped;
}

interface Overlay {
  program: ts.Program;
  /** Real directories of the targets and their linked dependencies. */
  overlayDirs: string[];
  unresolvedInTarget: Set<string>;
  /** Target files (relative to it) with at least one unresolved bare import. */
  unresolvedFiles: Set<string>;
  /** Bare imports met inside the overlay that should be served at a declared version but are not yet. */
  wanted: Map<string, Wanted>;
}

function packageNameOf(specifier: string): string {
  return specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');
}

/**
 * A second program over the same root files whose module resolution sends `pkg` (and its
 * subpaths) to a temp overlay: `overlay/node_modules/<pkg>` is a symlink to the target
 * directory, so the target's own `exports` map applies. The target tarball has no
 * node_modules of its own: its dependencies are linked next to it at the versions it
 * declares (see target-deps.ts), and any other bare import from inside it falls back to
 * the consumer's installed packages; what still fails is counted, not reported as a finding.
 */
/** The compiler options every program of a check uses: the repo's, with JavaScript checked too. */
function checkedOptions(base: ts.Program): ts.CompilerOptions {
  return {
    ...base.getCompilerOptions(),
    noEmit: true,
    skipLibCheck: true,
    // JavaScript files are checked on both sides: the compiler must be able to arbitrate
    // there too, and a repository without `checkJs` would otherwise leave the diff alone.
    checkJs: true,
  };
}

/**
 * A compiler host that shares the ts-morph program's parsed and bound source files, its
 * standard library and its module resolutions, so a second program costs binding and
 * checking only. Files inside `insideOverlay` are parsed fresh (once, into `parsed`).
 */
function sharedHost(
  compiler: Compiler,
  base: ts.Program,
  insideOverlay: (file: string) => boolean,
  parsed: Map<string, ts.SourceFile>,
): {
  options: ts.CompilerOptions;
  host: ts.CompilerHost;
  noPaths: ts.CompilerOptions;
  resolvedByBaseline:
    | ((
        file: ts.SourceFile,
        name: string,
        mode: ts.ResolutionMode,
      ) => ts.ResolvedModuleWithFailedLookupLocations | undefined)
    | undefined;
} {
  const tsc = compiler.ts;
  const options = checkedOptions(base);
  const host = tsc.createCompilerHost(options, true);
  // Shared source files carry the baseline's canonical `path`; the overlay must canonicalize
  // the same way, or `createProgram` rewrites `file.path` on the shared objects and the
  // baseline program can no longer find its own module resolutions. A ts-morph baseline is
  // case-sensitive whatever the file system; a native one canonicalizes as the default host does.
  if (!compiler.own) {
    host.useCaseSensitiveFileNames = () => true;
    host.getCanonicalFileName = (fileName) => fileName;
  }
  host.getCurrentDirectory = () => base.getCurrentDirectory();
  const noPaths: ts.CompilerOptions = { ...options, paths: undefined, baseUrl: undefined };
  // ts-morph serves the standard library from its own bundled copy, whose path the default
  // host does not know; the baseline program already parsed it, so its lib folder is reused.
  const anyLib = base.getSourceFiles().find((f) => /\/lib\.[^/]*\.d\.ts$/.test(f.fileName));
  if (anyLib) {
    const libDir = dirname(anyLib.fileName);
    host.getDefaultLibLocation = () => libDir;
    host.getDefaultLibFileName = (o) => join(libDir, tsc.getDefaultLibFileName(o));
  }
  const defaultFileExists = host.fileExists;
  host.fileExists = (fileName) =>
    base.getSourceFile(fileName) !== undefined || defaultFileExists(fileName);
  const defaultGetSourceFile = host.getSourceFile;
  // Everything the baseline already parsed and bound is shared; only overlay files are new.
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (!insideOverlay(fileName)) {
      const shared = base.getSourceFile(fileName);
      if (shared) return shared;
    }
    // Overlay files are parsed once per compile, not once per round.
    let file = parsed.get(fileName);
    if (!file) {
      file = defaultGetSourceFile(fileName, languageVersion, onError, shouldCreate);
      if (file) parsed.set(fileName, file);
    }
    return file;
  };
  // `getResolvedModule` is internal to the compiler API (stable since 5.3); when a future
  // version drops it, resolution falls back to disk lookups.
  const resolvedByBaseline = (
    base as unknown as {
      getResolvedModule?: (
        file: ts.SourceFile,
        name: string,
        mode: ts.ResolutionMode,
      ) => ts.ResolvedModuleWithFailedLookupLocations | undefined;
    }
  ).getResolvedModule?.bind(base);
  return { options, host, noPaths, resolvedByBaseline };
}

/**
 * The resolution mode of one import, as `tsc` would see it. The baseline's files come from
 * ts-morph without `impliedNodeFormat`, so under Node16/NodeNext every import would read as
 * CommonJS and take a package's `require` condition; the nearest package.json `type` is
 * what the compiler reads, and it is read here once per file.
 */
function usageModes(
  tsc: typeof ts,
  options: ts.CompilerOptions,
  host: ts.ModuleResolutionHost,
): (file: ts.SourceFile, usage: ts.StringLiteralLike) => ts.ResolutionMode {
  const nodeish =
    options.moduleResolution === ts.ModuleResolutionKind.Node16 ||
    options.moduleResolution === ts.ModuleResolutionKind.NodeNext;
  const formats = new Map<string, ts.ResolutionMode>();
  return (file, usage) => {
    if (file.impliedNodeFormat !== undefined || !nodeish)
      return tsc.getModeForUsageLocation(file, usage, options);
    let format = formats.get(file.fileName);
    if (format === undefined && !formats.has(file.fileName)) {
      format = tsc.getImpliedNodeFormatForFile(file.fileName, undefined, host, options);
      formats.set(file.fileName, format);
    }
    // Not mutated: the baseline program keyed its own resolutions by the format it had.
    const withFormat = Object.create(file, {
      impliedNodeFormat: { value: format },
    }) as ts.SourceFile;
    return tsc.getModeForUsageLocation(withFormat, usage, options);
  };
}

type Resolve = (
  name: string,
  literal: ts.StringLiteralLike | undefined,
  containingFile: string,
  containingSourceFile: ts.SourceFile | undefined,
) => ts.ResolvedModuleWithFailedLookupLocations;

/**
 * One resolver, asked the way each compiler asks: TypeScript 5 and later hand over the import
 * literals (`resolveModuleNameLiterals`), TypeScript 4 the names, with the file they sit in.
 */
function installResolver(host: ts.CompilerHost, resolve: Resolve): void {
  host.resolveModuleNameLiterals = (literals, containingFile, _r, _o, containingSourceFile) =>
    literals.map((l) => resolve(l.text, l, containingFile, containingSourceFile));
  host.resolveModuleNames = (names, containingFile, _reused, _redirect, _o, containingSourceFile) =>
    names.map((name) => {
      // The file's import literals are kept by the parser (`imports` is internal, and older
      // than TypeScript 4 itself); the one for this name says which resolution mode applies.
      const literal = (
        containingSourceFile as { imports?: readonly ts.StringLiteralLike[] } | undefined
      )?.imports?.find((l) => l.text === name);
      return resolve(name, literal, containingFile, containingSourceFile).resolvedModule;
    });
}

/**
 * The repository's own compiler over the files the ts-morph program holds, built once per
 * workspace, with the options the repository's tsconfig gives that compiler (not the ones
 * the bundled compiler read into the ts-morph program: an option the newer compiler
 * dropped, or defaults differently, is the repository's compiler's to read). With the
 * bundled compiler, the ts-morph program itself is the baseline.
 */
let nativeBases = new WeakMap<LoadedRepo, ts.Program>();

function nativeBase(repo: LoadedRepo, compiler: Compiler): ts.Program {
  const morph = repo.project.getProgram().compilerObject;
  if (!compiler.own) return morph;
  let program = nativeBases.get(repo);
  if (program) return program;
  const tsc = compiler.ts;
  const options: ts.CompilerOptions = {
    ...nativeOptions(repo, tsc, morph.getCompilerOptions()),
    noEmit: true,
    skipLibCheck: true,
    checkJs: true,
  };
  program = tsc.createProgram({
    rootNames: [...morph.getRootFileNames()],
    options,
    host: tsc.createCompilerHost(options, true),
  });
  nativeBases.set(repo, program);
  return program;
}

function nativeOptions(
  repo: LoadedRepo,
  tsc: typeof ts,
  morph: ts.CompilerOptions,
): ts.CompilerOptions {
  // The workspace's own tsconfig, else the one above it (repo.ts), read by this compiler.
  const config = repo.tsconfig ?? repo.inheritedTsconfig;
  let declared: ts.CompilerOptions | undefined;
  if (config) {
    try {
      const parsed = tsc.readConfigFile(config, (p) => readFileSync(p, 'utf8'));
      if (parsed.config)
        declared = tsc.parseJsonConfigFileContent(
          parsed.config,
          tsc.sys,
          dirname(config),
          undefined,
          config,
        ).options;
    } catch {
      // Unreadable by this compiler: the synthetic options below, as for no tsconfig at all.
    }
  }
  return {
    ...(declared ?? {
      target: tsc.ScriptTarget.ES2022,
      module: tsc.ModuleKind.ESNext,
      // `bundler` arrived with TypeScript 5; before it, `node` (Node10, value 2) is the nearest.
      moduleResolution: tsc.ModuleResolutionKind.Bundler ?? (2 as ts.ModuleResolutionKind),
      strict: true,
      allowJs: morph.allowJs ?? false,
      // The modern defaults the bundled compiler would apply.
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
    }),
    // Workspace dependencies mapped to their source (repo.ts): the same map, whichever compiler.
    ...(morph.paths ? { paths: morph.paths } : {}),
    ...(config ? { configFilePath: config } : {}),
  };
}

/** The baseline with JavaScript checked, once per workspace: the ts-morph program has the repo's own `checkJs`. */
let checkedBaselines = new WeakMap<LoadedRepo, ts.Program>();
// Keyed by a repository a reset already discards; dropped explicitly all the same.
onReset(() => {
  baselines = new WeakMap();
  importers = new WeakMap();
  checkedBaselines = new WeakMap();
  nativeBases = new WeakMap();
});

function checkedBaseline(repo: LoadedRepo, compiler: Compiler, base: ts.Program): ts.Program {
  // A native baseline is built with JavaScript checked from the start.
  if (compiler.own) return base;
  let program = checkedBaselines.get(repo);
  if (program) return program;
  const tsc = compiler.ts;
  const { options, host, resolvedByBaseline } = sharedHost(compiler, base, () => false, new Map());
  installResolver(
    host,
    (name, literal, containingFile, containingSourceFile) =>
      (literal && containingSourceFile
        ? resolvedByBaseline?.(
            containingSourceFile,
            name,
            tsc.getModeForUsageLocation(containingSourceFile, literal, options),
          )
        : undefined) ?? tsc.resolveModuleName(name, containingFile, options, host),
  );
  program = tsc.createProgram({ rootNames: [...base.getRootFileNames()], options, host });
  checkedBaselines.set(repo, program);
  return program;
}

function overlayProgram(
  repo: LoadedRepo,
  compiler: Compiler,
  base: ts.Program,
  targets: Target[],
  overlay: string,
  deps: DependencyLinks,
  parsed: Map<string, ts.SourceFile>,
): Overlay {
  const link = (name: string, dir: string): void => {
    const linkDir = join(overlay, 'node_modules', ...name.split('/'));
    mkdirSync(dirname(linkDir), { recursive: true });
    symlinkSync(realpathSync(dir), linkDir, 'dir');
  };
  for (const t of targets) link(t.name, t.dir);
  for (const [name, dir] of deps.links) link(name, dir);
  const overlayDirs = new Map<string, string>(targets.map((t) => [realpathSync(t.dir), t.name]));
  for (const [name, dir] of deps.links) overlayDirs.set(realpathSync(dir), name);
  const overlayDirOf = (file: string): string | undefined =>
    [...overlayDirs.keys()].find((d) => file.startsWith(`${d}/`));
  const insideOverlay = (file: string): boolean => overlayDirOf(file) !== undefined;
  const wanted = new Map<string, Wanted>();
  const probe = join(overlay, 'probe.ts');
  const repoProbe = join(repo.dir, '__uptide_probe__.ts');
  const unresolvedInTarget = new Set<string>();
  const unresolvedFiles = new Set<string>();
  const tsc = compiler.ts;
  const { options, host, noPaths, resolvedByBaseline } = sharedHost(
    compiler,
    base,
    insideOverlay,
    parsed,
  );
  const modeOf = usageModes(tsc, options, host);
  installResolver(host, (name, literal, containingFile, containingSourceFile) => {
    // Under Node16/NodeNext the importing file's format picks the `import` or `require`
    // condition; resolving from the probe would read the probe's (CommonJS) format instead.
    const mode =
      containingSourceFile && literal ? modeOf(containingSourceFile, literal) : undefined;
    if (targets.some((t) => isPackageSpecifier(name, t.specifier ?? t.name))) {
      // The repo's own `paths` may map the package (a linked checkout, a test fixture);
      // inside the overlay only the symlinked target may answer.
      return tsc.resolveModuleName(name, probe, noPaths, host, undefined, undefined, mode);
    }
    if (!insideOverlay(containingFile) && containingSourceFile) {
      // Outside the overlay nothing changed: the baseline's resolution is reused, no disk lookups.
      const known = resolvedByBaseline?.(containingSourceFile, name, mode);
      if (known) return known;
    }
    if (insideOverlay(containingFile) && isBare(name)) {
      // Inside the target and its linked dependencies, the overlay's node_modules answers first.
      const linked = tsc.resolveModuleName(name, probe, noPaths, host, undefined, undefined, mode);
      if (linked.resolvedModule) return linked;
    }
    const from = overlayDirOf(containingFile);
    const dep = packageNameOf(name);
    if (from !== undefined && isBare(name)) {
      // The importer declares a range: the consumer's copy (however the repo maps it) stands
      // in only when it satisfies that range; otherwise the next round links a proper version.
      const range = declaredRange(from, dep);
      if (range !== undefined && !deps.decided.has(dep) && !deps.links.has(dep)) {
        const importer = overlayDirs.get(from) as string;
        const consumer = installedVersion(repo, dep);
        if (consumer && isPeerOnly(from, dep)) {
          // A peer is the consumer's to provide: upgrading the target leaves the consumer's
          // copy where it is, so that is what the target is compiled against. Fetching the
          // version the peer range asks for would compile against two copies of the peer,
          // which no install has, and report errors that are not there.
          deps.decided.add(dep);
          if (!satisfies(consumer.version, range))
            deps.unsatisfied.push(
              `${dep}@${consumer.version} is outside the peer range ${range} of ${importer}; compiled against the installed ${dep}`,
            );
        } else if (!consumerCopySatisfies(importer, dep, range, consumer?.version)) {
          wanted.set(dep, { range, from: importer });
        }
      }
      // An untyped dependency is typed by the @types package the importer declares next to
      // it (vitest 5: `chai` and `@types/chai`). Nothing imports `@types/x` by name, so it
      // is wanted with `x`: without it the import is `any` and the ambient namespace it
      // declares (`Chai`) is missing, which shows up as errors at the consumer's call sites.
      const typesDep = `@types/${dep.startsWith('@') ? dep.slice(1).replace('/', '__') : dep}`;
      const typesRange = declaredRange(from, typesDep);
      if (typesRange !== undefined && !deps.decided.has(typesDep) && !deps.links.has(typesDep)) {
        const importer = overlayDirs.get(from) as string;
        const consumer = installedVersion(repo, typesDep);
        if (!consumerCopySatisfies(importer, typesDep, typesRange, consumer?.version))
          wanted.set(typesDep, { range: typesRange, from: importer });
      }
    }
    const direct = tsc.resolveModuleName(
      name,
      containingFile,
      options,
      host,
      undefined,
      undefined,
      mode,
    );
    if (direct.resolvedModule || from === undefined || !isBare(name)) return direct;
    const fromRepo = tsc.resolveModuleName(
      name,
      repoProbe,
      options,
      host,
      undefined,
      undefined,
      mode,
    );
    // A Node builtin is an ambient module of @types/node, which the program resolves on its own.
    const builtin = name.startsWith('node:') || builtinModules.includes(dep);
    if (!fromRepo.resolvedModule && !wanted.has(dep) && !builtin) {
      unresolvedInTarget.add(dep);
      const owner = overlayDirs.get(from);
      if (owner !== undefined && targets.some((t) => t.name === owner))
        unresolvedFiles.add(relative(from, containingFile));
    }
    return fromRepo;
  });
  // Not `oldProgram: base`: structure reuse copies the baseline's module resolutions and
  // silently bypasses the overlay. Sharing source files and resolutions through the host
  // (above) gives the same saving without that.
  const program = tsc.createProgram({ rootNames: [...base.getRootFileNames()], options, host });
  // `declare module 'x'` inside the target makes the compiler try to resolve `x` too; an
  // augmentation target is not an import and must not count as a missing dependency.
  for (const file of program.getSourceFiles()) {
    if (!insideOverlay(file.fileName)) continue;
    tsc.forEachChild(file, (node) => {
      if (tsc.isModuleDeclaration(node) && tsc.isStringLiteral(node.name)) {
        unresolvedInTarget.delete(node.name.text);
        if (unresolvedInTarget.size === 0) unresolvedFiles.clear();
      }
    });
  }
  return {
    program,
    overlayDirs: [...overlayDirs.keys()],
    unresolvedInTarget,
    unresolvedFiles,
    wanted,
  };
}

/** Rounds of "compile, see what the overlay imports, satisfy it"; the last program is the answer. */
async function convergedOverlay(
  repo: LoadedRepo,
  compiler: Compiler,
  base: ts.Program,
  targets: Target[],
  overlay: string,
  deps: DependencyLinks,
  fetcher: CompileOptions['fetcher'],
): Promise<Overlay> {
  const MAX_ROUNDS = 5;
  const parsed = new Map<string, ts.SourceFile>();
  for (let round = 0; ; round++) {
    const result = overlayProgram(repo, compiler, base, targets, overlay, deps, parsed);
    if (result.wanted.size === 0 || round === MAX_ROUNDS - 1) return result;
    const added = await satisfyWanted(repo, deps, result.wanted, fetcher);
    if (added === 0) return result;
    rmSync(join(overlay, 'node_modules'), { recursive: true, force: true });
  }
}

export function compileAgainstTarget(
  repoRef: RepoDir,
  pkg: string,
  targetDir: string,
  options: CompileOptions = {},
): Promise<CompileSignal> {
  return compileAgainstTargets(repoRef, [{ name: pkg, dir: targetDir }], options);
}

/** Several packages swapped in one overlay: a release group upgraded together. */
export async function compileAgainstTargets(
  repoRef: RepoDir,
  targets: Target[],
  options: CompileOptions = {},
): Promise<CompileSignal> {
  const compiler = repositoryCompiler(realpathSync(repoRef.dir));
  let repo: LoadedRepo;
  try {
    repo = loadedRepo(realpathSync(repoRef.dir), repoRef.rootFiles);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
    return {
      diagnostics: [],
      baselineErrors: 0,
      skipped: `invalid tsconfig: ${message}`,
      coverage: coverageOf(compiler, 0, 0, {
        reason: 'invalid tsconfig',
        count: options.files?.length ?? 0,
      }),
      unresolvedInTarget: [],
      unresolvedFiles: [],
      linkedDependencies: [],
      unsatisfiedDependencies: [],
      timing: { baselineMs: 0, overlayMs: 0, dependenciesMs: 0 },
    };
  }
  const t0 = Date.now();
  const base = nativeBase(repo, compiler);
  // Diagnostics come from a baseline that checks JavaScript too; files and resolutions are the
  // ts-morph program's. With baseline targets (the @types release the installed runtime
  // should have), the baseline is itself an overlay, built once for this compile.
  // Both sides are built the same way: the baseline is an overlay too, linking the installed
  // copies (or the baseline targets the caller names). A plain program and an overlay differ
  // in more than the target (which files they pull in, how JavaScript infers), and on a
  // 2,400-file JavaScript repository that difference alone produced dozens of "new" errors
  // for a patch release. The memoized plain baseline is the fallback when nothing is installed.
  const baselineTargets =
    options.baselineTargets && options.baselineTargets.length > 0
      ? options.baselineTargets
      : targets.flatMap((t) => {
          const installed = resolvePackageDir(repo, t.name);
          return installed ? [{ ...t, dir: installed }] : [];
        });
  let baselineOverlayDir: string | undefined;
  let checked: ts.Program;
  const memoized = baselineTargets.length === 0;
  if (memoized) {
    checked = checkedBaseline(repo, compiler, base);
  } else {
    baselineOverlayDir = mkdtempSync(join(tmpdir(), 'uptide-baseline-'));
    checked = overlayProgram(
      repo,
      compiler,
      base,
      baselineTargets,
      baselineOverlayDir,
      newLinks(),
      new Map(),
    ).program;
  }
  const { files, missing } = filesToCheck(repo, repoRef, checked, options.files);
  const baseline = files.flatMap((f) =>
    memoized
      ? baselineErrorsOf(repo, checked, f)
      : checked.getSemanticDiagnostics(f).filter((d) => isRepoError(d, repo.dir)),
  );
  if (baselineOverlayDir) rmSync(baselineOverlayDir, { recursive: true, force: true });
  const baselineMs = Date.now() - t0;
  const skipped = structuralFailure(checked, files, baseline);
  if (skipped) {
    return {
      diagnostics: [],
      baselineErrors: baseline.length,
      skipped,
      coverage: coverageOf(compiler, 0, missing, {
        reason: skipReasonOf(skipped),
        count: files.length,
      }),
      unresolvedInTarget: [],
      unresolvedFiles: [],
      linkedDependencies: [],
      unsatisfiedDependencies: [],
      timing: { baselineMs, overlayMs: 0, dependenciesMs: 0 },
    };
  }
  const known = new Set(baseline.map((d) => keyOf(d, repo.dir)));
  const overlay = mkdtempSync(join(tmpdir(), 'uptide-overlay-'));
  const deps = newLinks();
  // Group members are already linked; nothing may fetch another version of them.
  for (const t of targets) deps.decided.add(t.name);
  try {
    const t1 = Date.now();
    const { program, unresolvedInTarget, unresolvedFiles } = await convergedOverlay(
      repo,
      compiler,
      base,
      targets,
      overlay,
      deps,
      options.fetcher,
    );
    const fresh: { d: ts.Diagnostic; overlaid: ts.SourceFile }[] = [];
    for (const file of files) {
      const overlaid = program.getSourceFile(file.fileName);
      if (!overlaid) continue;
      for (const d of program.getSemanticDiagnostics(overlaid)) {
        if (isRepoError(d, repo.dir) && !known.has(keyOf(d, repo.dir))) fresh.push({ d, overlaid });
      }
    }
    // Causes are traced once every new diagnostic is known: a declaration that fails itself is a cause.
    const erroredLines = new Set(
      fresh.map(({ d, overlaid }) => {
        const { line } = overlaid.getLineAndCharacterOfPosition(d.start ?? 0);
        return `${relative(repo.dir, overlaid.fileName)}:${line + 1}`;
      }),
    );
    // One compiler option can explain hundreds of diagnostics (the JSX namespace the target no
    // longer declares): those are anchored at the option, the rest traced to a declaration.
    const programs = { overlay: program, base: checked, ts: compiler.ts };
    const jsx = jsxNamespaceCause(
      programs,
      fresh.map(({ d }) => d),
      repo.dir,
      targets.map((t) => t.name),
    );
    // A repository parameter several call sites trip over is one edit; one site keeps its
    // own diagnostic, which may as well be the argument's.
    const byParameter = new Map<string, DiagnosticCause>();
    const parameterOf = new Map<ts.Diagnostic, string>();
    for (const { d, overlaid } of fresh) {
      const cause = parameterCause(programs, d, overlaid, repo.dir, repoRef.root ?? repo.dir);
      if (!cause) continue;
      const key = `${cause.file}:${cause.line}:${cause.name}`;
      byParameter.set(key, cause);
      parameterOf.set(d, key);
    }
    const shared = new Map<string, number>();
    for (const key of parameterOf.values()) shared.set(key, (shared.get(key) ?? 0) + 1);
    const diagnostics: CompileDiagnostic[] = fresh.map(({ d, overlaid }) => {
      const diagnostic = toDiagnostic(d, overlaid, repo.dir);
      const parameter = parameterOf.get(d);
      const cause =
        (jsx?.explains(d) ? jsx.cause : undefined) ??
        (parameter !== undefined && (shared.get(parameter) ?? 0) >= 2
          ? byParameter.get(parameter)
          : undefined) ??
        findCause(programs, d, overlaid, repo.dir, erroredLines);
      if (cause) diagnostic.cause = cause;
      return diagnostic;
    });
    return {
      diagnostics: diagnostics.sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
      ),
      baselineErrors: baseline.length,
      coverage: coverageOf(compiler, files.length, missing),
      unresolvedInTarget: [...unresolvedInTarget].sort(),
      unresolvedFiles: [...unresolvedFiles].sort(),
      linkedDependencies: deps.linked,
      linkedDependencyDirs: Object.fromEntries(deps.links),
      unsatisfiedDependencies: deps.unsatisfied,
      timing: { baselineMs, overlayMs: Date.now() - t1, dependenciesMs: 0 },
    };
  } finally {
    rmSync(overlay, { recursive: true, force: true });
  }
}
