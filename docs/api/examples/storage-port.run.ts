/**
 * The runnable example behind docs/api/storage-port.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: the backend under test is core's
 * in-memory one — the same kit the RxDB backend passes in its own browser
 * tests.
 */

import assert from "node:assert/strict";
import {
  createMemoryBackend,
  removeMemoryDatabase,
  type StorageBackend,
  type StoredDocument,
} from "@azx/ribo-core";
import {
  defineStorageConformanceCases,
  type ConformanceCase,
  type Expect,
} from "@azx/ribo-core/testing";

/**
 * The kit's assertion seam, built on `node:assert/strict` — what a backend
 * author on any runner supplies instead of importing one. The kit needs only
 * `toBe`, `toEqual` and `toBeUndefined`.
 */
const expect: Expect = (actual: unknown) => ({
  toBe: (expected: unknown) => assert.equal(actual, expected),
  toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
  toBeUndefined: () => assert.equal(actual, undefined),
});

const subject = {
  createBackend: (databaseName: string): Promise<StorageBackend> =>
    Promise.resolve(createMemoryBackend(databaseName)),
  makeCapture: ({ id, seq, status, sessionId, removable }): StoredDocument => ({
    id,
    seq,
    status,
    sessionId,
    ...(removable === undefined ? {} : { removable }),
  }),
  // The memory backend validates nothing, so any field is removable; a
  // validating backend must name one its schema allows deleting.
  removableCaptureField: "removable",
  makeSession: ({ id, status, openedAt, ref }): StoredDocument => ({ id, status, openedAt, ref }),
  makeEntry: ({ id, scopeKind, scopeId, owner, key, value }): StoredDocument => ({
    id,
    scopeKind,
    scopeId,
    owner,
    key,
    value,
  }),
} satisfies Parameters<typeof defineStorageConformanceCases>[0];

export async function everyConformanceCaseHoldsForTheBackend(): Promise<void> {
  // #region usage
  const cases: readonly ConformanceCase[] = defineStorageConformanceCases(subject, expect);
  for (const conformanceCase of cases) {
    await conformanceCase.run();
  }
  // #endregion usage

  // A vacuous pass is not a pass: the kit is only evidence if the cases ran.
  assert.ok(cases.length > 0);
}

export async function thePortNamesThreeCollectionsAndAClosedFinderSet(): Promise<void> {
  const backend = await subject.createBackend(`docs-port-${crypto.randomUUID()}`);
  try {
    // The finders are three, and that is the whole set: no selector language
    // crosses the boundary.
    await backend.insert("captures", { id: "cap-1", seq: 0, status: "queued" });
    const found = await backend.find("captures", { status: ["queued"], limit: 10 });
    assert.equal(found.length, 1);

    // insertNext allocates the sequence atomically — the port takes the
    // field's name, not its schema.
    const inserted = await backend.insertNext("captures", "seq", {
      id: "cap-2",
      status: "queued",
    });
    assert.equal(inserted.seq, 1);
  } finally {
    await backend.close();
    removeMemoryDatabase(`docs-port-${crypto.randomUUID()}`);
  }
}

export async function blobsGoInSameWriteAndAreDescribedNeverMaterialised(): Promise<void> {
  const name = `docs-port-${crypto.randomUUID()}`;
  const backend = await subject.createBackend(name);
  try {
    await backend.insert("captures", { id: "cap-1", seq: 0, status: "queued" }, [
      { id: "audio", data: new Blob(["not really audio"]) },
    ]);

    // listBlobs answers ids and lengths, never bytes.
    const descriptors = await backend.listBlobs("captures", "cap-1");
    assert.deepEqual(
      descriptors.map((descriptor) => [descriptor.id, descriptor.length]),
      [["audio", 16]],
    );

    const bytes = await backend.getBlob("captures", "cap-1", "audio");
    assert.equal((await bytes?.arrayBuffer())?.byteLength, 16);
  } finally {
    await backend.close();
    removeMemoryDatabase(name);
  }
}
