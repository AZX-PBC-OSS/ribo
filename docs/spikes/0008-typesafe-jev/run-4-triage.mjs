// Probe 4: given a field/value pair an extractor produced, can a noul tell whether the
// transcript actually supports it?
//
// Three populations per transcript, all asked in one request:
//   SUPPORTED — the value ground truth asserts
//   CORRUPTED — the same leaf, with a different member of its own enum substituted
//   INVENTED  — a silent leaf paired with the value the bare arm of probe 3 actually produced,
//               i.e. a real hallucination from this same model, not a synthetic one
//
// Probe 3 showed `choice` confidence is blind to silence. This asks whether a purpose-built
// verification question sees what the confidence score could not.
import { readFileSync, writeFileSync } from "node:fs";
import { ask, results } from "./env.mjs";
import { corpus, assertedLeaves } from "./corpus.mjs";
import { ENUM_LEAVES } from "./leaves.mjs";

const bare = JSON.parse(readFileSync(results("enums-bare.json"), "utf8"));
const bareByName = new Map(bare.map((r) => [r.name, r]));
const optionsByPath = new Map(ENUM_LEAVES.map((l) => [l.path, l.options]));

/** Deterministic: the first member of the leaf's own enum that isn't the true one. */
const corrupt = (path, truth) => (optionsByPath.get(path) ?? []).find((o) => o !== truth) ?? null;

const question = (leaf, value) => ({
  type: "noul",
  instructions:
    `An automated extractor read this home-energy-audit dictation and recorded ` +
    `"${leaf}" = "${value}". Does the dictation actually support that value?`,
  criteria: {
    true: "The auditor states this value, or states something that plainly means it.",
    false:
      "The auditor never states this value — the field is not discussed, or a different " +
      "value is stated.",
  },
});

const rows = [];
for (const entry of corpus()) {
  const asserted = assertedLeaves(entry).filter((a) => a.isEnum);
  const spokenPaths = new Set(asserted.map((a) => `${a.group}.${a.leaf}`));

  const cells = [];
  for (const a of asserted) {
    const path = `${a.group}.${a.leaf}`;
    cells.push({ kind: "supported", path, value: a.value });
    const bad = corrupt(path, a.value);
    if (bad) cells.push({ kind: "corrupted", path, value: bad });
  }
  // The model's own hallucinations from probe 3's bare arm, on leaves nobody mentioned.
  const bareRow = bareByName.get(entry.name);
  for (const l of ENUM_LEAVES) {
    if (spokenPaths.has(l.path)) continue;
    const a = bareRow?.answers[l.path];
    if (a) cells.push({ kind: "invented", path: l.path, value: a.choice, priorConf: a.confidence });
  }

  const questions = Object.fromEntries(
    cells.map((c, i) => [`q${i}`, question(c.path.split(".")[1], c.value)]),
  );

  const res = await ask({ state: entry.transcript, questions });
  cells.forEach((c, i) => {
    rows.push({ name: entry.name, ...c, noul: res.answers[`q${i}`].noul });
  });
  console.log(
    `${entry.name.padEnd(28)} ${res.ms.toString().padStart(5)}ms  ${cells.length} cells  ` +
      `${res.usage.input_tokens} in / ${res.usage.output_tokens} out`,
  );
}

writeFileSync(results("triage.json"), JSON.stringify(rows, null, 2));

const by = (k) => rows.filter((r) => r.kind === k);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
console.log("\npopulation    n     mean noul   median   >=0.5   >=0.7");
for (const k of ["supported", "corrupted", "invented"]) {
  const xs = by(k)
    .map((r) => r.noul)
    .sort((a, b) => a - b);
  const med = xs[Math.floor(xs.length / 2)] ?? NaN;
  const hi5 = xs.filter((x) => x >= 0.5).length;
  const hi7 = xs.filter((x) => x >= 0.7).length;
  console.log(
    `${k.padEnd(12)} ${String(xs.length).padStart(4)}   ${mean(xs).toFixed(3)}      ` +
      `${med.toFixed(2)}    ${((100 * hi5) / xs.length).toFixed(1)}%   ${((100 * hi7) / xs.length).toFixed(1)}%`,
  );
}

// A triage gate keeps what looks supported and flags the rest. Sweep it.
console.log("\ngate   supported-kept   corrupted-caught   invented-caught");
for (const g of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
  const keep = (k) => by(k).filter((r) => r.noul >= g).length;
  const pc = (n, d) => `${((100 * n) / (d || 1)).toFixed(1)}%`;
  console.log(
    `${g.toFixed(2)}     ${pc(keep("supported"), by("supported").length).padStart(6)}` +
      `          ${pc(by("corrupted").length - keep("corrupted"), by("corrupted").length).padStart(6)}` +
      `            ${pc(by("invented").length - keep("invented"), by("invented").length).padStart(6)}`,
  );
}

const leaks = by("invented")
  .filter((r) => r.noul >= 0.7)
  .sort((a, b) => b.noul - a.noul);
if (leaks.length) {
  console.log("\ninvented values a 0.70 gate would wave through:");
  for (const r of leaks.slice(0, 10)) {
    console.log(
      `  noul=${r.noul.toFixed(2)} (choice-conf was ${r.priorConf?.toFixed(2)}) ` +
        `${r.name.slice(0, 2)} ${r.path} = ${JSON.stringify(r.value)}`,
    );
  }
}
