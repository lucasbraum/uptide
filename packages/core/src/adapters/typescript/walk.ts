import { relative } from 'node:path';
import type {
  ClassDeclaration,
  EnumDeclaration,
  GetAccessorDeclaration,
  InterfaceDeclaration,
  JSDocableNode,
  ModuleDeclaration,
  Symbol as MorphSymbol,
  PropertyDeclaration,
  PropertySignature,
  SetAccessorDeclaration,
  SourceFile,
  TypeAliasDeclaration,
  TypeChecker,
  TypeLiteralNode,
  VariableDeclaration,
} from 'ts-morph';
import { Node, ts } from 'ts-morph';
import * as P from '../../domain/path.js';
import type { ApiSymbol, SymbolKind, Visibility } from '../../domain/surface.js';
import { printCallable, printNode, printTypeNode } from './serialize.js';

/**
 * Walks exported declarations and emits one ApiSymbol per public name, following the
 * canonical path rules in docs/architecture.md. Everything here is read-only over the AST.
 */

export interface LocalSymbol {
  symbol: ApiSymbol;
  /** Top-level path this symbol hangs from; used to move whole subtrees on collisions. */
  root: string;
}

export interface AliasClass {
  /** The declaration's own name, when it has one; the path ending in it is the best canonical. */
  declaredName?: string;
  symbols: ApiSymbol[];
}

export interface Sink {
  entry: string;
  /** Absolute package directory; symbol files are recorded relative to it. */
  packageDir: string;
  checker: TypeChecker;
  /** Shared across entry points: every symbol emitted for each declaration, for alias detection. */
  byDeclaration: Map<ts.Node, AliasClass>;
  emit(root: string, symbol: ApiSymbol): void;
  /** Declarations behind each top-level path, for collision detection across entry points. */
  rootDecls: Map<string, Set<ts.Node>>;
}

const STRENGTH: SymbolKind[] = [
  'class',
  'function',
  'variable',
  'interface',
  'enum',
  'type',
  'namespace',
  'module',
];

function kindOf(node: Node): SymbolKind | undefined {
  if (Node.isClassDeclaration(node)) return 'class';
  if (Node.isFunctionDeclaration(node)) return 'function';
  if (Node.isVariableDeclaration(node)) return 'variable';
  if (Node.isInterfaceDeclaration(node)) return 'interface';
  if (Node.isEnumDeclaration(node)) return 'enum';
  if (Node.isModuleDeclaration(node) || Node.isSourceFile(node)) return 'namespace';
  if (Node.isTypeAliasDeclaration(node)) return 'type';
  return undefined;
}

function strongest(kinds: SymbolKind[]): SymbolKind {
  return [...kinds].sort((a, b) => STRENGTH.indexOf(a) - STRENGTH.indexOf(b))[0] ?? 'type';
}

function jsDocTag(nodes: Node[], name: string): string | true | undefined {
  for (const declared of nodes) {
    // `/** @deprecated */ export declare const X` documents the statement, not the declaration.
    const node = Node.isVariableDeclaration(declared)
      ? (declared.getVariableStatement() ?? declared)
      : declared;
    if (!Node.isJSDocable(node)) continue;
    for (const doc of (node as JSDocableNode).getJsDocs()) {
      for (const tag of doc.getTags()) {
        if (tag.getTagName() === name) {
          const text = tag.getCommentText()?.trim();
          return text ? text : true;
        }
      }
    }
  }
  return undefined;
}

function deprecatedOf(nodes: Node[]): string | true | undefined {
  return jsDocTag(nodes, 'deprecated');
}

function isInternal(nodes: Node[]): boolean {
  return jsDocTag(nodes, 'internal') !== undefined;
}

function isProtected(nodes: Node[]): boolean {
  return nodes.some((n) => Node.isScoped(n) && n.getScope() === 'protected');
}

/** Property names come back with their quotes or brackets; paths quote on their own terms. */
function memberName(node: Node & { getName(): string }): string {
  const raw = node.getName();
  if (/^['"]/.test(raw)) {
    try {
      return JSON.parse(raw.replace(/^'(.*)'$/s, (_, s: string) => JSON.stringify(s))) as string;
    } catch {
      return raw;
    }
  }
  return raw;
}

function typeParams(node: Node): string {
  if (!Node.isTypeParametered(node)) return '';
  const params = node.getTypeParameters();
  return params.length === 0 ? '' : `<${params.map((p) => printNode(p)).join(', ')}>`;
}

/** The anonymous type literal a property should be expanded through, if any, plus the path suffix. */
function expandable(
  typeNode: Node | undefined,
): { literal: TypeLiteralNode; array: boolean } | undefined {
  if (!typeNode) return undefined;
  if (Node.isTypeLiteral(typeNode)) return { literal: typeNode, array: false };
  if (Node.isArrayTypeNode(typeNode)) {
    const el = typeNode.getElementTypeNode();
    if (Node.isTypeLiteral(el)) return { literal: el, array: true };
  }
  if (Node.isTypeReference(typeNode)) {
    const name = typeNode.getTypeName().getText();
    const args = typeNode.getTypeArguments();
    const first = args[0];
    if (
      (name === 'Array' || name === 'ReadonlyArray') &&
      args.length === 1 &&
      first &&
      Node.isTypeLiteral(first)
    ) {
      return { literal: first, array: true };
    }
  }
  return undefined;
}

function modifiers(node: Node): string {
  const parts: string[] = [];
  if (Node.isScoped(node) && node.getScope() === 'protected') parts.push('protected');
  if (Node.isAbstractable(node) && node.isAbstract()) parts.push('abstract');
  if (Node.isReadonlyable(node) && node.isReadonly()) parts.push('readonly');
  return parts.length === 0 ? '' : `${parts.join(' ')} `;
}

function isHidden(node: Node): boolean {
  if (Node.isScoped(node) && node.getScope() === 'private') return true;
  const name = Node.hasName(node) ? node.getName() : '';
  return name.startsWith('#');
}

interface Ctx {
  sink: Sink;
  root: string;
  /** Inherited by everything below an `@internal` symbol. */
  visibility?: Visibility;
  /** The root being walked is the module's `export =`. */
  exportEquals?: boolean;
  /**
   * Members reached through a base type: emitted under the derived path so the apparent
   * member set diffs, but the declaration keeps pointing at the path it was declared under.
   */
  inherited?: boolean;
}

/** Emits a symbol and returns the context its members should be walked with. */
function emit(ctx: Ctx, symbol: Omit<ApiSymbol, 'exportedFrom'>, nodes: Node[]): Ctx {
  const full: ApiSymbol = { ...symbol, exportedFrom: [ctx.sink.entry] };
  if (full.optional === undefined) delete full.optional;
  if (full.deprecated === undefined) delete full.deprecated;
  const visibility: Visibility | undefined =
    ctx.visibility ??
    (isInternal(nodes) ? 'internal' : isProtected(nodes) ? 'protected' : undefined);
  if (visibility) full.visibility = visibility;
  if (ctx.exportEquals && symbol.path === ctx.root) full.exportEquals = true;

  const first = nodes[0];
  if (first) {
    full.file = relative(ctx.sink.packageDir, first.getSourceFile().getFilePath())
      .split('\\')
      .join('/');
  }
  if (first && !ctx.inherited) {
    const cls = ctx.sink.byDeclaration.get(first.compilerNode) ?? { symbols: [] };
    if (cls.declaredName === undefined && Node.hasName(first)) cls.declaredName = first.getName();
    cls.symbols.push(full);
    // Every declaration of a merged symbol points at the same class, so a reference to any
    // part (the namespace side of a class+namespace) maps back to this path.
    for (const node of nodes) ctx.sink.byDeclaration.set(node.compilerNode, cls);
  }
  ctx.sink.emit(ctx.root, full);
  return visibility === 'internal' ? { ...ctx, visibility } : ctx;
}

/**
 * Symbols that share a declaration are aliases of one another. The canonical one has the
 * fewest path segments, then a leaf equal to the declared name, then was seen first.
 * Same-path entries (one declaration reached from two entry points) are not aliases.
 */
export function assignAliases(byDeclaration: Map<ts.Node, AliasClass>): void {
  for (const { declaredName, symbols } of byDeclaration.values()) {
    const distinct = new Map<string, ApiSymbol[]>();
    for (const s of symbols) {
      const list = distinct.get(s.path) ?? [];
      list.push(s);
      distinct.set(s.path, list);
    }
    if (distinct.size < 2) continue;
    const rank = (path: string): [number, number] => [
      P.splitPath(path).segments.length,
      P.leafOf(path) === declaredName ? 0 : 1,
    ];
    let canonical: string | undefined;
    for (const path of distinct.keys()) {
      if (canonical === undefined) {
        canonical = path;
        continue;
      }
      const [a, b] = [rank(path), rank(canonical)];
      if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) canonical = path;
    }
    for (const [path, list] of distinct) {
      if (path === canonical) continue;
      for (const s of list) s.aliasOf = canonical;
    }
  }
}

// ---------- members ----------

function walkProperty(ctx: Ctx, path: string, node: PropertyDeclaration | PropertySignature): void {
  const typeNode = node.getTypeNode();
  const expansion = expandable(typeNode);
  const type = typeNode
    ? printTypeNode(typeNode, expansion ? { collapse: expansion.literal.compilerNode } : {})
    : 'any';
  const symbol: Omit<ApiSymbol, 'exportedFrom'> = {
    path,
    kind: 'property',
    signature: `${modifiers(node)}${type}`,
    deprecated: deprecatedOf([node]),
  };
  if (node.hasQuestionToken()) symbol.optional = true;
  const inner = emit(ctx, symbol, [node]);
  if (expansion) {
    walkTypeMembers(inner, expansion.array ? P.element(path) : path, [expansion.literal]);
  }
}

function walkAccessors(
  ctx: Ctx,
  path: string,
  getters: GetAccessorDeclaration[],
  setters: SetAccessorDeclaration[],
): void {
  const getter = getters[0];
  const setter = setters[0];
  const typeNode = getter?.getReturnTypeNode() ?? setter?.getParameters()[0]?.getTypeNode();
  const type = typeNode ? printTypeNode(typeNode) : 'any';
  const readonly = setter === undefined ? 'readonly ' : '';
  const scope = (getter ?? setter) as Node;
  const prot = Node.isScoped(scope) && scope.getScope() === 'protected' ? 'protected ' : '';
  emit(
    ctx,
    {
      path,
      kind: 'property',
      signature: `${prot}${readonly}${type}`,
      deprecated: deprecatedOf([...getters, ...setters]),
    },
    [...getters, ...setters],
  );
}

function walkCallableGroup(ctx: Ctx, path: string, nodes: Node[], optional = false): void {
  const symbol: Omit<ApiSymbol, 'exportedFrom'> = {
    path,
    kind: 'method',
    signature: nodes.map((n) => `${modifiers(n)}${printCallable(n)}`).join('; '),
    deprecated: deprecatedOf(nodes),
  };
  if (optional) symbol.optional = true;
  emit(ctx, symbol, nodes);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** Interfaces, merged interface declarations, and anonymous type literals share one member model. */
function walkTypeMembers(
  ctx: Ctx,
  path: string,
  containers: (InterfaceDeclaration | TypeLiteralNode)[],
): void {
  const props = containers.flatMap((c) => c.getProperties());
  for (const prop of props) walkProperty(ctx, P.instanceMember(path, memberName(prop)), prop);

  const methods = groupBy(
    containers.flatMap((c) => c.getMethods()),
    (m) => memberName(m),
  );
  for (const [name, overloads] of methods) {
    walkCallableGroup(
      ctx,
      P.instanceMember(path, name),
      overloads,
      overloads.some((m) => m.hasQuestionToken()),
    );
  }

  const getters = groupBy(
    containers.flatMap((c) => c.getGetAccessors()),
    (g) => memberName(g),
  );
  const setters = groupBy(
    containers.flatMap((c) => c.getSetAccessors()),
    (s) => memberName(s),
  );
  for (const name of new Set([...getters.keys(), ...setters.keys()])) {
    walkAccessors(
      ctx,
      P.instanceMember(path, name),
      getters.get(name) ?? [],
      setters.get(name) ?? [],
    );
  }

  const calls = containers.flatMap((c) => c.getCallSignatures());
  if (calls.length > 0) walkCallableGroup(ctx, P.callSignature(path), calls);
  const constructs = containers.flatMap((c) => c.getConstructSignatures());
  if (constructs.length > 0) walkCallableGroup(ctx, P.constructSignature(path), constructs);

  for (const index of containers.flatMap((c) => c.getIndexSignatures())) {
    const keyType = printNode(index.getKeyTypeNode());
    const valueType = index.getReturnTypeNode();
    emit(
      ctx,
      {
        path: P.indexSignature(path, keyType),
        kind: 'property',
        signature: `${index.isReadonly() ? 'readonly ' : ''}${valueType ? printNode(valueType) : 'any'}`,
        deprecated: deprecatedOf([index]),
      },
      [index],
    );
  }
}

function walkClassMembers(ctx: Ctx, path: string, classes: ClassDeclaration[]): void {
  const ctors = classes.flatMap((c) => c.getConstructors());
  if (ctors.length > 0) walkCallableGroup(ctx, P.constructSignature(path), ctors);

  const member = (node: Node & { isStatic(): boolean }, name: string): string =>
    node.isStatic() ? P.staticMember(path, name) : P.instanceMember(path, name);

  for (const prop of classes.flatMap((c) => c.getProperties())) {
    if (isHidden(prop)) continue;
    walkProperty(ctx, member(prop, memberName(prop)), prop);
  }

  const methods = groupBy(
    classes.flatMap((c) => c.getMethods()).filter((m) => !isHidden(m)),
    (m) => `${m.isStatic() ? 's' : 'i'}:${memberName(m)}`,
  );
  for (const overloads of methods.values()) {
    const first = overloads[0] as (typeof overloads)[number];
    walkCallableGroup(
      ctx,
      member(first, memberName(first)),
      overloads,
      overloads.some((m) => m.hasQuestionToken()),
    );
  }

  const getters = groupBy(
    classes.flatMap((c) => c.getGetAccessors()).filter((g) => !isHidden(g)),
    (g) => `${g.isStatic() ? 's' : 'i'}:${memberName(g)}`,
  );
  const setters = groupBy(
    classes.flatMap((c) => c.getSetAccessors()).filter((s) => !isHidden(s)),
    (s) => `${s.isStatic() ? 's' : 'i'}:${memberName(s)}`,
  );
  for (const key of new Set([...getters.keys(), ...setters.keys()])) {
    const any = (getters.get(key) ?? setters.get(key))?.[0] as
      | GetAccessorDeclaration
      | SetAccessorDeclaration;
    walkAccessors(
      ctx,
      member(any, memberName(any)),
      getters.get(key) ?? [],
      setters.get(key) ?? [],
    );
  }
}

/**
 * Members a class or interface has through `extends` (and intersections in the
 * declared type) but does not declare itself. They are part of the apparent member set a
 * consumer sees: zod 4 declares `ZodString#min` on a mixin, and it must not diff as
 * removed. Only declarations inside the package count (nothing inherited from the
 * standard library is the package's API), and the declaration stays mapped to the path it
 * was declared under.
 */
function walkInheritedMembers(
  ctx: Ctx,
  path: string,
  decls: (ClassDeclaration | InterfaceDeclaration)[],
  own: Set<string>,
): void {
  const first = decls[0];
  if (!first) return;
  const inner: Ctx = { ...ctx, inherited: true };
  const inPackage = (node: Node): boolean =>
    node.getSourceFile().getFilePath().startsWith(`${ctx.sink.packageDir}/`);
  const emitMember = (memberPath: string, nodes: Node[]): void => {
    const usable = nodes.filter(inPackage).filter((n) => !isHidden(n));
    if (usable.length === 0) return;
    const props = usable.filter(
      (n): n is PropertyDeclaration | PropertySignature =>
        Node.isPropertyDeclaration(n) || Node.isPropertySignature(n),
    );
    const methods = usable.filter((n) => Node.isMethodDeclaration(n) || Node.isMethodSignature(n));
    const getters = usable.filter(Node.isGetAccessorDeclaration);
    const setters = usable.filter(Node.isSetAccessorDeclaration);
    if (methods.length > 0) {
      walkCallableGroup(
        inner,
        memberPath,
        methods,
        methods.some((m) => Node.isQuestionTokenable(m) && m.hasQuestionToken()),
      );
    } else if (props[0]) {
      walkProperty(inner, memberPath, props[0]);
    } else if (getters.length > 0 || setters.length > 0) {
      walkAccessors(inner, memberPath, getters, setters);
    }
  };
  const instance = first.getType();
  for (const prop of instance.getProperties()) {
    const name = prop.getName();
    if (own.has(`i:${name}`)) continue;
    emitMember(P.instanceMember(path, name), prop.getDeclarations());
  }
  const cls = decls.find(Node.isClassDeclaration);
  if (cls) {
    const symbol = cls.getSymbol();
    if (!symbol) return;
    const statics = ctx.sink.checker.getTypeOfSymbolAtLocation(symbol, cls);
    for (const prop of statics.getProperties()) {
      const name = prop.getName();
      if (name === 'prototype' || own.has(`s:${name}`)) continue;
      emitMember(P.staticMember(path, name), prop.getDeclarations());
    }
  }
}

function ownMemberKeys(decls: (ClassDeclaration | InterfaceDeclaration)[]): Set<string> {
  const keys = new Set<string>();
  for (const d of decls) {
    for (const m of [...d.getProperties(), ...d.getMethods()]) {
      keys.add(`${Node.isStaticable(m) && m.isStatic() ? 's' : 'i'}:${memberName(m)}`);
    }
    for (const m of [...d.getGetAccessors(), ...d.getSetAccessors()]) {
      keys.add(`${Node.isStaticable(m) && m.isStatic() ? 's' : 'i'}:${memberName(m)}`);
    }
  }
  return keys;
}

// ---------- containers ----------

function classHeader(cls: ClassDeclaration): string {
  const parts = [cls.isAbstract() ? 'abstract class' : 'class'];
  parts[0] += typeParams(cls);
  const ext = cls.getExtends();
  if (ext) parts.push(`extends ${printNode(ext)}`);
  const impl = cls.getImplements();
  if (impl.length > 0) parts.push(`implements ${impl.map((i) => printNode(i)).join(', ')}`);
  return parts.join(' ');
}

function interfaceHeader(decls: InterfaceDeclaration[]): string {
  const first = decls[0] as InterfaceDeclaration;
  const ext = decls.flatMap((d) => d.getExtends()).map((e) => printNode(e));
  return `interface${typeParams(first)}${ext.length > 0 ? ` extends ${[...new Set(ext)].sort().join(', ')}` : ''}`;
}

function enumHeader(decl: EnumDeclaration): string {
  return decl.isConstEnum() ? 'const enum' : 'enum';
}

function walkEnumMembers(ctx: Ctx, path: string, decls: EnumDeclaration[]): void {
  for (const member of decls.flatMap((d) => d.getMembers())) {
    const value = member.getValue();
    emit(
      ctx,
      {
        path: P.staticMember(path, memberName(member)),
        kind: 'enumMember',
        signature: value === undefined ? '' : JSON.stringify(value),
        deprecated: deprecatedOf([member]),
      },
      [member],
    );
  }
}

function variableKeyword(decl: VariableDeclaration): string {
  return decl.getVariableStatement()?.getDeclarationKind() ?? 'const';
}

function resolveAlias(symbol: MorphSymbol): MorphSymbol {
  return (symbol.getFlags() & ts.SymbolFlags.Alias) !== 0
    ? (symbol.getAliasedSymbol() ?? symbol)
    : symbol;
}

/**
 * Exports of a symbol as (name, declarations), through aliases, with class members
 * dropped: a namespace merged onto a class reports the class's statics as its exports, and
 * the class walk already emitted those.
 */
function namedExports(symbols: MorphSymbol[]): Map<string, Node[]> {
  const out = new Map<string, Node[]>();
  for (const exp of symbols) {
    const name = exp.getName();
    if (name === 'prototype' || name === ts.InternalSymbolName.ExportEquals) continue;
    const decls = resolveAlias(exp)
      .getDeclarations()
      .filter((d) => !Node.isClassDeclaration(d.getParent()));
    if (decls.length > 0) out.set(name, decls);
  }
  return out;
}

/** The checker's merged symbol for a container, which spans every declaration of that name. */
function mergedSymbol(ctx: Ctx, node: ModuleDeclaration | SourceFile): MorphSymbol | undefined {
  return Node.isSourceFile(node)
    ? node.getSymbol()
    : ctx.sink.checker.getSymbolAtLocation(node.getNameNode());
}

function namespaceExports(ctx: Ctx, modules: ModuleDeclaration[]): Map<string, Node[]> {
  const first = modules[0];
  const symbol = first ? mergedSymbol(ctx, first) : undefined;
  return symbol ? namedExports(symbol.getExports()) : new Map();
}

export function walkNamed(ctx: Ctx, path: string, decls: Node[]): void {
  const kinds = decls.map(kindOf).filter((k): k is SymbolKind => k !== undefined);
  if (kinds.length === 0) return;
  const kind = strongest(kinds);

  const classes = decls.filter(Node.isClassDeclaration);
  const functions = decls.filter(Node.isFunctionDeclaration);
  const variables = decls.filter(Node.isVariableDeclaration);
  const interfaces = decls.filter(Node.isInterfaceDeclaration);
  const enums = decls.filter(Node.isEnumDeclaration);
  const modules = decls.filter(Node.isModuleDeclaration);
  const sourceFiles = decls.filter(Node.isSourceFile);
  const aliases = decls.filter(Node.isTypeAliasDeclaration);

  let signature = '';
  let expandLiteral: TypeLiteralNode | undefined;
  switch (kind) {
    case 'class':
      signature = classHeader(classes[0] as ClassDeclaration);
      break;
    case 'function':
      signature = functions.map((f) => printCallable(f)).join('; ');
      break;
    case 'variable': {
      const v = variables[0] as VariableDeclaration;
      const typeNode = v.getTypeNode();
      const expansion = expandable(typeNode);
      if (expansion && !expansion.array) expandLiteral = expansion.literal;
      const type = typeNode
        ? printTypeNode(typeNode, expandLiteral ? { collapse: expandLiteral.compilerNode } : {})
        : 'any';
      signature = `${variableKeyword(v)} ${type}`;
      break;
    }
    case 'interface':
      signature = interfaceHeader(interfaces);
      break;
    case 'enum':
      signature = enumHeader(enums[0] as EnumDeclaration);
      break;
    case 'namespace':
      signature = 'namespace';
      break;
    case 'type': {
      const alias = aliases[0] as TypeAliasDeclaration;
      const typeNode = alias.getTypeNode();
      if (typeNode && Node.isTypeLiteral(typeNode)) {
        expandLiteral = typeNode;
        signature = `type${typeParams(alias)}`;
      } else {
        signature = `type${typeParams(alias)} = ${typeNode ? printTypeNode(typeNode) : 'any'}`;
      }
      break;
    }
    case 'module':
      signature = 'module';
      break;
    default:
      return;
  }

  const inner = emit(ctx, { path, kind, signature, deprecated: deprecatedOf(decls) }, decls);

  if (classes.length > 0) walkClassMembers(inner, path, classes);
  if (interfaces.length > 0) walkTypeMembers(inner, path, interfaces);
  if (classes.length > 0 || interfaces.length > 0) {
    const containers = [...classes, ...interfaces];
    walkInheritedMembers(inner, path, containers, ownMemberKeys(containers));
  }
  if (expandLiteral) walkTypeMembers(inner, path, [expandLiteral]);
  if (enums.length > 0) walkEnumMembers(inner, path, enums);
  if (modules.length > 0) {
    for (const [name, decl] of namespaceExports(inner, modules)) {
      walkNamed(inner, P.staticMember(path, name), decl);
    }
  }
  for (const sf of sourceFiles) {
    for (const [name, decl] of moduleExports(inner, sf)) {
      walkNamed(inner, P.staticMember(path, name), decl);
    }
  }
}

// ---------- entry points ----------

/** Rule 2: `export =` / `export default` of a nominal declaration keeps its declared name. */
function defaultExportPath(decls: Node[]): string {
  for (const d of decls) {
    if (
      (Node.isClassDeclaration(d) ||
        Node.isFunctionDeclaration(d) ||
        Node.isEnumDeclaration(d) ||
        Node.isInterfaceDeclaration(d) ||
        Node.isModuleDeclaration(d)) &&
      d.getName()
    ) {
      return P.topLevel(d.getName() as string);
    }
  }
  return P.topLevel('default');
}

/**
 * Exports of a module (a source file or an ambient `declare module 'x'`), following
 * `export *` chains. `export =` is checked on the raw symbol first because the resolved
 * export list flattens the target's members into top-level names (rule 2 wants the nominal root).
 */
function moduleExports(ctx: Ctx, container: SourceFile | ModuleDeclaration): Map<string, Node[]> {
  const symbol = mergedSymbol(ctx, container);
  if (!symbol) return new Map();
  const equals = symbol
    .getExports()
    .find((e) => e.getName() === ts.InternalSymbolName.ExportEquals);
  if (equals) {
    const decls = resolveAlias(equals).getDeclarations();
    return new Map(decls.length > 0 ? [[ts.InternalSymbolName.ExportEquals, decls]] : []);
  }
  return namedExports(ctx.sink.checker.getExportsOfModule(symbol));
}

export function walkModule(
  sink: Sink,
  container: SourceFile | ModuleDeclaration,
  scope?: string,
): void {
  const ctx: Ctx = { sink, root: '' };
  for (const [name, decls] of moduleExports(ctx, container)) {
    const nominal = name === 'default' || name === ts.InternalSymbolName.ExportEquals;
    const bare = nominal ? defaultExportPath(decls) : P.topLevel(name);
    const root = scope === undefined ? bare : P.scoped(scope, bare);
    const set = sink.rootDecls.get(root) ?? new Set<ts.Node>();
    for (const d of decls) set.add(d.compilerNode);
    sink.rootDecls.set(root, set);
    const ctxRoot: Ctx = { sink, root };
    if (name === ts.InternalSymbolName.ExportEquals) ctxRoot.exportEquals = true;
    walkNamed(ctxRoot, root, decls);
  }
}

/** `declare module 'pkg'` -> ".", `declare module 'pkg/sub'` -> "./sub"; undefined for foreign modules. */
export function ownEntryOf(moduleName: string, packageName: string): string | undefined {
  if (moduleName === packageName) return '.';
  if (moduleName.startsWith(`${packageName}/`))
    return `./${moduleName.slice(packageName.length + 1)}`;
  return undefined;
}

export function ambientModuleName(mod: ModuleDeclaration): string | undefined {
  if (mod.getDeclarationKind() !== 'module') return undefined;
  const name = mod.getName();
  return /^['"]/.test(name) ? name.slice(1, -1) : undefined;
}
