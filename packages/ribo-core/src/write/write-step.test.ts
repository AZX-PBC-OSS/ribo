import { createMemoryBackend, removeMemoryDatabase } from "../storage/memory-backend.js";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";

import type { ToolAdapter, WriteMetadata } from "./adapter.js";
import { enveloped } from "../provenance/enveloped.js";
import { FakeTranscriber } from "../transcription/fake-transcriber.js";
import { isTransientFailure, TerminalError } from "../storage/backoff.js";
import { openStorage, type Storage } from "../storage/storage.js";
import { createRelay, type SessionWriteInput } from "../storage/relay.js";
import { restrictToKind } from "../transcription/restrict-to-kind.js";
import { sessionItemSchema, type SessionItem } from "../storage/session-schema.js";
import { toWriteStep } from "./write-step.js";

/**
 * `SessionWriteInput.recordReceipt` is required, so every input literal here supplies
 * one. A test that cares what was checkpointed passes its own recorder instead.
 */
const noRecordReceipt = async (): Promise<void> => {};

/**
 * @file `toWriteStep` — the trust boundary, and the per-session context resolution.
 *
 * The composition under test is three lines long, and every one of them is here
 * because something else would have been silently wrong:
 *
 *   - `ctxSchema.parse(input.ctx)` **per session**, because the storage holds
 *     recordings from more than one job at a time. The two-contexts test below is the
 *     regression guard for a composition that captured one `ctx` at construction.
 *   - `schema.parse(reviewed)`, because `RelayOptions.sessionWrite` is host-supplied and
 *     nothing else in this package runs it — the "adapter's schema is the trust
 *     boundary" reasoning described a boundary that was not installed anywhere.
 *   - `TerminalError` on either failure, because both are deterministic. The last
 *     test drives the REAL relay over an in-memory storage rather than asserting the
 *     error class alone: what matters is the session landing at `dead` on the first
 *     attempt, and that is a claim about `isTransientFailure` and `#recordSessionFailure`
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
    return { receipt: `uuid-${meta.idempotencyKey}` };
  },
});

// --- Fixtures ---------------------------------------------------------------

/**
 * A realistic session, built through `sessionItemSchema` rather than cast, so a
 * change to the document shape breaks these tests instead of letting them drift into
 * asserting against something the queue no longer produces.
 */
const sessionAt = (id: string): SessionItem =>
  sessionItemSchema.parse({
    id,
    status: "writing",
    openedAt: "2026-07-23T14:00:00.000Z",
    ctx: { jobId: "job-7" },
    ref: "job-7",
    attempts: 0,
    nextAttemptAt: "2026-07-23T14:00:00.000Z",
    idempotencyKey: `key-${id}`,
  });

// --- The happy path ---------------------------------------------------------

test("the reviewed patch and the session's ctx reach write, both parsed", async () => {
  const written: Write[] = [];
  const step = toWriteStep(makeAdapter(written));

  const result = await step({
    recordReceipt: noRecordReceipt,
    session: sessionAt("session-1"),
    // A stray key a UI might have persisted alongside the real leaves.
    reviewed: { rValue: 19, area: 400, notADeclaredLeaf: "🙈" },
    idempotencyKey: "key-session-1",
    ctx: { jobId: "job-7", extra: "the host's own business" },
  });

  expect(result).toEqual({ receipts: { singleton: "uuid-key-session-1" } });
  // Both sides are the PARSED values: the stray leaf and the host's extra ctx key are
  // gone. Passing either through untouched is what "nothing runs schema.parse" looked
  // like, and it is indistinguishable from this without the strays.
  expect(written).toEqual([
    {
      fields: { rValue: 19, area: 400 },
      ctx: { jobId: "job-7" },
      meta: { idempotencyKey: "key-session-1" },
    },
  ]);
});

test("a rejected leaf stays absent and an accepted null stays present through the parse", async () => {
  const written: Write[] = [];
  const step = toWriteStep(makeAdapter(written));

  await step({
    recordReceipt: noRecordReceipt,
    session: sessionAt("session-1"),
    // `rValue` accepted as null ("write it empty"); `area` rejected ("leave it alone").
    reviewed: { rValue: null },
    idempotencyKey: "key-session-1",
    ctx: { jobId: "job-7" },
  });

  const fields = written[0]?.fields;
  expect(fields).toBeDefined();
  expect("rValue" in fields!).toBe(true);
  expect(fields!.rValue).toBeNull();
  expect("area" in fields!).toBe(false);
});

test("the idempotency key reaches write in meta, unchanged across a retry of the same session", async () => {
  const written: Write[] = [];
  const step = toWriteStep(makeAdapter(written));
  const input = {
    recordReceipt: noRecordReceipt,
    session: sessionAt("session-1"),
    reviewed: { rValue: 19 },
    idempotencyKey: "key-session-1",
    ctx: { jobId: "job-7" },
  };

  // The relay hands the same session back after a transient failure, and the key is
  // the session's rather than the attempt's — so the same key reaches the vendor
  // twice. That stability is all this pins. It is NOT double-write protection:
  // Snugg Pro ignores `Idempotency-Key` (measured 2026-09-21), and for a one-patch
  // write the protection is that the endpoint is an upsert addressed by job.
  await step(input);
  await step(input);

  expect(written.map((w) => w.meta.idempotencyKey)).toEqual(["key-session-1", "key-session-1"]);
});

// --- The per-item context ---------------------------------------------------

test("two sessions from two jobs write to two destinations", async () => {
  // THE regression guard for the captured-ctx bug. `toWriteStep` takes no `ctx`: a
  // composition that resolved one at construction (or memoized the first session's)
  // would send the second session's findings to the first session's job — silently,
  // with no failure anywhere. Both sessions go through ONE step instance, because a
  // step built per session would not exercise the thing that breaks.
  const written: Write[] = [];
  const step = toWriteStep(makeAdapter(written));

  await step({
    recordReceipt: noRecordReceipt,
    session: sessionAt("session-1"),
    reviewed: { rValue: 19 },
    idempotencyKey: "key-session-1",
    ctx: { jobId: "job-7" },
  });
  await step({
    recordReceipt: noRecordReceipt,
    session: sessionAt("session-2"),
    reviewed: { rValue: 30 },
    idempotencyKey: "key-session-2",
    ctx: { jobId: "job-8" },
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
    recordReceipt: noRecordReceipt,
    session: sessionAt("session-1"),
    reviewed: { rValue: "thirty" },
    idempotencyKey: "key-session-1",
    ctx: { jobId: "job-7" },
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(thrown).toBeInstanceOf(TerminalError);
  expect((thrown as Error).message).toContain("session-1");
  // The failing leaf is named, so an operator reading a dead row knows which one.
  expect((thrown as Error).message).toContain("rValue");
  // Deterministic: it fails identically on retry, so retrying only delays telling a human.
  expect(isTransientFailure(thrown)).toBe(false);
  // Nothing partially-validated reaches a customer's tool.
  expect(written).toEqual([]);
});

test("a session ctx the adapter's ctxSchema rejects is terminal, and write is never called", async () => {
  const written: Write[] = [];
  const step = toWriteStep(makeAdapter(written));

  const thrown = await step({
    recordReceipt: noRecordReceipt,
    session: sessionAt("session-1"),
    // An empty `jobId` — a write with no destination, not a harmless default. The patch
    // below is perfectly valid, so the ctx is the only thing wrong.
    reviewed: { rValue: 19 },
    idempotencyKey: "key-session-1",
    ctx: { jobId: "" },
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(thrown).toBeInstanceOf(TerminalError);
  expect((thrown as Error).message).toContain("jobId");
  expect((thrown as Error).message).toContain("storage.sessions.open");
  expect(isTransientFailure(thrown)).toBe(false);
  expect(written).toEqual([]);
});

test("the ctx is parsed first: a session wrong in both ways reports the ctx", async () => {
  // The file documents this ordering and gives a reason — a session whose destination is
  // unusable has a problem with the recording, not with the review — so it is pinned.
  // Both failures are terminal, so the order cannot change the session's fate; it decides
  // only which message an operator reads off a dead row, which is the whole point.
  const written: Write[] = [];
  const step = toWriteStep(makeAdapter(written));

  const thrown = await step({
    recordReceipt: noRecordReceipt,
    session: sessionAt("session-1"),
    reviewed: { rValue: "thirty" },
    idempotencyKey: "key-session-1",
    ctx: { jobId: "" },
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect((thrown as Error).message).toContain("storage.sessions.open");
  expect((thrown as Error).message).not.toContain("not a valid patch");
  expect(written).toEqual([]);
});

test("a failing write propagates unchanged — the relay's retry contract is not swallowed", async () => {
  // Nothing else in this file would notice a `try/catch` around the `await`, and such a
  // wrapper is a plausible thing for someone to add while "improving the error message".
  // The cost would be silent: a network failure is the most common thing a real adapter's
  // `write` produces and it is precisely what must be RETRIED, so swallowing it (or
  // rethrowing something new, which strips the `status` that `isTransientFailure` reads)
  // would turn a recoverable 503 into a dead queue row.
  const failure = Object.assign(new Error("snuggpro returned 503"), { status: 503 });
  const adapter: ToolAdapter<AtticValues, JobContext> = {
    ...makeAdapter([]),
    write: () => Promise.reject(failure),
  };

  const thrown = await toWriteStep(adapter)({
    recordReceipt: noRecordReceipt,
    session: sessionAt("session-1"),
    reviewed: { rValue: 19 },
    idempotencyKey: "key-session-1",
    ctx: { jobId: "job-7" },
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  // The SAME error object, by identity: not wrapped, not re-thrown as something else.
  expect(thrown).toBe(failure);
  // And still classified as transient, which is the property that actually matters.
  expect(isTransientFailure(thrown)).toBe(true);
  expect(thrown).not.toBeInstanceOf(TerminalError);
});

// --- The classification, as the relay actually applies it -------------------

const opened: { storage: Storage; name: string }[] = [];

afterEach(async () => {
  for (const { storage, name } of opened.splice(0)) {
    if (!storage.closed) await storage.close();
    // A memory database outlives its handle, as an IndexedDB one does.
    removeMemoryDatabase(name);
  }
});

const openMemoryOutbox = async (): Promise<Storage> => {
  const name = `ribo-write-step-${crypto.randomUUID()}`;
  const storage = await openStorage({ backend: createMemoryBackend(name) });
  opened.push({ storage, name });
  return storage;
};

test("the relay records a terminal write failure as dead on the first attempt, not failed", async () => {
  // `TerminalError` is only intent until something acts on it. This drives the real
  // relay over an in-memory outbox: `isTransientFailure` returns false,
  // `#recordSessionFailure` takes the `dead` branch, and the session is out of the queue
  // after ONE attempt rather than resting in `failed` for eight backoff windows.
  // Asserting the error class alone would prove none of that.
  const storage = await openMemoryOutbox();
  const written: Write[] = [];

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

  // Transcribe the recording, then set up the session for write: extracted +
  // awaiting-review. The reviewed patch is the invalid one — non-empty, so the
  // relay's own empty-outcome guard is not what refuses it.
  await storage.captures.patch(enqueued.id, {
    transcript: { recordingId: "rec-1", text: "the attic is R-19", engine: "fake" },
    status: "transcribed",
  });
  await storage.sessions.patch(session.id, {
    extracted: { rValue: { value: 19, confidence: 1, sourceSpan: "the attic is R-19" } },
    extractedFromRecordingIds: [enqueued.id],
    status: "awaiting-review",
  });
  await storage.sessions.submitReview(session.id, {
    status: "edited",
    fields: { rValue: "thirty" },
    editedFields: ["rValue"],
    rejectedFields: [],
  });

  const relay = createRelay({
    storage,
    transcriber: restrictToKind("audio", new FakeTranscriber()),
    sessionExtract: () => Promise.reject(new Error("extraction should not run")),
    sessionWrite: toWriteStep(makeAdapter(written)),
  });
  await relay.syncNow();

  const dead = await storage.sessions.get(session.id);
  expect(dead?.status).toBe("dead");
  expect(dead?.attempts).toBe(1);
  expect(dead?.lastError).toContain("not a valid patch");
  expect(written).toEqual([]);
});

test("SessionWriteInput refuses a literal that omits recordReceipt", () => {
  // Why the member is required rather than optional, pinned so it stays that way.
  // Snugg Pro ignores `Idempotency-Key` (measured 2026-09-21), so the per-instance
  // receipt checkpoint is the only thing between an interrupted write and a
  // duplicate record on a customer's audit. As an OPTIONAL member it read as a
  // convenience and behaved as an opt-out: `recordReceipt?.(…)` short-circuits in
  // silence, so a caller that forgot it would accumulate receipts in a local
  // closure, lose all of them to a mid-loop throw, and re-create every instance on
  // the retry — reinstating the exact defect, with nothing raised to notice it.
  //
  // The `@ts-expect-error` IS the assertion: it fails the typecheck if the member
  // ever goes back to optional, which is the only way this regression could return.
  // @ts-expect-error - recordReceipt is required; a literal omitting it must not compile
  const withoutReceipt: SessionWriteInput = {
    session: sessionAt("session-refusal"),
    reviewed: {},
    idempotencyKey: "key-session-refusal",
    ctx: { jobId: "job-7" },
  };
  expect(withoutReceipt.idempotencyKey).toBe("key-session-refusal");
});
