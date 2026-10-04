/** Runs `tasks` with at most `limit` in flight, preserving order of results. */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await task(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Retry memory-constrained jobs only after all parallel programs have released their
 * reservations. The retry callback receives the full serial budget from the caller. */
export async function mapWithSerialRetry<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
  shouldRetry: (result: R) => boolean,
  retry: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = await mapWithLimit(items, limit, task);
  if (limit > 1)
    for (let i = 0; i < items.length; i++)
      if (shouldRetry(results[i] as R)) results[i] = await retry(items[i] as T);
  return results;
}
