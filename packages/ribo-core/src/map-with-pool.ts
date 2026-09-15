/**
 * @file The bounded-concurrency worker pool shared by every multi-call extractor.
 *
 * Moved here from `ribo-extractor-openai`, where it existed as two byte-identical
 * copies (`per-group.ts` and `instance-fill.ts`) and a third was about to be born
 * inside `groupedExtractor` — see `per-group-composition-design.md` §2.5. Core is
 * the neutral home: the pool speaks only `Promise`s and `AbortSignal`s, no chat
 * vocabulary, and every package that schedules extraction calls already depends on
 * core.
 */

/**
 * Run `fn` over `items` with at most `limit` calls in flight at once, preserving
 * order. Rejects on the first failure (via `Promise.all`): any group failing
 * fails the extraction, so the first rejection is the extraction's rejection.
 *
 * **Stops pulling new work after a failure.** When any worker's `fn` rejects,
 * the `failed` flag is set and `abort.abort()` is called. Other workers check
 * the flag (or the aborted signal) before pulling the next item and return
 * immediately — so a failing extraction does not start every remaining group's
 * call. Without this, workers kept pulling from the queue after a sibling
 * rejected, and those calls outlived the rejected `extract()`. That was a
 * minor waste before retries and a real problem once retries multiplied the
 * call count.
 *
 * **Aborts in-flight calls.** The `AbortController` is shared with `fn` via the
 * caller's closure, which passes the signal into whatever work `fn` performs
 * (a chat call, a group extractor's `extract()`). When a worker fails and calls
 * `abort.abort()`, in-flight work in other workers rejects, and the retry loops
 * do not retry an aborted call. This prevents calls from outliving the rejected
 * `extract()` — both new work (stopped by the flag) and in-flight work
 * (cancelled by the signal).
 */
export async function mapWithPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  abort: AbortController,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      // Stop pulling new work after any worker has failed. The abort signal
      // cancels in-flight calls in other workers; this check stops workers
      // that are between calls from starting new ones.
      if (failed || abort.signal.aborted) return;
      const index = next++;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (cause) {
        if (!failed) {
          failed = true;
          abort.abort();
        }
        throw cause;
      }
    }
  };
  const size = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: size }, () => worker()));
  return results;
}
