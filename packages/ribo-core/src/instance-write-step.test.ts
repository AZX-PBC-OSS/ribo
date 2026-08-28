import type { RxStorage } from "rxdb";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";

import type { ToolAdapter, WriteMetadata } from "./adapter.js";
import { enveloped } from "./enveloped.js";
import { FakeTranscriber } from "./fake-transcriber.js";
import { isTransientFailure, TerminalQueueError } from "./queue/backoff.js";
import { removeOutboxDatabase } from "./queue/database.js";
import { openOutbox, type Outbox } from "./queue/outbox.js";
import { createRelay } from "./queue/relay.js";
import type { SessionItem } from "./queue/session-schema.js";
import { deriveInstanceIdempotencyKey, toInstanceWriteStep } from "./instance-write-step.js";

/**
 * @file `toInstanceWriteStep` — per-instance write-back and resumability.
 *
 * The sibling of `toWriteStep`: it writes each collection instance separately,
 * derives a stable idempotency key per instance, and persists per-instance
 * progress so a retry resumes after the instances that already succeeded.
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
  },
});

// --- Fixtures ---------------------------------------------------------------

const opened: { outbox: Outbox; name: string; storage: RxStorage<unknown, unknown> }[] = [];

afterEach(async () => {
  for (const { outbox, name, storage } of opened.splice(0)) {
    if (!outbox.closed) await outbox.close();
    await removeOutboxDatabase(name, storage);
  }
});

class TestClock {
  #ms = Date.parse("2026-07-23T14:00:00.000Z");
  now = (): number => this.#ms;
  advance(ms: number): void {
    this.#ms += ms;
  }
}

const openTestOutbox = async (clock?: TestClock): Promise<Outbox> => {
  const storage = getRxStorageMemory();
  const name = `ribo-instance-write-step-${crypto.randomUUID()}`;
  const outbox = await openOutbox({ name, storage, now: clock?.now });
  opened.push({ outbox, name, storage });
  return outbox;
};

const seedSession = async (
  outbox: Outbox,
  ctx: unknown,
  fields: Record<string, unknown>,
  writtenInstances?: Record<string, boolean[]>,
): Promise<{ session: SessionItem; ctx: unknown }> => {
  const session = await outbox.openSession();
  const enqueued = await outbox.enqueue({
    recording: {
      id: "rec-1",
      capturedAt: "2026-07-23T14:02:00.000Z",
      durationMs: 8_400,
      mimeType: "audio/webm;codecs=opus",
      ctx,
    },
    audio: new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
    sessionId: session.id,
  });
  await outbox.patch(enqueued.id, {
    transcript: { recordingId: "rec-1", text: "the house has systems", engine: "fake" },
    status: "transcribed",
  });
  await outbox.patchSession(session.id, {
    extracted: {},
    extractedFromRecordingIds: ["rec-1"],
    status: "awaiting-review",
  });
  const reviewed = await outbox.submitSessionReview(session.id, {
    status: "accepted",
    fields,
  });
  if (writtenInstances) {
    return {
      session: await outbox.patchSession(session.id, { writtenInstances }),
      ctx,
    };
  }
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
  const outbox = await openTestOutbox();
  const written: Write[] = [];
  const step = toInstanceWriteStep({
    adapter: makeAdapter(written),
    outbox,
    collectionGroups: ["hvac"],
  });

  const { session, ctx } = await seedSession(
    outbox,
    { jobId: "job-7" },
    {
      hvac: [{ hvacSystemEquipmentType: "Furnace" }, { hvacSystemEquipmentType: "AC" }],
    },
  );

  const input = {
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  };

  await step(input);
  await step(input);

  expect(written).toHaveLength(4);
  const keys = written.map((w) => w.meta.idempotencyKey);
  expect(keys[0]).toBe(keys[2]); // instance 0, retry
  expect(keys[1]).toBe(keys[3]); // instance 1, retry
  expect(keys[0]).not.toBe(keys[1]);
  expect(keys[0]).toBe(deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 0));
  expect(keys[1]).toBe(deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 1));
});

test("singleton groups are written once with the session's original idempotency key", async () => {
  const outbox = await openTestOutbox();
  const written: Write[] = [];
  const step = toInstanceWriteStep({
    adapter: makeAdapter(written),
    outbox,
    collectionGroups: ["hvac"],
  });

  const { session, ctx } = await seedSession(
    outbox,
    { jobId: "job-7" },
    {
      basedata: { yearBuilt: 2004 },
      hvac: [{ hvacSystemEquipmentType: "Furnace" }],
    },
  );

  await step({
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
});

test("a patch with an empty collection group writes nothing for that group", async () => {
  const outbox = await openTestOutbox();
  const written: Write[] = [];
  const step = toInstanceWriteStep({
    adapter: makeAdapter(written),
    outbox,
    collectionGroups: ["hvac"],
  });

  const { session, ctx } = await seedSession(
    outbox,
    { jobId: "job-7" },
    {
      basedata: { yearBuilt: 2004 },
      hvac: [],
    },
  );

  await step({
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  });

  expect(written).toHaveLength(1);
  expect(written[0]!.fields).toEqual({ basedata: { yearBuilt: 2004 } });
});

test("progress is persisted before the next instance is attempted, not batched at the end", async () => {
  const outbox = await openTestOutbox();
  const written: Write[] = [];
  const base = makeAdapter(written);
  const watchingAdapter: ToolAdapter<Values, JobContext> = {
    ...base,
    write: async (fields, ctx, meta) => {
      if (meta.idempotencyKey.endsWith(":instance:hvac:1")) {
        const fromDisk = await outbox.getSession(session.id);
        expect(fromDisk?.writtenInstances).toEqual({ hvac: [true] });
      }
      await base.write(fields, ctx, meta);
    },
  };

  const { session, ctx } = await seedSession(
    outbox,
    { jobId: "job-7" },
    {
      hvac: [{ hvacSystemEquipmentType: "Furnace" }, { hvacSystemEquipmentType: "AC" }],
    },
  );

  await toInstanceWriteStep({
    adapter: watchingAdapter,
    outbox,
    collectionGroups: ["hvac"],
  })({
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  });

  const fromDisk = await outbox.getSession(session.id);
  expect(fromDisk?.writtenInstances).toEqual({ hvac: [true, true] });
});

// --- Skipping already-written instances on retry ----------------------------

test("already-written instances are skipped when the step is retried", async () => {
  const outbox = await openTestOutbox();
  const written: Write[] = [];
  const { session, ctx } = await seedSession(
    outbox,
    { jobId: "job-7" },
    {
      hvac: [
        { hvacSystemEquipmentType: "Furnace" },
        { hvacSystemEquipmentType: "AC" },
        { hvacSystemEquipmentType: "Heat Pump" },
      ],
    },
    { hvac: [true, false, false] },
  );

  await toInstanceWriteStep({
    adapter: makeAdapter(written),
    outbox,
    collectionGroups: ["hvac"],
  })({
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  });

  expect(written).toHaveLength(2);
  expect(written.map((w) => w.meta.idempotencyKey)).toEqual([
    deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 1),
    deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 2),
  ]);
});

// --- Relay-driven retry -----------------------------------------------------

test("a write failing on the second of three instances, then retrying, does not re-attempt the first", async () => {
  const clock = new TestClock();
  const outbox = await openTestOutbox(clock);
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
      await base.write(fields, ctx, meta);
    },
  };

  const session = await outbox.openSession();
  const enqueued = await outbox.enqueue({
    recording: {
      id: "rec-1",
      capturedAt: "2026-07-23T14:02:00.000Z",
      durationMs: 8_400,
      mimeType: "audio/webm;codecs=opus",
      ctx: { jobId: "job-7" },
    },
    audio: new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
    sessionId: session.id,
  });
  await outbox.patch(enqueued.id, {
    transcript: { recordingId: "rec-1", text: "the house has systems", engine: "fake" },
    status: "transcribed",
  });
  await outbox.patchSession(session.id, {
    extracted: {},
    extractedFromRecordingIds: ["rec-1"],
    status: "awaiting-review",
  });
  await outbox.submitSessionReview(session.id, {
    status: "accepted",
    fields: {
      hvac: [
        { hvacSystemEquipmentType: "Furnace" },
        { hvacSystemEquipmentType: "AC" },
        { hvacSystemEquipmentType: "Heat Pump" },
      ],
    },
  });

  const relay = createRelay({
    outbox,
    transcriber: new FakeTranscriber(),
    sessionExtract: () => Promise.reject(new Error("session extraction should not run")),
    sessionWrite: toInstanceWriteStep({
      adapter: failingAdapter,
      outbox,
      collectionGroups: ["hvac"],
    }),
    now: clock.now,
    random: () => 1,
    baseMs: 500,
  });

  await relay.syncNow();
  const failed = await outbox.getSession(session.id);
  expect(failed?.status).toBe("failed");
  expect(failed?.writtenInstances).toEqual({ hvac: [true] });
  expect(calls.filter((c) => c.key.endsWith(":instance:hvac:0"))).toEqual([
    { key: deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 0), failed: false },
  ]);
  expect(calls.filter((c) => c.key.endsWith(":instance:hvac:1"))).toEqual([
    { key: deriveInstanceIdempotencyKey(session.idempotencyKey, "hvac", 1), failed: true },
  ]);

  clock.advance(501);
  await relay.syncNow();
  const done = await outbox.getSession(session.id);
  expect(done?.status).toBe("done");
  expect(calls.filter((c) => c.key.endsWith(":instance:hvac:0"))).toHaveLength(1);
  expect(calls.filter((c) => c.key.endsWith(":instance:hvac:1"))).toHaveLength(2);
  expect(calls.filter((c) => c.key.endsWith(":instance:hvac:2"))).toHaveLength(1);
  expect(calls.filter((c) => c.key.endsWith(":instance:hvac:1") && c.failed)).toHaveLength(1);
  expect(written.filter((w) => w.meta.idempotencyKey.endsWith(":instance:hvac:1"))).toHaveLength(1);
});

// --- The same trust boundary as toWriteStep --------------------------------

test("a patch the adapter's schema rejects is terminal, and write is never called", async () => {
  const outbox = await openTestOutbox();
  const written: Write[] = [];
  const { session, ctx } = await seedSession(
    outbox,
    { jobId: "job-7" },
    {
      basedata: { yearBuilt: "nineteen" },
    },
  );

  const thrown = await toInstanceWriteStep({
    adapter: makeAdapter(written),
    outbox,
    collectionGroups: ["hvac"],
  })({
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(thrown).toBeInstanceOf(TerminalQueueError);
  expect((thrown as Error).message).toContain("not a valid patch");
  expect((thrown as Error).message).toContain("yearBuilt");
  expect(isTransientFailure(thrown)).toBe(false);
  expect(written).toEqual([]);
});

test("a recording ctx the adapter's ctxSchema rejects is terminal, and write is never called", async () => {
  const outbox = await openTestOutbox();
  const written: Write[] = [];
  const { session, ctx } = await seedSession(
    outbox,
    { jobId: "" },
    {
      hvac: [{ hvacSystemEquipmentType: "Furnace" }],
    },
  );

  const thrown = await toInstanceWriteStep({
    adapter: makeAdapter(written),
    outbox,
    collectionGroups: ["hvac"],
  })({
    session,
    reviewed: reviewFields(session),
    idempotencyKey: session.idempotencyKey,
    ctx,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(thrown).toBeInstanceOf(TerminalQueueError);
  expect((thrown as Error).message).toContain("Recording.ctx");
  expect(isTransientFailure(thrown)).toBe(false);
  expect(written).toEqual([]);
});

test("a failing write propagates unchanged — the relay's retry contract is not swallowed", async () => {
  const outbox = await openTestOutbox();
  const failure = Object.assign(new Error("snuggpro returned 503"), { status: 503 });
  const adapter: ToolAdapter<Values, JobContext> = {
    ...makeAdapter([]),
    write: () => Promise.reject(failure),
  };
  const { session, ctx } = await seedSession(
    outbox,
    { jobId: "job-7" },
    {
      hvac: [{ hvacSystemEquipmentType: "Furnace" }],
    },
  );

  const thrown = await toInstanceWriteStep({
    adapter,
    outbox,
    collectionGroups: ["hvac"],
  })({
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
  expect(thrown).not.toBeInstanceOf(TerminalQueueError);
});
