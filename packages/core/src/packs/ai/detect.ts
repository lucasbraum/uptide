import {
  type CallExpression,
  type NewExpression,
  Node,
  type ObjectLiteralElementLike,
  Project,
  type SourceFile,
  SyntaxKind,
} from 'ts-morph';
import type { Finding } from '../../domain/report.js';
import { onReset } from '../../shared-state.js';
import type { SourceSite } from '../contract.js';
import type { TransformResult } from '../types.js';

/**
 * Where the AI SDK 7 renames apply: the options object of a call to a function imported from
 * `ai`, by its exported name, and of the stream-result helpers, which no other library
 * names this way. Text alone cannot tell `system:` in a `generateText` call from `system:`
 * anywhere else; the import can.
 */
const parsed = new Map<string, SourceFile>();
onReset(() => parsed.clear());
function parse(text: string): SourceFile {
  let source = parsed.get(text);
  if (!source) {
    source = new Project({ useInMemoryFileSystem: true }).createSourceFile('consumer.tsx', text);
    if (parsed.size >= 16) parsed.delete(parsed.keys().next().value as string);
    parsed.set(text, source);
  }
  return source;
}

/** Local names bound to `ai` exports: local → exported. */
function imports(source: SourceFile): Map<string, string> {
  const names = new Map<string, string>();
  for (const declaration of source.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== 'ai') continue;
    for (const specifier of declaration.getNamedImports())
      names.set(specifier.getAliasNode()?.getText() ?? specifier.getName(), specifier.getName());
  }
  return names;
}

/** Methods of a streamText result that take UI message stream options. */
const RESULT_METHODS = new Set([
  'toUIMessageStream',
  'toUIMessageStreamResponse',
  'pipeUIMessageStreamToResponse',
]);

/** The options object of each call to one of `callees` (exported names), with its callee. */
function optionObjects(
  source: SourceFile,
  callees: ReadonlySet<string>,
): { callee: string; options: ObjectLiteralElementLike[] }[] {
  const names = imports(source);
  const found: { callee: string; options: ObjectLiteralElementLike[] }[] = [];
  const visit = (call: CallExpression | NewExpression) => {
    const expression = call.getExpression();
    let callee: string | undefined;
    if (Node.isIdentifier(expression)) callee = names.get(expression.getText());
    else if (
      Node.isPropertyAccessExpression(expression) &&
      RESULT_METHODS.has(expression.getName())
    )
      callee = expression.getName();
    if (!callee || !callees.has(callee)) return;
    const argument = call.getArguments()[0];
    if (argument && Node.isObjectLiteralExpression(argument))
      found.push({ callee, options: argument.getProperties() });
  };
  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) visit(call);
  for (const call of source.getDescendantsOfKind(SyntaxKind.NewExpression)) visit(call);
  return found;
}

function keyOf(property: ObjectLiteralElementLike): Node | undefined {
  if (
    Node.isPropertyAssignment(property) ||
    Node.isShorthandPropertyAssignment(property) ||
    Node.isMethodDeclaration(property)
  ) {
    const name = property.getNameNode();
    return Node.isIdentifier(name) || Node.isStringLiteral(name) ? name : undefined;
  }
  return undefined;
}

function site(source: SourceFile, node: Node): SourceSite {
  const { line, column } = source.getLineAndColumnAtPos(node.getStart());
  return {
    line,
    column,
    snippet: (source.getFullText().split('\n')[line - 1] ?? '').trim(),
    name: node.getText().replace(/['"]/g, ''),
  };
}

/** Sites of the option `key` in calls to `callees`. */
export function optionSites(text: string, key: string, callees: ReadonlySet<string>): SourceSite[] {
  if (!text.includes(key)) return [];
  const source = parse(text);
  return optionObjects(source, callees).flatMap(({ options }) =>
    options
      .map(keyOf)
      .filter((k): k is Node => k !== undefined && k.getText().replace(/['"]/g, '') === key)
      .map((k) => site(source, k)),
  );
}

/** The option key at the reported site renamed: `system:` → `instructions:`, `{ system }` → `{ instructions: system }`. */
export function renameOption(
  text: string,
  finding: Pick<Finding, 'usage'>,
  key: string,
  to: string,
  callees: ReadonlySet<string>,
): TransformResult {
  const source = parse(text);
  for (const { options } of optionObjects(source, callees))
    for (const property of options) {
      const name = keyOf(property);
      if (!name || name.getText().replace(/['"]/g, '') !== key) continue;
      const at = site(source, name);
      if (at.line !== finding.usage.line || at.column !== finding.usage.column) continue;
      const replacement = Node.isShorthandPropertyAssignment(property) ? `${to}: ${key}` : to;
      return {
        text: `${text.slice(0, name.getStart())}${replacement}${text.slice(name.getEnd())}`,
        applied: true,
        reason: `\`${key}\` is \`${to}\` in AI SDK 7`,
      };
    }
  return { text, applied: false, reason: `the reported site is not the \`${key}\` option` };
}

/** `stepCountIs` imported from `ai`: the import and every reference to the local name. */
export function importSites(text: string, exported: string): SourceSite[] {
  if (!text.includes(exported)) return [];
  const source = parse(text);
  const sites: SourceSite[] = [];
  for (const declaration of source.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== 'ai') continue;
    for (const specifier of declaration.getNamedImports()) {
      if (specifier.getName() !== exported) continue;
      sites.push(site(source, specifier.getNameNode()));
      // Aliased (`stepCountIs as stop`): the local keeps its name, only the import changes.
      if (specifier.getAliasNode()) continue;
      const local = specifier.getNameNode();
      if (!Node.isIdentifier(local)) continue;
      for (const reference of local.findReferencesAsNodes())
        if (
          reference.getSourceFile() === source &&
          !reference.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)
        )
          sites.push(site(source, reference));
    }
  }
  return sites.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Whether the file declares `name` anywhere (a variable, parameter, function, class or import),
 * other than as a binding taken from a `streamText(...)` result: that one is what renaming
 * `fullStream` to `stream` writes, so it never collides with the rename itself.
 */
export function declaresName(text: string, name: string): boolean {
  if (!text.includes(name)) return false;
  const source = parse(text);
  const streamText = [...imports(source)].find(([, exported]) => exported === 'streamText')?.[0];
  return source.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => {
    if (id.getText() !== name) return false;
    const parent = id.getParent();
    if (Node.isBindingElement(parent) && parent.getNameNode() === id) {
      const declaration = parent.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      const init = declaration?.getInitializer();
      const call = init && Node.isAwaitExpression(init) ? init.getExpression() : init;
      return !(
        streamText &&
        call &&
        Node.isCallExpression(call) &&
        call.getExpression().getText() === streamText
      );
    }
    if (Node.isImportClause(parent)) return parent.getDefaultImport() === id;
    return (
      (Node.isVariableDeclaration(parent) ||
        Node.isParameterDeclaration(parent) ||
        Node.isFunctionDeclaration(parent) ||
        Node.isClassDeclaration(parent) ||
        Node.isImportSpecifier(parent) ||
        Node.isNamespaceImport(parent)) &&
      parent.getNameNode() === id
    );
  });
}
