import type { CheckReport, Finding, PackageReport } from '../domain/report.js';

/**
 * Scoring against ground truth: the new tsc errors a real upgrade produced. A prediction
 * is a breaking or unverified site (`file:line`, repository-relative); an anchor is not a
 * prediction, the errors under it are. A hit is attributed when a diff change explains
 * it, as opposed to a bare compile error or a cluster.
 */
export interface TruthCase {
  package: string;
  target: string;
  workspace: string;
  errors: { file: string; line: number; code: number }[];
  /**
   * What no compiler shows and a pack must: a client created without `apiVersion`, whose API
   * version the SDK bump changes at runtime. Scored apart from the tsc errors, by rule.
   */
  runtime?: { file: string; line: number; rule: string }[];
}

export interface TruthScore {
  package: string;
  workspace: string;
  real: number;
  predicted: number;
  hits: number;
  attributed: number;
  anchors: number;
  precision: number;
  recall: number;
  attributionRate: number;
  misses: string[];
  falsePositives: string[];
  /** Pack findings against the case's `runtime` sites; absent when the case lists none and none was predicted. */
  runtime?: {
    real: number;
    predicted: number;
    hits: number;
    misses: string[];
    falsePositives: string[];
  };
}

interface Site {
  key: string;
  attributed: boolean;
}

function prefixOf(p: PackageReport): string {
  return p.workspace === '.' || p.workspace === '*' ? '' : `${p.workspace}/`;
}

function sitesOf(p: PackageReport, f: Finding): Site[] {
  if (f.change.kind === 'cause') {
    return (f.downstream ?? []).map((d) => ({ key: `${d.file}:${d.line}`, attributed: false }));
  }
  const attributed = !/^TS\d+$/.test(f.change.path);
  return [{ key: `${prefixOf(p)}${f.usage.file}:${f.usage.line}`, attributed }];
}

export function scoreAgainstTruth(report: CheckReport, cases: TruthCase[]): TruthScore[] {
  return cases.map((c) => {
    const real = new Set(c.errors.map((e) => `${e.file}:${e.line}`));
    const inWorkspace = (key: string): boolean => key.startsWith(`${c.workspace}/`);
    const predicted = new Map<string, boolean>();
    // A pack's own finding is no compiler error: it answers to the case's `runtime` sites.
    const runtimeReal = new Set((c.runtime ?? []).map((r) => `${r.file}:${r.line} ${r.rule}`));
    const runtimePredicted = new Set<string>();
    let anchors = 0;
    for (const p of report.packages) {
      const names = p.members ? p.members.map((m) => m.name) : [p.name];
      if (!names.includes(c.package)) continue;
      for (const f of p.findings) {
        if (f.severity !== 'breaking' && f.severity !== 'unverified') continue;
        if (f.change.source === 'pack') {
          const key = `${prefixOf(p)}${f.usage.file}:${f.usage.line}`;
          if (inWorkspace(key)) runtimePredicted.add(`${key} ${f.rule ?? f.change.path}`);
          continue;
        }
        if (f.change.kind === 'cause') anchors++;
        for (const s of sitesOf(p, f)) {
          if (!inWorkspace(s.key)) continue;
          predicted.set(s.key, (predicted.get(s.key) ?? false) || s.attributed);
        }
      }
    }
    const runtime =
      runtimeReal.size > 0 || runtimePredicted.size > 0
        ? {
            real: runtimeReal.size,
            predicted: runtimePredicted.size,
            hits: [...runtimePredicted].filter((k) => runtimeReal.has(k)).length,
            misses: [...runtimeReal].filter((k) => !runtimePredicted.has(k)).sort(),
            falsePositives: [...runtimePredicted].filter((k) => !runtimeReal.has(k)).sort(),
          }
        : undefined;
    const hits = [...predicted.keys()].filter((k) => real.has(k));
    const attributed = hits.filter((k) => predicted.get(k) === true).length;
    const ratio = (a: number, b: number): number => (b === 0 ? 1 : a / b);
    return {
      package: c.package,
      workspace: c.workspace,
      real: real.size,
      predicted: predicted.size,
      hits: hits.length,
      attributed,
      anchors,
      precision: ratio(hits.length, predicted.size),
      recall: ratio(hits.length, real.size),
      attributionRate: ratio(attributed, real.size),
      misses: [...real].filter((k) => !predicted.has(k)).sort(),
      falsePositives: [...predicted.keys()].filter((k) => !real.has(k)).sort(),
      ...(runtime ? { runtime } : {}),
    };
  });
}

export function formatTruthTable(scores: TruthScore[]): string {
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const rows = scores.map(
    (s) =>
      `${`${s.package} / ${s.workspace}`.padEnd(30)} real ${String(s.real).padStart(3)}  predicted ${String(s.predicted).padStart(3)}  hits ${String(s.hits).padStart(3)}  precision ${pct(s.precision).padStart(4)}  recall ${pct(s.recall).padStart(4)}  attributed ${String(s.attributed).padStart(3)}/${s.real} (${pct(s.attributionRate)})  anchors counted 0 (${s.anchors} present)${s.runtime ? `  runtime ${s.runtime.hits}/${s.runtime.real} (${s.runtime.predicted} predicted)` : ''}`,
  );
  const detail = scores.flatMap((s) => [
    ...(s.misses.length > 0
      ? [`  ${s.package} / ${s.workspace} misses: ${s.misses.join(', ')}`]
      : []),
    ...(s.falsePositives.length > 0
      ? [`  ${s.package} / ${s.workspace} false positives: ${s.falsePositives.join(', ')}`]
      : []),
    ...(s.runtime && s.runtime.misses.length > 0
      ? [`  ${s.package} / ${s.workspace} runtime misses: ${s.runtime.misses.join(', ')}`]
      : []),
    ...(s.runtime && s.runtime.falsePositives.length > 0
      ? [
          `  ${s.package} / ${s.workspace} runtime false positives: ${s.runtime.falsePositives.join(', ')}`,
        ]
      : []),
  ]);
  return [...rows, ...detail].join('\n');
}
