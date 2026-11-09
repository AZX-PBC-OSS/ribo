/**
 * The runnable example behind docs/api/relay.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: a memory backend, a
 * `FakeTranscriber`, a `FakeExtractor` behind `toSessionExtractStep`, and an
 * injected lock manager — the Web Locks API the relay falls back to is a
 * browser global this node runner does not have.
 */

import assert from "node:assert/strict";
import {
  createMemoryBackend,
  createRelay,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  FakeExtractor,
  FakeTranscriber,
  openStorage,
  restrictToKind,
  toSessionExtractStep,
  type Relay,
  type RelayOptions,
  type Storage,
  type Capture,
} from "@azx/ribo-core";

function injectableClock(): { now: () => number; advance: (ms: number) => void } {
  let nowMs = 1_700_000_000_000;
  return { now: () => nowMs, advance: (ms) => void (nowMs += ms) };
}

/** A LockManager that always grants — the browser's Web Locks, excluded here. */
function grantingLocks(): LockManager {
  return {
    request: async (
      _name: string,
      _options: unknown,
      callback: (lock: unknown) => Promise<unknown>,
    ): Promise<unknown> => await callback({}),
  } as unknown as LockManager;
}

const extractFields = {
  atticInsulation: { value: "the attic is R-19", confidence: 0.9, sourceSpan: "the attic is R-19" },
};

async function openRelayStorage(now: () => number): Promise<Storage> {
  return await openStorage({ backend: createMemoryBackend(crypto.randomUUID()), now });
}

function relayHarness(storage: Storage, now: () => number, overrides: Partial<RelayOptions> = {}) {
  return createRelay({
    storage,
    transcriber: restrictToKind("audio", new FakeTranscriber({ text: "the attic is R-19" })),
    sessionExtract: toSessionExtractStep(new FakeExtractor(extractFields)),
    sessionWrite: async () => ({ fields: extractFields, receipts: { singleton: "snugg-1" } }),
    locks: grantingLocks(),
    now,
    ...overrides,
  });
}

async function enqueueRecording(storage: Storage, sessionId: string): Promise<Capture> {
  return await storage.captures.enqueue({
    recording: {
      id: "rec-1",
      capturedAt: new Date().toISOString(),
      kind: "audio",
      durationMs: 96_000,
      mimeType: "audio/webm",
      ctx: {},
    },
    audio: new Blob(["not really audio"], { type: "audio/webm" }),
    sessionId,
  });
}

export async function theRelayDrainsCaptureThenSessionThenWrite(): Promise<void> {
  // #region usage
  const clock = injectableClock();
  const storage = await openRelayStorage(clock.now);
  const writeCalls: unknown[] = [];
  const relay: Relay = relayHarness(storage, clock.now, {
    sessionWrite: async (input) => {
      writeCalls.push(input);
      return { fields: extractFields, receipts: { singleton: "snugg-1" } };
    },
  });
  const session = await storage.sessions.open({ ctx: { jobId: "job-7" }, ref: "job-7" });
  const capture = await enqueueRecording(storage, session.id);
  await relay.syncNow();
  // #endregion usage

  // The recording drained first; the session is still open, so nothing more.
  const transcribed = await storage.captures.get(capture.id);
  assert.equal(transcribed?.status, "transcribed");

  await storage.sessions.close(session.id);
  await relay.syncNow();
  // Extraction joins the transcripts and parks for a human.
  const parked = await storage.sessions.get(session.id);
  assert.equal(parked?.status, "awaiting-review");

  // Only a human's accepted review can send the session to the write step.
  await storage.sessions.submitReview(session.id, { status: "accepted", fields: extractFields });
  await relay.syncNow();

  const done = await storage.sessions.get(session.id);
  assert.equal(done?.status, "done");
  assert.equal(writeCalls.length, 1);
  assert.deepEqual(done?.receipts, { singleton: "snugg-1" });
  assert.deepEqual(done?.writeResult, extractFields);
  relay.stop();
  await storage.close();
}

export async function aTransientFailureParksTheSessionForARetry(): Promise<void> {
  const clock = injectableClock();
  const storage = await openRelayStorage(clock.now);
  const relay = relayHarness(storage, clock.now, {
    // A transient error — the uplink is down. The relay parks, it does not die.
    sessionWrite: async () => {
      throw new Error("uplink down");
    },
    // Deterministic full jitter: always the top of the window.
    random: () => 1,
    baseMs: 500,
    capMs: 60_000,
  });
  const session = await storage.sessions.open({ ctx: { jobId: "job-7" }, ref: "job-7" });
  await enqueueRecording(storage, session.id);
  await relay.syncNow();
  await storage.sessions.close(session.id);
  await relay.syncNow();
  await storage.sessions.submitReview(session.id, { status: "accepted", fields: extractFields });
  await relay.syncNow();

  const parked = await storage.sessions.get(session.id);
  assert.equal(parked?.status, "failed");
  assert.equal(parked?.attempts, 1);
  // nextAttemptAt is persisted, not scheduled: on iOS the relay only runs in
  // the foreground, so eligibility is a timestamp the next drain compares.
  assert.equal(Date.parse(parked?.nextAttemptAt ?? ""), clock.now() + 500);
  relay.stop();
  await storage.close();
}

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // The backoff window defaults, read from
  // packages/ribo-core/src/storage/backoff.ts and re-exported from the barrel.
  // The page quotes these values next to this region; a source change that
  // moved one fails here.
  assert.equal(DEFAULT_BACKOFF_BASE_MS, 1_000);
  assert.equal(DEFAULT_BACKOFF_CAP_MS, 300_000);
}
// #endregion defaults
