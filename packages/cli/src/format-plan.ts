import type { Effort, PlannedPackage, UpgradePlan, UpgradeStep } from '@uptide/core';
import { BY, TIER_LEGEND } from '@uptide/core';
import pc from 'picocolors';
import { type CheckHeader, repoLine } from './format-check.js';
import { elapsed } from './progress.js';

export interface FormatPlanOptions {
  color?: boolean;
  header?: CheckHeader;
  invocation?: string;
  /** Flags to repeat so the suggested commands act on the same repository. */
  cwd?: string;
  /** Whether `fix` can run here (a supported package manager). */
  fixable?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** `small · 28 sites: 24 auto-fixable, 4 need the agent (LLM) · 2 unconfirmed`, or what "none" means. */
export function effortLine(e: Effort): string {
  if (e.level === 'unknown') return 'not checked completely · effort unknown';
  if (e.level === 'none') return 'no code changes expected';
  const sites = e.byRule + e.byAgent + e.manual;
  const by = [
    e.byRule > 0 ? BY.rule(e.byRule) : '',
    e.byAgent > 0 ? BY.agent(e.byAgent) : '',
    e.manual > 0 ? `${e.manual} manual` : '',
  ].filter(Boolean);
  return [
    e.level,
    sites > 0 ? `${plural(sites, 'site')}: ${by.join(', ')}` : '',
    e.unconfirmed > 0 ? `${e.unconfirmed} unconfirmed to look at` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

const moveOf = (p: PlannedPackage): string => `${p.name} ${p.installed} → ${p.target}`;

/** What a step asks the reader to do, as a title. */
export function stepTitle(step: UpgradeStep): string {
  if (step.together === 'no-impact')
    return `Bump together: ${plural(step.packages.length, 'package')}, nothing in your code is affected`;
  if (step.together === 'peer')
    return `Upgrade together: ${step.packages.map((p) => p.name).join(' + ')}`;
  return moveOf(step.packages[0] as PlannedPackage);
}

/**
 * The plan on one screen: the steps in order, each with its target, tier, effort and the
 * peer ranges that put it there, then what was left out and why.
 */
export function formatPlan(plan: UpgradePlan, opts: FormatPlanOptions = {}): string {
  const colors = pc.createColors(opts.color ?? true);
  const uptide = opts.invocation ?? 'npx uptide';
  const cwd = opts.cwd ? ` --cwd ${opts.cwd}` : '';
  const lines: string[] = [];
  if (opts.header) {
    const dot = colors.dim('·');
    lines.push(
      `${colors.bold('uptide plan')} ${dot} ${repoLine(opts.header)} ${dot} ${elapsed(opts.header.ms)}`,
      '',
    );
  }
  if (plan.steps.length === 0)
    lines.push(colors.dim('Nothing to plan: every analyzed dependency is up to date.'), '');
  for (const note of plan.notes ?? []) lines.push(note);
  if (plan.notes?.length) lines.push('');
  const width = String(plan.steps.length).length;
  const indent = ' '.repeat(width + 2);
  for (const step of plan.steps) {
    const single = step.packages.length === 1 ? (step.packages[0] as PlannedPackage) : undefined;
    lines.push(
      `${colors.bold(String(step.order).padStart(width))}  ${colors.bold(stepTitle(step))}${single ? colors.dim(`   ${single.tier}`) : ''}`,
    );
    if (single) lines.push(`${indent}${effortLine(single.effort)}`);
    else
      for (const p of step.packages)
        lines.push(
          `${indent}${moveOf(p)}${colors.dim(`   ${p.tier}`)}${step.together === 'peer' ? `   ${effortLine(p.effort)}` : ''}`,
        );
    for (const c of step.constraints)
      lines.push(
        `${indent}${c.effect === 'blocked' ? colors.red('✗ blocked: ') : colors.yellow('peer: ')}${c.reason}`,
      );
    if (opts.fixable && step.effort !== 'none')
      for (const p of step.packages)
        lines.push(
          colors.dim(
            `${indent}${uptide} ${p.effort.level === 'unknown' ? 'check' : 'fix'} ${p.name}${cwd}`,
          ),
        );
    lines.push('');
  }
  if (plan.notPlanned.length > 0) {
    lines.push(colors.bold('Not planned'));
    for (const p of plan.notPlanned.slice(0, 12))
      lines.push(`  ${p.name} ${p.installed}: ${p.reason}`);
    if (plan.notPlanned.length > 12)
      lines.push(colors.dim(`  and ${plan.notPlanned.length - 12} more`));
    lines.push(colors.dim(`  ${uptide} list${cwd}    refresh discovery`), '');
  }
  if (plan.steps.some((s) => s.packages.some((p) => p.tier === 'generic')))
    lines.push(colors.dim(TIER_LEGEND));
  lines.push(
    colors.dim(
      'Effort is an estimate from the findings: none (nothing affected), small (rules, or up to 5 sites by hand or agent), medium (up to 25), large (more).',
    ),
  );
  return `${lines.join('\n')}\n`;
}
