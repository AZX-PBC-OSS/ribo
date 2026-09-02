import { afterEach, beforeEach, expect, test } from "vitest";

import { FakeExtractor, toSessionExtractStep } from "./extractor.js";
import { FakeTranscriber } from "./fake-transcriber.js";
import { removeOutboxDatabase } from "./queue/database.js";
import { openOutbox, type Outbox } from "./queue/outbox.js";
import { createRelay } from "./queue/relay.js";
import type { Recording } from "./recording.js";

// Browser mode, for the same reason as `queue/relay.browser.test.ts`: this is the
// acceptance criterion for the extraction seam — a `FakeExtractor` substituting
// into the relay with ZERO relay changes — and it is only meaningful against the
// real RxDB/IndexedDB outbox the relay actually drives. jsdom's shimmed IndexedDB
// cannot tell the truth about what lands on a persisted item.
//
// This mirrors how `FakeTranscriber` proves the transcriber seam throughout
// `queue/relay.browser.test.ts`: build a real outbox, wire the fake into
// `createRelay`, drain, and read the result straight off durable storage.

interface AtticFields extends Record<string, unknown> {
  atticInsulation: string;
  rValue: number;
}

const recording: Recording = {
  id: "rec-1",
  capturedAt: "2026-07-23T10:00:00.000Z",
  durationMs: 1000,
  mimeType: "audio/webm;codecs=opus",
  ctx: { jobId: "job-7" },
};

function audio(): Blob {
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm;codecs=opus" });
}

const names: string[] = [];
const open: Outbox[] = [];

async function openTestOutbox(): Promise<Outbox> {
  const name = `ribo-extractor-test-${crypto.randomUUID()}`;
  names.push(name);
  const outbox = await openOutbox({ name });
  open.push(outbox);
  return outbox;
}

beforeEach(() => {
  names.length = 0;
  open.length = 0;
});

afterEach(async () => {
  for (const outbox of open.splice(0)) if (!outbox.closed) await outbox.close();
  for (const name of names.splice(0)) await removeOutboxDatabase(name);
});

test("a FakeExtractor substitutes into createRelay and its fields land on session.extracted", async () => {
  const outbox = await openTestOutbox();
  const session = await outbox.openSession({ ctx: { jobId: "job-7" }, ref: "job-7" });

  const fields: AtticFields = { atticInsulation: "fiberglass batts", rValue: 19 };
  const extractor = new FakeExtractor<AtticFields>(fields);

  // The ONLY line that changed vs. any other relay wiring: `sessionExtract` is
  // the seam's adapter over the fake. Nothing in `createRelay` or the relay
  // itself is touched.
  const relay = createRelay({
    outbox,
    transcriber: new FakeTranscriber({ text: "the attic is R-19" }),
    sessionExtract: toSessionExtractStep(extractor),
    sessionWrite: async () => undefined,
  });

  const item = await outbox.enqueue({ recording, audio: audio(), sessionId: session.id });

  // Drain transcribes the recording to `transcribed`.
  await relay.syncNow();
  expect((await outbox.get(item.id))?.status).toBe("transcribed");

  // Closing the session transitions it to `extracting`, and the next drain
  // runs session-level extraction.
  await outbox.closeSession(session.id);
  await relay.syncNow();

  // The session drained THROUGH the extracting step: the fake's exact fields
  // are what the relay persisted as `extracted` on the session.
  const parked = await outbox.getSession(session.id);
  expect(parked?.extracted).toEqual(fields);
  // And it stopped at the review gate, which is where a successful extraction
  // ends.
  expect(parked?.status).toBe("awaiting-review");

  // And the extractor really was driven with the joined transcript text, not
  // bypassed.
  expect(extractor.calls).toEqual(["the attic is R-19"]);
});
