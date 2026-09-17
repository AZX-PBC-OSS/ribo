/**
 * @file `@azx/ribo-core/testing` — the storage port's conformance kit.
 *
 * Published as its own subpath so that a backend author can depend on it while a
 * consumer importing `@azx/ribo-core` never pulls test scaffolding into a bundle.
 *
 * The kit imports no test runner. `describe`, `it` and `expect` are passed in, so
 * this package needs no test-framework peer dependency and a backend author on
 * any runner can use it. See `storage/conformance.ts`.
 */

export { runStorageConformance } from "./storage/conformance.js";
export type {
  ConformanceDocuments,
  ConformanceHarness,
  ConformanceRunner,
  Expectation,
} from "./storage/conformance.js";
