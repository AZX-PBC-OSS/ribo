import { describe, expect, test } from "vitest";
import { z } from "zod";

import { deriveExtractionShape } from "../extraction/shape/shape-operations.js";
import type { Transcript } from "../capture/transcript.js";
import { buildReviewRequest, resolveReview } from "./review.js";
import type {
  FieldDecision,
  FieldDecisions,
  ReviewField,
  ReviewNode,
  ReviewPlan,
  ReviewRequest,
  ReviewSectionNode,
} from "./review.js";

/**
 * @file The review tree laid out by a plan — `BuildReviewRequestOptions.reviewPlan`.
 *
 * A plan is plain data: the `mapping` and `partitions` off a `DerivedExtractionShape`. Most
 * fixtures derive one with the real derivation, so the pins read against plan data a host
 * actually holds; the stale-plan fixtures hand-write records, which is what a stale plan is.
 */

const transcript: Transcript = {
  recordingId: "rec-1",
  text: "Boiler Gas Keep Heat pump Electric Replace Seattle 1990",
  engine: "test",
};

const hvacElementSchema = z.object({
  hvacSystemEquipmentType: z.string().nullable().optional(),
  hvacHeatingEnergySource: z.string().nullable().optional(),
  hvacUpgradeAction: z.string().nullable().optional(),
});

const treeSchema = z.object({
  rValue: z.number().nullable().optional(),
  healthSafety: z
    .object({
      ambientCo: z.enum(["passed", "failed"]).nullable().optional(),
      gasLeak: z.enum(["passed", "failed"]).nullable().optional(),
    })
    .optional(),
  hvac: z.array(hvacElementSchema).optional(),
});

const treeRequestFor = (extracted: Record<string, unknown>): ReviewRequest =>
  buildReviewRequest(extracted, transcript, treeSchema);

/** Every leaf path the tree reaches, in the order the tree presents them. */
const treeLeafPaths = (nodes: readonly ReviewNode[]): string[] =>
  nodes.flatMap((node) => {
    if (node.kind === "leaf") return [node.path];
    if (node.kind === "object" || node.kind === "section") return treeLeafPaths(node.children);
    return node.instances.flatMap((instance) => treeLeafPaths(instance.children));
  });

/** Every leaf node the tree reaches. */
const treeLeaves = (nodes: readonly ReviewNode[]): Extract<ReviewNode, { kind: "leaf" }>[] =>
  nodes.flatMap((node) => {
    if (node.kind === "leaf") return [node];
    if (node.kind === "object" || node.kind === "section") return treeLeaves(node.children);
    return node.instances.flatMap((instance) => treeLeaves(instance.children));
  });

/** Every section node among `nodes`, in the order the tree presents them. */
const sectionsOf = (nodes: readonly ReviewNode[]): readonly ReviewSectionNode[] =>
  nodes.filter((node): node is ReviewSectionNode => node.kind === "section");

const leaf = (request: ReviewRequest, path: string): ReviewField => {
  const field = request.fields[path];
  if (field === undefined) throw new Error(`no review field at "${path}"`);
  return field;
};

const decisionsFor = (paths: readonly string[]): FieldDecisions =>
  Object.fromEntries(paths.map((path): [string, FieldDecision] => [path, { status: "accepted" }]));

const groupNamed = (request: ReviewRequest, key: string): ReviewNode | undefined =>
  request.tree.find((node) => node.kind !== "section" && node.key === key);

/**
 * The layout's invariants, against the same request built without a plan: every leaf appears
 * in the tree exactly once and is the object `fields` holds, everything but the tree is
 * identical, and `resolveReview` accepts both alike.
 */
const expectLaidOutInvariants = (withPlan: ReviewRequest, withoutPlan: ReviewRequest): void => {
  const leaves = treeLeaves(withPlan.tree);
  expect(leaves.map((leaf) => leaf.path).sort()).toEqual(Object.keys(withPlan.fields).sort());
  for (const leaf of leaves) expect(leaf.field).toBe(withPlan.fields[leaf.path]);
  const { tree: _with, ...restWith } = withPlan;
  const { tree: _without, ...restWithout } = withoutPlan;
  expect(restWith).toEqual(restWithout);
  const decisions = decisionsFor(Object.keys(withPlan.fields));
  expect(resolveReview(withPlan, { status: "submitted", decisions })).toEqual(
    resolveReview(withoutPlan, { status: "submitted", decisions }),
  );
};

const hvacInstance = (equipmentType: string, energySource: string, upgradeAction: string) => ({
  hvacSystemEquipmentType: { value: equipmentType, confidence: 1, sourceSpan: equipmentType },
  hvacHeatingEnergySource: { value: energySource, confidence: 1, sourceSpan: energySource },
  hvacUpgradeAction: { value: upgradeAction, confidence: 1, sourceSpan: upgradeAction },
});

const hvacPartitionPlan = deriveExtractionShape(treeSchema, {
  operations: [
    {
      op: "partition",
      group: "hvac",
      parts: { cooling: ["hvacSystemEquipmentType"], heating: ["hvacHeatingEnergySource"] },
    },
  ],
});

const plannedRequestFor = (
  extracted: Record<string, unknown>,
  reviewPlan: ReviewPlan,
): ReviewRequest => buildReviewRequest(extracted, transcript, treeSchema, { reviewPlan });

const firstInstanceOf = (request: ReviewRequest, key: string) => {
  const group = groupNamed(request, key);
  if (group?.kind !== "collection") throw new Error(`no collection group "${key}" in the tree`);
  const instance = group.instances[0];
  if (instance === undefined) throw new Error(`no instances in collection "${key}"`);
  return instance;
};

describe("buildReviewRequest — a reviewPlan lays the tree out by its partitions", () => {
  test("a partitioned collection's instance presents one labelled section per part, 'Other' last", () => {
    const request = plannedRequestFor(
      { hvac: [hvacInstance("Boiler", "Gas", "Keep")] },
      hvacPartitionPlan,
    );
    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);

    expect(sections.map((section) => section.label)).toEqual(["cooling", "heating", "Other"]);
    expect(sections.map((section) => treeLeafPaths(section.children))).toEqual([
      ["hvac[k1].hvacSystemEquipmentType"],
      ["hvac[k1].hvacHeatingEnergySource"],
      ["hvac[k1].hvacUpgradeAction"],
    ]);
  });

  test("fields within a section follow that part's field-list order, not schema order", () => {
    // The part lists the equipment type second; the schema declares it first.
    // Plan order wins inside the section — the whole point of the option — and
    // the leaf no part names falls to "Other", last.
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: { hvac: { heating: ["hvacHeatingEnergySource", "hvacSystemEquipmentType"] } },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);

    expect(treeLeafPaths(firstInstanceOf(request, "hvac").children)).toEqual([
      "hvac[k1].hvacHeatingEnergySource",
      "hvac[k1].hvacSystemEquipmentType",
      "hvac[k1].hvacUpgradeAction",
    ]);
  });

  test("every instance of a collection gets the same sections, each holding its own leaves", () => {
    const request = plannedRequestFor(
      {
        hvac: [hvacInstance("Boiler", "Gas", "Keep"), hvacInstance("Furnace", "Oil", "Replace")],
      },
      hvacPartitionPlan,
    );
    const hvac = groupNamed(request, "hvac");
    const instances = hvac?.kind === "collection" ? hvac.instances : [];

    expect(instances.map((i) => sectionsOf(i.children).map((s) => s.label))).toEqual([
      ["cooling", "heating", "Other"],
      ["cooling", "heating", "Other"],
    ]);
    expect(instances.map((i) => treeLeafPaths(i.children))).toEqual([
      [
        "hvac[k1].hvacSystemEquipmentType",
        "hvac[k1].hvacHeatingEnergySource",
        "hvac[k1].hvacUpgradeAction",
      ],
      [
        "hvac[k2].hvacSystemEquipmentType",
        "hvac[k2].hvacHeatingEnergySource",
        "hvac[k2].hvacUpgradeAction",
      ],
    ]);
  });

  test("a partition on a singleton object group sections the group's own children", () => {
    const singletonSchema = z.object({
      attic: z.object({
        rValue: z.number().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    });
    const plan = deriveExtractionShape(singletonSchema, {
      operations: [{ op: "partition", group: "attic", parts: { measured: ["rValue"] } }],
    });
    const request = buildReviewRequest(
      {
        attic: {
          rValue: { value: 19, confidence: 1, sourceSpan: "R-19" },
          notes: { value: "tight", confidence: 1, sourceSpan: "tight" },
        },
      },
      transcript,
      singletonSchema,
      { reviewPlan: plan },
    );

    const attic = groupNamed(request, "attic");
    expect(attic?.kind).toBe("object");
    const sections = attic?.kind === "object" ? sectionsOf(attic.children) : [];
    expect(sections.map((s) => s.label)).toEqual(["measured", "Other"]);
    expect(sections.map((s) => treeLeafPaths(s.children))).toEqual([
      ["attic.rValue"],
      ["attic.notes"],
    ]);
  });

  test("a retype is a no-op: the layout is identical with and without one", () => {
    // The closed set retypes a string patch leaf to a number; the layout never
    // reads it — the reviewer edits the real value through the patch schema's
    // type, so a retyped leaf keeps its patch path and its position rules.
    const withRetype = deriveExtractionShape(treeSchema, {
      operations: [
        { op: "retype", path: "hvac.hvacUpgradeAction", to: "number" },
        {
          op: "partition",
          group: "hvac",
          parts: { cooling: ["hvacSystemEquipmentType"], heating: ["hvacHeatingEnergySource"] },
        },
      ],
    });
    const extracted = { hvac: [hvacInstance("Boiler", "Gas", "Keep")] };

    expect(plannedRequestFor(extracted, withRetype).tree).toEqual(
      plannedRequestFor(extracted, hvacPartitionPlan).tree,
    );
  });

  test("a leaf the plan leaves without a mapping entry collects in 'Other' after the remainder's entries", () => {
    // The mapping is empty, so every leaf is unmapped: the cooling part can
    // place nothing and renders none; the remainder's entries lead "Other" in
    // the remainder list's order, the unplaced leaf follows in schema-declaration
    // order — the only order left for a leaf no plan entry speaks about.
    const plan: ReviewPlan = {
      mapping: { leaves: {}, provenance: {} },
      partitions: {
        hvac: {
          cooling: ["hvacSystemEquipmentType"],
          remainder: ["hvacHeatingEnergySource", "hvacUpgradeAction"],
        },
      },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);
    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);

    expect(sections).toHaveLength(1);
    expect(sections[0]!.label).toBe("Other");
    expect(treeLeafPaths(sections[0]!.children)).toEqual([
      "hvac[k1].hvacHeatingEnergySource",
      "hvac[k1].hvacUpgradeAction",
      "hvac[k1].hvacSystemEquipmentType",
    ]);
  });

  test("a non-leaf child of a partitioned group is placed in 'Other' as a whole subtree", () => {
    const nestedSchema = z.object({
      hvac: z
        .array(
          z.object({
            hvacSystemEquipmentType: z.string().nullable().optional(),
            system: z.object({ fuel: z.string().nullable().optional() }).optional(),
          }),
        )
        .optional(),
    });
    const plan = deriveExtractionShape(nestedSchema, {
      operations: [
        { op: "partition", group: "hvac", parts: { cooling: ["hvacSystemEquipmentType"] } },
      ],
    });
    const request = buildReviewRequest(
      {
        hvac: [
          {
            hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
            system: { fuel: { value: "Gas", confidence: 1, sourceSpan: "gas" } },
          },
        ],
      },
      transcript,
      nestedSchema,
      { reviewPlan: plan },
    );

    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);
    expect(sections.map((s) => s.label)).toEqual(["cooling", "Other"]);
    const other = sections[1]!;
    // The subtree is the walk's own object node — patch structure intact.
    expect(other.children.map((child) => child.kind)).toEqual(["object"]);
    expect(other.children.map((child) => treeLeafPaths([child]))).toEqual([
      ["hvac[k1].system.fuel"],
    ]);
  });

  test("an 'Other' section is omitted when nothing falls to it", () => {
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: {
        hvac: {
          cooling: ["hvacSystemEquipmentType"],
          heating: ["hvacHeatingEnergySource", "hvacUpgradeAction"],
        },
      },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);

    expect(sectionsOf(firstInstanceOf(request, "hvac").children).map((s) => s.label)).toEqual([
      "cooling",
      "heating",
    ]);
  });

  test("a part whose fields are all absent from the walked schema renders nothing", () => {
    // "ghost" names no field of the walked group: the entry is ignored and the
    // cooling section renders none. The mapped-but-unlisted leaves sweep into
    // "Other" after the remainder's entry, in schema-declaration order.
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: { hvac: { cooling: ["ghost"], remainder: ["hvacUpgradeAction"] } },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);
    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);

    expect(sections).toHaveLength(1);
    expect(sections[0]!.label).toBe("Other");
    expect(treeLeafPaths(sections[0]!.children)).toEqual([
      "hvac[k1].hvacUpgradeAction",
      "hvac[k1].hvacSystemEquipmentType",
      "hvac[k1].hvacHeatingEnergySource",
    ]);
  });

  test("an integer-like partition label enumerates first, ascending — the record's enumeration order", () => {
    // Specified ECMAScript property order hoists integer-like keys ahead of the
    // record's insertion order; the layout reads that order as the section order
    // rather than repairing it.
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: {
        hvac: {
          cooling: ["hvacSystemEquipmentType"],
          "7": ["hvacUpgradeAction"],
          heating: ["hvacHeatingEnergySource"],
        },
      },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);

    expect(sectionsOf(firstInstanceOf(request, "hvac").children).map((s) => s.label)).toEqual([
      "7",
      "cooling",
      "heating",
    ]);
  });

  test("a stale plan entry naming an unknown group is ignored, the rest of the plan still applying", () => {
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: { ...hvacPartitionPlan.partitions, dhw: { everywhere: ["dhwType2"] } },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);

    expect(sectionsOf(firstInstanceOf(request, "hvac").children).map((s) => s.label)).toEqual([
      "cooling",
      "heating",
      "Other",
    ]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a plan naming only unknown groups degrades to today's layout", () => {
    const plan: ReviewPlan = {
      mapping: { leaves: {}, provenance: {} },
      partitions: { dhw: { everywhere: ["dhwType2"] } },
    };
    const extracted = { rValue: { value: 30, confidence: 1, sourceSpan: "R30" } };

    expect(plannedRequestFor(extracted, plan).tree).toEqual(treeRequestFor(extracted).tree);
  });

  test("a stale plan entry naming an unknown field is ignored, every leaf still appearing exactly once", () => {
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: {
        hvac: {
          cooling: ["hvacSystemEquipmentType", "ghost"],
          heating: ["hvacHeatingEnergySource"],
          remainder: ["hvacUpgradeAction"],
        },
      },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);

    expect(
      sectionsOf(firstInstanceOf(request, "hvac").children).map((s) => treeLeafPaths(s.children)),
    ).toEqual([
      ["hvac[k1].hvacSystemEquipmentType"],
      ["hvac[k1].hvacHeatingEnergySource"],
      ["hvac[k1].hvacUpgradeAction"],
    ]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a leaf inside a section is the same object fields holds, at its unchanged patch path", () => {
    const request = plannedRequestFor(
      { hvac: [hvacInstance("Boiler", "Gas", "Keep")] },
      hvacPartitionPlan,
    );
    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);
    expect(sections.map((s) => s.label)).toEqual(["cooling", "heating", "Other"]);
    const node = sections[0]!.children[0]!;

    expect(node.kind).toBe("leaf");
    expect(node.kind === "leaf" && node.path).toBe("hvac[k1].hvacSystemEquipmentType");
    expect(node.kind === "leaf" && node.field).toBe(
      request.fields["hvac[k1].hvacSystemEquipmentType"],
    );
  });

  test("with a plan, everything but the tree is identical to the no-plan request", () => {
    const extracted = {
      rValue: { value: 30, confidence: 1, sourceSpan: "R30" },
      hvac: [hvacInstance("Boiler", "Gas", "Keep")],
    };
    const withoutPlan = treeRequestFor(extracted);
    const withPlan = plannedRequestFor(extracted, hvacPartitionPlan);

    expect(withPlan.transcript).toBe(withoutPlan.transcript);
    expect(withPlan.existingRecords).toEqual(withoutPlan.existingRecords);
    expect(Object.keys(withPlan.fields)).toEqual(Object.keys(withoutPlan.fields));
    for (const path of Object.keys(withoutPlan.fields)) {
      expect(leaf(withPlan, path)).toEqual(leaf(withoutPlan, path));
    }
  });

  test("resolveReview over a laid-out request classifies identically to the no-plan request", () => {
    const extracted = {
      rValue: { value: 30, confidence: 1, sourceSpan: "R30" },
      hvac: [hvacInstance("Boiler", "Gas", "Keep")],
    };
    const withoutPlan = treeRequestFor(extracted);
    const withPlan = plannedRequestFor(extracted, hvacPartitionPlan);
    const submission = {
      status: "submitted" as const,
      decisions: {
        ...decisionsFor(Object.keys(withoutPlan.fields)),
        rValue: { status: "edited" as const, value: 31 },
        "hvac[k1].hvacUpgradeAction": { status: "rejected" as const },
      },
    };

    expect(resolveReview(withPlan, submission)).toEqual(resolveReview(withoutPlan, submission));
  });

  test("a collection nested under a partitioned group survives in 'Other' and still writes an empty array on resolve", () => {
    const withVentsSchema = z.object({
      hvac: z
        .array(
          z.object({
            hvacSystemEquipmentType: z.string().nullable().optional(),
            vents: z.array(z.object({ size: z.string().nullable().optional() })).optional(),
          }),
        )
        .optional(),
    });
    const plan = deriveExtractionShape(withVentsSchema, {
      operations: [
        { op: "partition", group: "hvac", parts: { cooling: ["hvacSystemEquipmentType"] } },
      ],
    });
    const extracted = {
      hvac: [
        {
          hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
          vents: [],
        },
      ],
    };
    const withoutPlan = buildReviewRequest(extracted, transcript, withVentsSchema);
    const withPlan = buildReviewRequest(extracted, transcript, withVentsSchema, {
      reviewPlan: plan,
    });

    const sections = sectionsOf(firstInstanceOf(withPlan, "hvac").children);
    expect(sections.map((s) => s.label)).toEqual(["cooling", "Other"]);
    const other = sections[1]!;
    expect(other.children.map((child) => child.kind)).toEqual(["collection"]);
    const ventsNoPlan = firstInstanceOf(withoutPlan, "hvac").children.find(
      (n) => n.kind !== "section" && n.key === "vents",
    );
    expect(other.children[0]).toEqual(ventsNoPlan);

    const submission = {
      status: "submitted" as const,
      decisions: decisionsFor(Object.keys(withoutPlan.fields)),
    };
    // `emptyCollectionPaths` must descend through "Other" for the empty write to match.
    expect(resolveReview(withPlan, submission)).toEqual(resolveReview(withoutPlan, submission));
  });

  test("two parts naming one leaf place it exactly once, in the first part in enumeration order", () => {
    // No derivation produces overlapping parts; a stale or hand-built plan can
    // carry them. The degrade is exactly-once: the first part in enumeration
    // order holds the leaf, the second's entry places nothing, and nothing is
    // duplicated or dropped.
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: {
        hvac: {
          cooling: ["hvacSystemEquipmentType"],
          heating: ["hvacSystemEquipmentType", "hvacHeatingEnergySource"],
        },
      },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);
    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);

    expect(sections.map((s) => treeLeafPaths(s.children))).toEqual([
      ["hvac[k1].hvacSystemEquipmentType"],
      ["hvac[k1].hvacHeatingEnergySource"],
      ["hvac[k1].hvacUpgradeAction"],
    ]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a part naming a non-leaf child places nothing — the subtree falls to 'Other'", () => {
    // A partition's parts name direct leaves only, so this is plan data no
    // derivation can produce — a stale or foreign plan's shape. The mapping's
    // second source names the non-leaf child itself, isolating the layout's
    // leaf-kind rule from the mapping-membership one: without it, the object
    // child would pass every other guard and be placed into the section. The
    // degrade: the cooling section renders nothing and is omitted, and the
    // named object child sweeps into "Other" as a whole subtree, patch
    // structure intact.
    const nestedSchema = z.object({
      hvac: z
        .array(
          z.object({
            hvacSystemEquipmentType: z.string().nullable().optional(),
            system: z.object({ fuel: z.string().nullable().optional() }).optional(),
          }),
        )
        .optional(),
    });
    const plan: ReviewPlan = {
      mapping: {
        leaves: {
          "hvac.hvacSystemEquipmentType": { source: "hvac.hvacSystemEquipmentType" },
          "hvac.system": { source: "hvac.system" },
        },
        provenance: {},
      },
      partitions: { hvac: { cooling: ["system"] } },
    };
    const request = buildReviewRequest(
      {
        hvac: [
          {
            hvacSystemEquipmentType: { value: "Boiler", confidence: 1, sourceSpan: "boiler" },
            system: { fuel: { value: "Gas", confidence: 1, sourceSpan: "gas" } },
          },
        ],
      },
      transcript,
      nestedSchema,
      { reviewPlan: plan },
    );

    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);
    expect(sections.map((s) => s.label)).toEqual(["Other"]);
    expect(sections[0]!.children.map((child) => child.kind)).toEqual(["leaf", "object"]);
    expect(sections[0]!.children.map((child) => treeLeafPaths([child]))).toEqual([
      ["hvac[k1].hvacSystemEquipmentType"],
      ["hvac[k1].system.fuel"],
    ]);
  });

  test("a partitioned collection with no instances survives verbatim, its empty write intact", () => {
    // No instances, so no sections — and the collection node the layout spreads
    // must be indistinguishable from the walk's: state, emptyQuote, skip flag.
    // The resolve over it still records "there are none of these".
    const extracted = { hvac: [] };
    const statedEmpty = { hvac: "there's no HVAC in this unit" };
    const withoutPlan = buildReviewRequest(extracted, transcript, treeSchema, {
      statedEmptyGroups: statedEmpty,
    });
    const withPlan = buildReviewRequest(extracted, transcript, treeSchema, {
      reviewPlan: hvacPartitionPlan,
      statedEmptyGroups: statedEmpty,
    });

    expect(groupNamed(withPlan, "hvac")).toEqual(groupNamed(withoutPlan, "hvac"));
    const submission = {
      status: "submitted" as const,
      decisions: decisionsFor(Object.keys(withPlan.fields)),
    };
    const noPlanOutcome = resolveReview(withoutPlan, submission);
    // The empty write fires over the laid-out tree — the walk's collection node
    // survived the layout's spread — and the outcome matches the plain walk's exactly.
    if (noPlanOutcome.status !== "accepted") throw new Error("unreachable");
    expect(noPlanOutcome.fields).toEqual({
      rValue: null,
      healthSafety: { ambientCo: null, gasLeak: null },
      hvac: [],
    });
    expect(resolveReview(withPlan, submission)).toEqual(noPlanOutcome);
  });

  test("a partition naming a nested group is ignored — only top-level groups are examined", () => {
    // `system` exists in the walked schema but under `attic`, not at the top
    // level, and a partition names a top-level group: the entry is stale, and
    // nothing recurses into the nested group's children.
    const nestedSchema = z.object({
      attic: z.object({
        system: z.object({ fuel: z.string().nullable().optional() }).optional(),
      }),
    });
    const plan: ReviewPlan = {
      mapping: { leaves: { "attic.system.fuel": { source: "attic.system.fuel" } }, provenance: {} },
      partitions: { system: { fuel: ["fuel"] } },
    };
    const extracted = {
      attic: { system: { fuel: { value: "Gas", confidence: 1, sourceSpan: "gas" } } },
    };
    const withoutPlan = buildReviewRequest(extracted, transcript, nestedSchema);
    const withPlan = buildReviewRequest(extracted, transcript, nestedSchema, {
      reviewPlan: plan,
    });

    expect(withPlan.tree).toEqual(withoutPlan.tree);
  });

  test("a partitioned collection's skip flags and state survive the layout", () => {
    // The layout re-parents instances' children and spreads the collection
    // node; everything it does not own — state, emptyQuote, the group's and
    // each instance's skip flag — must come through the spread untouched.
    const extracted = { hvac: [hvacInstance("Boiler", "Gas", "Keep")] };
    const skippedItems = [{ phaseId: "fill", key: "hvac", instance: 1, instances: 1 }];
    const withoutPlan = buildReviewRequest(extracted, transcript, treeSchema, { skippedItems });
    const withPlan = buildReviewRequest(extracted, transcript, treeSchema, {
      reviewPlan: hvacPartitionPlan,
      skippedItems,
    });

    const noPlanGroup = groupNamed(withoutPlan, "hvac");
    const laidOutGroup = groupNamed(withPlan, "hvac");
    if (noPlanGroup?.kind !== "collection" || laidOutGroup?.kind !== "collection") {
      throw new Error("unreachable");
    }
    expect(laidOutGroup.skipped).toBe(noPlanGroup.skipped);
    expect(laidOutGroup.state).toBe(noPlanGroup.state);
    expect(laidOutGroup.emptyQuote).toBe(noPlanGroup.emptyQuote);
    expect(laidOutGroup.instances.map((instance) => instance.skipped)).toEqual(
      noPlanGroup.instances.map((instance) => instance.skipped),
    );
    // And the sections are there — the flags survived a layout that happened.
    expect(sectionsOf(firstInstanceOf(withPlan, "hvac").children).map((s) => s.label)).toEqual([
      "cooling",
      "heating",
      "Other",
    ]);
  });

  test("a derived plan whose part is labeled 'Other' still lays out sections with distinct labels", () => {
    // "remainder" is a reserved part label at derivation, but "Other" is not —
    // and the proposer invites short, model-chosen labels, so a part genuinely
    // named "Other" is plan data a host can hold from the derivation itself.
    // The catch-all's label is the same fixed literal, so a part labeled
    // "Other" folds into the catch-all — the plan asserted no topic for those
    // fields, which is what the catch-all holds — rather than emitting a second
    // section no host could tell apart from it.
    const otherPartPlan = deriveExtractionShape(treeSchema, {
      operations: [
        {
          op: "partition",
          group: "hvac",
          parts: { Other: ["hvacSystemEquipmentType"], cooling: ["hvacHeatingEnergySource"] },
        },
      ],
    });
    const request = plannedRequestFor(
      { hvac: [hvacInstance("Boiler", "Gas", "Keep")] },
      otherPartPlan,
    );
    const sections = sectionsOf(firstInstanceOf(request, "hvac").children);
    const labels = sections.map((s) => s.label);

    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(["cooling", "Other"]);
    expect(sections.map((s) => treeLeafPaths(s.children))).toEqual([
      ["hvac[k1].hvacHeatingEnergySource"],
      ["hvac[k1].hvacSystemEquipmentType", "hvac[k1].hvacUpgradeAction"],
    ]);
  });

  test("a partition entry naming a top-level leaf is ignored — no throw, the leaf untouched", () => {
    // A derivation refuses a partition on a top-level leaf, so this is stale
    // plan data. The quiet-degrade contract covers it: the leaf node passes
    // through unsectioned and every leaf still appears exactly once. It is the
    // one top-level node kind no other plan test hands a partition entry to.
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: { ...hvacPartitionPlan.partitions, rValue: { everywhere: ["rValue"] } },
    };
    const extracted = {
      rValue: { value: 30, confidence: 1, sourceSpan: "R30" },
      hvac: [hvacInstance("Boiler", "Gas", "Keep")],
    };
    const request = plannedRequestFor(extracted, plan);

    expect(groupNamed(request, "rValue")?.kind).toBe("leaf");
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a no-topic part's stale entries — one duplicating a placed leaf, one unknown — keep every leaf exactly once", () => {
    // Neither entry is plan data a derivation produces: the remainder holds the
    // fields no part named, so it cannot repeat one, and its entries name real
    // fields. The degrade is exactly-once: the duplicate entry places nothing,
    // the unknown field's entry is ignored, and every leaf appears once.
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: {
        hvac: {
          cooling: ["hvacSystemEquipmentType"],
          heating: ["hvacHeatingEnergySource"],
          remainder: ["hvacSystemEquipmentType", "ghost", "hvacUpgradeAction"],
        },
      },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);

    expect(
      sectionsOf(firstInstanceOf(request, "hvac").children).map((s) => treeLeafPaths(s.children)),
    ).toEqual([
      ["hvac[k1].hvacSystemEquipmentType"],
      ["hvac[k1].hvacHeatingEnergySource"],
      ["hvac[k1].hvacUpgradeAction"],
    ]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a normal part and an 'Other' part naming one leaf — the normal part claims it, exactly once", () => {
    // Overlapping parts are plan data no derivation produces (it refuses a field
    // named twice), so this is stale-plan shape. Two readings exist: the first
    // part in enumeration order claims the leaf (the two-normal-parts rule), or
    // the normal parts claim first and the no-topic parts yield to what is
    // already placed — what the fold's code does, since the catch-all is built
    // after the part loop. The pin is the observable resolution: the leaf sits
    // in the normal part's section, nothing is duplicated or dropped.
    const plan: ReviewPlan = {
      ...hvacPartitionPlan,
      partitions: {
        hvac: {
          Other: ["hvacSystemEquipmentType"],
          cooling: ["hvacSystemEquipmentType"],
        },
      },
    };
    const request = plannedRequestFor({ hvac: [hvacInstance("Boiler", "Gas", "Keep")] }, plan);

    expect(sectionsOf(firstInstanceOf(request, "hvac").children).map((s) => s.label)).toEqual([
      "cooling",
      "Other",
    ]);
    expect(
      sectionsOf(firstInstanceOf(request, "hvac").children).map((s) => treeLeafPaths(s.children)),
    ).toEqual([
      ["hvac[k1].hvacSystemEquipmentType"],
      ["hvac[k1].hvacHeatingEnergySource", "hvac[k1].hvacUpgradeAction"],
    ]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });
});

/* Regroup and nest — the mapping half of the layout.
 *
 * A derived fixture is the primary idiom (the pins read against plan data a host
 * actually holds); the order-rule and degrade fixtures hand-write mapping
 * records — what an out-of-patch-order declaration or a stale entry IS. For a
 * derived plan the mapping enumerates in patch-leaf order, so the
 * enumeration-order pins need hand-written records to be pins at all.
 */

const jobRegroupSchema = z.object({
  job: z.object({
    city: z.string().nullable().optional(),
    zip: z.string().nullable().optional(),
  }),
});

const jobExtracted = {
  job: {
    city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
    zip: { value: "98101", confidence: 1, sourceSpan: "98101" },
  },
};

const jobRegroupPlan = deriveExtractionShape(jobRegroupSchema, {
  operations: [{ op: "regroup", group: "job", moves: { city: "location.city" } }],
});

const nestSchema = z.object({
  poolSize: z.number().nullable().optional(),
  rValue: z.number().nullable().optional(),
});

const nestExtracted = {
  poolSize: { value: 12, confidence: 1, sourceSpan: "twelve" },
  rValue: { value: 30, confidence: 1, sourceSpan: "R30" },
};

const nestPlan = deriveExtractionShape(nestSchema, {
  operations: [{ op: "nest", group: "pool", moves: { poolSize: "size" } }],
});

describe("buildReviewRequest — a reviewPlan lays regrouped and nested fields out by its mapping", () => {
  test("a regroup's extraction-only intermediate renders as a labelled section after the surviving patch children", () => {
    const request = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: jobRegroupPlan,
    });
    const job = groupNamed(request, "job");
    const children = job?.kind === "object" ? job.children : [];

    // The untouched leaf keeps its patch position; the moved leaf's section
    // comes after it — and the leaf inside keeps its patch path and is the
    // very field object `fields` holds.
    expect(treeLeafPaths(children)).toEqual(["job.zip", "job.city"]);
    const sections = sectionsOf(children);
    expect(sections.map((s) => s.label)).toEqual(["location"]);
    const moved = sections[0]!.children[0]!;
    expect(moved.kind === "leaf" && moved.path).toBe("job.city");
    expect(moved.kind === "leaf" && moved.field).toBe(request.fields["job.city"]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("deeper intermediates nest sections", () => {
    const deepPlan = deriveExtractionShape(jobRegroupSchema, {
      operations: [{ op: "regroup", group: "job", moves: { city: "a.b.city" } }],
    });
    const request = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: deepPlan,
    });
    const job = groupNamed(request, "job");
    const sections = job?.kind === "object" ? sectionsOf(job.children) : [];

    expect(sections.map((s) => s.label)).toEqual(["a"]);
    const inner = sectionsOf(sections[0]!.children);
    expect(inner.map((s) => s.label)).toEqual(["b"]);
    expect(treeLeafPaths(inner[0]!.children)).toEqual(["job.city"]);
  });

  test("a leaf regrouped into a position the patch declares as an object joins it — no section", () => {
    const joinSchema = z.object({
      job: z.object({
        city: z.string().nullable().optional(),
        location: z.object({ region: z.string().nullable().optional() }).optional(),
      }),
    });
    const joinPlan = deriveExtractionShape(joinSchema, {
      operations: [{ op: "regroup", group: "job", moves: { city: "location.city" } }],
    });
    const extracted = {
      job: {
        city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
        location: { region: { value: "PNW", confidence: 1, sourceSpan: "PNW" } },
      },
    };
    const request = buildReviewRequest(extracted, transcript, joinSchema, {
      reviewPlan: joinPlan,
    });
    const job = groupNamed(request, "job");
    const children = job?.kind === "object" ? job.children : [];

    // No section anywhere: the moved leaf joined the patch's own object node,
    // appended after the child that kept its patch position.
    expect(sectionsOf(children)).toEqual([]);
    expect(children.map((c) => c.kind)).toEqual(["object"]);
    expect(treeLeafPaths(children)).toEqual(["job.location.region", "job.city"]);
    const joined = children[0]!;
    const moved = joined.kind === "object" ? joined.children[1]! : undefined;
    expect(moved?.kind === "leaf" && moved.path).toBe("job.city");
    expect(moved?.kind === "leaf" && moved.field).toBe(request.fields["job.city"]);
  });

  test("a leaf regrouped out to the group's own level appears after the surviving patch children", () => {
    const flattenSchema = z.object({
      job: z.object({
        keep: z.string().nullable().optional(),
        location: z
          .object({
            city: z.string().nullable().optional(),
            region: z.string().nullable().optional(),
          })
          .optional(),
      }),
    });
    const flattenPlan = deriveExtractionShape(flattenSchema, {
      operations: [{ op: "regroup", group: "job", moves: { "location.city": "city" } }],
    });
    const extracted = {
      job: {
        keep: { value: "kept", confidence: 1, sourceSpan: "kept" },
        location: {
          city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
          region: { value: "PNW", confidence: 1, sourceSpan: "PNW" },
        },
      },
    };
    const request = buildReviewRequest(extracted, transcript, flattenSchema, {
      reviewPlan: flattenPlan,
    });
    const job = groupNamed(request, "job");
    const children = job?.kind === "object" ? job.children : [];

    // The moved leaf does not return to its old position inside `location` —
    // it appends after everything that kept its patch position, the object it
    // left (still at ITS patch position) included.
    expect(children.map((c) => c.kind)).toEqual(["leaf", "object", "leaf"]);
    expect(treeLeafPaths(children)).toEqual([
      "job.keep",
      "job.location.region",
      "job.location.city",
    ]);
  });

  test("within a regroup section, fields follow the mapping's enumeration order", () => {
    // A derived plan enumerates in patch-leaf order, so the pin needs a
    // hand-written mapping: zip's entry is declared first, the schema declares
    // city first — the section shows zip, then city.
    const plan: ReviewPlan = {
      mapping: {
        leaves: {
          "job.location.zip": { source: "job.zip" },
          "job.location.city": { source: "job.city" },
        },
        provenance: {},
      },
      partitions: {},
    };
    const request = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: plan,
    });
    const job = groupNamed(request, "job");
    const sections = job?.kind === "object" ? sectionsOf(job.children) : [];

    expect(sections.map((s) => s.label)).toEqual(["location"]);
    expect(treeLeafPaths(sections[0]!.children)).toEqual(["job.zip", "job.city"]);
  });

  test("a nest's new top-level group renders as a top-level section after the patch's own groups", () => {
    const request = buildReviewRequest(nestExtracted, transcript, nestSchema, {
      reviewPlan: nestPlan,
    });

    expect(treeLeafPaths(request.tree)).toEqual(["rValue", "poolSize"]);
    const sections = sectionsOf(request.tree);
    expect(sections.map((s) => s.label)).toEqual(["pool"]);
    const moved = sections[0]!.children[0]!;
    expect(moved.kind === "leaf" && moved.path).toBe("poolSize");
    expect(moved.kind === "leaf" && moved.field).toBe(request.fields["poolSize"]);
    // The moved leaf left the patch's own top level — it appears in the
    // section, exactly once.
    expect(groupNamed(request, "poolSize")).toBeUndefined();
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a nest group named after the leaf it moves away holds that leaf inside the section", () => {
    // The derivation frees the name: the patch's own top-level leaf `pool` is
    // the very leaf the nest moves, so the extraction-space group `pool` and
    // the patch leaf `pool` coexist only as section label and leaf path.
    const anchorSchema = z.object({
      pool: z.string().nullable().optional(),
      other: z.string().nullable().optional(),
    });
    const anchorPlan = deriveExtractionShape(anchorSchema, {
      operations: [{ op: "nest", group: "pool", moves: { pool: "size" } }],
    });
    const extracted = {
      pool: { value: "yes", confidence: 1, sourceSpan: "a pool" },
      other: { value: "x", confidence: 1, sourceSpan: "x" },
    };
    const request = buildReviewRequest(extracted, transcript, anchorSchema, {
      reviewPlan: anchorPlan,
    });

    expect(treeLeafPaths(request.tree)).toEqual(["other", "pool"]);
    const sections = sectionsOf(request.tree);
    expect(sections.map((s) => s.label)).toEqual(["pool"]);
    const moved = sections[0]!.children[0]!;
    expect(moved.kind === "leaf" && moved.path).toBe("pool");
  });

  test("several nest sections follow the mapping's enumeration order", () => {
    // Enumeration order puts spa first; neither the alphabet (pool) nor the
    // patch's declaration order (poolSize first) does.
    const plan: ReviewPlan = {
      mapping: {
        leaves: {
          "spa.temp": { source: "spaTemp" },
          "pool.size": { source: "poolSize" },
        },
        provenance: {},
      },
      partitions: {},
    };
    const extracted = { ...nestExtracted, spaTemp: { value: 38, confidence: 1, sourceSpan: "38" } };
    const schema = z.object({
      poolSize: z.number().nullable().optional(),
      spaTemp: z.number().nullable().optional(),
      rValue: z.number().nullable().optional(),
    });
    const request = buildReviewRequest(extracted, transcript, schema, { reviewPlan: plan });

    expect(sectionsOf(request.tree).map((s) => s.label)).toEqual(["spa", "pool"]);
    expect(treeLeafPaths(request.tree)).toEqual(["rValue", "spaTemp", "poolSize"]);
  });

  test("a nest destination's deeper intermediates nest sections under the top-level one", () => {
    const deepNestPlan = deriveExtractionShape(nestSchema, {
      operations: [{ op: "nest", group: "pool", moves: { poolSize: "a.size" } }],
    });
    const request = buildReviewRequest(nestExtracted, transcript, nestSchema, {
      reviewPlan: deepNestPlan,
    });

    const sections = sectionsOf(request.tree);
    expect(sections.map((s) => s.label)).toEqual(["pool"]);
    const inner = sectionsOf(sections[0]!.children);
    expect(inner.map((s) => s.label)).toEqual(["a"]);
    expect(treeLeafPaths(inner[0]!.children)).toEqual(["poolSize"]);
  });

  test("a collection under a regrouped group keeps its patch position, verbatim, and still writes empty", () => {
    const ventsSchema = z.object({
      job: z.object({
        city: z.string().nullable().optional(),
        vents: z.array(z.object({ size: z.string().nullable().optional() })).optional(),
      }),
    });
    const ventsPlan = deriveExtractionShape(ventsSchema, {
      operations: [{ op: "regroup", group: "job", moves: { city: "location.city" } }],
    });
    const extracted = {
      job: {
        city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
        vents: [],
      },
    };
    const withoutPlan = buildReviewRequest(extracted, transcript, ventsSchema);
    const withPlan = buildReviewRequest(extracted, transcript, ventsSchema, {
      reviewPlan: ventsPlan,
    });

    const job = groupNamed(withPlan, "job");
    const children = job?.kind === "object" ? job.children : [];
    expect(children.map((c) => c.kind)).toEqual(["collection", "section"]);
    // The collection node the layout re-parented is the walk's own — state,
    // skip flag, instances, everything.
    const noPlanJob = groupNamed(withoutPlan, "job");
    const noPlanVents =
      noPlanJob?.kind === "object"
        ? noPlanJob.children.find((n) => n.kind !== "section" && n.key === "vents")
        : undefined;
    expect(children[0]).toEqual(noPlanVents);

    // And the laid-out tree still writes the empty collection on resolve —
    // identical to the no-plan outcome.
    const submission = {
      status: "submitted" as const,
      decisions: decisionsFor(Object.keys(withoutPlan.fields)),
    };
    expect(resolveReview(withPlan, submission)).toEqual(resolveReview(withoutPlan, submission));
  });

  test("a moved entry whose source names nothing is ignored — no throw, no section, no move", () => {
    const plan: ReviewPlan = {
      mapping: { leaves: { "job.location.city": { source: "ghost.city" } }, provenance: {} },
      partitions: {},
    };
    const withoutPlan = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema);
    const withPlan = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: plan,
    });

    expect(withPlan.tree).toEqual(withoutPlan.tree);
  });

  test("a nest entry whose source names nothing is ignored the same way", () => {
    const plan: ReviewPlan = {
      mapping: { leaves: { "pool.size": { source: "ghost" } }, provenance: {} },
      partitions: {},
    };
    const withoutPlan = buildReviewRequest(nestExtracted, transcript, nestSchema);
    const withPlan = buildReviewRequest(nestExtracted, transcript, nestSchema, {
      reviewPlan: plan,
    });

    expect(withPlan.tree).toEqual(withoutPlan.tree);
  });

  test("a regroup inside a collection's element lays out per instance, each instance getting the section", () => {
    const envelope = (value: string) => ({ value, confidence: 1, sourceSpan: value });
    const collectionSchema = z.object({
      hvac: z
        .array(
          z.object({
            ducts: z
              .object({
                location: z.string().nullable().optional(),
                insulation: z.string().nullable().optional(),
              })
              .optional(),
            fuel: z.string().nullable().optional(),
          }),
        )
        .optional(),
    });
    const plan = deriveExtractionShape(collectionSchema, {
      operations: [
        { op: "regroup", group: "hvac", moves: { "ducts.insulation": "wrap.insulation" } },
      ],
    });
    const instance = (fuel: string) => ({
      ducts: { location: envelope("attic"), insulation: envelope("R-8") },
      fuel: envelope(fuel),
    });
    const extracted = { hvac: [instance("Gas"), instance("Electric")] };
    const withPlan = buildReviewRequest(extracted, transcript, collectionSchema, {
      reviewPlan: plan,
    });

    const hvac = groupNamed(withPlan, "hvac");
    const instances = hvac?.kind === "collection" ? hvac.instances : [];
    expect(instances).toHaveLength(2);
    for (const { key, children } of instances) {
      expect(children.map((c) => (c.kind === "section" ? `section ${c.label}` : c.key))).toEqual([
        "ducts",
        "fuel",
        "section wrap",
      ]);
      expect(treeLeafPaths(children)).toEqual([
        `hvac[${key}].ducts.location`,
        `hvac[${key}].fuel`,
        `hvac[${key}].ducts.insulation`,
      ]);
    }
    expectLaidOutInvariants(withPlan, buildReviewRequest(extracted, transcript, collectionSchema));
  });

  test("two moved entries naming one patch leaf place it exactly once, first in enumeration order", () => {
    // A broken bijection, which no derivation produces: nothing may be duplicated.
    const plan: ReviewPlan = {
      mapping: {
        leaves: {
          "job.location.city": { source: "job.city" },
          "job.where.city": { source: "job.city" },
        },
        provenance: {},
      },
      partitions: {},
    };
    const request = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: plan,
    });

    expect(treeLeafPaths(request.tree)).toEqual(["job.zip", "job.city"]);
    const job = groupNamed(request, "job");
    const sections = job?.kind === "object" ? sectionsOf(job.children) : [];
    expect(sections.map((s) => s.label)).toEqual(["location"]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("partition, regroup and nest compose in one plan, every invariant holding", () => {
    const mixedSchema = z.object({
      rValue: z.number().nullable().optional(),
      job: z.object({
        city: z.string().nullable().optional(),
        zip: z.string().nullable().optional(),
      }),
      hvac: z.array(hvacElementSchema).optional(),
    });
    const mixedPlan = deriveExtractionShape(mixedSchema, {
      operations: [
        { op: "retype", path: "hvac.hvacUpgradeAction", to: "number" },
        { op: "regroup", group: "job", moves: { city: "location.city" } },
        {
          op: "partition",
          group: "hvac",
          parts: { cooling: ["hvacSystemEquipmentType"], heating: ["hvacHeatingEnergySource"] },
        },
        { op: "nest", group: "site", moves: { rValue: "r" } },
      ],
    });
    const extracted = {
      rValue: { value: 30, confidence: 1, sourceSpan: "R30" },
      job: {
        city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
        zip: { value: "98101", confidence: 1, sourceSpan: "98101" },
      },
      hvac: [hvacInstance("Boiler", "Gas", "Keep")],
    };
    const withoutPlan = buildReviewRequest(extracted, transcript, mixedSchema);
    const withPlan = buildReviewRequest(extracted, transcript, mixedSchema, {
      reviewPlan: mixedPlan,
    });

    // Each operation owns its container: the regroup section inside `job`, the
    // partition sections inside every instance, the nest section last — after
    // the patch's own top-level groups.
    expect(sectionsOf(withPlan.tree).map((s) => s.label)).toEqual(["site"]);
    const job = groupNamed(withPlan, "job");
    expect(job?.kind === "object" ? sectionsOf(job.children).map((s) => s.label) : []).toEqual([
      "location",
    ]);
    expect(sectionsOf(firstInstanceOf(withPlan, "hvac").children).map((s) => s.label)).toEqual([
      "cooling",
      "heating",
      "Other",
    ]);
    expect(treeLeafPaths(withPlan.tree)).toEqual([
      "job.zip",
      "job.city",
      "hvac[k1].hvacSystemEquipmentType",
      "hvac[k1].hvacHeatingEnergySource",
      "hvac[k1].hvacUpgradeAction",
      "rValue",
    ]);
    const leafPaths = treeLeafPaths(withPlan.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(withPlan.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);

    // `fields` is identical with and without the plan, order included.
    expect(Object.keys(withPlan.fields)).toEqual(Object.keys(withoutPlan.fields));
    for (const path of Object.keys(withoutPlan.fields)) {
      expect(leaf(withPlan, path)).toEqual(leaf(withoutPlan, path));
    }

    // resolveReview over the laid-out tree classifies identically — edits
    // touching the sections' leaves, not just accepts.
    const submission = {
      status: "submitted" as const,
      decisions: {
        ...decisionsFor(Object.keys(withoutPlan.fields)),
        "job.city": { status: "edited" as const, value: "Tacoma" },
        "hvac[k1].hvacUpgradeAction": { status: "edited" as const, value: "Replace" },
      },
    };
    expect(resolveReview(withPlan, submission)).toEqual(resolveReview(withoutPlan, submission));
  });

  test("a chain that joins the patch's own object and then enters extraction-only space nests the section under the joined object", () => {
    // `location` is real patch structure, `sub` is not: the first segment joins
    // the object node, the second gets a section draft inside it — appended
    // after the surviving patch child, and materialized at depth.
    const plan: ReviewPlan = {
      mapping: { leaves: { "job.location.sub.city": { source: "job.city" } }, provenance: {} },
      partitions: {},
    };
    const joinSchema = z.object({
      job: z.object({
        city: z.string().nullable().optional(),
        location: z.object({ region: z.string().nullable().optional() }).optional(),
      }),
    });
    const extracted = {
      job: {
        city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
        location: { region: { value: "PNW", confidence: 1, sourceSpan: "PNW" } },
      },
    };
    const request = buildReviewRequest(extracted, transcript, joinSchema, { reviewPlan: plan });
    const job = groupNamed(request, "job");
    const location = job?.kind === "object" ? job.children[0] : undefined;

    expect(location?.kind).toBe("object");
    expect(location?.kind === "object" && location.children.map((c) => c.kind)).toEqual([
      "leaf",
      "section",
    ]);
    const sections = location?.kind === "object" ? sectionsOf(location.children) : [];
    expect(sections.map((s) => s.label)).toEqual(["sub"]);
    expect(treeLeafPaths(request.tree)).toEqual(["job.location.region", "job.city"]);
    expect(sectionsOf(request.tree)).toEqual([]);
    const moved = sections[0]!.children[0]!;
    expect(moved.kind === "leaf" && moved.field).toBe(request.fields["job.city"]);
  });

  test("a section draft and a directly placed leaf share one appended list, in the mapping's enumeration order", () => {
    // Both entries append into `job`: the first creates the `where` section,
    // the second places its leaf directly at job's level. The section precedes
    // the leaf only because the mapping declared it first — the shared list
    // takes enumeration order across kinds, not sections-before-leaves.
    const plan: ReviewPlan = {
      mapping: {
        leaves: {
          "job.where.city": { source: "job.city" },
          "job.flat": { source: "job.zip" },
        },
        provenance: {},
      },
      partitions: {},
    };
    const request = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: plan,
    });
    const job = groupNamed(request, "job");
    const children = job?.kind === "object" ? job.children : [];

    expect(children.map((c) => c.kind)).toEqual(["section", "leaf"]);
    expect(treeLeafPaths(children)).toEqual(["job.city", "job.zip"]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a placement chain naming a collection does not join it — it bounces to a top-level section", () => {
    // The placement joins OBJECT nodes only: a collection is opaque, so a chain
    // segment naming one creates a section of that name instead of entering.
    const plan: ReviewPlan = {
      mapping: { leaves: { "hvac.city": { source: "job.city" } }, provenance: {} },
      partitions: {},
    };
    const schema = z.object({
      job: z.object({
        city: z.string().nullable().optional(),
        zip: z.string().nullable().optional(),
      }),
      hvac: z.array(z.object({ size: z.string().nullable().optional() })).optional(),
    });
    const extracted = {
      job: {
        city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
        zip: { value: "98101", confidence: 1, sourceSpan: "98101" },
      },
      hvac: [{ size: { value: "8in", confidence: 1, sourceSpan: "8in" } }],
    };
    const withoutPlan = buildReviewRequest(extracted, transcript, schema);
    const withPlan = buildReviewRequest(extracted, transcript, schema, { reviewPlan: plan });

    expect(sectionsOf(withPlan.tree).map((s) => s.label)).toEqual(["hvac"]);
    expect(treeLeafPaths(withPlan.tree)).toEqual(["job.zip", "hvac[k1].size", "job.city"]);
    const hvac = groupNamed(withPlan, "hvac");
    expect(hvac).toEqual(groupNamed(withoutPlan, "hvac"));
    const leafPaths = treeLeafPaths(withPlan.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(withPlan.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a placement intermediate colliding with a surviving leaf names a section, leaving the leaf where it is", () => {
    // The derivation refuses a nest group shadowing a key that stays; a stale
    // plan violating that degrades deterministically: the surviving leaf keeps
    // its patch position and the placement gets a section of the same name.
    const plan: ReviewPlan = {
      mapping: { leaves: { "rValue.size": { source: "poolSize" } }, provenance: {} },
      partitions: {},
    };
    const request = buildReviewRequest(nestExtracted, transcript, nestSchema, { reviewPlan: plan });

    expect(treeLeafPaths(request.tree)).toEqual(["rValue", "poolSize"]);
    const sections = sectionsOf(request.tree);
    expect(sections.map((s) => s.label)).toEqual(["rValue"]);
    const moved = sections[0]!.children[0]!;
    expect(moved.kind === "leaf" && moved.field).toBe(request.fields["poolSize"]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("two regroups naming the same intermediate give each group its own section", () => {
    // Sections are per container: a shared label in two groups is two sections,
    // each holding only its own group's moved leaf.
    const schema = z.object({
      job: z.object({
        city: z.string().nullable().optional(),
        zip: z.string().nullable().optional(),
      }),
      attic: z.object({
        region: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
      }),
    });
    const plan = deriveExtractionShape(schema, {
      operations: [
        { op: "regroup", group: "job", moves: { city: "location.city" } },
        { op: "regroup", group: "attic", moves: { region: "location.region" } },
      ],
    });
    const extracted = {
      job: {
        city: { value: "Seattle", confidence: 1, sourceSpan: "in Seattle" },
        zip: { value: "98101", confidence: 1, sourceSpan: "98101" },
      },
      attic: {
        region: { value: "PNW", confidence: 1, sourceSpan: "PNW" },
        note: { value: "n", confidence: 1, sourceSpan: "n" },
      },
    };
    const request = buildReviewRequest(extracted, transcript, schema, { reviewPlan: plan });

    const job = groupNamed(request, "job");
    const attic = groupNamed(request, "attic");
    const jobSections = job?.kind === "object" ? sectionsOf(job.children) : [];
    const atticSections = attic?.kind === "object" ? sectionsOf(attic.children) : [];
    expect(jobSections.map((s) => s.label)).toEqual(["location"]);
    expect(atticSections.map((s) => s.label)).toEqual(["location"]);
    expect(treeLeafPaths(jobSections[0]!.children)).toEqual(["job.city"]);
    expect(treeLeafPaths(atticSections[0]!.children)).toEqual(["attic.region"]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("an extraction path with a single segment places its leaf directly at the top level", () => {
    // placementChain's empty-chain boundary: one segment total wraps no
    // intermediate, so the moved leaf appends after the patch's own top-level
    // nodes — the same position a nest section follows, without the section.
    const plan: ReviewPlan = {
      mapping: { leaves: { flat: { source: "job.city" } }, provenance: {} },
      partitions: {},
    };
    const request = buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, {
      reviewPlan: plan,
    });

    expect(sectionsOf(request.tree)).toEqual([]);
    expect(treeLeafPaths(request.tree)).toEqual(["job.zip", "job.city"]);
    const moved = request.tree[1]!;
    expect(moved.kind === "leaf" && moved.path).toBe("job.city");
    expect(moved.kind === "leaf" && moved.field).toBe(request.fields["job.city"]);
    const leafPaths = treeLeafPaths(request.tree);
    expect(new Set(leafPaths)).toEqual(new Set(Object.keys(request.fields)));
    expect(new Set(leafPaths).size).toBe(leafPaths.length);
  });

  test("a regroup that moves a whole object away drops the emptied patch object", () => {
    const emptySchema = z.object({
      job: z.object({
        location: z.object({ city: z.string().nullable().optional() }).optional(),
        year: z.string().nullable().optional(),
      }),
    });
    const plan = deriveExtractionShape(emptySchema, {
      operations: [{ op: "regroup", group: "job", moves: { location: "place" } }],
    });
    const extracted = {
      job: {
        location: { city: { value: "Seattle", confidence: 1, sourceSpan: "Seattle" } },
        year: { value: "1990", confidence: 1, sourceSpan: "1990" },
      },
    };
    const request = buildReviewRequest(extracted, transcript, emptySchema, { reviewPlan: plan });

    const job = groupNamed(request, "job");
    const children = job?.kind === "object" ? job.children : [];
    expect(children.map((c) => (c.kind === "section" ? `section ${c.label}` : c.key))).toEqual([
      "year",
      "section place",
    ]);
    expect(treeLeafPaths(children)).toEqual(["job.year", "job.location.city"]);
    expectLaidOutInvariants(request, buildReviewRequest(extracted, transcript, emptySchema));
  });
  test("a mapping path that is not schema-time fails loudly, on either side, even where nothing moves", () => {
    // No derivation produces these, so they are not a stale plan to degrade on. A malformed
    // destination throws even when its source names nothing.
    const entries: Record<string, { source: string }>[] = [
      { "job..city": { source: "job.city" } },
      { "job.location[": { source: "job.city" } },
      { "job[k1].city": { source: "job.city" } },
      { "": { source: "job.city" } },
      { "job..city": { source: "ghost.city" } },
      { "job.location.city": { source: "job[k1].city" } },
      { "job.location.city": { source: "" } },
      { "": { source: "" } },
    ];
    for (const leaves of entries) {
      const plan: ReviewPlan = { mapping: { leaves, provenance: {} }, partitions: {} };
      expect(() =>
        buildReviewRequest(jobExtracted, transcript, jobRegroupSchema, { reviewPlan: plan }),
      ).toThrow(/not a plain dotted object path|field path "|field key cannot be empty/);
    }
  });
});
