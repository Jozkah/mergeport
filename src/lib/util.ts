/** Bounded concurrency map. Errors reject the whole run after in-flight work settles. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (failure === undefined) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
        await new Promise<void>((r) => setImmediate(r)); // let waiting page requests run between items of a long job
      } catch (e) {
        failure = e ?? new Error("failed");
      }
    }
  });
  await Promise.all(workers);
  if (failure !== undefined) throw failure;
  return results;
}

export const cn = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
