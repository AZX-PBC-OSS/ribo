/**
 * The scaffolding smoke example — the skeleton every real example package
 * copies. Its one job is to prove the `examples/*` wiring end to end: this
 * file imports `@azx/ribo-core` by package name, so it can only type-check
 * (through `@azx/tsconfig`'s `@azx/source` condition) and run (through the
 * unit project's `ssr.resolve.conditions`) if by-name workspace resolution
 * reaches an example package. The body is the smallest real, credential-free
 * round trip: open a store over the in-memory backend, assert it is live,
 * close it, assert it is closed.
 */

import assert from "node:assert/strict";
import { createMemoryBackend, openStorage } from "@azx/ribo-core";

// #region smoke-opens-and-closes
export async function smokeOpensAndClosesInMemoryStorage(): Promise<void> {
  const storage = await openStorage({
    backend: createMemoryBackend(`example-smoke-${crypto.randomUUID()}`),
  });
  assert.equal(storage.closed, false);
  await storage.close();
  assert.equal(storage.closed, true);
}
// #endregion smoke-opens-and-closes
