// Probe 3: spike 0008's probe 11 (one three-way choice), re-run on kev-0.6b on-device.
//
// This is the one that matters. Probe 11's formulation SHIPPED as `corroborateExtractor` (ADR
// 0021): one `choice` per committed value over supports / contradicts / says_nothing, with the
// policy thresholding a ratio of non-`supports` verdicts. An on-device rung is only worth a
// package if that judgement survives at 0.6B.
//
// A copy of ../0008-typesafe-jev/run-11-three-way.mjs with the import swapped — same 951 cells
// from probe 4's triage.json, same question text, same tables.
//
// Hosted Jev, for reference: supports 91.6% on supported, contradicts 97.9% on corrupted,
// says_nothing 91.1% on invented — 8.4% false escalation catching 97.9% / 92.1%.
import { readFileSync, writeFileSync } from "node:fs";
import { LEAF_BY_PATH } from "../0001-extraction-snuggpro/schema-leaves.mjs";
import { corpus } from "../0008-typesafe-jev/corpus.mjs";
import { loadKev } from "./kev.mjs";

const CHUNK = Number(process.argv[2] ?? 40);
const cells = JSON.parse(
  readFileSync(new URL("../0008-typesafe-jev/results/triage.json", import.meta.url), "utf8"),
);
const transcripts = new Map(corpus().map((e) => [e.name, e.transcript]));
const byName = new Map();
for (const c of cells) {
  if (!byName.has(c.name)) byName.set(c.name, []);
  byName.get(c.name).push(c);
}

/** What each population SHOULD come back as, if the three-way split works. */
const EXPECTED = { supported: "supports", corrupted: "contradicts", invented: "says_nothing" };

const t0 = Date.now();
const kev = await loadKev();
console.log(`model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s, chunk=${CHUNK}\n`);

const out = [];
for (const [name, list] of byName) {
  const state = transcripts.get(name);
  const questions = {};
  list.forEach((c, j) => {
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

  const res = await kev.ask({ state, questions, chunk: CHUNK });
  list.forEach((c, j) => {
    const a = res.answers[`c${j}`];
    out.push({
      ...c,
      choice: a.choice,
      confidence: a.confidence,
      probabilities: a.probabilities,
      expected: EXPECTED[c.kind],
    });
  });
  console.log(
    `${name.padEnd(28)} ${String(res.ms).padStart(6)}ms  ${String(res.tokens).padStart(5)} tok/pass  ${list.length} cells`,
  );
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

console.log("\nescalate when choice != supports (no threshold at all):");
for (const k of ["supported", "corrupted", "invented"]) {
  const rows = by(k);
  const fired = rows.filter((r) => r.choice !== "supports").length;
  console.log(
    `  ${k.padEnd(12)} ${pc(fired, rows.length).padStart(7)} ${k === "supported" ? "wrongly escalated" : "caught"}`,
  );
}

console.log("\nconf   supported-escalated   corrupted-caught   invented-caught");
for (const t of [0.0, 0.3, 0.5, 0.6, 0.7, 0.8]) {
  const fired = (k) => by(k).filter((r) => r.choice !== "supports" && r.confidence >= t).length;
  console.log(
    `${t.toFixed(2)}   ${pc(fired("supported"), by("supported").length).padStart(6)}` +
      `                ${pc(fired("corrupted"), by("corrupted").length).padStart(6)}` +
      `            ${pc(fired("invented"), by("invented").length).padStart(6)}`,
  );
}

const corrAsContra = by("corrupted").filter((r) => r.choice === "contradicts").length;
const invAsNothing = by("invented").filter((r) => r.choice === "says_nothing").length;
console.log(
  `\nthe distinction two nouls cannot make:\n` +
    `  corrupted -> "contradicts"    ${pc(corrAsContra, by("corrupted").length)}\n` +
    `  invented  -> "says_nothing"   ${pc(invAsNothing, by("invented").length)}`,
);

// Threshold-free separation of "should escalate" from "should not", on P(not supports).
// Temperature-invariant, so this is the number directly comparable across models.
const pNot = (r) => 1 - r.probabilities.supports;
const good = by("supported")
  .map(pNot)
  .sort((a, b) => a - b);
const bad = [...by("corrupted"), ...by("invented")].map(pNot).sort((a, b) => a - b);
let better = 0;
for (const a of bad) for (const b of good) better += a > b ? 1 : a === b ? 0.5 : 0;
console.log(
  `\nAUC ${(better / (bad.length * good.length)).toFixed(4)}  (P(not supports), escalate-worthy vs not)`,
);

console.log("\nhosted Jev on these same 951 cells (spike 0008 probe 11):");
console.log(
  "  supported   91.6% supports |  corrupted 97.9% contradicts | invented 91.1% says_nothing",
);
console.log(
  "  escalate!=supports:  8.4% wrongly escalated, 97.9% corrupted caught, 92.1% invented caught",
);
