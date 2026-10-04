import { parentPort, workerData } from 'node:worker_threads';
import { parseSource, type SourceJob } from './source.js';

const { jobs, names } = workerData as { jobs: SourceJob[]; names: string[] };
parentPort?.postMessage(jobs.map((job) => [...parseSource(job, names)]));
