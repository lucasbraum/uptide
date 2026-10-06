/**
 * State shared by every package analyzed in one process: TypeScript's printer, the consumer
 * repository's program and checker, caches of surfaces and parsed files. A failure inside a
 * package's analysis (a stack overflow, mid-print or mid-check) can leave any of it half
 * written, and the next package would then read it silently: on main, a package checked
 * after `@types/node`'s overflow got signatures prefixed with Node's `assert` types. Each
 * module registers how to discard what it holds; `check` resets everything after a failure.
 */
const resets: (() => void)[] = [];

/** Registers how to discard one piece of shared state; it is rebuilt on next use. */
export function onReset(reset: () => void): void {
  resets.push(reset);
}

/** Discards every piece of shared state: after it, the next package starts as in a new process. */
export function resetSharedState(): void {
  for (const reset of resets) reset();
}
