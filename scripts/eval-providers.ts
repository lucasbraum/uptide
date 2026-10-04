/** Opt-in live probe/eval. Never run in CI. Keys are read only from the environment.
 * pnpm exec tsx scripts/eval-providers.ts --smoke --provider=anthropic --model=claude-sonnet-5-5
 * pnpm exec tsx scripts/eval-providers.ts --repo=/scratch/storefront --provider=anthropic --model=claude-sonnet-5-5 --only=zod --effort=medium
 */
import { execFileSync } from 'node:child_process';
import { constants, cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fix, KEY_ENV, providerFixer, selectLlm } from '@uptide/core';
import { workspacePackagesOf } from '../packages/core/src/adapters/typescript/repo.js';
import type { Fixer, FixRequest, FixResponse } from '../packages/core/src/fix/types.js';
import { modelCapabilities } from '../packages/core/src/llm/capabilities.js';
import { nanos } from '../packages/core/src/llm/pricing.js';

const value = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const selection = selectLlm(value('repo') ?? process.cwd(), {
  provider: value('provider'),
  model: value('model'),
});
const effort = value('effort');
if (effort && !['low', 'medium', 'high'].includes(effort))
  throw new Error('effort must be low, medium or high');
const base = {
  provider: selection.provider,
  requestedModel: selection.model,
  effort:
    effort ?? modelCapabilities(selection.provider, selection.model).defaultEffort ?? 'API default',
};
const emit = (metrics: Record<string, unknown>) =>
  process.stdout.write(`UPTIDE_EVAL=${JSON.stringify({ ...base, ...metrics })}\n`);
if (!selection.available) {
  emit({ status: 'missing-key', variable: KEY_ENV[selection.provider] });
  process.exit(2);
}
// Each request gets its own reservation in the product; the probe uses the same $1 ceiling.
const httpStatuses: number[] = [];
const errorTypes: string[] = [];
const fetcher: typeof fetch = async (url, options) => {
  const response = await fetch(url, options);
  httpStatuses.push(response.status);
  if (!response.ok) {
    const body = await response
      .clone()
      .json()
      .catch(() => ({}));
    const type = body?.error?.type ?? body?.error?.status ?? body?.error?.code;
    const known = [
      'not_found_error',
      'invalid_request_error',
      'authentication_error',
      'permission_error',
      'rate_limit_error',
      'RESOURCE_EXHAUSTED',
      'UNAVAILABLE',
      'NOT_FOUND',
      'INVALID_ARGUMENT',
      'PERMISSION_DENIED',
      'UNAUTHENTICATED',
      'model_not_found',
      'insufficient_quota',
    ];
    if (known.includes(type)) errorTypes.push(type);
  }
  return response;
};
const agent = providerFixer(selection, {
  fetch: fetcher,
  effort: effort as 'low' | 'medium' | 'high' | undefined,
});
if (!agent) throw new Error('Selected environment key is unavailable');
const responses: FixResponse[] = [];
const requests: { reservationUsd: number; seconds: number }[] = [];
const traced: Fixer = {
  ...agent,
  async fix(request, remaining) {
    const start = performance.now();
    const reservationUsd = agent.estimate?.(request) ?? 0;
    const response = await agent.fix(request, remaining);
    requests.push({ reservationUsd, seconds: (performance.now() - start) / 1000 });
    responses.push(response);
    return response;
  },
};
const metrics = () => ({
  echoedModels: [...new Set(responses.flatMap((r) => (r.responseModel ? [r.responseModel] : [])))],
  attempts: responses.length,
  noToolCalls: responses.filter((r) => r.failureKind === 'no-tool-call').length,
  noToolCallRate: responses.length
    ? responses.filter((r) => r.failureKind === 'no-tool-call').length / responses.length
    : null,
  rateLimited: responses.filter((r) => r.failureKind === 'rate-limited').length,
  httpStatuses,
  errorTypes,
  spendUsd: responses.reduce((n, r) => n + (r.costUsd ?? 0), 0),
  reservationSumUsd: requests.reduce((n, r) => n + r.reservationUsd, 0),
  unreportedReservationUsd: responses.reduce((n, r) => n + (r.unreportedCostUsd ?? 0), 0),
  calls: responses.map((r, i) => ({
    ...requests[i],
    echoedModel: r.responseModel ?? null,
    failureKind: r.failureKind ?? null,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    spendUsd: r.costUsd ?? 0,
    unreportedReservationUsd: r.unreportedCostUsd ?? 0,
  })),
});
const start = performance.now();
try {
  if (process.argv.includes('--smoke')) {
    const request = {
      finding: {
        change: {
          package: 'zod',
          from: '3.23.8',
          to: '4.6.5',
          path: 'string',
          kind: 'type',
          severity: 'breaking',
          source: 'types',
          confidence: 1,
        },
        usage: { file: 'smoke.ts', line: 1, column: 1, snippet: 'const value = 1;' },
        severity: 'breaking',
        confidence: 1,
      },
      source: 'const value = 1;',
      enclosingFunction: 'const value = 1;',
      compilerError: 'Protocol smoke only; no patch needed.',
      guide:
        'This is a protocol smoke test. Call submit_patch with an empty diff and the explanation "smoke". No analysis or source edit is needed.',
    } as FixRequest;
    let spent = 0;
    let last: FixResponse | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = (1e9 - spent) / 1e9;
      if (nanos(agent.estimate?.(request) ?? 0) > Math.floor(remaining * 1e9)) break;
      last = await traced.fix(request, remaining);
      spent += nanos(last.costUsd ?? 0) + nanos(last.unreportedCostUsd ?? 0);
      if (last.failureKind !== 'rate-limited' || attempt === 2) break;
      let wait = last.retryAfterMs ?? 60000;
      emit({ status: 'rate-limited', attempt: attempt + 1, waitMs: wait });
      while (wait > 0) {
        const ms = Math.min(60000, wait);
        await delay(ms);
        wait -= ms;
      }
    }
    emit({
      kind: 'smoke',
      status: !last ? 'budget-stopped' : (last.failureKind ?? 'passed'),
      ...metrics(),
      seconds: (performance.now() - start) / 1000,
    });
  } else {
    const source = value('repo'),
      only = value('only');
    if (!source || (only !== 'zod' && only !== 'stripe'))
      throw new Error('eval requires --repo and --only=zod|stripe');
    // A separate local clone per run, including dependencies copied with clone-on-write when available.
    const parent = mkdtempSync(join(tmpdir(), 'uptide-provider-eval-'));
    const cwd = join(parent, 'repo');
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--no-hardlinks', source, cwd],
      { stdio: 'pipe' },
    );
    for (const workspace of workspacePackagesOf(source)) {
      const modules = join(source, workspace, 'node_modules');
      if (existsSync(modules))
        cpSync(modules, join(cwd, workspace, 'node_modules'), {
          recursive: true,
          verbatimSymlinks: true,
          mode: constants.COPYFILE_FICLONE,
        });
    }
    const report = await fix({
      cwd,
      only,
      target: value('target'),
      fixer: traced,
      provider: selection.provider,
      model: selection.model,
      maxCostUsd: 1,
      tool: { uptideVersion: '0.1.0', uptideCommit: 'live-eval', uptideDirty: true },
    });
    emit({
      kind: 'eval',
      package: only,
      target: report.target,
      status: 'completed',
      verified: report.verification.passed,
      agentSites: report.sites.filter((s) => s.outcome === 'agent').length,
      mechanicalSites: report.sites.filter((s) => s.outcome === 'mechanical').length,
      manualSites: report.sites.filter((s) => s.outcome === 'manual').length,
      newErrors: report.verification.newErrors.length,
      tests: report.verification.tests.map((t) => ({ status: t.status, summary: t.summary })),
      ...metrics(),
      seconds: (performance.now() - start) / 1000,
    });
  }
} catch (error) {
  let diagnostic = error instanceof Error ? error.message : 'Unknown failure';
  for (const name of Object.values(KEY_ENV)) {
    const key = process.env[name];
    if (key) diagnostic = diagnostic.replaceAll(key, '[redacted]');
  }
  emit({
    diagnostic: diagnostic.slice(0, 2000),
    status: 'run-error',
    ...metrics(),
    seconds: (performance.now() - start) / 1000,
  });
  process.exitCode = 1;
}
