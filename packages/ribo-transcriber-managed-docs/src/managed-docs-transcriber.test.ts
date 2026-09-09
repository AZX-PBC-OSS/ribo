import { isPermanentlyUnavailable } from "@azx/ribo-core";
import { describe, expect, test } from "vitest";

import { ManagedDocsTranscriber } from "./index.js";
import { MANAGED_DOCS_ENGINE } from "./config.js";

/**
 * Capability tests for the managed docs transcriber. No network, no credential:
 * `fetch` is injected with a double, connectivity is injected as a predicate, and
 * the endpoint is a bare string. The package has no capacity to authenticate, so
 * there is nothing to double beyond the transport. Mirrors
 * `ribo-transcriber-managed/src/managed-transcriber.test.ts`.
 */

const SAMPLE_ENDPOINT = "https://example.invalid/documentintelligence/documentModels/prebuilt-read:analyze";

describe("ManagedDocsTranscriber — capability", () => {
  test("a missing endpoint yields not-configured, and isPermanentlyUnavailable is false for it", async () => {
    const t = new ManagedDocsTranscriber({});
    const cap = await t.capability();

    expect(cap.status).toBe("unavailable");
    if (cap.status === "unavailable") {
      expect(cap.reason).toBe("not-configured");
    }
    expect(isPermanentlyUnavailable(cap)).toBe(false);
  });

  test("a connectivity predicate reporting down yields offline (and isPermanentlyUnavailable is false)", async () => {
    const t = new ManagedDocsTranscriber({
      endpoint: SAMPLE_ENDPOINT,
      isOnline: () => false,
    });
    const cap = await t.capability();

    expect(cap.status).toBe("unavailable");
    if (cap.status === "unavailable") {
      expect(cap.reason).toBe("offline");
    }
    expect(isPermanentlyUnavailable(cap)).toBe(false);
  });

  test("a connectivity predicate reporting up with an endpoint configured yields ready", async () => {
    const t = new ManagedDocsTranscriber({
      endpoint: SAMPLE_ENDPOINT,
      isOnline: () => true,
    });
    const cap = await t.capability();

    expect(cap.status).toBe("ready");
  });

  test("the engine id is exactly managed-docs", () => {
    const t = new ManagedDocsTranscriber({});
    expect(t.engine).toBe("managed-docs");
    expect(MANAGED_DOCS_ENGINE).toBe("managed-docs");
  });
});
