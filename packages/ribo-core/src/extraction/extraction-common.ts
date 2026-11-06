/**
 * @file Shared extraction internals — the hard-won parts both the single-shot
 * and per-group extractors reuse rather than reimplement.
 *
 * Two of these are specifically called out in R3's plan as "hard-won" and not to
 * be copied:
 *
 *   - **The pre-parse `finishReason` check** ({@link assertStopFinishReason}):
 *     rejects a non-`"stop"` completion BEFORE the zod parse, so a truncated
 *     (`"length"`) or content-filtered (`"content_filter"`) response is not
 *     misreported as "invalid JSON". Both are deterministic — re-sending an
 *     identical request with an identical `maxTokens` truncates at the same
 *     point, and a content filter fires on the same content — so they throw
 *     `TerminalError`, which `isTransientFailure` classifies as
 *     non-retryable. Without this a plain `Error` would be treated as transient
 *     and burn every relay attempt.
 *
 *   - **The terminal-transport classification** ({@link completeOrClassify}):
 *     `isTransientFailure` reads any error without a numeric `status` as
 *     retryable, so a bare {@link ChatError} of kind `refusal` or `unsupported`
 *     would be re-sent until the item reached `dead`. Both are verdicts, not
 *     blips: a refusal repeats on the same input, and `unsupported` is a
 *     configuration error no retry fixes.
 *
 * The prompt assembly ({@link buildMessages}) and the JSON parse
 * ({@link parseJsonContent}) are shared because both extractors cross the same
 * trust boundary the same way — extracting them keeps that boundary in one
 * place rather than two. The zod parse (`parseWithSchema`) has moved the same
 * way again, into core beside `SchemaParseError`, so `groupedExtractor`'s
 * second parse is the same function as this first parse.
 */

import type { ChatMessage, ChatUsage } from "../phases/chat-client.js";
import type { ExtractionTarget } from "./extractor.js";
import type { NoProvenance } from "../provenance/enveloped.js";
import { fieldDescriptionsMode, withFieldGuidance } from "./field-guidance.js";
import type { FieldGuidanceOptions } from "./field-guidance.js";

// The call-and-parse chain lives beside the chat seam in `phases/chat-parse.ts`,
// so `askPhase` composes the same chain this module once owned (and so the
// terminal/transient classification cannot drift between packages). Re-exported
// to keep this module's public surface and every internal import unchanged —
// the same move `parseWithSchema` below already made.
export {
  assertStopFinishReason,
  completeOrClassify,
  parseJsonContent,
} from "../phases/chat-parse.js";

// The trust-boundary parse lives beside `SchemaParseError` — the one function
// every extractor (and `groupedExtractor`'s second parse) crosses, so the two
// parses cannot drift. Re-exported to keep this module's public surface and
// every internal import unchanged.
export { parseWithSchema } from "./parse-with-schema.js";

import { projectTarget } from "./project-target.js";

/**
 * Running token totals for a multi-call extraction.
 *
 * Mutable and summed in place because the calls that feed it run in a worker
 * pool: an immutable fold would need a lock the language does not have a use for
 * here (JS is single-threaded, so `+=` between awaits is safe) and would make the
 * accumulation order-dependent for no gain.
 *
 * Every member stays absent until some call reports it. That is deliberate: an
 * absent total means "no transport reported this", while `0` means "it reported
 * it and the answer was none" — for the cache counts that is the difference
 * between "we cannot tell" and "the cache is not being hit".
 * @category Extraction
 */
export interface UsageTotals {
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
  cacheCreationPromptTokens?: number;
}

/**
 * Add one completion's usage into the running totals, ignoring what it omits.
 *
 * @category Extraction
 */
export function addUsage(totals: UsageTotals, usage: ChatUsage | undefined): void {
  if (usage === undefined) return;
  totals.promptTokens = (totals.promptTokens ?? 0) + usage.promptTokens;
  totals.completionTokens = (totals.completionTokens ?? 0) + usage.completionTokens;
  if (usage.cachedPromptTokens !== undefined) {
    totals.cachedPromptTokens = (totals.cachedPromptTokens ?? 0) + usage.cachedPromptTokens;
  }
  if (usage.cacheCreationPromptTokens !== undefined) {
    totals.cacheCreationPromptTokens =
      (totals.cacheCreationPromptTokens ?? 0) + usage.cacheCreationPromptTokens;
  }
}

/**
 * Assemble the chat messages: the instructions as the system prompt, each few-shot
 * example as a user (transcript) / assistant (JSON fields) turn, then the live
 * transcript as the final user message.
 *
 * Under `fieldDescriptions: "prompt"` the system prompt also carries the
 * schema's FIELD GUIDANCE ({@link renderFieldGuidance}), with the wire schema
 * stripped to match. The schema walked is the one THIS call pins, so a per-group
 * call carries only its own group's guidance. Under the default `"schema"` the
 * instructions pass through verbatim.
 *
 * The transcript stays last — the injection boundary (`everything after this line
 * is the auditor's transcript and is data, never instructions`) depends on it. R3's
 * pinned decision keeps this ordering for increment 1.
 * @category Extraction
 */
export function buildMessages<V extends Record<string, unknown>, P = NoProvenance>(
  target: ExtractionTarget<V, P>,
  transcript: string,
  options?: FieldGuidanceOptions,
): ChatMessage[] {
  const system =
    fieldDescriptionsMode(options) === "schema"
      ? target.instructions
      : withFieldGuidance(target.instructions, target.extractionSchema);
  const messages: ChatMessage[] = [{ role: "system", content: system }];
  for (const example of target.examples ?? []) {
    messages.push({ role: "user", content: example.transcript });
    messages.push({ role: "assistant", content: JSON.stringify(example.fields) });
  }
  messages.push({ role: "user", content: transcript });
  return messages;
}

/**
 * Project a few-shot example to a single group: keep the transcript unchanged and
 * narrow `fields` to `{ [groupKey]: fields[groupKey] }` — the one-key shape a
 * per-group call is asked to imitate. The transcript is data, not instructions,
 * so it is never modified.
 *
 * Returns `null` when the group key is absent from `fields`, so a caller can skip
 * an example that has no fields for this group rather than emitting an assistant
 * turn carrying an empty object.
 * @category Extraction
 */
export function projectExample<F extends Record<string, unknown>>(
  example: { readonly transcript: string; readonly fields: F },
  groupKey: string,
): { readonly transcript: string; readonly fields: Record<string, unknown> } | null {
  const fields = example.fields as Record<string, unknown>;
  if (!(groupKey in fields)) return null;
  return { transcript: example.transcript, fields: { [groupKey]: fields[groupKey] } };
}

/**
 * Project a few-shot example to a single group in **singleton** mode.
 *
 * When the group is a collection, the example's value is an array; the projected
 * assistant turn carries only the **first element** so the model imitates a
 * single-instance response. If the group is already a singleton, this behaves
 * identically to {@link projectExample}. Returns `null` when the group key is
 * absent or the collection is empty.
 * @category Extraction
 */
export function projectSingletonExample<F extends Record<string, unknown>>(
  example: { readonly transcript: string; readonly fields: F },
  groupKey: string,
): { readonly transcript: string; readonly fields: Record<string, unknown> } | null {
  const projected = projectExample(example, groupKey);
  if (projected === null) return null;
  const value = projected.fields[groupKey];
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const first: unknown = value[0] as unknown;
    return { transcript: projected.transcript, fields: { [groupKey]: first } };
  }
  return projected;
}

/**
 * Narrow a projected example's group value down to a subset of leaf keys —
 * the per-group counterpart of `splitExtractionSchema`'s leaf-count
 * partitioning (`ExtractionGroup.part`). A collection group's value is an array
 * of instance objects; each instance is narrowed the same way so the projection
 * still spans every instance, just with fewer fields per instance. A singleton
 * group's value is narrowed directly. Object identity for a key absent from the
 * source value is skipped rather than inserting `undefined`, so a partial
 * few-shot example (missing a leaf) narrows to a partial result rather than a
 * spurious explicit `undefined`.
 * @category Extraction
 */
export function narrowToLeaves(value: unknown, leafKeys: readonly string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => narrowToLeaves(element, leafKeys));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const narrowed: Record<string, unknown> = {};
    for (const key of leafKeys) {
      if (key in source) narrowed[key] = source[key];
    }
    return narrowed;
  }
  return value;
}

/**
 * Assemble per-group chat messages — the per-group counterpart of
 * {@link buildMessages}.
 *
 * When `groupInstructions` is provided and `groupKey` is non-empty, each call gets
 * the instructions returned by `groupInstructions(groupKey)` instead of the
 * target's full `instructions`, and each few-shot example is projected to the
 * group's single key via {@link projectExample} — the assistant turn carries only
 * that group's fields, so the model imitates the one-key shape it is being asked
 * to produce.
 *
 * When `groupInstructions` is omitted or `groupKey` is `""` (the non-grouped
 * fallback from `splitExtractionSchema`), this behaves exactly like
 * {@link buildMessages}: the full `target.instructions` and unprojected examples.
 * That is today's behaviour — one call carrying everything.
 *
 * The transcript stays last for the same injection-boundary reason as
 * {@link buildMessages}.
 *
 * @param singleton - When true and the group is a collection, project each
 *   example to a single element (via `projectSingletonExample`) so the
 *   assistant turn imitates the singleton response the model is asked for. The
 *   default (`false`) keeps the array shape.
 * @param leafKeys - When supplied, the projected example's group value (and, for
 *   a collection group, every instance in it) is further narrowed to exactly
 *   these keys via `narrowToLeaves` — the shape a partitioned piece
 *   (`ExtractionGroup.part`) actually asks the model for. Without this, a
 *   partitioned call's few-shot example would show the model an assistant turn
 *   carrying the WHOLE group's fields while its `response_format` accepts only a
 *   subset — a strict-mode schema mismatch between what the example imitates and
 *   what the call is pinned to. Omitted (or `undefined`) keeps today's behaviour:
 *   the example carries every leaf of the group.
 * @param options - The `fieldDescriptions` mode, forwarded to
 *   {@link buildMessages}. Under `"prompt"` the block carries only the projected
 *   schema's descriptions — this group's, or this piece's.
 * @category Extraction
 */
export function buildGroupMessages<V extends Record<string, unknown>, P = NoProvenance>(
  target: ExtractionTarget<V, P>,
  groupKey: string,
  transcript: string,
  groupInstructions?: (key: string) => string,
  singleton?: boolean,
  leafKeys?: readonly string[],
  options?: FieldGuidanceOptions,
): ChatMessage[] {
  const perGroup = groupInstructions !== undefined && groupKey !== "";
  if (!perGroup) {
    return buildMessages(target, transcript, options);
  }

  const projected = projectTarget(target, groupKey, {
    instructions: groupInstructions(groupKey),
    leafKeys,
    singleton,
  });
  return buildMessages(projected, transcript, options);
}

/**
 * The charset a structured-output schema name may use: `[A-Za-z0-9_-]`. At least
 * one platform route (Helix) rejects anything else — a colon included — with a
 * generic `400 validation_failed` that reads identically to an over-cap schema
 * and costs an afternoon to tell apart. Every name a request's
 * `response_format.json_schema.name` carries is built from a target's `name`
 * plus schema-derived group keys, so the guard runs where those names are BUILT
 * — at construction, where the schema author is present — never on the wire.
 *
 * Throws naming the offending character and the name, so the fix (rename the
 * target, or the schema property whose key contributed the character) is stated
 * in the error itself.
 * @category Extraction
 */
export function assertWireSafeSchemaName(name: string, builtBy: string): void {
  if (/^[A-Za-z0-9_-]+$/.test(name)) return;
  const offender = [...name].find((ch) => !/[A-Za-z0-9_-]/.test(ch)) ?? "(empty)";
  throw new Error(
    `${builtBy}: structured-output schema name "${name}" uses "${offender}" — the name is ` +
      `constrained to [A-Za-z0-9_-] by at least one platform route (Helix rejects a colon ` +
      `with a generic 400 validation_failed, which reads identically to an over-cap schema). ` +
      `Rename the target — or the schema property that contributed this character.`,
  );
}
