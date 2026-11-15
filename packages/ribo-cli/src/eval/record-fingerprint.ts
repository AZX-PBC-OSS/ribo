/**
 * @file The three hashes every freshness decision goes through: the run
 * fingerprint, the corpus fingerprint and the record's identity key.
 *
 * They answer three different questions and never substitute for one another:
 *
 * - the RUN fingerprint says "these were asked the same way" — the schema
 *   document and the prompt inputs, and nothing else;
 * - the CORPUS fingerprint says "these are the same questions" — the cases'
 *   inputs and expected answers, and nothing else;
 * - the IDENTITY key says "these are the same measurement" — the backend, the
 *   model, the settings and the run fingerprint together.
 *
 * All three hash the JSON VALUE, never the in-memory representation that
 * carries it, and all three canonicalise with the ONE rule the CLI already
 * has (`canonicalJson`), because a second canonicaliser would be a second
 * answer to a question the codebase already answers once.
 */
import { createHash } from "node:crypto";

import type { CorpusPromptInputs, LoadedCase, LoadedCorpus } from "../corpus.js";
import { jsonValue, schemaFingerprint } from "../inspect/fingerprint.js";
import type { EvalRunRecord, EvalRunRecordIdentity } from "./record-schema.js";

/**
 * The corpus fingerprint's input for one case.
 *
 * A document case's input is its BYTES: the bytes are the question, and the
 * capture metadata beside them describes the capture rather than answering
 * anything, so it is excluded. A text or transcript case's input is its exact
 * text.
 * @param entry - The loaded case.
 * @returns The case's input, as the fingerprint sees it.
 */
const corpusCaseInput = (entry: LoadedCase): string =>
  entry.input.kind === "document"
    ? createHash("sha256").update(entry.input.bytes).digest("hex")
    : entry.input.text;

/**
 * The run fingerprint: a hash over the schema document and the prompt inputs.
 *
 * The two are hashed as one composite, so a change to either moves the
 * fingerprint. The canonicalisation makes the JSON's key order and formatting
 * free: reordering a key or reformatting whitespace leaves the fingerprint
 * alone. The prompt TEXT is hashed exactly — no case folding, no whitespace
 * folding — so even a whitespace-only edit to the instructions or to an
 * example's transcript is a different measurement.
 *
 * The settings are never in this input: they travel as their own field, and
 * folding them in would foreclose compare reporting strategy or options as
 * axes.
 * @param schemaDocument - The corpus's schema document, as loaded.
 * @param promptInputs - The corpus's prompt inputs, as the manifest declares them.
 * @returns The fingerprint, as 64 lowercase hex characters.
 * @category Eval
 */
export function runFingerprint(schemaDocument: unknown, promptInputs: CorpusPromptInputs): string {
  return schemaFingerprint(jsonValue({ schema: schemaDocument, prompt: promptInputs }));
}

/**
 * The corpus fingerprint: a hash over the corpus's cases only.
 *
 * Each case contributes its id, its kind, its input and its expectations —
 * the asserted entries, the declared-absent entries and the acceptable
 * alternatives alike. The schema, the prompt inputs and every other manifest
 * field are excluded: this fingerprint answers "are these the same
 * questions?", which the run fingerprint answers differently.
 * @param corpus - The loaded corpus.
 * @returns The fingerprint, as 64 lowercase hex characters.
 * @category Eval
 */
export function corpusFingerprint(corpus: LoadedCorpus): string {
  const cases = corpus.cases.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    input: corpusCaseInput(entry),
    expected: entry.expected,
    // A case with no defaults and a case with an empty list of defaults ask
    // the same questions, so they hash the same.
    defaults: entry.defaults ?? [],
  }));
  return schemaFingerprint(jsonValue({ cases }));
}

/**
 * The record's identity key: the key its four identity fields form.
 *
 * Equality of keys is "same measurement". The key is opaque, and the record
 * itself carries all four fields in plain text, so a reader can see which
 * axis moved rather than only that one did.
 *
 * A stray `model` key inside the settings is dropped before hashing: the
 * model is the identity's own field, and a caller holding the runner's
 * settings object — which carries the model inside it — must get the same
 * key the record persisted.
 * @param identity - The record's four identity fields.
 * @returns The identity key, as 64 lowercase hex characters.
 * @category Eval
 */
export function recordIdentity(identity: EvalRunRecordIdentity): string {
  const { model: _model, ...settings } = identity.settings;
  return schemaFingerprint(
    jsonValue({
      backend: identity.backend,
      model: identity.model,
      settings,
      fingerprint: identity.fingerprint,
    }),
  );
}

/**
 * The currency predicate: is this record current for these conditions?
 *
 * A record is current only when the backend, the model, the settings and the
 * run fingerprint ALL match. It reports current or stale and nothing more:
 * which field differed is compare's axis reporting, not this function's.
 *
 * The `current` argument may be another record — a record carries the four
 * fields — which is how a consumer judges a stored record against a
 * reference.
 * @param record - The record to judge.
 * @param current - The conditions the record is judged against.
 * @returns Whether the record is current.
 * @category Eval
 */
export function isRecordCurrent(record: EvalRunRecord, current: EvalRunRecordIdentity): boolean {
  return recordIdentity(record) === recordIdentity(current);
}
