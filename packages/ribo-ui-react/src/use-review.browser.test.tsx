import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  openOutbox,
  ReviewValidationError,
  type FieldDecision,
  type Outbox,
  type OutboxItem,
} from "@azx/ribo-core";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { z } from "zod";

import { useReview, type UseReviewResult } from "./use-review.js";

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
 * A parked item covering all three cases the schema walk has to handle: a grounded
 * leaf, an ungrounded one, and `healthSafety.asbestos`, which the model OMITTED —
 * present here only because the schema says it exists.
 */
async function parkedItem() {
  const outbox = await openOutbox({
    name: `t-${crypto.randomUUID()}`,
    storage: getRxStorageMemory(),
  });
  const item = await outbox.enqueue({
    recording: recording(),
    audio: new Blob(["x"], { type: "audio/webm" }),
  });
  const parked = await outbox.patch(item.id, {
    status: "awaiting-review",
    transcript: transcriptFor(item.recording.id),
    extracted: {
      atticRValue: { value: 19, confidence: 1, sourceSpan: "R-19" },
      healthSafety: {
        ambientCo: { value: "passed", confidence: 1, sourceSpan: "the CO reading was fine" },
      },
    },
  });
  return { outbox, item: parked };
}

/** Mounts the hook and hands back the live result object. */
async function probe(item: OutboxItem | undefined, outbox: Outbox) {
  const seen: { current: UseReviewResult | undefined } = { current: undefined };
  function Probe({ subject }: { subject: OutboxItem | undefined }) {
    seen.current = useReview(subject, { valuesSchema, outbox });
    return null;
  }
  const screen = await render(<Probe subject={item} />);
  return { seen, screen, Probe };
}

test("is not ready until the item has both a transcript and an extraction", async () => {
  const { outbox, item } = await parkedItem();
  const { seen, screen, Probe } = await probe(undefined, outbox);

  expect(seen.current!.ready).toBe(false);
  expect(seen.current!.fields).toBeUndefined();

  await screen.rerender(<Probe subject={item} />);
  expect(seen.current!.ready).toBe(true);
  await outbox.close();
});

test("fields are the schema's leaves, by dotted path, in declaration order", async () => {
  // The schema enumerates the leaves, never the data. `healthSafety.asbestos` is
  // here because the schema says it exists -- the model never emitted it, and a
  // field that vanishes from the card is indistinguishable to the auditor from one
  // that was extracted correctly.
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);

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
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);

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
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);

  const leaf = seen.current!.fields!["healthSafety.ambientCo"]!.schema;
  expect(leaf.safeParse("passed").success).toBe(true);
  expect(leaf.safeParse("maybe").success).toBe(false);
  await outbox.close();
});

test("every leaf starts accepted, and untouched names what nobody looked at", async () => {
  // Core's contract says a leaf with no decision is indistinguishable from one the
  // reviewer never saw, so decisions start complete and `untouched` is what lets a
  // host refuse to submit while an ungrounded leaf has not been visited.
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);

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
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);

  const outcome = await seen.current!.submit();

  expect(outcome).toEqual({
    status: "accepted",
    // Nested, not dotted -- this is the shape the adapter's patch schema describes.
    // `asbestos` is a present null: the omitted leaf was accepted as extracted.
    fields: { atticRValue: 19, healthSafety: { ambientCo: "passed", asbestos: null } },
  });

  const persisted = await outbox.get(item.id);
  expect(persisted?.status).toBe("writing");
  expect(persisted?.reviewOutcome).toMatchObject({ status: "accepted" });
  await outbox.close();
});

test("an edit is reported as edited even when the value is unchanged", async () => {
  // resolveReview's rule: the signal is what the human touched, not whether the
  // bytes changed. Comparing values would under-report review effort for exactly
  // the leaves someone stopped to check.
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);

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
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);

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
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);

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
  // them. `outbox.submitReview` is the actual trust boundary (`relay.ts` reads
  // straight off what lands there), so this spies on the call itself.
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);
  const submitReviewSpy = vi.spyOn(outbox, "submitReview");

  seen.current!.reject("atticRValue"); // must end up ABSENT from what's persisted
  seen.current!.edit("healthSafety.ambientCo", null); // must end up PRESENT and null
  // healthSafety.asbestos left untouched: accepted-as-extracted, and the
  // extracted value is the omitted-leaf sentinel `null` -- also PRESENT and null.
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("atticRValue")).toEqual({ status: "rejected" }),
  );

  const outcome = await seen.current!.submit();
  expect(outcome).toMatchObject({ status: "edited" });

  expect(submitReviewSpy).toHaveBeenCalledTimes(1);
  const persisted = submitReviewSpy.mock.calls[0]![1] as { fields: Record<string, unknown> };
  expect(Object.hasOwn(persisted.fields, "atticRValue")).toBe(false);
  // The real NESTED shape `submitReview` actually receives, not a dotted one.
  expect(persisted.fields.healthSafety).toEqual({ ambientCo: null, asbestos: null });
  await outbox.close();
});

test("accept() explicitly re-accepts the extracted value -- including a sentinel null -- after a prior rejection on the same leaf", async () => {
  // accept() had no test at all before this one, and this is the case that
  // matters most for it: reverting a rejection must restore exactly what the
  // model extracted, even when that value is the omitted-leaf sentinel `null`
  // rather than a real answer -- and the persisted call must show it PRESENT,
  // not silently dropped the way a rejection would leave it.
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);
  const submitReviewSpy = vi.spyOn(outbox, "submitReview");

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

  expect(submitReviewSpy).toHaveBeenCalledTimes(1);
  const persisted = submitReviewSpy.mock.calls[0]![1] as unknown as {
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
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);

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
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);

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
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);

  seen.current!.edit("atticRValue", "thirty");
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("atticRValue")).toMatchObject({ status: "edited" }),
  );

  await expect(seen.current!.submit()).rejects.toBeInstanceOf(ReviewValidationError);
  await vi.waitFor(() => expect(seen.current!.errors.atticRValue).toMatch(/not valid/i));
  expect(seen.current!.error).toBeInstanceOf(ReviewValidationError);
  // Nothing was persisted, and the item did not move.
  expect((await outbox.get(item.id))?.status).toBe("awaiting-review");
  await outbox.close();
});

test("an error clears for a leaf as soon as that leaf is decided again", async () => {
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);

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
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);

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

test("decisions and errors do not leak between items in a reused component", async () => {
  // A queue UI reuses one card for the next parked item, and leaf paths repeat
  // across recordings. A correction made to recording A must not be submitted
  // against recording B -- and it must be gone on the FIRST render after the swap,
  // not one render later, because that render can submit.
  const { outbox, item: first } = await parkedItem();
  const second = await outbox.enqueue({
    recording: recording(),
    audio: new Blob(["x"], { type: "audio/webm" }),
  });
  const parkedSecond = await outbox.patch(second.id, {
    status: "awaiting-review",
    transcript: transcriptFor(second.recording.id),
    extracted: { atticRValue: { value: 11, confidence: 1, sourceSpan: "R-11" } },
  });

  // A plain `probe()` cannot pin "not one render later": `rerender()` wraps
  // React's commit in `act()`, which drains every effect-triggered render
  // before its promise resolves, so by the time an `await`ed rerender returns,
  // a broken effect-based reset has already had its extra render and looks
  // identical to the correct synchronous guard. So this component instead
  // records the decision `useReview` reports on EVERY render for the second
  // item -- the guard resets it on the very first one; an effect-based reset
  // would report the stale "edited" decision on that first entry and only fix
  // it on a second, which this history makes visible even after `act()` has
  // long since settled.
  const seen: { current: UseReviewResult | undefined } = { current: undefined };
  const seenForSecond: FieldDecision[] = [];
  function Probe({ subject }: { subject: OutboxItem | undefined }) {
    const result = useReview(subject, { valuesSchema, outbox });
    seen.current = result;
    if (subject?.id === parkedSecond.id) {
      seenForSecond.push(result.decisionOf("atticRValue")!);
    }
    return null;
  }

  const screen = await render(<Probe subject={first} />);
  seen.current!.edit("atticRValue", "thirty");
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("atticRValue")).toMatchObject({ status: "edited" }),
  );
  await expect(seen.current!.submit()).rejects.toThrow();
  await vi.waitFor(() => expect(seen.current!.errors.atticRValue).toBeDefined());

  await screen.rerender(<Probe subject={parkedSecond} />);

  // The FIRST render for the new item already saw the reset decision, not a
  // stale one corrected one render later.
  expect(seenForSecond[0]).toEqual({ status: "accepted" });
  expect(seen.current!.decisionOf("atticRValue")).toEqual({ status: "accepted" });
  expect(seen.current!.errors).toEqual({});
  expect(seen.current!.untouched).toContain("atticRValue");
  await outbox.close();
});

test("switching items while a submit is pending does not leak submitting or error onto the next item", async () => {
  // `decisions`/`errors` are not the only per-item state -- `submitting` and
  // `error` used to live in their own, item-blind `useState`s. Reproduces both
  // halves of that leak: (1) the SECOND item's very first render must already
  // show a clean slate while the first item's write is still in flight, and (2)
  // once that stale write finally settles, its completion must not resurrect
  // anything on a card that has since moved on.
  const { outbox, item: first } = await parkedItem();
  const second = await outbox.enqueue({
    recording: recording(),
    audio: new Blob(["x"], { type: "audio/webm" }),
  });
  const parkedSecond = await outbox.patch(second.id, {
    status: "awaiting-review",
    transcript: transcriptFor(second.recording.id),
    extracted: { atticRValue: { value: 11, confidence: 1, sourceSpan: "R-11" } },
  });

  // Held open until the test decides to fail it, so the first item's submit is
  // genuinely still in flight when the card switches to the second item.
  let rejectFirstWrite: (error: Error) => void = () => undefined;
  const pendingWrite = new Promise<OutboxItem>((_, reject) => {
    rejectFirstWrite = reject;
  });
  const submitReviewSpy = vi.spyOn(outbox, "submitReview").mockReturnValueOnce(pendingWrite);

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
  // Give the (incorrect) cross-item write every chance to land before checking
  // it didn't.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(seen.current!.submitting).toBe(false);
  expect(seen.current!.error).toBeUndefined();

  submitReviewSpy.mockRestore();
  await outbox.close();
});

test("a stale operation's completion cannot override a newer one on the same item", async () => {
  // Two submits in flight together for ONE item: `forItem` alone cannot tell
  // them apart, since neither ever changes it. Without a token, the first
  // attempt's completion -- arriving after the second has already succeeded --
  // would report `submitting: false` (masking that the second write, if it were
  // still running, hadn't finished) and, worse, resurrect an error over a review
  // that has already, successfully, gone in.
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);

  let rejectFirstWrite: (error: Error) => void = () => undefined;
  const firstWrite = new Promise<OutboxItem>((_, reject) => {
    rejectFirstWrite = reject;
  });
  const submitReviewSpy = vi.spyOn(outbox, "submitReview").mockReturnValueOnce(firstWrite);

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

  submitReviewSpy.mockRestore();
  await outbox.close();
});

test("a schema change on the same item revalidates a stale error without re-deciding the leaf", async () => {
  // The bulk `errors: {}` clear inside submit() is not redundant with
  // per-decision clearing in every case: `decisions` is keyed by item, not by
  // which `valuesSchema` produced `request`, so a leaf can go from invalid to
  // valid because the SCHEMA loosened between two submits, with its own decision
  // never touched. Per-decision clearing (`setDecision`'s `withoutPath`) never
  // fires in that case, so only the bulk clear can retire the stale message.
  const { outbox, item } = await parkedItem();

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
    seen.current = useReview(item, { valuesSchema: schema, outbox });
    return null;
  }

  const screen = await render(<Probe schema={strictSchema} />);

  seen.current!.edit("atticRValue", "thirty");
  await vi.waitFor(() =>
    expect(seen.current!.decisionOf("atticRValue")).toMatchObject({ status: "edited" }),
  );
  await expect(seen.current!.submit()).rejects.toThrow();
  await vi.waitFor(() => expect(seen.current!.errors.atticRValue).toBeDefined());

  // Same item, same decision ("thirty" is still what's recorded for
  // atticRValue) -- only the field's own schema now accepts a string.
  await screen.rerender(<Probe schema={relaxedSchema} />);

  const outcome = await seen.current!.submit();
  expect(outcome).toMatchObject({ status: "edited", editedFields: ["atticRValue"] });
  await vi.waitFor(() => expect(seen.current!.errors).toEqual({}));
  await outbox.close();
});

test("discarding is terminal and drops the audio", async () => {
  const { outbox, item } = await parkedItem();
  const { seen } = await probe(item, outbox);

  const outcome = await seen.current!.discard("misspoke");
  expect(outcome).toEqual({ status: "discarded", reason: "misspoke" });

  const persisted = await outbox.get(item.id);
  expect(persisted?.status).toBe("discarded");
  expect(persisted?.hasAudio).toBe(false);
  await outbox.close();
});
