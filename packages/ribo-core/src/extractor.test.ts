import { expect, test } from "vitest";

import { FakeExtractor, toSessionExtractStep } from "./extractor.js";
import type { Extractor, ExtractionResult } from "./extractor.js";
import type { SessionItem } from "./queue/session-schema.js";
import type { Transcript } from "./transcript.js";

interface AtticFields {
  atticInsulation: string;
}

const transcript: Transcript = {
  recordingId: "rec-1",
  text: "the attic is R-19",
  engine: "fake",
};

// `toSessionExtractStep` reads only `transcript` off its input, never `session`
// or `recordingIds`, so a bare stub is honest here — a real session would just be
// noise the step ignores.
const session = { id: "session-1" } as SessionItem;

// ---------------------------------------------------------------------------
// FakeExtractor — the shipped double
// ---------------------------------------------------------------------------

test("FakeExtractor returns its fixed fields, with no model calls counted and no raw", async () => {
  const extractor = new FakeExtractor<AtticFields>({ atticInsulation: "R-19" });

  const result = await extractor.extract("the attic is R-19");

  expect(result).toEqual({ fields: { atticInsulation: "R-19" }, usage: { calls: 0 } });
  expect(result.raw).toBeUndefined();
});

test("FakeExtractor echoes a configured raw payload and usage back on the result", async () => {
  const extractor = new FakeExtractor<AtticFields>(
    { atticInsulation: "R-19" },
    { raw: { model: "stub", choice: 0 }, usage: { calls: 1 } },
  );

  const result = await extractor.extract("anything");

  expect(result).toEqual({
    fields: { atticInsulation: "R-19" },
    raw: { model: "stub", choice: 0 },
    usage: { calls: 1 },
  });
});

test("FakeExtractor records the transcript text of every call, in order", async () => {
  const extractor = new FakeExtractor<AtticFields>({ atticInsulation: "R-19" });

  await extractor.extract("first");
  await extractor.extract("second");

  expect(extractor.calls).toEqual(["first", "second"]);
});

// ---------------------------------------------------------------------------
// toSessionExtractStep — the collapse onto the relay's injected step
// ---------------------------------------------------------------------------

test("toSessionExtractStep hands the extractor the transcript TEXT, and returns only its fields", async () => {
  const extractor = new FakeExtractor<AtticFields>({ atticInsulation: "R-19" });
  const step = toSessionExtractStep(extractor);

  const result = await step({ session, transcript: transcript.text, recordingIds: ["rec-1"] });

  // The extractor was called with `transcript.text`, not the whole Transcript.
  expect(extractor.calls).toEqual(["the attic is R-19"]);
  // Only `.fields` crosses into the field map — `raw` and the call count stay behind.
  expect(result.fields).toEqual({ atticInsulation: "R-19" });
});

test("toSessionExtractStep adapts any Extractor, not just the fake", async () => {
  const handRolled: Extractor<AtticFields> = {
    extract: (text): Promise<ExtractionResult<AtticFields>> =>
      Promise.resolve({
        fields: { atticInsulation: text.toUpperCase() },
        raw: "discarded",
        usage: { calls: 3 },
      }),
  };
  const step = toSessionExtractStep(handRolled);

  const result = await step({ session, transcript: transcript.text, recordingIds: ["rec-1"] });

  expect(result.fields).toEqual({ atticInsulation: "THE ATTIC IS R-19" });
});

// ---------------------------------------------------------------------------
// Engine provenance — which engine drafted this, carried to where review can see it
// ---------------------------------------------------------------------------

test("toSessionExtractStep passes the extractor's engine through beside the fields", async () => {
  const extractor = new FakeExtractor<AtticFields>(
    { atticInsulation: "R-19" },
    { usage: { calls: 1, engine: "ondevice-prompt-api" } },
  );

  const result = await toSessionExtractStep(extractor)({
    session,
    transcript: transcript.text,
    recordingIds: ["rec-1"],
  });

  expect(result).toEqual({
    fields: { atticInsulation: "R-19" },
    engine: "ondevice-prompt-api",
    usage: { calls: 1, engine: "ondevice-prompt-api" },
  });
});

test("toSessionExtractStep carries the strategy and the token totals, not just the engine", async () => {
  // The step seam used to return `{ fields, engine }` and drop everything else,
  // so the strategy that won a ladder and the prefix-cache counts never reached
  // the session — which is where anyone asking after the fact has to look.
  const extractor = new FakeExtractor<AtticFields>(
    { atticInsulation: "R-19" },
    {
      usage: {
        calls: 8,
        engine: "managed-openai",
        strategy: "tier1",
        promptTokens: 33_024,
        completionTokens: 1_680,
        cachedPromptTokens: 29_600,
        cacheCreationPromptTokens: 0,
      },
    },
  );

  const result = await toSessionExtractStep(extractor)({
    session,
    transcript: transcript.text,
    recordingIds: ["rec-1"],
  });

  expect(result.usage).toEqual({
    calls: 8,
    engine: "managed-openai",
    strategy: "tier1",
    promptTokens: 33_024,
    completionTokens: 1_680,
    cachedPromptTokens: 29_600,
    cacheCreationPromptTokens: 0,
  });
});

test("toSessionExtractStep reports no engine when the extractor does not name one", async () => {
  // The common case, and the one that must keep working: every single-transport
  // extractor in this repo reports `{ calls }` and nothing more. `engine` being
  // optional is what keeps them all compiling.
  const extractor = new FakeExtractor<AtticFields>({ atticInsulation: "R-19" });

  const result = await toSessionExtractStep(extractor)({
    session,
    transcript: transcript.text,
    recordingIds: ["rec-1"],
  });

  expect(result.fields).toEqual({ atticInsulation: "R-19" });
  expect(result.engine).toBeUndefined();
});
