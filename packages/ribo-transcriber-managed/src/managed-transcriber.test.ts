import { isPermanentlyUnavailable } from "@azx/ribo-core";
import { describe, expect, test } from "vitest";

import { ManagedTranscriber } from "./index.js";
import { MANAGED_AZURE_SPEECH_ENGINE } from "./config.js";

/**
 * Capability tests for the managed transcriber — the Task 3 must-fail tests from
 * `docs/roadmap/design/managed-transcription-plan.md`. No network, no credential:
 * `fetch` is injected with a double, connectivity is injected as a predicate, and
 * the endpoint is a bare string. The package has no capacity to authenticate, so
 * there is nothing to double beyond the transport.
 */

const SAMPLE_ENDPOINT = "https://myresource.cognitiveservices.azure.com";

describe("ManagedTranscriber — capability", () => {
  test("a missing endpoint yields not-configured, and isPermanentlyUnavailable is false for it", async () => {
    const t = new ManagedTranscriber({});
    const cap = await t.capability();

    expect(cap.status).toBe("unavailable");
    if (cap.status === "unavailable") {
      expect(cap.reason).toBe("not-configured");
    }
    // A missing configuration must not permanently demote the engine — the host
    // may supply one later. Both `not-configured` and `offline` are situations,
    // not facts about the hardware.
    expect(isPermanentlyUnavailable(cap)).toBe(false);
  });

  test("a connectivity predicate reporting down yields offline (and isPermanentlyUnavailable is false)", async () => {
    const t = new ManagedTranscriber({
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
    const t = new ManagedTranscriber({
      endpoint: SAMPLE_ENDPOINT,
      isOnline: () => true,
    });
    const cap = await t.capability();

    expect(cap.status).toBe("ready");
  });

  test("the engine id is exactly managed-azure-speech", () => {
    // The literal is asserted because it is persisted data — it rides into every
    // Transcript.engine this package produces and into the outbox document. A
    // rename is a migration, not a refactor.
    const t = new ManagedTranscriber({});
    expect(t.engine).toBe("managed-azure-speech");
    expect(MANAGED_AZURE_SPEECH_ENGINE).toBe("managed-azure-speech");
  });
});
