/**
 * @file `@azx/ribo-core/testing` — the storage port's conformance kit.
 *
 * Published as its own subpath so that a backend author can depend on it while a
 * consumer importing `@azx/ribo-core` never pulls test scaffolding into a bundle.
 *
 * The kit imports no test runner. The cases are built as data by
 * `defineStorageConformanceCases` — no runner vocabulary at all — and
 * `runStorageConformance` registers them on a runner passed in, so this package
 * needs no test-framework peer dependency and a backend author on any runner can
 * use it. See `storage/conformance-cases.ts` and `storage/conformance.ts`.
 */

export { registerStorageConformanceCases, runStorageConformance } from "./storage/conformance.js";
export { defineStorageConformanceCases } from "./storage/conformance-cases.js";
export type { ConformanceHarness, ConformanceRunner } from "./storage/conformance.js";
export type {
  ConformanceCase,
  ConformanceDocuments,
  ConformanceSubject,
  Expect,
  Expectation,
} from "./storage/conformance-cases.js";
