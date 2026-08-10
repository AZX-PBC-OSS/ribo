import {
  buildReviewRequest,
  resolveReview,
  outboxItemSchema,
  toWriteStep,
  transcriptSchema,
} from "@azx/ribo-core";
import type {
  FieldDecision,
  FieldDecisions,
  OutboxItem,
  ToolAdapter,
  Transcript,
  WriteMetadata,
} from "@azx/ribo-core";
import { expect, test } from "vitest";

import { SNUGGPRO_ADAPTER_NAME, snuggProAdapter } from "./adapter.js";
import { snuggCtxSchema, type SnuggWriteContext } from "./context.js";
import { snuggExamples } from "./examples.js";
import { snuggProInstructions } from "./instructions.js";
import { snuggExtractionSchema, snuggValuesSchema, type SnuggValues } from "./schema.js";

/**
 * @file The whole chain, once, on the real Snugg Pro field set.
 *
 * `snuggValuesSchema` → `enveloped()` → the model's response → `buildReviewRequest` →
 * a human's decisions → `resolveReview` → `toWriteStep` → what reaches `write`. Every
 * other test in this repo checks one link; this is the one that runs the chain.
 *
 * ## Why it lives here and not in `ribo-core`
 *
 * Dependencies point inward: `ribo-core` must never import an adapter. Core's own
 * `contracts.test.ts` composes the same pipeline over a four-leaf synthetic field set,
 * which is the right thing for a package that knows no tools. What that cannot do is
 * run the chain over 51 real leaves nested across seven per-endpoint resource groups,
 * with a fixture full of honest `null`s — so that test lives on this side of the
 * boundary, importing core through its public entry point exactly as a consumer would.
 *
 * ## Why the model's response is the committed fixture
 *
 * `snuggExamples[0].fields` is a real extraction of a real dictation, and it is
 * three-quarters `null` — every basedata field but one, all four duct fields, the whole
 * `wall` and `window` groups, eleven of the thirteen health tests. A hand-built,
 * all-non-null draft would run the same functions and prove nothing: the null path is
 * the one an earlier revision of this design got wrong, because "the reviewer accepted
 * a leaf the model had nothing for" and "the reviewer rejected a leaf" produce
 * different patches and the difference is invisible unless the nulls are there.
 *
 * ## Why a stub adapter
 *
 * `snuggProAdapter.write` throws by design — Snugg Pro egress is gated on the Helix
 * HMAC ask — so a round trip through the real adapter could only ever assert that the
 * write failed. {@link stubAdapter} shares the REAL `schema`, `extractionSchema`,
 * `ctxSchema`, `instructions` and `examples` by reference, and replaces only `write`
 * with a sink, so everything under test here is the production article. The first test
 * below pins that identity by reference: a stub that drifted onto a copy of the schema
 * would make every assertion after it meaningless.
 */

// --- The stub adapter -------------------------------------------------------

interface Write {
  fields: SnuggValues;
  ctx: SnuggWriteContext;
  meta: WriteMetadata;
}

const stubAdapter = (sink: Write[]): ToolAdapter<SnuggValues, SnuggWriteContext> => ({
  name: SNUGGPRO_ADAPTER_NAME,
  schema: snuggValuesSchema,
  extractionSchema: snuggExtractionSchema,
  ctxSchema: snuggCtxSchema,
  instructions: snuggProInstructions,
  examples: snuggExamples,
  write: async (fields, ctx, meta) => {
    sink.push({ fields, ctx, meta });
  },
});

test("the stub shares the real adapter's schemas — only `write` differs", () => {
  const stub = stubAdapter([]);

  // By reference, not by shape: a structural comparison would pass against a copy,
  // and a copy is exactly what would make this file stop testing production code.
  expect(stub.schema).toBe(snuggProAdapter.schema);
  expect(stub.extractionSchema).toBe(snuggProAdapter.extractionSchema);
  expect(stub.ctxSchema).toBe(snuggProAdapter.ctxSchema);
  expect(stub.name).toBe(snuggProAdapter.name);
  // And the real one still refuses to write, which is why the stub exists.
  expect(snuggProAdapter.write).not.toBe(stub.write);
});

// --- The capture, the model's response, and the queue item ------------------

const example = snuggExamples[0];
if (!example) throw new Error("expected the Snugg Pro adapter to carry a few-shot example");

const transcript: Transcript = transcriptSchema.parse({
  recordingId: "rec-delgado-basement",
  text: example.transcript,
  engine: "ondevice-whisper",
});

const ctx: SnuggWriteContext = {
  assessmentId: "assessment-4821",
  companyId: "company-77",
  apiBaseUrl: "https://helix.example.com/snuggpro",
};

const item: OutboxItem = outboxItemSchema.parse({
  id: "item-1",
  seq: 0,
  status: "writing",
  // Every committed row names its canonical audio attachment.
  canonicalAttachmentId: "audio",
  idempotencyKey: "idem-item-1",
  attempts: 0,
  nextAttemptAt: "2026-07-23T14:00:00.000Z",
  enqueuedAt: "2026-07-23T14:00:00.000Z",
  recording: {
    id: transcript.recordingId,
    capturedAt: "2026-07-23T14:02:00.000Z",
    durationMs: 96_000,
    mimeType: "audio/webm;codecs=opus",
    ctx,
  },
  audioReady: false,
  audioBytes: 0,
});

/**
 * The model's response, through the trust boundary it really crosses.
 *
 * The fixture is typed `SnuggExtraction`, so handing it straight to
 * `buildReviewRequest` would skip the parse a real extractor performs — and it is that
 * parse which guarantees the shape `enveloped()` derived, including the health matrix
 * arriving as eleven envelopes rather than one.
 */
const extracted: Record<string, unknown> = snuggExtractionSchema.parse(example.fields);

/** The leaf every human-edit assertion below is about, and its two values. */
const EDITED_LEAF = "health.healthGasLeak";
const MODEL_VALUE = "Passed";
const HUMAN_VALUE = "Warning";

/** Accept all 51 leaves, then apply the given overrides. */
const decide = (
  paths: readonly string[],
  overrides: Readonly<Record<string, FieldDecision>> = {},
): FieldDecisions =>
  Object.fromEntries(
    paths.map((path) => [path, overrides[path] ?? { status: "accepted" as const }]),
  );

/** Every leaf of a nested patch as a dotted path — the shape review addresses. */
const flatten = (value: Record<string, unknown>, prefix = ""): string[] =>
  Object.entries(value).flatMap(([key, child]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return child !== null && typeof child === "object"
      ? flatten(child as Record<string, unknown>, path)
      : [path];
  });

// --- The round trip ---------------------------------------------------------

test("the real field set round-trips: schema → extraction → review → write", async () => {
  const written: Write[] = [];
  const adapter = stubAdapter(written);

  // 1. Review is built off `adapter.schema` — the PATCH — which is what enumerates the
  //    leaves. Passing the adapter's own member is also the compile-time proof of R1.5's
  //    narrowing: this line did not typecheck while `schema` was a bare `ZodType<V>`.
  const request = buildReviewRequest(extracted, transcript, adapter.schema);
  const paths = Object.keys(request.fields);

  // 51 leaves across seven resource groups, each independently reviewable.
  expect(paths).toHaveLength(51);
  expect(paths).toContain(EDITED_LEAF);
  expect(request.fields[EDITED_LEAF]?.extracted.value).toBe(MODEL_VALUE);

  // 2. The human accepts everything, and corrects one leaf INSIDE the nested matrix —
  //    the case a review keyed on top-level fields could not express at all.
  const outcome = resolveReview(request, {
    status: "submitted",
    decisions: decide(paths, { [EDITED_LEAF]: { status: "edited", value: HUMAN_VALUE } }),
  });

  if (outcome.status !== "edited")
    throw new Error(`expected an edited outcome, got ${outcome.status}`);
  expect(outcome.editedFields).toEqual([EDITED_LEAF]);
  expect(outcome.rejectedFields).toEqual([]);

  // 3. The write step is the trust boundary: it parses the ctx off THIS item's recording
  //    and the patch through the adapter's schema before anything reaches `write`.
  await toWriteStep(adapter)({
    item,
    reviewed: outcome.fields,
    idempotencyKey: item.idempotencyKey,
  });

  expect(written).toHaveLength(1);
  const write = written[0]!;

  // THE assertion. The edited leaf arrives in its NESTED position carrying the human's
  // value — not the model's, and not at a dotted key. Everything R1.5 changed is
  // upstream of this one line: split the schemas, address leaves by path, validate at
  // submit, reassemble the nesting, parse at the boundary.
  expect(write.fields.health?.healthGasLeak).toBe(HUMAN_VALUE);
  expect(write.fields.health?.healthGasLeak).not.toBe(MODEL_VALUE);
  // No dotted key survived the reassembly.
  expect(Object.keys(write.fields)).not.toContain(EDITED_LEAF);

  // Its neighbours in the same matrix are untouched: the other affirmative result is
  // still the model's, and a test the auditor never mentioned is a present `null`.
  expect(write.fields.health?.healthDraftPressure).toBe("Passed");
  expect(write.fields.health?.healthAsbestos).toBeNull();

  // The honest nulls the fixture is full of survive as WRITTEN nulls — Snugg Pro's
  // `Not Tested` — because the human accepted them. This is the path an earlier revision
  // of this design got wrong.
  expect("hvacCoolingCapacity" in (write.fields.hvac ?? {})).toBe(true);
  expect(write.fields.hvac?.hvacCoolingCapacity).toBeNull();
  expect(write.fields.hvac?.hvacDuctLocation).toBeNull();
  expect(write.fields.hvac?.hvacDuctLeakage).toBeNull();

  // Values the model did extract come through as themselves, parsed — the fuel axis
  // split across two fields, and every enum member a literal Snugg Pro wire string.
  expect(write.fields.hvac?.hvacSystemEquipmentType).toBe("Boiler");
  expect(write.fields.hvac?.hvacHeatingEnergySource).toBe("Fuel Oil");
  expect(write.fields.hvac?.hvacHeatingSystemModelYear).toBe(2004);
  expect(write.fields.attic?.atticInsulationDepth).toBe("4-6");
  expect(write.fields.dhw?.dhwType2).toBe("Sidearm Tank");

  // Nothing is missing: accepting all 51 leaves writes all 51.
  expect(flatten(write.fields).sort()).toEqual([...paths].sort());

  // The destination came off THIS item's recording, and the idempotency key off the queue.
  expect(write.ctx).toEqual(ctx);
  expect(write.meta).toEqual({ idempotencyKey: "idem-item-1" });
});

test("one rejected leaf of the 51 still writes the other 50", async () => {
  // The test that proves patch semantics, and the one an earlier revision of this design
  // would have failed outright: rejecting a leaf must leave that field alone in Snugg
  // Pro, not fail the write and not blank the field.
  const written: Write[] = [];
  const adapter = stubAdapter(written);
  const rejected = "health.healthAsbestos";

  const request = buildReviewRequest(extracted, transcript, adapter.schema);
  const paths = Object.keys(request.fields);
  const outcome = resolveReview(request, {
    status: "submitted",
    decisions: decide(paths, { [rejected]: { status: "rejected" } }),
  });

  if (outcome.status !== "edited") {
    throw new Error(`expected an edited outcome, got ${outcome.status}`);
  }
  expect(outcome.rejectedFields).toEqual([rejected]);

  await toWriteStep(adapter)({
    item,
    reviewed: outcome.fields,
    idempotencyKey: item.idempotencyKey,
  });

  // The write SUCCEEDED — the rejection did not take the other 50 leaves down with it.
  expect(written).toHaveLength(1);
  const fields = written[0]!.fields;

  // Absent, not null. Absent means "leave the host tool alone"; the whole patch model
  // rests on that being distinguishable, and `in` is what distinguishes it —
  // `fields.healthSafety?.asbestos` reads `undefined` either way.
  expect("healthAsbestos" in fields.health!).toBe(false);
  // Every other leaf is present, including the thirteen surviving health fields.
  expect(flatten(fields).sort()).toEqual(paths.filter((path) => path !== rejected).sort());
  expect(Object.keys(fields.health!)).toHaveLength(13);

  // The neighbouring case, in the same patch: an accepted `null` is PRESENT and null.
  // Snugg Pro has no null, so the write layer renders both this and the absent leaf
  // above as `Not Tested` — but only one of them is an instruction to write anything,
  // and collapsing the two would silently overwrite a field the reviewer refused to
  // touch.
  expect("healthLead" in fields.health!).toBe(true);
  expect(fields.health!.healthLead).toBeNull();
  expect("hvacCoolingCapacity" in fields.hvac!).toBe(true);
  expect(fields.hvac!.hvacCoolingCapacity).toBeNull();
});
