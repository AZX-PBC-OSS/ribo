import { isCancellation } from "./cancellation.js";
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
import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  TerminalQueueError,
} from "./queue/backoff.js";
import { deriveRetryBudget, PER_CALL_CEILING_MS } from "./retry-budget.js";
import type { RetryBudget, RetryBudgetObserver } from "./retry-budget.js";
import { retryAsync } from "./retry-async.js";
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

/**
 * The default {@link PhasedExtractorOptions.delay} — a real `setTimeout` sleep. Tests
 * inject a fake that records the value and resolves immediately.
 */
const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Running usage state for one extraction: the required `calls` count and the tokens. */
interface UsageAccumulator {
  totalCalls: number;
  totals: UsageTotals;
  /**
   * The run's `engine`/`strategy`, taken from the FIRST phase output that reports
   * each — first writer wins, and the two accumulate independently. A run whose
   * phases span two transports has no single engine; reporting the first is both
   * defensible and what the gap-fill wrapper does today (its base phase runs
   * first, and its combined usage spreads the base's usage). Members a phase does
   * not report stay absent — an absent member means "no phase reported this",
   * and the result must never carry an explicit `undefined` in its place.
   */
  engine?: string;
  strategy?: string;
}

/** Add one item output's usage into the running totals, ignoring what it omits. */
function addPhaseOutputUsage(acc: UsageAccumulator, usage: ExtractionUsage): void {
  acc.totalCalls += usage.calls;
  if (acc.engine === undefined && usage.engine !== undefined) acc.engine = usage.engine;
  if (acc.strategy === undefined && usage.strategy !== undefined) acc.strategy = usage.strategy;
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
  const {
    target,
    phases,
    normalize = (fields) => fields,
    concurrency = 4,
    maxRetries = 2,
    stepTimeoutMs = 900_000,
    perCallCeilingMs = PER_CALL_CEILING_MS,
    delay = defaultDelay,
    baseMs = DEFAULT_BACKOFF_BASE_MS,
    capMs = DEFAULT_BACKOFF_CAP_MS,
    random,
    now = Date.now,
    onUnit,
    onRetryBudget,
    requireRetryBudget = false,
  } = options;

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

      // The running deadline, recorded once: this run's own step timeout, narrowed —
      // never widened — by any deadline the caller inherited from a composing
      // combinator. A combinator can always finish sooner than its caller allows; it
      // may never grant itself more time than it was given. The effective deadline is
      // what every phase's run sees in its context.
      const effectiveDeadline = Math.min(
        now() + stepTimeoutMs,
        callerOptions?.deadline ?? Infinity,
      );

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
          deadline: effectiveDeadline,
        };

        // Consumption of a Phase is Rank-2: I and C are bound but anonymous inside
        // this callback, so all of the phase's per-item work happens here. The
        // callback may be async — `with` returns its R either way.
        draft = await phase.with(async <I, C>(def: PhaseDef<V, P, I, C>) => {
          const items = def.plan(draft, ctx);
          // An empty plan is a no-op: no call, no event, no usage change.
          if (items.length === 0) return draft;

          const limit = def.concurrency ?? concurrency;
          // The retry budget is derived HERE, at the boundary where `plan` has just
          // returned and this phase's item count is finally known — not at
          // construction, where no count exists. The phase's share of the REMAINING
          // time is what is left divided by the phases not yet run, this one
          // included; a phase that finishes early leaves more for the rest.
          const requested = def.maxRetries ?? maxRetries;
          const batches = Math.ceil(items.length / limit);
          const deriveBudget = (timeout: number): RetryBudget =>
            deriveRetryBudget({
              requested,
              batches,
              stepTimeoutMs: timeout,
              perCallCeilingMs,
              baseMs,
              capMs,
            });
          const shareBudget = deriveBudget((effectiveDeadline - now()) / (phases.length - pass));
          const fullBudget = deriveBudget(stepTimeoutMs);
          // Two kinds of zero. A budget zero against the FULL step timeout means the
          // caller asked for retries that cannot fit ANY run of this shape — the
          // configuration error `requireRetryBudget` has always thrown for, and it
          // still throws (TerminalQueueError, matching instance-fill.ts's
          // extract-time precedent). A budget zero only against the REMAINING time
          // came from elapsed wall-clock at a late boundary — transient, so it runs
          // with no retries and reports. Conflating them kills sessions on a timing
          // blip. The share is Math.min'd against the full timeout, so it can never
          // derive HIGHER than the full derivation — the two cannot disagree in the
          // other direction.
          if (shareBudget.derived < requested) onRetryBudget?.(shareBudget);
          if (requireRetryBudget && requested > 0 && fullBudget.derived === 0) {
            throw new TerminalQueueError(
              `phasedExtractor: phase "${def.id}"'s retry budget derived to 0 (requested ` +
                `${requested}) against even the full step timeout (${stepTimeoutMs} ms) — ` +
                `increase stepTimeoutMs, lower perCallCeilingMs (${perCallCeilingMs}), or ` +
                `raise concurrency (${limit}) to fit at least one retry`,
            );
          }

          const outcomes = await mapWithPool(
            items,
            limit,
            async (item): Promise<Outcome<I, C>> => {
              // Mint one id per item, before any attempt — stable across the item's
              // retries, so a consumer correlates start/done/error without
              // bookkeeping. Minting per attempt would satisfy every other
              // assertion while breaking correlation for exactly the runs a
              // consumer most wants to follow.
              const id = nextUnitId();
              // key and leaf come from the phase's describeItem — the scheduler has
              // no other way to learn what an opaque item belongs to. Defaulting to
              // key "" matches groupedExtractor's GroupMap convention for a
              // whole-schema entry.
              const described = def.describeItem?.(item) ?? { key: "" };
              const unitKey = {
                key: described.key,
                ...(described.leaf !== undefined ? { leaf: described.leaf } : {}),
              };
              // The attempt that most recently BEGAN — 0 until onAttempt first
              // fires, so the done event names the attempt that actually settled,
              // and an attempt the pre-attempt abort check prevented emits
              // nothing at all: announcing it would invent a retry that did not
              // happen, and `attempt` is the only way a retry is observable.
              let beganAttempt = 0;
              try {
                // The item's retry loop is `retryAsync` — the policy extracted from
                // `retryExtractor` in the retry task, composed here rather than
                // reimplemented. Its signal is the phase's combined signal, so a
                // caller cancellation AND a sibling failure both stop the loop
                // (mapWithPool's doc: the retry loops do not retry an aborted call).
                // The budget is this phase's own derived share — a declared per-phase
                // value is what was REQUESTED; the derivation is what fits.
                const output = await retryAsync(
                  async (attempt) => {
                    try {
                      return await def.run(item, draft, ctx);
                    } catch (cause) {
                      // One error event per failed ATTEMPT, emitted where the
                      // attempt's own failure is observed and its number is in
                      // scope — a failure that a retry then recovers from is still
                      // announced.
                      onUnit?.({
                        id,
                        unit: "phase",
                        phase: "error",
                        attempt,
                        pass,
                        phaseId: def.id,
                        ...unitKey,
                        error: cause,
                      });
                      throw cause;
                    }
                  },
                  {
                    maxRetries: shareBudget.derived,
                    signal: effectiveSignal,
                    delay,
                    baseMs,
                    capMs,
                    random,
                    // One start event per item ATTEMPT, immediately before it runs —
                    // the hook the retry task put on retryAsync for exactly this.
                    onAttempt: (attempt) => {
                      beganAttempt = attempt;
                      onUnit?.({
                        id,
                        unit: "phase",
                        phase: "start",
                        attempt,
                        pass,
                        phaseId: def.id,
                        ...unitKey,
                      });
                    },
                  },
                );
                onUnit?.({
                  id,
                  unit: "phase",
                  phase: "done",
                  attempt: beganAttempt,
                  pass,
                  phaseId: def.id,
                  ...unitKey,
                  // Usage from the item's own PhaseOutput, omitted rather than
                  // zeroed when it reported none — absent means "not reported",
                  // and this repo keeps that distinction load-bearing.
                  ...(output.usage?.promptTokens !== undefined &&
                  output.usage?.completionTokens !== undefined
                    ? {
                        usage: {
                          inputTokens: output.usage.promptTokens,
                          outputTokens: output.usage.completionTokens,
                        },
                      }
                    : {}),
                });
                return { outcome: "result", item, output };
              } catch (cause) {
                // Cancellation is the exception to every failure policy: a caller
                // cancellation — signalled, or thrown as a branded error by the run
                // itself — rejects the whole run, whatever this phase declared. A
                // skip-policy phase converting one into a skipped item would resolve
                // with all-null fields, indistinguishable from a document that said
                // nothing.
                if (isCancellation(cause, callerSignal)) throw cause;
                // Skip policy: catch INSIDE the worker so the pool never sees a
                // rejection — the failed item reaches merge on the error arm for the
                // phase to interpret. Abort policy (the default, the safer one): let
                // the rejection escape; mapWithPool aborts the siblings and fails
                // the run, `map-with-pool.ts` untouched.
                if (def.onItemFailure === "skip") {
                  return { outcome: "error", item, error: cause };
                }
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
          const merged = def.merge(draft, outcomes);
          // The runtime half of the construction-time check: every key the phase
          // declared in `produces` must now be present in the merged draft's notes.
          // A phase that declares a key and writes it only conditionally is a
          // silent liar, and a roster-driven contribution is exactly that shape —
          // this is what makes `requires`/`produces` an actual guarantee rather
          // than a declaration.
          for (const key of def.produces ?? []) {
            if (!merged.notes.keys.includes(key)) {
              throw new Error(
                `phasedExtractor: phase "${def.id}" declared it produces note key ` +
                  `"${key}", but its merge did not write it — a phase that declares a ` +
                  `key and writes it only conditionally is a silent liar`,
              );
            }
          }
          return merged;
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
        usage: {
          calls: acc.totalCalls,
          ...acc.totals,
          // First writer wins — see UsageAccumulator. Spread in only when some
          // phase reported one; an absent member means "not reported", never an
          // explicit undefined.
          ...(acc.engine !== undefined ? { engine: acc.engine } : {}),
          ...(acc.strategy !== undefined ? { strategy: acc.strategy } : {}),
        },
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
