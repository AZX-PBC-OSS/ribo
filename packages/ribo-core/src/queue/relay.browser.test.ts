import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { Recording } from "../recording.js";
import { FakeTranscriber } from "../fake-transcriber.js";
import { firstCapable } from "../first-capable.js";
import { removeOutboxDatabase } from "./database.js";
import { TerminalQueueError } from "./backoff.js";
import { openOutbox, type Outbox } from "./outbox.js";
import { reviewOutcomeSchema } from "../review.js";
import {
  createRelay,
  type ExtractedFieldMap,
  type SessionExtractStep,
  type Relay,
  type SessionWriteStep,
  type SessionWriteInput,
} from "./relay.js";
import type { OutboxItem } from "./schema.js";
import type { SessionItem } from "./session-schema.js";
import type { Transcriber } from "../transcriber.js";
import { createConnectivity, type ScheduleTimer } from "../connectivity.js";

// Browser mode because the relay drives the real RxDB/IndexedDB outbox. The
// state machine is only interesting *against durable storage* — the assertions
// that matter here are about what survives a close and reopen, which is exactly
// what jsdom's IndexedDB shim cannot tell the truth about.
//
// `FakeTranscriber` (Phase 1) supplies the transcription step, including its
// built-in persistent and one-shot failure injection, so no model is loaded.

const recording: Recording = {
  id: "rec-1",
  capturedAt: "2026-07-23T10:00:00.000Z",
  durationMs: 1000,
  mimeType: "audio/webm;codecs=opus",
  ctx: { jobId: "job-7" },
};

const SESSION_ID = "test-session";

function audio(): Blob {
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm;codecs=opus" });
}

/** A clock the test moves by hand — no real waiting, and no `vi.useFakeTimers`. */
class TestClock {
  #ms = Date.parse("2026-07-23T10:00:00.000Z");
  now = (): number => this.#ms;
  advance(ms: number): void {
    this.#ms += ms;
  }
}

/**
 * A `setEventListener`-shaped fake connectivity source. `bind` stores the change
 * callback; `flip` sets the link-layer answer and fires one raw transition — the
 * same shape the field app gives the connectivity model from `window`.
 */
class FakeSource {
  #onChange: (() => void) | undefined;
  online = false;
  isOnline = (): boolean => this.online;
  bind = (onChange: () => void): (() => void) => {
    this.#onChange = onChange;
    return () => {
      this.#onChange = undefined;
    };
  };
  flip(online: boolean): void {
    this.online = online;
    this.#onChange?.();
  }
}

/**
 * A hand-driven timer scheduler for the connectivity model's stability window.
 *
 * Deliberately NOT `vi.useFakeTimers()`: the relay drives the real RxDB/IndexedDB
 * outbox, whose async work would deadlock against faked global timers (the same
 * reason this file uses a manual `TestClock` for the relay's own clock). Only the
 * connectivity window is advanced by hand; every RxDB await runs on real timers.
 */
class ManualTimers {
  #pending: { id: number; fn: () => void; at: number }[] = [];
  #now = 0;
  #next = 1;
  schedule: ScheduleTimer = (fn, ms) => {
    const id = this.#next++;
    this.#pending.push({ id, fn, at: this.#now + ms });
    return () => {
      this.#pending = this.#pending.filter((timer) => timer.id !== id);
    };
  };
  advance(ms: number): void {
    this.#now += ms;
    const due = this.#pending.filter((timer) => timer.at <= this.#now).sort((a, b) => a.at - b.at);
    this.#pending = this.#pending.filter((timer) => timer.at > this.#now);
    for (const timer of due) timer.fn();
  }
}

/** Flush microtasks so a `Promise`-returning probe settles (real macrotask turn). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A cheap always-healthy probe. */
const healthyProbe = async (): Promise<Response> => new Response(null, { status: 204 });

const names: string[] = [];
const open: Outbox[] = [];
let clock: TestClock;

async function openTestOutbox(name: string): Promise<Outbox> {
  const outbox = await openOutbox({ name, now: clock.now });
  open.push(outbox);
  return outbox;
}

function uniqueName(): string {
  const name = `ribo-relay-test-${crypto.randomUUID()}`;
  names.push(name);
  return name;
}

beforeEach(() => {
  clock = new TestClock();
});

afterEach(async () => {
  for (const outbox of open.splice(0)) if (!outbox.closed) await outbox.close();
  for (const name of names.splice(0)) await removeOutboxDatabase(name);
});

interface Harness {
  outbox: Outbox;
  relay: Relay;
  transcriber: Transcriber;
  session: SessionItem;
  extractCalls: { transcript: string; session: SessionItem }[];
  /**
   * The whole {@link SessionWriteInput}, not a projection of it. Tests need to tell
   * `reviewed` (what the human settled on) apart from `session.extracted` (what the
   * model said), and recording only some fields is how that distinction would go
   * unasserted.
   */
  writeCalls: SessionWriteInput[];
}

async function buildRelay(
  outbox: Outbox,
  overrides: {
    transcriber?: Transcriber;
    sessionExtract?: SessionExtractStep;
    sessionWrite?: SessionWriteStep;
    maxAttempts?: number;
    random?: () => number;
    dropAudioAfterTranscription?: boolean;
    locks?: LockManager;
  } = {},
): Promise<Harness> {
  const transcriber: Transcriber =
    overrides.transcriber ?? new FakeTranscriber({ text: "the attic is R-19" });
  const extractCalls: Harness["extractCalls"] = [];
  const writeCalls: Harness["writeCalls"] = [];

  const sessionExtract: SessionExtractStep =
    overrides.sessionExtract ??
    (async ({ transcript, session }) => {
      extractCalls.push({ transcript, session });
      return { fields: { atticInsulation: transcript } };
    });

  const sessionWrite: SessionWriteStep =
    overrides.sessionWrite ??
    (async (input) => {
      writeCalls.push(input);
      return { remoteId: "snugg-1" };
    });

  const relay = createRelay({
    outbox,
    transcriber,
    sessionExtract,
    sessionWrite,
    now: clock.now,
    // Deterministic full jitter: always the top of the window, so
    // `nextAttemptAt` is predictable without weakening the formula.
    random: overrides.random ?? (() => 1),
    // Deliberately NOT the default of 1000. An earlier draft of this file set a
    // misspelled option and every backoff assertion still passed, because the
    // numbers it expected happened to be the defaults. A non-default base is
    // what makes these tests prove the option is wired through at all.
    baseMs: 500,
    capMs: 60_000,
    maxAttempts: overrides.maxAttempts,
    dropAudioAfterTranscription: overrides.dropAudioAfterTranscription,
    locks: overrides.locks,
  });

  // Reuse an existing session (two-tabs tests build two harnesses from the
  // same outbox) or create one on the first call.
  let session = await outbox.getSession(SESSION_ID);
  if (!session)
    session = await outbox.openSession({
      id: SESSION_ID,
      ctx: { jobId: "job-7" },
      ref: "job-7",
    });

  return { outbox, relay, transcriber, session, extractCalls, writeCalls };
}

// ---------------------------------------------------------------------------
// Getting past the review gate
// ---------------------------------------------------------------------------
//
// The relay transcribes recordings to `transcribed`, then — once the host
// closes the session — extracts at session level and parks the session at
// `awaiting-review`. **No drain in this file reaches the write step on its
// own.** That is the gate, and every test below either stops at it or is
// helped over it by one of these three helpers.

/**
 * Drain recordings (transcribe), close the session, then drain sessions
 * (extract), ending at the review gate.
 *
 * Named rather than inlined at the call sites that expect a park, so those tests
 * say what they expect of the drain: run every step the relay owns, then stop.
 * Tests about the drain *triggers* (start, connectivity edges, overlap) still call
 * `syncNow` directly — the trigger is their subject.
 */
const drainToReview = async (harness: Harness): Promise<void> => {
  await harness.relay.syncNow();
  await harness.outbox.closeSession(harness.session.id);
  await harness.relay.syncNow();
};

/**
 * Accept a parked session's fields, making it eligible to write.
 *
 * A thin alias for `submitSessionReview` with an accepted outcome, kept named
 * because the call sites read as what a human did rather than as an outbox
 * write. It is also the only door: `submitSessionReview` refuses any status
 * but `awaiting-review`, so a test that wants a writable session has to park
 * it first — which is the production path, not a shortcut around it.
 */
const acceptReview = async (
  outbox: Outbox,
  sessionId: string,
  fields: ExtractedFieldMap = { atticInsulation: "the attic is R-19" },
): Promise<SessionItem> =>
  await outbox.submitSessionReview(sessionId, { status: "accepted", fields });

/**
 * Open a session, enqueue a recording, transcribe it, close the session,
 * extract, park for review, and accept — so the next drain runs exactly one
 * step: the write.
 *
 * The write-retry, idempotency, backoff and terminal-failure tests use this
 * rather than driving a fresh capture through the whole pipeline. They are
 * about what happens *around* a write, and a fresh capture would need a
 * session close and review to reach one. Seeding keeps each of those tests
 * testing the one thing it was written for.
 *
 * `fields` defaults to matching `extracted`, which is what an accept-as-is
 * really does; pass something different to prove a value came from the
 * review outcome rather than from the model's map.
 */
async function seedReviewedWriting(
  outbox: Outbox,
  options: { recording?: Recording; fields?: ExtractedFieldMap } = {},
): Promise<{ session: SessionItem; recordingItem: OutboxItem }> {
  const session = await outbox.openSession({ ctx: { jobId: "job-7" }, ref: "job-7" });
  const rec = options.recording ?? recording;
  const recordingItem = await outbox.enqueue({
    recording: rec,
    audio: audio(),
    sessionId: session.id,
  });

  // Transcribe the recording.
  await outbox.patch(recordingItem.id, {
    transcript: { recordingId: rec.id, text: "the attic is R-19", engine: "fake" },
    status: "transcribed",
  });

  // Close the session and patch it to `awaiting-review` with extracted data,
  // then accept the review to move it to `writing`.
  await outbox.closeSession(session.id);
  await outbox.patchSession(session.id, {
    extracted: { atticInsulation: "the attic is R-19" },
    extractedFromRecordingIds: [rec.id],
    status: "awaiting-review",
  });
  const accepted = await acceptReview(outbox, session.id, options.fields);
  return { session: accepted, recordingItem };
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

/**
 * The harness's transcriber as the fake it is.
 *
 * `Harness.transcriber` is typed as the interface so a test can inject a
 * composite or a hand-rolled stub; the tests that assert on recorded calls know
 * they left the default in place.
 */
const fake = (harness: Harness): FakeTranscriber => harness.transcriber as FakeTranscriber;

test("drives an item from queued through review to done", async () => {
  // The path the product actually takes, in one test: capture → transcribe →
  // extract → park → a human accepts → write → done. Everything else in this file
  // covers a slice of it; this is the only test that walks the whole thing, and
  // it takes two drains because a human stands between them.
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox);
  const item = await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await drainToReview(harness);

  const parked = await outbox.getSession(harness.session.id);
  expect(parked?.status).toBe("awaiting-review");
  expect(parked?.writeResult).toBeUndefined();
  expect(harness.writeCalls).toHaveLength(0);

  await acceptReview(outbox, harness.session.id);
  await harness.relay.syncNow();

  const doneSession = await outbox.getSession(harness.session.id);
  expect(doneSession?.status).toBe("done");
  const doneRecording = await outbox.get(item.id);
  expect(doneRecording?.transcript).toEqual({
    recordingId: "rec-1",
    text: "the attic is R-19",
    engine: "fake",
  });
  expect(doneSession?.extracted).toEqual({ atticInsulation: "the attic is R-19" });
  expect(doneSession?.writeResult).toEqual({ remoteId: "snugg-1" });
  expect(doneSession?.lastError).toBeUndefined();
  expect(harness.writeCalls).toHaveLength(1);
});

test("hands the transcriber the recording metadata and the attachment bytes", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox);
  await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await harness.relay.syncNow();

  expect(fake(harness).calls).toHaveLength(1);
  const call = fake(harness).calls[0]!;
  expect(call.recording).toMatchObject({ id: "rec-1", mimeType: "audio/webm;codecs=opus" });
  expect(new Uint8Array(await call.audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
});

test("passes through the statuses of the 09 state machine, in order", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const seenRecording: string[] = [];
  const seenSession: string[] = [];
  const recSub = outbox.items$.subscribe((items) => {
    const status = items[0]?.status;
    if (status && status !== seenRecording.at(-1)) seenRecording.push(status);
  });
  const harness = await buildRelay(outbox);
  const sessionSub = outbox.watchSessions().subscribe((sessions) => {
    const status = sessions[0]?.status;
    if (status && status !== seenSession.at(-1)) seenSession.push(status);
  });
  await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await drainToReview(harness);
  await vi.waitFor(() => expect(seenSession.at(-1)).toBe("awaiting-review"));

  // The relay stops here on its own. `writing` is NOT in the session list yet,
  // which is the whole gate: an unbroken run to `done` would mean un-reviewed
  // model output reached the host tool.
  expect(seenRecording).toEqual(["queued", "transcribing", "transcribed"]);
  expect(seenSession).toEqual(["open", "extracting", "awaiting-review"]);

  await acceptReview(outbox, harness.session.id);
  await harness.relay.syncNow();
  await vi.waitFor(() => expect(seenSession.at(-1)).toBe("done"));
  recSub.unsubscribe();
  sessionSub.unsubscribe();

  expect(seenRecording).toEqual(["queued", "transcribing", "transcribed"]);
  expect(seenSession).toEqual(["open", "extracting", "awaiting-review", "writing", "done"]);
});

// ---------------------------------------------------------------------------
// The review gate
// ---------------------------------------------------------------------------
//
// The gate is an *omission*: `awaiting-review` is not in ACTIVE_OUTBOX_STATUSES,
// so `nextPending()` never hands a parked item back and the drain walks past it.
// `schema.test.ts` pins the list itself; all four tests below pin the behaviour it
// buys, and all four fail if someone puts the status back in the list: the relay
// would pick the parked item up, `nextStep()` would see `extracted` and say
// `write`, and every `awaiting-review` assertion here would see `dead` instead.

test("a successful extraction parks the item for review instead of writing it", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox);
  await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await drainToReview(harness);

  const parked = await outbox.getSession(harness.session.id);
  expect(parked?.status).toBe("awaiting-review");
  expect(parked?.extracted).toEqual({ atticInsulation: "the attic is R-19" });
  expect(parked?.reviewOutcome).toBeUndefined();
  expect(harness.writeCalls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Engine provenance
//
// Which engine drafted an extraction has to survive to review, because by then
// the extractor that chose it is long gone and the reviewer's question — "should
// I trust this card less than usual?" — has no other way to be answered. The
// value is computed in the extractor and would be discarded at this boundary
// unless the step carries it and the relay persists it.
// ---------------------------------------------------------------------------

test("the engine an extract step reports is persisted on the item", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, {
    sessionExtract: async ({ transcript }) => ({
      fields: { atticInsulation: transcript },
      engine: "ondevice-prompt-api",
    }),
  });
  await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await drainToReview(harness);

  const parked = await outbox.getSession(harness.session.id);
  expect(parked?.extractedBy).toBe("ondevice-prompt-api");
});

test("an extract step that reports no engine leaves the column absent", async () => {
  // The managed path and every single-transport extractor land here. An absent
  // column must stay absent rather than becoming a persisted `undefined`, since
  // `patch` is incremental and cannot delete a key once written.
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, {
    sessionExtract: async ({ transcript }) => ({ fields: { atticInsulation: transcript } }),
  });
  await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await drainToReview(harness);

  const parked = await outbox.getSession(harness.session.id);
  expect(parked?.extracted).toEqual({ atticInsulation: "the attic is R-19" });
  expect(parked?.extractedBy).toBeUndefined();
});

test("a parked item does not block the recordings behind it", async () => {
  // The point of parking rather than awaiting a presenter: a human reviewing the
  // first recording must not stop the second from transcribing. Both recordings
  // are in the same session, so both get transcribed, then the session is
  // extracted once.
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox);
  for (const id of ["first", "second"]) {
    await outbox.enqueue({
      recording: { ...recording, id },
      audio: audio(),
      sessionId: harness.session.id,
    });
  }

  await drainToReview(harness);

  const items = await outbox.list();
  expect(items.map((entry) => entry.status)).toEqual(["transcribed", "transcribed"]);
  expect(harness.extractCalls).toHaveLength(1);
  expect(harness.writeCalls).toHaveLength(0);
});

test("the write step receives the human's reviewed values, not the model's", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox);
  await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });
  await drainToReview(harness);

  await outbox.submitSessionReview(harness.session.id, {
    status: "edited",
    fields: { atticRValue: 30 },
    editedFields: ["atticRValue"],
    rejectedFields: [],
  });
  await harness.relay.syncNow();

  expect(harness.writeCalls).toHaveLength(1);
  expect(harness.writeCalls[0]?.reviewed).toEqual({ atticRValue: 30 });
  // The auditor's correction shares no key with what the extractor produced, so a
  // regression that passed `session.extracted` through could not satisfy this — the
  // whole reason `SessionWriteInput` carries `reviewed` separately from `session`.
  expect(harness.writeCalls[0]?.session.extracted).toEqual({
    atticInsulation: "the attic is R-19",
  });
});

test("an item reviewed with every field rejected is never written", async () => {
  // `resolveReview` reports "the human rejected everything" as an `edited` outcome
  // with no fields, and `submitSessionReview` unparks it to `writing` like any other
  // edit — collapsing it into a discard would destroy audio the human never asked to
  // throw away. So the refusal has to be here, and it has to be the relay's own:
  // `sessionWrite` is host-supplied, so "the adapter's schema would reject it" is a
  // guarantee nothing in this package enforces.
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox);
  await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });
  await drainToReview(harness);

  const unparked = await outbox.submitSessionReview(harness.session.id, {
    status: "edited",
    fields: {},
    editedFields: [],
    rejectedFields: ["atticInsulation"],
  });
  // Asserted, not assumed: the outcome really is persisted and the session really is
  // eligible to write, so what follows is the relay refusing rather than the gate
  // never having opened.
  expect(unparked.status).toBe("writing");

  await harness.relay.syncNow();

  expect(harness.writeCalls).toHaveLength(0);
  const dead = await outbox.getSession(harness.session.id);
  // `dead`, not `failed`: re-running the write would reach the same conclusion
  // eight more times, and the row is a "needs attention" one a UI should surface.
  expect(dead?.status).toBe("dead");
  expect(dead?.lastError).toMatch(/rejected/i);
  // The human's decision is still on the row, unaltered — the relay refused to act
  // on it, it did not rewrite it.
  expect(dead?.reviewOutcome).toEqual({
    status: "edited",
    fields: {},
    editedFields: [],
    rejectedFields: ["atticInsulation"],
  });
});

test("an accepted review of an extraction that found nothing says so, not that fields were rejected", async () => {
  // The other way `#write` can be handed an empty field set, and a different event:
  // `resolveReview` returns `accepted` with no fields when the *request* had none,
  // i.e. the extractor found nothing at all. Both end `dead`, but an operator
  // reading "the review rejected every field" off this row would go looking for a
  // reviewer who never saw a field to reject.
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, { sessionExtract: async () => ({ fields: {} }) });
  await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });
  await drainToReview(harness);

  await outbox.submitSessionReview(harness.session.id, { status: "accepted", fields: {} });
  await harness.relay.syncNow();

  expect(harness.writeCalls).toHaveLength(0);
  const dead = await outbox.getSession(harness.session.id);
  expect(dead?.status).toBe("dead");
  expect(dead?.lastError).toMatch(/extraction produced no fields/i);
  expect(dead?.lastError).not.toMatch(/rejected/i);
});

test("an item that reaches writing with no review outcome fails terminally", async () => {
  // Defence in depth for the one invariant whose violation is invisible: reaching
  // a write unreviewed is a state-machine bug, so it must not silently write.
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox);
  await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });
  await drainToReview(harness);
  // Asserted, not assumed: without this the test passes even when the relay never
  // parked the item at all, because a `dead` item is `dead` whichever way it got
  // there. This is the line that makes the hand-patch below a *jump over the gate*
  // rather than an incidental status change.
  expect((await outbox.getSession(harness.session.id))?.status).toBe("awaiting-review");

  // The gate jumped by hand — exactly the shape a bug in it would take.
  await outbox.patchSession(harness.session.id, { status: "writing" });
  await harness.relay.syncNow();

  expect(harness.writeCalls).toHaveLength(0);
  const dead = await outbox.getSession(harness.session.id);
  // `dead`, not `failed`: retrying an item whose review is missing would just
  // reach the same conclusion eight more times.
  expect(dead?.status).toBe("dead");
  expect(dead?.lastError).toMatch(/review/i);
});

test("an item whose review discarded the draft never reaches the tool", async () => {
  // The other shape the same bug can take. A discard will move the item to
  // `discarded` and never to `writing`, so a `writing` row carrying a discarded
  // outcome is a broken invariant too — and the one where writing anyway would
  // record values a human explicitly threw away.
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox);
  await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });
  await drainToReview(harness);
  // Same reason as the test above: the park has to be asserted, or a relay that
  // never parked would satisfy every assertion below it.
  expect((await outbox.getSession(harness.session.id))?.status).toBe("awaiting-review");

  await outbox.patchSession(harness.session.id, {
    status: "writing",
    reviewOutcome: reviewOutcomeSchema.parse({ status: "discarded", reason: "wrong property" }),
  });
  await harness.relay.syncNow();

  expect(harness.writeCalls).toHaveLength(0);
  const dead = await outbox.getSession(harness.session.id);
  expect(dead?.status).toBe("dead");
  expect(dead?.lastError).toMatch(/review/i);
});

// ---------------------------------------------------------------------------
// Resumption — the reason step outputs are persisted at all
// ---------------------------------------------------------------------------

test("resumes at the next step after a reload rather than re-recording or re-transcribing", async () => {
  const name = uniqueName();

  // Session one: transcription succeeds, then the session is closed and
  // extraction blows up transiently, and then the "tab dies" — we close the
  // database mid-pipeline.
  const first = await openTestOutbox(name);
  const firstRun = await buildRelay(first, {
    sessionExtract: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  const item = await first.enqueue({ recording, audio: audio(), sessionId: firstRun.session.id });
  await firstRun.relay.syncNow();
  await first.closeSession(firstRun.session.id);
  await firstRun.relay.syncNow();

  const afterCrash = await first.get(item.id);
  expect(afterCrash?.transcript?.text).toBe("the attic is R-19");
  expect(afterCrash?.status).toBe("transcribed");
  expect((await first.getSession(firstRun.session.id))?.status).toBe("failed");
  await first.close();

  // Session two: a fresh database, a fresh relay, and a transcriber that would
  // throw if it were ever asked to do the work again.
  clock.advance(60_000);
  const second = await openTestOutbox(name);
  const explodingTranscriber = new FakeTranscriber();
  explodingTranscriber.failWith(new Error("transcription must not run twice"));
  const secondRun = await buildRelay(second, { transcriber: explodingTranscriber });

  await secondRun.relay.syncNow();

  expect(explodingTranscriber.calls).toHaveLength(0);
  expect(secondRun.extractCalls).toHaveLength(1);
  expect(secondRun.extractCalls[0]?.transcript).toBe("the attic is R-19");
  // It resumed at `extract` and ran to the gate, which is as far as the relay can
  // take a session without a human.
  expect((await second.getSession(secondRun.session.id))?.status).toBe("awaiting-review");
});

test("resumes at the write step when extraction and review already succeeded", async () => {
  const outbox = await openTestOutbox(uniqueName());
  // Reviewed with a field the extractor never produced, so a regression that read
  // `item.extracted` back out at write time could not pass this test.
  const { session: item } = await seedReviewedWriting(outbox, { fields: { atticRValue: 30 } });

  const transcriber = new FakeTranscriber().failWith(new Error("must not transcribe"));
  const harness = await buildRelay(outbox, {
    transcriber,
    sessionExtract: async () => {
      throw new Error("must not extract");
    },
  });
  await harness.relay.syncNow();

  expect((await outbox.getSession(item.id))?.status).toBe("done");
  expect(harness.writeCalls).toHaveLength(1);
  expect(harness.writeCalls[0]?.reviewed).toEqual({ atticRValue: 30 });
  // The model's raw map is still reachable on the item, for provenance.
  expect(harness.writeCalls[0]?.session.extracted).toEqual({
    atticInsulation: "the attic is R-19",
  });
});

// ---------------------------------------------------------------------------
// Empty and near-empty transcripts
// ---------------------------------------------------------------------------
//
// The relay no longer has an implausibility guard. A recording with an empty
// transcript still goes to `transcribed`; the session-level extraction joins
// all transcripts, so an empty one does not block anything. These tests verify
// that the recording transcribes normally and the session extracts on the
// joined transcript.

test("an empty transcript transcribes and the session extracts normally", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, { transcriber: new FakeTranscriber({ text: "" }) });
  const item = await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await drainToReview(harness);

  const parked = await outbox.get(item.id);
  const parkedSession = await outbox.getSession(harness.session.id);
  expect(parked?.status).toBe("transcribed");
  expect(parkedSession?.status).toBe("awaiting-review");
  expect(harness.extractCalls).toHaveLength(1);
  expect(harness.extractCalls[0]?.transcript).toBe("");
  expect(parkedSession?.extracted).toEqual({ atticInsulation: "" });
  expect(parked?.transcript).toEqual({
    recordingId: "rec-1",
    text: "",
    engine: "fake",
  });
});

test("a near-empty transcript transcribes and the session extracts normally", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, { transcriber: new FakeTranscriber({ text: "um" }) });
  const item = await outbox.enqueue({
    recording: { ...recording, durationMs: 240_000 },
    audio: audio(),
    sessionId: harness.session.id,
  });

  await drainToReview(harness);

  const parked = await outbox.get(item.id);
  expect(parked?.status).toBe("transcribed");
  expect(parked?.transcript?.text).toBe("um");
  const parkedSession = await outbox.getSession(harness.session.id);
  expect(parkedSession?.status).toBe("awaiting-review");
  expect(harness.extractCalls).toHaveLength(1);
});

test("a short but plausible transcript still advances to extraction", async () => {
  // "the attic" (9 chars) for a 4-second recording is 2.25 chars/s — above the
  // 0.5 threshold, so the guard does not fire. Extraction runs normally and the
  // item parks at the review gate the usual way.
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, {
    transcriber: new FakeTranscriber({ text: "the attic" }),
  });
  const item = await outbox.enqueue({
    recording: { ...recording, durationMs: 4_000 },
    audio: audio(),
    sessionId: harness.session.id,
  });

  await drainToReview(harness);

  const parked = await outbox.get(item.id);
  const parkedSession = await outbox.getSession(harness.session.id);
  // Extraction ran: the item has extracted data and went through the normal
  // review gate, not the guard's park.
  expect(parkedSession?.status).toBe("awaiting-review");
  expect(harness.extractCalls).toHaveLength(1);
  expect(harness.extractCalls[0]?.transcript).toBe("the attic");
  expect(parked?.transcript?.text).toBe("the attic");
  expect(parkedSession?.extracted).toEqual({ atticInsulation: "the attic" });
});

test("an empty transcript does not block the recordings behind it", async () => {
  // Both recordings are in the same session. Both transcribe (one to an empty
  // string, one to real text), then the session is closed and extracted once
  // on the joined transcript. The empty recording does not block anything.
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, {
    transcriber: new FakeTranscriber({
      responses: { empty: "", real: "the attic is R-19" },
    }),
  });
  await outbox.enqueue({
    recording: { ...recording, id: "empty" },
    audio: audio(),
    sessionId: harness.session.id,
  });
  await outbox.enqueue({
    recording: { ...recording, id: "real" },
    audio: audio(),
    sessionId: harness.session.id,
  });

  await drainToReview(harness);

  const items = await outbox.list();
  expect(items.map((entry) => [entry.recording.id, entry.status])).toEqual([
    ["empty", "transcribed"],
    ["real", "transcribed"],
  ]);
  const session = await outbox.getSession(harness.session.id);
  expect(session?.status).toBe("awaiting-review");
  expect(session?.extracted).toEqual({ atticInsulation: " the attic is R-19" });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("reuses the enqueue-time idempotency key on every retry, never regenerating it", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const keys: string[] = [];
  let attempt = 0;
  const harness = await buildRelay(outbox, {
    sessionWrite: async ({ idempotencyKey }) => {
      keys.push(idempotencyKey);
      attempt += 1;
      if (attempt < 3) throw Object.assign(new Error("gateway"), { status: 503 });
      return { remoteId: "snugg-1" };
    },
  });
  // Seeded past the gate: the key has to survive three *write* attempts, and a
  // fresh capture would park before the first one.
  const { session: item } = await seedReviewedWriting(outbox);

  for (let i = 0; i < 3; i += 1) {
    await harness.relay.syncNow();
    clock.advance(120_000);
  }

  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
  expect(keys[0]).toBe(item.idempotencyKey);
  expect((await outbox.getSession(item.id))?.status).toBe("done");
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

test("a transient failure parks the item with a persisted future nextAttemptAt", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, {
    sessionWrite: async () => {
      throw Object.assign(new Error("gateway"), { status: 502 });
    },
  });
  const { session: item } = await seedReviewedWriting(outbox);

  await harness.relay.syncNow();

  const failed = await outbox.getSession(item.id);
  expect(failed?.status).toBe("failed");
  expect(failed?.attempts).toBe(1);
  expect(failed?.lastError).toContain("gateway");
  // random() === 1, base 500, attempts-before-increment 0 → the full first window.
  expect(Date.parse(failed!.nextAttemptAt)).toBe(clock.now() + 500);
});

test("does not retry before nextAttemptAt, and does after — with the schedule surviving a reload", async () => {
  const name = uniqueName();
  const first = await openTestOutbox(name);
  const failing = async () => {
    throw Object.assign(new Error("gateway"), { status: 502 });
  };
  const firstRun = await buildRelay(first, { sessionWrite: failing });
  const { session: item } = await seedReviewedWriting(first);
  await firstRun.relay.syncNow();
  expect(firstRun.writeCalls).toHaveLength(0);
  const parked = await first.getSession(item.id);
  await first.close();

  // Reopen. Nothing is in memory; only `nextAttemptAt` in IndexedDB knows when
  // this item becomes eligible again. There is no timer anywhere — on iOS there
  // could not be one.
  const second = await openTestOutbox(name);
  expect((await second.getSession(item.id))?.nextAttemptAt).toBe(parked?.nextAttemptAt);
  // The review outcome is persisted too, so the reopened relay is still allowed to
  // write this item. A reload does not send it back to the human.
  expect((await second.getSession(item.id))?.reviewOutcome?.status).toBe("accepted");

  const tooEarly = await buildRelay(second);
  await tooEarly.relay.syncNow();
  expect(tooEarly.writeCalls).toHaveLength(0);
  expect((await second.getSession(item.id))?.status).toBe("failed");

  clock.advance(501);
  const nowDue = await buildRelay(second);
  await nowDue.relay.syncNow();
  expect(nowDue.writeCalls).toHaveLength(1);
  expect((await second.getSession(item.id))?.status).toBe("done");
});

test("the backoff window doubles with each attempt", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, {
    sessionWrite: async () => {
      throw Object.assign(new Error("gateway"), { status: 502 });
    },
  });
  const { session: item } = await seedReviewedWriting(outbox);

  const windows: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    await harness.relay.syncNow();
    const current = await outbox.getSession(item.id);
    windows.push(Date.parse(current!.nextAttemptAt) - clock.now());
    clock.advance(windows.at(-1)! + 1);
  }

  expect(windows).toEqual([500, 1000, 2000, 4000]);
});

// ---------------------------------------------------------------------------
// Terminal failures
// ---------------------------------------------------------------------------

test("a 4xx-equivalent failure goes straight to dead without a retry", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, {
    sessionWrite: async () => {
      throw Object.assign(new Error("unprocessable"), { status: 422 });
    },
  });
  const { session: item } = await seedReviewedWriting(outbox);

  await harness.relay.syncNow();
  clock.advance(600_000);
  await harness.relay.syncNow();

  const dead = await outbox.getSession(item.id);
  expect(dead?.status).toBe("dead");
  expect(dead?.attempts).toBe(1);
  expect(dead?.lastError).toContain("unprocessable");
  expect(harness.writeCalls).toHaveLength(0);
});

test("an explicit TerminalQueueError is terminal too", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, {
    sessionExtract: async () => {
      throw new TerminalQueueError("this transcript can never be extracted");
    },
  });
  await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await harness.relay.syncNow();
  await outbox.closeSession(harness.session.id);
  await harness.relay.syncNow();
  expect((await outbox.getSession(harness.session.id))?.status).toBe("dead");
});

test("missing audio is terminal, not an infinite retry loop", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox);
  const item = await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });
  await outbox.dropAudio(item.id);

  await harness.relay.syncNow();

  const dead = await outbox.get(item.id);
  expect(dead?.status).toBe("dead");
  expect(dead?.lastError).toMatch(/audio/i);
  expect(fake(harness).calls).toHaveLength(0);
});

test("gives up and goes dead once maxAttempts transient failures have accumulated", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, {
    maxAttempts: 3,
    sessionWrite: async () => {
      throw Object.assign(new Error("gateway"), { status: 502 });
    },
  });
  const { session: item } = await seedReviewedWriting(outbox);

  for (let i = 0; i < 5; i += 1) {
    await harness.relay.syncNow();
    clock.advance(600_000);
  }

  const dead = await outbox.getSession(item.id);
  expect(dead?.status).toBe("dead");
  expect(dead?.attempts).toBe(3);
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("processes serially, lowest seq first", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const order: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const harness = await buildRelay(outbox, {
    sessionWrite: async ({ session }) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      order.push(session.id);
      concurrent -= 1;
      return {};
    },
  });

  // Three rows already reviewed, so all three reach the write step in one drain.
  // Each `seedReviewedWriting` opens a new session, so the write order is the
  // sessions' `openedAt` order — which matches the seeding order here.
  const sessionToRecording: Record<string, string> = {};
  for (const id of ["c", "a", "b"]) {
    const { session } = await seedReviewedWriting(outbox, { recording: { ...recording, id } });
    sessionToRecording[session.id] = id;
    clock.advance(1);
  }
  await harness.relay.syncNow();

  expect(order.map((sid) => sessionToRecording[sid])).toEqual(["c", "a", "b"]);
  expect(maxConcurrent).toBe(1);
});

test("writes follow review order, not capture order", async () => {
  // With sessions, each session has one review and one write. The concept of
  // "review order" applies to multiple sessions: a human reviewing the second
  // session first means it writes first. Enforcing capture order here would let
  // one un-reviewed session block every write behind it — the exact stall the
  // parked design exists to avoid.
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox);

  const sessionA = await outbox.openSession({ ctx: { jobId: "job-7" }, ref: "job-7" });
  const sessionB = await outbox.openSession({ ctx: { jobId: "job-7" }, ref: "job-7" });
  await outbox.enqueue({
    recording: { ...recording, id: "first" },
    audio: audio(),
    sessionId: sessionA.id,
  });
  await outbox.enqueue({
    recording: { ...recording, id: "second" },
    audio: audio(),
    sessionId: sessionB.id,
  });

  // Both transcribe, both close, both extract — both park at awaiting-review.
  await harness.relay.syncNow();
  await outbox.closeSession(sessionA.id);
  await outbox.closeSession(sessionB.id);
  await harness.relay.syncNow();

  // Review the second session first, so it is the one that writes.
  await outbox.submitSessionReview(sessionB.id, {
    status: "accepted",
    fields: { atticRValue: 30 },
  });
  await harness.relay.syncNow();

  expect(harness.writeCalls).toHaveLength(1);
  expect(harness.writeCalls[0]?.session.id).toBe(sessionB.id);
  // The first session is untouched and still waiting on its human. It did not
  // block the write, and the write did not disturb it.
  expect((await outbox.getSession(sessionA.id))?.status).toBe("awaiting-review");
});

test("a parked head-of-queue item holds the queue, preserving capture order", async () => {
  const outbox = await openTestOutbox(uniqueName());
  let firstSessionId = "";
  const harness = await buildRelay(outbox, {
    sessionWrite: async ({ session }) => {
      if (session.id === firstSessionId) throw Object.assign(new Error("gw"), { status: 502 });
      return {};
    },
  });
  const { session: first } = await seedReviewedWriting(outbox, {
    recording: { ...recording, id: "first" },
  });
  firstSessionId = first.id;
  const second = await outbox.enqueue({
    recording: { ...recording, id: "second" },
    audio: audio(),
    sessionId: harness.session.id,
  });

  await harness.relay.syncNow();

  // The first session's write fails (transient), but the second recording still
  // transcribes — recordings are independent of session write status.
  expect((await outbox.getSession(first.id))?.status).toBe("failed");
  expect((await outbox.get(second.id))?.status).toBe("transcribed");
});

test("a dead item does not block the queue behind it", async () => {
  const outbox = await openTestOutbox(uniqueName());
  let firstSessionId = "";
  const harness = await buildRelay(outbox, {
    sessionWrite: async ({ session }) => {
      if (session.id === firstSessionId) throw Object.assign(new Error("bad"), { status: 400 });
      return {};
    },
  });
  const { session: first } = await seedReviewedWriting(outbox, {
    recording: { ...recording, id: "first" },
  });
  firstSessionId = first.id;
  const second = await outbox.enqueue({
    recording: { ...recording, id: "second" },
    audio: audio(),
    sessionId: harness.session.id,
  });

  await harness.relay.syncNow();

  expect((await outbox.getSession(first.id))?.status).toBe("dead");
  // `second` got transcribed — the relay is done with the recording. That it
  // moved at all is the point: blocking behind a dead session would strand it.
  expect((await outbox.get(second.id))?.status).toBe("transcribed");
});

// ---------------------------------------------------------------------------
// Foreground triggers — no service worker, no background sync
// ---------------------------------------------------------------------------

test("drains once at start, which is the app-start trigger", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox);
  const item = await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await harness.relay.start();

  // A drain happened, which is what this test is about; where it ends is the
  // review gate's business, not the trigger's.
  expect((await outbox.get(item.id))?.status).toBe("transcribed");
  harness.relay.stop();
});

/**
 * Wires a relay to a real {@link createConnectivity} model over hand-driven
 * fakes. Returns the pieces a test drives: the source it flaps, the timers it
 * advances, and the relay/outbox.
 */
async function wireConnectivity(
  outbox: Outbox,
  overrides: { probe?: (signal: AbortSignal) => Promise<Response> } = {},
): Promise<{
  harness: Harness;
  source: FakeSource;
  timers: ManualTimers;
  connectivity: ReturnType<typeof createConnectivity>;
}> {
  const harness = await buildRelay(outbox);
  const source = new FakeSource();
  const timers = new ManualTimers();
  const connectivity = createConnectivity({
    bindEvents: source.bind,
    isOnline: source.isOnline,
    probe: overrides.probe ?? healthyProbe,
    probeTimeoutMs: 5_000,
    stabilityWindowMs: 1_000,
    schedule: timers.schedule,
  });
  connectivity.start();
  return { harness, source, timers, connectivity };
}

test("drains on the connectivity model's stably-online edge", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const { harness, source, timers, connectivity } = await wireConnectivity(outbox);
  await harness.relay.start(connectivity);

  const item = await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  // Link comes up: probe → healthy → still `probing`, so nothing drains yet.
  source.flip(true);
  await settle();
  expect((await outbox.get(item.id))?.status).toBe("queued");

  // The stability window elapses → the `online` edge → the relay drains, which
  // transcribes the recording.
  timers.advance(1_000);
  await harness.relay.settled();
  expect((await outbox.get(item.id))?.status).toBe("transcribed");

  harness.relay.stop();
  connectivity.stop();
});

test("does not thrash when connectivity flaps — one stable edge, one drain", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const { harness, source, timers, connectivity } = await wireConnectivity(outbox);
  await harness.relay.start(connectivity); // app-start drain runs on the empty queue

  // Count every drain the relay *initiates* from here on. Overriding the
  // instance method is seen by the connectivity subscription's internal
  // `this.syncNow()` call, so this counts automatic drains, not item processing
  // (which the serial chain would collapse and hide the thrash).
  let drains = 0;
  const realSyncNow = harness.relay.syncNow.bind(harness.relay);
  harness.relay.syncNow = () => {
    drains += 1;
    return realSyncNow();
  };

  const item = await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  // offline → online → offline → online, all inside the stability window.
  source.flip(true);
  await settle(); // probe healthy → window armed
  source.flip(false); // instant offline → window cancelled
  source.flip(true);
  await settle(); // probe healthy → fresh window armed

  // Only now, once things hold still for the window, is `online` asserted.
  timers.advance(1_000);
  await harness.relay.settled();

  // The flap crossed the online edge exactly once, so the relay drained once —
  // no runaway drain/fail/backoff loop.
  expect(drains).toBe(1);
  expect((await outbox.get(item.id))?.status).toBe("transcribed");

  harness.relay.stop();
  connectivity.stop();
});

test("syncNow bypasses hysteresis — a human pressing 'Sync now' drains even while offline", async () => {
  const outbox = await openTestOutbox(uniqueName());
  // The connectivity model never leaves `offline`: the link stays down.
  const { harness, connectivity } = await wireConnectivity(outbox);
  await harness.relay.start(connectivity);

  const item = await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  // No online edge ever fired, yet the manual path drains regardless — "try now
  // regardless" is the whole point of the button.
  await harness.relay.syncNow();

  expect((await outbox.get(item.id))?.status).toBe("transcribed");

  harness.relay.stop();
  connectivity.stop();
});

test("stop detaches the connectivity subscription", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const { harness, source, timers, connectivity } = await wireConnectivity(outbox);
  await harness.relay.start(connectivity);
  harness.relay.stop();

  const item = await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });
  source.flip(true);
  await settle();
  timers.advance(1_000); // a real online edge fires on the model...
  await harness.relay.settled();

  // ...but the relay is no longer listening, so nothing drained.
  expect((await outbox.get(item.id))?.status).toBe("queued");

  connectivity.stop();
});

test("overlapping syncNow calls do not process an item twice", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox);
  // Two rows, because the duplications that would actually hurt sit at opposite
  // ends of the pipeline: a second transcription costs money, and a second write
  // hits a customer's tool. A fresh capture covers the first; a seeded reviewed row
  // is the only way to still cover the second now that a write needs a human.
  await seedReviewedWriting(outbox);
  await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await Promise.all([
    harness.relay.syncNow(),
    harness.relay.syncNow(),
    harness.relay.syncNow(),
    harness.relay.syncNow(),
  ]);

  expect(fake(harness).calls).toHaveLength(1);
  expect(harness.writeCalls).toHaveLength(1);
});

test("an empty queue is a no-op", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox);
  await expect(harness.relay.syncNow()).resolves.toBeUndefined();
  expect(fake(harness).calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// dropAudioAfterTranscription — the only branch in this package that
// *permanently destroys user data*
// ---------------------------------------------------------------------------
//
// The flag is off by default (09 §"What goes where"), so nothing else in this
// file exercises the delete. That is precisely why it is tested here: the
// failure mode is a field auditor's recording gone for good, and the moment a
// later phase flips the default is the worst possible moment to discover a bug
// in it. `Outbox.dropAudio` has its own coverage in `outbox.browser.test.ts`;
// what these tests pin is the *relay's decision* to call it — when, and just as
// importantly when not.

test("with dropAudioAfterTranscription, the audio is deleted once transcription succeeds", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, { dropAudioAfterTranscription: true });
  const item = await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });
  expect(await outbox.getAudio(item.id)).toBeDefined();

  await harness.relay.syncNow();

  expect(await outbox.getAudio(item.id)).toBeUndefined();
  // Dropping the bytes must not strand the item: extract, review and write all
  // consume the transcript, not the audio, so the item still finishes the pipeline.
  expect((await outbox.get(item.id))?.status).toBe("transcribed");
  await outbox.closeSession(harness.session.id);
  await harness.relay.syncNow();
  await acceptReview(outbox, harness.session.id);
  await harness.relay.syncNow();

  const done = await outbox.getSession(harness.session.id);
  expect(done?.status).toBe("done");
  const doneRecording = await outbox.get(item.id);
  expect(doneRecording?.transcript).toEqual({
    recordingId: "rec-1",
    text: "the attic is R-19",
    engine: "fake",
  });
  expect(done?.extracted).toEqual({ atticInsulation: "the attic is R-19" });
  expect(done?.writeResult).toEqual({ remoteId: "snugg-1" });
  expect(fake(harness).calls).toHaveLength(1);
});

test("the delete survives a reload — it is a real attachment removal, not a cached view", async () => {
  const name = uniqueName();
  const first = await openTestOutbox(name);
  const harness = await buildRelay(first, { dropAudioAfterTranscription: true });
  const item = await first.enqueue({ recording, audio: audio(), sessionId: harness.session.id });
  await harness.relay.syncNow();
  await first.close();

  const second = await openTestOutbox(name);
  expect(await second.getAudio(item.id)).toBeUndefined();
  expect((await second.get(item.id))?.status).toBe("transcribed");
});

test("with dropAudioAfterTranscription, a FAILED transcription retains the audio so the retry can work", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const transcriber = new FakeTranscriber({ text: "the attic is R-19" });
  transcriber.failNextWith(Object.assign(new Error("gateway"), { status: 503 }));
  const harness = await buildRelay(outbox, { transcriber, dropAudioAfterTranscription: true });
  const item = await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await harness.relay.syncNow();

  // The item is parked, not finished — and the bytes are still there. Dropping
  // audio on a failed transcription would make the retry structurally
  // impossible: `#transcribe` treats missing audio as terminal, so the item
  // would go straight to `dead` and the recording would be unrecoverable.
  const parked = await outbox.get(item.id);
  expect(parked?.status).toBe("failed");
  expect(parked?.transcript).toBeUndefined();
  const retained = await outbox.getAudio(item.id);
  expect(retained).toBeDefined();
  expect(new Uint8Array(await retained!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));

  // And the retry really does succeed off those retained bytes.
  clock.advance(600_000);
  await harness.relay.syncNow();

  expect((await outbox.get(item.id))?.status).toBe("transcribed");
  expect(fake(harness).calls).toHaveLength(2);
  expect(new Uint8Array(await fake(harness).calls[1]!.audio.arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3, 4]),
  );
  // Only now, after the successful attempt, is it gone.
  expect(await outbox.getAudio(item.id)).toBeUndefined();
});

test("with dropAudioAfterTranscription, audio is retained when a LATER step fails", async () => {
  // Guards the inverse mistake: the drop is keyed to transcription succeeding,
  // so an extraction failure must not take the audio with it — but neither
  // should a successful transcription hold the bytes hostage to the rest of the
  // pipeline. Transcription won, so the bytes go; the session is merely parked.
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, {
    dropAudioAfterTranscription: true,
    sessionExtract: async () => {
      throw Object.assign(new Error("gateway"), { status: 502 });
    },
  });
  const item = await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await harness.relay.syncNow();
  await outbox.closeSession(harness.session.id);
  await harness.relay.syncNow();

  const parked = await outbox.get(item.id);
  expect(parked?.status).toBe("transcribed");
  // The transcript is persisted, so the retry resumes at `extract` and never
  // needs the audio again.
  expect(parked?.transcript?.text).toBe("the attic is R-19");
  expect(await outbox.getAudio(item.id)).toBeUndefined();
  const failedSession = await outbox.getSession(harness.session.id);
  expect(failedSession?.status).toBe("failed");
  expect(failedSession?.lastError).toContain("gateway");
});

test("by default the audio survives transcription — Phase 2's visible durability payoff", async () => {
  const name = uniqueName();
  const first = await openTestOutbox(name);
  // No `dropAudioAfterTranscription` at all: the default must be retention.
  const harness = await buildRelay(first);
  const item = await first.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await harness.relay.syncNow();

  expect((await first.get(item.id))?.status).toBe("transcribed");
  const kept = await first.getAudio(item.id);
  expect(kept).toBeDefined();
  expect(new Uint8Array(await kept!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));

  // "Record, reload, the audio is still there" — the acceptance test 09 names,
  // asserted against a genuinely reopened database rather than a live handle.
  await first.close();
  const second = await openTestOutbox(name);
  const afterReload = await second.getAudio(item.id);
  expect(afterReload).toBeDefined();
  expect(new Uint8Array(await afterReload!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
});

test("explicitly false behaves the same as omitting the flag", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, { dropAudioAfterTranscription: false });
  const item = await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await harness.relay.syncNow();

  expect((await outbox.get(item.id))?.status).toBe("transcribed");
  expect(await outbox.getAudio(item.id)).toBeDefined();
});

// ---------------------------------------------------------------------------
// Engine provenance
//
// The failure this guards against is not a crash — it is believing you are
// offline-capable while every single item quietly went to cloud STT and someone
// is paying for it. That is only detectable if the engine that produced each
// transcript is durable and inspectable across the whole queue.
// ---------------------------------------------------------------------------

test("the engine that produced a transcript is persisted on the item", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = await buildRelay(outbox, {
    transcriber: new FakeTranscriber({ engine: "ondevice-whisper", text: "the attic is R-19" }),
  });
  const item = await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await harness.relay.syncNow();

  expect((await outbox.get(item.id))?.transcript?.engine).toBe("ondevice-whisper");
});

test("the engine survives a close and reopen, so the mix is inspectable later", async () => {
  const name = uniqueName();
  const first = await openTestOutbox(name);
  const composite = firstCapable([
    new FakeTranscriber({
      engine: "ondevice-whisper",
      capability: { status: "unavailable", reason: "unsupported-platform", detail: "no WebGPU" },
    }),
    new FakeTranscriber({ engine: "managed-azure", text: "the attic is R-19" }),
  ]);
  const harness = await buildRelay(first, { transcriber: composite });
  const item = await harness.outbox.enqueue({
    recording,
    audio: audio(),
    sessionId: harness.session.id,
  });
  await harness.relay.syncNow();
  await first.close();

  const second = await openTestOutbox(name);
  const items = await second.list();

  // Read straight off the queue: every item, and which engine it cost you.
  expect(items.map((entry) => [entry.id, entry.transcript?.engine])).toEqual([
    [item.id, "managed-azure"],
  ]);
});

test("a transcript with no engine never reaches storage", async () => {
  const outbox = await openTestOutbox(uniqueName());
  // A hand-rolled transcriber that forgot its provenance. The relay parses the
  // step's output before persisting it, so this dies at the boundary rather
  // than leaving an unattributable row behind.
  const anonymous = {
    engine: "anonymous",
    capability: () => Promise.resolve({ status: "ready" } as const),
    transcribe: () => Promise.resolve({ recordingId: "rec-1", text: "no provenance" } as never),
  };
  const harness = await buildRelay(outbox, { transcriber: anonymous, maxAttempts: 1 });
  const item = await outbox.enqueue({ recording, audio: audio(), sessionId: harness.session.id });

  await harness.relay.syncNow();

  const dead = await outbox.get(item.id);
  expect(dead?.status).toBe("dead");
  expect(dead?.transcript).toBeUndefined();
});

test("a step that never settles fails the attempt instead of stalling the queue", async () => {
  // The relay drains SERIALLY, so a collaborator that never settles does not fail one
  // item — it stops the queue, and every capture behind it waits with no `failed`, no
  // backoff and nothing surfaced. This is the worst outcome the machinery can produce and
  // it is reachable from a hung worker or a managed service that goes quiet.
  const outbox = await openTestOutbox(uniqueName());
  const session = await outbox.openSession({ ctx: { jobId: "job-7" }, ref: "job-7" });
  const first = await outbox.enqueue({ recording, audio: audio(), sessionId: session.id });
  const second = await outbox.enqueue({
    recording: { ...recording, id: "rec-2" },
    audio: audio(),
    sessionId: session.id,
  });

  const relay = createRelay({
    outbox,
    // Never settles — an out-of-memory worker kill looks exactly like this.
    transcriber: {
      engine: "hung",
      capability: async () => ({ status: "ready" }) as const,
      transcribe: () => new Promise<never>(() => {}),
    },
    sessionExtract: async () => ({ fields: {}, usage: { calls: 1 } }),
    sessionWrite: async () => undefined,
    stepTimeoutMs: 50,
    maxAttempts: 1,
  });

  await relay.syncNow();

  // The hung item failed as an ordinary attempt...
  const stalled = await outbox.get(first.id);
  expect(stalled?.lastError).toMatch(/did not settle/i);
  // ...and the queue is no longer blocked behind it: the SECOND item was reached.
  const behind = await outbox.get(second.id);
  expect(behind?.status).not.toBe("queued");

  await outbox.close();
});

// ---------------------------------------------------------------------------
// Two tabs, one queue
// ---------------------------------------------------------------------------

test("two relays over one outbox run each step ONCE, not twice", async () => {
  // `nextPending()` selects on status alone, and `ACTIVE_OUTBOX_STATUSES` deliberately includes the
  // in-flight statuses so a step interrupted by a dead tab resumes rather than stranding. The
  // consequence, before the per-item claim, was not a narrow race: a second tab selected work the
  // first was actively performing, in the steady state, and both ran it. Two transcriptions, two
  // extractions, and — past the review gate — two writes into someone's audit.
  const outbox = await openTestOutbox(uniqueName());

  // Both relays share these, so the assertion is about total work done across tabs rather than about
  // either tab's own bookkeeping.
  const extractCalls: string[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;

  // Wraps `FakeTranscriber` rather than hand-rolling a Transcript: `transcriptSchema` is a
  // `z.strictObject`, so an extra key fails validation, the step errors, and the drain stops with
  // nothing extracted — which looks exactly like the locking working. It cost one debugging round.
  const inner = new FakeTranscriber({ text: "the attic is R-19" });
  const slowTranscriber: Transcriber = {
    engine: inner.engine,
    capability: async () => ({ status: "ready" }) as const,
    // Slow on purpose: with an instant transcriber the first relay finishes before the second even
    // selects, and the test would pass against no locking at all.
    transcribe: async (recording, audio) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return await inner.transcribe(recording, audio);
      } finally {
        inFlight -= 1;
      }
    },
  };

  const extract: SessionExtractStep = async ({ transcript }) => {
    extractCalls.push(transcript);
    return { fields: { atticInsulation: transcript } };
  };

  const a = await buildRelay(outbox, { transcriber: slowTranscriber, sessionExtract: extract });
  const b = await buildRelay(outbox, { transcriber: slowTranscriber, sessionExtract: extract });

  await outbox.enqueue({
    recording: {
      id: "rec-claim",
      capturedAt: new Date(clock.now()).toISOString(),
      durationMs: 1000,
      mimeType: "audio/webm",
      ctx: {},
    },
    audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
    sessionId: a.session.id,
  });
  // Close the session so the relay can process it through extraction.
  await outbox.closeSession(a.session.id);

  // Both tabs drain at once, which is exactly what two open tabs on the stably-online edge do.
  await Promise.all([a.relay.syncNow(), b.relay.syncNow()]);

  // The load-bearing assertion. Extraction is the cheapest observable "this step ran" — the write is
  // behind the review gate, and transcription alone would not prove the *pipeline* only advanced once.
  expect(extractCalls).toHaveLength(1);
  // And nothing ever overlapped: a claim that merely deduplicated afterwards would still have burned
  // two Whisper passes on one phone.
  expect(maxConcurrent).toBe(1);
});

test("a relay that acquires the lock AFTER another finished does not re-run the step", async () => {
  // The lock stops two tabs working at once. It does NOT stop the second tab acting on the copy it
  // read *before* it got in — and that copy still says `queued` while the row has moved on. Without
  // re-reading inside the lock, the handoff moment re-runs a step that already happened, which is the
  // same duplicate write the lock exists to prevent, narrowed to a smaller window.
  //
  // Verified by mutation: deleting the re-read leaves the concurrent test above GREEN, because there
  // the loser never gets in at all. This is the case that catches it.
  const outbox = await openTestOutbox(uniqueName());
  const extractCalls: string[] = [];
  const extract: SessionExtractStep = async ({ transcript }) => {
    extractCalls.push(transcript);
    return { fields: { atticInsulation: transcript } };
  };

  // Holds the second relay at the door until the first is completely finished, then lets it in. A
  // real `ifAvailable` lock produces this same ordering whenever the winner releases between the
  // loser's select and its request; the fake makes it deterministic instead of a timing accident.
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  // Signals that the second relay has SELECTED its item and is now at the door. Without this the test
  // races its own setup: `nextPending()` is an IndexedDB query, one macrotask does not reliably cover
  // it, and if the first relay finishes before the second selects, the second selects nothing and the
  // test passes without ever holding a stale copy — which is the thing it exists to test.
  let reachedLock!: () => void;
  const atLock = new Promise<void>((resolve) => {
    reachedLock = resolve;
  });
  const gatedLocks = {
    request: async (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => {
      reachedLock();
      await gate;
      return await callback({ name: _name, mode: "exclusive" });
    },
  } as unknown as LockManager;

  const first = await buildRelay(outbox, { sessionExtract: extract });
  const second = await buildRelay(outbox, { sessionExtract: extract, locks: gatedLocks });

  await outbox.enqueue({
    recording: {
      id: "rec-handoff",
      capturedAt: new Date(clock.now()).toISOString(),
      durationMs: 1000,
      mimeType: "audio/webm",
      ctx: {},
    },
    audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
    sessionId: first.session.id,
  });
  // Close the session so the relay can process it through extraction.
  await outbox.closeSession(first.session.id);

  // The second relay selects the item, then blocks at the lock holding a `queued` copy.

  const blocked = second.relay.syncNow();
  await atLock;

  // The first relay takes it all the way to `awaiting-review`.
  await first.relay.syncNow();
  expect(extractCalls).toHaveLength(1);

  const parked = await outbox.getSession(first.session.id);
  expect(parked?.status).toBe("awaiting-review");

  // Now let the loser in. Its `item` still says `queued`; storage says otherwise.
  openGate();
  await blocked;

  // **The session is still parked for review.** This, not the extract count, is what the re-read
  // protects. Acting on the stale copy makes the loser re-transcribe (a wasted Whisper pass on a
  // phone), and its next drain iteration then reads the REAL item — already extracted — computes
  // `write`, and hits `TerminalQueueError: reached the write step with no review outcome`. That kills
  // a finished recording: `awaiting-review` becomes `dead`, and the human who was about to review it
  // never sees it.
  //
  // Measured, not reasoned: with the re-read deleted this assertion reads `dead`. `extractCalls` does
  // NOT move, because the drain's second iteration re-reads through `nextPending()` on its own — which
  // is why the obvious assertion here passes against the bug.
  const after = await outbox.getSession(first.session.id);
  expect(after?.status).toBe("awaiting-review");
  expect(extractCalls).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// The session owns its write destination
// ---------------------------------------------------------------------------

test("the write step receives the session's ctx, not a recording's", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const session = await outbox.openSession({
    ctx: { jobId: "session-ctx" },
    ref: "job-7",
  });
  await outbox.enqueue({
    recording: { ...recording, ctx: { jobId: "recording-ctx" } },
    audio: audio(),
    sessionId: session.id,
  });

  // Transcribe manually, then drive the session through review to write.
  const [item] = await outbox.list();
  await outbox.patch(item!.id, {
    transcript: { recordingId: item!.recording.id, text: "the attic is R-19", engine: "fake" },
    status: "transcribed",
  });
  await outbox.closeSession(session.id);
  await outbox.patchSession(session.id, {
    extracted: { atticInsulation: "the attic is R-19" },
    extractedFromRecordingIds: [item!.recording.id],
    status: "awaiting-review",
  });
  await acceptReview(outbox, session.id);

  const writeCalls: SessionWriteInput[] = [];
  const relay = createRelay({
    outbox,
    transcriber: new FakeTranscriber(),
    sessionExtract: async () => {
      throw new Error("must not extract");
    },
    sessionWrite: async (input) => {
      writeCalls.push(input);
      return {};
    },
    now: clock.now,
  });
  await relay.syncNow();

  expect(writeCalls).toHaveLength(1);
  expect(writeCalls[0]?.ctx).toEqual({ jobId: "session-ctx" });
});

test("a session with no transcribed recordings still reaches the write step", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const session = await outbox.openSession({
    ctx: { jobId: "job-7" },
    ref: "job-7",
  });

  // No recordings at all — patch straight to the review gate and accept.
  await outbox.closeSession(session.id);
  await outbox.patchSession(session.id, {
    extracted: { atticInsulation: "the attic is R-19" },
    extractedFromRecordingIds: [],
    status: "awaiting-review",
  });
  await acceptReview(outbox, session.id);

  const writeCalls: SessionWriteInput[] = [];
  const relay = createRelay({
    outbox,
    transcriber: new FakeTranscriber(),
    sessionExtract: async () => {
      throw new Error("must not extract");
    },
    sessionWrite: async (input) => {
      writeCalls.push(input);
      return {};
    },
    now: clock.now,
  });
  await relay.syncNow();

  expect(writeCalls).toHaveLength(1);
  const done = await outbox.getSession(session.id);
  expect(done?.status).toBe("done");
});
