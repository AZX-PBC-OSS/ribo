#!/usr/bin/env node
/**
 * Read the `*-score.json` files `score.mjs` writes for each run, join them with each run's
 * own `manifest.json` (calls, tokens, latency), and print one comparison table.
 *
 *   node spikes/managed-three-phase/compare.mjs <results-dir> [<results-dir> ...]
 *
 * Pricing is per Mtok, taken from the platform's published roster; cost is estimated from
 * the manifest's real token counts, not from a call count.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * USD per million tokens, {input, output} — first-party list rates for each vendor.
 * The Helix route meters and prices the call itself and may not bill at these rates, so
 * every cost figure below is an ESTIMATE from real token counts, not an invoice.
 */
const PRICING = {
  "gpt-4.1": { in: 2.0, out: 8.0 },
  "gpt-4o": { in: 2.5, out: 10.0 },
  "claude-sonnet-5": { in: 2.0, out: 10.0 },
  "claude-opus-5": { in: 5.0, out: 25.0 },
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
};

const pct = (n, d) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

const rows = [];
for (const dir of process.argv.slice(2)) {
  const scorePath = `${dir.replace(/\/$/, "")}-score.json`;
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(scorePath)) {
    console.error(`compare.mjs: no score file at ${scorePath} — run score.mjs on ${dir} first`);
    continue;
  }
  const s = JSON.parse(readFileSync(scorePath, "utf8"));
  const m = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  const t = s.totals;

  const missDen = t.gtNonNull - t.missExcused + (t.hGtState - t.hMissExcused);
  const missNum = t.miss + t.hMiss;
  const price = m ? PRICING[m.model] : null;
  const cost = price
    ? (m.totals.promptTokens / 1e6) * price.in + (m.totals.completionTokens / 1e6) * price.out
    : null;
  const ok = m ? m.transcripts.filter((x) => x.status === "ok").length : s.coverage?.scored;

  rows.push({
    label: basename(dir),
    model: m?.model ?? s.model ?? "?",
    completed: `${ok}/${m ? m.transcripts.length : "?"}`,
    scored: `${s.coverage?.scored ?? "?"}/${s.coverage?.total ?? "?"}`,
    hall: pct(t.hallucinationHard, t.gtNull),
    hallRaw: `${t.hallucinationHard}/${t.gtNull}`,
    miss: pct(missNum, missDen),
    missRaw: `${missNum}/${missDen}`,
    acc: pct(t.correct, t.correct + t.wrong),
    enums: pct(t.enumCorrect, t.enumGtMember),
    span: pct(t.spanVerbatim, t.spanChecked),
    spanBad: `${t.spanFabricated}f/${t.spanNearMiss}n`,
    hPass: t.hHallucinatedPass,
    calls: m?.totals.calls ?? "?",
    failedCalls: m?.totals.failures ?? "?",
    inTok: m?.totals.promptTokens ?? "?",
    outTok: m?.totals.completionTokens ?? "?",
    wallMin: m ? (m.wallMs / 60000).toFixed(1) : "?",
    secPerTx: m ? (m.wallMs / 1000 / m.transcripts.length).toFixed(0) : "?",
    cost: cost === null ? "?" : `$${cost.toFixed(3)}`,
    maxSchema: m?.totals.maxSchemaChars ?? "?",
  });
}

const cols = [
  ["run", "label", 40],
  ["model", "model", 17],
  ["done", "completed", 6],
  ["hall", "hall", 7],
  ["(n)", "hallRaw", 8],
  ["miss", "miss", 7],
  ["(n)", "missRaw", 8],
  ["acc", "acc", 7],
  ["enum", "enums", 7],
  ["span", "span", 7],
  ["hPass", "hPass", 5],
  ["calls", "calls", 6],
  ["fail", "failedCalls", 5],
  ["in tok", "inTok", 8],
  ["out tok", "outTok", 8],
  ["s/tx", "secPerTx", 5],
  ["wall", "wallMin", 6],
  ["cost", "cost", 8],
];

const line = (cells) => cells.map(([v, w]) => String(v).padEnd(w)).join(" ");
console.log(line(cols.map(([h, , w]) => [h, w])));
console.log(line(cols.map(([, , w]) => ["-".repeat(Math.min(w, 20)), w])));
for (const r of rows) console.log(line(cols.map(([, k, w]) => [r[k], w])));
