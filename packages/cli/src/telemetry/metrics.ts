import type { CheckReport, CheckResult, FixReport, ListReport } from '@uptide/core';
import type { Metrics } from './payload.js';

export function checkMetrics(report: CheckReport | CheckResult): Metrics {
  return {
    repo: report.repo,
    packages: report.packages.map((p) => ({ name: p.name, versions: [p.installed, p.target] })),
    counts: {
      packages: report.packages.length,
      workspaces: report.workspaces.length,
      breaking: report.summary.breaking,
      deprecated: report.summary.deprecated,
      unverified: report.summary.unverified,
      failed: report.summary.failed,
      partial: report.summary.partiallyAnalyzed,
    },
    durations: {
      fetch: report.packages.reduce((n, p) => n + p.timing.fetchMs, 0),
      diff: report.packages.reduce((n, p) => n + p.timing.diffMs, 0),
      usages: report.packages.reduce((n, p) => n + p.timing.usagesMs, 0),
      compile: report.packages.reduce((n, p) => n + p.timing.compileMs, 0),
      runtime: report.packages.reduce((n, p) => n + (p.timing.runtimeMs ?? 0), 0),
    },
  };
}
export function listMetrics(report: ListReport): Metrics {
  return {
    repo: report.repo,
    packages: report.packages.map((p) => ({ name: p.name, versions: [p.current, p.latest] })),
    counts: {
      packages: report.packages.length,
      workspaces: report.workspaces.length,
      failed: report.failures.length,
    },
    durations: { engine: report.timing.totalMs },
  };
}
export function fixMetrics(report: FixReport, cwd: string): Metrics {
  return {
    repo: cwd,
    packages: [{ name: report.package, versions: [report.from ?? '', report.target] }],
    counts: {
      sites: report.sites.length,
      files: new Set(report.sites.map((s) => s.finding.usage.file)).size,
      new_errors: report.verification.newErrors.length,
      tests: report.verification.tests.length,
    },
    durations: { engine: report.timingMs, verification: report.verificationTimingMs ?? 0 },
    verification: report.verificationPending
      ? 'not_run'
      : report.verification.passed
        ? 'passed'
        : 'failed',
    cost: report.llm.costUsd,
    provider: report.llm.provider,
    model: report.llm.model,
  };
}
