import { expect, test } from "vitest";

import type { NoProvenance } from "./enveloped.js";
import { draftSeededNoteKey } from "./phase-notes.js";
import { phaseBuilder } from "./phase.js";
import type { PhaseMeta } from "./phase.js";
import { validatePhases } from "./validate-phases.js";

// A minimal hand-written V — the validator reads only the metadata, so the values shape
// is irrelevant here; a `type` alias satisfies the Record<string, unknown> constraint.
type TestValues = { readonly note?: string | null | undefined };

const build = phaseBuilder<TestValues, NoProvenance>();

const phase = (id: string, meta: Partial<PhaseMeta> = {}) =>
  build({
    id,
    plan: () => [],
    run: async () => ({ value: 1 }),
    merge: (draft) => draft,
    ...meta,
  });

// One test per rejection, each asserting the throw AND that the message names the
// offending phase id and key/value — a validator whose message does not identify the
// problem is half a validator, and the agentic use (the message is the repair prompt for
// the next model attempt) depends entirely on it.

test("an empty phase list throws", () => {
  expect(() => validatePhases<TestValues>([])).toThrow(TypeError);
  expect(() => validatePhases<TestValues>([])).toThrow(/empty/);
});

test("a duplicate id throws, naming the id", () => {
  const phases = [phase("presence"), phase("span"), phase("presence")];
  expect(() => validatePhases<TestValues>(phases)).toThrow(/presence/);
});

test("a requires key no earlier phase produces throws, naming the phase and the key", () => {
  const fill = phase("fill", { requires: ["roster"] });
  expect(() => validatePhases<TestValues>([fill])).toThrow(/fill/);
  expect(() => validatePhases<TestValues>([fill])).toThrow(/roster/);
});

test("a concurrency that is not a positive integer throws, naming the phase and the value", () => {
  for (const bad of [0, -1, 1.5]) {
    const pooled = phase("pool", { concurrency: bad });
    expect(() => validatePhases<TestValues>([pooled])).toThrow(/pool/);
    expect(() => validatePhases<TestValues>([pooled])).toThrow(
      new RegExp(`declares concurrency ${bad}`),
    );
  }
});

test("a negative maxRetries throws, naming the phase and the value", () => {
  const retried = phase("retrying", { maxRetries: -1 });
  expect(() => validatePhases<TestValues>([retried])).toThrow(/retrying/);
  expect(() => validatePhases<TestValues>([retried])).toThrow(/-1/);
});

// The positive cases.

test("a well-formed list with a key produced by phase 1 and required by phase 3 passes", () => {
  const one = phase("one", { produces: ["roster"] });
  const two = phase("two");
  const three = phase("three", { requires: ["roster"] });
  expect(() => validatePhases<TestValues>([one, two, three])).not.toThrow();
});

test("a phase that requires what a LATER phase produces throws", () => {
  const early = phase("early", { requires: ["roster"] });
  const late = phase("late", { produces: ["roster"] });
  expect(() => validatePhases<TestValues>([early, late])).toThrow(/roster/);
});

test("a phase with no requires and no produces passes", () => {
  expect(() => validatePhases<TestValues>([phase("plain")])).not.toThrow();
});

test("a single-phase list passes", () => {
  const only = phase("only", { produces: ["roster"] });
  expect(() => validatePhases<TestValues>([only])).not.toThrow();
});

// ---------------------------------------------------------------------------
// The draft-seeded marker: a phase whose dependency is the SHAPE of
// `draft.fields` — not a note's value, so no other key would express it —
// declares `requires: [draftSeededNoteKey]`. The ids are the real phases', but
// the phases are the helper's: the real ones live in leaf packages core cannot
// import, and their note requirements would trip the check for the wrong reason.
// ---------------------------------------------------------------------------

test("a gapfill requiring the marker with nothing before it throws, naming the phase and the key", () => {
  const gapfill = phase("gapfill", { requires: [draftSeededNoteKey] });
  expect(() => validatePhases<TestValues>([gapfill])).toThrow(/gapfill/);
  expect(() => validatePhases<TestValues>([gapfill])).toThrow(/draft-seeded/);
});

test("a marker-requiring phase after one that does not produce it throws — inventory does not seed", () => {
  const inventory = phase("inventory");
  const gapfill = phase("gapfill", { requires: [draftSeededNoteKey] });
  expect(() => validatePhases<TestValues>([inventory, gapfill])).toThrow(/gapfill/);
  expect(() => validatePhases<TestValues>([inventory, gapfill])).toThrow(/draft-seeded/);
});

test("a marker-requiring phase after a marker-producing one passes", () => {
  const fill = phase("fill", { produces: [draftSeededNoteKey] });
  const gapfill = phase("gapfill", { requires: [draftSeededNoteKey] });
  expect(() => validatePhases<TestValues>([fill, gapfill])).not.toThrow();
});

test("a marker-producing phase AFTER the requiring one does not satisfy it — order matters", () => {
  const gapfill = phase("gapfill", { requires: [draftSeededNoteKey] });
  const fill = phase("fill", { produces: [draftSeededNoteKey] });
  expect(() => validatePhases<TestValues>([gapfill, fill])).toThrow(/gapfill/);
});

test("a phase producing AND requiring the marker does not satisfy itself", () => {
  const both = phase("both", {
    produces: [draftSeededNoteKey],
    requires: [draftSeededNoteKey],
  });
  expect(() => validatePhases<TestValues>([both])).toThrow(/both/);
});

test("the three-phase chain validates on its note declarations plus the marker", () => {
  const presence = phase("presence", { produces: ["presence", draftSeededNoteKey] });
  const span = phase("span", { requires: ["presence"], produces: ["spans"] });
  const classify = phase("classify", { requires: ["spans"], produces: ["unsupported"] });
  expect(() => validatePhases<TestValues>([presence, span, classify])).not.toThrow();
});

test("a list where no phase produces the marker passes — there is deliberately no list-level seeding rule", () => {
  // The pin that no "at least one phase must seed" rule was added, and must not be:
  // `[inventory]` alone is not clearly wrong — its merge writes `fields[key] = []`
  // for stated-none collection groups, so an all-stated-empty roster legitimately
  // produces `{hvac: []}` — and such a rule would reject it along with every
  // `phasedExtractor` fixture that predates the marker (SP4a design §4.1).
  const inventory = phase("inventory");
  expect(() => validatePhases<TestValues>([inventory])).not.toThrow();
});
