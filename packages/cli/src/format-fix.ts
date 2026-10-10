import { isAbsolute, relative } from 'node:path';
import { type FixReport, groupPeerBlockers, summaryCells } from '@uptide/core';
import pc from 'picocolors';
import { elapsed } from './progress.js';

export interface FormatFixOptions {
  color?: boolean;
  /** How the user invokes uptide (`npx uptide@next`), for the commands printed. */
  invocation?: string;
  /** Where the user runs commands from: paths are printed relative to it, so they work as typed. */
  cwd?: string;
  /** The whole run as the user saw it, clone included; the report's own timing is the work. */
  ms?: number;
}

/**
 * The end of `fix`: five lines on the run, then where the result is and what to do next.
 * The PR body itself is a file; the terminal says where.
 */
export function formatFixSummary(report: FixReport, opts: FormatFixOptions = {}): string {
  const colors = pc.createColors(opts.color ?? true);
  const uptide = opts.invocation ?? 'npx uptide';
  const cells = summaryCells(report);
  const dot = colors.dim('·');
  const title =
    report.mode === 'pin'
      ? `pin ${report.package} API version ${report.apiVersion ?? ''}`
      : `${report.package} ${report.from ?? '?'} → ${report.target}${report.targetSource ? ` ${colors.dim(`(${report.targetSource})`)}` : ''}`;
  const verdict = report.verification.passed
    ? colors.green('verification passed')
    : colors.red('verification failed');
  const lines = [
    `${colors.bold('uptide fix')} ${dot} ${title} ${dot} ${verdict} ${dot} ${elapsed(opts.ms ?? report.timingMs)}`,
    '',
    ...(
      [
        ['Risk', cells.risk],
        ['Changes', cells.changes],
        ['Types', cells.types],
        ['Behavior', cells.behavior],
        ['Tests', cells.tests],
      ] as const
    ).map(([label, text]) => `  ${pad(label, 9)} ${plain(text)}`),
    ...(report.companions?.length
      ? [
          `  ${pad('With', 9)} ${report.companions.map((c) => `${c.name} ${c.from} → ${c.to}`).join(', ')}`,
        ]
      : []),
    // Without a pack the reader is told once, here, what stands behind the edits.
    ...(report.tier === 'generic' && report.sites.some((s) => s.outcome === 'agent')
      ? [
          `  ${pad('Tier', 9)} generic: no migration pack; every edit is the agent's, kept on the compiler's word. Review each one.`,
        ]
      : []),
    ...(report.llm.costLimit
      ? [
          `  ${pad('Agent', 9)} stopped at $${report.llm.costLimit.limitUsd.toFixed(2)} (--max-cost): ${report.llm.costLimit.notAttempted} site${report.llm.costLimit.notAttempted === 1 ? '' : 's'} not completed`,
        ]
      : []),
    '',
  ];
  if (report.peerConflicts?.length) {
    lines.push(colors.bold('Peer risks'));
    for (const peer of groupPeerBlockers(report.peerConflicts))
      lines.push(
        `  ${peer.name} ${peer.version}: ${peer.peers.map((p) => `${p.peer} ${p.range} rejects ${p.target}`).join('; ')}${peer.allowed ? ' · explicitly allowed in package.json' : ''}`,
      );
    lines.push('');
  }
  const housekeeping = report.lockfile?.housekeeping;
  if (housekeeping)
    lines.push(
      colors.dim(
        `Lockfile housekeeping · ${housekeeping.deduped.length} dedupe move${housekeeping.deduped.length === 1 ? '' : 's'} · ${housekeeping.metadata.length} metadata-only change${housekeeping.metadata.length === 1 ? '' : 's'} (details in the report)`,
      ),
      '',
    );
  const from = opts.cwd ?? report.source ?? report.repo;
  const where = report.source ? `in your repository, not checked out` : `in ${report.repo}`;
  lines.push(`${colors.bold('Branch')} ${report.branch} ${colors.dim(`(${where})`)}`);
  const base = report.base ?? 'main';
  lines.push(`  git diff ${base}..${report.branch} --stat`);
  if (report.clone?.kept)
    lines.push(
      colors.dim(`  temporary clone kept at ${report.clone.path}: ${report.clone.reason}`),
    );
  lines.push('', colors.bold('Next'));
  const next: [string, string][] = [];
  if (report.prUrl) next.push([report.prUrl, 'the pull request']);
  else if (report.verification.passed)
    next.push([
      `${uptide} pr --branch ${report.branch}`,
      `push the branch and open ${report.publication?.refused.length ? '' : 'a draft '}PR${report.remote ? ` on ${report.remote.replace(/^https:\/\/github\.com\//, '')}` : ''}`,
    ]);
  else
    next.push([
      `${uptide} verify --branch ${report.branch}`,
      'verify again after fixing what failed',
    ]);
  const local = (file: string): string => {
    const rel = relative(from, file);
    return rel.startsWith('..') || isAbsolute(rel) ? file : rel;
  };
  if (report.html) next.push([`open ${local(report.html)}`, 'the migration report']);
  next.push([local(report.prBody), 'the PR description']);
  const width = Math.max(...next.map(([c]) => c.length));
  for (const [cmd, what] of next) lines.push(`  ${pad(cmd, width)}    ${colors.dim(what)}`);
  return `${lines.join('\n')}\n`;
}

/** The cells are Markdown for the PR table; the terminal has no backticks or bold. */
function plain(text: string): string {
  return text.replaceAll('`', '').replace(/\*\*([^*]+)\*\*/g, '$1');
}
const pad = (text: string, to: number): string => text + ' '.repeat(Math.max(0, to - text.length));
