/**
 * @file The `definition` form-part builder for the Fast Transcription request.
 *
 * Azure Fast Transcription accepts a phrase list to bias recognition toward
 * supplied domain terms — `definition.phraseList.phrases`, an array of strings.
 * This is load-bearing, not a refinement: measured on 2026-08-17 the same audio
 * returned "our 19" with no phrase list and "R-19" with one (design §6).
 * R-values are exactly the class of term the downstream extractor reads.
 *
 * The parameter exists only from api-version **2025-10-15** onward, which is the
 * version this package targets. A plausible-looking wrong key (`phrase_list`,
 * `phraseHints`, a bare array) is **silently ignored** by the service — no
 * error, just worse transcription — so the nesting is asserted in tests rather
 * than left to look right.
 *
 * **The vocabulary belongs to the host, not this package.** This package is
 * tool-agnostic and holds no home-energy word list. The option mirrors the
 * shape of `TranscribeHints.vocabulary` in
 * `ribo-transcriber-ondevice/src/config.ts` — `readonly string[]` — so a single
 * host-held list can feed both engines by two different mechanisms: a jargon
 * prefix on-device, a phrase list here. The type is re-declared here rather than
 * imported, because `TranscribeHints` lives in the on-device package and must
 * not move to `ribo-core` (plan Task 5, design §6).
 */

/** The `definition` JSON sent as a form part in the transcribe request. */
export interface TranscriptionDefinition {
  /** Locale(s) driving language selection — always present. */
  readonly locales: readonly string[];
  /** Optional phrase list biasing recognition toward supplied domain terms. */
  readonly phraseList?: { readonly phrases: readonly string[] };
}

/**
 * Build the `definition` object for the Fast Transcription request.
 *
 * `locales` is always present — it drives language selection and is the one part
 * Task 4 already sent. When `vocabulary` is supplied (non-empty after trimming
 * and dropping blanks), it is nested at `phraseList.phrases`. When no terms are
 * supplied, `phraseList` is **omitted entirely** rather than sent as an empty
 * object or empty array: an empty phrase list is no phrase list, and asserting
 * the absence (in tests) guards against a builder that *replaces* the definition
 * instead of extending it — which would pass a naive phrase-list test while
 * silently breaking language selection.
 */
export function buildDefinition(vocabulary?: readonly string[]): TranscriptionDefinition {
  const phrases = vocabulary?.map((term) => term.trim()).filter(Boolean) ?? [];
  if (phrases.length > 0) {
    return { locales: ["en-US"], phraseList: { phrases } };
  }
  return { locales: ["en-US"] };
}
