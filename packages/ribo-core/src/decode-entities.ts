/**
 * @file Decode HTML entities to their literal characters.
 *
 * `Transcript.text` holds text as a human reads it, not escaped markup. Document
 * transcribers receive text from PDF text layers or document understanding APIs
 * that may contain HTML entities (`&amp;`, `&lt;`, …). Decoding happens at the
 * transcriber, so the canonical text is already rendered by the time anything
 * quotes from or checks against it — a correct citation does not fail the
 * grounding check on an encoding difference.
 *
 * Shared here rather than copied into each document transcriber because both
 * `@azx/ribo-transcriber-pdfjs` and `@azx/ribo-transcriber-managed-docs` need
 * the same decoding, and a divergence would make the same document read
 * differently depending on which engine ran.
 */

/** The named entities that appear in document text. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decode HTML entities in `text` to their literal characters.
 *
 * Handles the five named entities above and numeric character references
 * (`&#NN;`, `&#xNN;`). Unknown entities are left unchanged — a transcriber must
 * not silently corrupt text it does not recognise.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      if (entity[1] === "x" || entity[1] === "X") {
        const code = Number.parseInt(entity.slice(2), 16);
        return code > 0 ? String.fromCodePoint(code) : match;
      }
      const code = Number.parseInt(entity.slice(1), 10);
      return code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}
