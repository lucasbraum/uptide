import {
  type CheckReport,
  callSitesLine,
  type Finding,
  isNativeProbeSkip,
  type PackageReport,
} from '@uptide/core';
import pc from 'picocolors';
import { analyzedImporters, importerNotes } from './importers.js';

export interface DetailOptions {
  /** Show findings under confidence 0.5 too. Additive findings are never listed. */
  all?: boolean;
  color?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** Errors shown under a compiler-option cause: enough to see the shape, not the thousand of them. */
const EVIDENCE_SITES = 8;

function describeChange(f: Finding): string {
  const c = f.change;
  const replacement =
    c.replacement !== undefined && c.kind !== 'moved' ? ` → ${c.replacement}` : '';
  if (c.path.startsWith('cause:')) return c.notes ?? f.reason;
  // Several symbols gone at one site: the reason already lists them.
  if (/^\d+ symbols (removed|moved) at this site: /.test(f.reason)) return f.reason;
  if (c.kind === 'module-format') return `${c.package} ${f.reason}`;
  if (/^TS\d+$/.test(c.path)) {
    const concrete = (f.usage.compileError ?? c.notes ?? f.reason).split('\n')[0] ?? '';
    return `${c.path}: ${concrete.length > 160 ? `${concrete.slice(0, 157)}...` : concrete}`;
  }
  switch (c.kind) {
    case 'removed':
      return `${c.path} removed${replacement}`;
    case 'moved':
      return `${c.path} moved to ${c.replacement ?? 'another entry point'}`;
    case 'renamed':
      return `${c.path} renamed${replacement}`;
    case 'deprecated':
      return `${c.path} deprecated${f.reason && f.reason !== 'deprecated' ? `: ${f.reason}` : ''}${replacement}`;
    default:
      // A reason that already names the path ("X, the type of Y, …") is not prefixed again.
      return f.reason.startsWith(`${c.path},`)
        ? `${f.reason}${replacement}`
        : `${c.path} ${f.reason}${replacement}`;
  }
}

/** What confirms a breaking finding, in the words `--details` prints under it. */
const EVIDENCE: Record<Exclude<NonNullable<Finding['evidence']>, 'pack'>, string> = {
  compiler: 'your code does not compile against the target at this site',
  runtime: 'the runtime probe loaded the target and the export is gone or changed',
  'module-format': 'a require() of a package whose target is ESM-only',
  'removed-export': 'the import of a name the target no longer exports',
};

function findingLines(
  f: Finding,
  mark: string,
  colors: ReturnType<typeof pc.createColors>,
  tint: (s: string) => string,
): string[] {
  const location = `${f.usage.file}:${f.usage.line}`;
  const first = `  ${tint(mark)} ${location.padEnd(34)} ${f.usage.snippet}`;
  const description = describeChange(f);
  const confidence = f.confidence < 1 ? colors.dim(` (${Math.round(f.confidence * 100)}%)`) : '';
  const second = `      ${description.padEnd(62)} ${colors.dim(f.fixability)}${confidence}`;
  const lines = [first, second];
  if (f.severity === 'breaking' && f.evidence && f.evidence !== 'pack')
    lines.push(colors.dim(`      evidence: ${EVIDENCE[f.evidence]}`));
  if (f.usage.compileError)
    lines.push(colors.dim(`      compiler: ${f.usage.compileError.split('\n')[0]}`));
  for (const detail of f.details ?? []) lines.push(colors.dim(`      ${detail}`));
  const others = (f.sites ?? []).filter((s) => s.line !== f.usage.line);
  if (others.length > 0)
    lines.push(
      colors.dim(
        `      also at line${others.length === 1 ? '' : 's'} ${others.map((s) => s.line).join(', ')}`,
      ),
    );
  return lines;
}

type Colors = ReturnType<typeof pc.createColors>;

function siteLines(
  findings: Finding[],
  mark: string,
  colors: Colors,
  tint: (s: string) => string,
): string[] {
  return findings.flatMap((f) => {
    if (f.change.kind !== 'cause') return findingLines(f, mark, colors, tint);
    const sites = f.downstream ?? [];
    // A compiler option is one site; the errors under it are evidence, a few of them shown.
    if (f.anchorOnly) {
      const shown = sites.slice(0, EVIDENCE_SITES);
      return [
        `  ${tint(mark)} ${f.usage.file}:${f.usage.line}  \`${f.change.path.replace(/^cause:/, '')}\``,
        `      ${f.reason}`,
        colors.dim(
          f.root
            ? `      ${callSitesLine(sites)}${shown.length ? ', for example' : ''}`
            : `      evidence: ${plural(sites.length, 'error')} at the target${shown.length ? ', for example' : ''}`,
        ),
        ...shown.map((site) =>
          colors.dim(`        ${site.file}:${site.line}  TS${site.code}: ${site.message}`),
        ),
        ...(sites.length > shown.length
          ? [colors.dim(`        … and ${sites.length - shown.length} more`)]
          : []),
        // The call-site count is printed above; the rest of the details follow.
        ...(f.details ?? [])
          .filter((detail) => !(f.root && /^\d+ call sites?\b/.test(detail)))
          .map((detail) => colors.dim(`      ${detail}`)),
      ];
    }
    return [
      `  ${tint(mark)} ${f.reason} (${plural(sites.length, 'site')})`,
      ...sites.flatMap((site) => [
        `      ${site.file}:${site.line}  ${site.snippet ?? ''}`.trimEnd(),
        colors.dim(`        TS${site.code}: ${site.message}`),
      ]),
      ...(f.details ?? []).map((detail) => colors.dim(`      ${detail}`)),
    ];
  });
}

function packageLines(p: PackageReport, opts: DetailOptions, colors: Colors): string[] {
  const behind = p.majorsBehind > 0 ? `   (${plural(p.majorsBehind, 'major')} behind)` : '';
  const title = p.members ? `${p.name} (${plural(p.members.length, 'package')})` : p.name;
  const where = p.workspaces
    ? colors.dim(
        `   · ${p.source === 'catalog' ? 'catalog · ' : ''}${p.workspaces.map((w) => (w === '.' ? 'root' : w)).join(', ')}`,
      )
    : '';
  const via = p.typesVia ? colors.dim(`   · types via ${p.typesVia}`) : '';
  const tier = p.tier ? colors.dim(`   · ${p.tier}`) : '';
  const header = `${colors.bold(title)}  ${p.installed} → ${p.target}${behind}${tier}${where}${via}`;
  const lines: string[] = [];
  if (p.status === 'no-types') {
    // The real reason: which version lacks declarations, or where the types live instead.
    const typesIn = p.notes.find((n) => n.startsWith('types in '));
    const reason = typesIn
      ? `${typesIn}, not analyzed`
      : (p.notes.find((n) => /type declarations/.test(n)) ??
        'no type declarations, cannot analyze');
    return [`${colors.bold(p.name)}  ${p.installed} → ${p.target}  ${colors.dim(reason)}`];
  }
  // Never imported, linked from the workspace, private, or up to date: nothing to say per package.
  if (p.status === 'not-imported' || p.status === 'workspace' || p.status === 'private') return [];
  if (p.notes.includes('up to date')) return [];
  // Left out by the time budget: the first screen's "Not analyzed" block names them once.
  if (p.skipReason === 'TIME_BUDGET') return [];
  if (p.status === 'skipped') {
    return [
      `${colors.bold(p.name)}  ${p.installed}  ${colors.dim(`skipped: ${p.notes.join('; ') || 'unknown reason'}`)}`,
    ];
  }
  lines.push(header);
  const analyzed = analyzedImporters(p);
  if (analyzed && (p.importers?.length ?? 0) > 1)
    lines.push(colors.dim(`  analyzed in ${analyzed}`));
  for (const note of importerNotes(p)) lines.push(`  ${colors.yellow('⚠')} ${note}`);
  const visible = p.findings.filter(
    (f) => f.severity !== 'additive' && f.severity !== 'info' && (opts.all || f.confidence >= 0.5),
  );
  const breaking = visible.filter((f) => f.severity === 'breaking');
  const unverified = visible.filter((f) => f.severity === 'unverified');
  const deprecated = visible.filter((f) => f.severity === 'deprecated');
  const render = siteLines;
  const unanalyzed = p.unanalyzed.length;
  if (visible.length === 0) {
    if (p.status === 'unknown') {
      lines.push(
        `  ${colors.magenta('?')} unknown: ${unanalyzed} of ${plural(p.callSitesChecked + unanalyzed, 'site')} not analyzed (require/dynamic import)`,
      );
    } else if (unanalyzed > 0) {
      lines.push(
        `  ${colors.green('✓')} no impact in ${plural(p.callSitesChecked, 'analyzed site')} · ${colors.yellow('⚠')} ${plural(unanalyzed, 'site')} not analyzed`,
      );
    } else {
      lines.push(
        `  ${colors.green('✓')} no impact on your code (${plural(p.callSitesChecked, 'call site')} checked)`,
      );
    }
  }
  if (breaking.length > 0) {
    // An anchor is not a call site; the errors under it are.
    const files = new Set(
      breaking.flatMap((f) =>
        f.change.kind === 'cause' ? (f.downstream ?? []).map((d) => d.file) : [f.usage.file],
      ),
    ).size;
    const sites = breaking.reduce(
      (n, f) => n + (f.change.kind === 'cause' ? (f.downstream?.length ?? 0) : 1),
      0,
    );
    lines.push(
      '',
      `  ${colors.red(colors.bold('BREAKING'))}  ${plural(sites, 'call site')} in ${plural(files, 'file')}`,
    );
    lines.push(...render(breaking, '✗', colors, colors.red));
  }
  if (unverified.length > 0) {
    lines.push(
      '',
      `  ${colors.magenta(colors.bold('UNVERIFIED'))}  ${plural(unverified.length, 'call site')} ${colors.dim(p.tier === 'generic' ? '(the declarations changed here; nothing confirmed that the code breaks)' : '(verification incomplete)')}`,
    );
    lines.push(...render(unverified, '?', colors, colors.magenta));
  }
  if (deprecated.length > 0) {
    lines.push(
      '',
      `  ${colors.yellow(colors.bold('DEPRECATED'))}  ${plural(deprecated.length, 'call site')}`,
    );
    lines.push(...render(deprecated, '!', colors, colors.yellow));
  }
  // `info` findings are demoted verdicts the compiler accepted: never listed, never counted, only mentioned here.
  const hidden = p.findings.filter(
    (f) =>
      f.severity !== 'additive' && (f.severity === 'info' || (!opts.all && f.confidence < 0.5)),
  ).length;
  if (hidden > 0)
    lines.push(colors.dim(`  ${plural(hidden, 'low-confidence finding')} hidden (use --all)`));
  for (const r of p.runtime ?? []) {
    const who = (p.runtime?.length ?? 0) > 1 ? `${r.package}: ` : '';
    const unused = r.changes.filter((c) => c.key && r.usedKeys && !r.usedKeys.includes(c.key));
    const unusedKeys = new Set(unused.map((c) => c.key));
    for (const c of r.changes) {
      if (!opts.all && unused.includes(c)) continue;
      lines.push(colors.dim(`  ⚙ runtime (${r.node}): ${who}${c.detail}`));
    }
    if (unusedKeys.size > 0)
      lines.push(
        colors.dim(
          `  ⚙ ${who}${unusedKeys.size} unused exports removed${opts.all ? '' : ' (use --all)'}`,
        ),
      );
    if (isNativeProbeSkip(r.inconclusive))
      lines.push(colors.dim(`  ⚙ ${who}native package, runtime probe skipped`));
    else if (r.inconclusive)
      lines.push(colors.dim(`  ⚙ runtime (${r.node}): ${who}inconclusive, ${r.inconclusive}`));
  }
  for (const note of p.notes) {
    // The verdict line already says how many sites were not analyzed.
    if (visible.length === 0 && /sites? not analyzed/.test(note)) continue;
    lines.push(colors.dim(`  ⚠ ${note}`));
  }
  return lines;
}

/**
 * `check --details`: every site with its snippet, reason and raw compiler message, full
 * paths, and every note the analysis left (subtracted pre-existing errors, hidden
 * low-confidence findings, runtime remarks). The default view is `format-check.ts`.
 */
export function formatCheckDetails(report: CheckReport, opts: DetailOptions = {}): string {
  const colors = pc.createColors(opts.color ?? true);
  const lines: string[] = [];
  const grouped = report.workspaces.length > 1;
  for (const workspace of ['*', ...report.workspaces]) {
    const blocks = report.packages
      .filter((p) => p.workspace === workspace)
      .map((p) => packageLines(p, opts, colors))
      .filter((b) => b.length > 0);
    if (blocks.length === 0) continue;
    if (grouped) {
      const title =
        workspace === '*' ? '(shared across workspaces)' : workspace === '.' ? '(root)' : workspace;
      lines.push(colors.bold(colors.underline(title)), '');
    }
    for (const block of blocks) lines.push(...block, '');
  }
  const privates = [
    ...new Set(report.packages.filter((p) => p.status === 'private').map((p) => p.name)),
  ].sort();
  if (privates.length > 0) {
    lines.push(
      colors.dim(
        `${plural(privates.length, 'private package')} skipped: registry auth or not on the registry (${privates.join(', ')})`,
      ),
      '',
    );
  }
  const s = report.summary;
  const actionable = s.breaking + s.deprecated;
  lines.push(
    `${colors.bold('Summary:')} ${plural(s.packagesNeedingAttention, 'package')} need${s.packagesNeedingAttention === 1 ? 's' : ''} attention · ${s.breaking} breaking · ${s.deprecated} deprecated${s.unverified > 0 ? ` · ${s.unverified} unverified` : ''} · ${s.unaffected} unaffected${s.partiallyAnalyzed > 0 ? ` · ${s.partiallyAnalyzed} partially analyzed` : ''}${s.notImported > 0 ? ` · ${s.notImported} not imported` : ''}`,
  );
  if (actionable > 0)
    lines.push(
      `         ${s.autoFixable} of ${plural(actionable, 'finding')} ${actionable === 1 ? 'is' : 'are'} mechanical`,
    );
  return `${lines.join('\n')}\n`;
}
