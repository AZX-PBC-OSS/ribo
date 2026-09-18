import { describe, expect, test } from "vitest";
import { z } from "zod";

import { enveloped } from "./enveloped.js";
import type { Enveloped } from "./enveloped.js";
import type { AnnotatedTranscript } from "./annotated-transcript.js";
import { assertExactPartition, splitOnBudget } from "./chunk-policy.js";
import type { ChunkPolicy } from "./chunk-policy.js";
import { chunkedExtractor } from "./chunked-extractor.js";
import type { ExtractOptions, Extractor, ExtractionResult, ExtractionTarget } from "./extractor.js";
import type { Extracted } from "./provenance.js";
import { isSpanGrounded } from "./provenance.js";
import { TerminalError } from "./storage/backoff.js";

/**
 * Tests for `chunkedExtractor` — the long-input combinator.
 *
 * The pins that matter most:
 *
 * - **A chunk failure IS the inner error, by identity.** ADR 0002 classifies by *who
 *   failed*, and the inner error already encodes that: a transport failure is transient,
 *   a model producing unparseable output is terminal. Wrapping it in a ChunkFailedError
 *   would erase the classification every `isTransientFailure` and `TerminalError` check
 *   downstream depends on, and turn a terminal failure into a relay retry loop. Pinned
 *   for a `TerminalError` AND a plain `Error`, so a wrapping regression fails on
 *   classification, not just identity.
 * - **The caller's options reach every chunk verbatim.** The deadline is absolute epoch
 *   milliseconds precisely so it survives composition; a future "improvement" that
 *   divides the budget by chunk count fails here.
 * - **Stated-empty claims are dropped on any sighting of a real instance, not on
 *   unanimity.** A single-shot extractor emits no `statedEmptyGroups` at all, so a chunk
 *   roster-ing "no rooms" while another simply finds none must keep the claim — what
 *   makes it honest is the exact partition, not unanimity.
 */

const TRANSCRIPT = [
  "The living room is about two hundred square feet.",
  "The kitchen is one hundred fifty square feet.",
  "The bedroom is one hundred twenty, the bath eighty.",
].join("\n\n");

const transcript: AnnotatedTranscript = { text: TRANSCRIPT, annotations: {} };

/** A two-chunk fixture for the mechanical pins: `["first ", "second"]` partitions it. */
const splitTranscript: AnnotatedTranscript = { text: "first second", annotations: {} };

const valuesSchema = z
  .object({
    rooms: z.array(z.object({ name: z.string().nullable().optional() }).strict()).optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

type Fields = Enveloped<z.infer<typeof valuesSchema>>;

const target: ExtractionTarget<z.infer<typeof valuesSchema>> = {
  name: "test-target",
  extractionSchema: enveloped(valuesSchema),
  instructions: "extract the rooms",
};

const leaf = <const V>(value: V | null, sourceSpan: string | null): Extracted<V> => ({
  value,
  confidence: 1,
  sourceSpan,
});

const room = (name: string | null, span: string | null = name) => ({ name: leaf(name, span) });

/** A chunker returning fixed pieces — the partition check validates them on every run. */
const chunkInto =
  (pieces: readonly string[]): ChunkPolicy =>
  () =>
    pieces;

/** Two chunks partitioning `splitTranscript` exactly. */
const twoChunks = chunkInto(["first ", "second"]);

type ScriptedOutcome = ExtractionResult<Fields> | Error;

/**
 * An extractor returning one queued outcome per call — a result, or an error to reject
 * with — and recording every call, the way `FakeExtractor` records its own.
 */
const scripted = (...outcomes: readonly ScriptedOutcome[]) => {
  const calls: { transcript: AnnotatedTranscript; options: ExtractOptions | undefined }[] = [];
  let index = 0;
  const extractor: Extractor<Fields> = {
    extract: (transcript, options) => {
      calls.push({ transcript, options });
      const outcome = outcomes[index++];
      if (outcome === undefined) {
        return Promise.reject(new Error("the inner extractor was called more times than scripted"));
      }
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve(outcome);
    },
  };
  return { extractor, calls };
};

describe("chunkedExtractor — the pieces put back together", () => {
  test("five rooms across three chunks come back as five, in document order", async () => {
    // End to end through the combinator: the shipped splitter partitions the canonical
    // text, the inner extractor sees each chunk, and the merge concatenates.
    const policy = splitOnBudget(60);
    const chunks = policy(transcript);
    expect(chunks).toHaveLength(3);

    const { extractor, calls } = scripted(
      {
        fields: { rooms: [room("The living room", "The living room")], notes: leaf(null, null) },
        usage: { calls: 1 },
      },
      {
        fields: { rooms: [room("The kitchen"), room("Garage", null)], notes: leaf(null, null) },
        usage: { calls: 1 },
      },
      {
        fields: { rooms: [room("The bedroom"), room("the bath")], notes: leaf(null, null) },
        usage: { calls: 1 },
      },
    );
    const chunked = chunkedExtractor(extractor, { target, chunk: policy });

    const result = await chunked.extract(transcript);

    expect(result.fields.rooms).toHaveLength(5);
    expect(result.fields.rooms.map((r) => r.name.value)).toEqual([
      "The living room",
      "The kitchen",
      "Garage",
      "The bedroom",
      "the bath",
    ]);
    // Each inner call saw one chunk, not the document.
    expect(calls.map((call) => call.transcript.text)).toEqual(chunks);
    // A span quoted from a later chunk grounds against the WHOLE canonical text —
    // grounding is verbatim presence, not occurrence identity.
    expect(isSpanGrounded("The bedroom", TRANSCRIPT)).toBe(true);
  });

  test("a chunker returning a gap throws before any model call", async () => {
    const { extractor, calls } = scripted();
    const chunked = chunkedExtractor(extractor, {
      target,
      chunk: chunkInto(["The living room is about two hundred square feet."]),
    });

    await expect(chunked.extract(transcript)).rejects.toThrow(/stops short/);
    expect(calls).toHaveLength(0);
  });

  test("each chunk receives the original annotations bag, unchanged", async () => {
    const annotations = { "capture.seq": 2, "capture.kind": "audio" as const, "capture.id": "c1" };
    const annotated: AnnotatedTranscript = { text: "first second", annotations };
    // Annotations describe the capture, not the region — a chunk is not a different
    // capture.
    const { extractor, calls } = scripted(
      { fields: { rooms: [], notes: leaf(null, null) }, usage: { calls: 1 } },
      { fields: { rooms: [], notes: leaf(null, null) }, usage: { calls: 1 } },
    );
    const chunked = chunkedExtractor(extractor, {
      target,
      chunk: twoChunks,
    });
    await chunked.extract(annotated);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.transcript.annotations).toBe(annotations);
    expect(calls[1]!.transcript.annotations).toBe(annotations);
  });

  test("the caller's signal and deadline reach every chunk — the deadline unnarrowed", async () => {
    const callerOptions: ExtractOptions = { signal: new AbortController().signal, deadline: 5_000 };
    const { extractor, calls } = scripted(
      { fields: { rooms: [], notes: leaf(null, null) }, usage: { calls: 1 } },
      { fields: { rooms: [], notes: leaf(null, null) }, usage: { calls: 1 } },
    );
    const chunked = chunkedExtractor(extractor, {
      target,
      chunk: twoChunks,
    });
    await chunked.extract(splitTranscript, callerOptions);

    // Verbatim, not a fraction of it, not a narrowed one: every layer passes the same
    // absolute instant down, and a chunk that starts after it has passed is the inner
    // extractor's to reject.
    for (const call of calls) {
      expect(call.options).toBe(callerOptions);
      expect(call.options?.deadline).toBe(5_000);
      expect(call.options?.signal).toBe(callerOptions.signal);
    }
  });
});

describe("chunkedExtractor — a chunk failure fails the whole run", () => {
  test("a TerminalError from a chunk propagates by identity — not a wrapper", async () => {
    const terminal = new TerminalError("the model refused");
    const { extractor } = scripted(
      { fields: { rooms: [], notes: leaf(null, null) }, usage: { calls: 1 } },
      terminal,
    );
    const chunked = chunkedExtractor(extractor, {
      target,
      chunk: twoChunks,
    });

    await expect(chunked.extract(splitTranscript)).rejects.toBe(terminal);
  });

  test("a plain Error from a chunk propagates by identity too", async () => {
    // Pinned separately from the TerminalError: a wrapper that only preserved the
    // familiar class would pass that pin and still erase a foreign transport's error.
    const plain = new Error("transport down");
    const { extractor } = scripted(plain);
    const chunked = chunkedExtractor(extractor, {
      target,
      chunk: twoChunks,
    });

    await expect(chunked.extract(splitTranscript)).rejects.toBe(plain);
  });
});

describe("chunkedExtractor — usage and provenance of the run", () => {
  test("usage sums calls; a token member any chunk omits is absent, not zero", async () => {
    const { extractor } = scripted(
      {
        fields: { rooms: [], notes: leaf(null, null) },
        usage: {
          calls: 2,
          promptTokens: 10,
          completionTokens: 5,
          cachedPromptTokens: 0,
          engine: "managed-azure",
          strategy: "single-shot",
        },
      },
      { fields: { rooms: [], notes: leaf(null, null) }, usage: { calls: 3, promptTokens: 20 } },
    );
    const chunked = chunkedExtractor(extractor, {
      target,
      chunk: twoChunks,
    });

    const result = await chunked.extract(splitTranscript);

    expect(result.usage.calls).toBe(5);
    expect(result.usage.promptTokens).toBe(30);
    // Absent means "not reported", never zero — chunk 1 made no report, so a summed 0
    // would assert the calls all missed cache while describing one run out of two.
    expect("completionTokens" in result.usage).toBe(false);
    expect("cachedPromptTokens" in result.usage).toBe(false);
    // `engine` and `strategy` identify ONE producer; a chunked run has N.
    expect("engine" in result.usage).toBe(false);
    expect("strategy" in result.usage).toBe(false);
  });

  test("raw is dropped even when every chunk carried one", async () => {
    const withRaw: ExtractionResult<Fields> = {
      fields: { rooms: [], notes: leaf(null, null) },
      usage: { calls: 1 },
      raw: "model output",
    };
    const { extractor } = scripted(withRaw, withRaw);
    const chunked = chunkedExtractor(extractor, {
      target,
      chunk: twoChunks,
    });

    const result = await chunked.extract(splitTranscript);

    expect("raw" in result).toBe(false);
  });
});

describe("chunkedExtractor — statedEmptyGroups", () => {
  test("a group any chunk populated loses the claim, even if another stated it empty", async () => {
    const { extractor } = scripted(
      {
        fields: { rooms: [], notes: leaf(null, null) },
        usage: { calls: 1 },
        statedEmptyGroups: { rooms: "No rooms in this region." },
      },
      {
        fields: { rooms: [room("The kitchen")], notes: leaf(null, null) },
        usage: { calls: 1 },
      },
    );
    const chunked = chunkedExtractor(extractor, {
      target,
      chunk: twoChunks,
    });

    const result = await chunked.extract(splitTranscript);

    expect("statedEmptyGroups" in result).toBe(false);
  });

  test("a group no chunk populated and one chunk stated empty keeps that chunk's span", async () => {
    // The pin that distinguishes this from the unanimity rule an earlier draft
    // specified: a single-shot extractor emits no statedEmptyGroups at all, so a chunk
    // roster-ing "no rooms" while another simply finds none must keep the true claim.
    // What makes it honest is the exact partition — no chunk found one, and the chunks
    // ARE the document.
    const { extractor } = scripted(
      {
        fields: { rooms: [], notes: leaf(null, null) },
        usage: { calls: 1 },
        statedEmptyGroups: { rooms: "No rooms were mentioned." },
      },
      { fields: { rooms: [], notes: leaf(null, null) }, usage: { calls: 1 } },
    );
    const chunked = chunkedExtractor(extractor, {
      target,
      chunk: twoChunks,
    });

    const result = await chunked.extract(splitTranscript);

    expect(result.statedEmptyGroups).toEqual({ rooms: "No rooms were mentioned." });
  });

  test("two chunks stating it with different quotes keep the earliest", async () => {
    const { extractor } = scripted(
      {
        fields: { rooms: [], notes: leaf(null, null) },
        usage: { calls: 1 },
        statedEmptyGroups: { rooms: "No rooms up front." },
      },
      {
        fields: { rooms: [], notes: leaf(null, null) },
        usage: { calls: 1 },
        statedEmptyGroups: { rooms: "No rooms later." },
      },
    );
    const chunked = chunkedExtractor(extractor, {
      target,
      chunk: twoChunks,
    });

    const result = await chunked.extract(splitTranscript);

    expect(result.statedEmptyGroups).toEqual({ rooms: "No rooms up front." });
  });
});

describe("chunkedExtractor — construction and the empty transcript", () => {
  test("an empty transcript calls the inner extractor exactly once, on the empty text", async () => {
    // Zero chunks would mean zero calls and a merge with nothing to merge; inventing an
    // all-null result would assert an extraction that never happened. Delegating once
    // preserves whatever the inner extractor already does with empty input — its
    // decision to make, not this wrapper's.
    const empty: AnnotatedTranscript = { text: "", annotations: {} };
    const { extractor, calls } = scripted({
      fields: { rooms: [], notes: leaf(null, null) },
      usage: { calls: 1 },
    });
    const chunked = chunkedExtractor(extractor, {
      target,
      chunk: chunkInto(["this policy is never consulted"]),
    });

    const result = await chunked.extract(empty);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.transcript.text).toBe("");
    expect(result.fields).toEqual({ rooms: [], notes: leaf(null, null) });
  });

  test("a target with a row group throws at construction, before any call", async () => {
    // The merge walks per-leaf envelopes; a "row" group has none, so it would merge
    // nothing while returning a result that looks merged (ADR 0003). The refusal is
    // `assertLeafGranularity`'s — this pins that construction runs it.
    const roomsPatch = z
      .object({
        rooms: z.array(z.object({ name: z.string().nullable().optional() }).strict()).optional(),
      })
      .strict();
    const rowTarget: ExtractionTarget<z.infer<typeof roomsPatch>, { rooms: "row" }> = {
      name: "row-target",
      extractionSchema: enveloped(roomsPatch, { provenance: { rooms: "row" } }),
      instructions: "extract the rooms",
    };

    const inner = new (class implements Extractor<
      Enveloped<z.infer<typeof roomsPatch>, { rooms: "row" }>
    > {
      extract = () => Promise.reject(new Error("never called"));
    })();

    expect(() =>
      chunkedExtractor(inner, {
        target: rowTarget,
        chunk: chunkInto(["anything"]),
      }),
    ).toThrow(/rooms/);
  });
});

describe("chunkedExtractor — the shipped splitter end to end", () => {
  test("splitOnBudget's output passes the partition check the combinator enforces", () => {
    const policy = splitOnBudget(60);
    expect(() => assertExactPartition(TRANSCRIPT, policy(transcript))).not.toThrow();
  });
});
