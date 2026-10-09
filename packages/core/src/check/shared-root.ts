import type { Finding } from '../domain/report.js';
import type { CompileDiagnostic, DiagnosticCause } from '../domain/usage.js';
import { clusterFinding, describeCluster } from './unattributed.js';

const keyOf = (c: Pick<DiagnosticCause, 'file' | 'line' | 'name'>): string =>
  `${c.file}:${c.line}:${c.name}`;

/** The cause an anchor finding stands for, read back from the finding. */
function anchorKey(f: Finding): string | undefined {
  if (f.change.kind !== 'cause' || !f.anchorOnly || !f.change.path.startsWith('cause:'))
    return undefined;
  return keyOf({ file: f.usage.file, line: f.usage.line, name: f.change.path.slice(6) });
}

/** A lone site as the compile error it was, repository-relative. */
function asDiagnostic(f: Finding, cause: DiagnosticCause): CompileDiagnostic {
  return {
    file: f.usage.file,
    line: f.usage.line,
    column: f.usage.column,
    endLine: f.usage.endLine,
    endColumn: f.usage.endColumn,
    code: Number(/^TS(\d+)$/.exec(f.change.path)?.[1] ?? 0),
    message: f.usage.compileError ?? '',
    snippet: f.usage.snippet,
    cause,
  };
}

/**
 * Several workspaces, one edit. A repository parameter that one call site trips in each of
 * several workspaces (`useTransform(ref)` in `apps/examples` and in `packages/tldraw`, both
 * rejected by `packages/editor/src/lib/hooks/useTransform.ts:6`) is one breaking finding at the
 * declaration, with the call sites under it as evidence, as one workspace with two such sites
 * already is. A lone site joins the anchor another workspace already reports for the same
 * declaration; two lone sites in different workspaces make one. A site no other shares stays
 * its own finding. Files are repository-relative (`mergeAcrossWorkspaces` prefixes them first).
 */
export function joinSharedRoots(findings: Finding[]): Finding[] {
  const candidates = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!f.sharedCause) continue;
    const key = keyOf(f.sharedCause);
    candidates.set(key, [...(candidates.get(key) ?? []), f]);
  }
  const joined = new Set<Finding>();
  const replaced = new Map<Finding, Finding>();
  const created = new Map<Finding, Finding>();
  for (const [key, lone] of candidates) {
    const anchor = findings.find((f) => anchorKey(f) === key);
    if (anchor) {
      const cause = lone[0]?.sharedCause as DiagnosticCause;
      const downstream = [
        ...(anchor.downstream ?? []),
        ...lone.map((f) => {
          const d = asDiagnostic(f, cause);
          return {
            file: d.file,
            line: d.line,
            code: d.code,
            message: d.message.split('\n')[0] ?? '',
          };
        }),
      ];
      replaced.set(anchor, {
        ...(replaced.get(anchor) ?? anchor),
        downstream,
        callSites: downstream.length,
        change: {
          ...anchor.change,
          notes: describeCluster(downstream.length, {
            ...cause,
            file: anchor.usage.file,
            line: anchor.usage.line,
          }),
        },
      });
      for (const f of lone) joined.add(f);
      continue;
    }
    if (lone.length < 2) continue;
    const first = lone[0] as Finding;
    const cause = first.sharedCause as DiagnosticCause;
    const meta = { package: first.change.package, from: first.change.from, to: first.change.to };
    const group = lone.map((f) => asDiagnostic(f, cause));
    const cluster = clusterFinding(group, meta);
    // The rule that claimed the lone sites claims the anchor too.
    created.set(first, first.rule ? { ...cluster, rule: first.rule } : cluster);
    for (const f of lone) joined.add(f);
  }
  const out: Finding[] = [];
  for (const f of findings) {
    const made = created.get(f);
    if (made) out.push(made);
    if (joined.has(f)) continue;
    const kept = replaced.get(f) ?? f;
    if (kept.sharedCause) {
      const { sharedCause: _unshared, ...rest } = kept;
      out.push(rest);
    } else out.push(kept);
  }
  return out;
}
