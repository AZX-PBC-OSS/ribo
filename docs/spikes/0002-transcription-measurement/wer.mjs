#!/usr/bin/env node
/**
 * Word Error Rate for the on-device transcription spike. Node built-ins only; imported by the driver
 * and unit-tested by wer.test.mjs. No external deps.
 *
 * ## Normalization (stated exactly, per Task 4)
 *
 * `normalize(text)`:
 *   1. lowercase
 *   2. curly apostrophes/quotes -> straight ('  ")
 *   3. replace every character except [a-z0-9], whitespace, and the straight apostrophe WITH A SPACE
 *      — this strips ALL punctuation and brackets and SPLITS on hyphens/slashes (so "[homeowner]" ->
 *      "homeowner", "R-38" -> "r 38", "direct-vented" -> "direct vented", "95%." -> "95") while
 *      keeping intra-word apostrophes ("I'll" stays "i'll")
 *   4. collapse runs of whitespace to a single space, trim
 *   5. split on space -> word tokens
 *
 * `wer(ref, hyp)` = word-level Levenshtein(ref, hyp) / |ref|, i.e. (S + D + I) / N, the standard ASR
 * definition. Returns the rate plus the S/D/I breakdown and reference length.
 *
 * ## The numeral caveat (reported alongside, not folded into the headline)
 *
 * Our authored transcripts spell numbers out ("thirty-two hundred", "hundred thousand BTU"); Whisper
 * emits digits ("3200", "100,000"). Standard WER counts every such pair as an error even though no
 * word was MIS-HEARD. We report standard WER as the headline (it is the honest, comparable number) and
 * separately surface the substitution list so numeral-formatting swaps can be told apart from true
 * mishearings — which is exactly the distinction that matters for the transcription->extraction
 * interaction, since the extraction scorer's parseNumberish tolerates words<->digits but not a
 * mis-heard jargon token like AFUE->"of FU".
 */

/** Straighten curly quotes then strip everything but letters, digits, spaces, and apostrophes. */
export function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(text) {
  const n = normalize(text);
  return n === "" ? [] : n.split(" ");
}

/**
 * Word-level Levenshtein with backtrace, returning distance and S/D/I counts.
 * ref/hyp are token arrays.
 */
export function align(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  const d = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  // Backtrace to count S/D/I and collect substitutions.
  let i = n;
  let j = m;
  let sub = 0;
  let del = 0;
  let ins = 0;
  const subs = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      i--;
      j--;
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      subs.push([ref[i - 1], hyp[j - 1]]);
      sub++;
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      del++;
      i--;
    } else {
      ins++;
      j--;
    }
  }
  subs.reverse();
  return { distance: d[n][m], sub, del, ins, subs };
}

export function wer(ref, hyp) {
  const r = tokens(ref);
  const h = tokens(hyp);
  const a = align(r, h);
  return {
    wer: r.length === 0 ? (h.length === 0 ? 0 : 1) : a.distance / r.length,
    sub: a.sub,
    del: a.del,
    ins: a.ins,
    refWords: r.length,
    hypWords: h.length,
    subs: a.subs,
  };
}
