export interface ProgressEvent {
  phase:
    | 'resolve'
    | 'fetch'
    | 'diff'
    | 'usages'
    | 'compile'
    | 'runtime'
    | 'install'
    | 'rules'
    | 'assist'
    | 'verify';
  package?: string;
  workspace?: string;
  /** What exactly is being done: `types (core, ui, worker)`, `tests (ui)`, a site being migrated. */
  detail?: string;
  state: 'start' | 'done';
  ms?: number;
}
export type ProgressListener = (event: ProgressEvent) => void;
/** End events are paired even on failure; they describe elapsed work, not success. */
export async function progress<T>(
  listener: ProgressListener | undefined,
  event: Omit<ProgressEvent, 'state' | 'ms'>,
  work: () => T | Promise<T>,
): Promise<T> {
  const start = performance.now();
  listener?.({ ...event, state: 'start' });
  try {
    return await work();
  } finally {
    listener?.({ ...event, state: 'done', ms: performance.now() - start });
  }
}
