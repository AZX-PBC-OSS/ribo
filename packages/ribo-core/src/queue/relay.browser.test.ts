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
  type ExtractStep,
  type Relay,
  type WriteStep,
  type WriteStepInput,
} from "./relay.js";
import type { OutboxItem } from "./schema.js";
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
  extractCalls: { transcript: string; item: OutboxItem }[];
  /**
   * The whole {@link WriteStepInput}, not a projection of it. Tests need to tell
   * `reviewed` (what the human settled on) apart from `item.extracted` (what the
   * model said), and recording only some fields is how that distinction would go
   * unasserted.
   */
  writeCalls: WriteStepInput[];
}

function buildRelay(
  outbox: Outbox,
  overrides: {
    transcriber?: Transcriber;
    extract?: ExtractStep;
    write?: WriteStep;
    maxAttempts?: number;
    random?: () => number;
    dropAudioAfterTranscription?: boolean;
  } = {},
): Harness {
  const transcriber: Transcriber =
    overrides.transcriber ?? new FakeTranscriber({ text: "the attic is R-19" });
  const extractCalls: Harness["extractCalls"] = [];
  const writeCalls: Harness["writeCalls"] = [];

  const extract: ExtractStep =
    overrides.extract ??
    (async ({ transcript, item }) => {
      extractCalls.push({ transcript: transcript.text, item });
      return { atticInsulation: transcript.text };
    });

  const write: WriteStep =
    overrides.write ??
    (async (input) => {
      writeCalls.push(input);
      return { remoteId: "snugg-1" };
    });

  const relay = createRelay({
    outbox,
    transcriber,
    extract,
    write,
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
  });

  return { outbox, relay, transcriber, extractCalls, writeCalls };
}

// ---------------------------------------------------------------------------
// Getting past the review gate
// ---------------------------------------------------------------------------
//
// Extraction parks the item at `awaiting-review` rather than advancing it to
// `writing`, so **no drain in this file reaches the write step on its own**. That
// is the gate, and every test below either stops at it or is helped over it by one
// of these three helpers.
//
// `acceptReview` is `Outbox.submitReview` — the production way over — and nothing
// in this file writes a review outcome by hand any more.

/**
 * Drain, which now ends at the review gate rather than at `done`.
 *
 * Named rather than inlined at the call sites that expect a park, so those tests
 * say what they expect of the drain: run every step the relay owns, then stop.
 * Tests about the drain *triggers* (start, connectivity edges, overlap) still call
 * `syncNow` directly — the trigger is their subject.
 */
const drainToReview = async (relay: Relay): Promise<void> => await relay.syncNow();

/**
 * Accept a parked item's fields, making it eligible to write.
 *
 * A thin alias for `submitReview` with an accepted outcome, kept named because the
 * call sites read as what a human did rather than as an outbox write. It is also
 * the only door: `submitReview` refuses any status but `awaiting-review`, so a test
 * that wants a writable row has to park the item first — which is the production
 * path, not a shortcut around it.
 */
const acceptReview = async (
  outbox: Outbox,
  id: string,
  fields: ExtractedFieldMap = { atticInsulation: "the attic is R-19" },
): Promise<OutboxItem> => await outbox.submitReview(id, { status: "accepted", fields });

/**
 * Enqueue a row that is already transcribed, extracted and reviewed, so the next
 * drain runs exactly one step: the write.
 *
 * The write-retry, idempotency, backoff and terminal-failure tests use this rather
 * than driving a fresh capture through the whole pipeline. They are about what
 * happens *around* a write, and a fresh capture can no longer get to one — it
 * parks. Seeding keeps each of those tests testing the one thing it was written
 * for.
 *
 * `fields` defaults to matching `extracted`, which is what an accept-as-is really
 * does; pass something different to prove a value came from the review outcome
 * rather than from the model's map.
 *
 * The seed lands the row at `awaiting-review` and then goes through
 * `submitReview`, rather than patching straight to `writing`: `submitReview`
 * refuses every other status, so the park is not decoration — it is the only shape
 * that reaches a writable row, and it keeps this helper's output a state the
 * production state machine can actually produce.
 */
async function seedReviewedWriting(
  outbox: Outbox,
  options: { recording?: Recording; fields?: ExtractedFieldMap } = {},
): Promise<OutboxItem> {
  const seeded = await outbox.enqueue({
    recording: options.recording ?? recording,
    audio: audio(),
  });
  await outbox.patch(seeded.id, {
    transcript: { recordingId: seeded.recording.id, text: "the attic is R-19", engine: "fake" },
    extracted: { atticInsulation: "the attic is R-19" },
    status: "awaiting-review",
  });
  return await acceptReview(outbox, seeded.id, options.fields);
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
  const harness = buildRelay(outbox);
  const item = await outbox.enqueue({ recording, audio: audio() });

  await drainToReview(harness.relay);

  const parked = await outbox.get(item.id);
  expect(parked?.status).toBe("awaiting-review");
  expect(parked?.writeResult).toBeUndefined();
  expect(harness.writeCalls).toHaveLength(0);

  await acceptReview(outbox, item.id);
  await harness.relay.syncNow();

  const done = await outbox.get(item.id);
  expect(done?.status).toBe("done");
  expect(done?.transcript).toEqual({
    recordingId: "rec-1",
    text: "the attic is R-19",
    engine: "fake",
  });
  expect(done?.extracted).toEqual({ atticInsulation: "the attic is R-19" });
  expect(done?.writeResult).toEqual({ remoteId: "snugg-1" });
  expect(done?.lastError).toBeUndefined();
  expect(harness.writeCalls).toHaveLength(1);
});

test("hands the transcriber the recording metadata and the attachment bytes", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox);
  await outbox.enqueue({ recording, audio: audio() });

  await harness.relay.syncNow();

  expect(fake(harness).calls).toHaveLength(1);
  const call = fake(harness).calls[0]!;
  expect(call.recording).toMatchObject({ id: "rec-1", mimeType: "audio/webm;codecs=opus" });
  expect(new Uint8Array(await call.audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
});

test("passes through the statuses of the 09 state machine, in order", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const seen: string[] = [];
  const subscription = outbox.items$.subscribe((items) => {
    const status = items[0]?.status;
    if (status && status !== seen.at(-1)) seen.push(status);
  });
  const harness = buildRelay(outbox);
  const item = await outbox.enqueue({ recording, audio: audio() });

  await drainToReview(harness.relay);
  await vi.waitFor(() => expect(seen.at(-1)).toBe("awaiting-review"));

  // The relay stops here on its own. `writing` is NOT in this list yet, which is
  // the whole gate: an unbroken run to `done` would mean un-reviewed model output
  // reached the host tool.
  expect(seen).toEqual(["queued", "transcribing", "extracting", "awaiting-review"]);

  await acceptReview(outbox, item.id);
  await harness.relay.syncNow();
  await vi.waitFor(() => expect(seen.at(-1)).toBe("done"));
  subscription.unsubscribe();

  expect(seen).toEqual([
    "queued",
    "transcribing",
    "extracting",
    "awaiting-review",
    "writing",
    "done",
  ]);
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
  const harness = buildRelay(outbox);
  const item = await outbox.enqueue({ recording, audio: audio() });

  await drainToReview(harness.relay);

  const parked = await outbox.get(item.id);
  expect(parked?.status).toBe("awaiting-review");
  expect(parked?.extracted).toEqual({ atticInsulation: "the attic is R-19" });
  expect(parked?.reviewOutcome).toBeUndefined();
  expect(harness.writeCalls).toHaveLength(0);
});

test("a parked item does not block the recordings behind it", async () => {
  // The point of parking rather than awaiting a presenter: a human reviewing the
  // first recording must not stop the second from transcribing and extracting.
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox);
  for (const id of ["first", "second"]) {
    await outbox.enqueue({ recording: { ...recording, id }, audio: audio() });
  }

  await drainToReview(harness.relay);

  const items = await outbox.list();
  expect(items.map((entry) => entry.status)).toEqual(["awaiting-review", "awaiting-review"]);
  expect(harness.extractCalls).toHaveLength(2);
  expect(harness.writeCalls).toHaveLength(0);
});

test("the write step receives the human's reviewed values, not the model's", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox);
  const item = await outbox.enqueue({ recording, audio: audio() });
  await drainToReview(harness.relay);

  await outbox.submitReview(item.id, {
    status: "edited",
    fields: { atticRValue: 30 },
    editedFields: ["atticRValue"],
    rejectedFields: [],
  });
  await harness.relay.syncNow();

  expect(harness.writeCalls).toHaveLength(1);
  expect(harness.writeCalls[0]?.reviewed).toEqual({ atticRValue: 30 });
  // The auditor's correction shares no key with what the extractor produced, so a
  // regression that passed `item.extracted` through could not satisfy this — the
  // whole reason `WriteStepInput.extracted` became `reviewed`.
  expect(harness.writeCalls[0]?.item.extracted).toEqual({
    atticInsulation: "the attic is R-19",
  });
});

test("an item reviewed with every field rejected is never written", async () => {
  // `resolveReview` reports "the human rejected everything" as an `edited` outcome
  // with no fields, and `submitReview` unparks it to `writing` like any other edit
  // — collapsing it into a discard would destroy audio the human never asked to
  // throw away. So the refusal has to be here, and it has to be the relay's own:
  // `write` is host-supplied, so "the adapter's schema would reject it" is a
  // guarantee nothing in this package enforces.
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox);
  const item = await outbox.enqueue({ recording, audio: audio() });
  await drainToReview(harness.relay);

  const unparked = await outbox.submitReview(item.id, {
    status: "edited",
    fields: {},
    editedFields: [],
    rejectedFields: ["atticInsulation"],
  });
  // Asserted, not assumed: the outcome really is persisted and the item really is
  // eligible to write, so what follows is the relay refusing rather than the gate
  // never having opened.
  expect(unparked.status).toBe("writing");

  await harness.relay.syncNow();

  expect(harness.writeCalls).toHaveLength(0);
  const dead = await outbox.get(item.id);
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
  const harness = buildRelay(outbox, { extract: async () => ({}) });
  const item = await outbox.enqueue({ recording, audio: audio() });
  await drainToReview(harness.relay);

  await outbox.submitReview(item.id, { status: "accepted", fields: {} });
  await harness.relay.syncNow();

  expect(harness.writeCalls).toHaveLength(0);
  const dead = await outbox.get(item.id);
  expect(dead?.status).toBe("dead");
  expect(dead?.lastError).toMatch(/extraction produced no fields/i);
  expect(dead?.lastError).not.toMatch(/rejected/i);
});

test("an item that reaches writing with no review outcome fails terminally", async () => {
  // Defence in depth for the one invariant whose violation is invisible: reaching
  // a write unreviewed is a state-machine bug, so it must not silently write.
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox);
  const item = await outbox.enqueue({ recording, audio: audio() });
  await drainToReview(harness.relay);
  // Asserted, not assumed: without this the test passes even when the relay never
  // parked the item at all, because a `dead` item is `dead` whichever way it got
  // there. This is the line that makes the hand-patch below a *jump over the gate*
  // rather than an incidental status change.
  expect((await outbox.get(item.id))?.status).toBe("awaiting-review");

  // The gate jumped by hand — exactly the shape a bug in it would take.
  await outbox.patch(item.id, { status: "writing" });
  await harness.relay.syncNow();

  expect(harness.writeCalls).toHaveLength(0);
  const dead = await outbox.get(item.id);
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
  const harness = buildRelay(outbox);
  const item = await outbox.enqueue({ recording, audio: audio() });
  await drainToReview(harness.relay);
  // Same reason as the test above: the park has to be asserted, or a relay that
  // never parked would satisfy every assertion below it.
  expect((await outbox.get(item.id))?.status).toBe("awaiting-review");

  await outbox.patch(item.id, {
    status: "writing",
    reviewOutcome: reviewOutcomeSchema.parse({ status: "discarded", reason: "wrong property" }),
  });
  await harness.relay.syncNow();

  expect(harness.writeCalls).toHaveLength(0);
  const dead = await outbox.get(item.id);
  expect(dead?.status).toBe("dead");
  expect(dead?.lastError).toMatch(/review/i);
});

// ---------------------------------------------------------------------------
// Resumption — the reason step outputs are persisted at all
// ---------------------------------------------------------------------------

test("resumes at the next step after a reload rather than re-recording or re-transcribing", async () => {
  const name = uniqueName();

  // Session one: transcription succeeds, extraction blows up transiently, and
  // then the "tab dies" — we close the database mid-pipeline.
  const first = await openTestOutbox(name);
  const firstRun = buildRelay(first, {
    extract: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  const item = await first.enqueue({ recording, audio: audio() });
  await firstRun.relay.syncNow();

  const afterCrash = await first.get(item.id);
  expect(afterCrash?.transcript?.text).toBe("the attic is R-19");
  expect(afterCrash?.status).toBe("failed");
  await first.close();

  // Session two: a fresh database, a fresh relay, and a transcriber that would
  // throw if it were ever asked to do the work again.
  clock.advance(60_000);
  const second = await openTestOutbox(name);
  const explodingTranscriber = new FakeTranscriber();
  explodingTranscriber.failWith(new Error("transcription must not run twice"));
  const secondRun = buildRelay(second, { transcriber: explodingTranscriber });

  await secondRun.relay.syncNow();

  expect(explodingTranscriber.calls).toHaveLength(0);
  expect(secondRun.extractCalls).toHaveLength(1);
  expect(secondRun.extractCalls[0]?.transcript).toBe("the attic is R-19");
  // It resumed at `extract` and ran to the gate, which is as far as the relay can
  // take an item without a human.
  expect((await second.get(item.id))?.status).toBe("awaiting-review");
});

test("resumes at the write step when extraction and review already succeeded", async () => {
  const outbox = await openTestOutbox(uniqueName());
  // Reviewed with a field the extractor never produced, so a regression that read
  // `item.extracted` back out at write time could not pass this test.
  const item = await seedReviewedWriting(outbox, { fields: { atticRValue: 30 } });

  const transcriber = new FakeTranscriber().failWith(new Error("must not transcribe"));
  const harness = buildRelay(outbox, {
    transcriber,
    extract: async () => {
      throw new Error("must not extract");
    },
  });
  await harness.relay.syncNow();

  expect((await outbox.get(item.id))?.status).toBe("done");
  expect(harness.writeCalls).toHaveLength(1);
  expect(harness.writeCalls[0]?.reviewed).toEqual({ atticRValue: 30 });
  // The model's raw map is still reachable on the item, for provenance.
  expect(harness.writeCalls[0]?.item.extracted).toEqual({
    atticInsulation: "the attic is R-19",
  });
});

// ---------------------------------------------------------------------------
// Empty and near-empty transcripts — the guard that stops silence advancing
// to extraction
// ---------------------------------------------------------------------------
//
// `text: ""` is a legal `Transcript` (`transcript.ts` says so deliberately —
// silence transcribes to nothing, which is a real result). Without a guard, the
// relay persists it and advances to extraction regardless, so a transcription
// that produced almost nothing — a VAD that missed the speech, a model that
// failed quietly — becomes an extraction over an empty string, and then a
// mostly-empty audit that nobody flagged. The guard in `#transcribe` parks the
// item at `awaiting-review` instead, persisting the transcript either way.

test("an empty transcript parks for review rather than advancing to extraction", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox, { transcriber: new FakeTranscriber({ text: "" }) });
  const item = await outbox.enqueue({ recording, audio: audio() });

  await drainToReview(harness.relay);

  const parked = await outbox.get(item.id);
  // Parked at the review gate, not advanced through extraction — the extractor
  // never ran, which is the whole point: feeding an empty string to extraction
  // produces a mostly-empty audit that nobody flagged.
  expect(parked?.status).toBe("awaiting-review");
  expect(harness.extractCalls).toHaveLength(0);
  expect(parked?.extracted).toBeUndefined();
  // The transcript is persisted: whatever was heard (nothing, here) is evidence
  // and must not be thrown away — the item parks WITH its transcript.
  expect(parked?.transcript).toEqual({
    recordingId: "rec-1",
    text: "",
    engine: "fake",
  });
});

test("a near-empty transcript for a long recording parks for review", async () => {
  // "um" (2 chars) for a 4-minute recording is 0.008 chars/s — well below the
  // 0.5 threshold. The same 2 chars for a 4-second recording would be 0.5, at
  // the threshold, and would advance (covered by the next test). The ratio is
  // what makes a near-empty transcript alarming for a long recording and fine
  // for a short one.
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox, { transcriber: new FakeTranscriber({ text: "um" }) });
  const item = await outbox.enqueue({
    recording: { ...recording, durationMs: 240_000 },
    audio: audio(),
  });

  await drainToReview(harness.relay);

  const parked = await outbox.get(item.id);
  expect(parked?.status).toBe("awaiting-review");
  expect(harness.extractCalls).toHaveLength(0);
  // The near-empty transcript is still persisted — it is evidence of what the
  // model heard, even if what it heard was almost nothing.
  expect(parked?.transcript?.text).toBe("um");
});

test("a short but plausible transcript still advances to extraction", async () => {
  // "the attic" (9 chars) for a 4-second recording is 2.25 chars/s — above the
  // 0.5 threshold, so the guard does not fire. Extraction runs normally and the
  // item parks at the review gate the usual way.
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox, { transcriber: new FakeTranscriber({ text: "the attic" }) });
  const item = await outbox.enqueue({
    recording: { ...recording, durationMs: 4_000 },
    audio: audio(),
  });

  await drainToReview(harness.relay);

  const parked = await outbox.get(item.id);
  // Extraction ran: the item has extracted data and went through the normal
  // review gate, not the guard's park.
  expect(parked?.status).toBe("awaiting-review");
  expect(harness.extractCalls).toHaveLength(1);
  expect(harness.extractCalls[0]?.transcript).toBe("the attic");
  expect(parked?.transcript?.text).toBe("the attic");
  expect(parked?.extracted).toEqual({ atticInsulation: "the attic" });
});

test("with dropAudioAfterTranscription, a parked empty transcript retains the audio", async () => {
  // A human investigating a suspiciously empty transcript needs to listen to
  // the recording. Dropping the bytes when the guard parks would make that
  // impossible, so `dropAudioAfterTranscription` is deliberately not applied
  // on the parking branch.
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox, {
    transcriber: new FakeTranscriber({ text: "" }),
    dropAudioAfterTranscription: true,
  });
  const item = await outbox.enqueue({ recording, audio: audio() });

  await harness.relay.syncNow();

  const parked = await outbox.get(item.id);
  expect(parked?.status).toBe("awaiting-review");
  expect(await outbox.getAudio(item.id)).toBeDefined();
});

test("an empty transcript does not block the recordings behind it", async () => {
  // The guard parks at `awaiting-review`, which is not active, so the drain
  // moves past it — same as a normal extraction park. A recording behind the
  // empty one still transcribes and extracts.
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox, {
    transcriber: new FakeTranscriber({
      responses: { empty: "", real: "the attic is R-19" },
    }),
  });
  await outbox.enqueue({ recording: { ...recording, id: "empty" }, audio: audio() });
  await outbox.enqueue({ recording: { ...recording, id: "real" }, audio: audio() });

  await drainToReview(harness.relay);

  const items = await outbox.list();
  expect(items.map((entry) => [entry.recording.id, entry.status])).toEqual([
    ["empty", "awaiting-review"],
    ["real", "awaiting-review"],
  ]);
  // The first item parked at the guard (no extraction), the second advanced
  // through extraction normally.
  const empty = items.find((entry) => entry.recording.id === "empty");
  const real = items.find((entry) => entry.recording.id === "real");
  expect(empty?.extracted).toBeUndefined();
  expect(real?.extracted).toEqual({ atticInsulation: "the attic is R-19" });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("reuses the enqueue-time idempotency key on every retry, never regenerating it", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const keys: string[] = [];
  let attempt = 0;
  const harness = buildRelay(outbox, {
    write: async ({ idempotencyKey }) => {
      keys.push(idempotencyKey);
      attempt += 1;
      if (attempt < 3) throw Object.assign(new Error("gateway"), { status: 503 });
      return { remoteId: "snugg-1" };
    },
  });
  // Seeded past the gate: the key has to survive three *write* attempts, and a
  // fresh capture would park before the first one.
  const item = await seedReviewedWriting(outbox);

  for (let i = 0; i < 3; i += 1) {
    await harness.relay.syncNow();
    clock.advance(120_000);
  }

  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
  expect(keys[0]).toBe(item.idempotencyKey);
  expect((await outbox.get(item.id))?.status).toBe("done");
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

test("a transient failure parks the item with a persisted future nextAttemptAt", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox, {
    write: async () => {
      throw Object.assign(new Error("gateway"), { status: 502 });
    },
  });
  const item = await seedReviewedWriting(outbox);

  await harness.relay.syncNow();

  const failed = await outbox.get(item.id);
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
  const firstRun = buildRelay(first, { write: failing });
  const item = await seedReviewedWriting(first);
  await firstRun.relay.syncNow();
  expect(firstRun.writeCalls).toHaveLength(0);
  const parked = await first.get(item.id);
  await first.close();

  // Reopen. Nothing is in memory; only `nextAttemptAt` in IndexedDB knows when
  // this item becomes eligible again. There is no timer anywhere — on iOS there
  // could not be one.
  const second = await openTestOutbox(name);
  expect((await second.get(item.id))?.nextAttemptAt).toBe(parked?.nextAttemptAt);
  // The review outcome is persisted too, so the reopened relay is still allowed to
  // write this item. A reload does not send it back to the human.
  expect((await second.get(item.id))?.reviewOutcome?.status).toBe("accepted");

  const tooEarly = buildRelay(second);
  await tooEarly.relay.syncNow();
  expect(tooEarly.writeCalls).toHaveLength(0);
  expect((await second.get(item.id))?.status).toBe("failed");

  clock.advance(501);
  const nowDue = buildRelay(second);
  await nowDue.relay.syncNow();
  expect(nowDue.writeCalls).toHaveLength(1);
  expect((await second.get(item.id))?.status).toBe("done");
});

test("the backoff window doubles with each attempt", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox, {
    write: async () => {
      throw Object.assign(new Error("gateway"), { status: 502 });
    },
  });
  const item = await seedReviewedWriting(outbox);

  const windows: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    await harness.relay.syncNow();
    const current = await outbox.get(item.id);
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
  const harness = buildRelay(outbox, {
    write: async () => {
      throw Object.assign(new Error("unprocessable"), { status: 422 });
    },
  });
  const item = await seedReviewedWriting(outbox);

  await harness.relay.syncNow();
  clock.advance(600_000);
  await harness.relay.syncNow();

  const dead = await outbox.get(item.id);
  expect(dead?.status).toBe("dead");
  expect(dead?.attempts).toBe(1);
  expect(dead?.lastError).toContain("unprocessable");
  expect(harness.writeCalls).toHaveLength(0);
});

test("an explicit TerminalQueueError is terminal too", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox, {
    extract: async () => {
      throw new TerminalQueueError("this transcript can never be extracted");
    },
  });
  const item = await outbox.enqueue({ recording, audio: audio() });

  await harness.relay.syncNow();
  expect((await outbox.get(item.id))?.status).toBe("dead");
});

test("missing audio is terminal, not an infinite retry loop", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox);
  const item = await outbox.enqueue({ recording, audio: audio() });
  await outbox.dropAudio(item.id);

  await harness.relay.syncNow();

  const dead = await outbox.get(item.id);
  expect(dead?.status).toBe("dead");
  expect(dead?.lastError).toMatch(/audio/i);
  expect(fake(harness).calls).toHaveLength(0);
});

test("gives up and goes dead once maxAttempts transient failures have accumulated", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox, {
    maxAttempts: 3,
    write: async () => {
      throw Object.assign(new Error("gateway"), { status: 502 });
    },
  });
  const item = await seedReviewedWriting(outbox);

  for (let i = 0; i < 5; i += 1) {
    await harness.relay.syncNow();
    clock.advance(600_000);
  }

  const dead = await outbox.get(item.id);
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
  const harness = buildRelay(outbox, {
    write: async ({ item }) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      order.push(item.recording.id);
      concurrent -= 1;
      return {};
    },
  });

  // Three rows already reviewed, so all three reach the write step in one drain.
  // Reviewing them in capture order is what makes `seq` the write order here;
  // reviewing them out of order is what the gate now legitimately allows, and the
  // `seq` comment in `schema.ts` says so.
  for (const id of ["c", "a", "b"]) {
    await seedReviewedWriting(outbox, { recording: { ...recording, id } });
  }
  await harness.relay.syncNow();

  expect(order).toEqual(["c", "a", "b"]);
  expect(maxConcurrent).toBe(1);
});

test("writes follow review order, not capture order", async () => {
  // The ordering guarantee `seq` used to carry, narrowed on purpose: a human
  // reviewing the second recording first means it writes first. Enforcing capture
  // order here would let one un-reviewed item block every write behind it — the
  // exact stall the parked design exists to avoid. `schema.ts`'s `seq` comment
  // states this; this is the test that stops someone "fixing" it back.
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox);
  for (const id of ["first", "second"]) {
    await outbox.enqueue({ recording: { ...recording, id }, audio: audio() });
  }

  // Both park, so neither is in the active set and the head no longer holds the
  // queue — which is what makes the review the ordering decision.
  await drainToReview(harness.relay);
  const [first, second] = await outbox.list();

  await outbox.submitReview(second!.id, { status: "accepted", fields: { atticRValue: 30 } });
  await harness.relay.syncNow();

  expect(harness.writeCalls).toHaveLength(1);
  expect(harness.writeCalls[0]?.item.id).toBe(second!.id);
  expect(harness.writeCalls[0]?.item.seq).toBeGreaterThan(first!.seq);
  // The lower-`seq` sibling is untouched and still waiting on its human. It did not
  // block the write, and the write did not disturb it.
  expect((await outbox.get(first!.id))?.status).toBe("awaiting-review");
});

test("a parked head-of-queue item holds the queue, preserving capture order", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox, {
    write: async ({ item }) => {
      if (item.recording.id === "first") throw Object.assign(new Error("gw"), { status: 502 });
      return {};
    },
  });
  // Only the head is seeded past the review gate. `first` is seq 0 and needs
  // exactly one step — the write that fails — while `second` is an untouched fresh
  // capture. That asymmetry is deliberate: the evidence for "second waited" is that
  // it is still literally `queued`, which a second seeded row could not show, and
  // keeping the failure at `write` is what pins the park for the write step rather
  // than only for the steps before it.
  const first = await seedReviewedWriting(outbox, { recording: { ...recording, id: "first" } });
  const second = await outbox.enqueue({
    recording: { ...recording, id: "second" },
    audio: audio(),
  });

  await harness.relay.syncNow();

  // Order is the guarantee 09 asks for, and letting `second` overtake a merely
  // delayed `first` would break it. `second` waits.
  expect((await outbox.get(first.id))?.status).toBe("failed");
  expect((await outbox.get(second.id))?.status).toBe("queued");
});

test("a dead item does not block the queue behind it", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox, {
    write: async ({ item }) => {
      if (item.recording.id === "first") throw Object.assign(new Error("bad"), { status: 400 });
      return {};
    },
  });
  // Seeded head, fresh follower, for the same reason as the test above — the two
  // are a pair and differ only in whether the head's write failure is transient.
  const first = await seedReviewedWriting(outbox, { recording: { ...recording, id: "first" } });
  const second = await outbox.enqueue({
    recording: { ...recording, id: "second" },
    audio: audio(),
  });

  await harness.relay.syncNow();

  expect((await outbox.get(first.id))?.status).toBe("dead");
  // `second` got as far as the relay can take it unaided, which is the gate. That
  // it moved at all is the point: blocking behind a dead item would strand it.
  expect((await outbox.get(second.id))?.status).toBe("awaiting-review");
});

// ---------------------------------------------------------------------------
// Foreground triggers — no service worker, no background sync
// ---------------------------------------------------------------------------

test("drains once at start, which is the app-start trigger", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox);
  const item = await outbox.enqueue({ recording, audio: audio() });

  await harness.relay.start();

  // A drain happened, which is what this test is about; where it ends is the
  // review gate's business, not the trigger's.
  expect((await outbox.get(item.id))?.status).toBe("awaiting-review");
  harness.relay.stop();
});

/**
 * Wires a relay to a real {@link createConnectivity} model over hand-driven
 * fakes. Returns the pieces a test drives: the source it flaps, the timers it
 * advances, and the relay/outbox.
 */
function wireConnectivity(
  outbox: Outbox,
  overrides: { probe?: (signal: AbortSignal) => Promise<Response> } = {},
) {
  const harness = buildRelay(outbox);
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
  const { harness, source, timers, connectivity } = wireConnectivity(outbox);
  await harness.relay.start(connectivity);

  const item = await outbox.enqueue({ recording, audio: audio() });

  // Link comes up: probe → healthy → still `probing`, so nothing drains yet.
  source.flip(true);
  await settle();
  expect((await outbox.get(item.id))?.status).toBe("queued");

  // The stability window elapses → the `online` edge → the relay drains, which
  // now ends at the review gate.
  timers.advance(1_000);
  await harness.relay.settled();
  expect((await outbox.get(item.id))?.status).toBe("awaiting-review");

  harness.relay.stop();
  connectivity.stop();
});

test("does not thrash when connectivity flaps — one stable edge, one drain", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const { harness, source, timers, connectivity } = wireConnectivity(outbox);
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

  const item = await outbox.enqueue({ recording, audio: audio() });

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
  expect((await outbox.get(item.id))?.status).toBe("awaiting-review");

  harness.relay.stop();
  connectivity.stop();
});

test("syncNow bypasses hysteresis — a human pressing 'Sync now' drains even while offline", async () => {
  const outbox = await openTestOutbox(uniqueName());
  // The connectivity model never leaves `offline`: the link stays down.
  const { harness, connectivity } = wireConnectivity(outbox);
  await harness.relay.start(connectivity);

  const item = await outbox.enqueue({ recording, audio: audio() });

  // No online edge ever fired, yet the manual path drains regardless — "try now
  // regardless" is the whole point of the button.
  await harness.relay.syncNow();

  expect((await outbox.get(item.id))?.status).toBe("awaiting-review");

  harness.relay.stop();
  connectivity.stop();
});

test("stop detaches the connectivity subscription", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const { harness, source, timers, connectivity } = wireConnectivity(outbox);
  await harness.relay.start(connectivity);
  harness.relay.stop();

  const item = await outbox.enqueue({ recording, audio: audio() });
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
  const harness = buildRelay(outbox);
  // Two rows, because the duplications that would actually hurt sit at opposite
  // ends of the pipeline: a second transcription costs money, and a second write
  // hits a customer's tool. A fresh capture covers the first; a seeded reviewed row
  // is the only way to still cover the second now that a write needs a human.
  await seedReviewedWriting(outbox);
  await outbox.enqueue({ recording, audio: audio() });

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
  const harness = buildRelay(outbox);
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
  const harness = buildRelay(outbox, { dropAudioAfterTranscription: true });
  const item = await outbox.enqueue({ recording, audio: audio() });
  expect(await outbox.getAudio(item.id)).toBeDefined();

  await harness.relay.syncNow();

  expect(await outbox.getAudio(item.id)).toBeUndefined();
  // Dropping the bytes must not strand the item: extract, review and write all
  // consume the transcript, not the audio, so the item still finishes the pipeline.
  expect((await outbox.get(item.id))?.status).toBe("awaiting-review");
  await acceptReview(outbox, item.id);
  await harness.relay.syncNow();

  const done = await outbox.get(item.id);
  expect(done?.status).toBe("done");
  expect(done?.transcript).toEqual({
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
  const harness = buildRelay(first, { dropAudioAfterTranscription: true });
  const item = await first.enqueue({ recording, audio: audio() });
  await harness.relay.syncNow();
  await first.close();

  const second = await openTestOutbox(name);
  expect(await second.getAudio(item.id)).toBeUndefined();
  expect((await second.get(item.id))?.status).toBe("awaiting-review");
});

test("with dropAudioAfterTranscription, a FAILED transcription retains the audio so the retry can work", async () => {
  const outbox = await openTestOutbox(uniqueName());
  const transcriber = new FakeTranscriber({ text: "the attic is R-19" });
  transcriber.failNextWith(Object.assign(new Error("gateway"), { status: 503 }));
  const harness = buildRelay(outbox, { transcriber, dropAudioAfterTranscription: true });
  const item = await outbox.enqueue({ recording, audio: audio() });

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

  expect((await outbox.get(item.id))?.status).toBe("awaiting-review");
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
  // pipeline. Transcription won, so the bytes go; the item is merely parked.
  const outbox = await openTestOutbox(uniqueName());
  const harness = buildRelay(outbox, {
    dropAudioAfterTranscription: true,
    extract: async () => {
      throw Object.assign(new Error("gateway"), { status: 502 });
    },
  });
  const item = await outbox.enqueue({ recording, audio: audio() });

  await harness.relay.syncNow();

  const parked = await outbox.get(item.id);
  expect(parked?.status).toBe("failed");
  // The transcript is persisted, so the retry resumes at `extract` and never
  // needs the audio again.
  expect(parked?.transcript?.text).toBe("the attic is R-19");
  expect(await outbox.getAudio(item.id)).toBeUndefined();
});

test("by default the audio survives transcription — Phase 2's visible durability payoff", async () => {
  const name = uniqueName();
  const first = await openTestOutbox(name);
  // No `dropAudioAfterTranscription` at all: the default must be retention.
  const harness = buildRelay(first);
  const item = await first.enqueue({ recording, audio: audio() });

  await harness.relay.syncNow();

  expect((await first.get(item.id))?.status).toBe("awaiting-review");
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
  const harness = buildRelay(outbox, { dropAudioAfterTranscription: false });
  const item = await outbox.enqueue({ recording, audio: audio() });

  await harness.relay.syncNow();

  expect((await outbox.get(item.id))?.status).toBe("awaiting-review");
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
  const harness = buildRelay(outbox, {
    transcriber: new FakeTranscriber({ engine: "ondevice-whisper", text: "the attic is R-19" }),
  });
  const item = await outbox.enqueue({ recording, audio: audio() });

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
  const harness = buildRelay(first, { transcriber: composite });
  const item = await harness.outbox.enqueue({ recording, audio: audio() });
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
  const harness = buildRelay(outbox, { transcriber: anonymous, maxAttempts: 1 });
  const item = await outbox.enqueue({ recording, audio: audio() });

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
  const first = await outbox.enqueue({ recording, audio: audio() });
  const second = await outbox.enqueue({
    recording: { ...recording, id: "rec-2" },
    audio: audio(),
  });

  const relay = createRelay({
    outbox,
    // Never settles — an out-of-memory worker kill looks exactly like this.
    transcriber: {
      engine: "hung",
      capability: async () => ({ status: "ready" }) as const,
      transcribe: () => new Promise<never>(() => {}),
    },
    extract: async () => ({ fields: {}, usage: { calls: 1 } }),
    write: async () => undefined,
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
