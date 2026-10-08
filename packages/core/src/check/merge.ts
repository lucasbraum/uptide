import type { ApiSurface } from '../domain/surface.js';
import {
  type CompileDiagnostic,
  type CompileSignal,
  type Usage,
  usagePaths,
} from '../domain/usage.js';

/**
 * Pure. Folds Signal B into Signal A. A diagnostic confirms exactly one usage: the
 * innermost whose span contains the diagnostic's start (the usage keeps its certainty and
 * gains the compiler's message). `z.string().trim().url()` is three usages on one line;
 * an error under `url` says nothing about `trim`. One that lands inside no usage is joined
 * to the nearest usage on the same line that a change explains, becomes an `inferred`
 * usage when its message names a symbol of the package, and is otherwise returned as
 * unattributed: still an error the upgrade causes, just one the report cannot tie to a change.
 */
export interface MergedSignals {
  usages: Usage[];
  unattributed: CompileDiagnostic[];
}

/** Whether the diagnostic starts inside the usage's span. */
function contains(u: Usage, d: CompileDiagnostic): boolean {
  if (u.file !== d.file) return false;
  const before = (aLine: number, aCol: number, bLine: number, bCol: number): boolean =>
    aLine < bLine || (aLine === bLine && aCol <= bCol);
  return (
    before(u.line, u.column, d.line, d.column) && before(d.line, d.column, u.endLine, u.endColumn)
  );
}

/** Span length in (lines, columns): the innermost usage is the shortest one containing the position. */
function spanOf(u: Usage): [number, number] {
  return [u.endLine - u.line, u.endLine === u.line ? u.endColumn - u.column : u.endColumn];
}

function innermost(candidates: Usage[]): Usage | undefined {
  let best: Usage | undefined;
  for (const u of candidates) {
    if (!best) {
      best = u;
      continue;
    }
    const [bl, bc] = spanOf(best);
    const [ul, uc] = spanOf(u);
    if (ul < bl || (ul === bl && uc < bc)) best = u;
  }
  return best;
}

/** `Property 'x' does not exist on type 'T'` -> `T#x`; `has no exported member 'x'` -> `x`; only when the surface has that path. */
export function symbolFromMessage(message: string, surface: ApiSurface): string | undefined {
  const known = new Set(surface.symbols.map((s) => s.path));
  const property = /Property '([^']+)' does not exist on type '([^'<]+)/.exec(message);
  if (property) {
    const [, member, type] = property as unknown as [string, string, string];
    for (const candidate of [`${type}#${member}`, `${type}.${member}`])
      if (known.has(candidate)) return candidate;
  }
  const exported = /has no exported member (?:named )?'([^']+)'/.exec(message);
  if (exported && known.has(exported[1] as string)) return exported[1];
  // `Type '{...}' is not assignable to type 'AxiosRequestHeaders'`: the target type is the changed symbol.
  const assignable = /is not assignable to (?:parameter of )?type '([^'<]+)/.exec(message);
  if (assignable && known.has(assignable[1] as string)) return assignable[1];
  return undefined;
}

export function mergeSignals(
  usages: Usage[],
  signal: CompileSignal | undefined,
  surface: ApiSurface,
  changedPaths: Set<string> = new Set(),
): MergedSignals {
  if (!signal) return { usages, unattributed: [] };
  const merged = usages.map((u) => ({ ...u }));
  const unattributed: CompileDiagnostic[] = [];
  const attach = (u: Usage, d: CompileDiagnostic): void => {
    u.compileError = u.compileError ? `${u.compileError}\n${d.message}` : d.message;
    u.compileCode ??= d.code;
  };
  const explained = (u: Usage): boolean => usagePaths(u).some((p) => changedPaths.has(p));
  for (const d of signal.diagnostics) {
    // A diagnostic a compiler option explains belongs to that cause, whatever usage it touches.
    if (d.cause?.config) {
      unattributed.push(d);
      continue;
    }
    const hit = innermost(merged.filter((u) => contains(u, d) && u.access !== 'import'));
    if (hit) {
      attach(hit, d);
      continue;
    }
    // The compiler points at an argument or a literal while the changed symbol sits elsewhere
    // on the same line (`client.interceptors.request.use(callback)`): join it to the nearest
    // usage on that line a change explains, so the error lands on a finding.
    const sameLine = merged
      .filter(
        (u) => u.file === d.file && u.line === d.line && u.access !== 'import' && explained(u),
      )
      .sort((a, b) => Math.abs(a.column - d.column) - Math.abs(b.column - d.column));
    const nearest = sameLine[0];
    if (nearest) {
      attach(nearest, d);
      continue;
    }
    const symbolPath = symbolFromMessage(d.message, surface);
    if (symbolPath) {
      merged.push({
        file: d.file,
        line: d.line,
        column: d.column,
        endLine: d.endLine,
        endColumn: d.endColumn,
        symbolPath,
        // "not assignable to type X" means the consumer supplied a value of X: a write.
        access: /is not assignable to (?:parameter of )?type/.test(d.message) ? 'write' : 'read',
        snippet: d.snippet,
        via: 'inferred',
        compileError: d.message,
        compileCode: d.code,
      });
    } else {
      unattributed.push(d);
    }
  }
  return { usages: merged, unattributed };
}
