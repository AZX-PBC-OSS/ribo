import { expect, test } from "vitest";

import type { NoProvenance } from "./enveloped.js";
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
// offending phase id and the id or value it got wrong — a validator whose message does
// not identify the problem is half a validator, and the agentic use (the message is the
// repair prompt for the next model attempt) depends entirely on it.

test("an empty phase list throws", () => {
  expect(() => validatePhases<TestValues>([])).toThrow(TypeError);
  expect(() => validatePhases<TestValues>([])).toThrow(/empty/);
});

test("a duplicate id throws, naming the id", () => {
  const phases = [phase("presence"), phase("span"), phase("presence")];
  expect(() => validatePhases<TestValues>(phases)).toThrow(/presence/);
});

test("a requires id that is not an earlier phase's throws, naming the phase and the id", () => {
  const fill = phase("fill", { requires: ["inventory"] });
  expect(() => validatePhases<TestValues>([fill])).toThrow(/fill/);
  expect(() => validatePhases<TestValues>([fill])).toThrow(/inventory/);
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

test("a well-formed list with a dependency on phase 1 from phase 3 passes", () => {
  const one = phase("one");
  const two = phase("two");
  const three = phase("three", { requires: ["one"] });
  expect(() => validatePhases<TestValues>([one, two, three])).not.toThrow();
});

test("a phase that requires a LATER phase throws — a dependency satisfied later is not satisfied", () => {
  const early = phase("early", { requires: ["late"] });
  const late = phase("late");
  expect(() => validatePhases<TestValues>([early, late])).toThrow(/late/);
});

test("a phase with no requires passes", () => {
  expect(() => validatePhases<TestValues>([phase("plain")])).not.toThrow();
});

test("a single-phase list passes", () => {
  expect(() => validatePhases<TestValues>([phase("only")])).not.toThrow();
});

test("a phase whose requires contains its own id is rejected — check before adding", () => {
  const self = phase("both", { requires: ["both"] });
  expect(() => validatePhases<TestValues>([self])).toThrow(/both/);
});

// The id chain: a phase's `requires` names the phase whose output it reads. The
// ids here are the shipped defaults' for legibility, but the phases are the
// helper's — the real ones live where their note reads are tested.

test("the three-phase chain validates on its id declarations", () => {
  const presence = phase("presence");
  const span = phase("span", { requires: ["presence"] });
  const classify = phase("classify", { requires: ["span"] });
  expect(() => validatePhases<TestValues>([presence, span, classify])).not.toThrow();
});

test("a list where no phase requires anything passes — there is deliberately no list-level seeding rule", () => {
  // The pin that no "at least one phase must run first" rule was added, and must
  // not be: `[inventory]` alone is not clearly wrong — its merge writes
  // `fields[key] = []` for stated-none collection groups, so an all-stated-empty
  // roster legitimately produces `{hvac: []}` — and such a rule would reject it
  // along with every `phasedExtractor` fixture whose phases declare no
  // requirements (ADR 0008).
  const inventory = phase("inventory");
  expect(() => validatePhases<TestValues>([inventory])).not.toThrow();
});
