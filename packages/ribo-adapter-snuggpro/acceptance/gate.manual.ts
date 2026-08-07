import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { openAiChat, singleShotExtractor } from "@azx/ribo-extractor-openai";

import { normalizeFields, snuggProAdapter } from "../src/index.js";
// The spike's scorer, imported (read-only) so the gate grades exactly as the spike
// does — never edited, never re-run as a CLI. `main()` only runs on direct invoke.
import { aggregate, scoreTranscript } from "../../../spikes/extraction-snuggpro/score.mjs";
// The corpus's own format/vocabulary check — reused, not re-derived. `readGroundTruth`
// is `isNewFormat` + `validateGroundTruth` composed exactly the way the corpus's own
// tooling (validate-ground-truth.mjs) uses them.
import { readGroundTruth } from "../../../spikes/extraction-snuggpro/ground-truth.mjs";

/**
 * THE EXTRACTION-QUALITY ACCEPTANCE GATE (Phase 4 Task 3) — MANUAL, opt-in, needs
 * a key, NEVER in `./check.sh`. It runs the built default extractor
 * (`singleShotExtractor` over `openAiChat`) against all corpus transcripts through a
 * real OpenAI-compatible endpoint, scores the output with the spike's own
 * `score.mjs`, and asserts:
 *
 *   - the corpus is in the format `score.mjs` expects and speaks the adapter's
 *     CURRENT 51-leaf vocabulary (see the first test below);
 *   - the FOUR HAZARDS hold: no silent fuel drop / fuel invention (1), no
 *     hallucinated health pass (2), no forbidden R-value->band conversion (3), no
 *     enum wrong-member/invalid mapping (4);
 *   - sourceSpans are 100% verbatim (no fabricated or missing spans);
 *   - the hard-hallucination and miss rates stay within the COMMITTED baseline
 *     (`baseline.json`, sibling of this file) — but ONLY when that baseline was
 *     captured against the SAME schema this run just sent to the model (see
 *     "BASELINE FRESHNESS" below). `confidence` is deliberately NOT gated (the
 *     spike found a 0.9 hallucination — it is uncalibrated).
 *
 * ============================================================================
 * BASELINE FRESHNESS. A hallucination/miss rate is only meaningful against a
 * baseline captured under the SAME schema — the adapter's field set, enum
 * vocabulary, and prompt all shape what "normal" looks like, and a schema change
 * invalidates the comparison exactly the way it invalidated the ground truth this
 * gate used to be blocked on (see git history: this file used to hard-fail with a
 * "BLOCKED" banner because the corpus was annotated against a dead field set —
 * `spikes/extraction-snuggpro/RECONCILIATION.md` records how it was rebuilt).
 *
 * `baseline.json` therefore carries a fingerprint (sha256 of the frozen JSON
 * Schema at `../src/__fixtures__/snugg-fields-json-schema.json` — exactly the
 * artifact sent to the model, so it changes iff what the model is asked for
 * changes) alongside the rates it recorded. Each run recomputes the CURRENT
 * fingerprint and compares:
 *   - MATCH  -> the baseline describes this exact schema; assert the rate bands.
 *   - MISMATCH (or no baseline file yet) -> the baseline is either stale or
 *     nonexistent. Asserting against it would be meaningless (or impossible), so
 *     the gate instead REPORTS the numbers and WRITES a fresh baseline for the
 *     current fingerprint. The absolute, history-independent checks (coverage,
 *     the four hazards, span verbatim-ness) still run and can still fail the
 *     build either way — only the two rate-vs-history assertions are skipped.
 * ============================================================================
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
const FIXTURE_SCHEMA_PATH = join(
  HERE,
  "..",
  "src",
  "__fixtures__",
  "snugg-fields-json-schema.json",
);
const BASELINE_PATH = join(HERE, "baseline.json");

/** Hash of the exact JSON Schema sent to the model — the fingerprint a baseline is captured
 * against. Reads the FROZEN fixture (`extraction-shape.test.ts` pins it), not a live derivation,
 * so this fingerprint changes iff that fixture is deliberately re-captured. */
function currentSchemaFingerprint(): string {
  const raw = readFileSync(FIXTURE_SCHEMA_PATH, "utf8");
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

interface Baseline {
  schemaFingerprint: string;
  capturedAt: string;
  model: string;
  hallRate: number;
  missRate: number;
  totals: Record<string, number>;
}

function loadBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  } catch {
    return null; // corrupt baseline is no baseline — treat exactly like "missing"
  }
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

describe.skipIf(!apiKey)("single-shot extraction — spike-corpus acceptance gate", () => {
  test("the ground truth is current: new format, valid against the adapter's 51-leaf vocabulary", async () => {
    // Runs FIRST and fails loudly. A vocabulary divergence between the adapter and the corpus
    // surfaces as "every hazard regressed", which reads as a model failure and is not one — this is
    // the guard that used to trip permanently (see the BASELINE FRESHNESS note above for the
    // history). It now checks what actually matters — the corpus's OWN format/vocabulary
    // validator, not a hand-rolled key-set comparison that only ever understood the old flat shape.
    const files = readdirSync(GT_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    expect(
      files.length,
      "the spike corpus has ground-truth files to grade against",
    ).toBeGreaterThan(0);
    for (const file of files) {
      const { isNew, ok, errors } = await readGroundTruth(join(GT_DIR, file), SPIKE);
      expect(
        isNew,
        `${file} is still in the OLD flat-field format (no \`leaves\` key) — the corpus rebuild ` +
          "has not reached it, and scoring it against the adapter's 51-leaf schema would report " +
          "every field as a miss. See spikes/extraction-snuggpro/ground-truth-format.md.",
      ).toBe(true);
      expect(
        ok,
        `${file} does not validate against the adapter's current vocabulary (schema-leaves.mjs): ` +
          errors.join("; "),
      ).toBe(true);
    }
  });

  test("four hazards hold, spans verbatim, hallucination/miss rates checked against a schema-matched baseline", async () => {
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
    const unscored = reports.filter((r) => r.status !== "scored");

    const fuelDropped = axisTally.fuelDropped ?? 0;
    const fuelInvented = axisTally.fuelInvented ?? 0;
    const hallRate = totals.hallucinationHard / totals.gtNull;
    const missRate = totals.miss / (totals.gtNonNull - totals.missExcused);
    const enumAccuracy = pct(totals.enumCorrect, totals.enumGtMember);

    const fingerprint = currentSchemaFingerprint();
    const baseline = loadBaseline();
    // Narrowed to non-null exactly when it is trustworthy — the schema it was captured against is
    // the schema this run just used. Keeping this as one nullable binding (rather than a separate
    // boolean flag alongside the original `baseline`) lets TypeScript prove every read below is
    // guarded, instead of relying on the flag and the value staying in sync by convention.
    const freshBaseline =
      baseline !== null && baseline.schemaFingerprint === fingerprint ? baseline : null;

    // Human-readable verdict — surfacing the numbers is the point of a manual run.
    const ok = (b: boolean) => (b ? "PASS" : "FAIL");
    console.log(`\n[acceptance] model=${model} base=${baseUrl}`);
    console.log(
      `[acceptance] coverage: ${scored}/${slugs.length} transcripts produced parseable output` +
        (unscored.length
          ? ` — UNSCORED: ${unscored.map((r) => `${r.slug} (${r.problem})`).join("; ")}`
          : ""),
    );
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
      `  4 enum map    : ${ok(totals.enumWrongMember === 0 && totals.enumInvalid === 0)}  (wrong-member ${totals.enumWrongMember}, invalid ${totals.enumInvalid})`,
    );
    console.log("[acceptance] ---- provenance + rates ----");
    console.log(
      `  spans verbatim: ${ok(totals.spanFabricated === 0 && totals.spanMissing === 0)}  (${pct(totals.spanVerbatim, totals.spanChecked)}; fabricated ${totals.spanFabricated}, missing ${totals.spanMissing})`,
    );
    console.log(
      `  hallucination : ${pct(totals.hallucinationHard, totals.gtNull)}  (${totals.hallucinationHard}/${totals.gtNull} GT-null slots)`,
    );
    console.log(
      `  miss (guard)  : ${pct(totals.miss, totals.gtNonNull - totals.missExcused)}  (an all-null output cannot pass)`,
    );
    console.log(
      `  enum accuracy : ${enumAccuracy}  (${totals.enumCorrect}/${totals.enumGtMember} member-correct, model-emitted enums only)`,
    );
    console.log(
      `  vocabulary mix on CORRECT enum matches: api-literal ${totals.vocabApi}  snake_case-slug ${totals.vocabSlug}` +
        "  <- does the model reliably emit the API's own wire strings?",
    );
    console.log("[acceptance] ---- baseline ----");
    if (freshBaseline) {
      console.log(
        `  schema fingerprint matches the committed baseline (captured ${freshBaseline.capturedAt}, ` +
          `model ${freshBaseline.model}) — asserting the rate bands below.`,
      );
      console.log(
        `  hallucination band <= ${(freshBaseline.hallRate * 100).toFixed(1)}% + 0.5pp; ` +
          `miss band <= ${(freshBaseline.missRate * 100).toFixed(1)}% + 5pp`,
      );
    } else {
      console.log(
        baseline === null
          ? "  no baseline.json yet — this run's numbers ARE the first baseline for this schema."
          : "  baseline.json was captured against a DIFFERENT schema fingerprint " +
              `(${baseline.schemaFingerprint} vs current ${fingerprint}) — untrustworthy, not asserted against.`,
      );
      console.log("  reporting rates only; a fresh baseline.json is being written for this run.");
    }

    // Every transcript must have produced a scoreable result (strict json_schema). This is the
    // single most important signal a manual run against a never-before-exercised schema can
    // produce: if the model cannot even emit parseable output, the schema is too large or too
    // strict in practice, independent of anything below.
    expect(scored, "all transcripts scored (no malformed/absent output)").toBe(slugs.length);

    // ---- Absolute, baseline-INDEPENDENT assertions: these do not depend on any prior run and
    // must fail the build on their own regression, schema-fresh baseline or not. ----
    expect(fuelDropped, "hazard 1: fuel dropped off its axis").toBe(0);
    expect(fuelInvented, "hazard 1: fuel invented on the silent-drop transcript").toBe(0);
    expect(totals.hHallucinatedPass, "hazard 2: hallucinated health pass").toBe(0);
    expect(totals.rvalueConversion, "hazard 3: forbidden R-value -> band conversion").toBe(0);
    expect(totals.enumWrongMember, "hazard 4: enum mapped to a wrong member").toBe(0);
    expect(totals.enumInvalid, "hazard 4: enum mapped to an invalid token").toBe(0);
    expect(totals.spanFabricated, "fabricated sourceSpan").toBe(0);
    expect(totals.spanMissing, "non-null value with no sourceSpan").toBe(0);

    // ---- History-dependent assertions: only meaningful when the baseline was captured against
    // THIS schema. Otherwise a fresh baseline is written below instead of asserted against. ----
    if (freshBaseline) {
      expect(
        hallRate,
        "hard hallucination rate within the committed, schema-matched baseline band",
      ).toBeLessThanOrEqual(freshBaseline.hallRate + 0.005);
      expect(
        missRate,
        "miss rate guard (an all-null output must not pass) within the committed baseline band",
      ).toBeLessThanOrEqual(freshBaseline.missRate + 0.05);
    } else {
      const newBaseline: Baseline = {
        schemaFingerprint: fingerprint,
        capturedAt: new Date().toISOString(),
        model,
        hallRate,
        missRate,
        totals,
      };
      writeFileSync(BASELINE_PATH, `${JSON.stringify(newBaseline, null, 2)}\n`);
      console.log(`[acceptance] wrote new baseline to ${BASELINE_PATH} — commit it.`);
    }
  }, 600_000);
});
