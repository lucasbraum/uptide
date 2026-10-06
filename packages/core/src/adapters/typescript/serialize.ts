import { Node, ts } from 'ts-morph';
import { onReset } from '../../shared-state.js';

/**
 * Turns a declaration into the normalized text compared across versions. The TypeScript
 * printer gives canonical spacing and drops comments; a transformer on top sorts union
 * members (so `A | B` and `B | A` are the same contract) and reduces `import("./x").T`
 * to `T` (so moving a file inside the package is not a change).
 */

const newPrinter = () => ts.createPrinter({ removeComments: true, omitTrailingSemicolon: true });
/**
 * One printer for every print. TypeScript clears its writer only when a print finishes, so a
 * print that throws leaves its partial text in front of the next one: a print that throws
 * replaces the printer, and so does a reset (shared-state.ts).
 */
let printer = newPrinter();
onReset(() => {
  printer = newPrinter();
});

export interface PrintOptions {
  /** A type literal to print as `{…}` because its members are emitted as separate symbols. */
  collapse?: ts.Node;
}

export function normalizeText(text: string): string {
  // The printer ends every type-literal member with `;`, including the last one.
  return text.replace(/\s+/g, ' ').replace(/; }/g, ' }').replace(/;\s*$/, '').trim();
}

function transformer(opts: PrintOptions): ts.TransformerFactory<ts.Node> {
  return (context) => {
    const { factory } = context;
    const visit = (node: ts.Node): ts.Node => {
      if (opts.collapse !== undefined && node === opts.collapse) {
        return factory.createTypeReferenceNode('{…}');
      }
      const visited = ts.visitEachChild(node, visit, context);
      if (ts.isUnionTypeNode(visited)) {
        const sorted = [...visited.types]
          .map((t) => ({
            t,
            key: printer.printNode(ts.EmitHint.Unspecified, t, t.getSourceFile()),
          }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
          .map((x) => x.t);
        return factory.updateUnionTypeNode(visited, factory.createNodeArray(sorted));
      }
      if (ts.isImportTypeNode(visited) && visited.qualifier) {
        return factory.createTypeReferenceNode(visited.qualifier, visited.typeArguments);
      }
      return visited;
    };
    return (root) => visit(root);
  };
}

export function printCompilerNode(node: ts.Node, opts: PrintOptions = {}): string {
  let result: ts.TransformationResult<ts.Node> | undefined;
  try {
    // The transformer prints too (union members are sorted by their text): inside the try.
    result = ts.transform(node, [transformer(opts)]);
    const transformed = result.transformed[0] ?? node;
    return normalizeText(
      printer.printNode(ts.EmitHint.Unspecified, transformed, node.getSourceFile()),
    );
  } catch (err) {
    printer = newPrinter();
    throw err;
  } finally {
    result?.dispose();
  }
}

export function printNode(node: Node, opts: PrintOptions = {}): string {
  return printCompilerNode(node.compilerNode, opts);
}

/** Name-free `(params): Return` form shared by functions, methods, constructors and signatures. */
export function printCallable(node: Node, opts: PrintOptions = {}): string {
  const cn = node.compilerNode as ts.SignatureDeclarationBase;
  const sig = ts.factory.createCallSignature(cn.typeParameters, cn.parameters, cn.type);
  ts.setSourceMapRange(sig, cn);
  // A synthesized node has no source file; print its parts against the original one.
  const result = ts.transform(sig, [transformer(opts)]);
  const text = printer.printNode(
    ts.EmitHint.Unspecified,
    result.transformed[0] ?? sig,
    cn.getSourceFile(),
  );
  result.dispose();
  return normalizeText(text);
}

/**
 * `typeof X` is an indirection to another declaration's type, and `X` may not exist in
 * the other version (zod 3's `const record: typeof ZodRecord.create`). Printing the
 * queried type itself keeps the comparison meaningful. `import('./lib.js').T` is the same
 * indirection across files (stripe's `LatestApiVersion = typeof ApiVersion` re-exported
 * through the namespace): when it resolves to literals, the literals are what a consumer
 * compares against, so they are printed. Everything else stays unexpanded.
 */
export function printTypeNode(typeNode: Node, opts: PrintOptions = {}): string {
  if (Node.isTypeQuery(typeNode)) {
    const text = typeNode.getType().getText(undefined, ts.TypeFormatFlags.NoTruncation);
    if (!text.startsWith('typeof ') && !text.startsWith('import(')) return normalizeText(text);
  }
  if (Node.isImportTypeNode(typeNode)) {
    const text = typeNode.getType().getText(undefined, ts.TypeFormatFlags.NoTruncation);
    if (isLiteralUnion(text)) return normalizeText(text);
  }
  return printNode(typeNode, opts);
}

/** `"a" | "b"`, `42`, `true`: a value a consumer writes, not a structure. */
function isLiteralUnion(text: string): boolean {
  return text
    .split('|')
    .map((part) => part.trim())
    .every((part) =>
      /^("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|-?\d+(\.\d+)?|true|false|null|undefined)$/.test(part),
    );
}
