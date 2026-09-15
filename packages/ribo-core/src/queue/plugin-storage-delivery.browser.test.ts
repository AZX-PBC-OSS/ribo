import { afterEach, expect, test } from "vitest";

import { FakeTranscriber } from "../fake-transcriber.js";
import type { CaptureItem } from "../capture-item.js";
import type { Recording } from "../recording.js";
import { removeOutboxDatabase } from "./database.js";
import { openOutbox } from "./outbox.js";
import { createRelay } from "./relay.js";
import { toSessionExtractStep } from "../extractor.js";
import type { Extractor } from "../extractor.js";
import type { Transcriber } from "../transcriber.js";
import type { OutboxItem } from "./schema.js";
import type { SessionItem } from "./session-schema.js";

// The plugin-storage DELIVERY, end to end: a transcriber writes through the
// handle the relay supplied in `TranscribeOptions.storage`, and an extractor —
// holding its own plugin-scoped handle from its construction — reads it back.
// Browser mode, not jsdom and not memory storage, because the load-bearing
// property is durability: the outbox is CLOSED AND REOPENED between the write
// and the read, and only real IndexedDB carries the bytes. An in-memory pass
// would satisfy a weaker test and miss the entire point — the two halves of a
// plugin may run in different tabs, minutes apart.

const usedNames: string[] = [];

function uniqueName(): string {
  const name = `ribo-outbox-plugin-storage-delivery-${crypto.randomUUID()}`;
  usedNames.push(name);
  return name;
}

afterEach(async () => {
  for (const name of usedNames.splice(0)) {
    await removeOutboxDatabase(name);
  }
});

const recording: Recording = {
  id: "rec-1",
  capturedAt: "2026-09-11T10:00:00.000Z",
  kind: "audio",
  durationMs: 4200,
  mimeType: "audio/webm;codecs=opus",
  ctx: { jobId: "job-1" },
};

function audioBlob(): Blob {
  const bytes = new Uint8Array(128).map((_, i) => (i * 31 + 7) % 256);
  return new Blob([bytes], { type: "audio/webm;codecs=opus" });
}

/** A transcriber that stores through the handle it was SUPPLIED, then transcribes normally. */
function storageWritingTranscriber(engine: string): Transcriber<CaptureItem> {
  return {
    engine,
    capability: async () => ({ status: "ready" }) as const,
    transcribe: async (item, _bytes, options) => {
      const store = options?.storage?.forPlugin(engine);
      if (!store) throw new Error(`${engine}: the relay supplied no storage handle`);
      await store.set("upload-handle", `uploaded-by-${engine}`);
      return { recordingId: item.id, text: "the attic is R-19", engine };
    },
  };
}

interface RelayDeps {
  readonly transcriber: Transcriber<CaptureItem>;
  readonly sessionExtract: Parameters<typeof createRelay>[0]["sessionExtract"];
}

async function buildRelay(outbox: Awaited<ReturnType<typeof openOutbox>>, deps: RelayDeps) {
  return createRelay({
    outbox,
    transcriber: deps.transcriber,
    sessionExtract: deps.sessionExtract,
    sessionWrite: async () => undefined,
  });
}

async function openSessionWithCapture(
  outbox: Awaited<ReturnType<typeof openOutbox>>,
): Promise<{ session: SessionItem; item: OutboxItem }> {
  const session = await outbox.openSession({ ctx: { jobId: "job-1" }, ref: "job-1" });
  const item = await outbox.enqueue({ recording, audio: audioBlob(), sessionId: session.id });
  return { session, item };
}

test("a transcriber writes through its relay-supplied handle and an extractor reads it back after the outbox is closed and reopened", async () => {
  const name = uniqueName();

  // --- Tab 1: the transcriber half, through the relay's delivery ------------
  const first = await openOutbox({ name });
  const { session, item } = await openSessionWithCapture(first);
  const relay1 = await buildRelay(first, {
    transcriber: storageWritingTranscriber("plugin-docs"),
    sessionExtract: async () => ({ fields: {}, usage: { calls: 1 } }),
  });
  await relay1.syncNow();

  // The transcription succeeded, which means the handle was supplied and the
  // write through it landed in the substrate.
  expect((await first.get(item.id))?.status).toBe("transcribed");
  expect(await first.pluginStorage(item.id, "plugin-docs").get("upload-handle")).toBe(
    "uploaded-by-plugin-docs",
  );

  await first.close();

  // --- Tab 2, minutes later: the extractor half, over a REOPENED database ---
  const second = await openOutbox({ name });
  // The construction-time handle: the host knows which plugin it is building,
  // so the scope bakes in the pluginId and leaves the capture dimension to be
  // addressed per call. It is minted from the REOPENED outbox — a handle from
  // `first` would be bound to a closed database.
  const scope = second.pluginStorageScope("plugin-docs");
  const extractor: Extractor<Record<string, unknown>> = {
    extract: async () => {
      // Read ACROSS the session's captures: enumerate what the plugin has,
      // then read each capture's entry. The extractor is told no capture id —
      // it discovers them, which is the whole point of the scope shape.
      const captureIds = await scope.captures();
      const uploads: Record<string, unknown> = {};
      for (const captureId of captureIds) {
        uploads[captureId] = await scope.capture(captureId).get("upload-handle");
      }
      return { fields: { uploads }, usage: { calls: 1 } };
    },
  };
  const relay2 = await buildRelay(second, {
    transcriber: new FakeTranscriber(),
    sessionExtract: toSessionExtractStep(extractor),
  });

  await second.closeSession(session.id);
  await relay2.syncNow();

  // The extraction ran on what storage held across the close-and-reopen —
  // not on anything the transcriber left in memory.
  const extracted = await second.getSession(session.id);
  expect(extracted?.status).toBe("awaiting-review");
  expect(extracted?.extracted).toEqual({
    uploads: { [item.id]: "uploaded-by-plugin-docs" },
  });

  await second.close();
});

test("two plugins cannot read each other's keys through the handles they are supplied", async () => {
  const name = uniqueName();
  const outbox = await openOutbox({ name });
  const { item } = await openSessionWithCapture(outbox);

  // The construction-time handles: one per plugin, baked to their pluginId.
  const scopeA = outbox.pluginStorageScope("plugin-A");
  const scopeB = outbox.pluginStorageScope("plugin-B");
  await scopeA.capture(item.id).set("secret", "a-value");

  expect(await scopeB.capture(item.id).get("secret")).toBeUndefined();
  // Stronger than a failed read: B cannot even DISCOVER the capture, because
  // enumeration is scoped to the plugin too.
  expect(await scopeB.captures()).toEqual([]);
  expect(await scopeA.captures()).toEqual([item.id]);

  // The transcribe-side view the relay supplies — the same isolation by the
  // plugin id the transcriber names for itself.
  const captureScope = outbox.captureStorage(item.id);
  await captureScope.forPlugin("plugin-A").set("k", "a");
  expect(await captureScope.forPlugin("plugin-B").get("k")).toBeUndefined();
  expect(await captureScope.forPlugin("plugin-A").get("k")).toBe("a");

  await outbox.close();
});

test("dropping a capture sweeps what the transcriber wrote for it — the extractor reads no stale view", async () => {
  const name = uniqueName();
  const outbox = await openOutbox({ name });
  const { item } = await openSessionWithCapture(outbox);

  const relay = await buildRelay(outbox, {
    transcriber: storageWritingTranscriber("plugin-docs"),
    sessionExtract: async () => ({ fields: {}, usage: { calls: 1 } }),
  });
  await relay.syncNow();

  // The extractor's scope, minted BEFORE the sweep and REUSED after it — the
  // strongest form of the staleness check: the handle caches nothing, so the
  // same instance must reflect the sweep on its very next read.
  const scope = outbox.pluginStorageScope("plugin-docs");
  expect(await scope.captures()).toEqual([item.id]);
  expect(await scope.capture(item.id).get("upload-handle")).toBe("uploaded-by-plugin-docs");

  await outbox.remove(item.id);

  expect(await scope.captures()).toEqual([]);
  expect(await scope.capture(item.id).get("upload-handle")).toBeUndefined();

  // And the sweep is durable: a fresh handle over a REOPENED database agrees.
  await outbox.close();
  const reopened = await openOutbox({ name });
  const fresh = reopened.pluginStorageScope("plugin-docs");
  expect(await fresh.captures()).toEqual([]);
  expect(await fresh.capture(item.id).get("upload-handle")).toBeUndefined();
  await reopened.close();
});

test("a transcriber driven by hand — no options at all — observes the member's absence", async () => {
  // The member is optional because the relay is not the only caller: a host
  // driving a transcriber by hand has no storage to give. This proves the
  // absence is observable (the handle is `undefined`, not an empty shell), so
  // an implementation that needs storage can say so rather than fail deeper.
  const transcriber = storageWritingTranscriber("plugin-docs");
  const error = await transcriber.transcribe(recording, audioBlob()).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("plugin-docs: the relay supplied no storage handle");
});
