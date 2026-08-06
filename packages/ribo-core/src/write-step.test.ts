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
import { outboxItemSchema, type OutboxItem } from "./queue/schema.js";
import { toWriteStep } from "./write-step.js";

/**
 * @file `toWriteStep` — the trust boundary, and the per-item context resolution.
 *
 * The composition under test is three lines long, and every one of them is here
 * because something else would have been silently wrong:
 *
 *   - `ctxSchema.parse(item.recording.ctx)` **per item**, because the outbox holds
 *     recordings from more than one job at a time. The two-contexts test below is the
 *     regression guard for a composition that captured one `ctx` at construction.
 *   - `schema.parse(reviewed)`, because `RelayOptions.write` is host-supplied and
 *     nothing else in this package runs it — the "adapter's schema is the trust
 *     boundary" reasoning described a boundary that was not installed anywhere.
 *   - `TerminalQueueError` on either failure, because both are deterministic. The last
 *     test drives the REAL relay over an in-memory outbox rather than asserting the
 *     error class alone: what matters is the item landing at `dead` on the first
 *     attempt, and that is a claim about `isTransientFailure` and `#recordFailure`
 *     together, not about the type of the throw.
 */

// --- The adapter under test -------------------------------------------------

/**
 * A patch, deliberately NOT strict, so the happy-path assertions can prove the parse
 * actually ran: a stray key survives a pass-through and is stripped by a parse.
 */
const atticSchema = z.object({
  rValue: z.number().nullable().optional(),
  area: z.number().nullable().optional(),
});
type AtticValues = z.infer<typeof atticSchema>;

interface JobContext {
  jobId: string;
}
const jobContextSchema = z.object({ jobId: z.string().min(1) });

interface Write {
  fields: AtticValues;
  ctx: JobContext;
  meta: WriteMetadata;
}

const makeAdapter = (sink: Write[]): ToolAdapter<AtticValues, JobContext> => ({
  name: "attic-insulation",
  schema: atticSchema,
  extractionSchema: enveloped(atticSchema),
  ctxSchema: jobContextSchema,
  instructions: "Extract the attic insulation R-value and area in square feet.",
  write: async (fields, ctx, meta) => {
    sink.push({ fields, ctx, meta });
  },
});

// --- Fixtures ---------------------------------------------------------------

/**
 * A realistic queue item, built through `outboxItemSchema` rather than cast, so a
 * change to the document shape breaks these tests instead of letting them drift into
 * asserting against something the queue no longer produces.
 */
const itemAt = (id: string, ctx: unknown): OutboxItem =>
  outboxItemSchema.parse({
    id,
    seq: 0,
    status: "writing",
    idempotencyKey: `key-${id}`,
    attempts: 0,
    nextAttemptAt: "2026-07-23T14:00:00.000Z",
    enqueuedAt: "2026-07-23T14:00:00.000Z",
    recording: {
      id: `rec-${id}`,
      capturedAt: "2026-07-23T14:02:00.000Z",
      durationMs: 8_400,
      mimeType: "audio/webm;codecs=opus",
      ctx,
    },
    hasAudio: false,
    audioBytes: 0,
  });

// --- The happy path ---------------------------------------------------------

test("the reviewed patch and the recording's ctx reach write, both parsed", async () => {
  const written: Write[] = [];
  const step = toWriteStep(makeAdapter(written));

  await step({
    item: itemAt("item-1", { jobId: "job-7", extra: "the host's own business" }),
    // A stray key a UI might have persisted alongside the real leaves.
    reviewed: { rValue: 19, area: 400, notADeclaredLeaf: "🙈" },
    idempotencyKey: "key-item-1",
  });

  // Both sides are the PARSED values: the stray leaf and the host's extra ctx key are
  // gone. Passing either through untouched is what "nothing runs schema.parse" looked
  // like, and it is indistinguishable from this without the strays.
  expect(written).toEqual([
    {
      fields: { rValue: 19, area: 400 },
      ctx: { jobId: "job-7" },
      meta: { idempotencyKey: "key-item-1" },
    },
  ]);
});

test("a rejected leaf stays absent and an accepted null stays present through the parse", async () => {
  const written: Write[] = [];
  const step = toWriteStep(makeAdapter(written));

  await step({
    item: itemAt("item-1", { jobId: "job-7" }),
    // `rValue` accepted as null ("write it empty"); `area` rejected ("leave it alone").
    reviewed: { rValue: null },
    idempotencyKey: "key-item-1",
  });

  const fields = written[0]?.fields;
  expect(fields).toBeDefined();
  expect("rValue" in fields!).toBe(true);
  expect(fields!.rValue).toBeNull();
  expect("area" in fields!).toBe(false);
});

test("the idempotency key reaches write in meta, unchanged across a retry of the same item", async () => {
  const written: Write[] = [];
  const step = toWriteStep(makeAdapter(written));
  const input = {
    item: itemAt("item-1", { jobId: "job-7" }),
    reviewed: { rValue: 19 },
    idempotencyKey: "key-item-1",
  };

  // The relay hands the same item back after a transient failure; the key is the item's,
  // not the attempt's, which is the only thing standing between an ambiguous success and
  // a double-write.
  await step(input);
  await step(input);

  expect(written.map((w) => w.meta.idempotencyKey)).toEqual(["key-item-1", "key-item-1"]);
});

// --- The per-item context ---------------------------------------------------

test("two items from two jobs write to two destinations", async () => {
  // THE regression guard for the captured-ctx bug. `toWriteStep` takes no `ctx`: a
  // composition that resolved one at construction (or memoized the first item's) would
  // send the second recording's findings to the first recording's job — silently, with
  // no failure anywhere. Both items go through ONE step instance, because a step built
  // per item would not exercise the thing that breaks.
  const written: Write[] = [];
  const step = toWriteStep(makeAdapter(written));

  await step({
    item: itemAt("item-1", { jobId: "job-7" }),
    reviewed: { rValue: 19 },
    idempotencyKey: "key-item-1",
  });
  await step({
    item: itemAt("item-2", { jobId: "job-8" }),
    reviewed: { rValue: 30 },
    idempotencyKey: "key-item-2",
  });

  expect(written.map((w) => w.ctx.jobId)).toEqual(["job-7", "job-8"]);
  // Paired with the fields, so a step that got the contexts right by accident (e.g. by
  // reading them in the wrong order) is still caught.
  expect(written.map((w) => [w.ctx.jobId, w.fields.rValue])).toEqual([
    ["job-7", 19],
    ["job-8", 30],
  ]);
});

// --- The two terminal failures ----------------------------------------------

test("a patch the adapter's schema rejects is terminal, and write is never called", async () => {
  const written: Write[] = [];
  const step = toWriteStep(makeAdapter(written));

  const thrown = await step({
    item: itemAt("item-1", { jobId: "job-7" }),
    reviewed: { rValue: "thirty" },
    idempotencyKey: "key-item-1",
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(thrown).toBeInstanceOf(TerminalQueueError);
  expect((thrown as Error).message).toContain("item-1");
  // The failing leaf is named, so an operator reading a dead row knows which one.
  expect((thrown as Error).message).toContain("rValue");
  // Deterministic: it fails identically on retry, so retrying only delays telling a human.
  expect(isTransientFailure(thrown)).toBe(false);
  // Nothing partially-validated reaches a customer's tool.
  expect(written).toEqual([]);
});

test("a recording ctx the adapter's ctxSchema rejects is terminal, and write is never called", async () => {
  const written: Write[] = [];
  const step = toWriteStep(makeAdapter(written));

  const thrown = await step({
    // An empty `jobId` — a write with no destination, not a harmless default. The patch
    // below is perfectly valid, so the ctx is the only thing wrong.
    item: itemAt("item-1", { jobId: "" }),
    reviewed: { rValue: 19 },
    idempotencyKey: "key-item-1",
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(thrown).toBeInstanceOf(TerminalQueueError);
  expect((thrown as Error).message).toContain("jobId");
  expect((thrown as Error).message).toContain("Recording.ctx");
  expect(isTransientFailure(thrown)).toBe(false);
  expect(written).toEqual([]);
});

// --- The classification, as the relay actually applies it -------------------

const opened: { outbox: Outbox; name: string; storage: RxStorage<unknown, unknown> }[] = [];

afterEach(async () => {
  for (const { outbox, name, storage } of opened.splice(0)) {
    if (!outbox.closed) await outbox.close();
    await removeOutboxDatabase(name, storage);
  }
});

const openMemoryOutbox = async (): Promise<Outbox> => {
  const storage = getRxStorageMemory();
  const name = `ribo-write-step-${crypto.randomUUID()}`;
  const outbox = await openOutbox({ name, storage });
  opened.push({ outbox, name, storage });
  return outbox;
};

test("the relay records a terminal write failure as dead on the first attempt, not failed", async () => {
  // `TerminalQueueError` is only intent until something acts on it. This drives the real
  // relay over an in-memory outbox: `isTransientFailure` returns false, `#recordFailure`
  // takes the `dead` branch, and the item is out of the queue after ONE attempt rather
  // than resting in `failed` for eight backoff windows. Asserting the error class alone
  // would prove none of that.
  const outbox = await openMemoryOutbox();
  const written: Write[] = [];

  const enqueued = await outbox.enqueue({
    recording: {
      id: "rec-1",
      capturedAt: "2026-07-23T14:02:00.000Z",
      durationMs: 8_400,
      mimeType: "audio/webm;codecs=opus",
      ctx: { jobId: "job-7" },
    },
    audio: new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
  });

  // Straight to the write step: transcript and extraction are already done, and a human
  // has reviewed. The reviewed patch is the invalid one — non-empty, so the relay's own
  // empty-outcome guard is not what refuses it.
  await outbox.patch(enqueued.id, {
    transcript: { recordingId: "rec-1", text: "the attic is R-19", engine: "fake" },
    extracted: { rValue: { value: 19, confidence: 1, sourceSpan: "the attic is R-19" } },
    status: "awaiting-review",
  });
  await outbox.submitReview(enqueued.id, {
    status: "edited",
    fields: { rValue: "thirty" },
    editedFields: ["rValue"],
    rejectedFields: [],
  });

  const relay = createRelay({
    outbox,
    transcriber: new FakeTranscriber(),
    extract: () => Promise.reject(new Error("extraction should not run")),
    write: toWriteStep(makeAdapter(written)),
  });
  await relay.syncNow();

  const dead = await outbox.get(enqueued.id);
  expect(dead?.status).toBe("dead");
  expect(dead?.attempts).toBe(1);
  expect(dead?.lastError).toContain("not a valid patch");
  expect(written).toEqual([]);
});
