/**
 * The runnable example behind docs/api/composing-transcribers.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: every engine is a `FakeTranscriber`.
 */

import assert from "node:assert/strict";
import {
  DEFAULT_CAPABILITY_TTL_MS,
  DEFAULT_HEDGE_BUDGET_MS,
  DEFAULT_HEDGE_FACTOR,
  DEFAULT_HEDGE_FLOOR_MS,
  type CapturePayload,
  type DocumentCapture,
  FakeTranscriber,
  fallbackTranscriber,
  firstCapable,
  hedgeDelay,
  hedgedTranscriber,
  type AudioCapture,
  restrictToKind,
  unsupportedFallsThrough,
  UnsupportedItemError,
} from "@azx/ribo-core";

function recording(id: string): AudioCapture {
  return {
    id,
    capturedAt: new Date().toISOString(),
    kind: "audio",
    durationMs: 96_000,
    mimeType: "audio/webm",
    ctx: {},
  };
}

function document(id: string): DocumentCapture {
  return {
    id,
    capturedAt: new Date().toISOString(),
    kind: "document",
    pageCount: 2,
    mimeType: "application/pdf",
    ctx: {},
  };
}

const audio = (): Blob => new Blob(["not really audio"], { type: "audio/webm" });

export async function firstCapableTakesTheFirstReadyEngineAndReportsSkips(): Promise<void> {
  // #region usage
  const onDevice = new FakeTranscriber({ engine: "fake-ondevice", text: "from the device" });
  const managed = new FakeTranscriber({ engine: "fake-managed", text: "from the cloud" });
  onDevice.setCapability({
    status: "needs-download",
    downloadBytes: 253_000_000,
    detail: "moonshine-base",
  });

  const fallbacks: unknown[] = [];
  const composite = firstCapable([onDevice, managed], {
    onFallback: (event) => fallbacks.push(event),
  });
  const transcript = await composite.transcribe(recording("cap-1"), audio());
  // #endregion usage

  // needs-download is never selected (rule 2): the ready engine ran instead.
  assert.equal(transcript.text, "from the cloud");
  assert.equal(transcript.engine, "fake-managed");
  assert.equal(fallbacks.length, 1);
  const event = fallbacks[0] as { skipped: { engine: string }[]; selected: string };
  assert.equal(event.skipped[0]?.engine, "fake-ondevice");
  assert.equal(event.selected, "fake-managed");
}

export async function anAttemptFailurePropagatesInsteadOfFallingThrough(): Promise<void> {
  const onDevice = new FakeTranscriber({ engine: "fake-ondevice" });
  const managed = new FakeTranscriber({ engine: "fake-managed", text: "from the cloud" });
  // An ordinary error — this clip OOMed — is an attempt failure, and rule 5
  // lets it straight through: one bad clip never demotes a device to the cloud.
  onDevice.failWith(new Error("out of memory"));

  const composite = firstCapable([onDevice, managed]);
  await assert.rejects(composite.transcribe(recording("cap-1"), audio()), /out of memory/);
  // The fallback engine was never asked.
  assert.equal(managed.calls.length, 0);
}

export async function hedgedRacesAFallbackOnALatencyBudget(): Promise<void> {
  const primary = new FakeTranscriber({ engine: "fake-primary", text: "from the device" });
  const hedge = new FakeTranscriber({ engine: "fake-hedge", text: "from the cloud" });

  // The timer is injected and never fired: the primary wins the race, and the
  // test observes when the hedge *would* have fired.
  let fireHedge: (() => void) | undefined;
  let hedgedAt: number | undefined;
  const composite = hedgedTranscriber(primary, hedge, {
    delay: hedgeDelay({ predictedDurationMs: () => 10_000 }),
    scheduleTimer: (fn, delayMs) => {
      hedgedAt = delayMs;
      fireHedge = fn;
      return () => undefined;
    },
  });

  const transcript = await composite.transcribe(recording("cap-2"), audio());

  // Rule 1: the primary resolved inside the budget — the hedge never ran and
  // no audio left the device.
  assert.equal(transcript.engine, "fake-primary");
  assert.equal(hedge.calls.length, 0);
  // A 10 s prediction at the default factor hedges at 15 s, inside the clamp.
  assert.equal(hedgedAt, 15_000);
  assert.ok(fireHedge);
}

export async function withoutAPredictionTheHedgeWaitsTheFullBudget(): Promise<void> {
  let hedgedAt: number | undefined;
  const composite = hedgedTranscriber(
    new FakeTranscriber({ engine: "fake-primary", text: "from the device" }),
    new FakeTranscriber({ engine: "fake-hedge", text: "from the cloud" }),
    {
      // No calibration yet: undefined prediction.
      delay: hedgeDelay({ predictedDurationMs: () => undefined }),
      scheduleTimer: (_fn, delayMs) => {
        hedgedAt = delayMs;
        return () => undefined;
      },
    },
  );

  await composite.transcribe(recording("cap-2"), audio());
  assert.equal(hedgedAt, DEFAULT_HEDGE_BUDGET_MS);
}

export async function fallbackTranscriberLetsAnArbiterDecide(): Promise<void> {
  // A ladder over both capture kinds is a ladder of Transcriber<CapturePayload>.
  const pdfjs = new FakeTranscriber<CapturePayload>({ engine: "fake-pdfjs", text: "" });
  // A scanned PDF this engine cannot read — an item unsuitability, not an
  // attempt failure, so the arbiter routes to the next rung.
  pdfjs.failWithUnsupported("no-text-layer", "no text layer");
  const managedDocs = new FakeTranscriber<CapturePayload>({
    engine: "fake-managed-docs",
    text: "Page 1 — home inspection report",
  });

  // #region usage
  const ladder = fallbackTranscriber([pdfjs, managedDocs], unsupportedFallsThrough);
  const transcript = await ladder.transcribe(document("cap-doc"), new Blob(["%PDF-1.7 …"]));
  // #endregion usage

  assert.equal(transcript.text, "Page 1 — home inspection report");
  assert.equal(transcript.engine, "fake-managed-docs");
}

export async function restrictToKindRefusesTheOtherKindAndDelegatesItsOwn(): Promise<void> {
  const audioEngine = new FakeTranscriber({ engine: "fake-audio", text: "from the device" });
  const lifted = restrictToKind("audio", audioEngine);

  await assert.rejects(
    lifted.transcribe(document("cap-doc"), new Blob(["%PDF-1.7 …"])),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedItemError);
      assert.equal(error.reason, "unsupported-format");
      return true;
    },
  );

  const transcript = await lifted.transcribe(recording("cap-1"), audio());
  assert.equal(transcript.engine, "fake-audio");
}

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // The exported defaults, read from
  // packages/ribo-core/src/transcription/hedged-transcriber.ts and first-capable.ts. The
  // page quotes these values in prose next to this region; a source change
  // that moved one fails here.
  assert.equal(DEFAULT_HEDGE_FACTOR, 1.5);
  assert.equal(DEFAULT_HEDGE_FLOOR_MS, 2_000);
  assert.equal(DEFAULT_HEDGE_BUDGET_MS, 30_000);
  assert.equal(DEFAULT_CAPABILITY_TTL_MS, 30_000);
}
// #endregion defaults
