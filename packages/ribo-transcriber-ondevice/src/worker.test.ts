import { describe, expect, test, vi } from "vitest";

import { WHISPER_SAMPLE_RATE } from "./decode.js";
import {
  WORKER_ENTRY_NAME,
  clearLiveSessions,
  handleMessage,
  injectLiveSession,
  normalizeProgress,
  planChunks,
  processPendingClose,
  serialize,
} from "./worker.js";
import type { RegionFrameResult } from "./vad-stream.js";
import type { WorkerToMainMessage } from "./protocol.js";

// Node-side coverage of the worker's pure routing/normalization. It deliberately never drives the
// `prime` path here: that dynamic-imports `@huggingface/transformers`, whose node entry pulls the
// onnxruntime-node native addon (build script unrun) — priming for real is the opt-in browser run,
// not this gate.

test("exports its subpath name", () => {
  expect(WORKER_ENTRY_NAME).toBe("@azx/ribo-transcriber-ondevice/worker");
});

test("normalizeProgress maps transformers.js statuses to the wire type", () => {
  expect(normalizeProgress({ status: "initiate", file: "config.json" })).toEqual({
    stage: "initiate",
    file: "config.json",
  });
  expect(
    normalizeProgress({
      status: "progress",
      file: "model.onnx",
      loaded: 10,
      total: 40,
      progress: 25,
    }),
  ).toEqual({ stage: "progress", file: "model.onnx", loaded: 10, total: 40, progress: 25 });
  expect(normalizeProgress({ status: "done", file: "model.onnx" })).toEqual({
    stage: "done",
    file: "model.onnx",
  });
});

test("normalizeProgress drops pipeline-level statuses that carry no file", () => {
  // `ready` fires once the whole pipeline is built; it is not a per-file datum, so it is not relayed.
  expect(normalizeProgress({ status: "ready" })).toBeNull();
});

test("normalizeProgress defaults missing byte counts to zero", () => {
  expect(normalizeProgress({ status: "progress", file: "x" })).toEqual({
    stage: "progress",
    file: "x",
    loaded: 0,
    total: 0,
    progress: 0,
  });
});

test("handleMessage ignores non-prime messages without touching transformers", async () => {
  const post = vi.fn();
  // A message the worker does not understand is a no-op — no reply, no dynamic import.
  await handleMessage({ type: "unknown" } as never, post);
  expect(post).not.toHaveBeenCalled();
});

/**
 * The chunking DECISION TREE — which of the four routes a recording takes. The segmentation maths
 * itself is proved in `segmentation.test.ts`; what is proved here is the routing around it.
 *
 * Every case below is one where no model loads, which is what makes it testable in node at all: a
 * path that reached the VAD would dynamic-import transformers.js and pull `onnxruntime-node`, whose
 * native addon is not built. That constraint is also what makes the first test meaningful — see it.
 */
describe("planChunks — routing", () => {
  const base = { modelId: "m", wasmPaths: "/ort/" } as const;
  const thirtySeconds = 30 * WHISPER_SAMPLE_RATE;

  test("empty audio plans nothing", async () => {
    await expect(planChunks({ ...base, vadModelId: "v" }, new Float32Array(0))).resolves.toEqual(
      [],
    );
  });

  test("audio at or under 30 s bypasses VAD ENTIRELY — one chunk, no model loaded", async () => {
    // The bypass is proved by the absence of a crash. A VAD model id IS configured here, so if the
    // 30 s check ran after the VAD call rather than before it, this would dynamic-import
    // transformers.js and blow up on the unbuilt onnxruntime-node addon. Resolving cleanly is the
    // assertion: the overwhelmingly common short-clip case never touches VAD, and none of VAD's
    // deletion risk applies to it.
    const config = { ...base, vadModelId: "onnx-community/pyannote-segmentation-3.0" };
    await expect(planChunks(config, new Float32Array(11 * WHISPER_SAMPLE_RATE))).resolves.toEqual([
      { start: 0, end: 11 * WHISPER_SAMPLE_RATE },
    ]);
    await expect(planChunks(config, new Float32Array(thirtySeconds))).resolves.toEqual([
      { start: 0, end: thirtySeconds },
    ]);
  });

  test("over 30 s with no VAD configured falls back to the fixed-window march", async () => {
    // A consumer who never configured VAD — and, at runtime, the user whose ASR weights were cached
    // before VAD shipped. They must still get their whole recording, not the first 30 seconds.
    const chunks = await planChunks(base, new Float32Array(120 * WHISPER_SAMPLE_RATE));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks[chunks.length - 1]!.end).toBe(120 * WHISPER_SAMPLE_RATE);
    for (const chunk of chunks) expect(chunk.end - chunk.start).toBeLessThanOrEqual(thirtySeconds);
  });

  test("a VAD that will not load costs the user nothing — the march covers it", async () => {
    // `vadModelId` set but unloadable (the dynamic import fails in node). The catch must swallow it
    // and fall through, because a broken optional model must never turn into lost audio.
    const chunks = await planChunks(
      { ...base, vadModelId: "definitely/not-a-real-model" },
      new Float32Array(120 * WHISPER_SAMPLE_RATE),
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[chunks.length - 1]!.end).toBe(120 * WHISPER_SAMPLE_RATE);
  });
});

describe("serialize — one inference at a time", () => {
  test("concurrent work does not interleave", async () => {
    // `handleMessage` does not await one request before starting the next, and the main thread
    // explicitly supports several outstanding correlated requests — so without this queue two
    // transcribes would interleave `generate()` against the one shared ORT session. Long audio makes
    // that window much wider, since one request now issues many passes instead of one.
    const events: string[] = [];
    const task = (name: string) => async (): Promise<void> => {
      events.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`${name}:end`);
    };

    await Promise.all([serialize(task("a")), serialize(task("b")), serialize(task("c"))]);

    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  test("a failed call does not poison the queue behind it", async () => {
    // The chain must absorb rejections, or one bad request would reject the shared promise and every
    // request queued after it would fail for a reason that has nothing to do with it.
    const failed = serialize(() => Promise.reject(new Error("boom")));
    await expect(failed).rejects.toThrow("boom");
    await expect(serialize(() => Promise.resolve("fine"))).resolves.toBe("fine");
  });
});

// `liveClose` and `liveFeed`-for-missing-session are safe to test in node: neither
// loads a model. `liveOpen` dynamic-imports `@huggingface/transformers` via
// `createSileroDetector` and is NOT tested here — that path is exercised by the
// manual browser test and the `live.test.ts` FakeWorker tests.

test("handleMessage for liveClose on a missing session is a silent no-op", async () => {
  clearLiveSessions();
  const post = vi.fn();
  await handleMessage({ type: "liveClose", sessionId: "no-such-session" }, post);
  expect(post).not.toHaveBeenCalled();
});

test("handleMessage for liveFeed on a missing session is a silent no-op", async () => {
  clearLiveSessions();
  const post = vi.fn();
  await handleMessage(
    { type: "liveFeed", sessionId: "no-such-session", frame: new Float32Array(512) },
    post,
  );
  // The feed calls vad.feed() which resolves on microtask; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(post).not.toHaveBeenCalled();
});

// ── Live session test helpers ─────────────────────────────────────────────────
//
// The tests below inject a fake session with a scripted region VAD and a controllable
// transcribe function. No model loads, no browser needed — the fake VAD returns
// deterministic RegionFrameResult values, and the fake transcribe returns deferreds
// the test resolves on its own schedule.

/** Concatenate frames into a single PCM buffer — mirrors vad-stream.ts's concatenateFrames. */
function concatFrames(frames: readonly Float32Array[]): Float32Array {
  const total = frames.reduce((sum, f) => sum + f.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

/** A deferred — a promise the test resolves on its own schedule. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A refresh result — the VAD detected a pause; re-transcribe the region. */
const REFRESH: RegionFrameResult = {
  refresh: true,
  commit: false,
  committedSamples: null,
  transcriptionSamples: null,
};

/** A "nothing happened" result — no refresh, no commit. */
const IDLE: RegionFrameResult = {
  refresh: false,
  commit: false,
  committedSamples: null,
  transcriptionSamples: null,
};

/**
 * A fake region VAD that accumulates frames and returns scripted results. Exposes
 * `samples` as the accumulated frames (matching `RegionVad.samples`). On a commit,
 * clears the buffer — simulating `RegionVad`'s buffer advance. `drain` returns and
 * clears the buffer.
 */
function makeFakeRegionVad(script: readonly RegionFrameResult[]): {
  feed: (frame: Float32Array) => Promise<RegionFrameResult>;
  drain: () => Promise<Float32Array>;
  readonly samples: Float32Array;
  speechSpanSamples: () => Float32Array | null;
} {
  let calls = 0;
  let frames: Float32Array[] = [];
  return {
    feed: (frame) => {
      frames.push(frame);
      const result = script[Math.min(calls++, script.length - 1)] ?? IDLE;
      if (result.commit) frames = [];
      return Promise.resolve(result);
    },
    drain: () => {
      const samples = concatFrames(frames);
      frames = [];
      return Promise.resolve(samples);
    },
    get samples() {
      return concatFrames(frames);
    },
    // The fake VAD does not trim — routing tests do not exercise the trimming logic.
    // Returns the full region so the worker's refresh path receives non-null samples.
    speechSpanSamples: () => concatFrames(frames),
  };
}

/** Wait for microtasks and the serialize chain to drain. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/** Collect posted messages into an array. */
function makePost(): {
  posts: WorkerToMainMessage[];
  post: (msg: WorkerToMainMessage) => void;
} {
  const posts: WorkerToMainMessage[] = [];
  return { posts, post: (msg) => posts.push(msg) };
}

// ── Test 1: a refresh posts a tail, a commit posts a commit ──────────────────

describe("Test 1 — refresh posts tail, commit posts commit", () => {
  test("a refresh produces a liveSegment with kind=tail, a commit with kind=commit", async () => {
    clearLiveSessions();
    const sessionId = "test-tail-commit";
    const { posts, post } = makePost();

    injectLiveSession(sessionId, {
      vad: makeFakeRegionVad([
        REFRESH,
        {
          refresh: false,
          commit: true,
          committedSamples: new Float32Array(512),
          transcriptionSamples: new Float32Array(512),
        },
      ]),
      transcribe: (samples) => Promise.resolve(`text-${samples.length}`),
      refreshInFlight: false,
    });

    // First feed: refresh → tail.
    await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
    await settle();

    // Second feed: commit → commit.
    await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
    await settle();

    const segments = posts.filter((m) => m.type === "liveSegment");
    expect(segments).toHaveLength(2);

    const tail = segments[0]!;
    expect(tail.type).toBe("liveSegment");
    if (tail.type === "liveSegment") expect(tail.kind).toBe("tail");

    const commit = segments[1]!;
    expect(commit.type).toBe("liveSegment");
    if (commit.type === "liveSegment") expect(commit.kind).toBe("commit");

    clearLiveSessions();
  });
});

// ── Test 2: a refresh during an in-flight transcription is skipped ───────────
//
// This is the test that proves load shedding never costs audio. A refresh
// transcription is in flight (pending deferred). A second frame arrives and the
// VAD reports a refresh — it is skipped because `refreshInFlight` is true. The
// region buffer is untouched, so the next refresh (after the in-flight
// transcription completes) transcribes the full region including the audio that
// arrived during the skip.

describe("Test 2 — refresh during in-flight is skipped, next refresh sees full region", () => {
  test("a refresh arriving while a transcription is in flight is skipped; the next refresh transcribes everything", async () => {
    clearLiveSessions();
    const sessionId = "test-load-shed";
    const { posts, post } = makePost();

    const transcribeCalls: Float32Array[] = [];
    const deferred1 = makeDeferred<string>();

    injectLiveSession(sessionId, {
      vad: makeFakeRegionVad([REFRESH, REFRESH, REFRESH]),
      transcribe: (samples) => {
        transcribeCalls.push(samples);
        if (transcribeCalls.length === 1) return deferred1.promise;
        return Promise.resolve(`tail-${samples.length}`);
      },
      refreshInFlight: false,
    });

    // Feed frame 1: refresh → transcribe starts (deferred1 pending).
    await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
    await settle();

    // The first transcribe was called and is pending. refreshInFlight is true.
    expect(transcribeCalls).toHaveLength(1);

    // Feed frame 2: refresh → skipped because refreshInFlight is true.
    await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
    await settle();

    // Still only one transcribe call — the second refresh was skipped.
    expect(transcribeCalls).toHaveLength(1);
    // No liveSegment posted yet — the first transcription is still pending.
    expect(posts.filter((m) => m.type === "liveSegment")).toHaveLength(0);

    // Resolve the first transcription → refreshInFlight = false → tail posted.
    deferred1.resolve("tail-1");
    await settle();

    const tailPosts = posts.filter((m) => m.type === "liveSegment");
    expect(tailPosts).toHaveLength(1);
    expect(tailPosts[0]!.type).toBe("liveSegment");
    if (tailPosts[0]!.type === "liveSegment") {
      expect(tailPosts[0]!.kind).toBe("tail");
      expect(tailPosts[0]!.text).toBe("tail-1");
    }

    // Feed frame 3: refresh → refreshInFlight is false → transcribe the full region.
    // The region includes frames 1, 2, and 3 (the fake VAD accumulated them all;
    // no commit cleared the buffer). This is the key assertion: audio that arrived
    // during the skip (frame 2) is included in the next refresh's transcription.
    await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
    await settle();

    expect(transcribeCalls).toHaveLength(2);
    // The second transcribe call received 3 frames' worth of samples (512 × 3 = 1536).
    expect(transcribeCalls[1]!.length).toBe(512 * 3);

    const allSegments = posts.filter((m) => m.type === "liveSegment");
    expect(allSegments).toHaveLength(2);
    if (allSegments[1]!.type === "liveSegment") {
      expect(allSegments[1]!.kind).toBe("tail");
      expect(allSegments[1]!.text).toBe(`tail-${512 * 3}`);
    }

    clearLiveSessions();
  });
});

// ── Test 3: a commit is never skipped ────────────────────────────────────────
//
// A commit's text is permanent, so skipping it would lose a region's text entirely.
// The committed samples are a snapshot taken at the commit boundary, so delaying
// the transcription does not change what it transcribes — but the transcription
// must still run. This test verifies that two commits in succession both produce
// transcribe calls and liveSegment posts, even when the first is still in flight
// when the second arrives.

describe("Test 3 — a commit is never skipped, even when one is in flight", () => {
  test("two commits in succession both transcribe and post", async () => {
    clearLiveSessions();
    const sessionId = "test-commit-no-skip";
    const { posts, post } = makePost();

    const transcribeCalls: Float32Array[] = [];
    const deferred1 = makeDeferred<string>();

    injectLiveSession(sessionId, {
      vad: makeFakeRegionVad([
        {
          refresh: false,
          commit: true,
          committedSamples: new Float32Array(512),
          transcriptionSamples: new Float32Array(512),
        },
        {
          refresh: false,
          commit: true,
          committedSamples: new Float32Array(512),
          transcriptionSamples: new Float32Array(512),
        },
      ]),
      transcribe: (samples) => {
        transcribeCalls.push(samples);
        if (transcribeCalls.length === 1) return deferred1.promise;
        return Promise.resolve(`commit-${transcribeCalls.length}`);
      },
      refreshInFlight: false,
    });

    // Feed frame 1: commit → transcribe starts (deferred1 pending).
    await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
    await settle();

    // The first commit's transcription is in flight.
    expect(transcribeCalls).toHaveLength(1);

    // Feed frame 2: commit → transcribeAsCommit is called (not skipped).
    // The serialize call chains behind the first, so the second transcribe
    // hasn't started yet — but transcribeAsCommit was called, which is the
    // point: a commit is never skipped.
    await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
    await settle();

    // Still only one transcribe call — the second is queued behind serialize.
    // But the second commit's transcribeAsCommit WAS called (serialize queued it).
    // If the commit had been skipped, resolving deferred1 would not produce a
    // second segment.
    expect(transcribeCalls).toHaveLength(1);

    // Resolve the first transcription → first commit posted, second starts.
    deferred1.resolve("commit-1");
    await settle();

    // Now the second commit's transcription has run.
    expect(transcribeCalls).toHaveLength(2);

    const commitPosts = posts.filter((m) => m.type === "liveSegment");
    expect(commitPosts).toHaveLength(2);
    for (const c of commitPosts) {
      expect(c.type).toBe("liveSegment");
      if (c.type === "liveSegment") expect(c.kind).toBe("commit");
    }
    if (commitPosts[0]!.type === "liveSegment") expect(commitPosts[0]!.text).toBe("commit-1");
    if (commitPosts[1]!.type === "liveSegment") expect(commitPosts[1]!.text).toBe("commit-2");

    clearLiveSessions();
  });
});

// ── Test 5: the commit queue is bounded (coalescing) ─────────────────────────
//
// `serialize` is a single unbounded promise chain. Without coalescing, every
// commit enqueues a separate closure and waits behind every earlier one — on a
// slow device the backlog compounds. This test drives commits faster than they
// drain (a `transcribe` that blocks on a deferred) and asserts the bound: at
// most one in-flight commit transcription + one coalesced pending buffer. No
// audio is lost — coalesced commits are merged and transcribed together.
//
// Removing the coalescing (always calling `transcribeAsCommit` per commit)
// turns this test red: after releasing the deferred, the unbounded queue would
// make one `transcribe` call per commit (5 total), not 2.

describe("Test 5 — the commit queue is bounded: coalescing prevents backlog", () => {
  test("commits arriving while one is in-flight coalesce into one pending buffer, not N queued calls", async () => {
    clearLiveSessions();
    const sessionId = "test-bounded-commit";
    const { posts, post } = makePost();

    const transcribeCalls: Float32Array[] = [];
    const deferred1 = makeDeferred<string>();

    // A commit result with 512-sample transcriptionSamples.
    const COMMIT_512: RegionFrameResult = {
      refresh: false,
      commit: true,
      committedSamples: new Float32Array(512),
      transcriptionSamples: new Float32Array(512),
    };

    injectLiveSession(sessionId, {
      vad: makeFakeRegionVad([COMMIT_512, COMMIT_512, COMMIT_512, COMMIT_512, COMMIT_512]),
      transcribe: (samples) => {
        transcribeCalls.push(samples);
        if (transcribeCalls.length === 1) return deferred1.promise;
        return Promise.resolve(`coalesced-${samples.length}`);
      },
      refreshInFlight: false,
    });

    // Feed 5 commits. The first starts transcribing (deferred1 pending).
    // Commits 2–5 must coalesce into pendingCommitSamples, NOT enqueue
    // separate serialize calls.
    for (let i = 0; i < 5; i++) {
      await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
      await settle();
    }

    // The bound: only ONE transcribe call — the first commit. The other four
    // coalesced into pendingCommitSamples instead of queuing four more
    // serialize entries. With the old unbounded code, this assertion would
    // still pass (serialize is sequential, so only the first transcribe has
    // started) — but the next assertion after release is what distinguishes.
    expect(transcribeCalls).toHaveLength(1);

    // Release the first transcription. The coalesced drain fires: the four
    // pending commits' samples (512 × 4 = 2048) are merged and transcribed
    // in ONE additional call, not four separate calls.
    deferred1.resolve("commit-1");
    await settle();

    // The bound holds: 2 transcribe calls total (1 in-flight + 1 coalesced),
    // NOT 5 (one per commit). This is the assertion that turns red if the
    // coalescing is removed.
    expect(transcribeCalls).toHaveLength(2);

    // No audio lost: the second call received all four coalesced commits'
    // samples concatenated (512 × 4 = 2048).
    expect(transcribeCalls[1]!.length).toBe(512 * 4);

    // Two commit segments posted: the first commit, then the coalesced rest.
    const commitPosts = posts.filter((m) => m.type === "liveSegment");
    expect(commitPosts).toHaveLength(2);
    for (const c of commitPosts) {
      expect(c.type).toBe("liveSegment");
      if (c.type === "liveSegment") expect(c.kind).toBe("commit");
    }
    if (commitPosts[0]!.type === "liveSegment") expect(commitPosts[0]!.text).toBe("commit-1");
    if (commitPosts[1]!.type === "liveSegment") {
      expect(commitPosts[1]!.text).toBe("coalesced-2048");
    }

    clearLiveSessions();
  });

  test("a third wave of commits arriving during the re-queued transcription also coalesces", async () => {
    clearLiveSessions();
    const sessionId = "test-bounded-commit-wave-3";
    const { posts, post } = makePost();

    const transcribeCalls: Float32Array[] = [];
    const deferred1 = makeDeferred<string>();
    const deferred2 = makeDeferred<string>();

    const COMMIT_512: RegionFrameResult = {
      refresh: false,
      commit: true,
      committedSamples: new Float32Array(512),
      transcriptionSamples: new Float32Array(512),
    };

    injectLiveSession(sessionId, {
      vad: makeFakeRegionVad(Array.from({ length: 8 }, () => COMMIT_512)),
      transcribe: (samples) => {
        transcribeCalls.push(samples);
        if (transcribeCalls.length === 1) return deferred1.promise;
        if (transcribeCalls.length === 2) return deferred2.promise;
        return Promise.resolve(`wave3-${samples.length}`);
      },
      refreshInFlight: false,
    });

    // Wave 1: feed 3 commits. First starts transcribing (deferred1).
    // Commits 2–3 coalesce.
    for (let i = 0; i < 3; i++) {
      await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
      await settle();
    }
    expect(transcribeCalls).toHaveLength(1);

    // Release wave 1 → re-queue with coalesced commits 2–3 (1024 samples).
    // The re-queued transcription blocks on deferred2.
    deferred1.resolve("commit-1");
    await settle();
    expect(transcribeCalls).toHaveLength(2);
    expect(transcribeCalls[1]!.length).toBe(512 * 2);

    // Wave 3: feed 3 more commits while the re-queued transcription is in-flight.
    // These must coalesce into pendingCommitSamples again.
    for (let i = 0; i < 3; i++) {
      await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
      await settle();
    }
    expect(transcribeCalls).toHaveLength(2);

    // Release wave 2 → re-queue with coalesced wave-3 commits (1536 samples).
    deferred2.resolve("coalesced-1024");
    await settle();

    // 3 transcribe calls total across 3 waves of coalescing — NOT 8.
    expect(transcribeCalls).toHaveLength(3);
    expect(transcribeCalls[2]!.length).toBe(512 * 3);

    const commitPosts = posts.filter((m) => m.type === "liveSegment");
    expect(commitPosts).toHaveLength(3);
    if (commitPosts[2]!.type === "liveSegment") {
      expect(commitPosts[2]!.text).toBe("wave3-1536");
    }

    clearLiveSessions();
  });
});

// ── Test 4: a transcription failure leaves the session alive ─────────────────
//
// A per-region transcription failure (OOM, ORT error) must not kill the session —
// the next region may transcribe fine. The error is posted as liveError, and
// refreshInFlight is reset so the next refresh can proceed. Against the old code
// (which deleted the session on any error), the second feed would no-op.

describe("Test 4 — a transcription failure leaves the session alive", () => {
  test("one refresh's transcription rejects, a later refresh still produces a tail", async () => {
    clearLiveSessions();
    const sessionId = "test-survive";
    const { posts, post } = makePost();

    let transcribeCalls = 0;
    injectLiveSession(sessionId, {
      vad: makeFakeRegionVad([REFRESH, REFRESH]),
      transcribe: () => {
        transcribeCalls++;
        if (transcribeCalls === 1) return Promise.reject(new Error("generate OOM"));
        return Promise.resolve("recovered tail");
      },
      refreshInFlight: false,
    });

    // First feed: refresh → transcribe rejects → liveError posted, session alive.
    await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
    await settle();

    const firstError = posts.find((m) => m.type === "liveError");
    expect(firstError?.type).toBe("liveError");
    if (firstError?.type === "liveError") expect(firstError.message).toBe("generate OOM");

    // Second feed: refresh → transcribe succeeds. Against the old code the session
    // was deleted on the first error, so this feed no-ops and no segment is posted.
    await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
    await settle();

    const segment = posts.find((m) => m.type === "liveSegment");
    expect(segment?.type).toBe("liveSegment");
    if (segment?.type === "liveSegment") {
      expect(segment.kind).toBe("tail");
      expect(segment.text).toBe("recovered tail");
    }

    clearLiveSessions();
  });

  test("a VAD failure is session-fatal — the session is deleted and later feeds no-op", async () => {
    clearLiveSessions();
    const sessionId = "test-vad-fatal";
    const { posts, post } = makePost();

    injectLiveSession(sessionId, {
      vad: {
        feed: () => Promise.reject(new Error("VAD model crashed")),
        drain: () => Promise.resolve(new Float32Array(0)),
        get samples() {
          return new Float32Array(0);
        },
        speechSpanSamples: () => null,
      },
      transcribe: () => Promise.resolve("never reached"),
      refreshInFlight: false,
    });

    // The VAD throws — session-fatal. The error is posted and the session is deleted.
    await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
    await settle();

    expect(posts.some((m) => m.type === "liveError")).toBe(true);

    // A later feed no-ops — the session was deleted, so the map lookup returns undefined.
    await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
    await settle();

    // Still only the one error from the VAD failure — no second error, no segment.
    expect(posts.filter((m) => m.type === "liveError")).toHaveLength(1);
    expect(posts.some((m) => m.type === "liveSegment")).toBe(false);

    clearLiveSessions();
  });
});

// ── Test 5: a liveClose before liveOpen completes still closes the session ────
//
// `handleMessage` is async and does not await `openLiveSession` (which loads the
// Silero model) before processing the next message. So a `liveClose` can arrive
// before the session is inserted into `liveSessions`. Without the pending-close
// mechanism, the close finds nothing, returns, and the open later inserts a
// session that can never be closed — leaking a RegionVad, a Silero detector, and
// the main thread's listener. This is not just a priming race: a user who stops
// recording immediately hits the same path.
//
// The test simulates the race: liveClose arrives (session missing → pending close
// recorded), then the open "completes" (session injected), then `processPendingClose`
// runs (as `openLiveSession` would call it after inserting). The session must be
// closed and `liveClosed` posted.

describe("Test 5 — liveClose before liveOpen completes still closes the session", () => {
  test("a pending close is processed when the open completes — no leak, liveClosed posted", async () => {
    clearLiveSessions();
    const sessionId = "test-race-close-before-open";
    const { posts, post } = makePost();

    // liveClose arrives before liveOpen has completed — session not in liveSessions.
    await handleMessage({ type: "liveClose", sessionId }, post);

    // No liveClosed posted yet — the open hasn't completed, so there is no
    // OnDeviceLiveSession listener to receive it.
    expect(posts.filter((m) => m.type === "liveClosed")).toHaveLength(0);

    // Simulate liveOpen completing — inject the session (as openLiveSession would
    // after createSileroDetector resolves). The fake VAD has no frames, so drain
    // returns empty samples.
    injectLiveSession(sessionId, {
      vad: makeFakeRegionVad([]),
      transcribe: () => Promise.resolve("never reached"),
      refreshInFlight: false,
    });

    // processPendingClose is what openLiveSession calls after inserting the
    // session and posting liveOpened. It sees the pending close and closes the
    // session immediately.
    processPendingClose(sessionId, post);
    await settle();

    // liveClosed was posted — the main thread can tear down its listener.
    expect(posts.filter((m) => m.type === "liveClosed")).toHaveLength(1);

    // The session was removed — no leak. A feed is a no-op (map lookup misses).
    await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
    await settle();
    expect(posts.filter((m) => m.type === "liveSegment")).toHaveLength(0);
    expect(posts.filter((m) => m.type === "liveError")).toHaveLength(0);

    clearLiveSessions();
  });
});

// ── Test 6: an empty transcription on a commit is recorded, not dropped ───────
//
// On a commit the region buffer has already advanced, so an empty ASR result
// means that audio's text is gone from the preview with no trace. The fix posts
// the empty commit segment so the host knows a commit happened, rather than the
// commit vanishing silently. The tail path still guards on `text.length > 0`
// (an empty tail just means "no speech yet" and posting it would clear the
// previous tail).

describe("Test 6 — an empty commit is posted, not silently dropped", () => {
  test("a commit with empty text produces a liveSegment with kind=commit and text=''", async () => {
    clearLiveSessions();
    const sessionId = "test-empty-commit";
    const { posts, post } = makePost();

    injectLiveSession(sessionId, {
      vad: makeFakeRegionVad([
        {
          refresh: false,
          commit: true,
          committedSamples: new Float32Array(512),
          transcriptionSamples: new Float32Array(512),
        },
      ]),
      transcribe: () => Promise.resolve(""),
      refreshInFlight: false,
    });

    await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
    await settle();

    const segments = posts.filter((m) => m.type === "liveSegment");
    expect(segments).toHaveLength(1);
    const seg = segments[0]!;
    expect(seg.type).toBe("liveSegment");
    if (seg.type === "liveSegment") {
      expect(seg.kind).toBe("commit");
      expect(seg.text).toBe("");
    }

    clearLiveSessions();
  });

  test("an empty tail is still dropped — only commits are always posted", async () => {
    clearLiveSessions();
    const sessionId = "test-empty-tail";
    const { posts, post } = makePost();

    injectLiveSession(sessionId, {
      vad: makeFakeRegionVad([REFRESH]),
      transcribe: () => Promise.resolve(""),
      refreshInFlight: false,
    });

    await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
    await settle();

    // No segment posted — empty tails are dropped (posting would clear the
    // previous tail, which is wrong when the region simply has no speech yet).
    expect(posts.filter((m) => m.type === "liveSegment")).toHaveLength(0);

    clearLiveSessions();
  });
});

// ── Test 7: coalesced buffer exceeding the model's 30s window is split ────────
//
// The coalescing fix (Test 5) bounds queue DEPTH but not buffer SIZE —
// pendingCommitSamples grows by unbounded concatenation, so three backed-up
// 30s regions become a single 90s transcription call that exceeds the model's
// input window. transcribeBounded reuses planFallbackChunks to split the
// coalesced buffer into ≤ 30s windows, transcribing each separately and joining
// the text. No audio's text is dropped.

describe("Test 7 — coalesced commit buffer exceeding the 30s window is split", () => {
  const CAP_SAMPLES = 30 * WHISPER_SAMPLE_RATE;

  /** Fill samples with their global index so the fake transcribe can report which range it saw. */
  function makeIndexedSamples(start: number, length: number): Float32Array {
    const s = new Float32Array(length);
    for (let i = 0; i < length; i++) s[i] = start + i;
    return s;
  }

  test("a coalesced buffer longer than the cap is transcribed in multiple calls, text covers all audio", async () => {
    clearLiveSessions();
    const sessionId = "test-cap-split";
    const { posts, post } = makePost();

    const transcribeCalls: { length: number; first: number; last: number }[] = [];
    const deferred1 = makeDeferred<string>();

    const commitResult = (offset: number): RegionFrameResult => ({
      refresh: false,
      commit: true,
      committedSamples: new Float32Array(512),
      transcriptionSamples: makeIndexedSamples(offset, CAP_SAMPLES),
    });

    let callCount = 0;
    injectLiveSession(sessionId, {
      vad: makeFakeRegionVad([
        commitResult(0),
        commitResult(CAP_SAMPLES),
        commitResult(CAP_SAMPLES * 2),
      ]),
      transcribe: (samples) => {
        callCount++;
        const record = {
          length: samples.length,
          first: samples[0] ?? 0,
          last: samples[samples.length - 1] ?? 0,
        };
        transcribeCalls.push(record);
        if (callCount === 1) return deferred1.promise;
        return Promise.resolve(`[${record.first},${record.last}]`);
      },
      refreshInFlight: false,
    });

    // Feed 3 commits (30s each). First starts transcribing (deferred1 pending).
    // Commits 2-3 coalesce into pendingCommitSamples (60s).
    for (let i = 0; i < 3; i++) {
      await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
      await settle();
    }
    expect(transcribeCalls).toHaveLength(1);

    // Release → first commit posted, re-queue transcribes coalesced 60s in 3 chunks.
    deferred1.resolve("[0,479999]");
    await settle();

    // 4 calls total: 1 for the first commit (30s, 1 chunk), 3 for the coalesced 60s.
    expect(transcribeCalls).toHaveLength(4);

    // Every call received at most the cap.
    for (const call of transcribeCalls) {
      expect(call.length).toBeLessThanOrEqual(CAP_SAMPLES);
    }

    // The coalesced buffer (calls 2-4) covers the full range [CAP_SAMPLES, CAP_SAMPLES*3-1].
    expect(transcribeCalls[1]!.first).toBe(CAP_SAMPLES);
    expect(transcribeCalls[3]!.last).toBe(CAP_SAMPLES * 3 - 1);

    // The posted text for the coalesced segment covers the full range — no text lost.
    const commitPosts = posts.filter((m) => m.type === "liveSegment");
    expect(commitPosts).toHaveLength(2);
    if (commitPosts[1]!.type === "liveSegment") {
      const text = commitPosts[1]!.text;
      expect(text).toContain(`[${CAP_SAMPLES},`);
      expect(text).toContain(`,${CAP_SAMPLES * 3 - 1}]`);
    }

    clearLiveSessions();
  });

  test("the cap holds — no single call exceeds the cap, however many commits back up", async () => {
    clearLiveSessions();
    const sessionId = "test-cap-holds";
    const { posts, post } = makePost();

    const transcribeLengths: number[] = [];
    const deferred1 = makeDeferred<string>();

    const commitResult = (): RegionFrameResult => ({
      refresh: false,
      commit: true,
      committedSamples: new Float32Array(512),
      transcriptionSamples: new Float32Array(CAP_SAMPLES),
    });

    let callCount = 0;
    injectLiveSession(sessionId, {
      vad: makeFakeRegionVad(Array.from({ length: 5 }, () => commitResult())),
      transcribe: (samples) => {
        callCount++;
        transcribeLengths.push(samples.length);
        if (callCount === 1) return deferred1.promise;
        return Promise.resolve(`text-${samples.length}`);
      },
      refreshInFlight: false,
    });

    // Feed 5 commits (30s each). First starts transcribing (deferred1 pending).
    // Commits 2-5 coalesce into pendingCommitSamples (120s).
    for (let i = 0; i < 5; i++) {
      await handleMessage({ type: "liveFeed", sessionId, frame: new Float32Array(512) }, post);
      await settle();
    }
    expect(transcribeLengths).toHaveLength(1);

    // Release → re-queue transcribes coalesced 120s in multiple chunks.
    deferred1.resolve("first");
    await settle();

    // Multiple calls (1 for the first commit + several for the coalesced 120s).
    expect(transcribeLengths.length).toBeGreaterThan(1);

    // THE CAP: no single transcription call exceeds 480000 samples.
    for (const length of transcribeLengths) {
      expect(length).toBeLessThanOrEqual(CAP_SAMPLES);
    }

    clearLiveSessions();
  });
});
