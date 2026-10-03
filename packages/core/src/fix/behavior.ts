import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Node, Project, ts } from 'ts-morph';
import { BEHAVIOR_PROBE } from './behavior-probe.js';
import { schemaGraph } from './schema-graph.js';
import type { FixSite } from './types.js';

export interface BehaviorResult {
  file: string;
  schema: string;
  inputs: number;
  identical: number;
  validInputs: number;
  /** Root input shape, including wrappers; single-field objects do not need coverage warnings. */
  schemaKind?: 'object' | 'single-field' | 'enum' | 'literal' | 'other';
  differences: {
    kind: string;
    input: unknown;
    before: unknown;
    after: unknown;
    path?: unknown[];
  }[];
  messageChecks?: {
    site: string;
    path: (string | number)[];
    input: 'missing' | 'wrong-type';
    status: 'identical' | 'different' | 'default' | 'skipped';
    before?: string;
    after?: string;
    reason?: string;
  }[];
  loadedModules?: string[];
  skipped?: string;
}
/** Slice only schema declarations and their local dependencies; never execute route registration. */
export function schemaSlices(source: string, sites: { line: number; column: number }[]) {
  const file = new Project({ useInMemoryFileSystem: true }).createSourceFile('schema.ts', source);
  const declarations = new Map<string, Node>();
  for (const statement of file.getStatements()) {
    if (Node.isVariableStatement(statement))
      for (const d of statement.getDeclarations()) declarations.set(d.getName(), d);
    if (Node.isFunctionDeclaration(statement) && statement.getName())
      declarations.set(statement.getName() as string, statement);
  }
  const paths = new Map<string, (string | number)[][]>();
  const fieldPath = (node: Node, top: Node) => {
    const result: string[] = [];
    for (let n: Node | undefined = node; n && n !== top; n = n.getParent())
      if (
        Node.isPropertyAssignment(n) &&
        !['required_error', 'invalid_type_error', 'message', 'error'].includes(n.getName())
      )
        result.unshift(n.getName().replace(/^['"]|['"]$/g, ''));
    return result;
  };
  for (const site of sites) {
    const pos =
      source
        .split('\n')
        .slice(0, site.line - 1)
        .reduce((n, l) => n + l.length + 1, 0) +
      site.column -
      1;
    const node = file.getDescendantAtPos(Math.min(pos, source.length - 1));
    const owner = node?.getFirstAncestor(
      (n) => Node.isVariableDeclaration(n) && declarations.get(n.getName()) === n,
    );
    if (owner && Node.isVariableDeclaration(owner) && node)
      paths.set(owner.getName(), [...(paths.get(owner.getName()) ?? []), fieldPath(node, owner)]);
  }
  // Carry every touched path through local schema reuse, including multiple dependencies.
  for (let round = 0; round < declarations.size; round++) {
    let added = false;
    for (const [name, node] of declarations) {
      if (!Node.isVariableDeclaration(node)) continue;
      const known = new Map((paths.get(name) ?? []).map((p) => [JSON.stringify(p), p]));
      for (const id of node.getDescendantsOfKind(ts.SyntaxKind.Identifier)) {
        if (id.getText() === name) continue;
        for (const path of paths.get(id.getText()) ?? []) {
          const next = [...fieldPath(id, node), ...path];
          if (next.length > 8) continue;
          const key = JSON.stringify(next);
          if (!known.has(key)) {
            known.set(key, next);
            added = true;
          }
        }
      }
      if (known.size) paths.set(name, [...known.values()]);
    }
    if (!added) break;
  }
  const slice = (selection: string | string[]) => {
    const names = typeof selection === 'string' ? [selection] : selection;
    const aliases = new Map<string, string>();
    for (const e of file.getExportDeclarations()) {
      if (e.getModuleSpecifier()) continue;
      for (const n of e.getNamedExports())
        aliases.set(n.getAliasNode()?.getText() ?? n.getName(), n.getName());
    }
    const needed = new Set<string>();
    const visit = (key: string) => {
      if (needed.has(key)) return;
      needed.add(key);
      const node = declarations.get(key);
      if (!node) return;
      for (const id of node.getDescendantsOfKind(ts.SyntaxKind.Identifier))
        if (declarations.has(id.getText())) visit(id.getText());
    };
    for (const name of names) visit(aliases.get(name) ?? name);
    // Reject executable application helpers even when referenced by a schema initializer.
    // Schema callbacks remain in the slice, but cannot reach application declarations.
    const roots = new Set(
      file
        .getImportDeclarations()
        .flatMap((i) =>
          [
            i.getDefaultImport()?.getText(),
            i.getNamespaceImport()?.getText(),
            ...i.getNamedImports().map((n) => n.getAliasNode()?.getText() ?? n.getName()),
          ].filter(Boolean),
        ),
    );
    for (const key of needed) {
      const node = declarations.get(key);
      if (!node) continue;
      if (!Node.isVariableDeclaration(node)) throw new Error(`application helper skipped: ${key}`);
      const init = node.getInitializer();
      if (!init) continue;
      if (
        init
          .getDescendantsOfKind(ts.SyntaxKind.NewExpression)
          .concat(Node.isNewExpression(init) ? [init] : [])
          .some((n) => !['Date', 'RegExp'].includes(n.getExpression().getText()))
      )
        throw new Error(`application constructor skipped: ${key}`);
      if (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
        throw new Error(`application function skipped: ${key}`);
      for (const call of init
        .getDescendantsOfKind(ts.SyntaxKind.CallExpression)
        .concat(Node.isCallExpression(init) ? [init] : [])) {
        const expression = call.getExpression();
        if (
          Node.isIdentifier(expression) &&
          !['String', 'Number', 'Boolean'].includes(expression.getText())
        )
          throw new Error(`application call skipped: ${expression.getText()}`);
        const root = expression.getText().match(/^[a-zA-Z_$][\w$]*/)?.[0];
        if (
          root &&
          !roots.has(root) &&
          !needed.has(root) &&
          !['Math', 'JSON', 'Object', 'Array'].includes(root)
        ) {
          // Callback arguments may use their own parameters (e.g. text.trim()).
          const callback = call.getFirstAncestorByKind(ts.SyntaxKind.ArrowFunction);
          if (!callback?.getParameters().some((p) => p.getName() === root))
            throw new Error(`application call skipped: ${expression.getText()}`);
        }
      }
    }
    const bodies = [...declarations]
      .filter(([key]) => needed.has(key))
      .map(([, n]) =>
        Node.isVariableDeclaration(n)
          ? `const ${n.getText()};`
          : n.getText().replace(/^export\s+/, ''),
      );
    const code =
      file
        .getImportDeclarations()
        .map((n) => n.getText())
        .join('\n') +
      '\n' +
      bodies.join('\n') +
      names
        .map((name) => `\nexports[${JSON.stringify(name)}]=${aliases.get(name) ?? name};`)
        .join('');
    // Transpile drops type-only imports and imports unused by this schema slice.
    return ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;
  };
  return { paths, slice };
}
export function behaviorCheck(
  root: string,
  originals: Map<string, string>,
  sites: FixSite[],
): BehaviorResult[] {
  const results: BehaviorResult[] = [];
  for (const [file, before] of originals) {
    const locations = sites
      .filter((s) => s.finding.usage.file === file)
      .map((s) => s.finding.usage);
    const old = schemaSlices(before, locations);

    if (!old.paths.size) {
      results.push({
        file,
        schema: '(reported site)',
        inputs: 0,
        identical: 0,
        validInputs: 0,
        differences: [],
        skipped: 'site is not a top-level schema binding; no application code executed',
      });
      continue;
    }
    for (const [name, paths] of old.paths) {
      const temp = mkdtempSync(join(tmpdir(), 'uptide-behavior-'));
      try {
        writeFileSync(join(temp, 'probe.mjs'), BEHAVIOR_PROBE);
        writeFileSync(
          join(temp, 'input.json'),
          JSON.stringify({
            before: schemaGraph(root, file, name, originals),
            after: schemaGraph(root, file, name, new Map()),
            name,
            paths,
            sites: locations
              .map((loc) => ({
                site: `${file}:${loc.line}:${loc.column}`,
                paths: schemaSlices(before, [loc]).paths.get(name) ?? [],
              }))
              .filter((s) => s.paths.length),
            resolveFrom: join(root, file),
          }),
        );
        const out = execFileSync(
          process.execPath,
          [
            Number(process.versions.node.split('.')[0]) >= 23
              ? '--permission'
              : '--experimental-permission',
            '--allow-fs-read=*',
            '--no-warnings',
            join(temp, 'probe.mjs'),
            join(temp, 'input.json'),
          ],
          {
            timeout: 15000,
            maxBuffer: 1024 * 1024,
            encoding: 'utf8',
            env: { PATH: process.env.PATH ?? '', HOME: temp, TZ: 'UTC' },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        results.push({ file, schema: name, ...JSON.parse(out.trim().split('\n').at(-1) ?? '{}') });
      } catch (e) {
        results.push({
          file,
          schema: name,
          inputs: 0,
          identical: 0,
          validInputs: 0,
          differences: [],
          skipped: e instanceof Error ? e.message.slice(0, 300) : String(e),
        });
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }
  }
  return results;
}
