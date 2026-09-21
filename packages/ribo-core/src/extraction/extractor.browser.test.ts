import { createMemoryBackend, removeMemoryDatabase } from "../storage/memory-backend.js";
import { afterEach, beforeEach, expect, test } from "vitest";

import { FakeExtractor, toSessionExtractStep } from "./extractor.js";
import { FakeTranscriber } from "../transcription/fake-transcriber.js";
import { restrictToKind } from "../transcription/restrict-to-kind.js";
import { openStorage, type Storage } from "../storage/storage.js";
import { createRelay } from "../storage/relay.js";
import type { Recording } from "../capture/recording.js";

// Browser mode, for the same reason as `queue/relay.browser.test.ts`: this is the
// acceptance criterion for the extraction seam — a `FakeExtractor` substituting
// into the relay with ZERO relay changes — and it is only meaningful against the
// real RxDB/IndexedDB storage the relay actually drives. jsdom's shimmed IndexedDB
// cannot tell the truth about what lands on a persisted item.
//
// This mirrors how `FakeTranscriber` proves the transcriber seam throughout
// `queue/relay.browser.test.ts`: build a real storage, wire the fake into
// `createRelay`, drain, and read the result straight off durable storage.

interface AtticFields extends Record<string, unknown> {
  atticInsulation: string;
  rValue: number;
}

const recording: Recording = {
  id: "rec-1",
  capturedAt: "2026-07-23T10:00:00.000Z",
  kind: "audio",
  durationMs: 1000,
  mimeType: "audio/webm;codecs=opus",
  ctx: { jobId: "job-7" },
};

function audio(): Blob {
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm;codecs=opus" });
}

const names: string[] = [];
const open: Storage[] = [];

async function openTestOutbox(): Promise<Storage> {
  const name = `ribo-extractor-test-${crypto.randomUUID()}`;
  names.push(name);
  const storage = await openStorage({ backend: createMemoryBackend(name) });
  open.push(storage);
  return storage;
}

beforeEach(() => {
  names.length = 0;
  open.length = 0;
});

afterEach(async () => {
  for (const storage of open.splice(0)) if (!storage.closed) await storage.close();
  for (const name of names.splice(0)) removeMemoryDatabase(name);
});

test("a FakeExtractor substitutes into createRelay and its fields land on session.extracted", async () => {
  const storage = await openTestOutbox();
  const session = await storage.sessions.open({ ctx: { jobId: "job-7" }, ref: "job-7" });

  const fields: AtticFields = { atticInsulation: "fiberglass batts", rValue: 19 };
  const extractor = new FakeExtractor<AtticFields>(fields);

  // The ONLY line that changed vs. any other relay wiring: `sessionExtract` is
  // the seam's adapter over the fake. Nothing in `createRelay` or the relay
  // itself is touched.
  const relay = createRelay({
    storage,
    transcriber: restrictToKind("audio", new FakeTranscriber({ text: "the attic is R-19" })),
    sessionExtract: toSessionExtractStep(extractor),
    sessionWrite: async () => undefined,
  });

  const item = await storage.captures.enqueue({ recording, audio: audio(), sessionId: session.id });

  // Drain transcribes the recording to `transcribed`.
  await relay.syncNow();
  expect((await storage.captures.get(item.id))?.status).toBe("transcribed");

  // Closing the session transitions it to `extracting`, and the next drain
  // runs session-level extraction.
  await storage.sessions.close(session.id);
  await relay.syncNow();

  // The session drained THROUGH the extracting step: the fake's exact fields
  // are what the relay persisted as `extracted` on the session.
  const parked = await storage.sessions.get(session.id);
  expect(parked?.extracted).toEqual(fields);
  // And it stopped at the review gate, which is where a successful extraction
  // ends.
  expect(parked?.status).toBe("awaiting-review");

  // And the extractor really was driven with the joined transcript text, not
  // bypassed.
  expect(extractor.calls.map((t) => t.text)).toEqual(["the attic is R-19"]);
});
