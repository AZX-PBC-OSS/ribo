import { DEFAULT_CAPABILITY_TTL_MS } from "@azx/ribo-core";
import type { Extractor, ExtractionResult } from "@azx/ribo-core";
import { describe, expect, test } from "vitest";

import type { CapableChatClient, ChatCapability } from "./chat-client.js";
import { compositeExtractor } from "./composite-extractor.js";

/**
 * Unit tests for the composite extractor: an ordered list of chat+extractor pairs,
 * first ready wins, capability is cached, and the winning engine is stamped onto
 * the result. Everything is fake — no network, no model.
 *
 * These tests pin the **managed-first, on-device-second** ordering that the spec
 * calls for. The two "first ready / first unavailable" tests together assert both
 * directions; without them the ordering looks like a bug and gets "fixed".
 */

interface MutableClock {
  now(): number;
  advance(ms: number): void;
}

function makeClock(): MutableClock {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function fakeChatClient(
  engine: string,
  capability: ChatCapability,
): CapableChatClient & { probeCount: number } {
  let probeCount = 0;
  return {
    engine,
    complete: async () => {
      throw new Error("composite extractor must not call chat.complete directly");
    },
    capability: async () => {
      probeCount += 1;
      return capability;
    },
    get probeCount() {
      return probeCount;
    },
  };
}

function fakeExtractor<F>(
  fields: F,
  options: { calls?: number; engine?: string } = {},
): Extractor<F> & { calls: readonly string[] } {
  const calls: string[] = [];
  return {
    extract: async (transcript: string) => {
      calls.push(transcript);
      return {
        fields,
        usage: { calls: options.calls ?? 1, engine: options.engine },
      } as ExtractionResult<F>;
    },
    get calls() {
      return calls;
    },
  };
}

const ready = (engine: string): ChatCapability => ({ status: "ready" });
const unavailable = (detail: string): ChatCapability => ({
  status: "unavailable",
  reason: "offline",
  detail,
});
const needsDownload = (): ChatCapability => ({ status: "needs-download" });

describe("compositeExtractor", () => {
  test("first entry ready -> first extractor runs and engine is stamped", async () => {
    const fields = { a: 1 };
    const managedChat = fakeChatClient("managed", ready("managed"));
    const managedExtractor = fakeExtractor(fields, { calls: 7, engine: "managed" });
    const onDeviceChat = fakeChatClient("on-device", ready("on-device"));
    const onDeviceExtractor = fakeExtractor(fields, { calls: 7, engine: "on-device" });

    const extractor = compositeExtractor([
      { chat: managedChat, extractor: managedExtractor },
      { chat: onDeviceChat, extractor: onDeviceExtractor },
    ]);

    const result = await extractor.extract("the transcript");
    expect(result.fields).toEqual(fields);
    expect(result.usage).toEqual({ calls: 7, engine: "managed" });
    expect(managedExtractor.calls).toEqual(["the transcript"]);
    expect(onDeviceExtractor.calls).toEqual([]);
    expect(managedChat.probeCount).toBe(1);
  });

  test("first unavailable, second ready -> second extractor runs and engine is stamped", async () => {
    const fields = { b: 2 };
    const managedChat = fakeChatClient("managed", unavailable("uplink is down"));
    const managedExtractor = fakeExtractor(fields, { engine: "managed" });
    const onDeviceChat = fakeChatClient("on-device", ready("on-device"));
    const onDeviceExtractor = fakeExtractor(fields, { engine: "on-device" });

    const extractor = compositeExtractor([
      { chat: managedChat, extractor: managedExtractor },
      { chat: onDeviceChat, extractor: onDeviceExtractor },
    ]);

    const result = await extractor.extract("the transcript");
    expect(result.fields).toEqual(fields);
    expect(result.usage).toEqual({ calls: 1, engine: "on-device" });
    expect(managedExtractor.calls).toEqual([]);
    expect(onDeviceExtractor.calls).toEqual(["the transcript"]);
    expect(managedChat.probeCount).toBe(1);
    expect(onDeviceChat.probeCount).toBe(1);
  });

  test("a needs-download entry is never selected, even as the only entry", async () => {
    const onlyChat = fakeChatClient("on-device", needsDownload());
    const onlyExtractor = fakeExtractor({});

    const only = compositeExtractor([{ chat: onlyChat, extractor: onlyExtractor }]);
    await expect(only.extract("x")).rejects.toThrow("on-device: needs-download");
    expect(onlyExtractor.calls).toEqual([]);
    expect(onlyChat.probeCount).toBe(1);

    const managedChat = fakeChatClient("managed", unavailable("offline"));
    const managedExtractor = fakeExtractor({});
    const onDeviceChat = fakeChatClient("on-device", needsDownload());
    const onDeviceExtractor = fakeExtractor({});

    const paired = compositeExtractor([
      { chat: managedChat, extractor: managedExtractor },
      { chat: onDeviceChat, extractor: onDeviceExtractor },
    ]);
    await expect(paired.extract("x")).rejects.toThrow();
    expect(managedExtractor.calls).toEqual([]);
    expect(onDeviceExtractor.calls).toEqual([]);
    expect(onDeviceChat.probeCount).toBe(1);
  });

  test("capability is probed once per extraction even though the chosen extractor makes many calls", async () => {
    const chat = fakeChatClient("managed", ready("managed"));
    const inner = fakeExtractor({ fields: true }, { calls: 7 });

    const extractor = compositeExtractor([{ chat, extractor: inner }]);
    const result = await extractor.extract("t");

    expect(result.usage.calls).toBe(7);
    expect(chat.probeCount).toBe(1);
    expect(inner.calls).toHaveLength(1);
  });

  test("invalidate() makes the next extraction re-probe", async () => {
    const clock = makeClock();
    const chat = fakeChatClient("managed", ready("managed"));
    const inner = fakeExtractor({});

    const extractor = compositeExtractor([{ chat, extractor: inner }], {
      now: clock.now,
    });

    await extractor.extract("a");
    expect(chat.probeCount).toBe(1);

    extractor.invalidate();
    await extractor.extract("b");
    expect(chat.probeCount).toBe(2);
  });

  test("within the TTL and without invalidate(), a second extraction does not re-probe", async () => {
    const clock = makeClock();
    const chat = fakeChatClient("managed", ready("managed"));
    const inner = fakeExtractor({});

    const extractor = compositeExtractor([{ chat, extractor: inner }], {
      now: clock.now,
    });

    await extractor.extract("a");
    clock.advance(DEFAULT_CAPABILITY_TTL_MS - 1);
    await extractor.extract("b");

    expect(chat.probeCount).toBe(1);
  });

  test("when no entry is selectable, the error names each engine and its status", async () => {
    const chat = fakeChatClient("managed", unavailable("offline"));
    const inner = fakeExtractor({});

    const extractor = compositeExtractor([{ chat, extractor: inner }]);
    await expect(extractor.extract("x")).rejects.toThrow(
      "managed: unavailable (offline) — offline",
    );
  });
});
