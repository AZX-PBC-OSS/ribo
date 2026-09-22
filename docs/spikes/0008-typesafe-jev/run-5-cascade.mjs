// Probe 5: the SDE-cascade verifier formulation, on probe 4's exact cells.
//
// Two changes from probe 4, both from https://docs.typesafe.ai/cookbooks/sde_cascade:
//   1. Inverted polarity — ask P(wrong), not P(supported). Probe 4's "does the dictation
//      support this?" rewarded implication; "is it absent from the dictation?" targets absence.
//   2. Several orthogonal questions per field, aggregated with max (`any(p > T)`), which the
//      cookbook argues for explicitly so one strong signal is not averaged into silence.
//
// Cells are read from results/triage.json so the two probes are compared like for like.
import { readFileSync, writeFileSync } from "node:fs";
import { ask } from "./env.mjs";

const cells = JSON.parse(readFileSync(new URL("./results/triage.json", import.meta.url), "utf8"));
const byName = new Map();
for (const c of cells) {
  if (!byName.has(c.name)) byName.set(c.name, []);
  byName.get(c.name).push(c);
}

const { corpus } = await import("./corpus.mjs");
const transcripts = new Map(corpus().map((e) => [e.name, e.transcript]));

// The cookbook's set, minus the ones that cannot fire here: every value is an enum member by
// construction, so type_mismatch and format_violation are vacuous, and these leaves are
// single-valued, so incomplete is too.
const CHECKS = {
  hallucinated: (f, v) => [
    `An extractor recorded "${f}" = "${v}" from this home-energy-audit dictation. ` +
      `Is that value unsupported by, or absent from, the dictation?`,
    { true: "the value is a hallucination", false: "the value is supported by the dictation" },
  ],
  off_target: (f, v) => [
    `An extractor recorded "${f}" = "${v}". Does this dictation fail to genuinely report ` +
      `the field "${f}" itself?`,
    {
      true: "the value was pulled from incidental text, or inferred from a different field",
      false: "the dictation genuinely reports this field",
    },
  ],
  name_desc_mismatch: (f, v) => [
    `Does the value "${v}" fail to match what the field "${f}" actually means?`,
    { true: "the value belongs to a different field", false: "the value fits this field" },
  ],
  unreasonable: (f, v) => [
    `Is "${v}" an implausible value for "${f}" given what this dictation describes?`,
    { true: "the value is implausible here", false: "the value is plausible" },
  ],
};
const CHECK_IDS = Object.keys(CHECKS);
const CHUNK = 30; // cells per request -> <=120 questions, well inside what probe 3 proved works

const out = [];
for (const [name, list] of byName) {
  const state = transcripts.get(name);
  let ms = 0;
  let inTok = 0;
  let outTok = 0;

  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const questions = {};
    slice.forEach((c, j) => {
      const field = c.path.split(".")[1];
      for (const id of CHECK_IDS) {
        const [instructions, criteria] = CHECKS[id](field, c.value);
        questions[`c${j}_${id}`] = { type: "noul", instructions, criteria };
      }
    });

    const res = await ask({ state, questions });
    ms += res.ms;
    inTok += res.usage.input_tokens;
    outTok += res.usage.output_tokens;

    slice.forEach((c, j) => {
      const flags = Object.fromEntries(
        CHECK_IDS.map((id) => [id, res.answers[`c${j}_${id}`].noul]),
      );
      out.push({ ...c, flags, maxFlag: Math.max(...Object.values(flags)) });
    });
  }
  console.log(
    `${name.padEnd(28)} ${String(ms).padStart(5)}ms  ${list.length} cells x ${CHECK_IDS.length}` +
      `  ${inTok} in / ${outTok} out`,
  );
}

writeFileSync(new URL("./results/cascade.json", import.meta.url), JSON.stringify(out, null, 2));

const by = (k) => out.filter((r) => r.kind === k);
const pc = (n, d) => `${((100 * n) / (d || 1)).toFixed(1)}%`;

console.log("\nper-question mean noul (want: low on supported, high on corrupted/invented)");
console.log(
  `${"".padEnd(12)}${CHECK_IDS.map((c) => c.slice(0, 10).padStart(12)).join("")}     max`,
);
for (const k of ["supported", "corrupted", "invented"]) {
  const rows = by(k);
  const m = (f) => rows.reduce((a, r) => a + f(r), 0) / (rows.length || 1);
  console.log(
    k.padEnd(12) +
      CHECK_IDS.map((c) =>
        m((r) => r.flags[c])
          .toFixed(3)
          .padStart(12),
      ).join("") +
      `   ${m((r) => r.maxFlag).toFixed(3)}`,
  );
}

console.log("\nFIRE_T   supported-escalated   corrupted-caught   invented-caught");
for (const t of [0.5, 0.6, 0.7, 0.8, 0.9]) {
  const fired = (k) => by(k).filter((r) => r.maxFlag > t).length;
  console.log(
    `${t.toFixed(2)}     ${pc(fired("supported"), by("supported").length).padStart(6)}` +
      `                ${pc(fired("corrupted"), by("corrupted").length).padStart(6)}` +
      `            ${pc(fired("invented"), by("invented").length).padStart(6)}`,
  );
}

// Did it fix the *Improved / inference leak probe 4 found?
const leak = by("invented").filter((r) => r.maxFlag <= 0.7);
const improvedLeak = leak.filter((r) => /Improved$/.test(r.path));
console.log(`\ninvented cells surviving FIRE_T=0.70: ${leak.length} of ${by("invented").length}`);
console.log(`  *Improved fields among them: ${improvedLeak.length}`);
console.log(`  (probe 4's single support-noul left 46, of which 21 were *Improved)`);
