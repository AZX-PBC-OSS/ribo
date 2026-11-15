/**
 * @file The retired verdict vocabulary, and where each piece of it landed.
 *
 * The Snugg spike's scorer carried a verdict vocabulary whose names were
 * partly Snugg's own — among them the `health-*` names, whose distinctions
 * were statements about Snugg's health tests rather than about a run. The
 * generic scorer replaces that vocabulary, and the design's §3 translation
 * table says where every retired verdict goes.
 *
 * The table lives here, alone, because that is the boundary the design
 * prescribes: it names the retired vocabulary once, to state where each piece
 * landed, and nothing else in the scorer knows those names. The rule that the
 * vocabulary belongs to the corpus — not to the scorer — holds everywhere
 * else; this module is the one documented exception, and it is the exception
 * the design itself asks for.
 *
 * The retired names are written out here rather than imported: the old
 * record's `CELL_VERDICTS` lives in an adapter's acceptance directory, which
 * is not part of that package's published exports, and the generic package
 * takes no dependency on any adapter.
 */
import type { EvalVerdict } from "./score-types.js";

/**
 * Every retired spike verdict, and the generic verdict it maps to.
 *
 * Each retired verdict maps exactly once, and every value is a member of the
 * generic taxonomy.
 * @category Eval
 */
export const RETIRED_VERDICT_TRANSLATION: Readonly<Record<string, EvalVerdict>> = Object.freeze({
  correct: "correct",
  "correct-null": "correct",
  wrong: "wrong",
  miss: "missed",
  "miss-excused": "unscorable",
  hallucination: "hallucinated",
  "hallucination-soft": "hallucinated",
  sanctioned: "correct",
  unscorable: "unscorable",
  "health-hallucinated-pass": "hallucinated",
  "health-hallucinated-problem": "hallucinated",
  "health-clean-dropped": "missed",
  "health-miss": "missed",
  "health-wrong": "wrong",
});
