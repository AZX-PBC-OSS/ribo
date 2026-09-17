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
