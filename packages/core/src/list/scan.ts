import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ts } from 'ts-morph';

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.yarn',
]);
export interface ImportUsage {
  files: string[];
  callSites: number;
  symbols: Record<string, number>;
  workspaces: string[];
}

/** Syntax only: no project, type checker, module resolution, or execution. Counts direct
 * calls/new/JSX through imported bindings; indirect aliases and reflection are not followed. */
export function scanImports(
  root: string,
  names: string[],
  workspaces: string[],
): Map<string, ImportUsage> {
  const result = new Map<string, ImportUsage>();
  const wanted = new Set(names);
  const packageOf = (specifier: string): string | undefined => {
    const name = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
    return name && wanted.has(name) ? name : undefined;
  };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.[cm]?[jt]sx?$/.test(entry.name) || /\.d\.[cm]?ts$/.test(entry.name)) continue;
      const file = relative(root, path).replaceAll('\\', '/');
      const workspace =
        [...workspaces]
          .sort((a, b) => b.length - a.length)
          .find((w) => w !== '.' && file.startsWith(`${w}/`)) ?? '.';
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const bindings = new Map<string, { name: string; symbol: string }>();
      const used = new Set<string>();
      const mark = (name: string): ImportUsage => {
        used.add(name);
        let usage = result.get(name);
        if (!usage) {
          usage = { files: [], callSites: 0, symbols: {}, workspaces: [] };
          result.set(name, usage);
        }
        return usage;
      };
      const bind = (local: string, name: string, symbol: string): void => {
        bindings.set(local, { name, symbol });
        const usage = mark(name);
        usage.symbols[symbol] ??= 0;
      };
      const literalPackage = (node: ts.Node | undefined): string | undefined =>
        node && ts.isStringLiteralLike(node) ? packageOf(node.text) : undefined;
      const visitImports = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          const name = literalPackage(node.moduleSpecifier);
          if (name) {
            mark(name);
            if (ts.isImportDeclaration(node)) {
              const clause = node.importClause;
              if (clause?.name) bind(clause.name.text, name, 'default');
              const named = clause?.namedBindings;
              if (named && ts.isNamespaceImport(named)) bind(named.name.text, name, '*');
              else if (named)
                for (const element of named.elements)
                  bind(element.name.text, name, (element.propertyName ?? element.name).text);
            }
          }
        } else if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference)
        ) {
          const name = literalPackage(node.moduleReference.expression);
          if (name) bind(node.name.text, name, '*');
        } else if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        ) {
          const name = literalPackage(node.arguments[0]);
          if (name) {
            mark(name);
            const parent = ts.isAwaitExpression(node.parent) ? node.parent.parent : node.parent;
            if (ts.isVariableDeclaration(parent)) {
              if (ts.isIdentifier(parent.name)) bind(parent.name.text, name, '*');
              else if (ts.isObjectBindingPattern(parent.name))
                for (const element of parent.name.elements) {
                  if (ts.isIdentifier(element.name))
                    bind(
                      element.name.text,
                      name,
                      element.propertyName?.getText(source) ?? element.name.text,
                    );
                }
            }
          }
        }
        ts.forEachChild(node, visitImports);
      };
      visitImports(source);
      const visitCalls = (node: ts.Node): void => {
        let expr: ts.Node | undefined;
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) expr = node.expression;
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) expr = node.tagName;
        if (expr) {
          const parts: string[] = [];
          while (ts.isPropertyAccessExpression(expr)) {
            parts.unshift(expr.name.text);
            expr = expr.expression;
          }
          if (ts.isIdentifier(expr)) {
            const binding = bindings.get(expr.text);
            if (binding) {
              const symbol =
                [binding.symbol === '*' ? '' : binding.symbol, ...parts]
                  .filter(Boolean)
                  .join('.') || 'default';
              const usage = mark(binding.name);
              usage.callSites++;
              usage.symbols[symbol] = (usage.symbols[symbol] ?? 0) + 1;
            }
          }
        }
        ts.forEachChild(node, visitCalls);
      };
      visitCalls(source);
      for (const name of used) {
        const usage = result.get(name) as ImportUsage;
        usage.files.push(file);
        if (!usage.workspaces.includes(workspace)) usage.workspaces.push(workspace);
      }
    }
  };
  walk(resolve(root));
  return result;
}
