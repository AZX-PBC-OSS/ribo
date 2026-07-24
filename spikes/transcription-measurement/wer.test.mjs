#!/usr/bin/env node
/**
 * Self-check for wer.mjs.  node spikes/transcription-measurement/wer.test.mjs
 * Standalone (like the extraction spike's score.test.mjs) — NOT part of ./check.sh's vitest globs.
 */
import assert from "node:assert/strict";

import { normalize, tokens, wer } from "./wer.mjs";

let n = 0;
const ok = (name) => {
  n++;
  console.log(`  ok ${name}`);
};

// normalize: punctuation/brackets stripped, apostrophes kept, case folded
assert.equal(normalize("The [homeowner] said, R-38!"), "the homeowner said r 38");
ok("normalize strips brackets/punctuation, splits R-38 -> r 38");
assert.equal(normalize("I'll note that."), "i'll note that");
ok("normalize keeps intra-word apostrophe");
assert.deepEqual(tokens("95%."), ["95"]);
ok("tokens drops percent sign");

// identical -> 0
assert.equal(wer("the blower door test", "the blower door test").wer, 0);
ok("identical text -> WER 0");

// one substitution of four -> 0.25
{
  const r = wer("the blower door test", "the blower door best");
  assert.equal(r.sub, 1);
  assert.equal(r.del, 0);
  assert.equal(r.ins, 0);
  assert.equal(r.wer, 0.25);
}
ok("single substitution -> 1/4");

// one deletion
{
  const r = wer("a b c d", "a b d");
  assert.equal(r.del, 1);
  assert.equal(r.wer, 0.25);
}
ok("single deletion -> 1/4");

// one insertion
{
  const r = wer("a b c", "a b x c");
  assert.equal(r.ins, 1);
  assert.equal(r.refWords, 3);
  assert.equal(Number(r.wer.toFixed(4)), 0.3333);
}
ok("single insertion -> 1/3");

// the AFUE jargon mishearing shows up as a substitution
{
  const r = wer("the furnace AFUE is 95 percent", "the furnace of FU is 95 percent");
  // "afue" -> "of" + "fu": one sub + one ins over 6 ref words
  assert.ok(r.sub + r.ins >= 2);
  assert.ok(r.wer > 0);
}
ok("AFUE -> 'of FU' counts as error(s)");

// empty hyp -> all deletions -> WER 1
assert.equal(wer("one two three", "").wer, 1);
ok("empty hypothesis -> WER 1.0");

console.log(`\n${n} assertions passed`);
