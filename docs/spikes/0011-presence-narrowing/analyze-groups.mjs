// How many extraction CALLS survive a group-level presence pass, and does any real group die?
//
// Reads spike 0008 probe 2's committed router results — 14 transcripts x 5 groups, one noul per
// group ("does this dictation touch this group?"). No API calls: this is arithmetic over evidence
// already on disk.
//
// The number that decides the design is not precision. It is **groups wrongly skipped**: a skipped
// group gets no extraction call at all, its leaves stay at the presence phase's null seed, and
// nothing downstream ever revisits them. One wrongly-skipped group is silent data loss.
import { readFileSync } from "node:fs";

const ROUTER = JSON.parse(
  readFileSync(new URL("../0008-typesafe-jev/results/router.json", import.meta.url), "utf8"),
);

const cells = ROUTER.flatMap((run) =>
  Object.keys(run.noul).map((group) => ({ group, p: run.noul[group], present: run.truth[group] })),
);

console.log(
  `${cells.length} transcript x group cells over ${ROUTER.length} transcripts — ` +
    `${cells.filter((c) => c.present).length} present / ${cells.filter((c) => !c.present).length} absent`,
);

console.log("\nthreshold   calls kept   skipped   % calls saved   groups WRONGLY skipped");
for (const t of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
  const kept = cells.filter((c) => c.p >= t);
  const skipped = cells.filter((c) => c.p < t);
  const lost = skipped.filter((c) => c.present);
  console.log(
    `   ${t.toFixed(2)}       ${String(kept.length).padStart(4)}       ${String(skipped.length).padStart(4)}` +
      `      ${((100 * skipped.length) / cells.length).toFixed(1).padStart(5)}%` +
      `         ${String(lost.length).padStart(3)}` +
      (lost.length ? `  [${lost.map((l) => l.group).join(", ")}]` : ""),
  );
}

// The plateau is the finding. A threshold that can move without changing the outcome is one a new
// transcript cannot fall off; spike 0008's LEAF-level recall 1.000 had no such room ("one leaf
// wide"), which is why these two signals get different jobs in the design.
const safe = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].filter(
  (t) => cells.filter((c) => c.p < t && c.present).length === 0,
);
console.log(
  `\nthresholds with ZERO groups lost: ${safe.map((t) => t.toFixed(2)).join(", ")}` +
    `  (plateau width ${(Math.max(...safe) - Math.min(...safe)).toFixed(2)})`,
);

const t = 0.5;
console.log(
  `\nat 0.50: ${(cells.filter((c) => c.p >= t).length / ROUTER.length).toFixed(1)} of ` +
    `${cells.length / ROUTER.length} groups get a call, per transcript`,
);
console.log(
  `router cost: ${Math.round(ROUTER.reduce((a, r) => a + r.ms, 0) / ROUTER.length)}ms, ` +
    `${Math.round(ROUTER.reduce((a, r) => a + r.usage.input_tokens, 0) / ROUTER.length)} input tokens per transcript`,
);
