import { randomUUID } from "node:crypto";
import type { TestProject } from "vitest/node";

import type {} from "./build-once.js";

/** One token per test run, so `buildCliOnce` can tell this run's build from a stale one. */
export default function setup(project: TestProject): void {
  project.provide("riboCliRunToken", randomUUID());
}
