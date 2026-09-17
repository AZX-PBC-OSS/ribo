import { nextUnitId } from "./extraction-observer.js";
import type { ExtractionObserver, PhaseUnit } from "./extraction-observer.js";
import type { AnnotatedTranscript } from "./annotated-transcript.js";
import type {
  ExtractOptions,
  Extractor,
  ExtractionResult,
  ExtractionTarget,
  ExtractionUsage,
} from "./extractor.js";
import type { Enveloped, NoProvenance } from "./enveloped.js";
import { mapWithPool } from "./map-with-pool.js";
import { parseWithSchema } from "./parse-with-schema.js";
import type { DeepPartial } from "./phase-draft.js";
import { emptyDraft } from "./phase-draft.js";
import type { Phase, PhaseContext, PhaseDef } from "./phase.js";
import type { PhaseItemOutcome as Outcome } from "./phase-outcome.js";
import type { BackoffOptions } from "./queue/backoff.js";
import type { RetryBudgetObserver } from "./retry-budget.js";
import { validatePhases } from "./validate-phases.js";

/**
 * @file `phasedExtractor` — the combinator that runs a list of phases. It owns everything
 * that is not "what to ask": scheduling, retry, abort, the running deadline, the unit
 * stream, usage accumulation and the closing trust-boundary parse.
 *
 * Wave 3a landed the vocabulary; this engine runs it. Phases execute in order; items
 * within a phase fan out through the existing `mapWithPool`. The draft a phase reads is
 * the one the previous `merge` returned — `merge` owns every write, so items within a
 * phase can run concurrently without racing.
 *
 * What this deliberately does NOT do (yet — the tasks build the spine first): per-item
 * retry, the failure policies, the running deadline and the per-phase retry budget land
 * in the tasks after this one; the spine validates at construction, runs phases in
 * order, fans items out, merges, normalizes once and parses once.
 */

export interface PhasedExtractorOptions<V extends Record<string, unknown>, P = NoProvenance>
  extends BackoffOptions, ExtractionObserver<PhaseUnit>, RetryBudgetObserver {
  /**
   * The field knowledge the whole extraction is pinned to: the merged draft's fields are
   * normalized and then parsed against `extractionSchema` (the trust boundary).
   */
  readonly target: ExtractionTarget<V, P>;
  /** The phases to run, in order. Validated at construction — see `validatePhases`. */
  readonly phases: readonly Phase<V, P>[];
  /**
   * The deterministic, model-free pass run once after the last merge and before the
   * closing parse — on the MERGED FIELDS, which at that point are still the draft's
   * deep partial. Runs once across the whole shape; running it per phase would run it
   * on partial shapes for no benefit.
   */
  readonly normalize?: (fields: DeepPartial<Enveloped<V, P>>) => DeepPartial<Enveloped<V, P>>;
  /**
   * Max concurrent items per phase — the run-level default a phase inherits when it
   * declares none. Defaults to 4, matching `groupedExtractor`.
   */
  readonly concurrency?: number;
  /**
   * Max retries per item after a transient failure (so the total attempts per item is
   * `maxRetries + 1`). Defaults to 2, matching `GroupedExtractorOptions`. A phase may
   * declare its own — see `PhaseMeta.maxRetries`.
   */
  readonly maxRetries?: number;
  /**
   * The relay's step timeout, used to derive the per-phase retry budget. Defaults to
   * `900_000` (15 minutes), matching the relay's `DEFAULT_STEP_TIMEOUT_MS`.
   */
  readonly stepTimeoutMs?: number;
  /**
   * Conservative upper bound on ONE item's `run` wall-clock duration, used to derive
   * the retry budget. Defaults to `PER_CALL_CEILING_MS` (120,000 ms).
   */
  readonly perCallCeilingMs?: number;
  /**
   * Injectable sleep used between retry attempts, so tests do not wait real seconds.
   * Defaults to a `setTimeout`-backed sleep, matching `grouped-extractor.ts`'s default.
   */
  readonly delay?: (ms: number) => Promise<void>;
  /** Injectable clock in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Running usage totals for the run, plus the one required `calls` count. */
interface UsageTotals {
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
  cacheCreationPromptTokens?: number;
}

/** Running usage state for one extraction: the required `calls` count and the tokens. */
interface UsageAccumulator {
  totalCalls: number;
  totals: UsageTotals;
}

/** Add one item output's usage into the running totals, ignoring what it omits. */
function addPhaseOutputUsage(acc: UsageAccumulator, usage: ExtractionUsage): void {
  acc.totalCalls += usage.calls;
  if (usage.promptTokens !== undefined) {
    acc.totals.promptTokens = (acc.totals.promptTokens ?? 0) + usage.promptTokens;
  }
  if (usage.completionTokens !== undefined) {
    acc.totals.completionTokens = (acc.totals.completionTokens ?? 0) + usage.completionTokens;
  }
  if (usage.cachedPromptTokens !== undefined) {
    acc.totals.cachedPromptTokens = (acc.totals.cachedPromptTokens ?? 0) + usage.cachedPromptTokens;
  }
  if (usage.cacheCreationPromptTokens !== undefined) {
    acc.totals.cacheCreationPromptTokens =
      (acc.totals.cacheCreationPromptTokens ?? 0) + usage.cacheCreationPromptTokens;
  }
}

/**
 * Build a {@link phasedExtractor} over a list of phases.
 *
 * On each `extract`:
 *   1. Run the phases in order. Each phase's `plan` is called with the draft as the
 *      previous `merge` returned it; its items fan out through `mapWithPool` at the
 *      phase's own concurrency or the run default.
 *   2. Each item's `run` receives the caller's signal combined with the phase pool's
 *      own sibling-abort controller via `AbortSignal.any` — never one or the other.
 *      With only the caller's signal, a sibling abort is invisible to an in-flight
 *      `run`; with only the pool's, a caller cancelling mid-phase never reaches the
 *      `run`s. `grouped-extractor.ts` does exactly this and documents the trap.
 *   3. Fold each phase's outcomes back in with that phase's `merge` — it owns every
 *      write to the draft and interprets each outcome.
 *   4. **Normalize once** on the merged fields, **then the trust-boundary parse**
 *      against the full `extractionSchema`, then assemble the result — usage summed
 *      from every `PhaseOutput`, `raw` from the draft when present, and
 *      `statedEmptyGroups` omitted entirely when empty, because `extractor.ts`
 *      documents its absence as meaning "this extractor ran no roster pass".
 */
export function phasedExtractor<V extends Record<string, unknown>, P = NoProvenance>(
  options: PhasedExtractorOptions<V, P>,
): Extractor<Enveloped<V, P>> {
  const { target, phases, normalize = (fields) => fields, concurrency = 4, onUnit } = options;

  // A mis-wired list must fail before any call is paid for.
  validatePhases(phases);

  return {
    async extract(
      transcript: AnnotatedTranscript,
      callerOptions?: ExtractOptions,
    ): Promise<ExtractionResult<Enveloped<V, P>>> {
      const callerSignal = callerOptions?.signal;
      const acc: UsageAccumulator = { totalCalls: 0, totals: {} };
      let draft = emptyDraft<V, P>();

      for (let pass = 0; pass < phases.length; pass++) {
        const phase = phases[pass]!;
        // One controller per phase: each phase is its own pool invocation with its own
        // sibling-abort controller, so one phase's failure never leaks into another
        // phase's pool state.
        const abort = new AbortController();
        // The caller's signal and this phase's sibling-failure controller are two
        // independent reasons to stop. Combine them with AbortSignal.any — `??` would
        // substitute one for the other, silently disabling sibling abort whenever a
        // caller supplied a signal, and dropping caller cancellation whenever it did not.
        const effectiveSignal = callerSignal
          ? AbortSignal.any([callerSignal, abort.signal])
          : abort.signal;
        const ctx: PhaseContext<V, P> = {
          transcript,
          target,
          signal: effectiveSignal,
          deadline: callerOptions?.deadline,
        };

        // Consumption of a Phase is Rank-2: I and C are bound but anonymous inside
        // this callback, so all of the phase's per-item work happens here. The
        // callback may be async — `with` returns its R either way.
        draft = await phase.with(async <I, C>(def: PhaseDef<V, P, I, C>) => {
          const items = def.plan(draft, ctx);
          // An empty plan is a no-op: no call, no event, no usage change.
          if (items.length === 0) return draft;

          const outcomes = await mapWithPool(
            items,
            def.concurrency ?? concurrency,
            async (item): Promise<Outcome<I, C>> => {
              // Mint one id per item, before any attempt — stable across the item's
              // retries once they exist, so a consumer correlates start/done/error.
              const id = nextUnitId();
              onUnit?.({
                id,
                unit: "phase",
                phase: "start",
                // No retries yet — the attempt is fixed at 1 until the retry task.
                attempt: 1,
                pass,
                phaseId: def.id,
                key: "",
              });
              try {
                const output = await def.run(item, draft, ctx);
                onUnit?.({
                  id,
                  unit: "phase",
                  phase: "done",
                  attempt: 1,
                  pass,
                  phaseId: def.id,
                  key: "",
                });
                return { outcome: "result", item, output };
              } catch (cause) {
                onUnit?.({
                  id,
                  unit: "phase",
                  phase: "error",
                  attempt: 1,
                  pass,
                  phaseId: def.id,
                  key: "",
                  error: cause,
                });
                throw cause;
              }
            },
            abort,
          );

          for (const outcome of outcomes) {
            if (outcome.outcome === "result" && outcome.output.usage !== undefined) {
              addPhaseOutputUsage(acc, outcome.output.usage);
            }
          }
          return def.merge(draft, outcomes);
        });
      }

      // Normalize once, on the merged fields, before the trust-boundary parse.
      const normalized = normalize(draft.fields);
      const parsed = parseWithSchema(
        target.extractionSchema,
        normalized,
        `phasedExtractor: merged response for "${target.name}"`,
      );

      return {
        fields: parsed,
        usage: { calls: acc.totalCalls, ...acc.totals },
        // `raw` is optional on the result and its ABSENCE is what "no phase carried
        // one" reads as — spread in only when the draft has one, never as an
        // explicit undefined. Same discipline for `statedEmptyGroups`: `extractor.ts`
        // documents its absence as "this extractor ran no roster pass", so an empty
        // record is omitted rather than emitted as `{}`.
        ...(draft.raw !== undefined ? { raw: draft.raw } : {}),
        ...(Object.keys(draft.statedEmptyGroups).length > 0
          ? { statedEmptyGroups: draft.statedEmptyGroups }
          : {}),
      };
    },
  };
}
