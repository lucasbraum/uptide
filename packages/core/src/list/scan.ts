import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ts } from 'ts-morph';
import { scanConfig, type TaskCommands } from './config.js';
import { isConfig } from './evidence.js';

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
  references: number;
  symbols: Record<string, number>;
  workspaces: string[];
}

export interface ScanStats {
  sourceMs: number;
  configMs: number;
  visitedFiles: number;
  sourceFiles: number;
  configFiles: number;
  assetFiles: number;
}
/** Syntax only: no project, type checker, module resolution, or execution. Counts direct
 * calls/new/JSX and value/type references through imported bindings; indirect aliases and reflection are not followed. */
export function scanImports(
  root: string,
  names: string[],
  workspaces: string[],
  configs?: string[],
  evidence?: Map<string, string[]>,
  stats?: ScanStats,
  tasks?: TaskCommands[],
): Map<string, ImportUsage> {
  const start = performance.now();
  const counts: ScanStats = {
    sourceMs: 0,
    configMs: 0,
    visitedFiles: 0,
    sourceFiles: 0,
    configFiles: 0,
    assetFiles: 0,
  };
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
      const file = relative(root, path).replaceAll('\\', '/');
      counts.visitedFiles++;
      if (isConfig(file)) {
        const started = performance.now();
        configs?.push(scanConfig(file, readFileSync(path, 'utf8'), names, evidence, tasks));
        counts.configFiles++;
        counts.configMs += performance.now() - started;
        continue;
      }
      if (/\.(?:scss|sass|less|css|html?)$/i.test(entry.name)) {
        counts.assetFiles++;
        const text = readFileSync(path, 'utf8');
        const add = (specifier: string, reason: string): void => {
          const clean = specifier.replace(/^~/, '').replace(/^(?:\.\.?\/|\/)*node_modules\//, '');
          const name = packageOf(clean);
          if (name) {
            const reasons = evidence?.get(name) ?? [];
            if (!reasons.includes(reason)) reasons.push(reason);
            evidence?.set(name, reasons);
          }
        };
        if (/\.html?$/i.test(entry.name)) {
          const html = text.replace(/<!--[\s\S]*?-->/g, '');
          for (const tag of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
            const attr = tag[1]?.toLowerCase() === 'script' ? 'src' : 'href';
            const value = tag[0].match(
              new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\\s>]+))`, 'i'),
            );
            const url = value?.[1] ?? value?.[2] ?? value?.[3];
            if (url && /^(?:\.\.?\/|\/)*node_modules\//.test(url))
              add(url, 'referenced by HTML assets');
          }
        } else {
          const styles = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
          for (const rule of styles.matchAll(/@(import|use|forward)\s+([^;\n]+)/gi)) {
            const specifiers = (rule[2] ?? '').matchAll(
              /(?:^|,)\s*(?:\([^)]*\)\s*)?(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)"']+))\s*\)|"([^"]+)"|'([^']+)')/g,
            );
            for (const value of specifiers) {
              add(value.slice(1).find(Boolean) ?? '', 'referenced by stylesheet imports');
              if (rule[1]?.toLowerCase() !== 'import') break;
            }
          }
        }
        continue;
      }
      if (!/\.[cm]?[jt]sx?$/.test(entry.name) || /\.d\.[cm]?ts$/.test(entry.name)) continue;
      counts.sourceFiles++;
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
      type Binding = { name: string; symbol: string };
      const scopes = new Map<ts.Node, Map<string, Binding | undefined>>();
      const isScope = (node: ts.Node): boolean =>
        ts.isSourceFile(node) ||
        ts.isBlock(node) ||
        ts.isFunctionLike(node) ||
        ts.isCatchClause(node) ||
        ts.isForStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isForInStatement(node);
      const scopeOf = (node: ts.Node): ts.Node => {
        let scope = node.parent;
        while (scope && !isScope(scope)) scope = scope.parent;
        // var declarations belong to the nearest function, not a nested block.
        if (
          ts.isVariableDeclaration(node) &&
          ts.isVariableDeclarationList(node.parent) &&
          !(node.parent.flags & ts.NodeFlags.BlockScoped)
        ) {
          while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope))
            scope = scope.parent;
        }
        return scope ?? source;
      };
      const declare = (name: ts.BindingName, scope: ts.Node): void => {
        if (ts.isIdentifier(name)) {
          const locals = scopes.get(scope) ?? new Map<string, Binding | undefined>();
          locals.set(name.text, undefined);
          scopes.set(scope, locals);
        } else
          for (const element of name.elements)
            if (ts.isBindingElement(element)) declare(element.name, scope);
      };
      const declarations = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) || ts.isParameter(node))
          declare(node.name, scopeOf(node));
        if (
          (ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isEnumDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isInterfaceDeclaration(node)) &&
          node.name
        )
          declare(node.name, scopeOf(node));
        if (ts.isFunctionExpression(node) && node.name) declare(node.name, node);
        ts.forEachChild(node, declarations);
      };
      declarations(source);
      const lookup = (node: ts.Identifier): Binding | undefined => {
        for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
          const locals = scopes.get(scope);
          if (locals?.has(node.text)) return locals.get(node.text);
        }
        return undefined;
      };
      const used = new Set<string>();
      const mark = (name: string): ImportUsage => {
        used.add(name);
        let usage = result.get(name);
        if (!usage) {
          usage = { files: [], callSites: 0, references: 0, symbols: {}, workspaces: [] };
          result.set(name, usage);
        }
        return usage;
      };
      const bind = (local: string, name: string, symbol: string, declaration: ts.Node): void => {
        const scope = scopeOf(declaration);
        const locals = scopes.get(scope) ?? new Map<string, Binding | undefined>();
        locals.set(local, { name, symbol });
        scopes.set(scope, locals);
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
              if (clause?.name) bind(clause.name.text, name, 'default', node);
              const named = clause?.namedBindings;
              if (named && ts.isNamespaceImport(named)) bind(named.name.text, name, '*', node);
              else if (named)
                for (const element of named.elements)
                  bind(element.name.text, name, (element.propertyName ?? element.name).text, node);
            }
          }
        } else if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference)
        ) {
          const name = literalPackage(node.moduleReference.expression);
          if (name) bind(node.name.text, name, '*', node);
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
              if (ts.isIdentifier(parent.name)) bind(parent.name.text, name, '*', parent);
              else if (ts.isObjectBindingPattern(parent.name))
                for (const element of parent.name.elements) {
                  if (ts.isIdentifier(element.name))
                    bind(
                      element.name.text,
                      name,
                      element.propertyName?.getText(source) ?? element.name.text,
                      parent,
                    );
                }
            }
          }
        }
        ts.forEachChild(node, visitImports);
      };
      visitImports(source);
      // Visit each root binding once; members and call targets belong to that same use.
      const visitUses = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return;
        if (ts.isIdentifier(node)) {
          const parent = node.parent;
          const isName =
            (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isPropertyAssignment(parent) && parent.name === node) ||
            (ts.isVariableDeclaration(parent) && parent.name === node) ||
            (ts.isParameter(parent) && parent.name === node) ||
            (ts.isBindingElement(parent) &&
              (parent.name === node || parent.propertyName === node)) ||
            (ts.isMethodDeclaration(parent) && parent.name === node) ||
            (ts.isPropertyDeclaration(parent) && parent.name === node) ||
            ((ts.isFunctionDeclaration(parent) ||
              ts.isFunctionExpression(parent) ||
              ts.isClassDeclaration(parent) ||
              ts.isInterfaceDeclaration(parent) ||
              ts.isTypeAliasDeclaration(parent) ||
              ts.isEnumDeclaration(parent)) &&
              parent.name === node) ||
            ts.isJsxClosingElement(parent);
          const binding = !isName && lookup(node);
          if (binding) {
            let expr: ts.Node = node;
            const parts: string[] = [];
            while (ts.isPropertyAccessExpression(expr.parent) && expr.parent.expression === expr) {
              parts.push(expr.parent.name.text);
              expr = expr.parent;
            }
            const context = expr.parent;
            if (ts.isJsxClosingElement(context)) return;
            const call =
              ((ts.isCallExpression(context) || ts.isNewExpression(context)) &&
                context.expression === expr) ||
              ((ts.isJsxOpeningElement(context) || ts.isJsxSelfClosingElement(context)) &&
                context.tagName === expr);
            const symbol =
              [binding.symbol === '*' ? '' : binding.symbol, ...parts].filter(Boolean).join('.') ||
              'default';
            const usage = mark(binding.name);
            if (call) usage.callSites++;
            else usage.references++;
            usage.symbols[symbol] = (usage.symbols[symbol] ?? 0) + 1;
          }
        }
        ts.forEachChild(node, visitUses);
      };
      visitUses(source);
      for (const name of used) {
        const usage = result.get(name) as ImportUsage;
        usage.files.push(file);
        if (!usage.workspaces.includes(workspace)) usage.workspaces.push(workspace);
      }
    }
  };
  walk(resolve(root));
  counts.sourceMs = performance.now() - start - counts.configMs;
  if (stats) Object.assign(stats, counts);
  return result;
}
