/**
 * @file A stable identity for a query object, for `useMemo`/`useEffect` deps.
 *
 * Both list hooks take a query and subscribe to the outbox with it. A caller
 * writes `useSessions({ status: "open" })` — a new object literal on every
 * render — so depending on the object itself would tear the subscription down
 * and rebuild it on each one. The hooks therefore memoise on a serialised form.
 *
 * **The serialisation must be derived, never enumerated.** Both hooks used to
 * hand-list the fields they knew about and then rebuild the query by parsing
 * that key back, which made the key the sole definition of what a query is: a
 * field nobody remembered to add was silently dropped on the way to the outbox.
 * `SessionQuery.ref` shipped that way, and every consumer of `useSessions` got
 * every session on the device and filtered client-side.
 *
 * Keys are sorted so two equal queries written in different orders memoise the
 * same, and `undefined` values are dropped so an explicitly-absent field and an
 * omitted one agree.
 */

/** A canonical string for a query object — equal queries produce equal strings. */
export function queryKey(query: object): string {
  const entries = Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/** Rebuild the query a {@link queryKey} was made from. */
export function queryFromKey<T>(key: string): T {
  return Object.fromEntries(JSON.parse(key) as [string, unknown][]) as T;
}
