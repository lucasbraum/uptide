import { parentPort, workerData } from 'node:worker_threads';
import { errorCode } from '@uptide/core';
import { explain } from './errors.js';
import { type Job, runJob } from './jobs.js';

/**
 * The engine parses and type-checks synchronously for seconds at a time. Here it does so
 * off the main thread, which stays free to draw progress. Error classes do not survive
 * the thread boundary, so the message is put into words on this side.
 */
runJob(workerData as Job, (event) => parentPort?.postMessage({ type: 'progress', event })).then(
  (value) => parentPort?.postMessage({ ok: true, value }),
  (err: unknown) =>
    parentPort?.postMessage({ ok: false, message: explain(err), code: errorCode(err) }),
);
