import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { schemaSlices } from './behavior.js';

export interface SchemaGraph {
  entry: string;
  modules: Record<string, { code: string; imports: Record<string, string> }>;
}
/** Resolve declarations, not application modules. Only selected imports enter the child VM. */
export function schemaGraph(
  root: string,
  entry: string,
  name: string,
  originals: Map<string, string>,
): SchemaGraph {
  const modules: SchemaGraph['modules'] = {};
  const requested = new Map<string, Set<string>>();
  const queue: [string, string[]][] = [[entry, [name]]];
  while (queue.length) {
    const [file, names] = queue.shift() as [string, string[]];
    const known = requested.get(file) ?? new Set<string>();
    if (names.every((n) => known.has(n))) continue;
    for (const n of names) known.add(n);
    requested.set(file, known);
    if (requested.size > 100) throw new Error('schema import graph exceeds 100 modules');
    const source = originals.get(file) ?? readFileSync(join(root, file), 'utf8');
    const parsed = new Project({ useInMemoryFileSystem: true }).createSourceFile(
      'module.ts',
      source,
    );
    const code = schemaSlices(source, []).slice([...known]);
    const ast = new Project({ useInMemoryFileSystem: true }).createSourceFile('module.js', code);
    const required = new Set(
      ast
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((c) => c.getExpression().getText() === 'require')
        .map((c) => c.getArguments()[0])
        .filter(Node.isStringLiteral)
        .map((n) => n.getLiteralValue()),
    );
    const imports: Record<string, string> = {};
    for (const imp of parsed.getImportDeclarations()) {
      const spec = imp.getModuleSpecifierValue();
      if (!required.has(spec) || !spec.startsWith('.')) continue;
      const raw = resolve(root, dirname(file), spec);
      const candidates = [
        raw.replace(/\.[cm]?js$/, '.ts'),
        raw.replace(/\.js$/, '.tsx'),
        raw,
        join(raw, 'index.ts'),
      ];
      const found = candidates.find(
        (p) => existsSync(p) && /\.[cm]?tsx?$/.test(p) && !p.endsWith('.d.ts'),
      );
      if (!found) throw new Error(`local schema import not resolved: ${file} → ${spec}`);
      const actual = realpathSync(found);
      if (!actual.startsWith(`${realpathSync(root)}/`))
        throw new Error('schema import escapes repository');
      const target = relative(realpathSync(root), actual);
      imports[spec] = target;
      const wanted = imp
        .getNamedImports()
        .map((n) => n.getName())
        .filter((n) => code.includes(`.${n}`));
      if (imp.getDefaultImport()) wanted.push('default');
      const ns = imp.getNamespaceImport()?.getText();
      if (ns)
        for (const access of parsed.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression))
          if (access.getExpression().getText() === ns) wanted.push(access.getName());
      if (!wanted.length) throw new Error(`side-effect/unsupported schema import skipped: ${spec}`);
      queue.push([target, [...new Set(wanted)]]);
    }
    modules[file] = { code, imports };
  }
  return { entry, modules };
}
