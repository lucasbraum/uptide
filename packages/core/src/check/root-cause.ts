import type { Finding, PackageReport } from '../domain/report.js';
import { parseVersion } from './version.js';

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
