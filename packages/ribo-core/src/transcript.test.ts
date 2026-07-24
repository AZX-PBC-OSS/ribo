import { describe, expect, test } from "vitest";
import { transcriptSchema, type Transcript } from "./transcript.js";

const valid = {
  recordingId: "rec_01",
  text: "Attic insulation is R-19 blown cellulose.",
  engine: "ondevice-whisper",
  confidence: 0.87,
};

describe("transcriptSchema", () => {
  test("parses a well-formed transcript", () => {
    const parsed: Transcript = transcriptSchema.parse(valid);

    expect(parsed).toEqual(valid);
  });

  test("round-trips a valid record unchanged", () => {
    const parsed = transcriptSchema.parse(valid);
    const reparsed = transcriptSchema.parse(JSON.parse(JSON.stringify(parsed)));

    expect(reparsed).toEqual(valid);
  });

  test("parses a transcript with no confidence", () => {
    const { confidence: _confidence, ...withoutConfidence } = valid;

    expect(transcriptSchema.parse(withoutConfidence)).toEqual(withoutConfidence);
  });

  test.each(["recordingId", "text", "engine"] as const)(
    "rejects a transcript missing %s",
    (key) => {
      const { [key]: _omitted, ...rest } = valid;

      expect(transcriptSchema.safeParse(rest).success).toBe(false);
    },
  );

  // Engine provenance is REQUIRED, not optional. An optional field would be
  // omitted by exactly the implementation whose fallbacks you most need to see,
  // and "which engine produced this?" would become unanswerable for the queue as
  // a whole — which is the entire point of carrying it.
  test("rejects an empty engine — an unattributed transcript is not acceptable", () => {
    expect(transcriptSchema.safeParse({ ...valid, engine: "" }).success).toBe(false);
  });

  test("rejects an unknown extra key", () => {
    expect(transcriptSchema.safeParse({ ...valid, segments: [] }).success).toBe(false);
  });

  test("rejects an empty recordingId", () => {
    expect(transcriptSchema.safeParse({ ...valid, recordingId: "" }).success).toBe(false);
  });

  test("accepts empty text — silence transcribes to nothing, which is not an error", () => {
    expect(transcriptSchema.safeParse({ ...valid, text: "" }).success).toBe(true);
  });

  test.each([-0.1, 1.1])("rejects a confidence of %s", (confidence) => {
    expect(transcriptSchema.safeParse({ ...valid, confidence }).success).toBe(false);
  });
});
