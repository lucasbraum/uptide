import { relative } from 'node:path';
import type { ts } from 'ts-morph';
import type { DiagnosticCause } from '../../domain/usage.js';

/**
 * Root cause of an `unknown`/`any` diagnostic. When an upgrade changes what a package
 * type resolves to, one repo declaration built on it starts producing `unknown`, and
 * every consumer of it errors: thirty-one errors with one fix. The expression at the
 * diagnostic is followed to its declaration, then through initializers, callees and
 * receivers. A repo declaration on that chain is blamed only when its own type differs
 * between the installed version and the target, or when it fails to compile itself; a
 * declaration that compiles unchanged is not a cause, whatever flows through it. When the
 * value flowing into such a declaration is `any` (or an error type), that value is traced
 * to its origin, an import or a declaration, and the origin is blamed. Nothing found means
 * the diagnostic stays on its own.
 */

const MAX_HOPS = 8;

interface Programs {
  overlay: ts.Program;
  base: ts.Program;
  /** The compiler both programs were built with: node kinds and flags are its, not the bundled one's. */
  ts: typeof ts;
}

function deepestAt(tsc: typeof ts, root: ts.Node, position: number): ts.Node {
  let node: ts.Node = root;
  for (;;) {
    let next: ts.Node | undefined;
    tsc.forEachChild(node, (child) => {
      if (!next && child.getStart() <= position && position < child.getEnd()) next = child;
    });
    if (!next) return node;
    node = next;
  }
}

/** The expression whose type the diagnostic complains about: the identifier or access at the position. */
function offendingExpression(tsc: typeof ts, node: ts.Node): ts.Expression | undefined {
  let n: ts.Node | undefined = node;
  while (n && !tsc.isExpression(n)) n = n.parent;
  if (!n) return undefined;
  while (tsc.isPropertyAccessExpression(n.parent) && n.parent.name === n) n = n.parent;
  return n as ts.Expression;
}

/** The same declaration in the other program, by file and position. */
function counterpart(tsc: typeof ts, decl: ts.Node, program: ts.Program): ts.Node | undefined {
  const file = program.getSourceFile(decl.getSourceFile().fileName);
  if (!file) return undefined;
  let node: ts.Node | undefined = deepestAt(tsc, file, decl.getStart());
  while (node && node.kind !== decl.kind) node = node.parent;
  return node;
}

function typeText(tsc: typeof ts, decl: ts.Node, program: ts.Program): string | undefined {
  const named = tsc.getNameOfDeclaration(decl as ts.Declaration);
  const at = named ?? decl;
  const checker = program.getTypeChecker();
  try {
    // The installed and target copies live in different directories; `import("…")` prefixes must not count as a change.
    return (
      checker
        .typeToString(checker.getTypeAtLocation(at), undefined, tsc.TypeFormatFlags.NoTruncation)
        .replace(/import\("[^"]*"\)\./g, '')
        // The same type prints as `ParamsDictionary` in one program and `core.ParamsDictionary` in another.
        .replace(/\b[A-Za-z_$][\w$]*\.(?=[A-Z])/g, '')
    );
  } catch {
    return undefined;
  }
}

export function findCause(
  programs: Programs,
  diagnostic: ts.Diagnostic,
  file: ts.SourceFile,
  repoDir: string,
  /** `file:line` of every new diagnostic, so a declaration failing itself is recognised. */
  erroredLines: Set<string>,
): DiagnosticCause | undefined {
  const tsc = programs.ts;
  if (diagnostic.start === undefined) return undefined;
  if (!/\b(unknown|any)\b/.test(tsc.flattenDiagnosticMessageText(diagnostic.messageText, ' ')))
    return undefined;
  const checker = programs.overlay.getTypeChecker();
  const inRepo = (n: ts.Node): boolean => {
    const f = n.getSourceFile().fileName;
    return f.startsWith(`${repoDir}/`) && !f.includes('/node_modules/');
  };
  const declarationOf = (expr: ts.Node): ts.Declaration | undefined => {
    const symbol = checker.getSymbolAtLocation(expr);
    const target =
      symbol && symbol.flags & tsc.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return target?.declarations?.[0];
  };
  const lineOf = (n: ts.Node): string => {
    const f = n.getSourceFile();
    const named = tsc.getNameOfDeclaration(n as ts.Declaration);
    return `${relative(repoDir, f.fileName)}:${f.getLineAndCharacterOfPosition((named ?? n).getStart()).line + 1}`;
  };
  const site = `${relative(repoDir, file.fileName)}:${file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
  /** Blame a repo declaration only for a change of its own. The site itself is never its own cause. */
  const judge = (decl: ts.Node): DiagnosticCause | undefined => {
    const at = lineOf(decl);
    if (at === site) return undefined;
    if (erroredLines.has(at))
      return causeAt(tsc, decl, 'which itself fails to compile against the target', repoDir);
    const before = counterpart(tsc, decl, programs.base);
    const after = typeText(tsc, decl, programs.overlay);
    const earlier = before ? typeText(tsc, before, programs.base) : undefined;
    if (after !== undefined && earlier !== undefined && after !== earlier) {
      return causeAt(
        tsc,
        decl,
        `whose type changed from \`${clip(earlier)}\` to \`${clip(after)}\``,
        repoDir,
      );
    }
    return undefined;
  };
  const isAny = (n: ts.Node): boolean =>
    (checker.getTypeAtLocation(n).flags & tsc.TypeFlags.Any) !== 0;
  /** An `any` value's origin: the import or repo declaration it came from. */
  const origin = (start: ts.Node): DiagnosticCause | undefined => {
    let n: ts.Node | undefined = start;
    for (let hop = 0; n && hop < MAX_HOPS; hop++) {
      if (tsc.isParenthesizedExpression(n) || tsc.isAwaitExpression(n) || tsc.isAsExpression(n)) {
        n = n.expression;
        continue;
      }
      if (tsc.isCallExpression(n) || tsc.isNewExpression(n)) {
        n = tsc.isPropertyAccessExpression(n.expression) ? n.expression.expression : n.expression;
        continue;
      }
      if (tsc.isPropertyAccessExpression(n)) {
        n = n.expression;
        continue;
      }
      if (!tsc.isIdentifier(n)) return undefined;
      const symbol = checker.getSymbolAtLocation(n);
      const decl = symbol?.declarations?.[0];
      if (!decl || !inRepo(decl)) return undefined;
      if (tsc.isImportSpecifier(decl) || tsc.isImportClause(decl) || tsc.isNamespaceImport(decl)) {
        const importDecl = decl.getSourceFile() && findImportDeclaration(tsc, decl);
        const from = importDecl
          ? importDecl.moduleSpecifier.getText().replace(/['"]/g, '')
          : 'an import';
        return causeAt(
          tsc,
          decl,
          `imported from \`${from}\`, which is typed \`any\` against the target`,
          repoDir,
        );
      }
      const judged = judge(decl);
      if (judged) return judged;
      if (tsc.isVariableDeclaration(decl) && decl.initializer) {
        n = decl.initializer;
        continue;
      }
      return undefined;
    }
    return undefined;
  };

  let expr: ts.Node | undefined = offendingExpression(tsc, deepestAt(tsc, file, diagnostic.start));
  for (let hop = 0; expr && hop < MAX_HOPS; hop++) {
    if (
      tsc.isParenthesizedExpression(expr) ||
      tsc.isAwaitExpression(expr) ||
      tsc.isAsExpression(expr)
    ) {
      expr = expr.expression;
      continue;
    }
    if (tsc.isCallExpression(expr) || tsc.isNewExpression(expr)) {
      const call = expr;
      const callee = call.expression;
      const target = tsc.isPropertyAccessExpression(callee) ? callee.name : callee;
      const decl = declarationOf(target);
      if (decl && inRepo(decl)) {
        const judged = judge(decl);
        if (judged) return judged;
        // The callee is unchanged and compiles: the fault came in through an argument.
        const anyArg = (call.arguments ?? []).find((a) => isAny(a));
        if (anyArg) return origin(anyArg);
        expr = returnedExpression(tsc, decl);
        continue;
      }
      // A package callee (`schema.safeParse`): the receiver carries the type that changed.
      expr = tsc.isPropertyAccessExpression(callee) ? callee.expression : undefined;
      continue;
    }
    if (tsc.isIdentifier(expr) || tsc.isPropertyAccessExpression(expr)) {
      const target = tsc.isPropertyAccessExpression(expr) ? expr.name : expr;
      const decl = declarationOf(target);
      if (!decl || !inRepo(decl)) {
        if (tsc.isPropertyAccessExpression(expr)) {
          expr = expr.expression;
          continue;
        }
        if (tsc.isIdentifier(expr) && isAny(expr)) return origin(expr);
        return undefined;
      }
      if (tsc.isImportSpecifier(decl) || tsc.isImportClause(decl) || tsc.isNamespaceImport(decl)) {
        return isAny(expr) ? origin(expr) : undefined;
      }
      const judged = judge(decl);
      if (judged) return judged;
      if (tsc.isVariableDeclaration(decl) || tsc.isPropertyDeclaration(decl)) {
        expr = decl.initializer;
        continue;
      }
      if (tsc.isParameter(decl)) {
        const fn = decl.parent;
        // A callback's parameter is typed by whatever the callback was passed to; look there first.
        if (tsc.isCallExpression(fn.parent)) {
          expr = fn.parent;
          continue;
        }
        return judge(fn);
      }
      if (
        (tsc.isPropertySignature(decl) || tsc.isPropertyAssignment(decl)) &&
        tsc.isPropertyAccessExpression(expr)
      ) {
        expr = expr.expression;
        continue;
      }
      return undefined;
    }
    return undefined;
  }
  return undefined;
}

function findImportDeclaration(tsc: typeof ts, node: ts.Node): ts.ImportDeclaration | undefined {
  let n: ts.Node | undefined = node;
  while (n && !tsc.isImportDeclaration(n)) n = n.parent;
  return n;
}

function returnedExpression(tsc: typeof ts, decl: ts.Declaration): ts.Expression | undefined {
  let body: ts.Node | undefined;
  if (tsc.isVariableDeclaration(decl) && decl.initializer) body = decl.initializer;
  else if (tsc.isFunctionLike(decl) && 'body' in decl) body = (decl as { body?: ts.Node }).body;
  if (!body) return undefined;
  if (tsc.isArrowFunction(body) || tsc.isFunctionExpression(body)) body = body.body;
  if (body && tsc.isExpression(body)) return body;
  let returned: ts.Expression | undefined;
  const visit = (n: ts.Node): void => {
    if (returned) return;
    if (tsc.isReturnStatement(n) && n.expression) returned = n.expression;
    else if (!tsc.isFunctionLike(n)) tsc.forEachChild(n, visit);
  };
  if (body) tsc.forEachChild(body, visit);
  return returned;
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ');
  return one.length > 80 ? `${one.slice(0, 77)}...` : one;
}

function causeAt(tsc: typeof ts, decl: ts.Node, reason: string, repoDir: string): DiagnosticCause {
  const file = decl.getSourceFile();
  let holder: ts.Node = decl;
  let named = tsc.getNameOfDeclaration(decl as ts.Declaration);
  while (!named && holder.parent && !tsc.isSourceFile(holder.parent)) {
    holder = holder.parent;
    if (tsc.isBlock(holder) || tsc.isCallExpression(holder)) break;
    named = tsc.getNameOfDeclaration(holder as ts.Declaration);
  }
  const { line } = file.getLineAndCharacterOfPosition((named ?? decl).getStart());
  return {
    name: named ? named.getText() : '(anonymous)',
    file: relative(repoDir, file.fileName).split('\\').join('/'),
    line: line + 1,
    reason,
  };
}

/** Argument not assignable to parameter; type not assignable (a JSX attribute to its prop). */
const MISMATCH_CODES = new Set([2345, 2322]);

/**
 * A mismatch the compiler reports at an argument whose parameter is a repository declaration:
 * `usePassThroughWheelEvents(ref)` rejected at eleven call sites because the hook's parameter
 * is typed `RefObject<HTMLElement>` and the target's `useRef` now returns
 * `RefObject<HTMLElement | null>`. The one edit is the parameter (or the prop, for a JSX
 * attribute), as the migration guides say; the call sites are evidence. The parameter is
 * blamed only when its declared type names something from outside the repository (a package
 * or library type), and the caller clusters the result: a parameter one site trips is left
 * to that site.
 */
export function parameterCause(
  programs: Programs,
  diagnostic: ts.Diagnostic,
  file: ts.SourceFile,
  repoDir: string,
  /** The repository root: another workspace's source (mapped from `workspace:*`) is the repository's too. */
  rootDir = repoDir,
): DiagnosticCause | undefined {
  const tsc = programs.ts;
  if (diagnostic.start === undefined || !MISMATCH_CODES.has(diagnostic.code)) return undefined;
  const checker = programs.overlay.getTypeChecker();
  const inRepo = (n: ts.Node): boolean => {
    const f = n.getSourceFile().fileName;
    return f.startsWith(`${rootDir}/`) && !f.includes('/node_modules/');
  };
  const node = deepestAt(tsc, file, diagnostic.start);
  let decl: ts.Declaration | undefined;
  // An argument of a call: the parameter it lands on, through the resolved signature.
  for (let n: ts.Node | undefined = node; n && !tsc.isStatement(n); n = n.parent) {
    const parent: ts.Node | undefined = n.parent;
    if (parent && (tsc.isCallExpression(parent) || tsc.isNewExpression(parent))) {
      // The callee of an inner call (`use(boxed())` reported at `boxed`): keep climbing.
      const index = parent.arguments?.indexOf(n as ts.Expression) ?? -1;
      if (index < 0) continue;
      const signature = checker.getResolvedSignature(parent);
      const parameters = signature?.parameters ?? [];
      const parameter = parameters[Math.min(index, parameters.length - 1)];
      decl = parameter?.valueDeclaration;
      break;
    }
    if (parent && tsc.isJsxAttribute(parent) && parent.initializer === n) {
      const symbol = checker.getSymbolAtLocation(parent.name);
      decl = symbol?.declarations?.[0];
      break;
    }
  }
  if (!decl || !inRepo(decl)) return undefined;
  if (!tsc.isParameter(decl) && !tsc.isPropertySignature(decl) && !tsc.isPropertyDeclaration(decl))
    return undefined;
  const typeNode = decl.type;
  if (!typeNode || !namesForeignType(tsc, typeNode, checker, inRepo)) return undefined;
  const site = `${relative(repoDir, file.fileName)}:${file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
  const at = decl.getSourceFile();
  const declLine = `${relative(repoDir, at.fileName)}:${at.getLineAndCharacterOfPosition(decl.getStart()).line + 1}`;
  if (declLine === site) return undefined;
  const what = tsc.isParameter(decl) ? 'parameter' : 'prop';
  const name = tsc.getNameOfDeclaration(decl)?.getText() ?? '(anonymous)';
  const cause = causeAt(
    tsc,
    decl,
    `whose ${what} \`${name}: ${clip(typeNode.getText())}\` no longer accepts what the target gives it; widen the ${what}'s type there`,
    repoDir,
  );
  // The anchor is the parameter itself, not the function that holds it.
  return { ...cause, name, line: cause.line, anchorOnly: true };
}

/** Whether a type annotation refers to a type declared outside the repository. */
function namesForeignType(
  tsc: typeof ts,
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  inRepo: (n: ts.Node) => boolean,
): boolean {
  let foreign = false;
  const visit = (n: ts.Node): void => {
    if (foreign) return;
    if (tsc.isTypeReferenceNode(n) || tsc.isExpressionWithTypeArguments(n)) {
      const name = tsc.isTypeReferenceNode(n) ? n.typeName : n.expression;
      const symbol = checker.getSymbolAtLocation(name);
      const target =
        symbol && symbol.flags & tsc.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      if (target?.declarations?.some((d) => !inRepo(d))) foreign = true;
    }
    tsc.forEachChild(n, visit);
  };
  visit(typeNode);
  return foreign;
}

/** Property missing on a type; property missing with a suggestion. */
const MISSING_MEMBER_CODES = new Set([2339, 2551]);

/**
 * A member the target no longer sees that reaches the installed type through an augmentation
 * the repository takes part in. `declare global { namespace jest { interface Matchers<R> {
 * toMatchPdfSnapshot(): R } } }` in a setup file, read by the installed `expect` and ignored by
 * the target's: every `expect(x).toMatchPdfSnapshot()` then fails with TS2339 or TS2551, and
 * the one edit is the declaration. The member may also come from a package's own types on
 * the same global interface (`jest-image-snapshot` declares `toMatchImageSnapshot` there):
 * then the repository's augmentation of that interface is still where the change goes, since
 * the matchers it registers have to move to the interface the target reads together. The
 * member is resolved in the baseline program, where it still exists; a `declare global` block
 * is anchored at the block, a `declare module "x"` augmentation at the interface inside it,
 * any other repository declaration at itself. One site is enough: the edit is never at the
 * call.
 */
export function augmentationCause(
  programs: Programs,
  diagnostic: ts.Diagnostic,
  file: ts.SourceFile,
  repoDir: string,
  /** The repository root: another workspace's source (mapped from `workspace:*`) is the repository's too. */
  rootDir = repoDir,
): DiagnosticCause | undefined {
  const tsc = programs.ts;
  if (diagnostic.start === undefined || !MISSING_MEMBER_CODES.has(diagnostic.code))
    return undefined;
  const inRepo = (n: ts.Node): boolean => {
    const f = n.getSourceFile().fileName;
    return f.startsWith(`${rootDir}/`) && !f.includes('/node_modules/');
  };
  const name = deepestAt(tsc, file, diagnostic.start);
  if (!tsc.isIdentifier(name) && !tsc.isPrivateIdentifier(name)) return undefined;
  // The baseline still resolves the member; its declaration says where it came from.
  const before = counterpart(tsc, name, programs.base);
  if (!before) return undefined;
  const checker = programs.base.getTypeChecker();
  const member = checker.getSymbolAtLocation(before)?.declarations?.[0];
  if (!member) return undefined;
  let decl: ts.Node | undefined = inRepo(member) ? member : undefined;
  let elsewhere: string | undefined;
  if (!decl) {
    // Declared by a package on an interface the repository augments too: the repository's own
    // augmentation (this workspace's first) is the place.
    const owner = member.parent;
    if (!owner || !tsc.isInterfaceDeclaration(owner)) return undefined;
    const declarations = (checker.getSymbolAtLocation(owner.name)?.declarations ?? []).filter(
      (d) => inRepo(d) && isAugmentation(tsc, d),
    );
    decl =
      declarations.find((d) => d.getSourceFile().fileName.startsWith(`${repoDir}/`)) ??
      declarations[0];
    if (!decl) return undefined;
    elsewhere = packageOf(member.getSourceFile().fileName);
  }
  const site = `${relative(repoDir, file.fileName)}:${file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
  // The declaration's container: the outermost `declare global`, else the interface (or other
  // named declaration) inside a `declare module "x"` block, else the declaration itself.
  let holder: ts.Node | undefined = tsc.isInterfaceDeclaration(decl) ? decl : undefined;
  let global: ts.ModuleDeclaration | undefined;
  let augmented: string | undefined;
  for (let n: ts.Node | undefined = decl.parent; n && !tsc.isSourceFile(n); n = n.parent) {
    if (tsc.isModuleDeclaration(n)) {
      if (n.flags & tsc.NodeFlags.GlobalAugmentation) global = n;
      else if (tsc.isStringLiteral(n.name)) augmented = n.name.text;
    } else if (
      !holder &&
      (tsc.isInterfaceDeclaration(n) || tsc.isTypeAliasDeclaration(n) || tsc.isClassDeclaration(n))
    )
      holder = n;
  }
  const anchor: ts.Node = global ?? holder ?? decl;
  const at = anchor.getSourceFile();
  const line = at.getLineAndCharacterOfPosition(anchor.getStart()).line + 1;
  if (`${relative(repoDir, at.fileName)}:${line}` === site) return undefined;
  const memberName = tsc.getNameOfDeclaration(member)?.getText() ?? name.getText();
  const path = qualifiedName(tsc, decl, holder);
  const declares = elsewhere
    ? `which augments \`${path}\`, the interface \`${memberName}\` is declared on (by ${elsewhere})`
    : `which declares \`${memberName}\` on \`${path}\``;
  const reason = global
    ? `${declares}, a global augmentation the target no longer reads; declare the matchers on the interface the target reads instead`
    : augmented !== undefined
      ? `${declares} in an augmentation of "${augmented}", a shape the target no longer merges; match the target's declaration there`
      : `${declares}, which the target no longer reads at this site`;
  return {
    name: path,
    file: relative(repoDir, at.fileName).split('\\').join('/'),
    line,
    reason,
    anchorOnly: true,
  };
}

/** Whether a declaration sits inside `declare global` or `declare module "x"`. */
function isAugmentation(tsc: typeof ts, decl: ts.Node): boolean {
  for (let n: ts.Node | undefined = decl.parent; n && !tsc.isSourceFile(n); n = n.parent)
    if (
      tsc.isModuleDeclaration(n) &&
      (n.flags & tsc.NodeFlags.GlobalAugmentation || tsc.isStringLiteral(n.name))
    )
      return true;
  return false;
}

/** The package a file under node_modules (or a fixture directory) belongs to, as a short label. */
function packageOf(fileName: string): string {
  const m = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(fileName);
  if (m) return m[1] as string;
  const dir = fileName.split('/').at(-2) ?? fileName;
  return dir.replace(/-v\d+$/, '');
}

/** `jest.Matchers` for a member inside `namespace jest { interface Matchers }`; the holder's name alone otherwise. */
function qualifiedName(tsc: typeof ts, decl: ts.Node, holder: ts.Node | undefined): string {
  const parts: string[] = [];
  const named = holder ? tsc.getNameOfDeclaration(holder as ts.Declaration)?.getText() : undefined;
  if (named) parts.push(named);
  for (
    let n: ts.Node | undefined = (holder ?? decl).parent;
    n && !tsc.isSourceFile(n);
    n = n.parent
  ) {
    if (
      tsc.isModuleDeclaration(n) &&
      tsc.isIdentifier(n.name) &&
      !(n.flags & tsc.NodeFlags.GlobalAugmentation)
    )
      parts.unshift(n.name.text);
  }
  return (
    parts.join('.') ||
    (tsc.getNameOfDeclaration(decl as ts.Declaration)?.getText() ?? '(anonymous)')
  );
}
