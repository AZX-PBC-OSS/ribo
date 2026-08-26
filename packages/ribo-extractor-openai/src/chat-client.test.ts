import { describe, expect, expectTypeOf, test } from "vitest";

import type {
  ChatCapability,
  ChatClient,
  CapableChatClient,
  ChatCompletion,
  ChatRequest,
} from "./chat-client.js";

/**
 * Type-level tests for the capability contract. These assert that the seam is
 * wide enough for on-device (which may need a download or may be absent) and
 * narrow enough that a plain `ChatClient` does not count as capable.
 */

describe("CapableChatClient structural conformance", () => {
  test("a plain object implementing complete, engine and capability satisfies CapableChatClient", () => {
    const client: CapableChatClient = {
      engine: "test-ondevice",
      capability: async (): Promise<ChatCapability> => ({ status: "ready" }),
      complete: async (_request: ChatRequest): Promise<ChatCompletion> => ({
        content: "{}",
      }),
    };

    expect(client.engine).toBe("test-ondevice");
  });

  test("a plain ChatClient does not satisfy CapableChatClient", () => {
    const client: ChatClient = {
      complete: async (_request: ChatRequest): Promise<ChatCompletion> => ({
        content: "{}",
      }),
    };

    // Structural mismatch: missing `engine` and `capability()`.
    // @ts-expect-error ChatClient lacks engine and capability()
    const capable: CapableChatClient = client;
    expect(capable).toBeDefined();
  });
});

describe("ChatCapability discriminants", () => {
  test("ready", () => {
    const cap: ChatCapability = { status: "ready" };
    expect(cap.status).toBe("ready");
    if (cap.status === "ready") {
      expectTypeOf(cap).toExtend<{ status: "ready" }>();
    }
  });

  test("needs-download", () => {
    const cap: ChatCapability = { status: "needs-download", detail: "Chrome-managed download" };
    expect(cap.status).toBe("needs-download");
    if (cap.status === "needs-download") {
      expectTypeOf(cap).toExtend<{ status: "needs-download"; detail?: string }>();
    }
  });

  test("needs-download without detail", () => {
    const cap: ChatCapability = { status: "needs-download" };
    expect(cap.status).toBe("needs-download");
  });

  test("unavailable", () => {
    const cap: ChatCapability = {
      status: "unavailable",
      reason: "unsupported-platform",
      detail: "no local model API",
    };
    expect(cap.status).toBe("unavailable");
    if (cap.status === "unavailable") {
      expectTypeOf(cap).toExtend<{ status: "unavailable"; reason: string; detail: string }>();
    }
  });
});
