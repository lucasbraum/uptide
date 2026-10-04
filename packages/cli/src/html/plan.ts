import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { TIER_LEGEND, type UpgradePlan } from '@uptide/core';
import { effortLine, type FormatPlanOptions, stepTitle } from '../format-plan.js';
import { elapsed } from '../progress.js';
import { css } from './assets.js';
import { escapeHtml } from './render.js';

export interface PlanHtmlOptions extends FormatPlanOptions {
  version: string;
  date: string;
  timeZone?: string;
}

/** The plan as a page: the same steps, constraints and effort as the terminal. No script, no network. */
export function renderPlanHtml(plan: UpgradePlan, opts: PlanHtmlOptions): string {
  const e = escapeHtml;
  const uptide = opts.invocation ?? 'npx uptide';
  const tone = {
    none: 'safe',
    small: 'deprecated',
    medium: 'unverified',
    large: 'breaking',
  } as const;
  const steps = plan.steps
    .map((step) => {
      const packages = step.packages
        .map(
          (p) =>
            `<article class="site"><div class="mono">${e(p.name)} ${e(p.installed)} → ${e(p.target)} · ${e(p.tier)}</div><p class="muted">${e(effortLine(p.effort))}</p>${
              opts.fixable && p.effort.level !== 'none'
                ? `<div class="command"><code>${e(`${uptide} fix --only ${p.name}`)}</code></div>`
                : ''
            }</article>`,
        )
        .join('');
      const constraints = step.constraints
        .map(
          (c) =>
            `<p class="more ${c.effect === 'blocked' ? 'breaking' : 'unverified'}">${c.effect === 'blocked' ? 'Blocked: ' : 'Peer: '}${e(c.reason)}</p>`,
        )
        .join('');
      return `<section class="package" id="step-${step.order}"><header><h2>${step.order}. ${e(stepTitle(step))}</h2><span class="mono ${tone[step.effort]}">effort: ${e(step.effort)}</span></header>${constraints}${packages}</section>`;
    })
    .join('');
  const notPlanned = plan.notPlanned.length
    ? `<section class="package" id="not-planned"><header><h2>Not planned</h2></header>${plan.notPlanned
        .map((p) => `<p class="more">${e(p.name)} ${e(p.installed)}: ${e(p.reason)}</p>`)
        .join('')}</section>`
    : '';
  const when = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: opts.timeZone,
  }).format(new Date(opts.date));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>Uptide plan · ${e(opts.header?.repo ?? 'repository')}</title><style>${css}</style></head>
<body><main><header><div class="brand">UPTIDE / PLAN</div><h1>${e(opts.header?.repo ?? 'Upgrade plan')}</h1><div class="meta"><span>${e(opts.header?.manager ?? '')}</span><time datetime="${e(opts.date)}">${e(when)}</time><span>Uptide CLI ${e(opts.version)}</span><span>${elapsed(opts.header?.ms ?? 0)}</span></div><p class="muted">${plan.steps.length} ${plan.steps.length === 1 ? 'step' : 'steps'}, in the order to take them.${plan.notPlanned.length ? ` ${plan.notPlanned.length} not planned.` : ''}</p><p class="muted">${e(TIER_LEGEND)}</p></header>
${steps || '<p class="more safe">✓ Nothing to plan: every analyzed dependency is up to date.</p>'}${notPlanned}
<footer>Effort is an estimate from the findings: none (nothing affected), small (rules, or up to 5 sites by hand or agent), medium (up to 25), large (more). Local page · No network requests.</footer></main></body></html>`;
}

export function writePlanHtml(
  plan: UpgradePlan,
  opts: PlanHtmlOptions,
  path: string | true,
  cwd: string,
): string {
  const slug =
    (opts.header?.repo ?? 'repo').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'repo';
  const target =
    typeof path === 'string'
      ? resolve(cwd, path)
      : join(tmpdir(), 'uptide', `${slug}-plan-${Date.now()}.html`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderPlanHtml(plan, opts), {
    mode: 0o600,
    flag: typeof path === 'string' ? 'w' : 'wx',
  });
  return target;
}
