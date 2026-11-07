import type { AnnotatedTranscript } from "./annotated-transcript.js";

/**
 * @file The pure contract for combining per-capture transcripts into one.
 *
 * This replaces the combination policy that used to live inside
 * `joinSessionTranscript` fused with its database I/O. Splitting the two means
 * the policy is testable with a plain array and no database, and a host can
 * replace it without forking the I/O.
 */

/**
 * Combines per-capture transcripts into one. **Pure**: takes an array (already
 * sorted by `seq`), returns a value, touches nothing else. A combiner that
 * takes the `Storage`, or reads anything, has reproduced the defect this
 * contract exists to fix.
 *
 * The relay supplies the array; the combiner decides how the texts join. A
 * caller who wants a different policy writes their own combiner instead of
 * asking for a second flag on the default.
 *
 * Two type parameters, not one: the combined transcript's annotations are not any input's. The
 * default returns an empty bag, so a single parameter would make it claim a shape it never
 * produces.
 * @category Captures & Sources
 */
export type TranscriptCombiner<
  In = Readonly<Record<string, unknown>>,
  Out = Readonly<Record<string, unknown>>,
> = (parts: readonly AnnotatedTranscript<In>[]) => AnnotatedTranscript<Out>;

/**
 * Options for {@link createDefaultTranscriptCombiner}.
 * @category Captures & Sources
 */
export interface DefaultTranscriptCombinerOptions {
  /**
   * When true, prefix each capture's text with a per-capture marker
   * (`\n===== CAPTURE seq:N kind:K id:I =====\n`) so a model can attribute a
   * value to the capture it came from. Mirrors the page-marker convention
   * (`\n===== PAGE n =====\n`) from `@azx/ribo-transcriber-pdfjs`.
   *
   *    The marker is built from `capture.seq`, `capture.kind`, and `capture.id`
   *    in each part's `annotations` bag — the relay populates these from the
   *    storage item under a reserved `capture.` prefix. The bag is open by design;
   *    the default combiner reads these keys and nothing else.
   *
   * Defaults to `false`: the joined text is unchanged for existing callers.
   * What every extractor sees does not shift unless the caller explicitly opts
   * in — an extractor might produce different output when it sees markers, and
   * that is a behaviour change for every caller.
   */
  markCaptures?: boolean;
}

/**
 * The per-capture marker prefix. The full marker for a capture is
 * `` `\n===== CAPTURE seq:${seq} kind:${kind} id:${id} =====\n` ``.
 *
 * Mirrors the page-marker convention from `@azx/ribo-transcriber-pdfjs`:
 * a `===== … =====` line on its own, surrounded by newlines, so it is
 * greppable, unambiguous against real transcript content, and cheap in tokens.
 */
const CAPTURE_MARKER_PREFIX = "\n===== CAPTURE ";

/** The annotation keys a marker is built from, in the order they appear in it. */
const MARKER_KEYS = ["capture.seq", "capture.kind", "capture.id"] as const;

/**
 * Build the per-capture marker for one part.
 *
 * The marker sits **before** the capture's text, never inside it — so
 * `isSpanGrounded` still finds a verbatim quote from within the transcript as a
 * substring of the joined text. The `\n` at each end of the marker separates it
 * from surrounding text without needing a join space.
 *
 * The keys are read from the `capture.` namespace the relay reserves for
 * capture metadata. The marker output still reads `seq:N kind:K id:I` — the
 * namespace is where the value comes from, not what the marker says.
 */
function captureMarker(part: AnnotatedTranscript, index: number): string {
  const a = part.annotations;
  // Read explicitly rather than `String(a["capture.seq"])`. The bag is
  // `unknown`-valued, so a part built without these keys would stringify to
  // `seq:undefined` and inject that into the canonical text — the string a model
  // quotes from and a reviewer reads. Silent garbage in the grounding substrate
  // is the one failure this file must not produce, so a missing key is an error.
  const marker = MARKER_KEYS.map((key) => {
    const value = a[key];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new TypeError(
        `createDefaultTranscriptCombiner: markCaptures needs a string or number \`${key}\` in ` +
          `parts[${index}].annotations, got ${typeof value}. The relay populates these from the ` +
          `storage item; a hand-built part must supply them.`,
      );
    }
    // The marker reads `seq:N` not `capture.seq:N` — the namespace is internal.
    return `${key.slice("capture.".length)}:${value}`;
  }).join(" ");
  return `${CAPTURE_MARKER_PREFIX}${marker} =====\n`;
}

/**
 * Create the default transcript combiner. Reproduces the output of the previous
 * `joinSessionTranscript` byte-for-byte: texts joined with a single space when
 * `markCaptures` is false (or absent), or each text preceded by a per-capture
 * marker (then concatenated with no separator) when true.
 *
 * Zero parts produce empty text; a single part produces just that text (with a
 * marker when `markCaptures` is true). Both fall out of the join naturally —
 * there is no special case.
 * @category Captures & Sources
 */
export function createDefaultTranscriptCombiner(
  options?: DefaultTranscriptCombinerOptions,
): TranscriptCombiner<Readonly<Record<string, unknown>>, Record<string, never>> {
  const { markCaptures = false } = options ?? {};
  // `Record<string, never>` in the return position is the point of the second parameter: this
  // combiner emits an empty bag, and saying so stops a caller reading input annotations off it.
  return (parts): AnnotatedTranscript<Record<string, never>> => {
    if (markCaptures) {
      return {
        text: parts.map((p, i) => captureMarker(p, i) + p.text).join(""),
        annotations: {},
      };
    }
    return {
      text: parts.map((p) => p.text).join(" "),
      annotations: {},
    };
  };
}
