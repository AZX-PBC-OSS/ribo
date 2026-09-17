import type { Subscription } from "rxjs";

import type { EntryScopeKind, StorageBackend, StoredDocument } from "./port.js";

/**
 * @file The storage port's conformance kit — the contract made executable.
 *
 * A backend that satisfies `StorageBackend`'s types and fails this suite is not
 * an implementation of the port. The six obligations in
 * `docs/roadmap/design/storage-port-design.md` §4.2 are behaviours no signature
 * can express, and four of them are things a backend gets *wrong* in a way that
 * looks right: publishing a document before its blob, a reactive query that only
 * sees its own handle's writes, a last-write-wins "modify", and a sequence
 * allocator that races.
 *
 * Framework-agnostic on purpose. It imports no test runner; `describe`, `it` and
 * `expect` arrive as arguments, so a backend author on any runner can use it and
 * this package needs no test-framework peer dependency.
 */

/** The subset of a matcher API this kit uses. Structural, so any runner's `expect` satisfies it. */
export interface Expectation {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
  toBeUndefined: () => void;
}

/** The subset of a runner this kit uses. */
export interface ConformanceRunner {
  describe: (name: string, body: () => void) => void;
  it: (name: string, body: () => Promise<void> | void) => void;
  expect: (actual: unknown) => Expectation;
}

/**
 * Document factories, supplied by the backend under test.
 *
 * The kit does not know what a valid document looks like — a backend may be
 * validating against a JSON schema with required fields the kit has never heard
 * of. Each factory takes the fields the kit needs to *control* (the ones the
 * finders filter and order on) and fills in whatever else its storage demands.
 */
export interface ConformanceDocuments {
  makeCapture: (fields: {
    id: string;
    seq: number;
    status: string;
    sessionId: string;
  }) => StoredDocument;
  makeSession: (fields: {
    id: string;
    status: string;
    openedAt: string;
    ref: string;
  }) => StoredDocument;
  makeEntry: (fields: {
    id: string;
    scopeKind: EntryScopeKind;
    scopeId: string;
    owner: string;
    key: string;
    value: string;
  }) => StoredDocument;
}

/** Everything the kit needs from the backend under test. */
export interface ConformanceHarness extends ConformanceRunner, ConformanceDocuments {
  /**
   * Open a backend on a given database name. Called more than once with the same
   * name by the cross-context test, which requires the two handles to share
   * durable state — if this returns the same object both times, that test is
   * vacuous and proves nothing.
   */
  createBackend: (databaseName: string) => Promise<StorageBackend>;
}

/** Collect a blob's size without assuming a runtime `Blob.size` shortcut is honest. */
async function byteLength(blob: Blob): Promise<number> {
  return (await blob.arrayBuffer()).byteLength;
}

/** Wait for `predicate` to hold, polling the microtask/macrotask queue. Rejects on timeout. */
async function until(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`conformance: timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Run the conformance suite against one backend.
 *
 * `label` names the backend in test output, so a repo running this against two
 * backends gets two distinguishable suites.
 */
export function runStorageConformance(label: string, harness: ConformanceHarness): void {
  const { describe, it, expect, createBackend, makeCapture, makeSession, makeEntry } = harness;

  // Every test gets its own database name. Backends are durable by definition, so
  // sharing one would let an earlier test's rows decide a later test's assertions.
  let counter = 0;
  const freshName = (): string => `conformance-${label}-${Date.now()}-${counter++}`;

  const withBackend = async (body: (backend: StorageBackend) => Promise<void>): Promise<void> => {
    const backend = await createBackend(freshName());
    try {
      await body(backend);
    } finally {
      await backend.close();
    }
  };

  describe(`storage port conformance: ${label}`, () => {
    // ---------------------------------------------------------------------
    // The finders. Filter, order and limit — the whole query surface.
    // ---------------------------------------------------------------------

    it("finds captures by status, ordered by sequence ascending", async () => {
      await withBackend(async (backend) => {
        // Inserted out of sequence order, so a backend that returns insertion
        // order rather than sorting fails here.
        for (const [seq, status] of [
          [3, "queued"],
          [1, "queued"],
          [2, "transcribed"],
        ] as const) {
          await backend.insert(
            "captures",
            makeCapture({ id: `c${seq}`, seq, status, sessionId: "s1" }),
          );
        }

        const all = await backend.find("captures", {});
        expect(all.map((doc) => doc.seq)).toEqual([1, 2, 3]);

        const queued = await backend.find("captures", { status: ["queued"] });
        expect(queued.map((doc) => doc.id)).toEqual(["c1", "c3"]);

        const limited = await backend.find("captures", { limit: 2 });
        expect(limited.map((doc) => doc.seq)).toEqual([1, 2]);
      });
    });

    it("finds captures by session id", async () => {
      await withBackend(async (backend) => {
        await backend.insert(
          "captures",
          makeCapture({ id: "a", seq: 1, status: "queued", sessionId: "s1" }),
        );
        await backend.insert(
          "captures",
          makeCapture({ id: "b", seq: 2, status: "queued", sessionId: "s2" }),
        );

        const found = await backend.find("captures", { sessionId: "s2" });
        expect(found.length).toBe(1);
        expect(found[0]?.id).toBe("b");
      });
    });

    it("finds sessions by status and ref, ordered by opened-at ascending", async () => {
      await withBackend(async (backend) => {
        await backend.insert(
          "sessions",
          makeSession({
            id: "s2",
            status: "open",
            openedAt: "2026-01-02T00:00:00.000Z",
            ref: "j1",
          }),
        );
        await backend.insert(
          "sessions",
          makeSession({
            id: "s1",
            status: "open",
            openedAt: "2026-01-01T00:00:00.000Z",
            ref: "j2",
          }),
        );
        await backend.insert(
          "sessions",
          makeSession({
            id: "s3",
            status: "done",
            openedAt: "2026-01-03T00:00:00.000Z",
            ref: "j1",
          }),
        );

        const all = await backend.find("sessions", {});
        expect(all.map((doc) => doc.id)).toEqual(["s1", "s2", "s3"]);

        const open = await backend.find("sessions", { status: ["open"] });
        expect(open.map((doc) => doc.id)).toEqual(["s1", "s2"]);

        const byRef = await backend.find("sessions", { ref: "j1" });
        expect(byRef.map((doc) => doc.id)).toEqual(["s2", "s3"]);
      });
    });

    it("finds entries by scope and owner, ordered by key ascending", async () => {
      await withBackend(async (backend) => {
        const entry = (owner: string, scopeId: string, key: string): StoredDocument =>
          makeEntry({
            id: `${owner}:${scopeId}:${key}`,
            scopeKind: "capture",
            scopeId,
            owner,
            key,
            value: `${key}-value`,
          });

        await backend.insert("entries", entry("pdfjs", "cap1", "zebra"));
        await backend.insert("entries", entry("pdfjs", "cap1", "alpha"));
        await backend.insert("entries", entry("other", "cap1", "beta"));
        await backend.insert("entries", entry("pdfjs", "cap2", "gamma"));

        const scoped = await backend.find("entries", {
          scopeKind: "capture",
          scopeId: "cap1",
          owner: "pdfjs",
        });
        expect(scoped.map((doc) => doc.key)).toEqual(["alpha", "zebra"]);

        const wholeScope = await backend.find("entries", { scopeKind: "capture", scopeId: "cap1" });
        expect(wholeScope.length).toBe(3);

        const wholeOwner = await backend.find("entries", { owner: "pdfjs" });
        expect(wholeOwner.length).toBe(3);
      });
    });

    // ---------------------------------------------------------------------
    // Obligation 1 — insert-with-blobs is ONE write.
    // ---------------------------------------------------------------------

    it("never publishes a document before its blob is readable (obligation 1)", async () => {
      await withBackend(async (backend) => {
        const audio = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: "audio/webm" });

        // The subscription is the whole test. Insert-then-read would pass against
        // a backend that writes the document and the blob in two steps; only
        // observing the FIRST emission that contains the document catches it.
        let firstSighting: Promise<Blob | undefined> | undefined;
        const subscription: Subscription = backend.watch("captures", {}).subscribe((documents) => {
          if (firstSighting !== undefined) return;
          if (documents.some((doc) => doc.id === "withAudio")) {
            firstSighting = backend.getBlob("captures", "withAudio", "audio");
          }
        });

        try {
          await backend.insert(
            "captures",
            makeCapture({ id: "withAudio", seq: 1, status: "queued", sessionId: "s1" }),
            [{ id: "audio", data: audio }],
          );

          await until(() => firstSighting !== undefined, "the capture to be published");

          const seen = await firstSighting;
          if (seen === undefined) {
            throw new Error(
              "obligation 1 violated: the capture was published before its blob was readable",
            );
          }
          expect(await byteLength(seen)).toBe(5);
        } finally {
          subscription.unsubscribe();
        }
      });
    });

    // ---------------------------------------------------------------------
    // Obligation 2 — reactive finders see other contexts' writes.
    // ---------------------------------------------------------------------

    it("publishes writes made through a different handle on the same database (obligation 2)", async () => {
      const name = freshName();
      const one = await createBackend(name);
      const two = await createBackend(name);

      try {
        const seen: string[][] = [];
        const subscription = one
          .watch("captures", {})
          .subscribe((documents) => seen.push(documents.map((doc) => doc.id)));

        try {
          await two.insert(
            "captures",
            makeCapture({ id: "fromTwo", seq: 1, status: "queued", sessionId: "s1" }),
          );

          await until(
            () => seen.some((ids) => ids.includes("fromTwo")),
            "handle one to observe handle two's write",
          );
        } finally {
          subscription.unsubscribe();
        }
      } finally {
        await one.close();
        await two.close();
      }
    });

    // ---------------------------------------------------------------------
    // Obligation 3 — modify is conflict-safe.
    // ---------------------------------------------------------------------

    it("loses neither of two concurrent modifies (obligation 3)", async () => {
      await withBackend(async (backend) => {
        await backend.insert(
          "captures",
          makeCapture({ id: "contended", seq: 1, status: "queued", sessionId: "s1" }),
        );

        // Both read the same starting document, so a last-write-wins
        // implementation drops whichever lands first.
        await Promise.all([
          backend.modify("captures", "contended", (current) => ({ ...current, status: "failed" })),
          backend.modify("captures", "contended", (current) => ({ ...current, attempts: 7 })),
        ]);

        const after = await backend.get("captures", "contended");
        expect(after?.status).toBe("failed");
        expect(after?.attempts).toBe(7);
      });
    });

    // ---------------------------------------------------------------------
    // Obligation 4 — blob listing reads lengths, not bytes.
    // ---------------------------------------------------------------------

    it("lists blobs as ids and lengths without materialising bytes (obligation 4)", async () => {
      await withBackend(async (backend) => {
        await backend.insert(
          "captures",
          makeCapture({ id: "chunked", seq: 1, status: "recording", sessionId: "s1" }),
        );
        await backend.putBlob(
          "captures",
          "chunked",
          "chunk-0",
          new Blob([new Uint8Array(10)], { type: "audio/webm" }),
        );
        await backend.putBlob(
          "captures",
          "chunked",
          "chunk-1",
          new Blob([new Uint8Array(20)], { type: "audio/webm" }),
        );

        const listed = await backend.listBlobs("captures", "chunked");
        const sorted = [...listed].sort((a, b) => a.id.localeCompare(b.id));

        expect(sorted.map((blob) => blob.id)).toEqual(["chunk-0", "chunk-1"]);
        expect(sorted.map((blob) => blob.length)).toEqual([10, 20]);

        // A descriptor carrying bytes would make `audioBytes` a memory bomb on a
        // full queue, so the absence of the data is part of the contract.
        for (const descriptor of sorted) {
          expect(Object.keys(descriptor).sort()).toEqual(["id", "length"]);
        }
      });
    });

    // ---------------------------------------------------------------------
    // Obligation 5 — documents come back clean.
    // ---------------------------------------------------------------------

    it("returns documents with no backend metadata (obligation 5)", async () => {
      await withBackend(async (backend) => {
        const document = makeCapture({ id: "clean", seq: 1, status: "queued", sessionId: "s1" });
        await backend.insert("captures", document);

        // Core's document schemas are `strictObject`, so a stray `_rev` or
        // `_meta` is not cosmetic — it throws at the parse boundary.
        const expected = Object.keys(document).sort();
        expect(Object.keys((await backend.get("captures", "clean")) ?? {}).sort()).toEqual(
          expected,
        );
        expect(Object.keys((await backend.find("captures", {}))[0] ?? {}).sort()).toEqual(expected);

        const modified = await backend.modify("captures", "clean", (current) => {
          // The modifier sees the same clean shape, which is what lets a facade
          // hand its result straight to zod.
          expect(Object.keys(current).sort()).toEqual(expected);
          return { ...current, status: "transcribed" };
        });
        expect(Object.keys(modified).sort()).toEqual(expected);
      });
    });

    // ---------------------------------------------------------------------
    // Obligation 6 — sequence allocation is atomic.
    // ---------------------------------------------------------------------

    it("allocates distinct consecutive sequences under concurrency (obligation 6)", async () => {
      await withBackend(async (backend) => {
        const count = 12;
        const inserted = await Promise.all(
          Array.from({ length: count }, (_unused, index) =>
            backend.insertNext(
              "captures",
              "seq",
              makeCapture({ id: `race-${index}`, seq: 0, status: "queued", sessionId: "s1" }),
            ),
          ),
        );

        const sequences = inserted.map((doc) => doc.seq as number).sort((a, b) => a - b);
        expect(new Set(sequences).size).toBe(count);
        expect(sequences).toEqual(Array.from({ length: count }, (_unused, index) => index + 1));
      });
    });

    it("continues the sequence from what is already stored", async () => {
      await withBackend(async (backend) => {
        await backend.insert(
          "captures",
          makeCapture({ id: "existing", seq: 41, status: "queued", sessionId: "s1" }),
        );

        const next = await backend.insertNext(
          "captures",
          "seq",
          makeCapture({ id: "next", seq: 0, status: "queued", sessionId: "s1" }),
        );
        expect(next.seq).toBe(42);
      });
    });

    // ---------------------------------------------------------------------
    // The mechanical remainder.
    // ---------------------------------------------------------------------

    it("round-trips a document and reports a missing one as undefined", async () => {
      await withBackend(async (backend) => {
        await backend.insert(
          "captures",
          makeCapture({ id: "here", seq: 1, status: "queued", sessionId: "s1" }),
        );
        expect((await backend.get("captures", "here"))?.id).toBe("here");
        expect(await backend.get("captures", "absent")).toBeUndefined();
      });
    });

    it("upserts by primary key", async () => {
      await withBackend(async (backend) => {
        const first = makeCapture({ id: "up", seq: 1, status: "queued", sessionId: "s1" });
        await backend.upsert("captures", first);
        await backend.upsert("captures", { ...first, status: "transcribed" });

        expect((await backend.find("captures", {})).length).toBe(1);
        expect((await backend.get("captures", "up"))?.status).toBe("transcribed");
      });
    });

    it("removes a document with its blobs, and reports absence honestly", async () => {
      await withBackend(async (backend) => {
        await backend.insert(
          "captures",
          makeCapture({ id: "doomed", seq: 1, status: "queued", sessionId: "s1" }),
          [{ id: "audio", data: new Blob([new Uint8Array(4)]) }],
        );

        expect(await backend.remove("captures", "doomed")).toBe(true);
        expect(await backend.get("captures", "doomed")).toBeUndefined();
        expect(await backend.getBlob("captures", "doomed", "audio")).toBeUndefined();
        expect(await backend.remove("captures", "doomed")).toBe(false);
      });
    });

    it("removes many, skipping ids that are not there", async () => {
      await withBackend(async (backend) => {
        for (const seq of [1, 2, 3]) {
          await backend.insert(
            "captures",
            makeCapture({ id: `m${seq}`, seq, status: "queued", sessionId: "s1" }),
          );
        }

        expect(await backend.removeMany("captures", ["m1", "m3", "never-existed"])).toBe(2);
        expect((await backend.find("captures", {})).map((doc) => doc.id)).toEqual(["m2"]);
      });
    });

    it("replaces and detaches blobs", async () => {
      await withBackend(async (backend) => {
        await backend.insert(
          "captures",
          makeCapture({ id: "blobby", seq: 1, status: "recording", sessionId: "s1" }),
        );

        await backend.putBlob("captures", "blobby", "audio", new Blob([new Uint8Array(3)]));
        await backend.putBlob("captures", "blobby", "audio", new Blob([new Uint8Array(9)]));
        expect((await backend.listBlobs("captures", "blobby")).length).toBe(1);
        expect(await byteLength((await backend.getBlob("captures", "blobby", "audio"))!)).toBe(9);

        await backend.removeBlob("captures", "blobby", "audio");
        expect(await backend.getBlob("captures", "blobby", "audio")).toBeUndefined();
        await backend.removeBlob("captures", "blobby", "audio");
      });
    });

    it("emits the current result set on subscribe", async () => {
      await withBackend(async (backend) => {
        await backend.insert(
          "captures",
          makeCapture({ id: "already", seq: 1, status: "queued", sessionId: "s1" }),
        );

        const seen: string[][] = [];
        const subscription = backend
          .watch("captures", {})
          .subscribe((documents) => seen.push(documents.map((doc) => doc.id)));

        try {
          await until(() => seen.length > 0, "the initial emission");
          expect(seen[0]).toEqual(["already"]);
        } finally {
          subscription.unsubscribe();
        }
      });
    });

    it("honours the finder when watching", async () => {
      await withBackend(async (backend) => {
        const seen: string[][] = [];
        const subscription = backend
          .watch("captures", { status: ["queued"] })
          .subscribe((documents) => seen.push(documents.map((doc) => doc.id)));

        try {
          await backend.insert(
            "captures",
            makeCapture({ id: "match", seq: 1, status: "queued", sessionId: "s1" }),
          );
          await backend.insert(
            "captures",
            makeCapture({ id: "nomatch", seq: 2, status: "dead", sessionId: "s1" }),
          );

          await until(
            () => seen.some((ids) => ids.includes("match")),
            "the matching capture to be published",
          );
          expect(seen.every((ids) => !ids.includes("nomatch"))).toBe(true);
        } finally {
          subscription.unsubscribe();
        }
      });
    });
  });
}
