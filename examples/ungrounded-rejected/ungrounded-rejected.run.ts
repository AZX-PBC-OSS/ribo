/**
 * The ungrounded-rejected example: a fabricated citation becomes a terminal
 * rejection, never a field value. The provenance guides say ungrounded values
 * cannot pass — this shows the refusal happening, with the census naming the
 * exact leaf that fabricated its quote.
 */

// #region imports
import assert from "node:assert/strict";
import { z } from "zod";
import {
  enveloped,
  FakeExtractor,
  rejectUngroundedCommitments,
  spanGroundedness,
  validateExtractor,
  ValidationRejectedError,
  type ExtractionTarget,
} from "@azx/ribo-core";
// #endregion imports

// #region rejection
const TRANSCRIPT = "The heating system is a gas furnace. The attic insulation is R-38.";

export async function anUngroundedQuoteIsRejectedRatherThanReturned(): Promise<void> {
  const valuesSchema = z.object({
    heating: z.object({
      systemType: z.string().nullable().optional(),
      efficiency: z.number().nullable().optional(),
    }),
  });
  const target: ExtractionTarget<z.infer<typeof valuesSchema>> = {
    name: "heating-target",
    extractionSchema: enveloped(valuesSchema),
    instructions: "extract the heating fields",
  };

  // The fabricated citation, verbatim from a hallucinating model: "80% AFUE"
  // appears nowhere in the transcript — not a case/whitespace/quote-style
  // reformatting of anything, so it grades "ungrounded", the tier the default
  // policy rejects (a near-miss would pass, deliberately).
  assert.equal(spanGroundedness("80% AFUE", TRANSCRIPT), "ungrounded");

  const extractor = validateExtractor(
    new FakeExtractor(
      enveloped(valuesSchema).parse({
        heating: {
          systemType: { value: "gas", confidence: 1, sourceSpan: "gas furnace" },
          efficiency: { value: 0.8, confidence: 1, sourceSpan: "80% AFUE" },
        },
      }),
    ),
    // Named explicitly; it is also the default. Choosing a policy is an import,
    // not a flag.
    { target, policy: rejectUngroundedCommitments },
  );

  let rejected: unknown;
  try {
    await extractor.extract({ text: TRANSCRIPT, annotations: {} });
  } catch (caught) {
    rejected = caught;
  }
  if (!(rejected instanceof ValidationRejectedError)) {
    throw new Error("expected the extraction to be rejected");
  }

  // The rejection is about the fabrication, not the result wholesale: the
  // grounded sibling passes, and the census pins the one ungrounded leaf to its
  // path. The reason line names that path too.
  assert.equal(rejected.census.counts.ungrounded, 1);
  const fabricated = rejected.census.leaves.find((leaf) => leaf.groundedness === "ungrounded");
  assert.ok(fabricated, "the census names the fabricated leaf");
  assert.deepEqual(fabricated.path, ["heating", "efficiency"]);
  assert.equal(fabricated.committed, true);
  assert.equal(fabricated.cited, true);
  assert.match(rejected.reason, /heating\.efficiency/);
}
// #endregion rejection
