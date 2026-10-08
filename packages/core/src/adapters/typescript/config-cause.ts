import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ts } from 'ts-morph';
import type { DiagnosticCause } from '../../domain/usage.js';

/**
 * A root cause that is a compiler option, not a declaration. `@types/react` 19 no longer
 * declares the global `JSX` namespace: a workspace whose `jsx` is `preserve` or `react` (and
 * names no `jsxImportSource`) reads JSX element types from that namespace, so every element
 * in every file errors (TS7026, TS2602) with one fix, in the tsconfig. Those diagnostics are
 * anchored there, as evidence of the one change; a `JSX.Element` written in code is still a
 * site of its own.
 */

/** JSX element types came from the global namespace, and it is gone. */
const JSX_NAMESPACE_CODES = new Set([7026, 2602]);

interface Programs {
  overlay: ts.Program;
  base: ts.Program;
}

/** The nearest config in the `extends` chain that sets `compilerOptions.jsx`, and the line of that setting. */
function jsxSettingLocation(configFile: string): { file: string; line: number } | undefined {
  const seen = new Set<string>();
  for (let file = configFile; !seen.has(file); ) {
    seen.add(file);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
    const parsed = ts.parseConfigFileTextToJson(file, text).config as
      | { compilerOptions?: { jsx?: unknown }; extends?: string | string[] }
      | undefined;
    if (parsed?.compilerOptions?.jsx !== undefined) {
      const at = text.search(/"jsx"\s*:/);
      const line = at < 0 ? 1 : text.slice(0, at).split('\n').length;
      return { file, line };
    }
    const base = Array.isArray(parsed?.extends) ? parsed?.extends[0] : parsed?.extends;
    if (typeof base !== 'string' || base.startsWith('@') || !base.startsWith('.')) {
      // A package's config (`@tsconfig/node20`) or none: the option is not set in this repository.
      return undefined;
    }
    const next = isAbsolute(base) ? base : resolve(dirname(file), base);
    file = next.endsWith('.json') ? next : join(next, 'tsconfig.json');
  }
  return undefined;
}

function hasGlobalJsx(program: ts.Program): boolean {
  const checker = program.getTypeChecker();
  return checker.resolveName('JSX', undefined, ts.SymbolFlags.Namespace, false) !== undefined;
}

/**
 * The tsconfig to blame when the target removed the global `JSX` namespace the workspace's
 * `jsx` setting reads, with a predicate for the diagnostics it explains; undefined when the
 * namespace is still there, or no diagnostic says it is missing.
 */
export function jsxNamespaceCause(
  programs: Programs,
  fresh: readonly ts.Diagnostic[],
  repoDir: string,
  targets: readonly string[],
): { cause: DiagnosticCause; explains: (d: ts.Diagnostic) => boolean } | undefined {
  if (!fresh.some((d) => JSX_NAMESPACE_CODES.has(d.code))) return undefined;
  const options = programs.overlay.getCompilerOptions();
  const jsx = options.jsx;
  // react-jsx reads the namespace from the runtime module, not the global: another cause.
  if (jsx === undefined || jsx === ts.JsxEmit.ReactJSX || jsx === ts.JsxEmit.ReactJSXDev)
    return undefined;
  if (options.jsxImportSource !== undefined) return undefined;
  if (hasGlobalJsx(programs.overlay) || !hasGlobalJsx(programs.base)) return undefined;
  const configFile = options.configFilePath as string | undefined;
  const location = configFile ? jsxSettingLocation(configFile) : undefined;
  const file = location?.file ?? configFile;
  if (!file) return undefined;
  const setting = ts.JsxEmit[jsx]?.toLowerCase() ?? String(jsx);
  const who = targets.find((t) => t.startsWith('@types/')) ?? targets[0] ?? 'the target';
  return {
    cause: {
      name: 'jsx',
      file: relative(repoDir, file).split('\\').join('/'),
      line: location?.line ?? 1,
      reason: `"jsx": "${setting}" reads JSX element types from the global JSX namespace, which ${who} no longer declares; "jsxImportSource": "react" (or "jsx": "react-jsx") makes the compiler read them from react/jsx-runtime`,
      config: true,
    },
    explains: (d) => JSX_NAMESPACE_CODES.has(d.code),
  };
}
