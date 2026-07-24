import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { openAiChat, singleShotExtractor } from "@azx/ribo-extractor-openai";

import { normalizeFields, snuggProAdapter } from "../src/index.js";
// The spike's scorer, imported (read-only) so the gate grades exactly as the spike
// does — never edited, never re-run as a CLI. `main()` only runs on direct invoke.
import { aggregate, scoreTranscript } from "../../../spikes/extraction-snuggpro/score.mjs";

/**
 * THE EXTRACTION-QUALITY ACCEPTANCE GATE (Phase 4 Task 3) — MANUAL, opt-in, needs
 * a key, NEVER in `./check.sh`. It runs the built default extractor
 * (`singleShotExtractor` over `openAiChat`) against all 14 spike transcripts
 * through a real OpenAI-compatible endpoint, scores the output with the spike's own
 * `score.mjs`, and asserts:
 *
 *   - the FOUR HAZARDS hold: no silent fuel drop / fuel invention (1), no
 *     hallucinated health pass (2), no forbidden R-value->band conversion (3), no
 *     enum wrong-member/invalid mapping (4);
 *   - sourceSpans are 100% verbatim (no fabricated or missing spans);
 *   - the hard-hallucination rate stays within the COMMITTED baseline band
 *     (`results/{codex,opencode}-score.json`), read alongside a miss-rate guard so a
 *     degenerate all-null output cannot pass.
 *
 * `confidence` is deliberately NOT gated (the spike found a 0.9 hallucination — it
 * is uncalibrated). Watch it fail by mutating a hazard: e.g. make the model drop
 * `heatingFuel` and the fuel-drop assertion trips.
 *
 * Run:
 *   OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o-2024-08-06 \
 *   pnpm exec vitest run --config packages/ribo-adapter-snuggpro/vitest.acceptance.config.ts
 *
 * Env: OPENAI_API_KEY (required), OPENAI_MODEL (default gpt-4o-2024-08-06),
 * OPENAI_BASE_URL (default https://api.openai.com/v1 — point at the Helix proxy in
 * production). Without a key the whole suite SKIPS (never fails).
 */

const apiKey = process.env.OPENAI_API_KEY ?? "";
const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const model = process.env.OPENAI_MODEL ?? "gpt-4o-2024-08-06";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SPIKE = join(HERE, "..", "..", "..", "spikes", "extraction-snuggpro");
const GT_DIR = join(SPIKE, "ground-truth");
const TX_DIR = join(SPIKE, "transcripts");
const RESULTS_DIR = join(HERE, "results", model.replace(/[^\w.-]+/g, "_"));

/** Widest committed baseline for the two rates a degenerate output could game. */
function baselineBand(): { maxHallRate: number; maxMissRate: number } {
  let maxHallRate = 0;
  let maxMissRate = 0;
  for (const name of ["codex", "opencode"]) {
    const j = JSON.parse(readFileSync(join(SPIKE, "results", `${name}-score.json`), "utf8"));
    const t = j.totals;
    maxHallRate = Math.max(maxHallRate, t.hallucinationHard / t.gtNull);
    maxMissRate = Math.max(maxMissRate, t.miss / (t.gtNonNull - t.missExcused));
  }
  return { maxHallRate, maxMissRate };
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

describe.skipIf(!apiKey)("single-shot extraction — spike-corpus acceptance gate", () => {
  test("four hazards hold, spans verbatim, hallucination within the committed baseline band", async () => {
    const chat = openAiChat({ apiKey, baseUrl });
    const extractor = singleShotExtractor({
      target: snuggProAdapter,
      chat,
      model,
      normalize: normalizeFields,
    });
    mkdirSync(RESULTS_DIR, { recursive: true });

    const slugs = readdirSync(GT_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();

    const reports = [];
    for (const slug of slugs) {
      const gt = JSON.parse(readFileSync(join(GT_DIR, `${slug}.json`), "utf8"));
      const transcript = readFileSync(join(TX_DIR, `${slug}.txt`), "utf8");
      let fields: unknown = null;
      let problem: string | null = null;
      try {
        const result = await extractor.extract(transcript);
        fields = result.fields;
        writeFileSync(join(RESULTS_DIR, `${slug}.json`), `${JSON.stringify(fields, null, 2)}\n`);
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      reports.push(scoreTranscript(slug, gt, transcript, fields, problem));
    }

    const { totals, axisTally } = aggregate(reports);
    const scored = reports.filter((r) => r.status === "scored").length;
    const { maxHallRate, maxMissRate } = baselineBand();

    const fuelDropped = axisTally.fuelDropped ?? 0;
    const fuelInvented = axisTally.fuelInvented ?? 0;
    const hallRate = totals.hallucinationHard / totals.gtNull;
    const missRate = totals.miss / (totals.gtNonNull - totals.missExcused);

    // Human-readable verdict — surfacing the numbers is the point of a manual run.
    const ok = (b: boolean) => (b ? "PASS" : "FAIL");
    console.log(`\n[acceptance] model=${model} base=${baseUrl}`);
    console.log(`[acceptance] coverage: ${scored}/${slugs.length} transcripts scored`);
    console.log(`[acceptance] wrote per-transcript results to ${RESULTS_DIR}`);
    console.log("[acceptance] ---- four hazards ----");
    console.log(
      `  1 fuel axis   : ${ok(fuelDropped === 0 && fuelInvented === 0)}  (dropped ${fuelDropped}, invented ${fuelInvented})`,
    );
    console.log(
      `  2 health pass : ${ok(totals.hHallucinatedPass === 0)}  (hallucinated passes ${totals.hHallucinatedPass})`,
    );
    console.log(
      `  3 R->band     : ${ok(totals.rvalueConversion === 0)}  (forbidden conversions ${totals.rvalueConversion})`,
    );
    console.log(
      `  4 enum map    : ${ok(totals.enumWrongMember === 0 && totals.enumInvalid === 0)}  (wrong-member ${totals.enumWrongMember}, invalid ${totals.enumInvalid}, other-dump ${totals.enumOtherDump})`,
    );
    console.log("[acceptance] ---- provenance + rates ----");
    console.log(
      `  spans verbatim: ${ok(totals.spanFabricated === 0 && totals.spanMissing === 0)}  (${pct(totals.spanVerbatim, totals.spanChecked)}; fabricated ${totals.spanFabricated}, missing ${totals.spanMissing})`,
    );
    console.log(
      `  hallucination : ${pct(totals.hallucinationHard, totals.gtNull)}  (baseline band <= ${(maxHallRate * 100).toFixed(1)}% + 0.5pp)`,
    );
    console.log(
      `  miss (guard)  : ${pct(totals.miss, totals.gtNonNull - totals.missExcused)}  (<= ${(maxMissRate * 100).toFixed(1)}% + 5pp, so an all-null output cannot pass)`,
    );

    // Every transcript must have produced a scoreable result (strict json_schema).
    expect(scored, "all transcripts scored (no malformed/absent output)").toBe(slugs.length);

    // The four hazards — all committed baselines are 0; any regression trips here.
    expect(fuelDropped, "hazard 1: fuel dropped off its axis").toBe(0);
    expect(fuelInvented, "hazard 1: fuel invented on the silent-drop transcript").toBe(0);
    expect(totals.hHallucinatedPass, "hazard 2: hallucinated health pass").toBe(0);
    expect(totals.rvalueConversion, "hazard 3: forbidden R-value -> band conversion").toBe(0);
    expect(totals.enumWrongMember, "hazard 4: enum mapped to a wrong member").toBe(0);
    expect(totals.enumInvalid, "hazard 4: enum mapped to an invalid token").toBe(0);

    // Provenance: 100% verbatim spans.
    expect(totals.spanFabricated, "fabricated sourceSpan").toBe(0);
    expect(totals.spanMissing, "non-null value with no sourceSpan").toBe(0);

    // Hallucination within the committed band; miss-rate guard blocks the all-null bypass.
    expect(hallRate, "hard hallucination rate within committed baseline band").toBeLessThanOrEqual(
      maxHallRate + 0.005,
    );
    expect(missRate, "miss rate guard (an all-null output must not pass)").toBeLessThanOrEqual(
      maxMissRate + 0.05,
    );
  }, 600_000);
});
