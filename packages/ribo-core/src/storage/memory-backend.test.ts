import { describe, expect, it } from "vitest";

import { createMemoryBackend } from "./memory-backend.js";
import { runStorageConformance } from "../testing.js";

/**
 * @file The memory backend against the conformance kit.
 *
 * There is deliberately almost nothing here. The kit *is* the test: if this file
 * grows backend-specific assertions, they belong in the kit instead, where the
 * RxDB backend has to satisfy them too.
 *
 * The document factories are as thin as the port allows, because the memory
 * backend validates nothing. The RxDB backend's factories have to satisfy real
 * JSON schemas, which is exactly why the kit takes factories rather than
 * building documents itself.
 */
runStorageConformance("memory", {
  describe,
  it,
  expect,
  createBackend: (databaseName) => Promise.resolve(createMemoryBackend(databaseName)),
  makeCapture: ({ id, seq, status, sessionId, removable }) => ({
    id,
    seq,
    status,
    sessionId,
    ...(removable === undefined ? {} : { removable }),
  }),
  removableCaptureField: "removable",
  makeSession: ({ id, status, openedAt, ref }) => ({ id, status, openedAt, ref }),
  makeEntry: ({ id, scopeKind, scopeId, owner, key, value }) => ({
    id,
    scopeKind,
    scopeId,
    owner,
    key,
    value,
  }),
});
