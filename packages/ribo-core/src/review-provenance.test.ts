import { describe, expect, test } from "vitest";
import { z } from "zod";

import { enveloped } from "./enveloped.js";
import { buildReviewRequest, resolveReview } from "./review.js";
import type { FieldDecisions } from "./review.js";
import type { Transcript } from "./transcript.js";

/**
 * @file How a group that declared coarser provenance presents in review.
 *
 * The product answer, and the one this file pins: a row's citation is SHARED by the row's
 * fields. Every leaf of a `"row"` group is still its own review card with its own verdict —
 * that is what review is for — and every one of them shows the same quote, so the auditor
 * reads the transcript line once and judges the fifteen numbers it justifies against it.
 *
 * The alternative was a new node kind, so a UI could render the citation once per row. It was
 * not taken: `ReviewField` is what every host already renders, `resolveReview` is keyed by leaf
 * path, and a second presentation shape would have to be handled by every UI before any of them
 * could show a row group at all. Sharing the span keeps the contract's surface unchanged.
 */

const valuesSchema = z.object({
  rooms: z
    .array(
      z.object({
        name: z.string().nullable().optional(),
        heatingLoad: z.number().nullable().optional(),
      }),
    )
    .optional(),
  basedata: z.object({ yearBuilt: z.number().nullable().optional() }).optional(),
});

const provenance = { rooms: "row" } as const;

const TEXT = "L1.Bathrm | 47 | 1521 and L1.Kitchen | 812 | 2043, on a house built in seventy-two.";

const transcript: Transcript = { recordingId: "rec-1", text: TEXT, engine: "fake" };

const extracted = {
  rooms: [
    { name: "L1.Bathrm", heatingLoad: 47, sourceSpan: "L1.Bathrm | 47 | 1521" },
    { name: "L1.Kitchen", heatingLoad: 812, sourceSpan: "a line nobody dictated" },
  ],
  basedata: { yearBuilt: { value: 1972, confidence: 1, sourceSpan: "built in seventy-two" } },
};

const request = () => buildReviewRequest(extracted, transcript, valuesSchema, { provenance });

describe("buildReviewRequest — a row group's fields share the row's citation", () => {
  test("every leaf of a row is presented with the row's span", () => {
    const { fields } = request();

    expect(fields["rooms[k1].name"]!.extracted.value).toBe("L1.Bathrm");
    expect(fields["rooms[k1].name"]!.extracted.sourceSpan).toBe("L1.Bathrm | 47 | 1521");
    expect(fields["rooms[k1].heatingLoad"]!.extracted.sourceSpan).toBe("L1.Bathrm | 47 | 1521");
  });

  test("groundedness is the row's, so a fabricated row flags all of its fields", () => {
    const { fields } = request();

    expect(fields["rooms[k1].name"]!.isGrounded).toBe(true);
    expect(fields["rooms[k2].name"]!.isGrounded).toBe(false);
    expect(fields["rooms[k2].heatingLoad"]!.isGrounded).toBe(false);
  });

  test("a row's own sourceSpan is not itself a reviewable leaf", () => {
    // It is derivation output, not a field the adapter's patch declares — so it must not
    // appear as a card the auditor has to decide, and `resolveReview` must not demand one.
    const { fields } = request();

    expect(Object.keys(fields)).toEqual([
      "rooms[k1].name",
      "rooms[k1].heatingLoad",
      "rooms[k2].name",
      "rooms[k2].heatingLoad",
      "basedata.yearBuilt",
    ]);
  });

  test("a group the map does not name still reads its per-leaf envelope", () => {
    const { fields } = request();

    expect(fields["basedata.yearBuilt"]!.extracted).toEqual({
      value: 1972,
      confidence: 1,
      sourceSpan: "built in seventy-two",
    });
  });

  test("a leaf the model omitted from a present row still gets a card", () => {
    const partial = { rooms: [{ name: "L1.Bathrm", sourceSpan: "L1.Bathrm | 47 | 1521" }] };

    const { fields } = buildReviewRequest(partial, transcript, valuesSchema, { provenance });

    expect(fields["rooms[k1].heatingLoad"]!.extracted).toEqual({
      value: null,
      confidence: 0,
      sourceSpan: null,
    });
  });
});

describe("buildReviewRequest — the near-miss tier", () => {
  test("a re-spaced quote from a laid-out document reads as near-miss, not ungrounded", () => {
    // `layoutPageText` pads columns, so a document transcript holds runs of spaces the model
    // reports as one. `isGrounded` stays false — verbatim means verbatim — but a card can now
    // tell that from a citation the model invented.
    const laidOut: Transcript = {
      recordingId: "doc-1",
      text: "Blower door     $       5,250.00\n",
      engine: "pdfjs",
    };

    const { fields } = buildReviewRequest(
      { rooms: [{ name: "Blower door", heatingLoad: null, sourceSpan: "$ 5,250.00" }] },
      laidOut,
      valuesSchema,
      { provenance },
    );

    expect(fields["rooms[k1].name"]!.isGrounded).toBe(false);
    expect(fields["rooms[k1].name"]!.groundedness).toBe("near-miss");
  });

  test("a fabricated quote is still ungrounded", () => {
    const { fields } = request();

    expect(fields["rooms[k2].name"]!.groundedness).toBe("ungrounded");
    expect(fields["rooms[k1].name"]!.groundedness).toBe("grounded");
  });
});

describe('buildReviewRequest — "none" granularity', () => {
  test("fields are presented with no citation, and so as ungrounded", () => {
    const { fields } = buildReviewRequest(
      { rooms: [{ name: "L1.Bathrm", heatingLoad: 47 }], basedata: extracted.basedata },
      transcript,
      valuesSchema,
      { provenance: { rooms: "none" } },
    );

    expect(fields["rooms[k1].name"]!.extracted).toEqual({
      value: "L1.Bathrm",
      confidence: 1,
      sourceSpan: null,
    });
    expect(fields["rooms[k1].name"]!.isGrounded).toBe(false);
  });
});

describe("resolveReview — a row group round-trips into the patch shape", () => {
  const accept = (paths: readonly string[]): FieldDecisions =>
    Object.fromEntries(paths.map((path) => [path, { status: "accepted" } as const]));

  test("accepted plain values reassemble as the nested patch, with no envelope left over", () => {
    const req = request();

    const outcome = resolveReview(req, {
      status: "submitted",
      decisions: accept(Object.keys(req.fields)),
    });

    expect(outcome.status).toBe("accepted");
    expect(outcome.status === "accepted" && outcome.fields).toEqual({
      rooms: [
        { name: "L1.Bathrm", heatingLoad: 47 },
        { name: "L1.Kitchen", heatingLoad: 812 },
      ],
      basedata: { yearBuilt: 1972 },
    });
  });

  test("an edit to one field of a row is still one field's edit", () => {
    const req = request();

    const outcome = resolveReview(req, {
      status: "submitted",
      decisions: {
        ...accept(Object.keys(req.fields)),
        "rooms[k1].heatingLoad": { status: "edited", value: 470 },
      },
    });

    expect(outcome.status === "edited" && outcome.editedFields).toEqual(["rooms[k1].heatingLoad"]);
    expect(
      outcome.status === "edited" &&
        (outcome.fields.rooms as { heatingLoad: number }[])[0]!.heatingLoad,
    ).toBe(470);
  });

  test("the derived extraction schema and the review walk agree on what a row is", () => {
    // The two walks over one values schema must not disagree, which is the whole reason
    // `field-path.ts` exists. Parsing the fixture through the real derivation is what says
    // the data this file feeds review is data the model could actually have produced.
    expect(enveloped(valuesSchema, { provenance }).parse(extracted)).toEqual(extracted);
  });
});
