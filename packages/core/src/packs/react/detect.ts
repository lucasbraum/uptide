import { type ArrowFunction, Node, Project, type SourceFile, SyntaxKind } from 'ts-morph';
import type { Finding } from '../../domain/report.js';
import { onReset } from '../../shared-state.js';
import type { SourceSite } from '../contract.js';
import type { TransformResult } from '../types.js';

/**
 * Where an implicit return in a ref callback is: `ref={(el) => (inputRef.current = el)}`.
 * React 19 lets a ref callback return a cleanup function, so its types reject any other
 * return value, and an arrow function that assigns returns the assigned value. No type diff
 * reports it (the prop's type is the same), and Text alone cannot tell a `ref` attribute from
 * an object key named `ref`; the syntax tree can.
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

interface RefAssignment {
  attribute: Node;
  arrow: ArrowFunction;
  /** The assignment the arrow returns, without the parentheses around it. */
  assignment: Node;
}

/** `ref={(el) => (x = el)}`: a `ref` attribute whose arrow function returns an assignment. */
function refAssignments(source: SourceFile): RefAssignment[] {
  const found: RefAssignment[] = [];
  for (const attribute of source.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    if (attribute.getNameNode().getText() !== 'ref') continue;
    const initializer = attribute.getInitializer();
    if (!initializer || !Node.isJsxExpression(initializer)) continue;
    const arrow = initializer.getExpression();
    if (!arrow || !Node.isArrowFunction(arrow)) continue;
    let body: Node = arrow.getBody();
    while (Node.isParenthesizedExpression(body)) body = body.getExpression();
    if (
      Node.isBinaryExpression(body) &&
      body.getOperatorToken().getKind() === SyntaxKind.EqualsToken
    )
      found.push({ attribute, arrow, assignment: body });
  }
  return found;
}

export function refCallbackReturnSites(text: string): SourceSite[] {
  if (!text.includes('ref')) return [];
  const source = parse(text);
  return refAssignments(source).map(({ attribute }) => {
    const { line, column } = source.getLineAndColumnAtPos(attribute.getStart());
    return {
      line,
      column,
      snippet: (text.split('\n')[line - 1] ?? '').trim(),
      name: 'ref',
    };
  });
}

/** `(el) => (x = el)` becomes `(el) => { x = el; }`: the same assignment, nothing returned. */
export function dropRefCallbackReturn(
  text: string,
  finding: Pick<Finding, 'usage'>,
): TransformResult {
  const source = parse(text);
  for (const { attribute, arrow, assignment } of refAssignments(source)) {
    const at = source.getLineAndColumnAtPos(attribute.getStart());
    if (at.line !== finding.usage.line || at.column !== finding.usage.column) continue;
    const body = arrow.getBody();
    return {
      text: `${text.slice(0, body.getStart())}{ ${assignment.getText()}; }${text.slice(body.getEnd())}`,
      applied: true,
      reason: 'a ref callback returns nothing: the assignment becomes a statement',
    };
  }
  return { text, applied: false, reason: 'the reported site is not a ref callback that assigns' };
}
