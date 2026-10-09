import type { DownstreamSite, Finding, PackageReport, SharedRoot } from '../domain/report.js';
import { describeCluster } from './unattributed.js';
import { parseVersion } from './version.js';

const rootKey = (r: SharedRoot): string => `${r.file}:${r.line}:${r.name}`;

/** `3 call sites in 2 workspaces`: the line under a shared root's reason. */
export function callSitesLine(sites: readonly DownstreamSite[]): string {
  const workspaces = new Set(sites.map((s) => s.workspace).filter((w) => w !== undefined));
  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
  return `${count(sites.length, 'call site')}${workspaces.size > 1 ? ` in ${count(workspaces.size, 'workspace')}` : ''}`;
}

/**
 * Sites in different workspaces that trace to one repository declaration are one finding,
 * anchored at the declaration with the sites as evidence. Within a workspace the compile
 * signal already folds two or more such sites (adapters/typescript/compile.ts); a site alone
 * in its workspace keeps its `root`, and here, after the merge, roots are compared across
 * workspaces: two or more sites at one root, or one site plus the anchor another workspace
 * already produced, become (or join) the anchored finding. tldraw's `useTransform(ref)`,
 * called from three workspaces, is fixed once, in the hook's parameter.
 */
export function foldSharedRoots(
  findings: Finding[],
  workspaceOf: (f: Finding) => string | undefined,
): Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!f.root) continue;
    const list = groups.get(rootKey(f.root)) ?? [];
    list.push(f);
    groups.set(rootKey(f.root), list);
  }
  const folded = new Map<Finding, Finding | undefined>();
  for (const group of groups.values()) {
    const anchors = group.filter((f) => f.anchorOnly && f.change.kind === 'cause');
    const sites = group.filter((f) => !anchors.includes(f));
    // One site, no anchor anywhere: nothing shared, the site stands on its own.
    if (sites.length === 0 || anchors.length + sites.length < 2) continue;
    const root = (group[0] as Finding).root as SharedRoot;
    const evidence: DownstreamSite[] = [
      ...anchors.flatMap((a) => a.downstream ?? []),
      ...sites.map((f) => ({
        file: f.usage.file,
        line: f.usage.line,
        column: f.usage.column,
        snippet: f.usage.snippet,
        code: f.usage.compileCode ?? Number(/^TS(\d+)$/.exec(f.change.path)?.[1] ?? 0),
        message: f.usage.compileError ?? f.reason,
        ...(workspaceOf(f) !== undefined ? { workspace: workspaceOf(f) } : {}),
      })),
    ].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const first = (anchors[0] ?? sites[0]) as Finding;
    // The pack rule the sites were filed under, when they agree on one.
    const rules = [...new Set(group.map((f) => f.rule).filter((r) => r !== undefined))];
    const anchor: Finding = {
      ...first,
      change: {
        ...first.change,
        path: `cause:${root.name}`,
        kind: 'cause',
        severity: 'breaking',
        evidence: 'checker',
        notes: describeCluster(evidence.length, { ...root, anchorOnly: true }),
      },
      usage: {
        file: root.file,
        line: root.line,
        column: 1,
        endLine: root.line,
        endColumn: 1,
        symbolPath: `cause:${root.name}`,
        access: 'read',
        snippet: '',
        via: 'inferred',
      },
      downstream: evidence,
      anchorOnly: true,
      root,
      severity: 'breaking',
      confidence: 1,
      fixability: 'assisted',
      reason: root.reason,
      details: [
        callSitesLine(evidence),
        ...(first.details ?? []).filter((d) => !/^\d+ call sites?/.test(d)),
      ],
      evidence: 'compiler',
      ...(rules.length === 1 ? { rule: rules[0] } : {}),
    };
    folded.set(first, anchor);
    for (const f of group) if (f !== first) folded.set(f, undefined);
  }
  if (folded.size === 0) return findings;
  return findings.flatMap((f) =>
    folded.has(f) ? (folded.get(f) ? [folded.get(f) as Finding] : []) : [f],
  );
}

/** Known package-level cause, gated on compiler evidence. Other diagnostics remain separate. */
export function groupRootCauses(report: PackageReport): void {
  if (report.name !== 'typescript' || parseVersion(report.target)?.major !== 7) return;
  const codeOf = (f: Finding): number =>
    f.usage.compileCode ?? Number(/^TS(\d+)$/.exec(f.change.path)?.[1] ?? 0);
  const missing = report.findings.filter(
    (f) =>
      f.severity === 'breaking' &&
      f.evidence === 'compiler' &&
      [2305, 2339, 2551, 2614, 2694, 2724].includes(codeOf(f)),
  );
  if (missing.length < 2) return;
  const first = missing[0] as Finding;
  const title = 'TypeScript 7 has no JavaScript compiler API in its main entry';
  const cause: Finding = {
    ...first,
    rule: 'typescript-no-js-api',
    change: { ...first.change, kind: 'cause', path: 'cause:typescript-no-js-api' },
    reason: title,
    details: [
      'Migrate compiler API consumers separately; changing individual missing members does not restore the API.',
    ],
    downstream: missing.map((f) => ({
      file: f.usage.file,
      line: f.usage.line,
      column: f.usage.column,
      snippet: f.usage.snippet,
      code: codeOf(f),
      message: f.usage.compileError ?? f.reason,
    })),
  };
  report.findings = [cause, ...report.findings.filter((f) => !missing.includes(f))];
}
