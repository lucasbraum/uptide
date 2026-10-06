import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { type Symbol as MorphSymbol, Node, type SourceFile, ts } from 'ts-morph';
import type { RepoDir } from '../../domain/adapter.js';
import * as P from '../../domain/path.js';
import type { ApiSurface } from '../../domain/surface.js';
import {
  type FindUsagesResult,
  repoTypeChecks,
  type Unanalyzed,
  type Usage,
  type UsageAccess,
  type UsageVia,
} from '../../domain/usage.js';
import { UptideError } from '../../errors.js';
import { onReset } from '../../shared-state.js';
import type { TypescriptAdapter } from './index.js';
import { locationKey } from './index.js';
import { forgetRepo, type LoadedRepo, loadedRepo, ownsFile, readInstalled } from './repo.js';

export { forgetRepo };

/**
 * Signal A: every reference in the repository whose symbol is declared inside the
 * package, mapped to a canonical path by the declaration's location. The type checker
 * does the resolution (aliases, namespace imports, barrels, instances), so `s.subs.create`
 * lands on `Stripe#subscriptions` and then `create` on its type without any name matching.
 */

/**
 * The declaration-location map of an installed package, once per process: the same store
 * directory serves every workspace that depends on it, and walking a large package
 * (stripe, drizzle-orm) costs seconds.
 */
/**
 * One raw walk over the repository's files, per program: which packages each file loads
 * (imports, re-exports, `import =`, literal `require()`/`import()`), where its member-name
 * identifiers sit, and whether it has a computed load. Every package's scan then touches
 * only the files that can concern it, instead of re-walking 2,400 files per dependency.
 */
interface FileIndex {
  /** Package names loaded by this file, plus relative specifiers it re-exports from or imports. */
  loads: Set<string>;
  /** Relative specifiers re-exported (`export ... from './x'`): the file may be a barrel. */
  reexportsFrom: string[];
  /** Relative specifiers imported: the file may import a barrel. */
  importsFrom: string[];
  /** Identifier text -> start positions, for property-access names, qualified names and object keys. */
  memberNames: Map<string, number[]>;
  /** A `require()`/`import()` with a computed specifier: only its text can say which package. */
  computedLoads: string[];
}

const repoIndexes = new WeakMap<LoadedRepo, Map<string, FileIndex>>();

function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:'))
    return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function indexFile(sf: ts.SourceFile): FileIndex {
  const index: FileIndex = {
    loads: new Set(),
    reexportsFrom: [],
    importsFrom: [],
    memberNames: new Map(),
    computedLoads: [],
  };
  const load = (specifier: string): void => {
    const name = packageNameOf(specifier);
    if (name) index.loads.add(name);
  };
  const member = (id: ts.Node): void => {
    if (!ts.isIdentifier(id)) return;
    const list = index.memberNames.get(id.text) ?? [];
    list.push(id.getStart(sf));
    index.memberNames.set(id.text, list);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      load(n.moduleSpecifier.text);
      if (n.moduleSpecifier.text.startsWith('.')) index.importsFrom.push(n.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      load(n.moduleSpecifier.text);
      if (n.moduleSpecifier.text.startsWith('.')) index.reexportsFrom.push(n.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const e = n.moduleReference.expression;
      if (ts.isStringLiteral(e)) load(e.text);
    } else if (ts.isCallExpression(n)) {
      const isLoad =
        (ts.isIdentifier(n.expression) && n.expression.text === 'require') ||
        n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const arg = n.arguments[0];
      if (isLoad && arg) {
        if (ts.isStringLiteral(arg)) load(arg.text);
        else index.computedLoads.push(arg.getText(sf));
      }
    } else if (ts.isPropertyAccessExpression(n)) member(n.name);
    else if (ts.isQualifiedName(n)) member(n.right);
    else if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) member(n.name);
    else if (ts.isMethodDeclaration(n) && ts.isObjectLiteralExpression(n.parent)) member(n.name);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return index;
}

function repoIndex(repo: LoadedRepo): Map<string, FileIndex> {
  let index = repoIndexes.get(repo);
  if (index) return index;
  index = new Map();
  for (const file of repo.project.getSourceFiles()) {
    if (file.isDeclarationFile() || file.getFilePath().includes('/node_modules/')) continue;
    index.set(file.getFilePath(), indexFile(file.compilerNode));
  }
  repoIndexes.set(repo, index);
  return index;
}

const detailed = new Map<
  string,
  Promise<Awaited<ReturnType<TypescriptAdapter['extractSurfaceDetailed']>>>
>();
onReset(() => detailed.clear());

function detailedSurfaceOf(
  adapter: TypescriptAdapter,
  name: string,
  version: string,
  dir: string,
): Promise<Awaited<ReturnType<TypescriptAdapter['extractSurfaceDetailed']>>> {
  const key = `${adapter.id}|${dir}`;
  let p = detailed.get(key);
  if (!p) {
    p = adapter.extractSurfaceDetailed({ name, version, dir });
    detailed.set(key, p);
    p.catch(() => detailed.delete(key));
  }
  return p;
}

function isPackageSpecifier(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

/** Where the repo's compiler finds the package, following symlinks, as a package root. */
export function resolvePackageDir(repo: LoadedRepo, pkg: string): string | undefined {
  const files = repo.project.getSourceFiles();
  const from = files[0];
  if (!from) return undefined;
  const resolved = ts.resolveModuleName(
    pkg,
    from.getFilePath(),
    repo.project.getCompilerOptions(),
    repo.project.getModuleResolutionHost(),
  ).resolvedModule;
  // Unresolved and not on disk under node_modules: not installed. Climbing from a missing
  // directory would land on the repository's own package.json and call it the package.
  const fallback = join(repo.dir, 'node_modules', pkg);
  if (!resolved && !existsSync(join(fallback, 'package.json'))) return undefined;
  let dir = resolved ? dirname(resolved.resolvedFileName) : fallback;
  for (;;) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        const name = (JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name;
        if (name === pkg || !resolved?.packageId) return realpathSync(dir);
      } catch {
        // keep climbing
      }
    }
    const parent = dirname(dir);
    // Resolved to another package's declarations (@types/express for 'express'): the runtime package is under node_modules.
    if (parent === dir)
      return existsSync(join(fallback, 'package.json')) ? realpathSync(fallback) : undefined;
    dir = parent;
  }
}

interface Resolved {
  /** Under the name the consumer wrote. */
  path: string;
  /** The canonical target when `path` is an alias of it. */
  canonical: string;
}

interface Resolver {
  /** `written`: the identifier text at the reference, for aliases the checker resolves through. */
  pathOf(symbol: MorphSymbol | undefined, written?: string): Resolved | undefined;
  inPackage(file: string): boolean;
  /** The constructor path of a class, when the surface lists one. */
  constructorOf(classPath: string): string;
}

function makeResolver(
  locations: Map<string, string>,
  pkgDir: string,
  surface: ApiSurface,
): Resolver {
  const inPackage = (file: string): boolean => file.startsWith(`${pkgDir}/`);
  const known = new Map(surface.symbols.map((s) => [s.path, s]));
  const canonicalOf = (symbol: MorphSymbol): string | undefined => {
    for (const decl of symbol.getDeclarations()) {
      const file = decl.getSourceFile().getFilePath();
      if (!inPackage(file)) continue;
      const path = locations.get(locationKey(file, decl.getStart()));
      if (path) return path;
    }
    return undefined;
  };
  return {
    inPackage,
    constructorOf(classPath) {
      const ctor = `${classPath}.new()`;
      return known.has(ctor) ? ctor : classPath;
    },
    pathOf(symbol, written) {
      if (!symbol) return undefined;
      const isAlias = (symbol.getFlags() & ts.SymbolFlags.Alias) !== 0;
      const target = isAlias ? (symbol.getAliasedSymbol() ?? symbol) : symbol;
      const canonical = canonicalOf(target);
      if (!canonical) return undefined;
      // `z.infer` names the export `infer`. In a type position the checker hands back the
      // resolved `TypeOf` symbol, not the alias, so the name written is matched against the
      // surface directly: the consumer wrote `infer`, and `infer`'s changes are theirs.
      if (written !== undefined && written !== canonical) {
        const named = known.get(written);
        if (named && named.aliasOf === canonical) return { path: named.path, canonical };
      }
      // `import { makeClient }` names the export `makeClient`, even if it is an alias of
      // `createClient`: removing that name hits this consumer, and so does changing the target.
      if (isAlias) {
        const decl = symbol.getDeclarations()[0];
        const imported =
          decl && (Node.isImportSpecifier(decl) || Node.isExportSpecifier(decl))
            ? decl.getNameNode().getText()
            : undefined;
        const named = imported ? known.get(imported) : undefined;
        if (named && (named.aliasOf === canonical || named.path === canonical)) {
          return { path: named.path, canonical };
        }
      }
      return { path: canonical, canonical };
    },
  };
}

/** A receiver the checker gave up on: `any`, or an error type. */
function isUntyped(expression: Node): boolean {
  try {
    const type = expression.getType();
    return type.isAny() || type.isUnknown();
  } catch {
    return false;
  }
}

/** Whether a member access chain (`a.b().c`, `A.B`) starts at an import binding. */
function rootedAtImport(access: Node, extraRoots: Set<MorphSymbol> = new Set()): boolean {
  let node: Node = access;
  for (;;) {
    if (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) {
      node = node.getExpression();
    } else if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
      node = node.getExpression();
    } else if (Node.isNonNullExpression(node) || Node.isParenthesizedExpression(node)) {
      node = node.getExpression();
    } else if (Node.isQualifiedName(node)) {
      node = node.getLeft();
    } else if (Node.isAwaitExpression(node)) {
      node = node.getExpression();
    } else break;
  }
  if (!Node.isIdentifier(node)) return false;
  const symbol = node.getSymbol();
  if (!symbol) return false;
  return (symbol.getFlags() & ts.SymbolFlags.Alias) !== 0 || extraRoots.has(symbol);
}

/** The innermost receiver of `a.b().c`: an identifier, a call, or whatever starts the chain. */
function rootNode(access: Node): Node | undefined {
  let node: Node = access;
  for (;;) {
    if (
      Node.isPropertyAccessExpression(node) ||
      Node.isElementAccessExpression(node) ||
      Node.isNonNullExpression(node) ||
      Node.isParenthesizedExpression(node) ||
      Node.isAwaitExpression(node)
    ) {
      node = node.getExpression();
    } else if (Node.isQualifiedName(node)) {
      node = node.getLeft();
    } else return node;
  }
}

/** The root identifier of `a.b().c`, or undefined. */
function rootIdentifier(access: Node): Node | undefined {
  let node: Node = access;
  for (;;) {
    if (
      Node.isPropertyAccessExpression(node) ||
      Node.isElementAccessExpression(node) ||
      Node.isCallExpression(node) ||
      Node.isNewExpression(node) ||
      Node.isNonNullExpression(node) ||
      Node.isParenthesizedExpression(node) ||
      Node.isAwaitExpression(node)
    ) {
      node = node.getExpression();
    } else if (Node.isQualifiedName(node)) {
      node = node.getLeft();
    } else break;
  }
  return Node.isIdentifier(node) ? node : undefined;
}

/** `require('pkg')` or `import('pkg')` with a literal specifier naming the package. */
function packageLoadCall(node: Node, pkg: string): 'require' | 'dynamic-import' | undefined {
  if (!Node.isCallExpression(node)) return undefined;
  const arg = node.getArguments()[0];
  const specifier = arg && Node.isStringLiteral(arg) ? arg.getLiteralValue() : undefined;
  if (specifier === undefined || !isPackageSpecifier(specifier, pkg)) return undefined;
  const callee = node.getExpression();
  if (Node.isIdentifier(callee) && callee.getText() === 'require') return 'require';
  if (callee.getKind() === ts.SyntaxKind.ImportKeyword) return 'dynamic-import';
  return undefined;
}

/** `await import('pkg')` -> the call. */
function unwrapAwait(node: Node): Node {
  return Node.isAwaitExpression(node) ? node.getExpression() : node;
}

/**
 * Whether a load call's result is followed: bound to a name or a pattern, accessed inline,
 * or used for its side effect only. Anything else (an argument, a property value, a
 * return) is a flow the analyzer does not track.
 */
function loadIsFollowed(call: Node): boolean {
  let node: Node = call;
  if (Node.isAwaitExpression(node.getParent())) node = node.getParent() as Node;
  const parent = node.getParent();
  if (!parent) return false;
  if (Node.isVariableDeclaration(parent)) return true;
  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === node) return true;
  if (Node.isExpressionStatement(parent)) return true;
  if (Node.isImportEqualsDeclaration(parent)) return true;
  return false;
}

/** Whether an object literal is passed to a package callable or typed with a package type, following nested literals. */
function literalFlowsInto(literal: Node, resolver: Resolver): boolean {
  let node: Node = literal;
  for (;;) {
    const parent = node.getParent();
    if (!parent) return false;
    if (
      Node.isObjectLiteralExpression(parent) ||
      Node.isArrayLiteralExpression(parent) ||
      Node.isPropertyAssignment(parent) ||
      Node.isParenthesizedExpression(parent)
    ) {
      node = parent;
      continue;
    }
    if (Node.isCallExpression(parent) || Node.isNewExpression(parent)) {
      const callee = parent.getExpression();
      const symbol = Node.isPropertyAccessExpression(callee)
        ? callee.getNameNode().getSymbol()
        : callee.getSymbol();
      return resolver.pathOf(symbol) !== undefined;
    }
    if (
      Node.isVariableDeclaration(parent) ||
      Node.isSatisfiesExpression(parent) ||
      Node.isAsExpression(parent)
    ) {
      const typeNode = parent.getTypeNode();
      const name = typeNode && Node.isTypeReference(typeNode) ? typeNode.getTypeName() : undefined;
      const symbol =
        name && Node.isQualifiedName(name) ? name.getRight().getSymbol() : name?.getSymbol();
      return resolver.pathOf(symbol) !== undefined;
    }
    return false;
  }
}

/** The package property an object-literal member fills, through `| undefined` and unions of object types. */
function contextualProperty(literal: Node, name: string): MorphSymbol | undefined {
  if (!Node.isObjectLiteralExpression(literal)) return undefined;
  const contextual = literal.getContextualType();
  if (!contextual) return undefined;
  const candidates = contextual.isUnion() ? contextual.getUnionTypes() : [contextual];
  for (const t of candidates) {
    const prop = t.getProperty(name);
    if (prop) return prop;
  }
  return undefined;
}

interface LocalAlias {
  resolved: Resolved;
  via: UsageVia;
}

function isAssignmentTarget(expr: Node): boolean {
  const parent = expr.getParent();
  if (!parent) return false;
  if (Node.isBinaryExpression(parent) && parent.getLeft() === expr) {
    const op = parent.getOperatorToken().getKind();
    return op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
  }
  if (Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent)) {
    const op = parent.getOperatorToken();
    return op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken;
  }
  return Node.isDeleteExpression(parent);
}

/** The expression a reference stands for: `a.b.c` for the identifier `c`. */
function referenceExpression(id: Node): Node {
  const parent = id.getParent();
  if (parent && Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id)
    return parent;
  if (parent && Node.isQualifiedName(parent) && parent.getRight() === id) return parent;
  return id;
}

function classifyAccess(id: Node): UsageAccess {
  const heritage = id.getFirstAncestor(
    (a) => Node.isExpressionWithTypeArguments(a) && Node.isHeritageClause(a.getParent()),
  );
  if (heritage) return 'implement';
  if (
    id.getFirstAncestor((a) => Node.isTypeNode(a) || Node.isTypeQuery(a) || Node.isTypeReference(a))
  )
    return 'typeRef';
  const expr = referenceExpression(id);
  const parent = expr.getParent();
  if (parent && Node.isCallExpression(parent) && parent.getExpression() === expr) return 'call';
  if (parent && Node.isNewExpression(parent) && parent.getExpression() === expr) return 'construct';
  if (isAssignmentTarget(expr)) return 'write';
  return 'read';
}

/** `import { z as zod }` is an alias; an import that reaches the package through a repo barrel is a re-export. */
function viaOfImport(symbol: MorphSymbol, repoDir: string, resolver: Resolver): UsageVia {
  const decl = symbol.getDeclarations()[0];
  if (decl && Node.isImportSpecifier(decl) && decl.getAliasNode() !== undefined) return 'alias';
  let current: MorphSymbol | undefined = symbol;
  for (
    let hops = 0;
    hops < 10 && current && (current.getFlags() & ts.SymbolFlags.Alias) !== 0;
    hops++
  ) {
    const next: MorphSymbol | undefined = current.getImmediatelyAliasedSymbol();
    const nextDecl = next?.getDeclarations()[0];
    if (nextDecl) {
      const file = nextDecl.getSourceFile().getFilePath();
      if (
        !resolver.inPackage(file) &&
        file.startsWith(`${repoDir}/`) &&
        (Node.isExportSpecifier(nextDecl) || Node.isExportAssignment(nextDecl))
      ) {
        return 'reexport';
      }
    }
    current = next;
  }
  return 'direct';
}

/**
 * Load sites the analyzer does not follow: `require(name)` with a computed specifier, and a
 * literal `require('pkg')`/`import('pkg')` whose result flows into an argument, a property
 * or a return. Bound loads are followed by the scan and are not listed.
 */
function scanUnanalyzed(file: SourceFile, pkg: string, repoDir: string): Unanalyzed[] {
  const out: Unanalyzed[] = [];
  const rel = relative(repoDir, file.getFilePath()).split('\\').join('/');
  const note = (node: Node, kind: Unanalyzed['kind']): void => {
    out.push({ file: rel, line: file.getLineAndColumnAtPos(node.getStart()).line, kind });
  };
  file.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    const isRequire = Node.isIdentifier(callee) && callee.getText() === 'require';
    const isImport = callee.getKind() === ts.SyntaxKind.ImportKeyword;
    if (!isRequire && !isImport) return;
    const arg = node.getArguments()[0];
    if (arg && Node.isStringLiteral(arg)) {
      if (!isPackageSpecifier(arg.getLiteralValue(), pkg)) return;
      if (!loadIsFollowed(node)) note(node, isRequire ? 'require' : 'dynamic-import');
      return;
    }
    // A computed specifier may name any package; template literals starting with the name count.
    const text = arg?.getText() ?? '';
    if (arg && !Node.isStringLiteral(arg) && text.includes(pkg))
      note(node, isRequire ? 'require' : 'dynamic-import');
  });
  return out;
}

export async function findUsagesInRepo(
  adapter: TypescriptAdapter,
  repoRef: RepoDir,
  pkg: string,
  surface: ApiSurface,
): Promise<FindUsagesResult> {
  const repo = loadedRepo(realpathSync(repoRef.dir), repoRef.rootFiles);
  // Types served by DefinitelyTyped: the declarations to map live in @types/<pkg>, not in the package.
  const declarationsPkg =
    surface.package.startsWith('@types/') && surface.package !== pkg ? surface.package : pkg;
  const pkgDir = resolvePackageDir(repo, declarationsPkg);
  if (!pkgDir) {
    // Nothing resolvable to follow, but a require() of the package is still a gap worth reporting.
    const files = repo.project
      .getSourceFiles()
      .filter((f) => !f.isDeclarationFile() && ownsFile(repoRef, f.getFilePath()));
    const unanalyzed = files.flatMap((f) => scanUnanalyzed(f, pkg, repo.dir));
    return {
      usages: [],
      unanalyzed,
      checksJs: repo.project.getCompilerOptions().checkJs === true,
      filesScanned: files.length,
      includesJs: repo.includesJs,
    };
  }
  // An untyped package (joi 13, node-fetch 2) still has load sites worth recording.
  const { locations } =
    surface.symbols.length === 0
      ? { locations: new Map<string, string>() }
      : await detailedSurfaceOf(adapter, pkg, surface.version, pkgDir).catch(() => ({
          locations: new Map<string, string>(),
        }));
  const resolver = makeResolver(locations, pkgDir, surface);
  const usages: Usage[] = [];
  const seen = new Set<string>();

  let fileChecked = true;
  const emit = (
    file: SourceFile,
    node: Node,
    resolved: Resolved,
    access: UsageAccess,
    via: UsageVia,
    loader?: 'require',
  ): void => {
    const symbolPath = resolved.path;
    const start = file.getLineAndColumnAtPos(node.getStart());
    const end = file.getLineAndColumnAtPos(node.getEnd());
    const key = `${file.getFilePath()}:${start.line}:${start.column}:${symbolPath}:${access}`;
    if (seen.has(key)) return;
    seen.add(key);
    const lineText = file.getFullText().split('\n')[start.line - 1] ?? '';
    const usage: Usage = {
      file: relative(repo.dir, file.getFilePath()).split('\\').join('/'),
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
      symbolPath,
      access,
      snippet: lineText.trim(),
      via,
    };
    if (resolved.canonical !== symbolPath) usage.canonicalPath = resolved.canonical;
    if (loader) usage.loader = loader;
    if (!fileChecked) usage.checked = false;
    usages.push(usage);
  };

  const files = repo.project
    .getSourceFiles()
    .filter(
      (f) =>
        !f.isDeclarationFile() &&
        !f.getFilePath().includes('/node_modules/') &&
        !resolver.inPackage(f.getFilePath()) &&
        ownsFile(repoRef, f.getFilePath()),
    );

  // Two tiers, chosen from the repository index. A file that loads the package, or a local
  // barrel re-exporting it, gets every identifier resolved. Any other file can only meet the
  // package through a value that flowed from such a file, which shows up as a property
  // access or an object-literal key; only identifiers whose name the surface declares are
  // resolved there, and files with none are not opened at all.
  const index = repoIndex(repo);
  const loadsPkg = (path: string): boolean => index.get(path)?.loads.has(pkg) === true;
  const barrels = new Set(
    files
      .filter((f) => {
        const entry = index.get(f.getFilePath());
        return entry?.loads.has(pkg) && entry.reexportsFrom.length === 0
          ? f
              .getExportDeclarations()
              .some((d) => isPackageSpecifier(d.getModuleSpecifierValue() ?? '', pkg))
          : false;
      })
      .map((f) => f.getFilePath()),
  );
  const importsPackage = (file: SourceFile): boolean => {
    const path = file.getFilePath();
    if (loadsPkg(path)) return true;
    if (barrels.size === 0 || (index.get(path)?.importsFrom.length ?? 0) === 0) return false;
    return file.getImportDeclarations().some((d) => {
      const specifier = d.getModuleSpecifierValue();
      if (specifier === undefined || !specifier.startsWith('.')) return false;
      const target = d.getModuleSpecifierSourceFile()?.getFilePath();
      return target !== undefined && barrels.has(target);
    });
  };
  /** The root of the surface as a consumer calls it: the `export =` value, or `default`. */
  const rootPath = surface.symbols.find((sym) => sym.exportEquals)?.path ?? 'default';
  const known = new Map(surface.symbols.map((sym) => [sym.path, sym]));
  /** `member` of the module by name: a top-level export, or a member of the `export =` root. */
  const byName = (member: string): Resolved | undefined => {
    for (const candidatePath of [member, `${rootPath}.${member}`, `${rootPath}#${member}`]) {
      const sym = known.get(candidatePath);
      if (sym) return { path: candidatePath, canonical: sym.aliasOf ?? candidatePath };
    }
    return undefined;
  };
  const leafCounts = new Map<string, string[]>();
  for (const sym of surface.symbols) {
    const name = P.leafOf(sym.path);
    if (/^[A-Za-z_$][\w$]*$/.test(name))
      leafCounts.set(name, [...(leafCounts.get(name) ?? []), sym.path]);
  }
  const leafNames = new Set(leafCounts.keys());
  /**
   * A member name few symbols share (`current_period_end`, not `id`): worth asking the checker
   * about on a value that did not visibly come from the import, such as one another workspace's
   * function returned. Common names stay behind the cheap import-rooted check.
   */
  const distinctive = (name: string): boolean => (leafCounts.get(name)?.length ?? 0) <= 8;
  /** The one symbol a member name can mean, for a receiver the checker types as `any`. */
  const onlyMeaning = (name: string): Resolved | undefined => {
    const paths = leafCounts.get(name) ?? [];
    const path = paths.length === 1 ? paths[0] : undefined;
    return path === undefined ? undefined : { path, canonical: known.get(path)?.aliasOf ?? path };
  };

  const unanalyzed: Unanalyzed[] = [];
  for (const file of files) {
    const entry = index.get(file.getFilePath());
    const full = importsPackage(file);
    const memberHits = entry
      ? [...entry.memberNames.entries()]
          .filter(([name]) => leafNames.has(name))
          .flatMap(([, p]) => p)
      : [];
    const computed = entry?.computedLoads.some((text) => text.includes(pkg)) === true;
    if (!full && memberHits.length === 0 && !computed) continue;
    if (full || computed) unanalyzed.push(...scanUnanalyzed(file, pkg, repo.dir));
    const localAliases = new Map<MorphSymbol, LocalAlias>();
    const candidate = (name: string): boolean => full || leafNames.has(name);
    // Signal B checks JavaScript too (checkJs on both sides), but the repository may not: there
    // the compiler is not the arbiter, and the usage says so.
    fileChecked = repoTypeChecks(
      file.getFilePath(),
      file.getFullText().slice(0, 2000),
      repo.project.getCompilerOptions().checkJs === true,
    );
    // Locals bound from `require('pkg')` / `await import('pkg')` / `import x = require('pkg')`.
    const requireLocals = new Set<MorphSymbol>();
    const requirePaths = new Map<MorphSymbol, Resolved>();
    for (const v of file.getDescendantsOfKind(ts.SyntaxKind.VariableDeclaration)) {
      const init = v.getInitializer();
      if (!init) continue;
      const load = unwrapAwait(init);
      const nameNode = v.getNameNode();
      if (packageLoadCall(load, pkg) !== undefined) {
        if (Node.isIdentifier(nameNode)) {
          const local = nameNode.getSymbol();
          if (local) requireLocals.add(local);
          // The load itself is a site: a package that goes ESM-only breaks it whatever is touched later.
          emit(file, nameNode, { path: '.', canonical: '.' }, 'import', 'require', 'require');
        } else if (Node.isObjectBindingPattern(nameNode)) {
          // The load itself is a site even when no member resolves (an untyped package).
          emit(file, nameNode, { path: '.', canonical: '.' }, 'import', 'require', 'require');
          for (const element of nameNode.getElements()) {
            const propName = (element.getPropertyNameNode() ?? element.getNameNode()).getText();
            const local = element.getNameNode().getSymbol();
            const viaChecker = resolver.pathOf(load.getType().getProperty(propName));
            const resolved = viaChecker ?? byName(propName);
            if (local && resolved) {
              localAliases.set(local, { resolved, via: viaChecker ? 'destructure' : 'require' });
              requireLocals.add(local);
              emit(
                file,
                element,
                resolved,
                'read',
                viaChecker ? 'destructure' : 'require',
                'require',
              );
            }
          }
        }
      } else if (
        Node.isPropertyAccessExpression(load) &&
        packageLoadCall(load.getExpression(), pkg) !== undefined &&
        Node.isIdentifier(nameNode)
      ) {
        // `const x = require('pkg').member`
        const local = nameNode.getSymbol();
        const resolved = resolver.pathOf(load.getNameNode().getSymbol()) ?? byName(load.getName());
        if (local && resolved) {
          requirePaths.set(local, resolved);
          requireLocals.add(local);
        }
      }
    }
    for (const d of file.getStatements().filter(Node.isImportEqualsDeclaration)) {
      const spec = d
        .getModuleReference()
        .getFirstDescendantByKind(ts.SyntaxKind.StringLiteral)
        ?.getLiteralValue();
      if (spec === undefined || !isPackageSpecifier(spec, pkg)) continue;
      const local = d.getNameNode().getSymbol();
      if (local) requireLocals.add(local);
    }
    const loaderOf = (node: Node): 'require' | undefined => {
      const chain = node.getParent() ?? node;
      // `require('pkg').member` inline: the chain starts at the load call itself.
      const start = rootNode(chain);
      if (start !== undefined && packageLoadCall(start, pkg) !== undefined) return 'require';
      const root = rootIdentifier(chain) ?? (Node.isIdentifier(node) ? node : undefined);
      const symbol = root?.getSymbol();
      return symbol && requireLocals.has(symbol) ? 'require' : undefined;
    };

    // Imports and re-exports from the package.
    for (const decl of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
      const specifier = decl.getModuleSpecifierValue();
      if (specifier === undefined || !isPackageSpecifier(specifier, pkg)) continue;
      const named = Node.isImportDeclaration(decl)
        ? decl.getNamedImports()
        : decl.getNamedExports();
      for (const spec of named) {
        const resolved = resolver.pathOf(spec.getSymbol());
        if (resolved)
          emit(
            file,
            spec,
            resolved,
            'import',
            spec.getAliasNode() !== undefined ? 'alias' : 'direct',
          );
      }
      if (Node.isImportDeclaration(decl)) {
        const def = decl.getDefaultImport();
        const defResolved = def ? resolver.pathOf(def.getSymbol()) : undefined;
        if (def && defResolved) emit(file, def, defResolved, 'import', 'direct');
      }
    }

    // Locals bound from package values: `const { create } = stripe.subscriptions`, `const p = pkg.parse`.
    for (const v of file.getDescendantsOfKind(ts.SyntaxKind.VariableDeclaration)) {
      const init = v.getInitializer();
      if (!init) continue;
      const nameNode = v.getNameNode();
      if (Node.isObjectBindingPattern(nameNode)) {
        const elements = nameNode
          .getElements()
          .filter((e) => candidate((e.getPropertyNameNode() ?? e.getNameNode()).getText()));
        if (elements.length === 0) continue;
        const type = init.getType();
        for (const element of elements) {
          const propName = (element.getPropertyNameNode() ?? element.getNameNode()).getText();
          const resolved = resolver.pathOf(type.getProperty(propName));
          const local = element.getNameNode().getSymbol();
          if (resolved && local) {
            localAliases.set(local, { resolved, via: 'destructure' });
            emit(file, element, resolved, 'read', 'destructure');
          }
        }
      } else if (Node.isIdentifier(nameNode)) {
        const initSymbol =
          (Node.isPropertyAccessExpression(init) && candidate(init.getName())) ||
          (Node.isIdentifier(init) && full)
            ? init.getSymbol()
            : undefined;
        const resolved = resolver.pathOf(initSymbol);
        const local = nameNode.getSymbol();
        const callable =
          (initSymbol?.getFlags() ?? 0) &
          (ts.SymbolFlags.Function | ts.SymbolFlags.Method | ts.SymbolFlags.Class);
        if (resolved && local && callable !== 0)
          localAliases.set(local, { resolved, via: 'alias' });
      }
    }

    const visit = (node: Node): void => {
      if (!Node.isIdentifier(node)) return;
      const parent = node.getParent();
      if (!parent) return;
      // Import/export bindings were handled above; declarations of the repo's own names are not references.
      if (
        Node.isImportSpecifier(parent) ||
        Node.isExportSpecifier(parent) ||
        Node.isNamespaceImport(parent) ||
        Node.isImportClause(parent)
      )
        return;

      // Object literal members: the property belongs to the contextual (package) type.
      if (
        (Node.isPropertyAssignment(parent) ||
          Node.isShorthandPropertyAssignment(parent) ||
          Node.isMethodDeclaration(parent)) &&
        parent.getNameNode() === node
      ) {
        const literal = parent.getParent();
        if (!Node.isObjectLiteralExpression(literal) || !candidate(node.getText())) return;
        // Outside importing files, the contextual type (expensive to compute) is only asked for
        // when the literal visibly flows into the package: a call or constructor argument of a
        // package function, or a declaration annotated with a package type.
        if (!full && !literalFlowsInto(literal, resolver)) return;
        const resolved = resolver.pathOf(contextualProperty(literal, node.getText()));
        if (!resolved) return;
        const value = Node.isPropertyAssignment(parent) ? parent.getInitializer() : parent;
        const implementing =
          value !== undefined &&
          (Node.isArrowFunction(value) ||
            Node.isFunctionExpression(value) ||
            Node.isMethodDeclaration(value));
        emit(file, node, resolved, implementing ? 'implement' : 'write', 'direct');
        return;
      }
      if (Node.isBindingElement(parent)) return;
      // Outside importing files only a member name the package declares, on a value that
      // came in through an import, can be a usage. Resolving the member's symbol needs the
      // type of the whole receiver expression; the root import binding is cheap to check first.
      if (!full) {
        const isMemberName =
          (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) ||
          (Node.isQualifiedName(parent) && parent.getRight() === node);
        if (!isMemberName || !leafNames.has(node.getText())) return;
        // Not rooted at the import: a value from elsewhere, typed by another workspace's
        // export (`getStripe().subscriptions.retrieve()`), a cast, or a parameter. The checker
        // still knows where the member is declared; only a distinctive name is worth asking.
        if (!rootedAtImport(parent, requireLocals) && !distinctive(node.getText())) return;
      }
      // `Parser` in `Parser.create()` is a qualifier; the reference that matters is `create`.
      if (
        Node.isPropertyAccessExpression(parent) &&
        parent.getExpression() === node &&
        candidate(parent.getName()) &&
        resolver.pathOf(parent.getNameNode().getSymbol())
      ) {
        return;
      }
      if (
        Node.isQualifiedName(parent) &&
        parent.getLeft() === node &&
        resolver.pathOf(parent.getRight().getSymbol())
      )
        return;
      if (
        Node.hasName(parent) &&
        parent.getNameNode() === node &&
        !Node.isPropertyAccessExpression(parent)
      )
        return;

      // `require('pkg').member` inline, typed by the checker or matched by name.
      if (
        Node.isPropertyAccessExpression(parent) &&
        parent.getNameNode() === node &&
        packageLoadCall(unwrapAwait(parent.getExpression()), pkg) !== undefined
      ) {
        const viaChecker = resolver.pathOf(node.getSymbol(), node.getText());
        const resolved = viaChecker ?? byName(node.getText());
        if (resolved)
          emit(
            file,
            node,
            resolved,
            classifyAccess(node),
            viaChecker ? 'direct' : 'require',
            'require',
          );
        return;
      }
      const symbol = node.getSymbol();
      if (!symbol) {
        // `(sub as any).current_period_end` in a file that imports the package: the checker has
        // nothing, but a name only one symbol of the package carries is that symbol.
        if (
          full &&
          Node.isPropertyAccessExpression(parent) &&
          parent.getNameNode() === node &&
          isUntyped(parent.getExpression())
        ) {
          const meaning = onlyMeaning(node.getText());
          if (meaning) emit(file, node, meaning, classifyAccess(node), 'inferred', loaderOf(node));
        }
        return;
      }
      const local = localAliases.get(symbol);
      if (local) {
        emit(file, node, local.resolved, classifyAccess(node), local.via, loaderOf(node));
        return;
      }
      // `const x = require('pkg').member; x(...)`
      const bound = requirePaths.get(symbol);
      if (bound) {
        emit(file, node, bound, classifyAccess(node), 'require', 'require');
        return;
      }
      let resolved = resolver.pathOf(symbol, node.getText());
      let syntactic = false;
      if (!resolved && requireLocals.has(symbol)) {
        // A require the checker could not type (`any`): `x.member` and `x()` are matched by name.
        if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === node) {
          const member = byName(parent.getName());
          if (member) {
            emit(
              file,
              parent.getNameNode(),
              member,
              classifyAccess(parent.getNameNode()),
              'require',
              'require',
            );
          }
          return;
        }
        if (
          Node.isCallExpression(parent) &&
          parent.getExpression() === node &&
          known.has(rootPath)
        ) {
          resolved = { path: rootPath, canonical: rootPath };
          syntactic = true;
        } else return;
      }
      if (!resolved) return;
      const via = syntactic
        ? 'require'
        : (symbol.getFlags() & ts.SymbolFlags.Alias) !== 0
          ? viaOfImport(symbol, repo.dir, resolver)
          : 'direct';
      const access = classifyAccess(node);
      const target =
        access === 'construct'
          ? {
              path: resolver.constructorOf(resolved.path),
              canonical: resolver.constructorOf(resolved.canonical),
            }
          : resolved;
      emit(file, node, target, access, via, loaderOf(node));
    };
    if (full) {
      file.forEachDescendant(visit);
    } else {
      // Only the member names the surface declares, at the positions the index recorded.
      for (const pos of memberHits) {
        const node = file.getDescendantAtPos(pos);
        if (node) visit(node);
      }
    }
  }

  return {
    usages: usages.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
    ),
    unanalyzed: unanalyzed.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    checksJs: repo.project.getCompilerOptions().checkJs === true,
    filesScanned: files.length,
    includesJs: repo.includesJs,
  };
}

/** Where the repository's compiler finds `pkg`, as a package root, or undefined. */
export function installedPackageDir(repoRef: RepoDir, pkg: string): string | undefined {
  return resolvePackageDir(loadedRepo(realpathSync(repoRef.dir), repoRef.rootFiles), pkg);
}

/** Direct dependencies and their installed versions, from the lockfile. Never parses sources: the caller may only be listing. */
export function installedDependenciesOf(repoRef: RepoDir): Map<string, string> {
  const repo = readInstalled(realpathSync(repoRef.dir));
  if (!repo.lockfile) throw new UptideError('NO_LOCKFILE', `${repoRef.dir}: no lockfile found`);
  return new Map(repo.installed);
}

/** Bare package names imported anywhere in the repo's sources, including require() and dynamic import(). */
export function importedPackagesOf(repoRef: RepoDir): Set<string> {
  const repo = loadedRepo(realpathSync(repoRef.dir), repoRef.rootFiles);
  const out = new Set<string>();
  const packageOf = (specifier: string): string | undefined => {
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:'))
      return undefined;
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  };
  for (const file of repo.project.getSourceFiles()) {
    if (file.isDeclarationFile() || file.getFilePath().includes('/node_modules/')) continue;
    for (const decl of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
      const spec = decl.getModuleSpecifierValue();
      const name = spec === undefined ? undefined : packageOf(spec);
      if (name) out.add(name);
    }
    file.forEachDescendant((node) => {
      let spec: string | undefined;
      if (Node.isCallExpression(node)) {
        const callee = node.getExpression();
        const arg = node.getArguments()[0];
        const isRequire = Node.isIdentifier(callee) && callee.getText() === 'require';
        const isImport = callee.getKind() === ts.SyntaxKind.ImportKeyword;
        if ((isRequire || isImport) && arg && Node.isStringLiteral(arg))
          spec = arg.getLiteralValue();
      } else if (Node.isImportEqualsDeclaration(node)) {
        spec = node
          .getModuleReference()
          .getFirstDescendantByKind(ts.SyntaxKind.StringLiteral)
          ?.getLiteralValue();
      }
      const name = spec === undefined ? undefined : packageOf(spec);
      if (name) out.add(name);
    });
  }
  return out;
}
