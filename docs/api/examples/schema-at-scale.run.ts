/**
 * The runnable example behind docs/api/schema-at-scale.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: the split and the description are
 * model-free, and the per-group run drives `scriptedChat`.
 */

import assert from "node:assert/strict";
import { z } from "zod";
import {
  describeExtraction,
  deriveExtractionShape,
  enveloped,
  type ExtractionTarget,
  groupedExtractor,
  MAX_NULLABLE_UNIONS_PER_CALL,
  overrideGroups,
  perGroupPlan,
  type ChatRequest,
  type ScriptedChatResponder,
  scriptedChat,
  singleShotExtractor,
  splitExtractionSchema,
} from "@azx/ribo-core";

// Two top-level object groups, one of them over the union cap when the cap is
// forced low — which is what the partitioning test below does.
const patchSchema = z.object({
  attic: z.object({
    rValue: z.number().nullable().optional(),
    hatchSealed: z.enum(["yes", "no"]).nullable().optional(),
    notes: z.string().nullable().optional(),
  }),
  health: z.object({
    ambientCo: z.enum(["passed", "failed"]).nullable().optional(),
    gasLeak: z.enum(["passed", "failed"]).nullable().optional(),
  }),
});

const envelope = (value: unknown, span: string) => ({
  value,
  confidence: 0.9,
  sourceSpan: span,
});

// A describe fixture big enough that the WHOLE schema sits over the shipped
// union cap — five plus four enveloped leaves, twenty unions in all.
const oneLeaf = () => z.string().nullable().optional();
const bigPatchSchema = z.object({
  attic: z.object({ a1: oneLeaf(), a2: oneLeaf(), a3: oneLeaf(), a4: oneLeaf(), a5: oneLeaf() }),
  health: z.object({ h1: oneLeaf(), h2: oneLeaf(), h3: oneLeaf(), h4: oneLeaf() }),
});

/** Dispatch on the structured-output schema name — one chat serving many groups. */
const answering =
  (reply: (schemaName: string) => object): ScriptedChatResponder =>
  (request: ChatRequest) => ({ content: reply(request.responseFormat.json_schema.name) });

export function theSplitGivesOneEntryPerTopLevelGroup(): void {
  // #region usage
  const groups = splitExtractionSchema(patchSchema);
  // #endregion usage

  // One entry per top-level group — the key, and a strict schema carrying
  // exactly that key's leaves.
  assert.deepEqual(
    groups.map((group) => group.key),
    ["attic", "health"],
  );
  assert.equal(groups[0]?.part, undefined);
}

export function aGroupOverTheUnionCapIsPartitionedAcrossPieces(): void {
  // Force the cap down to watch the split partition the group.
  const groups = splitExtractionSchema(patchSchema, { maxNullableUnionsPerGroup: 4 });

  // attic's three nullable leaves carry six unions between them — over the
  // cap — so its pieces share the key and carry their coordinates.
  const attic = groups.filter((group) => group.key === "attic");
  assert.ok(attic.length > 1);
  assert.deepEqual(
    attic.map((group) => group.part),
    attic.map((_group, index) => index),
  );
  assert.ok(attic.every((group) => group.parts === attic.length));
  // health fit under the cap and stayed whole.
  const health = groups.filter((group) => group.key === "health");
  assert.equal(health.length, 1);
  assert.equal(health[0]?.part, undefined);
}

export function describeExtractionReportsBeforeAnythingIsConstructed(): void {
  // Nine enveloped leaves = 18 nullable unions — over the shipped cap — so a
  // model-free dry run reports the grouped path and the per-group call shape
  // `schemaExtractor` would select, without a chat client: none is needed to
  // know what construction would do.
  const report = describeExtraction({ schema: bigPatchSchema });

  assert.equal(report.path, "grouped");
  assert.equal(report.callShape, "per-group");
  assert.equal(report.refusal, undefined);
  assert.deepEqual(
    (report.keys ?? []).map((key) => key.key),
    ["attic", "health"],
  );

  // A flat schema — no top-level group — reports the flat path and names why;
  // and `refusal` is present exactly when the real constructors would throw.
  const flat = describeExtraction({
    schema: z.object({ a: z.string().nullable().optional(), b: z.number().nullable().optional() }),
  });
  assert.equal(flat.path, "flat");
  assert.equal(flat.callShape, "single-shot");
  assert.equal(flat.refusal, undefined);
  assert.equal(flat.flatReason?.kind, "loose-keys");

  // A schema the derivation refuses — here, not an object at all — reports the
  // refusal instead of a split.
  const refused = describeExtraction({ schema: z.array(z.string()) as never });
  assert.equal(refused.refusal?.stage, "derive");
}

export async function thePlanTakesTheDefaultsAndAnOverrideReplacesOneGroup(): Promise<void> {
  // One leaf per group, so a scripted response can carry every leaf whole.
  const planPatch = z.object({
    attic: z.object({ rValue: z.number().nullable().optional() }),
    health: z.object({ gasLeak: z.enum(["passed", "failed"]).nullable().optional() }),
  });
  const target: ExtractionTarget<{
    attic: { rValue: number | null };
    health: { gasLeak: string | null };
  }> = {
    name: "audit",
    extractionSchema: enveloped(planPatch),
    instructions: "Extract the audit fields.",
  };

  // The derived plan: every group runs the same managed preset over the same
  // chat. The scripted answers dispatch on the request's schema name, which
  // carries the group key.
  const plan = perGroupPlan({
    target,
    chat: scriptedChat(
      answering((name) =>
        name.includes("attic")
          ? { attic: { rValue: envelope(null, "no r-value quote") } }
          : { health: { gasLeak: envelope("passed", "gas leak test passed") } },
      ),
    ),
    model: "fake-mini",
  });

  // The override layer replaces ONE group — per piece, so a partitioned
  // group's override applies to every piece — without rebuilding the rest.
  // Here the attic rung goes to a cheaper model.
  const entries = overrideGroups(plan, {
    attic: (_defaultEntry, pieceTarget) =>
      singleShotExtractor({
        target: pieceTarget,
        chat: scriptedChat({
          content: { attic: { rValue: envelope(19, "The attic is R-19") } },
        }),
        model: "cheap-mini",
      }),
  });

  // The entries spread straight into the run-owner combinator.
  const extractor = groupedExtractor({ target, ...entries });
  const result = await extractor.extract({
    text: "The attic is R-19 and the gas leak test passed.",
    annotations: {},
  });

  // The override answered attic; the plan's default answered health.
  assert.equal(result.fields.attic.rValue.value, 19);
  assert.equal(result.fields.health.gasLeak.value, "passed");
  assert.equal(result.usage.calls, 2);
}

export function deriveExtractionShapeAppliesExplicitOperations(): void {
  // The model-free applier: explicit operations in, artifact pair out. The
  // `drop` op removes the leaf from both the derived patch and the extraction
  // schema — the pilot's scoping.
  const shape = deriveExtractionShape(
    z.object({ rValue: z.number().nullable().optional(), noise: z.string().nullable().optional() }),
    { operations: [{ op: "drop", path: "noise" }] },
  );

  // The extraction schema no longer asks the model for the dropped leaf —
  // and the drop removed it from the derived patch too: scoping means the
  // leaf is gone from the whole artifact, both views.
  const extractionKeys = Object.keys(shape.extractionSchema.shape);
  assert.ok(!extractionKeys.includes("noise"));
  const patchKeys = Object.keys(shape.patchSchema.shape);
  assert.deepEqual(patchKeys, ["rValue"]);
}

// #region defaults
export function theDefaultsThePageQuotesComeFromTheSource(): void {
  // The shipped union cap is an exported constant — a source change that moved
  // it fails here. The page quotes the value next to this region.
  assert.equal(MAX_NULLABLE_UNIONS_PER_CALL, 16);
}
// #endregion defaults
