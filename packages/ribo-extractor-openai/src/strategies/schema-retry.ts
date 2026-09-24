/**
 * @file The schema-retry combinator — a bounded self-correction loop that tells
 * the model WHAT failed validation, out of band.
 *
 * A schema-validated extraction can fail in a way the model would fix on the
 * spot if shown the error: a required key omitted, a string where a number
 * belongs. Without feedback the only options are falling through to another
 * strategy or re-sending the identical request — the model is never told what
 * it got wrong, and a sampled miss is re-rolled blind.
 *
 * `schemaRetryExtractor` wraps a base {@link Extractor}. When the base rejects
 * with a {@link SchemaParseError}, it re-asks through the injected
 * {@link ChatClient}, appending two conversation turns to the SAME message
 * assembly the base used: the failed output as an assistant turn (the model's
 * own previous answer), then a user turn carrying the validation error. Each
 * further retry appends another pair, so the model sees its full history of
 * rejected answers.
 *
 * The transcript is NEVER modified. Every extracted field carries a
 * `sourceSpan` that `spanGroundedness` checks verbatim against the real
 * transcript at review time — appending feedback to the transcript text would
 * let the model quote text the review tier then reports as `ungrounded`, and
 * would re-present the model's own bad values as source material it can cite,
 * reinforcing the exact hallucination being corrected. The transcript is also
 * a data channel for untrusted user content; instructions do not go in it.
 * Feedback therefore travels as conversation turns, and the message carrying
 * the transcript stays byte-for-byte the caller's string on every attempt.
 *
 * Only a schema validation failure is retried: it is the one failure showing
 * the error can fix. A transport error, a 429, a refusal, a truncation —
 * anything else — passes through untouched, unchanged in type and identity.
 *
 * This combinator lives here, not in `ribo-core`, because it needs message
 * assembly. That forfeits provider-neutrality deliberately: the only
 * provider-neutral channel a core combinator could write to is the transcript
 * string, which is exactly the channel that must stay pristine.
 */

import { z } from "zod";

import { SchemaParseError } from "@azx/ribo-core";
import type {
  AnnotatedTranscript,
  ChatClient,
  ChatMessage,
  Enveloped,
  ExtractionResult,
  ExtractionTarget,
  ExtractionUsage,
  ExtractOptions,
  Extractor,
  NoProvenance,
} from "@azx/ribo-core";

import type { UsageTotals } from "@azx/ribo-core";
import {
  addUsage,
  assertStopFinishReason,
  buildMessages,
  completeOrClassify,
  parseJsonContent,
  parseWithSchema,
} from "@azx/ribo-core";

/** The default retry budget. Small and bounded on purpose: every retry is a real, paid model call. */
const DEFAULT_MAX_RETRIES = 1;

/**
 * Options for {@link schemaRetryExtractor}.
 *
 * `base` is handed over ALREADY BUILT, exactly as in {@link GapFillOptions}:
 * there is no observer threading to do, and the base's own units flow through
 * whatever `onUnit` its caller gave it at construction.
 */
export interface SchemaRetryOptions<V extends Record<string, unknown>, P = NoProvenance> {
  /**
   * The wrapped extractor. Its result passes through untouched on success; its
   * {@link SchemaParseError} is what triggers a retry. The retry conversation
   * is assembled with {@link buildMessages}, so a base whose prompt differs
   * from single-shot's gets feedback framed against single-shot's assembly —
   * wire this around {@link singleShotExtractor} or another
   * `buildMessages`-shaped base.
   */
  readonly base: Extractor<Enveloped<V, P>>;
  /**
   * The field knowledge: the retry pins the response to `extractionSchema` —
   * the same schema the base's output failed — and reuses `instructions` and
   * few-shot `examples` so the retry's prompt is the base's prompt plus the
   * feedback turns.
   */
  readonly target: ExtractionTarget<V, P>;
  /** The injected chat transport for the retry calls. A fake in tests. */
  readonly chat: ChatClient;
  /** The model id passed through to the endpoint. */
  readonly model: string;
  /** Cap on generated tokens for each retry call, as in {@link SingleShotOptions.maxTokens}. */
  readonly maxTokens?: number;
  /**
   * How many self-correction calls to make after the base fails. Every retry
   * is a real call to a paid endpoint, so the budget defaults to
   * `DEFAULT_MAX_RETRIES` and must be a non-negative integer — `0`
   * disables retrying and passes the base's outcome through unchanged.
   */
  readonly maxRetries?: number;
  /**
   * The deterministic, model-free pass run on a retry's parsed fields — the
   * same role as {@link GapFillOptions.normalize}. The base normalizes its own
   * successes; a RETRY's success never went through the base, so this runs the
   * same pass here. Defaults to identity.
   */
  readonly normalize?: (fields: Enveloped<V, P>) => Enveloped<V, P>;
}

/**
 * The user turn telling the model what failed. The error text goes here — a
 * conversation turn — and never into the transcript, per the file header. The
 * reminder about verbatim spans restates the grounding contract at the moment
 * the model is most likely to break it: correcting under pressure.
 */
const buildFeedback = (error: SchemaParseError): string =>
  `Your previous response failed validation against the response schema:\n\n${error.message}\n\n` +
  `Return a corrected response that satisfies the schema. Every sourceSpan must remain a verbatim quote from the transcript; never invent values the transcript does not support.`;

/**
 * Usage for a successful retry: one entry per retry call actually made, token
 * totals summed via {@link addUsage} so an unreported count stays absent rather
 * than collapsing to `0`. The base's FAILED attempt reported no usage (a
 * rejected `extract` has no result to carry it), so nothing is summed from it.
 */
const retryUsage = (calls: number, totals: UsageTotals): ExtractionUsage => ({
  calls,
  ...totals,
});

/**
 * Wrap a base {@link Extractor} with a bounded self-correction retry — see the
 * file header for why the feedback travels as conversation turns and never in
 * the transcript.
 *
 * On each `extract`:
 *   1. Run `base.extract(transcript)`. A success returns unchanged — same
 *      object, same usage, no extra call. Any error that is not a
 *      {@link SchemaParseError} rethrows untouched.
 *   2. Otherwise, up to `maxRetries` times: assemble the base's messages with
 *      {@link buildMessages} (transcript last and unmodified), append the
 *      failed output as an assistant turn and the validation error as a user
 *      turn, and call the chat transport pinned to the target's
 *      `extractionSchema`. The response crosses the same gates as any
 *      extraction here: {@link assertStopFinishReason}, then `parseWithSchema`.
 *   3. A retry that succeeds returns its parsed fields (after `normalize`)
 *      with usage counting the retry calls. A retry that fails validation
 *      again appends its own output and error and loops; when the budget is
 *      spent the LAST `SchemaParseError` rethrows as-is, so a strategy ladder
 *      still sees the recognisable, transient failure it knows how to handle.
 */
export function schemaRetryExtractor<V extends Record<string, unknown>, P = NoProvenance>({
  base,
  target,
  chat,
  model,
  maxTokens,
  maxRetries = DEFAULT_MAX_RETRIES,
  normalize = (fields) => fields,
}: SchemaRetryOptions<V, P>): Extractor<Enveloped<V, P>> {
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError(
      `schemaRetryExtractor: maxRetries must be a non-negative integer, got ${maxRetries}`,
    );
  }
  const jsonSchema = z.toJSONSchema(target.extractionSchema, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
  const context = `schemaRetryExtractor: model response for "${target.name}"`;
  // `-`, not `:` — the schema-name charset constraint documented in per-group.
  const name = `${target.name}-retry`;

  return {
    async extract(
      transcript: AnnotatedTranscript,
      options?: ExtractOptions,
    ): Promise<ExtractionResult<Enveloped<V, P>>> {
      let failure: SchemaParseError;
      try {
        return await base.extract(transcript, options);
      } catch (error) {
        if (!(error instanceof SchemaParseError) || maxRetries === 0) throw error;
        failure = error;
      }

      // Assembled once per extract() and grown in place — each attempt appends
      // its own pair of turns, so attempt n sees every earlier rejected answer.
      // The transcript message itself is never touched.
      const messages: ChatMessage[] = buildMessages(target, transcript.text);
      const totals: UsageTotals = {};
      let calls = 0;
      for (;;) {
        if (failure.output !== undefined) {
          messages.push({ role: "assistant", content: JSON.stringify(failure.output) });
        }
        messages.push({ role: "user", content: buildFeedback(failure) });

        const completion = await completeOrClassify(
          chat,
          {
            model,
            messages,
            response_format: {
              type: "json_schema",
              json_schema: { name, schema: jsonSchema, strict: true },
            },
            maxTokens,
          },
          context,
          options,
        );
        calls += 1;
        addUsage(totals, completion.usage);

        assertStopFinishReason(completion, context);
        const raw = parseJsonContent(completion.content, context);
        try {
          const parsed = parseWithSchema(target.extractionSchema, raw, context);
          return { fields: normalize(parsed), raw, usage: retryUsage(calls, totals) };
        } catch (error) {
          if (!(error instanceof SchemaParseError)) throw error;
          if (calls >= maxRetries) throw error;
          failure = error;
        }
      }
    },
  };
}
