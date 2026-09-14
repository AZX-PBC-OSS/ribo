import type { CaptureItem } from "./capture-item.js";
import type { Transcript } from "./transcript.js";
import {
  applyTranscriptionVerdict,
  type TranscriptionArbiter,
  type TranscriptionArbiterInput,
  type TranscriptionOutcome,
} from "./transcription-arbitration.js";
import type { Transcriber, TranscriberCapability } from "./transcriber.js";

/**
 * @file `fallbackTranscriber` — try transcribers in order and let an arbiter
 * decide whether to accept the outcome, try the next candidate, or give up.
 *
 * This is the per-item sibling of `firstCapable`: where `firstCapable` selects
 * on `capability()` (engine-level, cannot express "this engine cannot read
 * _this item_"), `fallbackTranscriber` calls candidates in order **without
 * consulting `capability()` at all** and lets a caller-supplied arbiter decide
 * from the settled outcomes. That is the distinguishing property; a reader who
 * thinks it is "firstCapable with retries" will wire it wrongly.
 *
 * A sibling of {@link ./fallback-extractor.ts | fallbackExtractor}, not a
 * generalisation of the extractor engine. See the document-transcription plan
 * Task 4's Intent for the three-part argument for why a sibling is the right
 * call.
 */

export interface FallbackTranscriberOptions {
  /** `Transcriber.engine` for the composite itself. Defaults to `"fallback"`. */
  readonly engine?: string;
}

/**
 * Try a list of transcribers in order, asking the arbiter after each one
 * settles whether to accept, continue, or give up.
 *
 * Candidates are a bare `readonly Transcriber<S>[]` — a `Transcriber` already
 * carries `.engine`, and a wrapper would be a second place for the same id to
 * live. Duplicate engine ids are refused at construction, as `firstCapable`
 * refuses them.
 *
 * The arbiter is a **required** argument, as `fallbackExtractor`'s is, so the
 * policy is chosen by name rather than inherited by omission.
 *
 * Nothing is stamped onto the result. `Transcript.engine` is already required
 * and set by the implementation that ran, so "which one did?" is answerable off
 * `Outbox.list()` for free. The returned transcript is returned as-is, never
 * re-stamped with the wrapper's own engine id.
 *
 * `capability()` on the composite reports the **best** of its delegates, with
 * `firstCapable`'s precedence (`ready` beats `needs-download` beats
 * `unavailable`, first in order within a tier).
 */
export function fallbackTranscriber<S extends CaptureItem = CaptureItem>(
  transcribers: readonly Transcriber<S>[],
  arbiter: TranscriptionArbiter,
  options?: FallbackTranscriberOptions,
): Transcriber<S> {
  if (transcribers.length === 0) {
    throw new TypeError("fallbackTranscriber requires at least one transcriber");
  }
  const seen = new Set<string>();
  for (const transcriber of transcribers) {
    if (seen.has(transcriber.engine)) {
      throw new TypeError(`fallbackTranscriber: duplicate engine id "${transcriber.engine}"`);
    }
    seen.add(transcriber.engine);
  }

  const engine = options?.engine ?? "fallback";

  return {
    engine,
    capability: async (): Promise<TranscriberCapability> => {
      const reports: { engine: string; capability: TranscriberCapability }[] = [];
      for (const transcriber of transcribers) {
        reports.push({ engine: transcriber.engine, capability: await probe(transcriber) });
      }
      for (const status of ["ready", "needs-download"] as const) {
        const match = reports.find((report) => report.capability.status === status);
        if (match) return match.capability;
      }
      return reports[0]!.capability;
    },
    transcribe: async (item: S, bytes: Blob): Promise<Transcript> => {
      const outcomes: TranscriptionOutcome[] = [];

      let index = 0;
      for (const transcriber of transcribers) {
        const isLast = index === transcribers.length - 1;
        index += 1;

        try {
          const transcript = await transcriber.transcribe(item, bytes);
          outcomes.push({ candidate: transcriber.engine, result: transcript });
        } catch (error) {
          outcomes.push({ candidate: transcriber.engine, error });
        }

        const input: TranscriptionArbiterInput = { outcomes, exhausted: isLast };
        const result = applyTranscriptionVerdict(arbiter(input), input, arbiter);
        if (result !== "continue") return result;
      }

      // Every candidate is settled, yet the loop did not return. This is a
      // safety net for an arbiter that returned `continue` at the last call
      // without being caught above — which should not happen, but naming the
      // arbiter here keeps the failure diagnosable.
      const input: TranscriptionArbiterInput = { outcomes, exhausted: true };
      const result = applyTranscriptionVerdict(arbiter(input), input, arbiter);
      if (result !== "continue") return result;
      throw new TypeError(
        `arbiter ${arbiter.name || "(anonymous)"} returned continue at exhaustion`,
      );
    },
  };
}

/** A probe is not permitted to take the caller down; a thrown probe is unavailable. */
async function probe(transcriber: {
  capability: () => Promise<TranscriberCapability>;
}): Promise<TranscriberCapability> {
  try {
    return await transcriber.capability();
  } catch (error) {
    return {
      status: "unavailable",
      reason: "unknown",
      detail: `capability probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
