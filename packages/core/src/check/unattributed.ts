import { posix } from 'node:path';
import type { Change } from '../domain/change.js';
import type { Finding } from '../domain/report.js';
import type { ApiSurface } from '../domain/surface.js';
import type { CompileDiagnostic, DiagnosticCause, Usage } from '../domain/usage.js';

/**
 * A diagnostic that is new in the overlay and absent from the baseline is a break by
 * definition, whether or not the diff can name the change behind it. It becomes a finding
 * of its own: breaking, fixability unknown, reason fixed, grouped by TypeScript code and by
 * the message with its quoted identifiers normalized. When the message quotes a name
 * declared in a target file with unresolved imports, the compiler could not judge and the
 * finding is `unverified`.
 */

export const UNATTRIBUTED_REASON = 'compile error not attributed to a known API change';

/** `'ZodString'` -> `'_'`: the same shape of error on two types is one group. */
export function normalizeMessage(message: string): string {
  return (message.split('\n')[0] ?? '')
    .replace(/'[^']*'/g, "'_'")
    .replace(/\s+/g, ' ')
    .trim();
}

function quotedNames(message: string): string[] {
  return [...message.matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
}

/** `${n} errors caused by \`name\` (file:line), <reason>. Fix here first.`: the text the report prints for a cluster. */
export function describeCluster(count: number, cause: DiagnosticCause): string {
  if (cause.config || cause.anchorOnly)
    return `${count} error${count === 1 ? '' : 's'} caused by \`${cause.name}\` in ${cause.file}:${cause.line}: ${cause.reason}. One edit there resolves them.`;
  return `${count} error${count === 1 ? '' : 's'} caused by \`${cause.name}\` (${cause.file}:${cause.line}), ${cause.reason}. Fix here first.`;
}

export function unattributedFindings(
  diagnostics: CompileDiagnostic[],
  meta: { package: string; from: string; to: string },
  surfaceB: ApiSurface,
  unresolvedFiles: string[],
  /** Prefix that makes a workspace-relative file repository-relative (`packages/api/`). */
  filePrefix = '',
): Finding[] {
  // Diagnostics sharing a traced cause collapse into one finding at the cause.
  const clusters = new Map<string, CompileDiagnostic[]>();
  const single: CompileDiagnostic[] = [];
  for (const d of diagnostics) {
    if (!d.cause) {
      single.push(d);
      continue;
    }
    const key = `${d.cause.file}:${d.cause.line}:${d.cause.name}`;
    const list = clusters.get(key) ?? [];
    list.push(d);
    clusters.set(key, list);
  }
  const clustered: Finding[] = [...clusters.values()].map((group) => {
    const cause = (group[0] as CompileDiagnostic).cause as DiagnosticCause;
    const usage: Usage = {
      file: cause.file,
      line: cause.line,
      column: 1,
      endLine: cause.line,
      endColumn: 1,
      symbolPath: `cause:${cause.name}`,
      access: 'read',
      snippet: '',
      via: 'inferred',
    };
    const change: Change = {
      ...meta,
      path: `cause:${cause.name}`,
      kind: 'cause',
      severity: 'breaking',
      source: 'types',
      confidence: 1,
      evidence: 'checker',
      notes: describeCluster(group.length, {
        ...cause,
        file: posix.normalize(`${filePrefix}${cause.file}`),
      }),
    };
    return {
      change,
      usage,
      downstream: group.map((d) => ({
        file: posix.normalize(`${filePrefix}${d.file}`),
        line: d.line,
        code: d.code,
        message: d.message.split('\n')[0] ?? d.message,
      })),
      // A cause that is itself the one edit (a compiler option, a parameter's type) is the
      // site; the errors under it are evidence.
      ...(cause.anchorOnly || cause.config ? { anchorOnly: true as const } : {}),
      severity: 'breaking',
      confidence: 1,
      fixability: cause.anchorOnly || cause.config ? 'assisted' : 'unknown',
      reason: cause.anchorOnly || cause.config ? cause.reason : UNATTRIBUTED_REASON,
    };
  });
  return [...clustered, ...plainFindings(single, meta, surfaceB, unresolvedFiles)];
}

function plainFindings(
  diagnostics: CompileDiagnostic[],
  meta: { package: string; from: string; to: string },
  surfaceB: ApiSurface,
  unresolvedFiles: string[],
): Finding[] {
  const unresolved = new Set(unresolvedFiles);
  // Leaf names declared in files the compiler could not fully resolve.
  const shaky = new Set(
    surfaceB.symbols
      .filter((s) => s.file !== undefined && unresolved.has(s.file))
      .map((s) => s.path.split(/[.#[]/).pop() ?? s.path),
  );
  return diagnostics.map((d) => {
    const usage: Usage = {
      file: d.file,
      line: d.line,
      column: d.column,
      endLine: d.endLine,
      endColumn: d.endColumn,
      symbolPath: `TS${d.code}`,
      access: 'read',
      snippet: d.snippet ?? '',
      via: 'inferred',
      compileError: d.message,
    };
    const change: Change = {
      ...meta,
      path: `TS${d.code}`,
      kind: 'type',
      severity: 'breaking',
      source: 'types',
      confidence: 1,
      evidence: 'checker',
      notes: normalizeMessage(d.message),
    };
    const inconclusive = quotedNames(d.message).some((n) => shaky.has(n));
    return {
      change,
      usage,
      severity: inconclusive ? 'unverified' : 'breaking',
      confidence: 1,
      fixability: 'unknown',
      reason: inconclusive
        ? `${UNATTRIBUTED_REASON}; a type it names is declared in a target file with unresolved imports, compile check inconclusive`
        : UNATTRIBUTED_REASON,
    };
  });
}
