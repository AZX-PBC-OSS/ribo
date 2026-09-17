import { expect, test } from "vitest";

import {
  chunkName,
  isChunkOf,
  MAX_CHUNK_INDEX,
  MAX_SLICE_INDEX,
  sliceOversized,
} from "./chunk-names.js";

test("names sort chronologically", () => {
  const names = [chunkName("s", 9, 0), chunkName("s", 10, 0), chunkName("s", 9, 1)];
  expect([...names].sort()).toEqual([
    chunkName("s", 9, 0),
    chunkName("s", 9, 1),
    chunkName("s", 10, 0),
  ]);
});

test("an index that would overflow fails loudly rather than sorting wrongly", () => {
  // Six digits is ~58 days at 5s, and two is 100 slices — ample, but "ample" is
  // not "impossible", and a silently wrong sort corrupts merge ORDER, which is
  // unrecoverable.
  expect(() => chunkName("s", MAX_CHUNK_INDEX + 1, 0)).toThrow(/overflow/i);
  expect(() => chunkName("s", 0, MAX_SLICE_INDEX + 1)).toThrow(/overflow/i);
});

test("chunks of one source are distinguishable from another's", () => {
  expect(isChunkOf(chunkName("abc", 1, 0), "abc")).toBe(true);
  expect(isChunkOf(chunkName("abc", 1, 0), "abd")).toBe(false);
});

test("an oversized blob slices into byte-identical parts that carry the MIME type", async () => {
  const blob = new Blob([new Uint8Array(2500)], { type: "audio/webm" });
  const parts = sliceOversized(blob, "audio/webm", 1000);
  expect(parts).toHaveLength(3);
  // Blob.slice() returns an empty type unless one is supplied, and RxDB rejects an
  // empty attachment content type.
  expect(parts.every((p) => p.type === "audio/webm")).toBe(true);
  const rejoined = new Uint8Array(await new Blob(parts).arrayBuffer());
  expect(rejoined).toEqual(new Uint8Array(await blob.arrayBuffer()));
});
