import {
  type Change,
  type CheckResult,
  cleanRuns,
  createNpmFetcher,
  diffPackage,
  type ErrorCode,
  type FixReport,
  openPr,
  type PrOptions,
  type ProgressEvent,
  type ProgressListener,
  type PublishTarget,
  publishTarget,
  typescriptAdapter,
  UptideError,
  updatePrBody,
  workerHeapMb,
} from '@uptide/core';
import {
  type CheckRequest,
  type FixRequest,
  type Job,
  type PlanResult,
  runJob,
  type VerifyRequest,
} from './jobs.js';

/** Kept injectable for CLI tests; provided by the engine's public export. */
export type UpdatePrBody = (opts: {
  pr: string;
  cwd: string;
  run?: string;
  preview?: boolean;
}) => Promise<{ body: string; updated: boolean; url: string }>;

/** The engine as the CLI uses it. Tests substitute an in-memory one. */
export interface Engine {
  check(request: CheckRequest, onProgress?: ProgressListener): Promise<CheckResult>;
  /** `check`, then the order to upgrade in with peer constraints and effort. */
  plan?(request: CheckRequest, onProgress?: ProgressListener): Promise<PlanResult>;
  fix(request: FixRequest, onProgress?: ProgressListener): Promise<FixReport>;
  /** Remove kept temporary clones older than `days`; lists what was removed and what remains. */
  clean?(days: number): { removed: string[]; kept: string[] };
  /** Verify the checked-out migration branch again and refresh its stored run. */
  verify?(request: VerifyRequest, onProgress?: ProgressListener): Promise<FixReport>;
  /** Where a `--pr` run will open its PR, resolved before any work: needs `gh` signed in. */
  publishTarget?(cwd: string, repo?: string): Promise<PublishTarget>;
  /** Push a finished run's branch and open its PR with the stored body. */
  pr?(
    request: PrOptions,
    print: (text: string) => void,
  ): Promise<{ url: string; report: FixReport }>;
  diff(name: string, from: string, to: string): Promise<Change[]>;
  /** The registry's `latest` for a package. */
  latest(name: string): Promise<string>;
  workspaces(root: string): Promise<string[]>;
  /** Direct dependencies of one package directory at their locked versions. */
  installed(dir: string): Promise<Map<string, string>>;
  /** Direct dependencies as written in package.json (`^3.23.8`, `catalog:`). */
  declared(dir: string): Promise<Map<string, string>>;
  updatePrBody?: UpdatePrBody;
}

/** Built: a worker thread next to this file. From source (tests, tsx) the job runs in place. */
async function offThread<T>(job: Job, onProgress?: ProgressListener): Promise<T> {
  const here = import.meta.url;
  if (here.endsWith('.ts')) return (await runJob(job, onProgress)) as T;
  const { Worker } = await import('node:worker_threads');
  return new Promise<T>((resolvePromise, reject) => {
    const worker = new Worker(new URL('./engine-worker.js', here), {
      workerData: job,
      // The job thread holds the programs of a single-package repository itself.
      resourceLimits: { maxOldGenerationSizeMb: workerHeapMb(1) },
    });
    let settled = false;
    worker.on(
      'message',
      (
        reply:
          | { type: 'progress'; event: ProgressEvent }
          | { ok: true; value: T }
          | { ok: false; message: string; code: ErrorCode },
      ) => {
        if ('type' in reply) {
          onProgress?.(reply.event);
          return;
        }
        settled = true;
        if (reply.ok) resolvePromise(reply.value);
        else reject(new UptideError(reply.code, reply.message));
      },
    );
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`analysis stopped unexpectedly (worker exit code ${code})`));
    });
  });
}

export function defaultEngine(): Engine {
  return {
    check: (request, onProgress) => offThread<CheckResult>({ kind: 'check', request }, onProgress),
    plan: (request, onProgress) => offThread<PlanResult>({ kind: 'plan', request }, onProgress),
    fix: (request, onProgress) => offThread<FixReport>({ kind: 'fix', request }, onProgress),
    verify: (request, onProgress) => offThread<FixReport>({ kind: 'verify', request }, onProgress),
    clean: (days) => cleanRuns({ days }),
    pr: (request, print) => openPr(request, print),
    publishTarget: (cwd, repo) => publishTarget(cwd, repo),
    diff: (name, from, to) => diffPackage({ name, from, to }),
    latest: (name) => createNpmFetcher().resolve(name, 'latest'),
    workspaces: async (root) =>
      (await typescriptAdapter.workspacePackages?.({ dir: root })) ?? ['.'],
    installed: async (dir) =>
      (await typescriptAdapter.installedDependencies?.({ dir })) ?? new Map<string, string>(),
    declared: async (dir) =>
      (await typescriptAdapter.declaredSpecifiers?.({ dir })) ?? new Map<string, string>(),
    updatePrBody,
  };
}
