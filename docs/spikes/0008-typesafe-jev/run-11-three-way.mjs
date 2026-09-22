// Probe 11: the citation_check cookbook's formulation — ONE choice with three outcomes —
// against probe 5's two-noul max, on probe 4's exact cells.
//
// https://docs.typesafe.ai/cookbooks/citation_check.md splits verification in two: a string
// match for whether the quote exists (which is `spanGroundedness`, already in ribo and already
// better, since its near-miss tier covers the reworded-quote case the cookbook calls a
// limitation), then ONE choice asking whether the context supports / contradicts / says nothing
// about the claim.
//
// Two reasons it might beat max(hallucinated, off_target): a choice returns a distribution plus
// a confidence rather than a max over two independent probabilities, and it cannot produce the
// incoherent states two nouls can. And it makes a distinction ribo cannot currently make —
// CONTRADICTED (a wrong value, which gap-fill could re-ask) versus UNSUPPORTED (a value nobody
// mentioned, which should be nulled).
import { readFileSync, writeFileSync } from "node:fs";
import { LEAF_BY_PATH } from "../0001-extraction-snuggpro/schema-leaves.mjs";
import { ask } from "./env.mjs";
import { corpus } from "./corpus.mjs";

const cells = JSON.parse(readFileSync(new URL("./results/triage.json", import.meta.url), "utf8"));
const transcripts = new Map(corpus().map((e) => [e.name, e.transcript]));
const byName = new Map();
for (const c of cells) {
  if (!byName.has(c.name)) byName.set(c.name, []);
  byName.get(c.name).push(c);
}

const CHUNK = 40;

// What each population SHOULD come back as, if the three-way split works.
const EXPECTED = { supported: "supports", corrupted: "contradicts", invented: "says_nothing" };

const out = [];
for (const [name, list] of byName) {
  const state = transcripts.get(name);
  let ms = 0;

  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const questions = {};
    slice.forEach((c, j) => {
      const field = c.path.split(".")[1];
      const options = LEAF_BY_PATH.get(c.path)?.options ?? null;
      const vocab = options
        ? `The field "${field}" records exactly one of: ${options.join(", ")}. `
        : "";
      questions[`c${j}`] = {
        type: "choice",
        instructions:
          `${vocab}An extractor read this home-energy-audit dictation and recorded ` +
          `"${field}" = ${JSON.stringify(c.value)}. The value is a code from that list, not a ` +
          `quote — a faithful encoding of what the auditor said counts as supporting it. ` +
          `What is the relationship between the dictation and that recorded value?`,
        criteria: {
          supports: "the dictation states this value, or plainly means it",
          contradicts: "the dictation discusses this field but states a different value",
          says_nothing: "the dictation never discusses this field at all",
        },
      };
    });

    const res = await ask({ state, questions });
    ms += res.ms;
    slice.forEach((c, j) => {
      const a = res.answers[`c${j}`];
      out.push({
        ...c,
        choice: a.choice,
        confidence: a.confidence,
        probabilities: a.probabilities,
        expected: EXPECTED[c.kind],
      });
    });
  }
  console.log(`${name.padEnd(28)} ${String(ms).padStart(5)}ms  ${list.length} cells`);
}

writeFileSync(new URL("./results/three-way.json", import.meta.url), JSON.stringify(out, null, 2));

const by = (k) => out.filter((r) => r.kind === k);
const pc = (n, d) => `${((100 * n) / (d || 1)).toFixed(1)}%`;

console.log("\nwhat each population came back as");
console.log(
  `${"population".padEnd(12)}${"n".padStart(5)}${"supports".padStart(11)}${"contradicts".padStart(13)}${"says_nothing".padStart(14)}`,
);
for (const k of ["supported", "corrupted", "invented"]) {
  const rows = by(k);
  const n = (v) => rows.filter((r) => r.choice === v).length;
  console.log(
    k.padEnd(12) +
      String(rows.length).padStart(5) +
      pc(n("supports"), rows.length).padStart(11) +
      pc(n("contradicts"), rows.length).padStart(13) +
      pc(n("says_nothing"), rows.length).padStart(14),
  );
}

// The escalation decision: anything that is not "supports" is a problem.
console.log("\nescalate when choice != supports (no threshold at all):");
for (const k of ["supported", "corrupted", "invented"]) {
  const rows = by(k);
  const fired = rows.filter((r) => r.choice !== "supports").length;
  const label = k === "supported" ? "wrongly escalated" : "caught";
  console.log(`  ${k.padEnd(12)} ${pc(fired, rows.length).padStart(7)} ${label}`);
}

// With a confidence gate: only act on a confident non-supports verdict.
console.log("\nconf   supported-escalated   corrupted-caught   invented-caught");
for (const t of [0.0, 0.5, 0.6, 0.7, 0.8]) {
  const fired = (k) => by(k).filter((r) => r.choice !== "supports" && r.confidence >= t).length;
  console.log(
    `${t.toFixed(2)}   ${pc(fired("supported"), by("supported").length).padStart(6)}` +
      `                ${pc(fired("corrupted"), by("corrupted").length).padStart(6)}` +
      `            ${pc(fired("invented"), by("invented").length).padStart(6)}`,
  );
}

// The new capability: does it tell a wrong value from an unmentioned one?
const corrAsContra = by("corrupted").filter((r) => r.choice === "contradicts").length;
const invAsNothing = by("invented").filter((r) => r.choice === "says_nothing").length;
console.log(
  `\nthe distinction two nouls cannot make:\n` +
    `  corrupted -> "contradicts"    ${pc(corrAsContra, by("corrupted").length)}\n` +
    `  invented  -> "says_nothing"   ${pc(invAsNothing, by("invented").length)}`,
);

console.log("\nprobe 5 (two-noul max) on these same cells, FIRE_T=0.60:");
console.log("  supported escalated 21.1% | corrupted caught 100.0% | invented caught 98.0%");
console.log("  best subset (hallucinated+off_target) 14.7% | 100.0% | 97.6%");
