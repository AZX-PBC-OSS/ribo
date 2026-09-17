/**
 * @file `threePhaseExtractor` — the on-device preset over `phasedExtractor`:
 * presence → span → classify → classify-wrapped, four phases at `concurrency: 1`
 * so the device still sees one call at a time.
 *
 * Ported from `spikes/ondevice-acceptance/three-phase.ts`. The measurement that
 * picked this strategy is in
 * `docs/implementation/19-ondevice-extraction-strategies.md`: splitting extraction
 * into presence, span, and classify calls eliminated the degenerate whitespace
 * loop that retries could not fix, and adding unconditional span grounding took
 * source-span fidelity to 100%.
 *
 * The strategy is intentionally adapter-agnostic: it reads the grouped schema from
 * {@link ExtractionTarget.extractionSchema} and never imports a host-tool adapter.
 *
 * Since Wave 6 this file is only the preset — the scheduling, retry, abort,
 * deadline, unit stream, usage accumulation and closing trust-boundary parse are
 * the engine's (`phasedExtractor`), and the phases themselves live in
 * `phases/presence-phase.ts`, `phases/span-phase.ts` and `phases/classify-phase.ts`.
 * What stays here is the schema walk and the two numbers that keep the strategy's
 * retries alive:
 *
 * - **`perCallCeilingMs` is device-sized.** The engine default is 120 s, sized for
 *   a managed structured-output call; the on-device transport's own bound is
 *   `DEFAULT_DEVICE_PROMPT_DEADLINE_MS` (15 s). With the managed ceiling, a
 *   classify phase of a dozen-plus leaves at `concurrency: 1` derives to zero
 *   retries against any plausible share of the step timeout — against today's
 *   fixed three. `retry-budget.ts` already warns that an on-device preset must
 *   lower the ceiling or derive to zero.
 * - **`delay` is zero.** `ondevice-extraction-design.md` records, as a surviving
 *   lesson from a retired strategy, that backing off is wrong for a degenerate
 *   loop — "it should retry immediately" — which is why the old loops had no
 *   delay at all. The engine's default is `fullJitterDelay`, and on a transport
 *   whose calls complete in seconds the backoff would dominate the run.
 */

import { z } from "zod";

import { phasedExtractor } from "@azx/ribo-core";
import type {
  Enveloped,
  Extractor,
  ExtractionObserver,
  ExtractionTarget,
  NoProvenance,
  PhaseUnit,
} from "@azx/ribo-core";

import type { CapableChatClient } from "@azx/ribo-extractor-openai";

import { classifyPhase, classifyWrappedPhase } from "./phases/classify-phase.js";
import { extractGroups } from "./phases/presence-phase.js";
import { presencePhase } from "./phases/presence-phase.js";
import { spanPhase } from "./phases/span-phase.js";
import { DEFAULT_DEVICE_PROMPT_DEADLINE_MS } from "./ondevice-chat.js";

/** Default retry budget for a single call, matching the spike. */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * The on-device preset's delay: retry immediately, never back off. See the file
 * header — the engine's `fullJitterDelay` default would dominate a run whose
 * calls complete in seconds.
 */
const immediateDelay = (): Promise<void> => Promise.resolve();

export interface ThreePhaseExtractorOptions<
  V extends Record<string, unknown>,
  P = NoProvenance,
> extends ExtractionObserver<PhaseUnit> {
  /** The field knowledge: the extraction schema drives all four phases. */
  readonly target: ExtractionTarget<V, P>;
  /** The on-device chat transport. */
  readonly chat: CapableChatClient;
  /** Max retries per model call. Defaults to `DEFAULT_MAX_RETRIES`. */
  readonly maxRetries?: number;
}

/**
 * Build the three-phase on-device {@link Extractor} — four phases over the
 * generic engine, run phase-major: every group's presence call, then every
 * group's span call, then every grounded leaf's classify, then the wrapped
 * pass over whatever the transport could not answer bare.
 *
 * Phase 0 asks, per group, which leaves are discussed at all. Phase 1 asks for
 * verbatim quotes only for the phase-0-true leaves. Phase 2 classifies each
 * grounded quote into the leaf's value. Leaves whose phase-1 span is not a
 * verbatim substring of the transcript are dropped unconditionally. Phase 3
 * re-asks the leaves the transport reported `unsupported` for, over a wrapped
 * schema.
 */
export function threePhaseExtractor<V extends Record<string, unknown>, P = NoProvenance>(
  options: ThreePhaseExtractorOptions<V, P>,
): Extractor<Enveloped<V, P>> {
  const { target, chat, maxRetries = DEFAULT_MAX_RETRIES, onUnit } = options;
  const schema = z.toJSONSchema(target.extractionSchema, { target: "draft-2020-12" });
  const groups = extractGroups(schema);
  if (groups.length === 0) {
    throw new Error("threePhaseExtractor: no groups found in extraction schema");
  }
  // The on-device chat transport ignores the model id, but ChatRequest requires one.
  const model = chat.engine;

  return phasedExtractor<V, P>({
    target,
    phases: [
      presencePhase<V, P>({ groups, chat, model }),
      spanPhase<V, P>({ groups, chat, model }),
      classifyPhase<V, P>({ groups, chat, model }),
      classifyWrappedPhase<V, P>({ groups, chat, model }),
    ],
    // One model session: it does not benefit from parallel calls, and the device
    // still sees one request at a time.
    concurrency: 1,
    maxRetries,
    perCallCeilingMs: DEFAULT_DEVICE_PROMPT_DEADLINE_MS,
    delay: immediateDelay,
    onUnit,
  });
}
