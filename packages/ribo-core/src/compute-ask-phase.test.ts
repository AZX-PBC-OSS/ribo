import { describe, expect, test } from "vitest";
import { z } from "zod";

import { askPhase } from "./ask-phase.js";
import type { AnnotatedTranscript } from "./annotated-transcript.js";
import { ChatError } from "./chat-client.js";
import type { CapableChatClient } from "./chat-client.js";
import { computePhase } from "./compute-phase.js";
import { enveloped } from "./enveloped.js";
import type { Enveloped, NoProvenance } from "./enveloped.js";
import type { ExtractionTarget } from "./extractor.js";
import type { DeepPartial } from "./phase-draft.js";
import { demandNote, noteKey } from "./phase-notes.js";
import type { NoteKey } from "./phase-notes.js";
import type { PhaseDraft } from "./phase-draft.js";
import type { Phase } from "./phase.js";
import { phasedExtractor } from "./phased-extractor.js";
import { SchemaParseError } from "./schema-parse-error.js";
import { isTransientFailure } from "./storage/backoff.js";
import { fakeChat } from "./test-support/fake-chat.js";

/**
 * Tests for `computePhase` and `askPhase` — the caller-owned kinds: a
 * deterministic fold between model passes, and one model call against the
 * caller's own schema, result type and note key.
 *
 * This file contains no `as` cast, and none may be added. The caller-side type
 * flow is the subject: every pin below is either a type-equality assertion or a
 * `@ts-expect-error`, so a wrong implementation fails to compile rather than
 * merely failing at runtime (phase.ts's rule, applied where it matters most).
 */

// A small hand-written patch V, the same shape the engine suite uses — no
// adapter imports, no model.
const testValuesSchema = z.object({ note: z.string().nullable().optional() });
type TestValues = z.infer<typeof testValuesSchema>;

const target: ExtractionTarget<TestValues> = {
  name: "test-target",
  extractionSchema: enveloped(testValuesSchema),
  instructions: "extract the note",
};

const transcript: AnnotatedTranscript = { text: "the attic is drafty", annotations: {} };

// The caller's question: schema, answer type and note key, all declared HERE —
// the way a host's own would be. Nothing is imported for them.
const answerSchema = z.object({ verdict: z.string() });
type Answer = z.infer<typeof answerSchema>;
const answerKey: NoteKey<Answer> = noteKey("test-answer");

// Type equality, not assignability — the phase-draft.test.ts idiom. A widened
// or cast-bridged type stays assignable to `unknown`; it is not EQUAL to it.
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** A complete, valid envelope for the one leaf — what the closing parse needs to pass. */
function noteFields(value: string): DeepPartial<Enveloped<TestValues, NoProvenance>> {
  return { note: { value, confidence: 1, sourceSpan: null } };
}

describe("computePhase and askPhase — the composition", () => {
  test("an ask writes its parsed answer under a caller's note key, and a compute folds it in", async () => {
    const { chat, requests } = fakeChat(() => JSON.stringify({ verdict: "drafty windows" }));
    const ask = askPhase<TestValues>()({
      schema: answerSchema,
      chat,
      model: "test-model",
      messages: (_draft, ctx) => [
        { role: "system", content: "What did the transcript say, in one word?" },
        { role: "user", content: ctx.transcript.text },
      ],
      noteKey: answerKey,
    });
    const compute = computePhase<TestValues>({
      // The fold reads the note back AT THE ANSWER'S TYPE. `verdict` exists
      // only on `Answer`, so an implementation that widened the value to
      // `unknown` fails to compile here, not at runtime.
      // `demandNote`, the spelling `phase-notes.ts` prescribes where the writer's
      // plan is never empty — which the ask's is. A guarded `get` would make a
      // mis-ordered list an all-null run caught only by the closing parse.
      fold: (draft) => {
        const answer = demandNote(draft.notes, answerKey, "compute", "ask");
        return {
          ...draft,
          fields: { note: { value: answer.verdict, confidence: 1, sourceSpan: null } },
        };
      },
      requires: ["ask"],
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [ask, compute] });

    const result = await extractor.extract(transcript);

    expect(requests).toHaveLength(1);
    expect(result.fields.note?.value).toBe("drafty windows");
  });

  test("the answer's type flows from the schema through the key, the fold and the read with no cast", async () => {
    const { chat } = fakeChat(() => JSON.stringify({ verdict: "typed" }));
    const pins: boolean[] = [];
    const ask = askPhase<TestValues>()({
      schema: answerSchema,
      chat,
      model: "test-model",
      messages: () => [{ role: "system", content: "ask" }],
      // The fold sink: the value arrives at the schema's own type — pinned by
      // the equality assertion inside, and by writing it back under the key,
      // which refuses a mismatched type (the brand is invariant).
      fold: (draft, value) => {
        const exact: Eq<typeof value, Answer> = true;
        pins.push(exact);
        return { ...draft, notes: draft.notes.set(answerKey, value) };
      },
    });
    const compute = computePhase<TestValues>({
      fold: (draft) => {
        const answer = draft.notes.get(answerKey);
        // Equality, not assignability: the read through the caller's key is
        // `Answer | undefined`, never `unknown | undefined`.
        const exact: Eq<typeof answer, Answer | undefined> = true;
        pins.push(exact);
        if (answer === undefined) return draft;
        return {
          ...draft,
          fields: { note: { value: answer.verdict, confidence: 1, sourceSpan: null } },
        };
      },
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [ask, compute] });

    const result = await extractor.extract(transcript);

    expect(pins).toEqual([true, true]);
    expect(result.fields.note?.value).toBe("typed");
  });

  test("widening the answer type is refused at the call site — the brand is invariant", () => {
    const { chat } = fakeChat(() => "{}");
    const widened = (): Phase<TestValues> =>
      askPhase<TestValues, NoProvenance>()<unknown>({
        schema: answerSchema,
        chat,
        model: "test-model",
        messages: () => [],
        // @ts-expect-error — the brand is invariant: a `NoteKey<Answer>` must not satisfy
        // a `NoteKey<unknown>` slot. If it ever does, a widened implementation compiles
        // and the failure moves from the caller to runtime.
        noteKey: answerKey,
      });
    void widened;
  });

  test("supplying both sinks, or neither, is refused at the call site", () => {
    const { chat } = fakeChat(() => "{}");
    const base = { schema: answerSchema, chat, model: "test-model", messages: () => [] };
    const both = (): Phase<TestValues> =>
      // @ts-expect-error — exactly one of `noteKey` and `fold` is the contract, held by
      // `never` partners in the options union. A regression to two independent optional
      // members would compile this and silently prefer one in `merge`, which only the
      // runtime guard would catch — and only for callers it can see.
      askPhase<TestValues, NoProvenance>()<Answer>({
        ...base,
        noteKey: answerKey,
        fold: (draft: PhaseDraft<TestValues>) => draft,
      });
    const neither = (): Phase<TestValues> =>
      // @ts-expect-error — and neither sink is equally refused: an ask whose answer goes
      // nowhere is a call paid for and thrown away.
      askPhase<TestValues, NoProvenance>()<Answer>({ ...base });
    void both;
    void neither;
  });
});

describe("computePhase", () => {
  test("makes no model call and reports no usage", async () => {
    const { chat, requests } = fakeChat(() => JSON.stringify({ verdict: "once" }));
    const ask = askPhase<TestValues>()({
      schema: answerSchema,
      chat,
      model: "test-model",
      messages: () => [{ role: "system", content: "ask" }],
      noteKey: answerKey,
    });
    const compute = computePhase<TestValues>({
      fold: (draft) => ({
        ...draft,
        fields: noteFields("folded"),
      }),
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [ask, compute] });

    const result = await extractor.extract(transcript);

    // The ask's single call is the whole run's traffic: the compute phase added
    // neither a request nor a call to the usage.
    expect(requests).toHaveLength(1);
    expect(result.usage.calls).toBe(1);
  });

  test("the marker item is load-bearing: the merge runs and the fold lands in the draft", async () => {
    const compute = computePhase<TestValues>({
      fold: (draft) => ({ ...draft, fields: noteFields("folded") }),
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [compute] });

    const result = await extractor.extract(transcript);

    // If `plan` were "simplified" to return [], the engine would skip `merge`
    // entirely, the fold would never run, and the closing parse would reject
    // the empty fields — this assertion is what fails.
    expect(result.fields.note?.value).toBe("folded");
  });
});

describe("askPhase", () => {
  test("a response that does not satisfy the caller's schema is rejected, transiently", async () => {
    const { chat } = fakeChat(() => JSON.stringify({ verdict: 42 }));
    const ask = askPhase<TestValues>()({
      schema: answerSchema,
      chat,
      model: "test-model",
      messages: () => [{ role: "system", content: "ask" }],
      noteKey: answerKey,
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [ask] });

    const rejection = await extractor.extract(transcript).catch((cause: unknown) => cause);

    // Classified the way the shipped phases classify a schema miss: a
    // SchemaParseError — recognisable, and retryable, because the same request
    // can pass on a re-send.
    expect(rejection).toBeInstanceOf(SchemaParseError);
    expect(isTransientFailure(rejection)).toBe(true);
  });

  test("an aborted signal reaches the chat call", async () => {
    const caller = new AbortController();
    const seen: AbortSignal[] = [];
    const chat: CapableChatClient = {
      engine: "recording-chat",
      capability: () => Promise.resolve({ status: "ready" }),
      complete: async (_request, options) => {
        const signal = options?.signal;
        if (signal === undefined) throw new Error("askPhase forwarded no signal");
        seen.push(signal);
        // Hold the call open until the abort lands, so the signal is observed
        // mid-flight the way a real transport would receive it.
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw ChatError.aborted("the caller stopped this");
      },
    };
    const ask = askPhase<TestValues>()({
      schema: answerSchema,
      chat,
      model: "test-model",
      messages: () => [{ role: "system", content: "ask" }],
      noteKey: answerKey,
    });
    const extractor = phasedExtractor<TestValues>({ target, phases: [ask] });

    const settled = extractor.extract(transcript, { signal: caller.signal });
    setTimeout(() => caller.abort(), 1);
    // The fake throws a cancellation-branded ChatError, which the engine rethrows
    // unchanged (the same propagation the shipped phases' cancellation tests pin).
    await expect(settled).rejects.toBeInstanceOf(ChatError);

    // The pin: the context's combined signal — not a fresh one — reached the call.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.aborted).toBe(true);
  });
});

describe("ordering, checked at construction", () => {
  test("a list naming a later phase is rejected", () => {
    const { chat } = fakeChat(() => "{}");
    expect(() =>
      phasedExtractor<TestValues>({
        target,
        phases: [
          computePhase<TestValues>({ fold: (draft) => draft, requires: ["ask"] }),
          askPhase<TestValues>()({
            schema: answerSchema,
            chat,
            model: "test-model",
            messages: () => [],
            noteKey: answerKey,
          }),
        ],
      }),
    ).toThrow(TypeError);
  });
});
