import { type Change, depthOf, foldForDisplay, type Severity } from '@uptide/core';
import pc from 'picocolors';

export interface FormatOptions {
  /** Show protected/@internal symbols, alias duplicates and members of removed parents. */
  all?: boolean;
  color?: boolean;
}

const ORDER: Severity[] = ['breaking', 'deprecated', 'additive'];
const KIND_ORDER = [
  'signature',
  'narrowed',
  'type',
  'required',
  'removed',
  'moved',
  'renamed',
  'widened',
  'deprecated',
  'added',
];

function describe(c: Change): string {
  switch (c.kind) {
    case 'removed':
      if (c.replacement === c.path) return 'no longer exported here';
      return c.replacement ? `removed, possibly renamed to ${c.replacement}` : 'removed';
    case 'added':
      return 'added';
    case 'required':
      return 'now required';
    case 'deprecated':
      return typeof c.notes === 'string' ? `deprecated: ${c.notes}` : 'deprecated';
    case 'signature':
      return c.notes ?? 'signature changed';
    case 'type':
      return c.notes ?? 'type changed';
    case 'renamed':
      return `renamed to ${c.replacement ?? '?'}`;
    case 'moved':
      return `moved to ${c.replacement ?? '?'}`;
    case 'widened':
      return c.notes ?? 'type widened';
    case 'narrowed':
      return c.notes ?? 'type narrowed';
    case 'cause':
      return c.notes ?? 'root cause';
    case 'module-format':
      return c.notes ?? 'ESM only';
  }
}

/** `before -> after` only when both exist and are short enough to read on one line. */
function transition(c: Change): string | undefined {
  if (c.before === undefined || c.after === undefined) return undefined;
  const text = `${c.before} -> ${c.after}`;
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
}

export function formatHuman(changes: Change[], opts: FormatOptions = {}): string {
  const colors = pc.createColors(opts.color ?? true);
  const tint: Record<Severity, (s: string) => string> = {
    breaking: colors.red,
    deprecated: colors.yellow,
    additive: colors.green,
    info: colors.dim,
    unverified: colors.magenta,
  };
  const folded = foldForDisplay(changes);
  const visible = opts.all ? changes : folded.shown;
  const lines: string[] = [];
  const first = changes[0];
  if (first) lines.push(colors.bold(`${first.package} ${first.from} -> ${first.to}`), '');

  for (const severity of ORDER) {
    const group = visible
      .filter((c) => c.severity === severity)
      .sort(
        (x, y) =>
          depthOf(x.path) - depthOf(y.path) ||
          KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) ||
          (x.path < y.path ? -1 : x.path > y.path ? 1 : 0),
      );
    if (group.length === 0) continue;
    lines.push(tint[severity](colors.bold(`${severity.toUpperCase()} (${group.length})`)));
    for (const c of group) {
      const confidence =
        c.confidence < 1 ? colors.dim(` (${Math.round(c.confidence * 100)}%)`) : '';
      lines.push(`  ${tint[severity](c.path)}  ${describe(c)}${confidence}`);
      const t = transition(c);
      if (t) lines.push(colors.dim(`      ${t}`));
    }
    lines.push('');
  }

  if (visible.length === 0) lines.push('no changes to the public API', '');

  if (!opts.all) {
    const { impliedByRemoval, aliasDuplicates, nonPublic } = folded.hidden;
    const hidden = impliedByRemoval.length + aliasDuplicates.length + nonPublic.length;
    if (hidden > 0) {
      const parts = [
        impliedByRemoval.length > 0 ? `${impliedByRemoval.length} members of removed symbols` : '',
        aliasDuplicates.length > 0 ? `${aliasDuplicates.length} alias duplicates` : '',
        nonPublic.length > 0 ? `${nonPublic.length} protected/@internal` : '',
      ].filter(Boolean);
      lines.push(
        colors.dim(
          `${hidden} hidden (${parts.join(', ')}); --all shows them, --json includes them`,
        ),
        '',
      );
    }
  }
  return lines.join('\n');
}
