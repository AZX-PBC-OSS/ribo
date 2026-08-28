import { describe, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  openOutbox,
  ReviewValidationError,
  type ExistingRecord,
  type FieldDecision,
  type Outbox,
  type RankedCandidate,
  type SessionItem,
} from "@azx/ribo-core";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { z } from "zod";

import { useReview, type UseReviewOptions, type UseReviewResult } from "./use-review.js";

// vitest-browser-react@2.2.0's `render` (and `RenderResult.rerender`) are async —
// see context.browser.test.tsx. Every render and rerender below is awaited, with
// one deliberate exception noted at its call site.

// A miniature patch schema in the shape a real adapter declares: leaves optional
// and nullable, and ONE NESTED GROUP -- `healthSafety` is the whole reason review
// moved to leaf paths, so a fixture without nesting would test none of it.
const valuesSchema = z.object({
  atticRValue: z.number().nullable().optional(),
  healthSafety: z
    .object({
      ambientCo: z.enum(["passed", "failed", "not_tested"]).nullable().optional(),
      asbestos: z.enum(["passed", "failed", "not_tested"]).nullable().optional(),
    })
    .optional(),
});

// `transcriptSchema` is a z.strictObject requiring `recordingId`, `text` and `engine`.
// `segments` is not a field and a strict schema REJECTS it, so an invented fixture
// fails at `outbox.patch`'s boundary parse before the hook is ever exercised.
const transcriptFor = (recordingId: string) => ({
  recordingId,
  text: "The attic is R-19 and ambient CO passed.",
  engine: "fake",
});

const recording = () => ({
  id: crypto.randomUUID(),
  capturedAt: new Date().toISOString(),
  durationMs: 10,
  mimeType: "audio/webm",
  ctx: {},
});

/**
 * A parked session covering all three cases the schema walk has to handle: a grounded
 * leaf, an ungrounded one, and `healthSafety.asbestos`, which the model OMITTED —
 * present here only because the schema says it exists.
 *
 * After the schema split the session owns `extracted` and the recording owns its
 * `transcript`, so the fixture opens a session, enqueues one recording into it,
 * writes the transcript on the recording, then patches the session to
 * `awaiting-review` with the extraction output.
 */
async function parkedItem() {
  const outbox = await openOutbox({
    name: `t-${crypto.randomUUID()}`,
    storage: getRxStorageMemory(),
  });
  const session = await outbox.openSession();
  const rec = await outbox.enqueue({
    recording: recording(),
    audio: new Blob(["x"], { type: "audio/webm" }),
    sessionId: session.id,
  });
  await outbox.patch(rec.id, {
    status: "transcribed",
    transcript: transcriptFor(rec.recording.id),
  });
  const parked = await outbox.patchSession(session.id, {
    status: "awaiting-review",
    extracted: {
      atticRValue: { value: 19, confidence: 1, sourceSpan: "R-19" },
      healthSafety: {
        ambientCo: { value: "passed", confidence: 1, sourceSpan: "the CO reading was fine" },
      },
    },
    extractedFromRecordingIds: [rec.id],
  });
  return { outbox, session: parked };
}

/**
 * Mounts the hook and hands back the live result object.
 *
 * `extra` merges over the base `{ valuesSchema, outbox }` — the one caller that
 * needs `requiredOnCreate` is what it exists for, so most call sites pass nothing.
 *
 * When `session` is not `undefined`, waits for `ready` to become `true` before
 * returning: `useOutboxItems` inside `useReview` loads the session's recordings
 * asynchronously, so the first render after mount is not yet ready.
 */
async function probe(
  session: SessionItem | undefined,
  outbox: Outbox,
  extra: Partial<UseReviewOptions> = {},
) {
  const seen: { current: UseReviewResult | undefined } = { current: undefined };
  function Probe({ subject }: { subject: SessionItem | undefined }) {
    seen.current = useReview(subject, { valuesSchema, outbox, ...extra });
    return null;
  }
  const screen = await render(<Probe subject={session} />);
  if (session !== undefined) {
    await vi.waitFor(() => expect(seen.current!.ready).toBe(true));
  }
  return { seen, screen, Probe };
}

test("is not ready until the session has both a joined transcript and an extraction", async () => {
  const { outbox, session } = await parkedItem();
  const { seen, screen, Probe } = await probe(undefined, outbox);

  expect(seen.current!.ready).toBe(false);
  expect(seen.current!.fields).toBeUndefined();

  await screen.rerender(<Probe subject={session} />);
  await vi.waitFor(() => expect(seen.current!.ready).toBe(true));
  await outbox.close();
});

test("fields are the schema's leaves, by dotted path, in declaration order", async () => {
  // The schema enumerates the leaves, never the data. `healthSafety.asbestos` is
  // here because the schema says it exists -- the model never emitted it, and a
  // field that vanishes from the card is indistinguishable to the auditor from one
  // that was extracted correctly.
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);

  expect(Object.keys(seen.current!.fields!)).toEqual([
    "atticRValue",
    "healthSafety.ambientCo",
    "healthSafety.asbestos",
  ]);
  expect(seen.current!.fields!["healthSafety.asbestos"]!.extracted).toEqual({
    value: null,
    confidence: 0,
    sourceSpan: null,
  });
  await outbox.close();
});

test("grounding comes from core, so every UI flags the same thing", async () => {
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);

  expect(seen.current!.fields!.atticRValue!.isGrounded).toBe(true);
  // "the CO reading was fine" was never said -- the model invented the quote.
  expect(seen.current!.fields!["healthSafety.ambientCo"]!.isGrounded).toBe(false);
  // A null span cannot be a verbatim quote.
  expect(seen.current!.fields!["healthSafety.asbestos"]!.isGrounded).toBe(false);
  await outbox.close();
});

test("each field carries its own leaf schema, so a UI can render an editor without the adapter", async () => {
  // The property AGENTS.md §4 now rests on: everything needed to render and
  // validate one editor is on the field, and a TypeScript type could not carry
  // the enum's members to runtime.
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);

  const leaf = seen.current!.fields!["healthSafety.ambientCo"]!.schema;
  expect(leaf.safeParse("passed").success).toBe(true);
  expect(leaf.safeParse("maybe").success).toBe(false);
  await outbox.close();
});

test("requiredOnCreate marks the named leaf required and leaves every other leaf not required", async () => {
  // This is the join that went missing: `buildReviewRequest` and `snuggProAdapter`
  // were each correct on their own, but nothing threaded the adapter's
  // `requiredOnCreate` list through `useReview` into the request it builds. Without
  // it every leaf's `required` is `false`, silently, because
  // `BuildReviewRequestOptions.requiredOnCreate` defaults to `undefined` there too.
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox, {
    requiredOnCreate: { healthSafety: ["ambientCo"] },
  });

  expect(seen.current!.fields!["healthSafety.ambientCo"]!.required).toBe(true);
  // Not named -> not required. An adapter's silence is not a claim of absence,
  // but it must not be misread as a claim of presence either.
  expect(seen.current!.fields!.atticRValue!.required).toBe(false);
  expect(seen.current!.fields!["healthSafety.asbestos"]!.required).toBe(false);
  await outbox.close();
});

test("every leaf starts accepted, and untouched names what nobody looked at", async () => {
  // Core's contract says a leaf with no decision is indistinguishable from one the
  // reviewer never saw, so decisions start complete and `untouched` is what lets a
  // host refuse to submit while an ungrounded leaf has not been visited.
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);

  expect(seen.current!.decisionOf("atticRValue")).toEqual({ status: "accepted" });
  expect(seen.current!.untouched).toEqual([
    "atticRValue",
    "healthSafety.ambientCo",
    "healthSafety.asbestos",
  ]);
  expect(seen.current!.decisionOf("notALeaf")).toBeUndefined();
  await outbox.close();
});

test("submitting untouched leaves yields an accepted outcome with the nesting rebuilt", async () => {
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);

  const outcome = await seen.current!.submit();

  expect(outcome).toEqual({
    status: "accepted",
    // Nested, not dotted -- this is the shape the adapter's patch schema describes.
    // `asbestos` is a present null: the omitted leaf was accepted as extracted.
    fields: { atticRValue: 19, healthSafety: { ambientCo: "passed", asbestos: null } },
  });

  const persisted = await outbox.getSession(session.id);
  expect(persisted?.status).toBe("writing");
  expect(persisted?.reviewOutcome).toMatchObject({ status: "accepted" });
  await outbox.close();
});

test("an edit is reported as edited even when the value is unchanged", async () => {
  // resolveReview's rule: the signal is what the human touched, not whether the
  // bytes changed. Comparing values would under-report review effort for exactly
  // the leaves someone stopped to check.
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);

  seen.current!.edit("atticRValue", 19);
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("atticRValue")).toEqual({ status: "edited", value: 19 }),
  );
  const outcome = await seen.current!.submit();

  expect(outcome).toMatchObject({ status: "edited", editedFields: ["atticRValue"] });
  await outbox.close();
});

test("rejecting the last leaf of a group drops the group entirely", async () => {
  // A nested group only materialises when one of its leaves survives review, and
  // an absent key is what a patch means by "leave this alone".
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);

  seen.current!.reject("healthSafety.ambientCo");
  seen.current!.reject("healthSafety.asbestos");
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("healthSafety.asbestos")).toEqual({ status: "rejected" }),
  );
  const outcome = await seen.current!.submit();

  expect(outcome).toMatchObject({
    status: "edited",
    fields: { atticRValue: 19 },
    rejectedFields: ["healthSafety.ambientCo", "healthSafety.asbestos"],
  });
  expect("healthSafety" in (outcome as { fields: object }).fields).toBe(false);
  await outbox.close();
});

test("editing to null is a positive assertion, not a rejection", async () => {
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);

  seen.current!.edit("healthSafety.ambientCo", null);
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("healthSafety.ambientCo")).toEqual({
      status: "edited",
      value: null,
    }),
  );
  const outcome = await seen.current!.submit();

  // Present and null -- "there is nothing to record here" -- not absent.
  const fields = (outcome as unknown as { fields: { healthSafety: Record<string, unknown> } })
    .fields;
  expect(fields.healthSafety.ambientCo).toBeNull();
  await outbox.close();
});

test("the absent-versus-null distinction is pinned on what's actually persisted, not just on the returned outcome", async () => {
  // Every test above this one only asserts on `submit()`'s RETURN value. An
  // implementation that computes a perfectly correct outcome but then persists
  // something else entirely -- an empty `{ fields: {} }`, a version with nulls
  // stripped, one that reinstates a rejected leaf -- would pass every one of
  // them. `outbox.submitSessionReview` is the actual trust boundary (`relay.ts` reads
  // straight off what lands there), so this spies on the call itself.
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);
  const submitSessionReviewSpy = vi.spyOn(outbox, "submitSessionReview");

  seen.current!.reject("atticRValue"); // must end up ABSENT from what's persisted
  seen.current!.edit("healthSafety.ambientCo", null); // must end up PRESENT and null
  // healthSafety.asbestos left untouched: accepted-as-extracted, and the
  // extracted value is the omitted-leaf sentinel `null` -- also PRESENT and null.
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("atticRValue")).toEqual({ status: "rejected" }),
  );

  const outcome = await seen.current!.submit();
  expect(outcome).toMatchObject({ status: "edited" });

  expect(submitSessionReviewSpy).toHaveBeenCalledTimes(1);
  const persisted = submitSessionReviewSpy.mock.calls[0]![1] as { fields: Record<string, unknown> };
  expect(Object.hasOwn(persisted.fields, "atticRValue")).toBe(false);
  // The real NESTED shape `submitSessionReview` actually receives, not a dotted one.
  expect(persisted.fields.healthSafety).toEqual({ ambientCo: null, asbestos: null });
  await outbox.close();
});

test("accept() explicitly re-accepts the extracted value -- including a sentinel null -- after a prior rejection on the same leaf", async () => {
  // accept() had no test at all before this one, and this is the case that
  // matters most for it: reverting a rejection must restore exactly what the
  // model extracted, even when that value is the omitted-leaf sentinel `null`
  // rather than a real answer -- and the persisted call must show it PRESENT,
  // not silently dropped the way a rejection would leave it.
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);
  const submitSessionReviewSpy = vi.spyOn(outbox, "submitSessionReview");

  seen.current!.reject("healthSafety.asbestos");
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("healthSafety.asbestos")).toEqual({ status: "rejected" }),
  );
  seen.current!.accept("healthSafety.asbestos");
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("healthSafety.asbestos")).toEqual({ status: "accepted" }),
  );

  const outcome = await seen.current!.submit();
  expect(outcome).toEqual({
    status: "accepted",
    fields: { atticRValue: 19, healthSafety: { ambientCo: "passed", asbestos: null } },
  });

  expect(submitSessionReviewSpy).toHaveBeenCalledTimes(1);
  const persisted = submitSessionReviewSpy.mock.calls[0]![1] as unknown as {
    fields: { healthSafety: Record<string, unknown> };
  };
  expect(Object.hasOwn(persisted.fields.healthSafety, "asbestos")).toBe(true);
  expect(persisted.fields.healthSafety.asbestos).toBeNull();
  await outbox.close();
});

test("editing to undefined is refused rather than normalised", async () => {
  // Type-legal, and exactly what a React editor with `undefined` state submits. It
  // passes an `.optional()` leaf schema and then disappears on serialisation,
  // leaving the leaf ABSENT -- "do not touch this field" -- while `editedFields`
  // still names it as touched. Refused at the call site so the report lands on the
  // keystroke that caused it, and never rewritten to null, which would write an
  // empty value nobody asked for.
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);

  expect(() => seen.current!.edit("atticRValue", undefined)).toThrow(/undefined/);
  expect(() => seen.current!.edit("atticRValue", undefined)).toThrow(/reject/);
  expect(seen.current!.decisionOf("atticRValue")).toEqual({ status: "accepted" });
  expect(seen.current!.untouched).toContain("atticRValue");
  await outbox.close();
});

test("an unknown or mistyped path throws rather than silently flipping meaning", async () => {
  // submit() defaults any path missing a decision to "accepted" -- that is what
  // makes resolveReview's completeness check pass for every leaf nobody touched.
  // A decision recorded under a path that ISN'T a leaf never reaches that map at
  // all, so a typo like "healthSafety.asbestoss" would silently leave the real
  // "healthSafety.asbestos" defaulted to accepted -- turning an intended
  // rejection into an acceptance of whatever the model extracted, with no error
  // anywhere. This must be loud instead.
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);

  expect(() => seen.current!.reject("healthSafety.asbestoss")).toThrow(/not a field/i);
  expect(() => seen.current!.accept("attic_R_Value")).toThrow(/not a field/i);
  expect(() => seen.current!.edit("nope", 1)).toThrow(/not a field/i);
  // None of the three silently recorded anything -- the real leaves are exactly
  // where review started.
  expect(seen.current!.decisionOf("atticRValue")).toEqual({ status: "accepted" });
  expect(seen.current!.decisionOf("healthSafety.asbestos")).toEqual({ status: "accepted" });
  expect(seen.current!.untouched).toEqual([
    "atticRValue",
    "healthSafety.ambientCo",
    "healthSafety.asbestos",
  ]);
  await outbox.close();
});

test("a submit whose value fails its leaf schema throws AND reports the leaf", async () => {
  // Both halves are the requirement. Throwing is what stops a caller proceeding as
  // though the review went in; `errors` is what lets the card show the message
  // beside the input while the auditor is still looking at it.
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);

  seen.current!.edit("atticRValue", "thirty");
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("atticRValue")).toMatchObject({ status: "edited" }),
  );

  await expect(seen.current!.submit()).rejects.toBeInstanceOf(ReviewValidationError);
  await vi.waitFor(() => expect(seen.current!.errors.atticRValue).toMatch(/not valid/i));
  expect(seen.current!.error).toBeInstanceOf(ReviewValidationError);
  // Nothing was persisted, and the session did not move.
  expect((await outbox.getSession(session.id))?.status).toBe("awaiting-review");
  await outbox.close();
});

test("an error clears for a leaf as soon as that leaf is decided again", async () => {
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);

  seen.current!.edit("atticRValue", "thirty");
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("atticRValue")).toMatchObject({ status: "edited" }),
  );
  await expect(seen.current!.submit()).rejects.toThrow();
  await vi.waitFor(() => expect(seen.current!.errors.atticRValue).toBeDefined());

  seen.current!.edit("atticRValue", 30);
  await vi.waitFor(() => expect(seen.current!.errors.atticRValue).toBeUndefined());

  const outcome = await seen.current!.submit();
  expect(outcome).toMatchObject({ status: "edited" });
  await outbox.close();
});

test("a successful submit clears every error left over from a failed one", async () => {
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);

  seen.current!.edit("atticRValue", "thirty");
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("atticRValue")).toMatchObject({ status: "edited" }),
  );
  await expect(seen.current!.submit()).rejects.toThrow();
  await vi.waitFor(() => expect(seen.current!.errors.atticRValue).toBeDefined());
  // Both halves of the failed submit's aftermath: the per-leaf map AND the
  // single `error` this hook also exposes. A fix that clears one and not the
  // other (Task 13's own reference implementation shipped exactly that half-fix
  // for a different hook) would leave a card showing no per-field message while
  // a banner still reports a submission that has since succeeded.
  expect(seen.current!.error).toBeInstanceOf(ReviewValidationError);

  seen.current!.reject("atticRValue");
  // Without this wait, `seen.current!.submit` below can still be the PRIOR
  // render's closure -- captured over the "edited: thirty" decision -- because
  // `reject()`'s `setState` has not yet flushed into a re-render of `Probe`.
  // Calling that stale closure resubmits the invalid edit and this test fails
  // for the wrong reason (the old ReviewValidationError) instead of exercising
  // the success path it is named for.
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("atticRValue")).toEqual({ status: "rejected" }),
  );
  await seen.current!.submit();

  await vi.waitFor(() => expect(seen.current!.errors).toEqual({}));
  await vi.waitFor(() => expect(seen.current!.error).toBeUndefined());
  await outbox.close();
});

test("decisions and errors do not leak between sessions in a reused component", async () => {
  // A queue UI reuses one card for the next parked session, and leaf paths repeat
  // across recordings. A correction made to session A must not be submitted
  // against session B -- and it must be gone on the FIRST render after the swap,
  // not one render later, because that render can submit.
  const { outbox, session: first } = await parkedItem();
  const secondSession = await outbox.openSession();
  const secondRec = await outbox.enqueue({
    recording: recording(),
    audio: new Blob(["x"], { type: "audio/webm" }),
    sessionId: secondSession.id,
  });
  await outbox.patch(secondRec.id, {
    status: "transcribed",
    transcript: transcriptFor(secondRec.recording.id),
  });
  const parkedSecond = await outbox.patchSession(secondSession.id, {
    status: "awaiting-review",
    extracted: { atticRValue: { value: 11, confidence: 1, sourceSpan: "R-11" } },
    extractedFromRecordingIds: [secondRec.id],
  });

  // A plain `probe()` cannot pin "not one render later": `rerender()` wraps
  // React's commit in `act()`, which drains every effect-triggered render
  // before its promise resolves, so by the time an `await`ed rerender returns,
  // a broken effect-based reset has already had its extra render and looks
  // identical to the correct synchronous guard. So this component instead
  // records the decision `useReview` reports on EVERY render for the second
  // session -- the guard resets it on the very first one; an effect-based reset
  // would report the stale "edited" decision on that first entry and only fix
  // it on a second, which this history makes visible even after `act()` has
  // long since settled.
  const seen: { current: UseReviewResult | undefined } = { current: undefined };
  const seenForSecond: FieldDecision[] = [];
  function Probe({ subject }: { subject: SessionItem | undefined }) {
    const result = useReview(subject, { valuesSchema, outbox });
    seen.current = result;
    if (subject?.id === parkedSecond.id) {
      seenForSecond.push(result.decisionOf("atticRValue")!);
    }
    return null;
  }

  const screen = await render(<Probe subject={first} />);
  await vi.waitFor(() => expect(seen.current!.ready).toBe(true));
  seen.current!.edit("atticRValue", "thirty");
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("atticRValue")).toMatchObject({ status: "edited" }),
  );
  await expect(seen.current!.submit()).rejects.toThrow();
  await vi.waitFor(() => expect(seen.current!.errors.atticRValue).toBeDefined());

  await screen.rerender(<Probe subject={parkedSecond} />);

  // The FIRST render for the new session already saw the reset decision, not a
  // stale one corrected one render later.
  expect(seenForSecond[0]).toEqual({ status: "accepted" });
  expect(seen.current!.decisionOf("atticRValue")).toEqual({ status: "accepted" });
  expect(seen.current!.errors).toEqual({});
  expect(seen.current!.untouched).toContain("atticRValue");
  await outbox.close();
});

test("switching sessions while a submit is pending does not leak submitting or error onto the next session", async () => {
  // `decisions`/`errors` are not the only per-session state -- `submitting` and
  // `error` used to live in their own, session-blind `useState`s. Reproduces both
  // halves of that leak: (1) the SECOND session's very first render must already
  // show a clean slate while the first session's write is still in flight, and (2)
  // once that stale write finally settles, its completion must not resurrect
  // anything on a card that has since moved on.
  const { outbox, session: first } = await parkedItem();
  const secondSession = await outbox.openSession();
  const secondRec = await outbox.enqueue({
    recording: recording(),
    audio: new Blob(["x"], { type: "audio/webm" }),
    sessionId: secondSession.id,
  });
  await outbox.patch(secondRec.id, {
    status: "transcribed",
    transcript: transcriptFor(secondRec.recording.id),
  });
  const parkedSecond = await outbox.patchSession(secondSession.id, {
    status: "awaiting-review",
    extracted: { atticRValue: { value: 11, confidence: 1, sourceSpan: "R-11" } },
    extractedFromRecordingIds: [secondRec.id],
  });

  // Held open until the test decides to fail it, so the first session's submit is
  // genuinely still in flight when the card switches to the second session.
  let rejectFirstWrite: (error: Error) => void = () => undefined;
  const pendingWrite = new Promise<SessionItem>((_, reject) => {
    rejectFirstWrite = reject;
  });
  const submitSessionReviewSpy = vi
    .spyOn(outbox, "submitSessionReview")
    .mockReturnValueOnce(pendingWrite);

  const { seen, screen, Probe } = await probe(first, outbox);

  // Every leaf on `first` defaults to accepted, so this clears resolveReview and
  // reaches the (mocked, pending) write.
  const submitPromise = seen.current!.submit();
  await vi.waitFor(() => expect(seen.current!.submitting).toBe(true));

  await screen.rerender(<Probe subject={parkedSecond} />);

  expect(seen.current!.submitting).toBe(false);
  expect(seen.current!.error).toBeUndefined();

  rejectFirstWrite(new Error("stale network failure"));
  await expect(submitPromise).rejects.toThrow("stale network failure");
  // Give the (incorrect) cross-session write every chance to land before checking
  // it didn't.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(seen.current!.submitting).toBe(false);
  expect(seen.current!.error).toBeUndefined();

  submitSessionReviewSpy.mockRestore();
  await outbox.close();
});

test("a stale operation's completion cannot override a newer one on the same session", async () => {
  // Two submits in flight together for ONE session: `forSession` alone cannot tell
  // them apart, since neither ever changes it. Without a token, the first
  // attempt's completion -- arriving after the second has already succeeded --
  // would report `submitting: false` (masking that the second write, if it were
  // still running, hadn't finished) and, worse, resurrect an error over a review
  // that has already, successfully, gone in.
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);

  let rejectFirstWrite: (error: Error) => void = () => undefined;
  const firstWrite = new Promise<SessionItem>((_, reject) => {
    rejectFirstWrite = reject;
  });
  const submitSessionReviewSpy = vi
    .spyOn(outbox, "submitSessionReview")
    .mockReturnValueOnce(firstWrite);

  const firstSubmit = seen.current!.submit();
  await vi.waitFor(() => expect(seen.current!.submitting).toBe(true));

  // The second attempt falls through to the real (fast, in-memory) write and
  // succeeds before the first one has even failed.
  const secondSubmit = seen.current!.submit();
  await secondSubmit;
  // Awaiting `submit()` itself does not guarantee its last `setState` has been
  // committed -- this call runs outside any `act()`, unlike a `render`/
  // `rerender`, so React's own scheduling can still be a tick behind the
  // resolved promise. Same convention as every other post-decision assertion
  // in this file.
  await vi.waitFor(() => expect(seen.current!.submitting).toBe(false));
  expect(seen.current!.error).toBeUndefined();

  rejectFirstWrite(new Error("stale network failure"));
  await expect(firstSubmit).rejects.toThrow("stale network failure");
  // `submitting` is ALREADY `false` at this point (from the second submit
  // succeeding, above), so `vi.waitFor(() => submitting === false)` would
  // resolve instantly whether or not the stale completion's `setState` has
  // landed yet -- it cannot prove the wait was long enough to observe a
  // regression. A short real delay is what actually gives that (still
  // outside any `act()`) update a chance to commit before checking the
  // negative.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(seen.current!.submitting).toBe(false);
  expect(seen.current!.error).toBeUndefined();

  submitSessionReviewSpy.mockRestore();
  await outbox.close();
});

test("a schema change on the same session revalidates a stale error without re-deciding the leaf", async () => {
  // The bulk `errors: {}` clear inside submit() is not redundant with
  // per-decision clearing in every case: `decisions` is keyed by session, not by
  // which `valuesSchema` produced `request`, so a leaf can go from invalid to
  // valid because the SCHEMA loosened between two submits, with its own decision
  // never touched. Per-decision clearing (`setDecision`'s `withoutPath`) never
  // fires in that case, so only the bulk clear can retire the stale message.
  const { outbox, session } = await parkedItem();

  const strictSchema = valuesSchema; // atticRValue: z.number().nullable().optional()
  const relaxedSchema = z.object({
    atticRValue: z.union([z.number(), z.string()]).nullable().optional(),
    healthSafety: z
      .object({
        ambientCo: z.enum(["passed", "failed", "not_tested"]).nullable().optional(),
        asbestos: z.enum(["passed", "failed", "not_tested"]).nullable().optional(),
      })
      .optional(),
  });

  const seen: { current: UseReviewResult | undefined } = { current: undefined };
  function Probe({ schema }: { schema: z.ZodObject }) {
    seen.current = useReview(session, { valuesSchema: schema, outbox });
    return null;
  }

  const screen = await render(<Probe schema={strictSchema} />);
  await vi.waitFor(() => expect(seen.current!.ready).toBe(true));

  seen.current!.edit("atticRValue", "thirty");
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("atticRValue")).toMatchObject({ status: "edited" }),
  );
  await expect(seen.current!.submit()).rejects.toThrow();
  await vi.waitFor(() => expect(seen.current!.errors.atticRValue).toBeDefined());

  // Same session, same decision ("thirty" is still what's recorded for
  // atticRValue) -- only the field's own schema now accepts a string.
  await screen.rerender(<Probe schema={relaxedSchema} />);

  const outcome = await seen.current!.submit();
  expect(outcome).toMatchObject({ status: "edited", editedFields: ["atticRValue"] });
  await vi.waitFor(() => expect(seen.current!.errors).toEqual({}));
  await outbox.close();
});

test("discarding is terminal", async () => {
  // A discarded review outcome on a session means the human decided the whole
  // session's extraction is not going anywhere. Unlike the recording's discard
  // (which drops audio), there is no audio on the session to drop — the
  // recordings stay. The session transitions to `done` with the outcome recorded.
  const { outbox, session } = await parkedItem();
  const { seen } = await probe(session, outbox);

  const outcome = await seen.current!.discard("misspoke");
  expect(outcome).toEqual({ status: "discarded", reason: "misspoke" });

  const persisted = await outbox.getSession(session.id);
  expect(persisted?.status).toBe("done");
  expect(persisted?.reviewOutcome).toMatchObject({ status: "discarded", reason: "misspoke" });
  await outbox.close();
});

describe("useReview — instance identity: link-or-create decision", () => {
  const collectionValuesSchema = z.object({
    hvac: z
      .array(
        z
          .object({
            hvacSystemEquipmentType: z.string().nullable().optional(),
            hvacHeatingSystemManufacturer: z.string().nullable().optional(),
          })
          .strict(),
      )
      .optional(),
  });

  const collectionTranscript = {
    recordingId: "rec-hvac",
    text: "Boiler by Burnham.",
    engine: "fake",
  } as const;

  async function collectionParkedItem() {
    const outbox = await openOutbox({
      name: `t-${crypto.randomUUID()}`,
      storage: getRxStorageMemory(),
    });
    const session = await outbox.openSession();
    const rec = await outbox.enqueue({
      recording: recording(),
      audio: new Blob(["x"], { type: "audio/webm" }),
      sessionId: session.id,
    });
    await outbox.patch(rec.id, {
      status: "transcribed",
      transcript: collectionTranscript,
    });
    const parked = await outbox.patchSession(session.id, {
      status: "awaiting-review",
      extracted: {
        hvac: [
          {
            hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "Boiler" },
            hvacHeatingSystemManufacturer: {
              value: "Burnham",
              confidence: 1,
              sourceSpan: "Burnham",
            },
          },
        ],
      },
      extractedFromRecordingIds: [rec.id],
    });
    return { outbox, session: parked };
  }

  async function collectionProbe(
    session: SessionItem | undefined,
    outbox: Outbox,
    extra: Partial<UseReviewOptions> = {},
  ) {
    const seen: { current: UseReviewResult | undefined } = { current: undefined };
    function Probe({ subject }: { subject: SessionItem | undefined }) {
      seen.current = useReview(subject, {
        valuesSchema: collectionValuesSchema,
        outbox,
        ...extra,
      });
      return null;
    }
    const screen = await render(<Probe subject={session} />);
    if (session !== undefined) {
      await vi.waitFor(() => expect(seen.current!.ready).toBe(true));
    }
    return { seen, screen, Probe };
  }

  const existingRecords: Record<string, readonly ExistingRecord[]> = {
    hvac: [
      {
        uuid: "hvac-1",
        fields: { hvacSystemEquipmentType: "Boiler", hvacHeatingSystemManufacturer: "Burnham" },
      },
    ],
  };

  const rankCandidates: (
    group: string,
    instance: Record<string, unknown>,
    existing: readonly ExistingRecord[],
  ) => readonly RankedCandidate[] = (_group, instance, existing) =>
    existing.map((record) => ({
      ...record,
      contradicts: instance.hvacSystemEquipmentType !== record.fields.hvacSystemEquipmentType,
    }));

  test("exposes existing records and the default create decision", async () => {
    const { outbox, session } = await collectionParkedItem();
    const { seen } = await collectionProbe(session, outbox, {
      existingRecords,
      rankCandidates,
    });

    expect(seen.current!.existingRecords).toEqual(existingRecords);
    expect(seen.current!.linkDecisionOf("hvac[k1]")).toEqual({ kind: "create" });
    expect(seen.current!.rankedCandidatesOf("hvac[k1]")).toHaveLength(1);
    await outbox.close();
  });

  test("linking an instance survives submit and reaches the outcome as an update target", async () => {
    const { outbox, session } = await collectionParkedItem();
    const { seen } = await collectionProbe(session, outbox, {
      existingRecords,
      rankCandidates,
    });

    seen.current!.linkInstance("hvac[k1]", "hvac-1");
    await vi.waitFor(() =>
      expect(seen.current!.linkDecisionOf("hvac[k1]")).toEqual({ kind: "link", uuid: "hvac-1" }),
    );
    const outcome = await seen.current!.submit();

    expect(outcome).toMatchObject({
      status: "accepted",
      fields: {
        hvac: [{ hvacSystemEquipmentType: "Boiler", hvacHeatingSystemManufacturer: "Burnham" }],
      },
      linkTargets: { hvac: ["hvac-1"] },
    });

    const persisted = await outbox.getSession(session.id);
    expect(persisted?.reviewOutcome).toMatchObject({
      status: "accepted",
      linkTargets: { hvac: ["hvac-1"] },
    });
    await outbox.close();
  });

  test("without a link decision, one perfect existing record still creates", async () => {
    const { outbox, session } = await collectionParkedItem();
    const { seen } = await collectionProbe(session, outbox, {
      existingRecords,
      rankCandidates,
    });

    const outcome = await seen.current!.submit();

    expect(outcome).toMatchObject({
      status: "accepted",
      linkTargets: { hvac: [null] },
    });
    await outbox.close();
  });

  test("createInstance resets a previous link decision", async () => {
    const { outbox, session } = await collectionParkedItem();
    const { seen } = await collectionProbe(session, outbox, {
      existingRecords,
      rankCandidates,
    });

    seen.current!.linkInstance("hvac[k1]", "hvac-1");
    await vi.waitFor(() =>
      expect(seen.current!.linkDecisionOf("hvac[k1]")).toEqual({ kind: "link", uuid: "hvac-1" }),
    );
    seen.current!.createInstance("hvac[k1]");
    await vi.waitFor(() =>
      expect(seen.current!.linkDecisionOf("hvac[k1]")).toEqual({ kind: "create" }),
    );
    const outcome = await seen.current!.submit();
    expect(outcome).toMatchObject({ linkTargets: { hvac: [null] } });
    await outbox.close();
  });

  test("an unknown instance path is rejected when linking", async () => {
    const { outbox, session } = await collectionParkedItem();
    const { seen } = await collectionProbe(session, outbox, {
      existingRecords,
      rankCandidates,
    });

    expect(() => seen.current!.linkInstance("hvac[k9]", "hvac-1")).toThrow(
      /not a collection instance/,
    );
    await outbox.close();
  });
});
