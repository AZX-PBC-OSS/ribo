// Per-arm cost and speed from the run metrics: the baseline from the first run (with its one
// transport-failed cell replaced by the re-run), the narrowed arms from the array-fill run and
// from the run with the decline wording on top of it.
//
//   node summarize.mjs
import { readFileSync } from "node:fs";

const read = (f) => JSON.parse(readFileSync(new URL(`./results/${f}`, import.meta.url), "utf8"));
const first = read("metrics-pathonly.json");
const rerun10 = read("metrics-rerun-10.json").baseline[0];
const fixed = read("metrics.json");
// Transcript 01's narrowed cells hit hung connections (each a 300 s fetch header timeout) during
// a Foundry episode; re-run minutes later they took 23 s and 9 s with identical token counts.
const rerun01 = read("metrics-rerun-01.json");
const swap01 = (arm) =>
  fixed[arm].map((r) => (r.name === "01-attic-r-value-shell" ? rerun01[arm][0] : r));
const decline = read("metrics-decline.json");
const arms = {
  baseline: first.baseline.map((r) => (r.ok ? r : rerun10)),
  "md-1": swap01("md-1"),
  jev: swap01("jev"),
  "md-1-decline": decline["md-1"],
  "jev-decline": decline.jev,
};

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

console.log(
  "arm           ok  wall p50  wall mean  chat calls  chat in tok  chat out tok  presence in tok",
);
for (const [arm, rows] of Object.entries(arms)) {
  const ok = rows.filter((r) => r.ok);
  console.log(
    `${arm.padEnd(12)} ${String(ok.length).padStart(3)}  ` +
      `${(median(ok.map((r) => r.ms)) / 1000).toFixed(1).padStart(7)}s  ` +
      `${(mean(ok.map((r) => r.ms)) / 1000).toFixed(1).padStart(8)}s  ` +
      `${mean(ok.map((r) => r.chat.requests))
        .toFixed(1)
        .padStart(10)}  ` +
      `${Math.round(mean(ok.map((r) => r.chat.inputTokens)))
        .toString()
        .padStart(11)}  ` +
      `${Math.round(mean(ok.map((r) => r.chat.outputTokens)))
        .toString()
        .padStart(12)}  ` +
      `${ok[0].presence ? Math.round(mean(ok.map((r) => r.presence.inputTokens))) : "-"}`.padStart(
        15,
      ),
  );
}
