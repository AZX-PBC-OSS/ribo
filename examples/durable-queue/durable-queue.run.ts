/**
 * The durable-queue example: the half of the queue a host actually lives in.
 * The drain itself is taught by docs/api/examples/relay.run.ts — this example
 * adds what no other executed file shows: observing the session machine
 * through `storage.sessions.watch`, and the offline-first ordering promise —
 * the capture row is persisted before transcription runs — asserted from
 * inside the transcription call itself, not from a read-back after the fact.
 *
 * The file runs over 100 lines only because it carries its own test doubles
 * (a granting lock manager, a two-second watch deadline); the example arc
 * itself is the three regions below.
 */

// #region imports
import assert from "node:assert/strict";
import {
  createMemoryBackend,
  createRelay,
  FakeExtractor,
  FakeTranscriber,
  openStorage,
  restrictToKind,
  toSessionExtractStep,
  type AudioCapture,
  type TranscribeOptions,
} from "@azx/ribo-core";
// #endregion imports

/** A lock manager that always grants — the Web Locks API is a browser global. */
function grantingLocks(): LockManager {
  const request = async (
    _name: string,
    _options: unknown,
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown> => callback({});
  return { request } as unknown as LockManager;
}

/** Reject with `message` if `promised` has not settled within two seconds. */
function within(promised: Promise<void>, message: string): Promise<void> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(message)), 2_000);
  });
  return Promise.race([promised, timeout]);
}

const FIXED_NOW_MS = 1_700_000_000_000;
const DATABASE = "example-durable-queue";
const REF = "job-7";

const EXTRACT_FIELDS = {
  atticInsulation: { value: "the attic is R-19", confidence: 0.9, sourceSpan: "the attic is R-19" },
};

// #region complete-export
export async function theQueuePersistsFirstAndTheWatchSeesReview(): Promise<void> {
  // The injected clock stays visible — it is the lesson: the persisted
  // timestamps are values the example chose, not wall-clock accidents.
  const now = (): number => FIXED_NOW_MS;
  const storage = await openStorage({ backend: createMemoryBackend(DATABASE), now });

  // #region watch
  // Subscribe BEFORE anything runs — the watch stream is how a host observes
  // the session machine, and a subscriber that arrives late misses the path.
  const statuses: string[] = [];
  let reachReview!: () => void;
  const sawAwaitingReview = new Promise<void>((resolve) => {
    reachReview = resolve;
  });
  const subscription = storage.sessions.watch({ ref: REF }).subscribe((sessions) => {
    const session = sessions.find((candidate) => candidate.ref === REF);
    if (!session || statuses[statuses.length - 1] === session.status) return;
    statuses.push(session.status);
    if (session.status === "awaiting-review") reachReview();
  });
  // #endregion watch

  const session = await storage.sessions.open({ ctx: { jobId: REF }, ref: REF });

  // #region ordering
  // The relay hands a transcriber the capture payload, not the stored row, and
  // the row's id is minted by the queue at enqueue time — so the double below
  // matches its payload to the persisted row through the public session-scoped
  // list, at invocation time. If the relay ever transcribed a capture it had
  // not persisted, this read-back finds no row.
  class PersistedFirstTranscriber extends FakeTranscriber {
    #reads = 0;
    get reads(): number {
      return this.#reads;
    }
    override async transcribe(item: AudioCapture, bytes: Blob, options?: TranscribeOptions) {
      this.#reads += 1;
      const rows = await storage.captures.list({ sessionId: session.id });
      const row = rows.find((candidate) => candidate.recording.id === item.id);
      assert.ok(row, "the capture row must already be persisted when transcription runs");
      assert.equal(row.enqueuedAt, new Date(FIXED_NOW_MS).toISOString());
      return super.transcribe(item, bytes, options);
    }
  }
  const transcriber = new PersistedFirstTranscriber();
  await storage.captures.enqueue({
    recording: {
      id: "rec-1",
      capturedAt: new Date(FIXED_NOW_MS).toISOString(),
      kind: "audio",
      durationMs: 96_000,
      mimeType: "audio/webm",
      ctx: {},
    },
    audio: new Blob(["not really audio"], { type: "audio/webm" }),
    sessionId: session.id,
  });
  // #endregion ordering

  // #region relay
  const errors: unknown[] = [];
  const relay = createRelay({
    storage,
    transcriber: restrictToKind("audio", transcriber),
    sessionExtract: toSessionExtractStep(new FakeExtractor(EXTRACT_FIELDS)),
    sessionWrite: async () => ({ fields: EXTRACT_FIELDS, receipts: { singleton: "snugg-1" } }),
    locks: grantingLocks(),
    now,
    onError: (error) => errors.push(error),
  });
  // Captures drain first — the transcript lands while the session is open.
  await relay.syncNow();
  assert.equal(transcriber.reads, 1, "the transcriber override must have run once");
  assert.deepEqual(errors, [], "no step may fail — an in-call assertion failure surfaces here");
  // The host closes the session; only then does the relay extract and park it.
  await storage.sessions.close(session.id);
  await relay.syncNow();
  // #endregion relay

  // The watch stream reported the session reaching `awaiting-review` — parked,
  // because only a human decision can move it from here.
  await within(sawAwaitingReview, "the watch stream never reported awaiting-review");
  assert.equal(statuses[0], "open");
  assert.equal(statuses[statuses.length - 1], "awaiting-review");
  subscription.unsubscribe();
  relay.stop();
  await storage.close();
}
// #endregion complete-export
