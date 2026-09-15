import { enveloped, groupedExtractor } from "@azx/ribo-core";
import type { Enveloped, ExtractionTarget, GroupMap } from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import type { ChatClient, ChatRequest } from "./chat-client.js";
import { gapFillExtractor } from "./gap-fill.js";
import { overrideGroups, perGroupPlan } from "./per-group.js";
import type { PerGroupPlan } from "./per-group.js";
import { singleShotExtractor } from "./single-shot.js";

/**
 * Key-free tests for the composition plan's Task 12 — `perGroupPlan` and
 * `overrideGroups`, the two exported steps the `perGroupExtractor` preset is
 * built from (`per-group-composition-design.md` §4.3).
 *
 * The preset's own behaviour — byte-identical requests, partitioning, progress
 * units, retry budget — is gated by the unchanged `per-group.test.ts` suite, the
 * adapter's `per-group-cap.test.ts` and the frozen JSON Schema fixture. What is
 * pinned here is the capability Task 12 exists to provide: a host takes the
 * plan's defaults for every group and replaces or wraps ONE group — per piece,
 * so a partitioned group's override applies to every piece — without
 * constructing the other nineteen by hand. The running example is the design's:
 * the defaults everywhere, except `health` also gets gap-fill and
 * `componentLoads` goes to a cheaper model.
 */

// --- Fixture: three groups, one of them partitioned ---------------------------

const leaf = () => z.string().nullable().optional();

/**
 * `health` carries ten enveloped leaves = 20 nullable unions, over the default
 * 16-union cap, so the default split PARTITIONS it into two pieces sharing the
 * key — the case a bare `{ ...plan.groups, health: … }` spread cannot override.
 * `componentLoads` and `attic` are under the cap: one entry each.
 */
const patch = z
  .object({
    health: z
      .object({
        h1: leaf(),
        h2: leaf(),
        h3: leaf(),
        h4: leaf(),
        h5: leaf(),
        h6: leaf(),
        h7: leaf(),
        h8: leaf(),
        h9: leaf(),
        h10: leaf(),
      })
      .strict()
      .optional(),
    componentLoads: z.object({ c1: leaf(), c2: leaf() }).strict().optional(),
    attic: z.object({ a1: leaf(), a2: leaf() }).strict().optional(),
  })
  .strict();

const extraction = enveloped(patch);
type Values = z.infer<typeof patch>;
type Fields = Enveloped<Values>;

const envelope = (value: string, span: string) => ({
  value,
  confidence: 0.9,
  sourceSpan: span,
});

const target: ExtractionTarget<Values> = {
  name: "demo",
  extractionSchema: extraction,
  instructions: "Extract the fields.",
  examples: [],
};

const healthPiece = (from: number, to: number): Record<string, unknown> => ({
  health: Object.fromEntries(
    Array.from({ length: to - from + 1 }, (_, i) => [
      `h${from + i}`,
      envelope(`v${from + i}`, "s"),
    ]),
  ),
});

const componentLoadsResponse = {
  componentLoads: { c1: envelope("pv-1", "s"), c2: envelope("pv-2", "s") },
};
const atticResponse = { attic: { a1: envelope("blown", "s"), a2: envelope("R-38", "s") } };

/** A ChatClient that records every request and replays a canned response per schema name. */
function fakeChat(responses: Record<string, string>): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: {
      complete: (request) => {
        requests.push(request);
        const name = request.response_format.json_schema.name;
        return Promise.resolve({ content: responses[name] ?? "{}", finishReason: "stop" });
      },
    },
  };
}

const planGroups = <V extends Record<string, unknown>, P>(
  plan: PerGroupPlan<V, P>,
): Record<string, unknown> => plan.groups;
const planTargets = <V extends Record<string, unknown>, P>(
  plan: PerGroupPlan<V, P>,
): Record<string, unknown> => plan.targets;

// --- The plan -----------------------------------------------------------------

describe("perGroupPlan — the derived plan", () => {
  test("one default entry per group — and one per piece for a group the cap partitions", () => {
    const plan = perGroupPlan({ target, chat: fakeChat({}).chat, model: "m" });
    const groups = planGroups(plan);

    // The map is exhaustive over the schema's top-level keys — a missing group
    // is a compile error at the spread site, and `groupedExtractor`'s coverage
    // check throws for a JS caller.
    expect(Object.keys(groups).sort()).toEqual(["attic", "componentLoads", "health"]);

    // `health` is partitioned: two pieces sharing the key.
    expect(Array.isArray(groups.health)).toBe(true);
    expect(groups.health as unknown[]).toHaveLength(2);
    // The under-cap groups are single extractors.
    for (const key of ["componentLoads", "attic"]) {
      expect(typeof (groups[key] as { extract: unknown }).extract).toBe("function");
    }
  });

  test("targets mirrors groups key for key and index for index, each named for its request", () => {
    const plan = perGroupPlan({ target, chat: fakeChat({}).chat, model: "m" });
    const targets = planTargets(plan);

    const healthTargets = targets.health as readonly ExtractionTarget<Pick<Values, "health">>[];
    expect(healthTargets.map((t) => t.name)).toEqual(["demo-health-0", "demo-health-1"]);
    expect((targets.componentLoads as ExtractionTarget<Pick<Values, "componentLoads">>).name).toBe(
      "demo-componentLoads",
    );
    expect((targets.attic as ExtractionTarget<Pick<Values, "attic">>).name).toBe("demo-attic");

    // Each projected schema is the piece's one-key strict object: health's
    // pieces carry their own leaf subsets (5 + 5), the others the whole group.
    const healthSchema = (t: ExtractionTarget<Pick<Values, "health">>): Record<string, unknown> =>
      ((t.extractionSchema as unknown as z.ZodObject).shape.health as z.ZodObject).shape;
    expect(
      Object.keys((healthTargets[0]!.extractionSchema as unknown as z.ZodObject).shape),
    ).toEqual(["health"]);
    expect(Object.keys(healthSchema(healthTargets[0]!))).toEqual(["h1", "h2", "h3", "h4", "h5"]);
    expect(Object.keys(healthSchema(healthTargets[1]!))).toEqual(["h6", "h7", "h8", "h9", "h10"]);

    const atticTarget = targets.attic as ExtractionTarget<Pick<Values, "attic">>;
    expect(
      Object.keys(
        ((atticTarget.extractionSchema as unknown as z.ZodObject).shape.attic as z.ZodObject)
          .shape as Record<string, unknown>,
      ),
    ).toEqual(["a1", "a2"]);
  });

  test("without groupInstructions, each entry target carries the target's full instructions and unprojected examples", () => {
    // The subtlety that keeps the preset's requests byte-identical: with no
    // `groupInstructions`, the old `buildGroupMessages` sent the FULL
    // unprojected example to every group call. The plan's entry targets carry
    // those same unprojected examples — reference-equal — while their schemas
    // are still the projected pieces.
    const example = {
      transcript: "t",
      fields: {
        health: healthPiece(1, 10).health,
        componentLoads: componentLoadsResponse.componentLoads,
        attic: atticResponse.attic,
      },
    } as unknown as (typeof target)["examples"] extends infer E
      ? E extends readonly unknown[]
        ? E[number]
        : never
      : never;
    const withExample: ExtractionTarget<Values> = { ...target, examples: [example] };

    const plan = perGroupPlan({ target: withExample, chat: fakeChat({}).chat, model: "m" });
    const targets = planTargets(plan);

    const atticTarget = targets.attic as ExtractionTarget<Pick<Values, "attic">>;
    expect(atticTarget.instructions).toBe(withExample.instructions);
    expect(atticTarget.examples).toBe(withExample.examples);

    // With groupInstructions, the entry target is the projected one: the
    // group's instructions and a one-key example.
    const groupInstructions = (): string => "Group rules.";
    const projected = perGroupPlan({
      target: withExample,
      chat: fakeChat({}).chat,
      model: "m",
      groupInstructions,
    });
    const projectedAttic = planTargets(projected).attic as ExtractionTarget<Pick<Values, "attic">>;
    expect(projectedAttic.instructions).toBe("Group rules.");
    expect(
      Object.keys((projectedAttic.examples?.[0]!.fields as Record<string, unknown>) ?? {}),
    ).toEqual(["attic"]);
  });
});

// --- The overrides ------------------------------------------------------------

describe("overrideGroups — the defaults everywhere except…", () => {
  test("untouched keys are reference-equal to the plan's; the overridden key is replaced", () => {
    const plan = perGroupPlan({ target, chat: fakeChat({}).chat, model: "m" });
    const cheap = fakeChat({});
    const overridden = overrideGroups(plan, {
      componentLoads: (_entry, pieceTarget) =>
        singleShotExtractor({ target: pieceTarget, chat: cheap.chat, model: "cheap" }),
    });

    const groups = planGroups({ groups: overridden, targets: plan.targets });
    const defaults = planGroups(plan);
    expect(groups.attic).toBe(defaults.attic);
    expect(groups.health).toBe(defaults.health);
    expect(groups.componentLoads).not.toBe(defaults.componentLoads);
  });

  test("an override is invoked once per piece with that piece's default extractor and projected target", () => {
    const plan = perGroupPlan({ target, chat: fakeChat({}).chat, model: "m" });
    const defaults = planGroups(plan);
    const defaultTargets = planTargets(plan);

    const calls: Array<[unknown, unknown, number]> = [];
    overrideGroups(plan, {
      health: (entry, pieceTarget, index) => {
        calls.push([entry, pieceTarget, index]);
        return gapFillExtractor({
          base: entry,
          target: pieceTarget,
          chat: fakeChat({}).chat,
          model: "m",
        });
      },
    });

    // `health` is partitioned into two pieces — the override ran per piece, not
    // once for the group and not on the first piece only.
    expect(calls).toHaveLength(2);
    const pieces = defaults.health as unknown[];
    const pieceTargets = defaultTargets.health as unknown[];
    expect(calls[0]![0]).toBe(pieces[0]);
    expect(calls[0]![1]).toBe(pieceTargets[0]);
    expect(calls[0]![2]).toBe(0);
    expect(calls[1]![0]).toBe(pieces[1]);
    expect(calls[1]![1]).toBe(pieceTargets[1]);
    expect(calls[1]![2]).toBe(1);

    // An unpartitioned group's override runs once, at index 0.
    const single: Array<[unknown, unknown, number]> = [];
    overrideGroups(plan, {
      attic: (entry, pieceTarget, index) => {
        single.push([entry, pieceTarget, index]);
        return entry;
      },
    });
    expect(single).toEqual([[defaults.attic, planTargets(plan).attic, 0]]);
  });

  test("an unknown key in the overrides object is a type error, and a runtime throw naming the key for a JS caller", () => {
    const plan = perGroupPlan({ target, chat: fakeChat({}).chat, model: "m" });
    // The directive stays attached on purpose: hoisted so Prettier cannot wrap
    // the call and detach it (composition plan, Global Constraints).
    // @ts-expect-error — the overrides object is keyed by the schema's top-level keys.
    const withGhost = (): GroupMap<Values> => overrideGroups(plan, { ghost: (e: never) => e });
    expect(withGhost).toThrowError(/ghost/);
  });

  test("a plan built from a non-grouped schema has no per-group entries to override", () => {
    const flatPatch = z.object({ rValue: leaf(), area: leaf() }).strict();
    const flatTarget: ExtractionTarget<z.infer<typeof flatPatch>> = {
      name: "demo-flat",
      extractionSchema: enveloped(flatPatch),
      instructions: "Extract.",
      examples: [],
    };
    const plan = perGroupPlan({ target: flatTarget, chat: fakeChat({}).chat, model: "m" });

    // The fallback plan: one whole-schema entry, keyed "".
    expect(Object.keys(planGroups(plan))).toEqual([""]);

    // `rValue` IS a key of the values type, so this typechecks — and the runtime
    // refusal is the only guard: a silent no-op would read as "overridden".
    expect(() => overrideGroups(plan, { rValue: (entry) => entry })).toThrowError(
      /not an object of groups/,
    );
  });
});

// --- The deliverable -----------------------------------------------------------

describe("overrideGroups — the running example", () => {
  test("the preset's defaults everywhere, except health also gets gap-fill and componentLoads goes to a cheaper model", async () => {
    // Three chats, three jobs: the plan's chat serves the defaults (health's
    // main calls and attic), the cheap chat serves the replaced group only, and
    // the gap-fill chat serves the follow-ups the health override may make.
    const planChat = fakeChat({
      "demo-health-0": JSON.stringify(healthPiece(1, 5)),
      "demo-health-1": JSON.stringify(healthPiece(6, 10)),
      "demo-attic": JSON.stringify(atticResponse),
    });
    const cheapChat = fakeChat({
      "demo-componentLoads": JSON.stringify(componentLoadsResponse),
    });
    const gapChat = fakeChat({});

    const plan = perGroupPlan({ target, chat: planChat.chat, model: "m" });
    const extractor = groupedExtractor({
      target,
      groups: overrideGroups(plan, {
        health: (entry, pieceTarget) =>
          gapFillExtractor({ base: entry, target: pieceTarget, chat: gapChat.chat, model: "m" }),
        componentLoads: (_entry, pieceTarget) =>
          singleShotExtractor({ target: pieceTarget, chat: cheapChat.chat, model: "cheap" }),
      }),
    });

    const result = await extractor.extract({ text: "t", annotations: {} });

    // componentLoads was sent ONLY through the override's own chat, with the
    // projected target's name; the plan's chat received none for that key and
    // all of them for every other key. (Pieces run concurrently, so assert the
    // key SET, not the order.)
    expect(cheapChat.requests.map((r) => r.response_format.json_schema.name)).toEqual([
      "demo-componentLoads",
    ]);
    expect(planChat.requests.map((r) => r.response_format.json_schema.name).sort()).toEqual([
      "demo-attic",
      "demo-health-0",
      "demo-health-1",
    ]);
    expect(gapChat.requests).toHaveLength(0);

    // The partitioned group recombined into one complete `health`, the replaced
    // group's fields came from the cheap model, and usage sums what the entries
    // report — the gap-fill's follow-up would be counted too (none ran here).
    for (let i = 1; i <= 10; i++) {
      const key = `h${i}` as keyof Fields["health"];
      expect(result.fields.health[key].value, `health.h${i}`).toBe(`v${i}`);
    }
    expect(result.fields.componentLoads.c1.value).toBe("pv-1");
    expect(result.fields.attic.a2.value).toBe("R-38");
    expect(result.usage.calls).toBe(4);
  });

  test("a partitioned group's gap-fill re-asks exactly the abstained piece's leaves, per piece", async () => {
    // Piece 0 abstains on h3 (null value over a real span — the model found its
    // evidence and did not commit); piece 1 abstains on nothing. Each piece's
    // gap-fill follows up on ITS OWN abstentions against a schema that fits the
    // piece — the reason overrides apply per piece.
    const abstainingPiece = healthPiece(1, 5);
    const health0 = abstainingPiece.health as Record<string, unknown>;
    health0.h3 = { value: null, confidence: 0.9, sourceSpan: "spray foam present" };

    const planChat = fakeChat({
      "demo-health-0": JSON.stringify(abstainingPiece),
      "demo-health-1": JSON.stringify(healthPiece(6, 10)),
      "demo-componentLoads": JSON.stringify(componentLoadsResponse),
      "demo-attic": JSON.stringify(atticResponse),
    });
    const gapChat = fakeChat({
      "demo-health-0-gap-fill": JSON.stringify({
        "health.h3": envelope("closed-cell", "spray foam present"),
      }),
    });

    const plan = perGroupPlan({ target, chat: planChat.chat, model: "m" });
    const extractor = groupedExtractor({
      target,
      groups: overrideGroups(plan, {
        health: (entry, pieceTarget) =>
          gapFillExtractor({ base: entry, target: pieceTarget, chat: gapChat.chat, model: "m" }),
      }),
    });

    const result = await extractor.extract({ text: "t", annotations: {} });

    // Exactly one follow-up — piece 0's — named for the piece, and piece 1 made none.
    expect(gapChat.requests.map((r) => r.response_format.json_schema.name)).toEqual([
      "demo-health-0-gap-fill",
    ]);
    const followUpSchema = gapChat.requests[0]!.response_format.json_schema.schema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(followUpSchema.properties)).toEqual(["health.h3"]);

    // The filled value merged into the recombined whole.
    expect(result.fields.health.h3.value).toBe("closed-cell");
    expect(result.fields.health.h10.value).toBe("v10");
    expect(result.usage.calls).toBe(5);
  });
});
