import { describe, expect, test } from "vitest";

import type { Enveloped } from "./enveloped.js";
import type { Extracted } from "./provenance.js";
import type { InstanceMatcher } from "./instance-identity.js";
import { contradictionMatcher } from "./instance-identity.js";
import { firstCommitted, lastCommitted, type MergePolicy } from "./merge-policy.js";
import { mergeChunkResults } from "./merge-chunk-results.js";

/**
 * Tests for `mergeChunkResults` — the chunk merge walk.
 *
 * The headline pins are stated as the bugs they prevent:
 *
 * - **The splice.** A positional implementation (the `mergeGroupPieces` shape) pairs
 *   `rooms[0]` in chunk 0 with `rooms[0]` in chunk 1 — different rooms — and where one
 *   chunk abstains, splices two rooms into one with two verbatim citations from
 *   different parts of the document. Every downstream check passes. The tests below
 *   name that failure in their titles.
 * - **Order.** Chunks arrive in document order, anchors keep first-accepted position,
 *   and new instances append — so the output is global first-mention order, which is
 *   what `buildInstancePositions` establishes and what `LinkTargets` aligns to
 *   index-wise. A merge that reordered instances would silently attach a human's link
 *   decision to a different physical record.
 *
 * **Why the align tests supply their own matcher.** No shipped matcher can exercise the
 * align path, and that is structural rather than a gap: `contradictionMatcher` — the only
 * matcher core ships — never returns `"same"` by design, and core could not ship one that
 * did. With chunks an exact partition, two chunks can never quote the same span, so the
 * one piece of positive evidence core could read does not exist across disjoint regions.
 * Sameness here is host knowledge, always. The concat path is the one every shipped
 * default takes.
 */

const leaf = <const V>(value: V | null, sourceSpan: string | null): Extracted<V> => ({
  value,
  confidence: 1,
  sourceSpan,
});

/**
 * The hand-declared VALUES shape the fixtures imitate — every leaf patch-optional and
 * nullable, the way a real `V` is declared. The walk needs no schema, and neither do
 * these tests: the fixtures are hand-built envelopes, the way model output arrives
 * after parsing.
 */
type Values = {
  rooms?: {
    name?: string | null;
    size?: number | null;
    windows?: (string | null)[];
  }[];
  notes?: string | null;
  // An array of BARE leaves — `enveloped()` derives `z.array(z.string())` to an array
  // of envelopes, so this group exercises the concat case where the elements are not
  // instances at all.
  labels?: (string | null)[];
};

type Fields = Enveloped<Values>;

/**
 * One room instance — a collection element whose leaves are envelopes. `windows` is the
 * nested-array member the absorption tests use; the other tests leave it empty.
 */
const room = (
  name: string | null,
  size: number | null,
  nameSpan = name,
  windows: readonly string[] = [],
) => ({
  name: leaf(name, nameSpan),
  size: leaf(size, size === null ? null : `${size} square feet`),
  windows: windows.map((w) => leaf(w, w)),
});

/** A chunk that never mentions the `notes` leaf — an explicit null envelope. */
const ABSTAINED = leaf<string>(null, null);

/** A host matcher that judges by name — the judgement core itself cannot make. */
const matchByName: InstanceMatcher = (a, b) => {
  const aName = a.leaves.name?.value;
  const bName = b.leaves.name?.value;
  return typeof aName === "string" && aName === bName ? "same" : "unknown";
};

describe("the chunk merge walk — collections concatenate", () => {
  test("five rooms across three chunks come back as five rooms, not two", () => {
    // The headline pin, stated as the bug it prevents: a positional implementation
    // pairs rooms[0] with rooms[0] and rooms[1] with rooms[1] and returns TWO rooms —
    // splicing five real ones into two plausible-but-fabricated composites.
    const chunk0: Fields = { rooms: [room("Living room", 200)], notes: ABSTAINED, labels: [] };
    const chunk1: Fields = {
      rooms: [room("Kitchen", 150), room("Garage", null)],
      notes: ABSTAINED,
      labels: [],
    };
    const chunk2: Fields = {
      rooms: [room("Bedroom", 120), room("Bath", 80)],
      notes: ABSTAINED,
      labels: [],
    };

    const merged = mergeChunkResults([chunk0, chunk1, chunk2], { merge: firstCommitted });
    expect(merged.rooms).toHaveLength(5);
    expect(merged.rooms.map((r) => r.name.value)).toEqual([
      "Living room",
      "Kitchen",
      "Garage",
      "Bedroom",
      "Bath",
    ]);
  });

  test("the splice: a name from chunk 0 and a size from chunk 1 stay two rooms", () => {
    // Chunk 0 commits a room's name and abstains on its size; chunk 1 describes a
    // DIFFERENT room with a size. A positional merge produces one room with chunk 0's
    // name and chunk 1's size — a room that was never described.
    const chunk0: Fields = { rooms: [room("Living room", null)], notes: ABSTAINED, labels: [] };
    const chunk1: Fields = { rooms: [room("Kitchen", 150)], notes: ABSTAINED, labels: [] };

    const merged = mergeChunkResults([chunk0, chunk1], { merge: firstCommitted });
    expect(merged.rooms).toHaveLength(2);
    expect(merged.rooms[0]).toEqual(room("Living room", null));
    expect(merged.rooms[1]).toEqual(room("Kitchen", 150));
  });

  test("an instance never merges with one from the same chunk, even under a matcher", () => {
    // The model saw both instances in one region and distinguished them; that
    // judgement beats ours.
    const chunk0: Fields = {
      rooms: [room("Garage", null), room("Garage", 250)],
      notes: ABSTAINED,
      labels: [],
    };

    const merged = mergeChunkResults([chunk0], {
      merge: firstCommitted,
      alignInstances: matchByName,
    });
    expect(merged.rooms).toHaveLength(2);
  });

  test("arrays of leaf envelopes concatenate too — no positional pairing", () => {
    const chunk0: Fields = {
      rooms: [],
      notes: ABSTAINED,
      labels: [leaf("north", "north label"), leaf(null, null)],
    };
    const chunk1: Fields = { rooms: [], notes: ABSTAINED, labels: [leaf("east", "east label")] };

    const merged = mergeChunkResults([chunk0, chunk1], { merge: firstCommitted });
    expect(merged.labels).toHaveLength(3);
    expect(merged.labels.map((l) => l.value)).toEqual(["north", null, "east"]);
  });
});

describe("scalars and objects", () => {
  test("scalars outside collections merge by policy", () => {
    const chunk0: Fields = {
      rooms: [],
      notes: leaf("first mention", "first mention"),
      labels: [],
    };
    const chunk1: Fields = {
      rooms: [],
      notes: leaf("passing reference", "passing reference"),
      labels: [],
    };

    const first = mergeChunkResults([chunk0, chunk1], { merge: firstCommitted });
    expect(first.notes.value).toBe("first mention");
    const last = mergeChunkResults([chunk0, chunk1], { merge: lastCommitted });
    expect(last.notes.value).toBe("passing reference");
  });

  test("a leaf only one chunk committed survives", () => {
    const chunk0: Fields = { rooms: [], notes: ABSTAINED, labels: [] };
    const chunk1: Fields = { rooms: [], notes: ABSTAINED, labels: [] };
    const chunk2: Fields = { rooms: [], notes: leaf("R-38", "R-38"), labels: [] };

    const merged = mergeChunkResults([chunk0, chunk1, chunk2], { merge: firstCommitted });
    expect(merged.notes).toEqual(leaf("R-38", "R-38"));
  });

  test("an all-null leaf keeps the first sample — a null envelope, citation preserved", () => {
    const abstains = leaf<string>(null, "not going to guess the ACH");
    const chunk0: Fields = { rooms: [], notes: abstains, labels: [] };
    const chunk1: Fields = { rooms: [], notes: leaf<string>(null, null), labels: [] };

    const merged = mergeChunkResults([chunk0, chunk1], { merge: lastCommitted });
    expect(merged.notes).toBe(abstains);
  });

  test("objects present in one chunk and absent in another merge to the union", () => {
    // Real chunks parsed through one `enveloped()` schema carry every key — the walk's
    // union is defensive, exercised here with a hand-shaped cast because the type
    // (correctly) refuses to express a chunk missing a required key.
    const chunk0 = { notes: leaf("noted", "noted") } as Fields;
    const chunk1 = { rooms: [room("Kitchen", 150)] } as unknown as Fields;

    const merged = mergeChunkResults([chunk0, chunk1], { merge: firstCommitted });
    expect(merged.rooms).toHaveLength(1);
    expect(merged.notes.value).toBe("noted");
  });
});

describe("cross-chunk instance alignment — a host-supplied matcher", () => {
  test("a matcher returning the same merges into the earlier anchor, which keeps its index", () => {
    const chunk0: Fields = { rooms: [room("Kitchen", null)], notes: ABSTAINED, labels: [] };
    const chunk1: Fields = {
      rooms: [room("Kitchen", 150), room("Bath", 80)],
      notes: ABSTAINED,
      labels: [],
    };

    const merged = mergeChunkResults([chunk0, chunk1], {
      merge: firstCommitted,
      alignInstances: matchByName,
    });
    expect(merged.rooms).toHaveLength(2);
    // The anchor keeps first-accepted position and its own committed name citation.
    expect(merged.rooms[0]!.name.value).toBe("Kitchen");
    // The incoming instance's committed size fills the anchor's abstention.
    expect(merged.rooms[0]!.size.value).toBe(150);
    expect(merged.rooms[1]!.name.value).toBe("Bath");
  });

  test("an unknown verdict appends", () => {
    const chunk0: Fields = { rooms: [room("Kitchen", 150)], notes: ABSTAINED, labels: [] };
    const chunk1: Fields = { rooms: [room("Kitchen", 150)], notes: ABSTAINED, labels: [] };

    const unknownMatcher: InstanceMatcher = () => "unknown";
    const merged = mergeChunkResults([chunk0, chunk1], {
      merge: firstCommitted,
      alignInstances: unknownMatcher,
    });
    expect(merged.rooms).toHaveLength(2);
  });

  test("a matcher that would match two earlier anchors merges into the first only", () => {
    // Greedy: the FIRST anchor answering "same" absorbs the incoming and stops
    // comparing; a later anchor that would also match is left standing. Under
    // union-find one wrong "same" collapses three instances and makes the outcome
    // depend on comparison order; greedy's worst case is a visible duplicate.
    const chunk0: Fields = {
      rooms: [room("Garage", null), room("Garage", 250)],
      notes: ABSTAINED,
      labels: [],
    };
    const chunk1: Fields = { rooms: [room("Garage", 300)], notes: ABSTAINED, labels: [] };

    const merged = mergeChunkResults([chunk0, chunk1], {
      merge: firstCommitted,
      alignInstances: matchByName,
    });
    expect(merged.rooms).toHaveLength(2);
    // The FIRST anchor absorbed the incoming size; the second stands untouched.
    expect(merged.rooms[0]!.size.value).toBe(300);
    expect(merged.rooms[1]!.size.value).toBe(250);
  });

  test("a nested array inside an absorbed instance concatenates in chunk order", () => {
    // The same rule one level down, with no per-nested-group matcher: pairing nested
    // arrays by index once their parents matched would reintroduce exactly the splice
    // this walk exists to prevent.
    const chunk0: Fields = {
      rooms: [room("Kitchen", null, "Kitchen", ["north window"])],
      notes: ABSTAINED,
      labels: [],
    };
    const chunk1: Fields = {
      rooms: [room("Kitchen", 150, "Kitchen", ["east window"]), room("Bath", 80)],
      notes: ABSTAINED,
      labels: [],
    };

    const merged = mergeChunkResults([chunk0, chunk1], {
      merge: firstCommitted,
      alignInstances: matchByName,
    });
    expect(merged.rooms).toHaveLength(2);
    expect(merged.rooms[0]!.windows.map((w) => w.value)).toEqual(["north window", "east window"]);
  });

  test("output order equals first-mention order — anchors in place, new instances appended", () => {
    const chunk0: Fields = { rooms: [room("A", 1), room("B", 2)], notes: ABSTAINED, labels: [] };
    const chunk1: Fields = { rooms: [room("A", 1), room("C", 3)], notes: ABSTAINED, labels: [] };
    const chunk2: Fields = { rooms: [room("D", 4)], notes: ABSTAINED, labels: [] };

    const merged = mergeChunkResults([chunk0, chunk1, chunk2], {
      merge: firstCommitted,
      alignInstances: matchByName,
    });
    expect(merged.rooms.map((r) => r.name.value)).toEqual(["A", "B", "C", "D"]);
  });

  test("with contradictionMatcher supplied, nothing ever merges — identical to no matcher", () => {
    // The pin that keeps the default honest: contradictionMatcher cannot return "same"
    // (agreement is not identity — two identical furnaces are two records), so supplying
    // it must be observably the concat path.
    const chunk0: Fields = { rooms: [room("Kitchen", null)], notes: ABSTAINED, labels: [] };
    const chunk1: Fields = { rooms: [room("Kitchen", 150)], notes: ABSTAINED, labels: [] };

    const withMatcher = mergeChunkResults([chunk0, chunk1], {
      merge: firstCommitted,
      alignInstances: contradictionMatcher({ rooms: ["name"] }),
    });
    const withoutMatcher = mergeChunkResults([chunk0, chunk1], { merge: firstCommitted });
    expect(withMatcher).toEqual(withoutMatcher);
    expect(withMatcher.rooms).toHaveLength(2);
  });
});

describe("policy misuse", () => {
  test("an out-of-range index from the policy throws, naming the index and path", () => {
    const chunk0: Fields = { rooms: [], notes: leaf("a", "a"), labels: [] };
    const chunk1: Fields = { rooms: [], notes: leaf("b", "b"), labels: [] };
    const runaway: MergePolicy = () => 5;

    const rejection = (): unknown => mergeChunkResults([chunk0, chunk1], { merge: runaway });
    expect(rejection).toThrowError(/5/);
    expect(rejection).toThrowError(/notes/);
  });
});
