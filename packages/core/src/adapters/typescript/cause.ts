import { relative } from 'node:path';
import { ts } from 'ts-morph';
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
}

function deepestAt(root: ts.Node, position: number): ts.Node {
  let node: ts.Node = root;
  for (;;) {
    let next: ts.Node | undefined;
    ts.forEachChild(node, (child) => {
      if (!next && child.getStart() <= position && position < child.getEnd()) next = child;
    });
    if (!next) return node;
    node = next;
  }
}

/** The expression whose type the diagnostic complains about: the identifier or access at the position. */
function offendingExpression(node: ts.Node): ts.Expression | undefined {
  let n: ts.Node | undefined = node;
  while (n && !ts.isExpression(n)) n = n.parent;
  if (!n) return undefined;
  while (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) n = n.parent;
  return n as ts.Expression;
}

/** The same declaration in the other program, by file and position. */
function counterpart(decl: ts.Node, program: ts.Program): ts.Node | undefined {
  const file = program.getSourceFile(decl.getSourceFile().fileName);
  if (!file) return undefined;
  let node: ts.Node | undefined = deepestAt(file, decl.getStart());
  while (node && node.kind !== decl.kind) node = node.parent;
  return node;
}

function typeText(decl: ts.Node, program: ts.Program): string | undefined {
  const named = ts.getNameOfDeclaration(decl as ts.Declaration);
  const at = named ?? decl;
  const checker = program.getTypeChecker();
  try {
    // The installed and target copies live in different directories; `import("…")` prefixes must not count as a change.
    return (
      checker
        .typeToString(checker.getTypeAtLocation(at), undefined, ts.TypeFormatFlags.NoTruncation)
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
  if (diagnostic.start === undefined) return undefined;
  if (!/\b(unknown|any)\b/.test(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')))
    return undefined;
  const checker = programs.overlay.getTypeChecker();
  const inRepo = (n: ts.Node): boolean => {
    const f = n.getSourceFile().fileName;
    return f.startsWith(`${repoDir}/`) && !f.includes('/node_modules/');
  };
  const declarationOf = (expr: ts.Node): ts.Declaration | undefined => {
    const symbol = checker.getSymbolAtLocation(expr);
    const target =
      symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return target?.declarations?.[0];
  };
  const lineOf = (n: ts.Node): string => {
    const f = n.getSourceFile();
    const named = ts.getNameOfDeclaration(n as ts.Declaration);
    return `${relative(repoDir, f.fileName)}:${f.getLineAndCharacterOfPosition((named ?? n).getStart()).line + 1}`;
  };
  const site = `${relative(repoDir, file.fileName)}:${file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
  /** Blame a repo declaration only for a change of its own. The site itself is never its own cause. */
  const judge = (decl: ts.Node): DiagnosticCause | undefined => {
    const at = lineOf(decl);
    if (at === site) return undefined;
    if (erroredLines.has(at))
      return causeAt(decl, 'which itself fails to compile against the target', repoDir);
    const before = counterpart(decl, programs.base);
    const after = typeText(decl, programs.overlay);
    const earlier = before ? typeText(before, programs.base) : undefined;
    if (after !== undefined && earlier !== undefined && after !== earlier) {
      return causeAt(
        decl,
        `whose type changed from \`${clip(earlier)}\` to \`${clip(after)}\``,
        repoDir,
      );
    }
    return undefined;
  };
  const isAny = (n: ts.Node): boolean =>
    (checker.getTypeAtLocation(n).flags & ts.TypeFlags.Any) !== 0;
  /** An `any` value's origin: the import or repo declaration it came from. */
  const origin = (start: ts.Node): DiagnosticCause | undefined => {
    let n: ts.Node | undefined = start;
    for (let hop = 0; n && hop < MAX_HOPS; hop++) {
      if (ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n) || ts.isAsExpression(n)) {
        n = n.expression;
        continue;
      }
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        n = ts.isPropertyAccessExpression(n.expression) ? n.expression.expression : n.expression;
        continue;
      }
      if (ts.isPropertyAccessExpression(n)) {
        n = n.expression;
        continue;
      }
      if (!ts.isIdentifier(n)) return undefined;
      const symbol = checker.getSymbolAtLocation(n);
      const decl = symbol?.declarations?.[0];
      if (!decl || !inRepo(decl)) return undefined;
      if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) {
        const importDecl = decl.getSourceFile() && findImportDeclaration(decl);
        const from = importDecl
          ? importDecl.moduleSpecifier.getText().replace(/['"]/g, '')
          : 'an import';
        return causeAt(
          decl,
          `imported from \`${from}\`, which is typed \`any\` against the target`,
          repoDir,
        );
      }
      const judged = judge(decl);
      if (judged) return judged;
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        n = decl.initializer;
        continue;
      }
      return undefined;
    }
    return undefined;
  };

  let expr: ts.Node | undefined = offendingExpression(deepestAt(file, diagnostic.start));
  for (let hop = 0; expr && hop < MAX_HOPS; hop++) {
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAwaitExpression(expr) ||
      ts.isAsExpression(expr)
    ) {
      expr = expr.expression;
      continue;
    }
    if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) {
      const call = expr;
      const callee = call.expression;
      const target = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
      const decl = declarationOf(target);
      if (decl && inRepo(decl)) {
        const judged = judge(decl);
        if (judged) return judged;
        // The callee is unchanged and compiles: the fault came in through an argument.
        const anyArg = (call.arguments ?? []).find((a) => isAny(a));
        if (anyArg) return origin(anyArg);
        expr = returnedExpression(decl);
        continue;
      }
      // A package callee (`schema.safeParse`): the receiver carries the type that changed.
      expr = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined;
      continue;
    }
    if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
      const target = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
      const decl = declarationOf(target);
      if (!decl || !inRepo(decl)) {
        if (ts.isPropertyAccessExpression(expr)) {
          expr = expr.expression;
          continue;
        }
        if (ts.isIdentifier(expr) && isAny(expr)) return origin(expr);
        return undefined;
      }
      if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) {
        return isAny(expr) ? origin(expr) : undefined;
      }
      const judged = judge(decl);
      if (judged) return judged;
      if (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) {
        expr = decl.initializer;
        continue;
      }
      if (ts.isParameter(decl)) {
        const fn = decl.parent;
        // A callback's parameter is typed by whatever the callback was passed to; look there first.
        if (ts.isCallExpression(fn.parent)) {
          expr = fn.parent;
          continue;
        }
        return judge(fn);
      }
      if (
        (ts.isPropertySignature(decl) || ts.isPropertyAssignment(decl)) &&
        ts.isPropertyAccessExpression(expr)
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

function findImportDeclaration(node: ts.Node): ts.ImportDeclaration | undefined {
  let n: ts.Node | undefined = node;
  while (n && !ts.isImportDeclaration(n)) n = n.parent;
  return n;
}

function returnedExpression(decl: ts.Declaration): ts.Expression | undefined {
  let body: ts.Node | undefined;
  if (ts.isVariableDeclaration(decl) && decl.initializer) body = decl.initializer;
  else if (ts.isFunctionLike(decl) && 'body' in decl) body = (decl as { body?: ts.Node }).body;
  if (!body) return undefined;
  if (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) body = body.body;
  if (body && ts.isExpression(body)) return body;
  let returned: ts.Expression | undefined;
  const visit = (n: ts.Node): void => {
    if (returned) return;
    if (ts.isReturnStatement(n) && n.expression) returned = n.expression;
    else if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
  };
  if (body) ts.forEachChild(body, visit);
  return returned;
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ');
  return one.length > 80 ? `${one.slice(0, 77)}...` : one;
}

function causeAt(decl: ts.Node, reason: string, repoDir: string): DiagnosticCause {
  const file = decl.getSourceFile();
  let holder: ts.Node = decl;
  let named = ts.getNameOfDeclaration(decl as ts.Declaration);
  while (!named && holder.parent && !ts.isSourceFile(holder.parent)) {
    holder = holder.parent;
    if (ts.isBlock(holder) || ts.isCallExpression(holder)) break;
    named = ts.getNameOfDeclaration(holder as ts.Declaration);
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
): DiagnosticCause | undefined {
  if (diagnostic.start === undefined || !MISMATCH_CODES.has(diagnostic.code)) return undefined;
  const checker = programs.overlay.getTypeChecker();
  const inRepo = (n: ts.Node): boolean => {
    const f = n.getSourceFile().fileName;
    return f.startsWith(`${repoDir}/`) && !f.includes('/node_modules/');
  };
  const node = deepestAt(file, diagnostic.start);
  let decl: ts.Declaration | undefined;
  // An argument of a call: the parameter it lands on, through the resolved signature.
  for (let n: ts.Node | undefined = node; n && !ts.isStatement(n); n = n.parent) {
    const parent: ts.Node | undefined = n.parent;
    if (parent && (ts.isCallExpression(parent) || ts.isNewExpression(parent))) {
      // The callee of an inner call (`use(boxed())` reported at `boxed`): keep climbing.
      const index = parent.arguments?.indexOf(n as ts.Expression) ?? -1;
      if (index < 0) continue;
      const signature = checker.getResolvedSignature(parent);
      const parameters = signature?.parameters ?? [];
      const parameter = parameters[Math.min(index, parameters.length - 1)];
      decl = parameter?.valueDeclaration;
      break;
    }
    if (parent && ts.isJsxAttribute(parent) && parent.initializer === n) {
      const symbol = checker.getSymbolAtLocation(parent.name);
      decl = symbol?.declarations?.[0];
      break;
    }
  }
  if (!decl || !inRepo(decl)) return undefined;
  if (!ts.isParameter(decl) && !ts.isPropertySignature(decl) && !ts.isPropertyDeclaration(decl))
    return undefined;
  const typeNode = decl.type;
  if (!typeNode || !namesForeignType(typeNode, checker, inRepo)) return undefined;
  const site = `${relative(repoDir, file.fileName)}:${file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
  const at = decl.getSourceFile();
  const declLine = `${relative(repoDir, at.fileName)}:${at.getLineAndCharacterOfPosition(decl.getStart()).line + 1}`;
  if (declLine === site) return undefined;
  const what = ts.isParameter(decl) ? 'parameter' : 'prop';
  const name = ts.getNameOfDeclaration(decl)?.getText() ?? '(anonymous)';
  const cause = causeAt(
    decl,
    `whose ${what} \`${name}: ${clip(typeNode.getText())}\` no longer accepts what the target gives it; widen the ${what}'s type there`,
    repoDir,
  );
  // The anchor is the parameter itself, not the function that holds it.
  return { ...cause, name, line: cause.line, anchorOnly: true };
}

/** Whether a type annotation refers to a type declared outside the repository. */
function namesForeignType(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  inRepo: (n: ts.Node) => boolean,
): boolean {
  let foreign = false;
  const visit = (n: ts.Node): void => {
    if (foreign) return;
    if (ts.isTypeReferenceNode(n) || ts.isExpressionWithTypeArguments(n)) {
      const name = ts.isTypeReferenceNode(n) ? n.typeName : n.expression;
      const symbol = checker.getSymbolAtLocation(name);
      const target =
        symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      if (target?.declarations?.some((d) => !inRepo(d))) foreign = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(typeNode);
  return foreign;
}
