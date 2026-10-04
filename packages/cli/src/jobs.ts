import {
  type CheckOptions,
  type CheckReport,
  type CheckResult,
  check,
  type FixReport,
  isolatedFix,
  isolatedVerify,
  type ProgressListener,
  type UpgradePlan,
  upgradePlan,
} from '@uptide/core';

/** Plain data only: a request crosses into a worker thread and its result comes back. */
export type CheckRequest = Pick<
  CheckOptions,
  | 'cwd'
  | 'targets'
  | 'only'
  | 'compile'
  | 'runtime'
  | 'allDeps'
  | 'workspaceConcurrency'
  | 'maxTimeMs'
> & { checkResults?: CheckReport };

export interface FixRequest {
  provider?: string;
  model?: string;
  cwd: string;
  only: string;
  /** `--max-cost`: where the agent stops, in USD. */
  maxCostUsd?: number;
  target?: string;
  includeDeprecated?: boolean;
  /** `--pin-current-api`: stripe stays; the SDK's default apiVersion is written on every client. */
  pinCurrentApi?: boolean;
  pr?: boolean;
  yes?: boolean;
  /** False with `--no-llm`: no fixer is created, so no code can leave the machine. */
  llm: boolean;
  /** `--with-services`: also run tests that need a database, a cache or a queue. */
  withServices?: boolean;
  /** `--keep`: leave the temporary clone in place after the run. */
  keep?: boolean;
}

export interface VerifyRequest {
  cwd: string;
  /** The migration branch; default: the one checked out. */
  branch?: string;
  withServices?: boolean;
  /** Push the new commits from the clone to origin, fast-forward only. Needs `yes`. */
  push?: boolean;
  yes?: boolean;
  /** `--keep`: leave the temporary clone in place after the run. */
  keep?: boolean;
}

export interface PlanResult {
  report: CheckResult;
  plan: UpgradePlan;
}

export type Job =
  | { kind: 'check'; request: CheckRequest }
  | { kind: 'plan'; request: CheckRequest }
  | { kind: 'fix'; request: FixRequest }
  | { kind: 'verify'; request: VerifyRequest };
export type JobResult<J extends Job> = J extends { kind: 'check' } ? CheckResult : FixReport;

export async function runJob(
  job: Job,
  onProgress?: ProgressListener,
): Promise<CheckResult | FixReport | PlanResult> {
  if (job.kind === 'check') return check({ ...job.request, onProgress });
  if (job.kind === 'plan') return upgradePlan({ ...job.request, onProgress });
  // Both run in a private clone: the user's checkout is never the place where anything happens.
  if (job.kind === 'verify') return isolatedVerify({ ...job.request, onProgress });
  const { llm, ...options } = job.request;
  // `fixer: null` is the engine's "no assistant at all", whatever the environment holds.
  return isolatedFix({ ...options, onProgress, ...(llm ? {} : { fixer: null }) });
}
