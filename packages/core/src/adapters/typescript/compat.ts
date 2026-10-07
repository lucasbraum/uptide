import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ModuleDeclaration,
  Node,
  Project,
  type Signature,
  type SourceFile,
  type Type,
  ts,
} from 'ts-morph';
import { parseCallable } from '../../diff/signature-parse.js';
import type {
  CompareTypesInput,
  ParameterComparison,
  SignatureComparison,
  TypeComparison,
  TypeRelation,
} from '../../domain/adapter.js';
import { leafOf, parentOf, splitPath } from '../../domain/path.js';
import type { ApiSymbol } from '../../domain/surface.js';
import { resolveEntryPoints } from './entry-points.js';
import { ambientModuleName, ownEntryOf } from './walk.js';

/**
 * The "compat program": a TypeScript program over version B in which, for every path to
 * compare, the OLD signature text and the NEW signature text are declared as type aliases
 * and related with the checker's assignability. Both texts are evaluated in B's own
 * scope, appended to the entry module (or the namespace block the symbol lives in), so
 * every name resolves the way it does for B's own declarations. That is what a consumer's
 * code experiences after upgrading: every name it wrote re-binds to B's declaration.
 * Loading A's own types instead would make one changed type cascade into every signature
 * that mentions it, and would merge two versions' `declare module` blocks into one.
 */

const MODIFIERS = /^(readonly |protected |abstract |static |const |let |var )+/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Walks type text at bracket depth: calls `visit` with each character outside string and
 * template literals and the depth before it. The `>` of an arrow (`=>`) closes nothing.
 */
function scanDepth(
  text: string,
  from: number,
  visit: (ch: string, i: number, depth: number) => boolean | undefined,
): void {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (visit(ch, i, depth)) return;
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
    else if ((ch === '>' && text[i - 1] !== '=') || ch === ')' || ch === ']' || ch === '}') depth--;
  }
}

/** The index of the `>` that closes the type parameter list opened by the `<` at `open`. */
function closingAngle(text: string, open: number): number | undefined {
  let close: number | undefined;
  scanDepth(text, open, (ch, i, depth) => {
    if (depth === 1 && ch === '>' && text[i - 1] !== '=') close = i;
    return close !== undefined;
  });
  return close;
}

const HEADER = /^(?:abstract )?(?:class|interface|type)</;

function headerTypeParams(symbol: ApiSymbol | undefined): string | undefined {
  if (!symbol) return undefined;
  const m = HEADER.exec(symbol.signature);
  if (!m) return undefined;
  const close = closingAngle(symbol.signature, m[0].length - 1);
  return close === undefined ? undefined : symbol.signature.slice(m[0].length, close);
}

function countParams(list: string): number {
  let n = 1;
  scanDepth(list, 0, (ch, _i, depth) => {
    if (ch === ',' && depth === 0) n++;
    return false;
  });
  return n;
}

/**
 * The right-hand side of a type alias signature (`type<T = never> = body`). The alias's
 * own ` = ` follows its type parameter list; a default's (`Start extends number = never`)
 * sits inside it.
 */
function aliasBody(sig: string): string | undefined {
  const m = HEADER.exec(sig);
  const close = m ? closingAngle(sig, m[0].length - 1) : undefined;
  if (m && close === undefined) return undefined;
  const eq = sig.indexOf(' = ', close ?? 0);
  return eq === -1 ? undefined : sig.slice(eq + 3);
}

function overloadMembers(signature: string, prefix: string): string[] | undefined {
  const overloads = parseCallable(signature.replace(MODIFIERS, ''));
  if (!overloads) return undefined;
  return overloads.map((o) => {
    const params = [
      ...(o.thisType !== undefined ? [`this: ${o.thisType}`] : []),
      ...o.params.map((p) => `${p.rest ? '...' : ''}${p.name}${p.optional ? '?' : ''}: ${p.type}`),
    ].join(', ');
    const tp = o.typeParams.length > 0 ? `<${o.typeParams.join(', ')}>` : '';
    return `${prefix}${tp}(${params}): ${o.returnType}`;
  });
}

/**
 * Rebuilds the object literal a property collapsed to `{…}` from its member symbols, so
 * `auth: {…}` can be compared with the named type that replaced it.
 */
function expandCollapsed(
  text: string,
  path: string,
  symbols: Map<string, ApiSymbol>,
): string | undefined {
  if (!text.includes('{…}')) return text;
  const container = text === '{…}' ? path : `${path}[]`;
  const members: string[] = [];
  for (const s of symbols.values()) {
    if (parentOf(s.path) !== container) continue;
    const leaf = leafOf(s.path);
    const sep = s.path[container.length];
    if (leaf === '()') {
      members.push(...(overloadMembers(s.signature, '') ?? []));
      continue;
    }
    if (leaf === 'new()') {
      members.push(...(overloadMembers(s.signature, 'new ') ?? []));
      continue;
    }
    if (leaf.startsWith('[') && sep === '#') {
      members.push(`[key: ${leaf.slice(1, -1)}]: ${s.signature.replace(MODIFIERS, '')}`);
      continue;
    }
    const name = IDENTIFIER.test(leaf) ? leaf : JSON.stringify(leaf);
    const optional = s.optional ? '?' : '';
    if (s.kind === 'method') {
      const overloads = overloadMembers(s.signature, `${name}${optional}`);
      if (!overloads) return undefined;
      members.push(...overloads);
    } else {
      const inner = expandCollapsed(s.signature.replace(MODIFIERS, ''), s.path, symbols);
      if (inner === undefined) return undefined;
      members.push(
        `${s.signature.startsWith('readonly ') ? 'readonly ' : ''}${name}${optional}: ${inner}`,
      );
    }
  }
  const literal = `{ ${members.join('; ')} }`;
  return text.replace('{…}', literal);
}

/** The type text an alias should declare for a symbol, or undefined when the signature is not a type expression. */
function bodyFor(
  symbol: ApiSymbol,
  path: string,
  symbols: Map<string, ApiSymbol>,
  container: string | undefined,
): string | undefined {
  // `this` as a type means the container; `this:` names the this-parameter and must stay.
  const sig = symbol.signature.replace(/\bthis\b(?!\s*:)/g, container ?? 'this');
  if (sig === '') return undefined;
  switch (symbol.kind) {
    case 'property':
    case 'variable':
      return expandCollapsed(sig.replace(MODIFIERS, ''), path, symbols);
    case 'enumMember':
      return sig;
    case 'function':
    case 'method': {
      const members = overloadMembers(sig, leafOf(path) === 'new()' ? 'new ' : '');
      return members ? `{ ${members.join('; ')} }` : undefined;
    }
    case 'type':
      return aliasBody(sig);
    default:
      return undefined;
  }
}

interface AliasPlan {
  statements: string[];
}

/** Two aliases: the generic one carrying every ancestor's type parameters, and one instantiated with `any`. */
function aliasFor(
  name: string,
  path: string,
  symbols: Map<string, ApiSymbol>,
): AliasPlan | undefined {
  const symbol = symbols.get(path);
  if (!symbol) return undefined;
  const params: string[] = [];
  const own = symbol.kind === 'type' ? headerTypeParams(symbol) : undefined;
  let containerRef: string | undefined;
  for (let p = parentOf(path); p !== undefined; p = parentOf(p)) {
    const parent = symbols.get(p);
    const tp = headerTypeParams(parent);
    if (tp) params.unshift(tp);
    if (
      containerRef === undefined &&
      parent &&
      (parent.kind === 'class' || parent.kind === 'interface')
    ) {
      const { scope, segments } = splitPath(p);
      if (scope === undefined && segments.every((seg, i) => i === 0 || seg.startsWith('.'))) {
        const anys = tp
          ? `<${Array.from({ length: countParams(tp) }, () => 'any').join(', ')}>`
          : '';
        containerRef = `${segments.join('')}${anys}`;
      }
    }
  }
  const body = bodyFor(symbol, path, symbols, containerRef);
  if (body === undefined) return undefined;
  if (own) params.push(own);
  const list = params.join(', ');
  const anys = params
    .map((p) => Array.from({ length: countParams(p) }, () => 'any').join(', '))
    .join(', ');
  return {
    statements: [
      `type ${name}${list ? `<${list}>` : ''} = ${body};`,
      `type ${name}$ = ${name}${list ? `<${anys}>` : ''};`,
    ],
  };
}

function isAnyLike(type: Type): boolean {
  return (type.getFlags() & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

function isErrorType(type: Type): boolean {
  return (type.compilerType as { intrinsicName?: string }).intrinsicName === 'error';
}

function relate(checker: ts.TypeChecker, before: Type, after: Type): TypeRelation {
  const anyBefore = isAnyLike(before);
  const anyAfter = isAnyLike(after);
  if (anyBefore && anyAfter) return 'equivalent';
  if (anyBefore) return 'narrowed';
  if (anyAfter) return 'widened';
  const oldToNew = checker.isTypeAssignableTo(before.compilerType, after.compilerType);
  const newToOld = checker.isTypeAssignableTo(after.compilerType, before.compilerType);
  if (oldToNew && newToOld) return 'equivalent';
  if (oldToNew) return 'widened';
  if (newToOld) return 'narrowed';
  return 'incompatible';
}

function parameterInfo(sig: Signature): { name: string; type: Type; optional: boolean }[] {
  return sig.getParameters().map((p) => {
    const decl = p.getDeclarations()[0];
    const node = decl?.compilerNode;
    const optional =
      node !== undefined && ts.isParameter(node)
        ? node.questionToken !== undefined ||
          node.dotDotDotToken !== undefined ||
          node.initializer !== undefined
        : false;
    const declared = decl ? p.getTypeAtLocation(decl) : sig.getReturnType();
    // An optional parameter's type carries `undefined`; optionality is reported on its own,
    // so compare the type without it (null goes too, an accepted imprecision).
    const type = optional ? declared.getNonNullableType() : declared;
    return { name: p.getName(), type, optional };
  });
}

function compareSignatures(
  checker: ts.TypeChecker,
  before: Signature,
  after: Signature,
): SignatureComparison {
  const pa = parameterInfo(before);
  const pb = parameterInfo(after);
  const parameters: ParameterComparison[] = [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const a = pa[i];
    const b = pb[i];
    if (a && !b)
      parameters.push({
        name: a.name,
        relation: 'removed',
        optionalBefore: a.optional,
        optionalAfter: false,
      });
    else if (!a && b)
      parameters.push({
        name: b.name,
        relation: 'added',
        optionalBefore: false,
        optionalAfter: b.optional,
      });
    else if (a && b) {
      parameters.push({
        name: a.name,
        relation: relate(checker, a.type, b.type),
        optionalBefore: a.optional,
        optionalAfter: b.optional,
      });
    }
  }
  const result: SignatureComparison = {
    parameters,
    returnType: relate(checker, before.getReturnType(), after.getReturnType()),
  };
  const thisA = thisParameter(before);
  const thisB = thisParameter(after);
  if (thisA && !thisB) result.thisParameter = { relation: 'removed', before: thisA.text };
  else if (!thisA && thisB) result.thisParameter = { relation: 'added', after: thisB.text };
  else if (thisA && thisB) {
    result.thisParameter = {
      relation: relate(checker, thisA.type, thisB.type),
      before: thisA.text,
      after: thisB.text,
    };
  }
  return result;
}

/** The declared `this` parameter, which the checker keeps out of `getParameters()`. Printed relative to its declaration so names stay short. */
function thisParameter(sig: Signature): { type: Type; text: string } | undefined {
  const decl = sig.getDeclaration();
  if (!Node.isParametered(decl)) return undefined;
  const param = decl.getParameters().find((p) => p.getName() === 'this');
  if (!param) return undefined;
  const type = param.getType();
  return { type, text: type.getText(param, ts.TypeFormatFlags.NoTruncation) };
}

function compare(
  checker: ts.TypeChecker,
  before: Type,
  after: Type,
  construct: boolean,
): TypeComparison {
  const sigsA = construct ? before.getConstructSignatures() : before.getCallSignatures();
  const sigsB = construct ? after.getConstructSignatures() : after.getCallSignatures();
  const callable = sigsA.length > 0 && sigsB.length > 0;
  const result: TypeComparison = { relation: relate(checker, before, after), callable };
  if (callable) {
    result.typeParameterCounts = {
      before: sigsA.map((s) => s.getTypeParameters().length),
      after: sigsB.map((s) => s.getTypeParameters().length),
    };
  }
  const generic = [...sigsA, ...sigsB].some((s) => s.getTypeParameters().length > 0);
  if (callable && sigsA.length === sigsB.length && !generic) {
    result.signatures = sigsA.map((s, i) => compareSignatures(checker, s, sigsB[i] as Signature));
  }
  return result;
}

/** A name the old text used that B does not have shows up as an error type somewhere inside the alias. */
function hasErrorInside(file: SourceFile | ModuleDeclaration, name: string): boolean {
  const generic = file.getTypeAlias(name);
  if (!generic) return true;
  return (
    generic
      .getTypeNode()
      ?.getDescendants()
      .some((d) => Node.isTypeReference(d) && isErrorType(d.getType())) ?? false
  );
}

type Scope = SourceFile | ModuleDeclaration;

/**
 * Where an entry point's names live: the module file itself, or for script-style
 * declarations (stripe) the `declare module 'pkg'` block that carries the exports.
 */
function scopeForEntry(
  project: Project,
  file: SourceFile,
  entry: string,
  packageName: string,
): Scope | undefined {
  if (file.getSymbol() !== undefined) return file;
  const wanted = entry === '.' ? packageName : `${packageName}/${entry.slice(2)}`;
  for (const sf of project.getSourceFiles()) {
    for (const mod of sf.getModules()) {
      if (ambientModuleName(mod) === wanted && ownEntryOf(wanted, packageName) === entry)
        return mod;
    }
  }
  return undefined;
}

/**
 * The namespace block a path's declaration sits in, when its `.`-chain resolves to
 * namespaces in B: aliases placed there see the same sibling names the declaration did.
 */
function namespaceScope(project: Project, scope: Scope, path: string): Scope {
  const checker = project.getTypeChecker();
  const moduleSymbol = Node.isSourceFile(scope)
    ? scope.getSymbol()
    : checker.getSymbolAtLocation(scope.getNameNode());
  if (!moduleSymbol) return scope;
  let exports = checker.getExportsOfModule(moduleSymbol);
  let current: Scope = scope;
  for (const seg of splitPath(path).segments) {
    if (!/^\.?[A-Za-z_$"]/.test(seg) || seg === '.new()') break;
    const name = seg.startsWith('.') ? seg.slice(1) : seg;
    const found = exports.find((e) => e.getName() === name);
    if (!found) break;
    const symbol =
      (found.getFlags() & ts.SymbolFlags.Alias) !== 0 ? (found.getAliasedSymbol() ?? found) : found;
    const block = symbol
      .getDeclarations()
      .find(
        (d): d is ModuleDeclaration => Node.isModuleDeclaration(d) && d.getBody() !== undefined,
      );
    if (!block) break;
    current = block;
    exports = symbol.getExports();
  }
  return current;
}

export async function compareTypesWithChecker(
  input: CompareTypesInput,
): Promise<Map<string, TypeComparison>> {
  const entries = resolveEntryPoints(input.b.dir, input.b.name, input.b.version);
  const dir = mkdtempSync(join(tmpdir(), 'uptide-compat-'));
  const out = new Map<string, TypeComparison>();
  try {
    const paths: Record<string, string[]> = {};
    for (const { entry, file } of entries)
      paths[entry === '.' ? '__b' : `__b/${entry.slice(2)}`] = [file];
    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      compilerOptions: {
        strict: true,
        module: ts.ModuleKind.Preserve,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ESNext,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
        baseUrl: dir,
        paths,
      },
    });
    const entryFiles = new Map(entries.map((e) => [e.entry, project.addSourceFileAtPath(e.file)]));
    project.resolveSourceFileDependencies();

    const symbolsA = new Map(input.surfaceA.symbols.map((s) => [s.path, s]));
    const symbolsB = new Map(input.surfaceB.symbols.map((s) => [s.path, s]));

    const byEntry = new Map<string, string[]>();
    for (const path of input.paths) {
      const entry = splitPath(path).scope ?? '.';
      if (!entryFiles.has(entry)) continue;
      const list = byEntry.get(entry) ?? [];
      list.push(path);
      byEntry.set(entry, list);
    }

    const planned: { path: string; scope: Scope; index: number; construct: boolean }[] = [];
    let index = 0;
    for (const [entry, pathsHere] of byEntry) {
      const file = entryFiles.get(entry) as SourceFile;
      const scope = scopeForEntry(project, file, entry, input.b.name);
      if (!scope) continue;

      // A module made of re-exports has no local names; import its own exports so bare names resolve.
      if (Node.isSourceFile(scope)) {
        const moduleSymbol = scope.getSymbol();
        const locals = new Set(scope.getLocals().map((l) => l.getName()));
        const names = moduleSymbol
          ? project
              .getTypeChecker()
              .getExportsOfModule(moduleSymbol)
              .map((e) => e.getName())
              .filter((n) => IDENTIFIER.test(n) && n !== 'default' && !locals.has(n))
          : [];
        if (names.length > 0) {
          scope.addStatements(
            `import { ${names.join(', ')} } from ${JSON.stringify(entry === '.' ? '__b' : `__b/${entry.slice(2)}`)};`,
          );
        }
      }

      const perScope = new Map<Scope, string[]>();
      for (const path of pathsHere) {
        const a = aliasFor(`__a_${index}`, path, symbolsA);
        const b = aliasFor(`__b_${index}`, path, symbolsB);
        if (!a || !b) continue;
        const target = namespaceScope(project, scope, path);
        const lines = perScope.get(target) ?? [];
        lines.push(...a.statements, ...b.statements);
        perScope.set(target, lines);
        planned.push({ path, scope: target, index, construct: leafOf(path) === 'new()' });
        index++;
      }
      for (const [target, lines] of perScope) target.addStatements(lines);
    }

    if (process.env.UPTIDE_COMPAT_KEEP) {
      for (const f of new Set(planned.map((p) => p.scope.getSourceFile()))) {
        writeFileSync(join(dir, f.getBaseName()), f.getFullText());
      }
    }

    const checker = project.getTypeChecker().compilerObject;
    for (const { path, scope, index: i, construct } of planned) {
      const a = scope.getTypeAlias(`__a_${i}$`);
      const b = scope.getTypeAlias(`__b_${i}$`);
      if (!a || !b) continue;
      const typeA = a.getType();
      const typeB = b.getType();
      if (isErrorType(typeA) || isErrorType(typeB)) continue;
      if (hasErrorInside(scope, `__a_${i}`) || hasErrorInside(scope, `__b_${i}`)) continue;
      if (isAnyLike(typeA) && isAnyLike(typeB)) continue;
      out.set(path, compare(checker, typeA, typeB, construct));
    }
    return out;
  } finally {
    // UPTIDE_COMPAT_KEEP=1 leaves the generated program on disk for inspection.
    if (process.env.UPTIDE_COMPAT_KEEP) console.error(`compat program kept at ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
}
