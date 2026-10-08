import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ts } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { jsxNamespaceCause } from './config-cause.js';

/** A consumer with one JSX file, type-checked against types with and without the global JSX namespace. */
function programs(
  jsx: string,
  extra = '',
): { base: ts.Program; overlay: ts.Program; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'uptide-jsx-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'tsconfig.json'),
    `{\n  "compilerOptions": {\n    "strict": true,\n    "jsx": "${jsx}",${extra}\n    "types": [],\n    "noEmit": true\n  },\n  "include": ["src"]\n}\n`,
  );
  writeFileSync(join(root, 'src', 'App.tsx'), 'export const app = <div />;\n');
  mkdirSync(join(root, 'with'));
  writeFileSync(
    join(root, 'with', 'index.d.ts'),
    'declare global { namespace JSX { interface IntrinsicElements { div: {} } } }\nexport {};\n',
  );
  mkdirSync(join(root, 'without'));
  writeFileSync(join(root, 'without', 'index.d.ts'), 'export {};\n');
  const parsed = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(
    parsed.config,
    ts.sys,
    root,
    undefined,
    join(root, 'tsconfig.json'),
  );
  const program = (types: string): ts.Program =>
    ts.createProgram({
      rootNames: [join(root, 'src', 'App.tsx'), join(root, types, 'index.d.ts')],
      options,
    });
  return { base: program('with'), overlay: program('without'), root };
}

describe('the JSX namespace a compiler option reads', () => {
  it('blames the tsconfig line that sets `jsx` when the target drops the global namespace', () => {
    const { base, overlay, root } = programs('preserve');
    const fresh = overlay.getSemanticDiagnostics(
      overlay.getSourceFile(join(root, 'src', 'App.tsx')),
    );
    expect(fresh.map((d) => d.code)).toEqual([7026]);
    const found = jsxNamespaceCause({ overlay, base }, fresh, root, ['@types/react']);
    expect(found?.cause).toMatchObject({
      name: 'jsx',
      file: 'tsconfig.json',
      line: 4,
      config: true,
    });
    expect(found?.cause.reason).toContain('"jsx": "preserve"');
    expect(found?.cause.reason).toContain('@types/react no longer declares');
    expect(found?.explains(fresh[0] as ts.Diagnostic)).toBe(true);
    expect(found?.explains({ code: 2322 } as ts.Diagnostic)).toBe(false);
  });

  it('is no cause when the namespace is still there, or when the option is the react-jsx runtime', () => {
    const { base, overlay, root } = programs('preserve');
    const app = join(root, 'src', 'App.tsx');
    // Nothing new: the base program has the namespace, and so does this "overlay".
    expect(
      jsxNamespaceCause(
        { overlay: base, base },
        base.getSemanticDiagnostics(base.getSourceFile(app)),
        root,
        ['x'],
      ),
    ).toBeUndefined();
    const explicit = programs('preserve', '\n    "jsxImportSource": "react",');
    const diagnostics = explicit.overlay.getSemanticDiagnostics(
      explicit.overlay.getSourceFile(join(explicit.root, 'src', 'App.tsx')),
    );
    // With an import source the namespace comes from the runtime module: another cause entirely.
    expect(
      jsxNamespaceCause(
        { overlay: explicit.overlay, base: explicit.base },
        diagnostics,
        explicit.root,
        ['x'],
      ),
    ).toBeUndefined();
    // Nothing that says the namespace is missing: nothing to anchor.
    expect(
      jsxNamespaceCause({ overlay, base }, [{ code: 2322 } as ts.Diagnostic], root, ['x']),
    ).toBeUndefined();
  });
});
