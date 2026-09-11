import { z } from "zod";

/**
 * The provenance envelope every extracted field is wrapped in.
 *
 * `extractedSchema(inner)` turns any zod type into `{ value, confidence, sourceSpan }`:
 *
 *   - `value` is `inner.nullable()` — `null` means "not stated in the transcript". Never a
 *     guess, never an inference.
 *   - `confidence` is the model's self-reported score. Read the warning below before using it.
 *   - `sourceSpan` is the VERBATIM transcript quote justifying `value`, or `null`. It is what
 *     the review card shows the auditor as justification, and it is checkable — see
 *     {@link isSpanGrounded}.
 *
 * Two rules hold for every key, and neither is stylistic:
 *
 * 1. **Every key is required and nullable. None is `.optional()`.** This is the
 *    anti-hallucination rule enforced at the schema level: the model must explicitly emit
 *    `null` for "not mentioned" rather than silently omitting the key. An omitted key is
 *    indistinguishable from a field the model never considered; an explicit `null` is an
 *    answer. Adding `.optional()` anywhere here quietly deletes that guarantee.
 * 2. **Strict-structured-output compatible.** No top-level `.optional()`, no unions of
 *    objects, closed object shapes, and no numeric/string constraint keywords — OpenAI strict
 *    mode rejects the `minimum`/`maximum`/`pattern` that `.min()`/`.max()`/`.regex()` emit.
 *    That is why `confidence` is a bare `z.number()` even though 0..1 is the intent; clamp the
 *    range in normalization, not here.
 *
 * `sourceSpan` is nullable independently of `value`: a field can legitimately carry
 * `value: null` with a non-null `sourceSpan` when the auditor explicitly declined to state it
 * or explicitly reported nothing to report ("I'm not going to guess the ACH on this one").
 *
 * ---
 *
 * ## ⚠️ `confidence` MUST NOT drive review flagging. Do not wire a threshold to it.
 *
 * It is kept because one run is not grounds for deleting a field, and because a future model
 * or a calibration pass may make it meaningful. Today it carries **no discriminating signal**.
 *
 * Evidence — the extraction spike (`spikes/extraction-snuggpro/`, scored over 14 transcripts / **322
 * slots**, `results/codex-score.json`):
 *
 *   - mean confidence on **correct** answers: **0.996**
 *   - mean confidence on **correct nulls**: **1.000**
 *   - confidence gap between right and wrong answers: **not computable** — the model returned
 *     ~1.0 on effectively everything.
 *
 * Uniform-high confidence is not calibration, it is a constant. A "flag anything under 0.8"
 * rule against that distribution flags nothing, which reads as "the extraction is clean" when
 * it means "the signal is absent". Anyone tuning that threshold is tuning noise.
 *
 * **Use {@link isSpanGrounded} instead.** Whether `sourceSpan` is a verbatim substring of the
 * transcript is a fact we can check ourselves without trusting the model's self-report, and it
 * discriminates: in the same spike run every one of the 77 spans checked was verbatim, so a
 * non-grounded span is genuinely anomalous and worth surfacing to a reviewer.
 */
export const extractedSchema = <T extends z.ZodType>(inner: T) =>
  z.strictObject({
    /** null = not stated in the transcript. Never a guess, never an inference. */
    value: inner.nullable(),
    /** The model's self-reported score. NOT load-bearing — see the warning above. */
    confidence: z.number(),
    /** Verbatim transcript quote justifying `value`, or null. Check it with `isSpanGrounded`. */
    sourceSpan: z.string().nullable(),
  });

/**
 * Is `schema` an object {@link extractedSchema} built — a leaf envelope, as opposed to a group of
 * them or a plain-leaf row?
 *
 * Exists because the two shapes became genuinely ambiguous the day a group could declare `"row"`
 * provenance. Before that, "every property is an object" separated a group from an envelope, since
 * an envelope's `confidence` is a bare number; a row of plain leaves also has no object properties,
 * so that test now calls a row an envelope and collapses the per-group split to a single call.
 *
 * Matched on the key set AND each key's kind, not on key names alone: the names are ordinary
 * enough that a real field set could carry them (a row's own `sourceSpan` does), and matching the
 * kinds is what tells an envelope from an impostor. It lives here rather than in the split because
 * `extractedSchema` above is the shape being recognised — the predicate and the constructor have
 * to change together, so they sit together.
 */
export const isExtractedSchema = (schema: z.ZodType): boolean => {
  if (!(schema instanceof z.ZodObject)) return false;
  const shape = schema.shape as Record<string, z.ZodType | undefined>;
  const keys = Object.keys(shape);
  if (keys.length !== 3) return false;
  return (
    shape.value instanceof z.ZodNullable &&
    shape.confidence instanceof z.ZodNumber &&
    shape.sourceSpan instanceof z.ZodNullable
  );
};

/**
 * A value of type `T` carried with its provenance.
 *
 * Inferred from {@link extractedSchema} rather than hand-declared, so the schema stays the
 * single source of truth: `Extracted<number>` is `{ value: number | null; confidence: number;
 * sourceSpan: string | null }`.
 */
export type Extracted<T> = z.infer<ReturnType<typeof extractedSchema<z.ZodType<T>>>>;

/**
 * Is `span` a verbatim quote from `transcript`?
 *
 * The checkable alternative to trusting `confidence`. A grounded span means the model quoted
 * the auditor; an ungrounded one means it produced text that was never said, which is the
 * failure mode the whole envelope exists to catch.
 *
 * Pure predicate — no I/O, no normalization of the transcript. Trailing whitespace is stripped
 * from the span before the comparison because spans arrive trimmed while the transcript keeps
 * its line breaks and spacing, so an otherwise-exact quote would fail on an invisible
 * character. Nothing else is normalized: case, punctuation and internal whitespace must match,
 * because "verbatim" that tolerates rewriting is not verbatim. (The spike's scorer draws the
 * same line — it grades case/whitespace-normalized matches as "near-miss", not verbatim.)
 *
 * A `null` span is not grounded, and neither is an empty one: every string contains `""`, so
 * accepting it would make the check vacuously true.
 */
export const isSpanGrounded = (span: string | null, transcript: string): boolean => {
  if (span === null) return false;
  const quote = span.trimEnd();
  if (quote.length === 0) return false;
  return transcript.includes(quote);
};

/**
 * How well a span is grounded, in three tiers rather than two.
 *
 *   - `"grounded"` — verbatim. Exactly {@link isSpanGrounded}.
 *   - `"near-miss"` — the quote is in the document, differing only in case, whitespace runs or
 *     quote characters.
 *   - `"ungrounded"` — the text is not there. This is the tier worth interrupting a reviewer for.
 *
 * **Why the middle tier is not a nicety.** A document transcript is laid out, not spoken:
 * `layoutPageText` pads columns so they align, so the transcript holds `"$       5,250.00"` while
 * a model quoting that line reports `"$ 5,250.00"`. Two tiers report that as ungrounded — the
 * same answer given for text the model invented — and a reviewer is sent hunting for a
 * hallucination that never happened. Once a fabricated citation and a re-spaced one are
 * indistinguishable, the flag stops meaning anything, which is the same way `confidence` failed.
 *
 * The extraction spike's scorer (`spikes/extraction-snuggpro/score.mjs`) draws this line already,
 * and this is that rule. It draws two more that are deliberately NOT adopted here: a
 * punctuation-insensitive match, and a "some 4-word fragment appears" match. Both are right for
 * grading a corpus, where the question is whether the model found the answer. Neither is right for
 * a review card, where the question is whether the auditor can check the quote against the
 * document — and a paraphrase sharing four words cannot be checked that way.
 *
 * A `null` or blank span is `"ungrounded"`, never near: every string contains `""`, so a
 * normalized `.includes` would call an empty span a near miss of everything.
 */
export type SpanGroundedness = "grounded" | "near-miss" | "ungrounded";

/**
 * Decode a small, deliberately scoped set of HTML entities. Only the entities that
 * actually occur in markdown / HTML-escaped transcripts are handled (`&amp;`,
 * `&lt;`, `&gt;`, `&quot;`, `&apos;`), plus numeric decimal and hexadecimal forms.
 * Keeps the helper dependency-free and tiny.
 */
function decodeHtmlEntities(text: string): string {
  return (
    text
      // Named entities first, case-insensitive so `&AMP;` and `&amp;` both land.
      .replace(/&(?:amp|lt|gt|quot|apos);/gi, (entity) => {
        switch (entity.toLowerCase()) {
          case "&amp;":
            return "&";
          case "&lt;":
            return "<";
          case "&gt;":
            return ">";
          case "&quot;":
            return '"';
          case "&apos;":
            return "'";
          default:
            return entity;
        }
      })
      .replace(/&#(\d+);/g, (entity, decimal) => {
        const code = parseInt(decimal, 10);
        return Number.isNaN(code) || code < 0 || code > 0x10ffff ? entity : String.fromCodePoint(code);
      })
      .replace(/&#x([0-9a-f]+);/gi, (entity, hex) => {
        const code = parseInt(hex, 16);
        return Number.isNaN(code) || code < 0 || code > 0x10ffff ? entity : String.fromCodePoint(code);
      })
  );
}

/** Case-, whitespace-, quote- and HTML-entity-insensitive form, for the near-miss tier only. */
const loosen = (text: string): string =>
  decodeHtmlEntities(text.toLowerCase())
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/gu, " ")
    .trim();

export const spanGroundedness = (span: string | null, transcript: string): SpanGroundedness => {
  if (isSpanGrounded(span, transcript)) return "grounded";
  if (span === null) return "ungrounded";
  const quote = loosen(span);
  if (quote.length === 0) return "ungrounded";
  return loosen(transcript).includes(quote) ? "near-miss" : "ungrounded";
};
