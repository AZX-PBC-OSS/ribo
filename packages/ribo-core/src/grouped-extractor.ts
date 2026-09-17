/**
 * @file `groupedExtractor` — the run-owner combinator: it takes a per-key map of
 * `Extractor`s, runs them, and assembles one result.
 *
 * Lives beside `fallbackExtractor` and `raceExtractor` because it is a combinator
 * over the core `Extractor` seam and knows nothing about chat, prompts or
 * providers. It owns exactly the work that is genuinely CROSS-group
 * (`per-group-composition-design.md` §4.2):
 *
 *   - **Coverage, checked at construction.** Every top-level key of
 *     `target.extractionSchema` must be named in `groups`, and no key outside it
 *     may be — thrown with the key named, in the style of `enveloped()`'s
 *     `validateProvenance`. Silent partial coverage would surface as a
 *     second-parse failure after every call had been paid for.
 *   - **Scheduling.** A bounded pool over the flattened list of group entries;
 *     the retry budget is derived from that count exactly as the per-group
 *     extractor derives it (`batches = ceil(entries / concurrency)`).
 *   - **Retry.** A transient failure of a group entry's `extract()` is retried
 *     with `fullJitterDelay` up to the derived budget; `TerminalQueueError` is
 *     never retried; a `SchemaParseError` stays transient. **The unit of retry
 *     is the group entry's `extract()`**, not the chat call alone — a group
 *     extractor that assembles its own messages re-runs that assembly per
 *     attempt, which is cheap and was outside the loop for tidiness, not
 *     correctness.
 *   - **Sibling abort.** One `AbortController` per `extract()`; when an entry
 *     fails (terminally or past its budget), the pool aborts the run so
 *     in-flight siblings are cancelled and no further entry starts. The
 *     caller's own signal (Task 9's `ExtractOptions.signal`) is **combined**
 *     with the run's controller via `AbortSignal.any` — never substituted for
 *     it with `??`, which would silently disable sibling abort whenever a
 *     caller passed a signal.
 *   - **Merge, second parse, normalize once, usage sum, `statedEmptyGroups`
 *     union.** As the per-group extractor does them today.
 *
 * What it does NOT own: how a group asks the model. Each entry is an opaque
 * `Extractor` — typically a `singleShotExtractor` over a projected target
 * (`projectTarget`), possibly wrapped (a `schemaRetry` or `gapFill` around one
 * group) — so per-group heterogeneity is composition, not options.
 */

import { z } from "zod";

import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  fullJitterDelay,
  TerminalQueueError,
} from "./queue/backoff.js";
import { deriveRetryBudget, PER_CALL_CEILING_MS } from "./retry-budget.js";
import type { RetryBudgetObserver } from "./retry-budget.js";
import { nextUnitId } from "./extraction-observer.js";
import type { BackoffOptions } from "./queue/backoff.js";
import type { ExtractionObserver, GroupUnit } from "./extraction-observer.js";
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
import { mergeGroupPieces } from "./merge-group-pieces.js";
import { parseWithSchema } from "./parse-with-schema.js";

/**
 * The per-key map of group extractors: one top-level key to either one
 * `Extractor` or an ordered list of them — the pieces of a partitioned group,
 * recombined with `mergeGroupPieces`. The map type is exhaustive over `V`'s
 * keys, so a missing group is a compile error; the construction-time coverage
 * check catches a JS caller.
 *
 * The `""` arm is the **non-grouped fallback**: a map whose ONLY key is `""`
 * declares one entry covering the whole schema — the shape
 * `splitExtractionSchema`'s fallback yields for a schema that is not an object
 * of groups, and the shape `perGroupExtractor` sends today (one call, the full
 * schema, `GroupUnit` events keyed `""`). Design §4.7: the preset keeps that
 * derived behaviour; a hand composer names keys instead. Coverage is not
 * checked for this arm — the entry IS the whole coverage declaration, and the
 * second trust-boundary parse validates what it returns.
 */
export type GroupMap<V extends Record<string, unknown>, P = NoProvenance> =
  | {
      readonly [K in keyof V & string]:
        Extractor<Pick<Enveloped<V, P>, K>> | readonly Extractor<Pick<Enveloped<V, P>, K>>[];
    }
  | { readonly "": Extractor<Enveloped<V, P>> };

/** Options for {@link groupedExtractor}. */
export interface GroupedExtractorOptions<V extends Record<string, unknown>, P = NoProvenance>
  extends BackoffOptions, ExtractionObserver<GroupUnit>, RetryBudgetObserver {
  /**
   * The field knowledge the whole extraction is pinned to: the merged result is
   * parsed against `extractionSchema` (the second trust-boundary parse), and its
   * top-level keys are what `groups` must cover.
   */
  readonly target: ExtractionTarget<V, P>;
  /** The per-key map of group extractors — see {@link GroupMap}. */
  readonly groups: GroupMap<V, P>;
  /**
   * Max concurrent group entries. Defaults to 4 — the same bound the per-group
   * extractor applies, so the worst case (all entries plus their retries plus
   * their backoff delays) fits inside the relay's `stepTimeoutMs`.
   */
  readonly concurrency?: number;
  /**
   * Max retries per group entry after a transient failure (so the total attempts
   * per entry is `maxRetries + 1`). Terminal failures
   * (`TerminalQueueError` — truncation, content filtering, refusal,
   * unsupported) are never retried and never delay. Defaults to 2, capped by
   * the derived budget — see `deriveRetryBudget`.
   */
  readonly maxRetries?: number;
  /**
   * The relay's step timeout, used to derive the retry budget. Defaults to
   * `900_000` (15 minutes), matching the relay's `DEFAULT_STEP_TIMEOUT_MS` —
   * see `PerGroupOptions.stepTimeoutMs` for the full rationale.
   */
  readonly stepTimeoutMs?: number;
  /**
   * Conservative upper bound on ONE GROUP ENTRY's `extract()` wall-clock
   * duration, used to derive the retry budget. Defaults to
   * `PER_CALL_CEILING_MS` (120,000 ms). An entry that makes several calls
   * (a gap-fill's follow-up, an inner retry loop) or a slower transport should
   * raise this so the budget is sized honestly.
   */
  readonly perCallCeilingMs?: number;
  /**
   * Injectable sleep used between retry attempts, so tests do not wait real
   * seconds. Defaults to `setTimeout`. The value passed is the
   * `fullJitterDelay` result in milliseconds.
   */
  readonly delay?: (ms: number) => Promise<void>;
  /**
   * The deterministic, model-free pass run AFTER the second trust-boundary
   * parse — on the MERGED result, not per group. Runs once across the whole
   * enveloped shape; running it per group would run it on partial shapes for no
   * benefit.
   */
  readonly normalize?: (fields: Enveloped<V, P>) => Enveloped<V, P>;
}

/**
 * The default {@link GroupedExtractorOptions.delay} — a real `setTimeout` sleep. Tests
 * inject a fake that records the value and resolves immediately.
 */
const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Running usage totals for the run, plus the one required `calls` count. */
interface UsageTotals {
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
  cacheCreationPromptTokens?: number;
}

/** Add one settled entry result's usage into the running totals, ignoring what it omits. */
function addResultUsage(totals: UsageTotals, usage: ExtractionUsage): void {
  if (usage.promptTokens !== undefined) {
    totals.promptTokens = (totals.promptTokens ?? 0) + usage.promptTokens;
  }
  if (usage.completionTokens !== undefined) {
    totals.completionTokens = (totals.completionTokens ?? 0) + usage.completionTokens;
  }
  if (usage.cachedPromptTokens !== undefined) {
    totals.cachedPromptTokens = (totals.cachedPromptTokens ?? 0) + usage.cachedPromptTokens;
  }
  if (usage.cacheCreationPromptTokens !== undefined) {
    totals.cacheCreationPromptTokens =
      (totals.cacheCreationPromptTokens ?? 0) + usage.cacheCreationPromptTokens;
  }
}

/** One entry of the flattened schedule: a group key, its 1-based part position, its extractor. */
interface GroupEntry {
  readonly key: string;
  readonly part: number;
  readonly parts: number;
  readonly extractor: Extractor<Record<string, unknown>>;
}

/**
 * Build a {@link groupedExtractor} over a per-key map of group extractors.
 *
 * On each `extract`:
 *   1. Run the flattened group entries concurrently with a bounded pool. Each
 *      entry's `extract()` receives the run's combined signal (the caller's
 *      `AbortSignal.any`-ed with the run's own sibling-abort controller).
 *   2. Retry each entry on transient failure, with `fullJitterDelay`
 *      backoff, up to the derived budget. Emit a `GroupUnit` (`key`, `part`,
 *      `parts`, `attempt`) around each entry's `extract()` — the honest unit of
 *      the entry's work. An entry's own inner units (a `WholeUnit` from a
 *      single-shot call, a `GapFillUnit` from a wrapper) flow through whatever
 *      `onUnit` its own builder gave it.
 *   3. Merge the settled results by top-level key — one entry per key assigns
 *      directly; a partitioned group's pieces recombine with
 *      `mergeGroupPieces`.
 *   4. **Second trust-boundary parse**: parse the merged whole against the full
 *      `extractionSchema`. This is not redundant — it catches a merge that
 *      produced a shape no single entry would have.
 *   5. **Normalize once** on the merged result; sum usage across entries;
 *      union `statedEmptyGroups`.
 *
 * `usage.calls` sums what the entries report — a failed attempt's own calls are
 * the entry's business and are visible only through that entry's events; the
 * combinator counts what it can see, and a combinator-level retry is visible in
 * the `GroupUnit` attempt numbers.
 */
export function groupedExtractor<V extends Record<string, unknown>, P = NoProvenance>({
  target,
  groups,
  normalize = (fields) => fields,
  concurrency = 4,
  maxRetries = 2,
  stepTimeoutMs = 900_000,
  perCallCeilingMs = PER_CALL_CEILING_MS,
  delay = defaultDelay,
  baseMs,
  capMs,
  random,
  onUnit,
  onRetryBudget,
  requireRetryBudget = false,
}: GroupedExtractorOptions<V, P>): Extractor<Enveloped<V, P>> {
  // Coverage is checked at construction: the top-level keys of the extraction
  // schema are what `groups` must cover, no more, no fewer. The schema is
  // `ZodType<Enveloped<V, P>>` at the type level, and `Enveloped` is a mapped
  // type over `keyof V`, so the runtime keys of its shape are exactly `V`'s
  // string keys — the cast only names what the type already guarantees.
  const groupRecord = groups as Readonly<Record<string, unknown>>;

  // The non-grouped fallback arm first: a map whose only key is "" declares one
  // entry covering the whole schema, so the per-key coverage check does not
  // apply (see GroupMap). Combining "" with per-key entries is a contradiction
  // — either the schema has groups or it does not — and is refused, not merged.
  const fallbackEntry = groupRecord[""];
  const isFallback = fallbackEntry !== undefined;
  if (isFallback) {
    const others = Object.keys(groupRecord).filter((key) => key !== "");
    if (others.length > 0) {
      throw new Error(
        `groupedExtractor: the "" key declares the non-grouped fallback — one entry ` +
          `covering the whole schema — and cannot be combined with per-key entries ` +
          `(${others.map((key) => `"${key}"`).join(", ")}).`,
      );
    }
  }

  const schema = target.extractionSchema;
  if (!isFallback && !(schema instanceof z.ZodObject)) {
    throw new Error(
      `groupedExtractor: target "${target.name}"'s extractionSchema is not a zod object, ` +
        `so there are no top-level keys to cover with groups.`,
    );
  }
  const schemaKeys = Object.keys(
    isFallback ? {} : (schema as z.ZodObject).shape,
  ) as readonly (keyof V & string)[];

  // A `GroupMap` is keyed by `keyof V & string`; read back through a plain
  // record so the coverage check can index it with the schema's runtime keys.
  // Skipped for the fallback arm — the entry IS the whole coverage declaration.
  const missing = schemaKeys.filter((key) => !(key in groupRecord));
  if (missing.length > 0) {
    throw new Error(
      `groupedExtractor: groups is missing top-level key(s) ` +
        `${missing.map((key) => `"${String(key)}"`).join(", ")} required by the extraction ` +
        `schema of "${target.name}" — a silent partial coverage would surface as a ` +
        `second-parse failure after every call had been paid for.`,
    );
  }
  const extra = isFallback
    ? []
    : Object.keys(groupRecord).filter((key) => !schemaKeys.includes(key));
  if (extra.length > 0) {
    throw new Error(
      `groupedExtractor: groups names top-level key(s) ` +
        `${extra.map((key) => `"${key}"`).join(", ")} that the extraction schema of ` +
        `"${target.name}" does not have. Known keys: ${schemaKeys.join(", ")}.`,
    );
  }

  // Flatten the map into the schedule. A key mapped to a list is a partitioned
  // group: its pieces run as separate entries and recombine at the merge. The
  // part numbers are 1-based and total the piece count, matching the GroupUnit
  // vocabulary an unpartitioned entry reports as part 1 of 1 — a consumer must
  // not need two code paths for "one" and "several".
  const entries: readonly GroupEntry[] = isFallback
    ? [
        {
          key: "",
          part: 1,
          parts: 1,
          extractor: fallbackEntry as Extractor<Record<string, unknown>>,
        },
      ]
    : schemaKeys.flatMap((key) => {
        const entry = groupRecord[key] as
          Extractor<Record<string, unknown>> | readonly Extractor<Record<string, unknown>>[];
        const pieces = Array.isArray(entry)
          ? (entry as readonly Extractor<Record<string, unknown>>[])
          : [entry as Extractor<Record<string, unknown>>];
        return pieces.map((extractor, index) => ({
          key,
          part: index + 1,
          parts: pieces.length,
          extractor,
        }));
      });

  // The relay wraps extract() in withTimeout(stepTimeoutMs). All entries plus
  // their retries plus their backoff delays must fit inside it. The budget is
  // derived from the ENTRY count — `batches = ceil(entries / concurrency)` —
  // exactly as the per-group extractor derives it from its prepared group
  // count, so the observable RetryBudget for the same shape of run is
  // unchanged. See deriveRetryBudget for the relationship.
  const backoffBaseMs = baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffCapMs = capMs ?? DEFAULT_BACKOFF_CAP_MS;
  const batches = Math.ceil(entries.length / concurrency);
  const budget = deriveRetryBudget({
    requested: maxRetries,
    batches,
    stepTimeoutMs,
    perCallCeilingMs,
    baseMs: backoffBaseMs,
    capMs: backoffCapMs,
  });
  const effectiveMaxRetries = budget.derived;
  // Fire onRetryBudget only when the budget was reduced — a consumer that asked
  // for 5 and got 5 has nothing to act on. The default must stay non-throwing:
  // the current production wiring derives to zero-reduction, so throwing by
  // default would break the live path in the same change that makes it visible.
  if (budget.derived < budget.requested) {
    onRetryBudget?.(budget);
  }
  if (requireRetryBudget && budget.derived === 0 && budget.requested > 0) {
    throw new Error(
      `groupedExtractor: retry budget derived to 0 (requested ${budget.requested}) — ` +
        `increase stepTimeoutMs (${stepTimeoutMs}), lower perCallCeilingMs (${perCallCeilingMs}), ` +
        `or lower concurrency (${concurrency}) to fit at least one retry`,
    );
  }
  // Pre-compute the backoff options object once — passed to fullJitterDelay on
  // every retry. The random function defaults to Math.random inside
  // fullJitterDelay when not supplied here.
  const backoffOpts: BackoffOptions = { baseMs: backoffBaseMs, capMs: backoffCapMs, random };

  return {
    async extract(
      transcript: AnnotatedTranscript,
      options?: ExtractOptions,
    ): Promise<ExtractionResult<Enveloped<V, P>>> {
      // One AbortController for the whole run. When any entry fails (terminally
      // or past its retry budget), abort is called by mapWithPool: in-flight
      // siblings observe the aborted signal (a well-behaved group extractor
      // forwards it to its transport), and workers stop pulling new entries.
      const abort = new AbortController();
      // The caller's signal (Task 9's ExtractOptions.signal) and this run's
      // sibling-failure controller are two independent reasons to stop. Combine
      // them with AbortSignal.any — `??` would substitute one for the other,
      // silently disabling sibling abort whenever a caller supplied a signal
      // (the same mistake twice corrected elsewhere in this codebase).
      const callerSignal = options?.signal;
      const effectiveSignal = callerSignal
        ? AbortSignal.any([callerSignal, abort.signal])
        : abort.signal;

      let totalCalls = 0;
      const totals: UsageTotals = {};
      const statedEmpty: Record<string, string> = {};

      const results = await mapWithPool(
        entries,
        concurrency,
        async (entry) => {
          // Mint one id per entry before the loop — stable across every
          // attempt of this entry, so a consumer correlates start/done/error
          // without bookkeeping. attempt is what distinguishes retries.
          const id = nextUnitId();
          const { key, part, parts } = entry;

          let lastError: unknown;
          for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
            // If a sibling group's failure has aborted the run, or the caller
            // has aborted their signal, don't start a new attempt — propagate
            // so this worker stops. mapWithPool checks the run signal before
            // pulling new work; this check catches the case where an abort
            // fires between retry attempts.
            if (effectiveSignal.aborted) {
              // NO event here, deliberately, and for two independent reasons.
              //
              // This check runs at the TOP of the loop, before this attempt's
              // `start`, so attempt `attempt + 1` never began — announcing it
              // would invent a retry that did not happen, and `attempt` is the
              // only way a retry is observable at all. Re-reporting `attempt`
              // is no better: when it is > 0 that attempt already settled with
              // its own `error` in the catch below, and when it is 0 nothing
              // started at all.
              //
              // And the timing is worse than the numbering. `mapWithPool` uses
              // `Promise.all`, so `extract()` rejects the instant a sibling
              // fails — while this worker may still be asleep in its backoff.
              // Anything emitted here therefore arrives AFTER the extraction
              // has settled, telling a progress panel that a finished run is
              // still going. The unit's last live attempt is already reported;
              // that no further attempt follows is said by the absence of a
              // next `start`.
              if (lastError instanceof Error) {
                throw lastError;
              }
              throw new Error(
                callerSignal?.aborted
                  ? "groupedExtractor: aborted by the caller's signal"
                  : "groupedExtractor: aborted by a sibling failure",
              );
            }

            onUnit?.({ id, unit: "group", phase: "start", attempt: attempt + 1, key, part, parts });

            try {
              const result = await entry.extractor.extract(transcript, {
                ...options,
                signal: effectiveSignal,
              });

              // Sum what the entry reports — its calls and token totals. A
              // failed attempt's calls are the entry's business; this run's
              // own retries are visible in the GroupUnit attempt numbers.
              totalCalls += result.usage.calls;
              addResultUsage(totals, result.usage);
              if (result.statedEmptyGroups !== undefined) {
                Object.assign(statedEmpty, result.statedEmptyGroups);
              }

              onUnit?.({
                id,
                unit: "group",
                phase: "done",
                attempt: attempt + 1,
                key,
                part,
                parts,
                // Omitted rather than set to `undefined` when the entry
                // reports no token counts: absent means "not reported", and
                // this repo keeps that distinction load-bearing.
                ...(result.usage.promptTokens !== undefined &&
                result.usage.completionTokens !== undefined
                  ? {
                      usage: {
                        inputTokens: result.usage.promptTokens,
                        outputTokens: result.usage.completionTokens,
                      },
                    }
                  : {}),
              });
              return result;
            } catch (cause) {
              lastError = cause;
              onUnit?.({
                id,
                unit: "group",
                phase: "error",
                attempt: attempt + 1,
                key,
                part,
                parts,
                error: cause,
              });
              // Terminal failures are never retried — a
              // TerminalQueueError names a deterministic failure
              // (truncation, content filtering, refusal, unsupported);
              // re-sending an identical request reproduces it. Retrying
              // would burn the budget for nothing and hide a
              // configuration problem behind a retry storm.
              if (cause instanceof TerminalQueueError) throw cause;
              // If aborted — by a sibling's failure or by the caller — don't
              // retry; propagate. A cancellation is not a transient blip.
              if (effectiveSignal.aborted) throw cause;
              // Transient failure — back off before the next attempt if budget
              // remains. fullJitterDelay takes the failure count before this
              // failure (matching the relay's convention), so the first retry
              // draws from [0, base]. The delay is injected so tests do not
              // sleep; the default is a real setTimeout. After the delay, the
              // loop's top-of-iteration abort check catches a sibling failure
              // that fired while we were sleeping.
              if (attempt < effectiveMaxRetries) {
                await delay(fullJitterDelay(attempt, backoffOpts));
              }
            }
          }
          // Budget exhausted — rethrow the last transient error. The error
          // event for the final attempt was already fired in the catch above;
          // this throw propagates to the relay's existing backoff, attempt
          // count and dead handling unchanged.
          throw lastError;
        },
        abort,
      );

      // Merge by the entries' own keys — each entry's fields is a
      // `Pick<Enveloped<V, P>, K>`: a one-key record whose only key IS the
      // entry's key (the group extractor was handed a projected target with
      // exactly that shape). Reading by the entry's own key — rather than the
      // response's first key — is what lets two entries share a group key (a
      // partitioned group's pieces) without one clobbering the other.
      // `results` is index-aligned with `entries` (mapWithPool preserves
      // order), so pieces recombine in the order they were scheduled.
      const merged: Record<string, unknown> = {};
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const fields = results[i]!.fields;
        if (entry.key === "") {
          // The non-grouped fallback: the entry's fields ARE the whole merged
          // object already (its schema is the full extraction schema, not a
          // one-key slice) — assign its keys directly rather than nesting
          // under "".
          Object.assign(merged, fields);
          continue;
        }
        const value = fields[entry.key];
        merged[entry.key] =
          entry.key in merged ? mergeGroupPieces(merged[entry.key], value) : value;
      }

      // Second trust-boundary parse: validate the merged whole against the full
      // extraction schema. This is not redundant — it catches a merge that
      // produced a shape no single entry would have.
      const mergeContext = `groupedExtractor: merged response for "${target.name}"`;
      const parsed = parseWithSchema(target.extractionSchema, merged, mergeContext);

      // Normalization runs once on the merged result — running it per group
      // would run it on partial shapes for no benefit.
      return {
        fields: normalize(parsed),
        raw: merged,
        usage: { calls: totalCalls, ...totals },
        ...(Object.keys(statedEmpty).length > 0 ? { statedEmptyGroups: statedEmpty } : {}),
      };
    },
  };
}
