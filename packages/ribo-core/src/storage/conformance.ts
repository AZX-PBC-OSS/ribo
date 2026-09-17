import type { ConformanceCase, ConformanceSubject, Expect } from "./conformance-cases.js";

import { defineStorageConformanceCases } from "./conformance-cases.js";

/**
 * @file The conformance kit's runner adapter — the only place runner vocabulary appears.
 *
 * The cases live in `conformance-cases.ts` as data: a list of named
 * {@link ConformanceCase}s built by `defineStorageConformanceCases`, with no
 * `describe` or `it` anywhere in it. This module is the thin adapter that
 * registers that list on a host runner, and `runStorageConformance` composes the
 * two with the signature the kit has always had, so the existing call sites —
 * `storage/memory-backend.test.ts` and `@azx/ribo-storage-rxdb`'s
 * `backend.browser.test.ts` — work unchanged.
 *
 * Framework-agnostic on purpose. It imports no test runner; `describe`, `it` and
 * `expect` arrive as arguments, so a backend author on any runner can use it and
 * this package needs no test-framework peer dependency. A third party who would
 * rather not adapt can skip this module and map the case list themselves — see
 * `conformance-cases.ts`.
 */

/** The subset of a runner's registration API this kit uses. Structural, so any runner satisfies it. */
export interface ConformanceRunner {
  describe: (name: string, body: () => void) => void;
  it: (name: string, body: () => Promise<void> | void) => void;
}

/** The fused input `runStorageConformance` takes: the subject, the assertion, the registration. */
export interface ConformanceHarness extends ConformanceRunner, ConformanceSubject {
  expect: Expect;
}

/**
 * Register conformance cases on a runner.
 *
 * The kit's single `describe`/`it` touchpoint. A third party mapping the case
 * list onto a runner of their own can call this, or inline its body.
 */
export function registerStorageConformanceCases(
  label: string,
  cases: readonly ConformanceCase[],
  runner: ConformanceRunner,
): void {
  runner.describe(`storage port conformance: ${label}`, () => {
    for (const conformanceCase of cases) {
      runner.it(conformanceCase.name, () => conformanceCase.run());
    }
  });
}

/**
 * Run the conformance suite against one backend.
 *
 * `label` names the backend in test output, so a repo running this against two
 * backends gets two distinguishable suites.
 */
export function runStorageConformance(label: string, harness: ConformanceHarness): void {
  const { describe, it, expect, createBackend, makeCapture, makeSession, makeEntry } = harness;
  const { removableCaptureField } = harness;

  const cases = defineStorageConformanceCases(
    { createBackend, makeCapture, makeSession, makeEntry, removableCaptureField },
    expect,
  );
  registerStorageConformanceCases(label, cases, { describe, it });
}
