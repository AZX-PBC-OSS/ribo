// Scores both arms of probe 3 against the annotated corpus.
//
// Every (transcript, enum leaf) cell is one of two kinds:
//   SPOKEN  — ground truth asserts a member. Correct = that member, or an annotator-sanctioned
//             alternative (the `arguable.acceptableAlternatives` the corpus already records).
//   SILENT  — ground truth asserts nothing. Correct = "Not stated" (escape arm), or, in the
//             bare arm, whatever confidence threshold we would need to suppress it.
import { readFileSync } from "node:fs";
import { ENUM_LEAVES, NOT_STATED } from "./leaves.mjs";

const load = (arm) =>
  JSON.parse(readFileSync(new URL(`./results/enums-${arm}.json`, import.meta.url), "utf8"));

for (const arm of ["escape", "bare"]) {
  const rows = load(arm);
  let spoken = 0,
    spokenHit = 0,
    spokenAlt = 0,
    spokenWrongMember = 0,
    spokenSaidNotStated = 0;
  let silent = 0,
    silentSuppressed = 0,
    silentInvented = 0;
  const spokenConf = [];
  const silentConf = [];
  const invented = [];

  for (const r of rows) {
    for (const l of ENUM_LEAVES) {
      const a = r.answers[l.path];
      const t = r.truth[l.path];
      if (t) {
        spoken += 1;
        spokenConf.push(a.confidence);
        if (a.choice === t.value) spokenHit += 1;
        else if ((t.alts ?? []).includes(a.choice)) spokenAlt += 1;
        else if (a.choice === NOT_STATED) spokenSaidNotStated += 1;
        else spokenWrongMember += 1;
      } else {
        silent += 1;
        silentConf.push(a.confidence);
        if (a.choice === NOT_STATED) silentSuppressed += 1;
        else {
          silentInvented += 1;
          invented.push({ name: r.name, path: l.path, choice: a.choice, conf: a.confidence });
        }
      }
    }
  }

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const pct = (n, d) => `${((100 * n) / (d || 1)).toFixed(1)}%`;

  console.log(`\n=== arm: ${arm} ===`);
  console.log(`SPOKEN cells (ground truth asserts a member): ${spoken}`);
  console.log(
    `  exact member            ${String(spokenHit).padStart(4)}  ${pct(spokenHit, spoken)}`,
  );
  console.log(
    `  sanctioned alternative  ${String(spokenAlt).padStart(4)}  ${pct(spokenAlt, spoken)}`,
  );
  console.log(
    `  wrong member            ${String(spokenWrongMember).padStart(4)}  ${pct(spokenWrongMember, spoken)}`,
  );
  console.log(
    `  said "Not stated"       ${String(spokenSaidNotStated).padStart(4)}  ${pct(spokenSaidNotStated, spoken)}`,
  );
  console.log(`SILENT cells (ground truth asserts nothing):   ${silent}`);
  console.log(
    `  suppressed              ${String(silentSuppressed).padStart(4)}  ${pct(silentSuppressed, silent)}`,
  );
  console.log(
    `  INVENTED a value        ${String(silentInvented).padStart(4)}  ${pct(silentInvented, silent)}`,
  );
  console.log(
    `mean confidence: spoken ${mean(spokenConf).toFixed(3)} / silent ${mean(silentConf).toFixed(3)}`,
  );

  // Would a confidence gate separate the two populations?
  console.log("  gate   spoken-kept  silent-invented-let-through");
  for (const g of [0.0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
    const kept = spokenConf.filter((c) => c >= g).length;
    const leak = invented.filter((i) => i.conf >= g).length;
    console.log(
      `  ${g.toFixed(2)}   ${String(kept).padStart(5)}/${spoken} (${pct(kept, spoken)})` +
        `      ${String(leak).padStart(4)}/${silent} (${pct(leak, silent)})`,
    );
  }

  if (invented.length) {
    console.log(`  top invented values by confidence:`);
    for (const i of invented.sort((a, b) => b.conf - a.conf).slice(0, 8)) {
      console.log(
        `    ${i.conf.toFixed(2)} ${i.name.slice(0, 2)} ${i.path} = ${JSON.stringify(i.choice)}`,
      );
    }
  }
}
