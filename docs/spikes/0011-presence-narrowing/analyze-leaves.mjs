// How much SCHEMA survives a leaf-level presence pass, split into three bands rather than two?
//
// Reads spike 0008 probe 10's committed per-leaf presence results — 14 transcripts x 159 leaves.
// No API calls.
//
// Two bands (skip / extract) forces one threshold to be both the recall floor and the work floor,
// and spike 0008 measured that recall 1.000 is "one leaf wide" at leaf granularity. Three bands
// separate the questions: `lo` is the recall floor and must lose nothing, `hi` only decides how
// confident a leaf has to be to skip the band. The TypeSafe consistency cookbooks use the same
// shape (below 0.30 no / 0.30-0.70 uncertain / above 0.70 yes) — and for the same reason, since
// re-asking Jev is useless: its per-question probability std dev across repeats is ~0.010.
import { readFileSync } from "node:fs";

const ROWS = JSON.parse(
  readFileSync(new URL("../0008-typesafe-jev/results/presence-leaf.json", import.meta.url), "utf8"),
);

const cells = ROWS.flatMap((r) => r.cells);
const T = ROWS.length;
const LEAVES = cells.length / T;

console.log(
  `${cells.length} transcript x leaf cells over ${T} transcripts (${LEAVES} leaves), ` +
    `${cells.filter((c) => c.truth).length} actually discussed`,
);

const band = (lo, hi) => {
  const skipped = cells.filter((c) => c.noul < lo);
  const inBand = cells.filter((c) => c.noul >= lo && c.noul < hi);
  const direct = cells.filter((c) => c.noul >= hi);
  return { skipped, inBand, direct, lost: skipped.filter((c) => c.truth) };
};

console.log("\n                per transcript                     real leaves");
console.log("band            skip    band   extract   touched    LOST   in band   direct");
for (const [lo, hi] of [
  [0.2, 0.4],
  [0.2, 0.5],
  [0.2, 0.6],
  [0.15, 0.5],
  [0.25, 0.5],
]) {
  const b = band(lo, hi);
  const touched = (b.inBand.length + b.direct.length) / T;
  console.log(
    `[${lo.toFixed(2)},${hi.toFixed(2)})   ` +
      `${(b.skipped.length / T).toFixed(1).padStart(5)}  ${(b.inBand.length / T).toFixed(1).padStart(5)}  ` +
      `${(b.direct.length / T).toFixed(1).padStart(6)}   ${touched.toFixed(1).padStart(6)}    ` +
      `${String(b.lost.length).padStart(4)}   ${String(b.inBand.filter((c) => c.truth).length).padStart(6)}   ` +
      `${String(b.direct.filter((c) => c.truth).length).padStart(5)}`,
  );
}

const [LO, HI] = [0.2, 0.5];
const b = band(LO, HI);
const touched = b.inBand.length + b.direct.length;
console.log(
  `\nat [${LO}, ${HI}): ${LEAVES} leaves -> ${(touched / T).toFixed(1)} touched per transcript ` +
    `(${((100 * (cells.length - touched)) / cells.length).toFixed(1)}% of the schema dropped), ` +
    `${b.lost.length} discussed leaves lost`,
);

// Where the real leaves sit decides whether the band is a residue or a second pipeline. If almost
// everything real is already above `hi`, the band can simply ride along in the same call and the
// "recovery phase" costs nothing.
const realAbove = b.direct.filter((c) => c.truth).length;
const realTotal = cells.filter((c) => c.truth).length;
console.log(
  `${realAbove} of ${realTotal} discussed leaves (${((100 * realAbove) / realTotal).toFixed(1)}%) ` +
    `are already above ${HI} — the band is a residue, not a second pipeline`,
);

// The tail is what a recall requirement actually rests on, and it is not the median.
const pos = cells
  .filter((c) => c.truth)
  .map((c) => c.noul)
  .sort((a, b2) => a - b2);
console.log(
  `lowest discussed leaf ${pos[0].toFixed(3)} — the recall floor, and the reason \`lo\` is 0.20 and not 0.30`,
);
