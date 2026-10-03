import { parentPort, workerData } from 'node:worker_threads';
import { errorCode } from '../errors.js';
import { checkWorkspaceJob, type WorkspaceJob } from './check.js';

/**
 * Worker-thread entry: one workspace, its own parsed program, its own registry memo.
 * Everything crossing the thread boundary is plain data (the job in, the reports out).
 */
const job = workerData as WorkspaceJob;
checkWorkspaceJob(job, (event) => parentPort?.postMessage({ type: 'progress', event })).then(
  (reports) => parentPort?.postMessage({ type: 'result', reports }),
  (err: unknown) => {
    parentPort?.postMessage({
      type: 'error',
      code: errorCode(err),
      message: err instanceof Error ? err.message : String(err),
    });
  },
);
