import { createMemoryBackend, removeMemoryDatabase } from "../storage/memory-backend.js";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";

import type { ToolAdapter, WriteMetadata } from "./adapter.js";
import { enveloped } from "../provenance/enveloped.js";
import { FakeTranscriber } from "../transcription/fake-transcriber.js";
import { isTransientFailure, TerminalError } from "../storage/backoff.js";
import { openStorage, type Storage } from "../storage/storage.js";
import { createRelay } from "../storage/relay.js";
import type { SessionItem } from "../storage/session-schema.js";
import { deriveInstanceIdempotencyKey, toInstanceWriteStep } from "./instance-write-step.js";
import { restrictToKind } from "../transcription/restrict-to-kind.js";

/**
 * `SessionWriteInput.recordReceipt` is required, so every input literal here supplies
 * one. A test that cares what was checkpointed passes its own recorder instead.
 */
const noRecordReceipt = async (): Promise<void> => {};

/**
 * @file `toInstanceWriteStep` — per-instance write-back and resumability.
 *
 * The sibling of `toWriteStep`: it writes each collection instance separately
 * and derives a stable idempotency key per instance. The key is still sent as
 * `Idempotency-Key`, but nothing rests on it — no vendor here honours it
 * (measured 2026-09-21 against Snugg Pro's staging API). Duplicate protection
 * is the receipt: each earned uuid is checkpointed through `recordReceipt`, and
 * a retry UPDATEs the receipted uuid instead of creating again.
 *
 * It no longer persists per-instance progress. That marker was positional, and
 * position is not identity: `reopenSessionForReview` preserves progress across
 * a review cycle while `resolveReview` renumbers the instances that survived
 * it, so a reviewer who deleted an instance could silently strand its
 * neighbour. The reopen case below pins exactly that, and it is the test that
 * should stop positional identity coming back now that receipts have landed.
 */

// --- The adapter under test -------------------------------------------------

interface JobContext {
  jobId: string;
}

const jobContextSchema = z.object({ jobId: z.string().min(1) });

const hvacFieldsSchema = z.object({
  hvacSystemEquipmentType: z.string().nullable().optional(),
});

const basedataFieldsSchema = z.object({
  yearBuilt: z.number().nullable().optional(),
});

const valuesSchema = z
  .object({
    basedata: basedataFieldsSchema.optional(),
    hvac: z.array(hvacFieldsSchema).optional(),
  })
  .strict();

type Values = z.infer<typeof valuesSchema>;

interface Write {
  fields: Values;
  ctx: JobContext;
  meta: WriteMetadata;
}

const makeAdapter = (sink: Write[]): ToolAdapter<Values, JobContext> => ({
  name: "instance-write-test",
  schema: valuesSchema,
  extractionSchema: enveloped(valuesSchema),
  ctxSchema: jobContextSchema,
  instructions: "test",
  write: async (fields, ctx, meta) => {
    sink.push({ fields, ctx, meta });
    return { receipt: `uuid-${meta.idempotencyKey}` };
  },
});

// --- Fixtures ---------------------------------------------------------------

const opened: { storage: Storage; name: string }[] = [];

afterEach(async () => {
  for (const { storage, name } of opened.splice(0)) {
    if (!storage.closed) await storage.close();
    // A memory database outlives its handle, as an IndexedDB one does.
    removeMemoryDatabase(name);
  }
});

class TestClock {
  #ms = Date.parse("2026-07-23T14:00:00.000Z");
  now = (): number => this.#ms;
  advance(ms: number): void {
    this.#ms += ms;
  }
}

const openTestOutbox = async (clock?: TestClock): Promise<Storage> => {
  const name = `ribo-instance-write-step-${crypto.randomUUID()}`;
  const storage = await openStorage({ backend: createMemoryBackend(name), now: clock?.now });
  opened.push({ storage, name });
  return storage;
};

const seedSession = async (
  storage: Storage,
  ctx: unknown,
  fields: Record<string, unknown>,
  instanceKeys?: Record<string, string[]>,
  linkTargets?: Record<string, (string | null)[]>,
): Promise<{ session: SessionItem; ctx: unknown }> => {
  const session = await storage.sessions.open({ ctx, ref: "job-7" });
  const enqueued = await storage.captures.enqueue({
    recording: {
      id: "rec-1",
      capturedAt: "2026-07-23T14:02:00.000Z",
      kind: "audio",
      durationMs: 8_400,
      mimeType: "audio/webm;codecs=opus",
      ctx,
    },
    audio: new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
    sessionId: session.id,
  });
  await storage.captures.patch(enqueued.id, {
    transcript: { recordingId: "rec-1", text: "the house has systems", engine: "fake" },
    status: "transcribed",
  });
  await storage.sessions.patch(session.id, {
    extracted: {},
    // The OUTBOX ITEM id, not the recording's. `joinSessionTranscript` stamps
    // `r.id` off the item, and `enqueue` generates that independently of
    // `recording.id` — a fixture using "rec-1" describes a set no production
    // extraction could ever produce.
    extractedFromRecordingIds: [enqueued.id],
    status: "awaiting-review",
  });
  const reviewed = await storage.sessions.submitReview(session.id, {
    status: "accepted",
    fields,
    ...(instanceKeys ? { instanceKeys } : {}),
    ...(linkTargets ? { linkTargets } : {}),
  });
  return { session: reviewed, ctx };
};

function reviewFields(session: SessionItem): Record<string, unknown> {
  if (session.reviewOutcome?.status === "discarded") {
    throw new Error("seeded session was discarded; tests expect accepted or edited outcomes");
  }
  return session.reviewOutcome!.fields;
}

// --- The happy path and the key derivation --------------------------------

test("each instance's derived key is stable across retries and distinct between instances", async () => {
  const storage = await openTestOutbox();
  const written: Write[] = [];
  const step = toInstanceWriteStep({
    adapter: makeAdapter(written),
    collectionGroups: ["hvac"],
  });

  const { session, ctx } = await seedSession(
    storage,
    { jobId: "job-7" },
    {
      hvac: [{ hvacSystemEquipmentType: "Furnace" }, { hvacSystemEquipmentType: "AC" }],
    },
    { hvac: ["k1", "k2"] },
  );

  const input = {
    recordReceipt: noRecordReceipt,
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  };

  const result1 = await step(input);
  const result2 = await step(input);

  expect(written).toHaveLength(4);
  const keys = written.map((w) => w.meta.idempotencyKey);
  expect(keys[0]).toBe(keys[2]); // instance 0, retry
  expect(keys[1]).toBe(keys[3]); // instance 1, retry
  expect(keys[0]).not.toBe(keys[1]);
  expect(keys[0]).toBe(deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 0));
  expect(keys[1]).toBe(deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 1));
  expect(result1?.receipts?.instances?.hvac).toEqual({
    k1: `uuid-${deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 0)}`,
    k2: `uuid-${deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 1)}`,
  });
  expect(result2?.receipts?.instances?.hvac).toEqual(result1?.receipts?.instances?.hvac);
});

test("singleton groups are written once with the session's original idempotency key", async () => {
  const storage = await openTestOutbox();
  const written: Write[] = [];
  const step = toInstanceWriteStep({
    adapter: makeAdapter(written),
    collectionGroups: ["hvac"],
  });

  const { session, ctx } = await seedSession(
    storage,
    { jobId: "job-7" },
    {
      basedata: { yearBuilt: 2004 },
      hvac: [{ hvacSystemEquipmentType: "Furnace" }],
    },
    { hvac: ["k1"] },
  );

  const result = await step({
    recordReceipt: noRecordReceipt,
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  });

  expect(written).toHaveLength(2);
  const singleton = written.find((w) => "basedata" in w.fields);
  const instance = written.find((w) => "hvac" in w.fields);
  expect(singleton?.meta.idempotencyKey).toBe(session.idempotencyKey);
  expect(instance?.meta.idempotencyKey).toBe(
    deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 0),
  );
  expect(result?.receipts?.singleton).toBe(`uuid-${session.idempotencyKey}`);
  expect(result?.receipts?.instances?.hvac).toEqual({
    k1: `uuid-${deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 0)}`,
  });
});

test("a patch with an empty collection group writes nothing for that group", async () => {
  const storage = await openTestOutbox();
  const written: Write[] = [];
  const step = toInstanceWriteStep({
    adapter: makeAdapter(written),
    collectionGroups: ["hvac"],
  });

  const { session, ctx } = await seedSession(
    storage,
    { jobId: "job-7" },
    {
      basedata: { yearBuilt: 2004 },
      hvac: [],
    },
  );

  await step({
    recordReceipt: noRecordReceipt,
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  });

  expect(written).toHaveLength(1);
  expect(written[0]!.fields).toEqual({ basedata: { yearBuilt: 2004 } });
});

// --- The review's link decision ---------------------------------------------
// A human decides at review whether an instance updates an existing record or
// creates a new one; the write step carries that decision to the adapter.
// `linkTargets` is aligned positionally with each group's array in `fields` —
// the same array this loop walks — and `null` means create.

test("an instance with a link target passes it to write as `meta.linkTarget`", async () => {
  const storage = await openTestOutbox();
  const written: Write[] = [];
  const step = toInstanceWriteStep({
    adapter: makeAdapter(written),
    collectionGroups: ["hvac"],
  });

  const { session, ctx } = await seedSession(
    storage,
    { jobId: "job-7" },
    { hvac: [{ hvacSystemEquipmentType: "Furnace" }] },
    { hvac: ["k1"] },
    { hvac: ["uuid-existing-1"] },
  );

  await step({
    recordReceipt: noRecordReceipt,
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  });

  expect(written).toHaveLength(1);
  expect(written[0]?.meta.linkTarget).toBe("uuid-existing-1");
});

test("an instance whose decision is `null` gets no `linkTarget` member at all", async () => {
  // `null` means create, and create is carried by the member's ABSENCE — not by
  // `linkTarget: undefined`, which would be a value that is not a value.
  // `"linkTarget" in meta` is the assertion that survives the member vanishing
  // from both sides; `toBeUndefined` is not.
  const storage = await openTestOutbox();
  const written: Write[] = [];
  const step = toInstanceWriteStep({
    adapter: makeAdapter(written),
    collectionGroups: ["hvac"],
  });

  const { session, ctx } = await seedSession(
    storage,
    { jobId: "job-7" },
    { hvac: [{ hvacSystemEquipmentType: "Furnace" }] },
    { hvac: ["k1"] },
    { hvac: [null] },
  );

  await step({
    recordReceipt: noRecordReceipt,
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  });

  expect(written).toHaveLength(1);
  expect("linkTarget" in written[0]!.meta).toBe(false);
});

test("a group with no entry in `linkTargets` writes every instance as a create", async () => {
  const storage = await openTestOutbox();
  const written: Write[] = [];
  const step = toInstanceWriteStep({
    adapter: makeAdapter(written),
    collectionGroups: ["hvac"],
  });

  const { session, ctx } = await seedSession(
    storage,
    { jobId: "job-7" },
    {
      hvac: [{ hvacSystemEquipmentType: "Furnace" }, { hvacSystemEquipmentType: "AC" }],
    },
    { hvac: ["k1", "k2"] },
    // No hvac entry: a missing target is the normal case (it means create),
    // not an error — an implementation that threw here would break every
    // unlinked instance, which is almost all of them.
  );

  await step({
    recordReceipt: noRecordReceipt,
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  });

  expect(written).toHaveLength(2);
  expect(written.map((w) => "linkTarget" in w.meta)).toEqual([false, false]);
});

test("two instances in one group with different decisions each get their own", async () => {
  // The pin that index alignment is real: instance 0 links and instance 1
  // creates, each identified by the idempotency key its position derives, so a
  // crossed or shared decision cannot pass unnoticed in a one-instance fixture.
  const storage = await openTestOutbox();
  const written: Write[] = [];
  const step = toInstanceWriteStep({
    adapter: makeAdapter(written),
    collectionGroups: ["hvac"],
  });

  const { session, ctx } = await seedSession(
    storage,
    { jobId: "job-7" },
    {
      hvac: [{ hvacSystemEquipmentType: "Furnace" }, { hvacSystemEquipmentType: "AC" }],
    },
    { hvac: ["k1", "k2"] },
    { hvac: ["uuid-existing-1", null] },
  );

  await step({
    recordReceipt: noRecordReceipt,
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  });

  expect(written).toHaveLength(2);
  const byIndex = (index: number): WriteMetadata =>
    written.find((w) => w.meta.idempotencyKey.endsWith(`:instance:hvac:${index}`))!.meta;
  expect(byIndex(0).linkTarget).toBe("uuid-existing-1");
  expect("linkTarget" in byIndex(1)).toBe(false);
});

test("an outcome with no `linkTargets` at all writes creates and does not throw", async () => {
  // Every outcome persisted before linking existed has no `linkTargets` member;
  // the write step must keep writing them as creates.
  const storage = await openTestOutbox();
  const written: Write[] = [];
  const step = toInstanceWriteStep({
    adapter: makeAdapter(written),
    collectionGroups: ["hvac"],
  });

  const { session, ctx } = await seedSession(
    storage,
    { jobId: "job-7" },
    {
      hvac: [{ hvacSystemEquipmentType: "Furnace" }, { hvacSystemEquipmentType: "AC" }],
    },
    { hvac: ["k1", "k2"] },
  );

  await expect(
    step({
      recordReceipt: noRecordReceipt,
      session,
      reviewed: reviewFields(session),
      idempotencyKey: session.idempotencyKey,
      ctx,
    }),
  ).resolves.toBeDefined();

  expect(written).toHaveLength(2);
  expect(written.map((w) => "linkTarget" in w.meta)).toEqual([false, false]);
});

// --- Checkpointed receipts ---------------------------------------------------

test("each earned instance receipt is checkpointed before the next write runs, and before a failure propagates", async () => {
  const storage = await openTestOutbox();
  const written: Write[] = [];
  const base = makeAdapter(written);
  const failure = Object.assign(new Error("snuggpro returned 503"), { status: 503 });
  const events: string[] = [];
  const adapter: ToolAdapter<Values, JobContext> = {
    ...base,
    write: async (fields, ctx, meta) => {
      events.push(`write:${meta.idempotencyKey}`);
      if (meta.idempotencyKey.endsWith(":instance:hvac:2")) throw failure;
      return base.write(fields, ctx, meta);
    },
  };

  const { session, ctx } = await seedSession(
    storage,
    { jobId: "job-7" },
    {
      hvac: [
        { hvacSystemEquipmentType: "Furnace" },
        { hvacSystemEquipmentType: "AC" },
        { hvacSystemEquipmentType: "Heat Pump" },
      ],
    },
    // Real instance keys, deliberately not the indices they sit at.
    { hvac: ["hvac-a", "hvac-b", "hvac-c"] },
  );

  const checkpointed: Array<[string, string, string]> = [];
  const thrown = await toInstanceWriteStep({
    adapter,
    collectionGroups: ["hvac"],
  })({
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
    recordReceipt: async (group, instanceKey, uuid) => {
      events.push(`receipt:${instanceKey}`);
      checkpointed.push([group, instanceKey, uuid]);
    },
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(thrown).toBe(failure);
  // Exactly the two instances that wrote successfully, keyed by the review
  // outcome's real instance keys, each checkpointed before the next write ran
  // and so before the third write's rejection propagated.
  expect(events).toEqual([
    `write:${deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 0)}`,
    "receipt:hvac-a",
    `write:${deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 1)}`,
    "receipt:hvac-b",
    `write:${deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 2)}`,
  ]);
  expect(checkpointed).toEqual([
    ["hvac", "hvac-a", `uuid-${deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 0)}`],
    ["hvac", "hvac-b", `uuid-${deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 1)}`],
  ]);
});

// --- Relay-driven retry -----------------------------------------------------

test("a write failing on the second of three instances, then retrying, re-attempts the first", async () => {
  // Without the positional skip, every instance is written every attempt. The
  // first instance IS re-attempted on retry — as an UPDATE of the receipt it
  // earned, not a second create.
  const clock = new TestClock();
  const storage = await openTestOutbox(clock);
  const written: Write[] = [];
  const base = makeAdapter(written);
  let instanceOneFailed = true;
  const calls: { key: string; failed: boolean }[] = [];
  const failingAdapter: ToolAdapter<Values, JobContext> = {
    ...base,
    write: async (fields, ctx, meta) => {
      const key = meta.idempotencyKey;
      const failThis = key.endsWith(":instance:hvac:1") && instanceOneFailed;
      calls.push({ key, failed: failThis });
      if (failThis) {
        instanceOneFailed = false;
        throw Object.assign(new Error("transient"), { status: 503 });
      }
      return await base.write(fields, ctx, meta);
    },
  };

  const session = await storage.sessions.open({ ctx: { jobId: "job-7" }, ref: "job-7" });
  const enqueued = await storage.captures.enqueue({
    recording: {
      id: "rec-1",
      capturedAt: "2026-07-23T14:02:00.000Z",
      kind: "audio",
      durationMs: 8_400,
      mimeType: "audio/webm;codecs=opus",
      ctx: { jobId: "job-7" },
    },
    audio: new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
    sessionId: session.id,
  });
  await storage.captures.patch(enqueued.id, {
    transcript: { recordingId: "rec-1", text: "the house has systems", engine: "fake" },
    status: "transcribed",
  });
  await storage.sessions.patch(session.id, {
    extracted: {},
    // The storage item id, not the recording's — see the note in `seedSession`.
    extractedFromRecordingIds: [enqueued.id],
    status: "awaiting-review",
  });
  await storage.sessions.submitReview(session.id, {
    status: "accepted",
    fields: {
      hvac: [
        { hvacSystemEquipmentType: "Furnace" },
        { hvacSystemEquipmentType: "AC" },
        { hvacSystemEquipmentType: "Heat Pump" },
      ],
    },
    instanceKeys: { hvac: ["k1", "k2", "k3"] },
  });

  const relay = createRelay({
    storage,
    transcriber: restrictToKind("audio", new FakeTranscriber()),
    sessionExtract: () => Promise.reject(new Error("session extraction should not run")),
    sessionWrite: toInstanceWriteStep({
      adapter: failingAdapter,
      collectionGroups: ["hvac"],
    }),
    now: clock.now,
    random: () => 1,
    baseMs: 500,
  });

  await relay.syncNow();
  const failed = await storage.sessions.get(session.id);
  expect(failed?.status).toBe("failed");
  expect(calls.filter((c) => c.key.endsWith(":instance:hvac:0"))).toEqual([
    { key: deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 0), failed: false },
  ]);
  expect(calls.filter((c) => c.key.endsWith(":instance:hvac:1"))).toEqual([
    { key: deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 1), failed: true },
  ]);

  clock.advance(501);
  await relay.syncNow();
  const done = await storage.sessions.get(session.id);
  expect(done?.status).toBe("done");
  // Instance 0 is re-attempted on retry — no positional skip.
  expect(calls.filter((c) => c.key.endsWith(":instance:hvac:0"))).toHaveLength(2);
  expect(calls.filter((c) => c.key.endsWith(":instance:hvac:1"))).toHaveLength(2);
  expect(calls.filter((c) => c.key.endsWith(":instance:hvac:2"))).toHaveLength(1);
  expect(calls.filter((c) => c.key.endsWith(":instance:hvac:1") && c.failed)).toHaveLength(1);
  expect(written.filter((w) => w.meta.idempotencyKey.endsWith(":instance:hvac:1"))).toHaveLength(1);
});

test("a mid-collection failure leaves its earned receipts on the session, and the retry updates instead of re-creating", async () => {
  const clock = new TestClock();
  const storage = await openTestOutbox(clock);
  const written: Write[] = [];
  const base = makeAdapter(written);
  let firstAttempt = true;
  const failingAdapter: ToolAdapter<Values, JobContext> = {
    ...base,
    write: async (fields, ctx, meta) => {
      if (firstAttempt && meta.idempotencyKey.endsWith(":instance:hvac:2")) {
        firstAttempt = false;
        throw Object.assign(new Error("transient"), { status: 503 });
      }
      return base.write(fields, ctx, meta);
    },
  };

  const { session } = await seedSession(
    storage,
    { jobId: "job-7" },
    {
      hvac: [
        { hvacSystemEquipmentType: "Furnace" },
        { hvacSystemEquipmentType: "AC" },
        { hvacSystemEquipmentType: "Heat Pump" },
      ],
    },
    { hvac: ["k1", "k2", "k3"] },
  );

  const relay = createRelay({
    storage,
    transcriber: restrictToKind("audio", new FakeTranscriber()),
    sessionExtract: () => Promise.reject(new Error("session extraction should not run")),
    sessionWrite: toInstanceWriteStep({
      adapter: failingAdapter,
      collectionGroups: ["hvac"],
    }),
    now: clock.now,
    random: () => 1,
    baseMs: 500,
  });

  await relay.syncNow();
  const failed = await storage.sessions.get(session.id);
  expect(failed?.status).toBe("failed");
  // The two receipts earned before the throw are already durable on the
  // session document — not waiting on an end-of-step return that never came.
  expect(failed?.receipts?.instances?.hvac).toEqual({
    k1: `uuid-${deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 0)}`,
    k2: `uuid-${deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 1)}`,
  });

  clock.advance(501);
  await relay.syncNow();
  const done = await storage.sessions.get(session.id);
  expect(done?.status).toBe("done");
  // The consequence the receipts are for: the retry resolves the receipted
  // instances to UPDATES of the records it already created, not new creates.
  const first = written.filter((w) => w.meta.idempotencyKey.endsWith(":instance:hvac:0"));
  expect(first).toHaveLength(2);
  expect("linkTarget" in first[0]!.meta).toBe(false);
  expect(first[1]?.meta.linkTarget).toBe(
    `uuid-${deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 0)}`,
  );
  const second = written.filter((w) => w.meta.idempotencyKey.endsWith(":instance:hvac:1"));
  expect(second).toHaveLength(2);
  expect("linkTarget" in second[0]!.meta).toBe(false);
  expect(second[1]?.meta.linkTarget).toBe(
    `uuid-${deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 1)}`,
  );
  // k3 never earned a receipt; its one write is still a create.
  expect(written.filter((w) => w.meta.idempotencyKey.endsWith(":instance:hvac:2"))).toHaveLength(1);
  expect(done?.receipts?.instances?.hvac).toEqual({
    k1: `uuid-${deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 0)}`,
    k2: `uuid-${deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 1)}`,
    k3: `uuid-${deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 2)}`,
  });
});

// --- The same trust boundary as toWriteStep --------------------------------

test("a patch the adapter's schema rejects is terminal, and write is never called", async () => {
  const storage = await openTestOutbox();
  const written: Write[] = [];
  const { session, ctx } = await seedSession(
    storage,
    { jobId: "job-7" },
    {
      basedata: { yearBuilt: "nineteen" },
    },
  );

  const thrown = await toInstanceWriteStep({
    adapter: makeAdapter(written),
    collectionGroups: ["hvac"],
  })({
    recordReceipt: noRecordReceipt,
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(thrown).toBeInstanceOf(TerminalError);
  expect((thrown as Error).message).toContain("not a valid patch");
  expect((thrown as Error).message).toContain("yearBuilt");
  expect(isTransientFailure(thrown)).toBe(false);
  expect(written).toEqual([]);
});

test("a recording ctx the adapter's ctxSchema rejects is terminal, and write is never called", async () => {
  const storage = await openTestOutbox();
  const written: Write[] = [];
  const { session, ctx } = await seedSession(
    storage,
    { jobId: "" },
    {
      hvac: [{ hvacSystemEquipmentType: "Furnace" }],
    },
    { hvac: ["k1"] },
  );

  const thrown = await toInstanceWriteStep({
    adapter: makeAdapter(written),
    collectionGroups: ["hvac"],
  })({
    recordReceipt: noRecordReceipt,
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(thrown).toBeInstanceOf(TerminalError);
  expect((thrown as Error).message).toContain("storage.sessions.open");
  expect(isTransientFailure(thrown)).toBe(false);
  expect(written).toEqual([]);
});

test("a failing write propagates unchanged — the relay's retry contract is not swallowed", async () => {
  const storage = await openTestOutbox();
  const failure = Object.assign(new Error("snuggpro returned 503"), { status: 503 });
  const adapter: ToolAdapter<Values, JobContext> = {
    ...makeAdapter([]),
    write: () => Promise.reject(failure),
  };
  const { session, ctx } = await seedSession(
    storage,
    { jobId: "job-7" },
    {
      hvac: [{ hvacSystemEquipmentType: "Furnace" }],
    },
    { hvac: ["k1"] },
  );

  const thrown = await toInstanceWriteStep({
    adapter,
    collectionGroups: ["hvac"],
  })({
    recordReceipt: noRecordReceipt,
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(thrown).toBe(failure);
  expect(isTransientFailure(thrown)).toBe(true);
  expect(thrown).not.toBeInstanceOf(TerminalError);
});

// --- The reopen bug: a positional marker for an identity we do not keep --------

test("after reopening from dead and removing the first instance, the survivor reaches the adapter", async () => {
  // The bug this test outlives: `writtenInstances` records per-position write
  // progress, and `reopenSessionForReview` preserves it. A reviewer reopens a
  // dead session, deletes the first instance as a mishearing, and resubmits.
  // The survivor is now index 0; the marker at index 0 is still true from the
  // deleted instance; and the write step silently skips it. This test stops a
  // future receipts implementation reintroducing positional identity.
  const clock = new TestClock();
  const storage = await openTestOutbox(clock);
  const written: Write[] = [];
  const base = makeAdapter(written);
  let firstAttempt = true;
  const adapter: ToolAdapter<Values, JobContext> = {
    ...base,
    write: async (fields, ctx, meta) => {
      const key = meta.idempotencyKey;
      // First attempt: instance 0 succeeds, instance 1 throws → session dies.
      if (firstAttempt && key.endsWith(":instance:hvac:1")) {
        firstAttempt = false;
        throw Object.assign(new Error("transient"), { status: 503 });
      }
      return await base.write(fields, ctx, meta);
    },
  };

  const session = await storage.sessions.open({ ctx: { jobId: "job-7" }, ref: "job-7" });
  const enqueued = await storage.captures.enqueue({
    recording: {
      id: "rec-1",
      capturedAt: "2026-07-23T14:02:00.000Z",
      kind: "audio",
      durationMs: 8_400,
      mimeType: "audio/webm;codecs=opus",
      ctx: { jobId: "job-7" },
    },
    audio: new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
    sessionId: session.id,
  });
  await storage.captures.patch(enqueued.id, {
    transcript: { recordingId: "rec-1", text: "the house has systems", engine: "fake" },
    status: "transcribed",
  });
  await storage.sessions.patch(session.id, {
    extracted: {},
    // The storage item id, not the recording's — see the note in `seedSession`.
    extractedFromRecordingIds: [enqueued.id],
    status: "awaiting-review",
  });
  await storage.sessions.submitReview(session.id, {
    status: "accepted",
    fields: {
      hvac: [{ hvacSystemEquipmentType: "Furnace" }, { hvacSystemEquipmentType: "AC" }],
    },
    instanceKeys: { hvac: ["k1", "k2"] },
  });

  const relay = createRelay({
    storage,
    transcriber: restrictToKind("audio", new FakeTranscriber()),
    sessionExtract: () => Promise.reject(new Error("should not extract")),
    sessionWrite: toInstanceWriteStep({
      adapter,
      collectionGroups: ["hvac"],
    }),
    now: clock.now,
    random: () => 1,
    baseMs: 500,
    maxAttempts: 1,
  });

  // First drain: instance 0 writes, instance 1 throws → session dies.
  await relay.syncNow();
  const dead = await storage.sessions.get(session.id);
  expect(dead?.status).toBe("dead");

  // Reopen from dead, remove the first instance, resubmit with only the survivor.
  await storage.sessions.reopenForReview(session.id);
  await storage.sessions.submitReview(session.id, {
    status: "accepted",
    fields: {
      hvac: [{ hvacSystemEquipmentType: "AC" }],
    },
    // Deliberately "k2" (not "k1"): this fixture bypasses the real UI's
    // remapAfterInstanceRemove (which would renumber the survivor to k1) to
    // stress-test the write step's keying behavior in isolation.
    instanceKeys: { hvac: ["k2"] },
  });

  // Second drain: the survivor (now index 0) must reach the adapter.
  const step2 = toInstanceWriteStep({
    adapter,
    collectionGroups: ["hvac"],
  });
  const relay2 = createRelay({
    storage,
    transcriber: restrictToKind("audio", new FakeTranscriber()),
    sessionExtract: () => Promise.reject(new Error("should not extract")),
    sessionWrite: step2,
    now: clock.now,
    random: () => 1,
    baseMs: 500,
  });

  await relay2.syncNow();
  const done = await storage.sessions.get(session.id);
  expect(done?.status).toBe("done");

  // The survivor reached the adapter. Today it does not: it is now index 0,
  // and the marker at index 0 is still true from the deleted instance.
  expect(written.filter((w) => w.meta.idempotencyKey.endsWith(":instance:hvac:0"))).toHaveLength(2);
  expect(
    written
      .filter((w) => w.meta.idempotencyKey.endsWith(":instance:hvac:0"))
      .map(
        (w) =>
          (w.fields as { hvac: Array<{ hvacSystemEquipmentType: string }> }).hvac[0]
            ?.hvacSystemEquipmentType,
      ),
  ).toEqual(["Furnace", "AC"]);

  // Receipts are keyed by the real instance key the reviewed outcome declares
  // (k2), not by array position. The relay doesn't expose the resolved
  // SessionWriteResult, so call the step directly with the same inputs.
  const postRemoval = await storage.sessions.get(session.id);
  const receiptResult = await step2({
    recordReceipt: noRecordReceipt,
    session: postRemoval!,
    reviewed: reviewFields(postRemoval!),
    idempotencyKey: postRemoval!.idempotencyKey,
    ctx: postRemoval!.ctx,
  });
  expect(receiptResult?.receipts?.instances?.hvac).toEqual({
    k2: `uuid-${deriveInstanceIdempotencyKey(postRemoval!.idempotencyKey, "hvac", 0)}`,
  });
});
