import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type { ChatClient } from "@azx/ribo-extractor-openai";
import { openAiChat, singleShotExtractor } from "@azx/ribo-extractor-openai";
// The CLI-backed transport — a sibling developer test harness, not part of any published
// package (see its file header for the full contract and why it lives here rather than in
// `@azx/ribo-extractor-openai`: that package is browser-targeted and published, and a
// `node:child_process` import has no business anywhere in its graph).
import type { CliShapeResult } from "./cli-chat.js";
import { cliChat } from "./cli-chat.js";

import { normalizeFields, snuggProAdapter } from "../src/index.js";
// The spike's scorer, imported (read-only) so the gate grades exactly as the spike
// does — never edited, never re-run as a CLI. `main()` only runs on direct invoke.
import { aggregate, scoreTranscript } from "../../../spikes/extraction-snuggpro/score.mjs";
// The corpus's own format/vocabulary check — reused, not re-derived. `readGroundTruth`
// is `isNewFormat` + `validateGroundTruth` composed exactly the way the corpus's own
// tooling (validate-ground-truth.mjs) uses them.
import { readGroundTruth } from "../../../spikes/extraction-snuggpro/ground-truth.mjs";

/**
 * THE EXTRACTION-QUALITY ACCEPTANCE GATE (Phase 4 Task 3) — MANUAL, opt-in, NEVER in
 * `./check.sh`. It runs the built default extractor (`singleShotExtractor`) against
 * all corpus transcripts through a real backend, scores the output with the
 * spike's own `score.mjs`, and asserts:
 *
 *   - the corpus is in the format `score.mjs` expects and speaks the adapter's
 *     CURRENT 51-leaf vocabulary (see the first test below);
 *   - the FOUR HAZARDS hold: no silent fuel drop / fuel invention (1), no
 *     hallucinated health pass (2), no forbidden R-value->band conversion (3), no
 *     enum wrong-member/invalid mapping (4);
 *   - sourceSpans are 100% verbatim (no fabricated or missing spans);
 *   - the hard-hallucination and miss rates stay within the COMMITTED baseline
 *     for this SAME schema and this SAME backend (see "BASELINE FRESHNESS" below).
 *     `confidence` is deliberately NOT gated (the spike found a 0.9 hallucination —
 *     it is uncalibrated).
 *
 * ============================================================================
 * BACKEND SELECTION (`RIBO_ACCEPTANCE_BACKEND`, default `openai`).
 *
 *   - `openai` (default)  -> `openAiChat`, a real OpenAI-compatible endpoint with
 *     `response_format: { json_schema, strict: true }`. The endpoint itself REJECTS
 *     a non-conforming reply, so this path only ever measures CONTENT accuracy —
 *     shape is enforced server-side and can never fail here. Needs `OPENAI_API_KEY`.
 *   - `claude-cli` / `codex-cli` -> `cliChat` (`./cli-chat.ts`, a sibling of this file),
 *     which shells the `claude`/`codex` CLI already installed and authenticated on
 *     this machine — NO KEY NEEDED. A CLI has no strict mode: the schema goes into
 *     the PROMPT in words, and `cliChat` finds the JSON, validates it against that
 *     same schema, and retries (feeding the validation error back in) before giving
 *     up. That makes a CLI run measure TWO things at once — did it ever produce a
 *     conforming object, and separately, was the content right — so this gate
 *     reports shape conformance (first-try / retried / never) as its OWN section,
 *     distinct from the hazard/rate numbers below, which are content-accuracy-only.
 *
 * Whichever backend runs, `expect(scored).toBe(slugs.length)` below is the one
 * assertion both paths share unconditionally: on the CLI paths it is what makes a
 * "never conforming" transcript fail the build, exactly as a network error would.
 *
 * ============================================================================
 * BASELINE FRESHNESS. A hallucination/miss rate is only meaningful against a
 * baseline captured under the SAME schema AND THE SAME BACKEND — the adapter's
 * field set, enum vocabulary and prompt all shape what "normal" looks like for a
 * schema change (exactly the way a schema change invalidated the ground truth this
 * gate used to be blocked on — see git history: this file used to hard-fail with a
 * "BLOCKED" banner because the corpus was annotated against a dead field set;
 * `spikes/extraction-snuggpro/RECONCILIATION.md` records how it was rebuilt), and a
 * CLI's free-text-then-validate path is not the same measurement as an endpoint
 * that enforces shape up front, even against the identical schema. Conflating the
 * two the way this repo's now-retired `codex-score.json`/`opencode-score.json`
 * baselines conflated tool and schema is exactly what this guards against.
 *
 * Each backend gets its OWN baseline file — `baseline.json` for `openai` (unchanged
 * filename, for continuity with every run before this one), `baseline.claude-cli.json`
 * and `baseline.codex-cli.json` for the CLI backends — and every baseline ALSO
 * carries the backend identity as a field inside the JSON (`backend`), not merely
 * implied by its filename, so a future copy/rename mistake cannot silently make two
 * incomparable runs look comparable. Each baseline carries a fingerprint (sha256 of
 * the frozen JSON Schema at `../src/__fixtures__/snugg-fields-json-schema.json` —
 * exactly the artifact the schema-conformance contract is built from, whether
 * enforced by the endpoint or spelled out in a CLI prompt, so it changes iff what
 * the model is asked for changes) alongside the rates it recorded. Each run
 * recomputes the CURRENT fingerprint and compares it AND the backend identity to
 * its OWN baseline file:
 *   - MATCH  -> the baseline describes this exact schema and backend; assert the
 *     rate bands.
 *   - MISMATCH (or no baseline file yet) -> stale or nonexistent. Asserting against
 *     it would be meaningless (or impossible), so the gate instead REPORTS the
 *     numbers and WRITES a fresh baseline. The absolute, history-independent checks
 *     (coverage, the four hazards, span verbatim-ness) still run and can still fail
 *     the build either way — only the two rate-vs-history assertions are skipped.
 * ============================================================================
 *
 * Run (openai, needs a key):
 *   OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o-2024-08-06 \
 *   pnpm exec vitest run --config packages/ribo-adapter-snuggpro/vitest.acceptance.config.ts
 *
 * Run (a CLI backend, no key needed — `claude` or `codex` must be installed and
 * authenticated on this machine):
 *   RIBO_ACCEPTANCE_BACKEND=claude-cli \
 *   pnpm exec vitest run --config packages/ribo-adapter-snuggpro/vitest.acceptance.config.ts
 *
 * Env: RIBO_ACCEPTANCE_BACKEND (openai | claude-cli | codex-cli, default openai).
 * For `openai`: OPENAI_API_KEY (required — its ABSENCE, not the backend choice,
 * is what skips the suite), OPENAI_MODEL (default gpt-4o-2024-08-06), OPENAI_BASE_URL
 * (default https://api.openai.com/v1 — point at the Helix proxy in production). The
 * CLI backends need none of these three.
 */

type BackendId = "openai" | "claude-cli" | "codex-cli";

function resolveBackendId(raw: string | undefined): BackendId {
  const value = raw ?? "openai";
  if (value === "openai" || value === "claude-cli" || value === "codex-cli") return value;
  throw new Error(
    `RIBO_ACCEPTANCE_BACKEND="${value}" is not a known backend (openai | claude-cli | codex-cli).`,
  );
}

const backendId = resolveBackendId(process.env.RIBO_ACCEPTANCE_BACKEND);
const apiKey = process.env.OPENAI_API_KEY ?? "";
const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const openaiModel = process.env.OPENAI_MODEL ?? "gpt-4o-2024-08-06";

/** The label used for console banners, the results dir, and the baseline filename. For
 *  `openai` this is the model id (so different models keep separate baselines exactly as
 *  before this change); for a CLI backend it IS the backend id — the CLI reports no
 *  finer-grained model of its own. */
const backendLabel = backendId === "openai" ? openaiModel : backendId;

/** The identity recorded INSIDE every baseline (`Baseline.backend`) and checked for freshness
 *  alongside the schema fingerprint — see the "BASELINE FRESHNESS" note above. For `openai` this
 *  includes the model, since a different model under the same backend is not the same
 *  measurement either. */
const backendIdentity = backendId === "openai" ? `openai:${openaiModel}` : backendId;

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SPIKE = join(HERE, "..", "..", "..", "spikes", "extraction-snuggpro");
const GT_DIR = join(SPIKE, "ground-truth");
const TX_DIR = join(SPIKE, "transcripts");
const RESULTS_DIR = join(HERE, "results", backendLabel.replace(/[^\w.-]+/g, "_"));
const FIXTURE_SCHEMA_PATH = join(
  HERE,
  "..",
  "src",
  "__fixtures__",
  "snugg-fields-json-schema.json",
);
// One baseline FILE per backend (see "BASELINE FRESHNESS" above) — `openai`'s filename is
// unchanged so every run before this one still resolves.
const BASELINE_PATH = join(
  HERE,
  backendId === "openai" ? "baseline.json" : `baseline.${backendId}.json`,
);

/** Hash of the exact JSON Schema sent to the model — the fingerprint a baseline is captured
 * against. Reads the FROZEN fixture (`extraction-shape.test.ts` pins it), not a live derivation,
 * so this fingerprint changes iff that fixture is deliberately re-captured. */
function currentSchemaFingerprint(): string {
  const raw = readFileSync(FIXTURE_SCHEMA_PATH, "utf8");
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

interface Baseline {
  schemaFingerprint: string;
  /** The backend identity this baseline was captured against (`openai:<model>`, `claude-cli` or
   *  `codex-cli`) — checked ALONGSIDE `schemaFingerprint` for freshness. Carried inside the JSON,
   *  not just implied by the filename, so a future copy/rename mistake cannot silently make two
   *  incomparable runs (a strict-mode API number and a free-text CLI number) look comparable.
   *  See the "BASELINE FRESHNESS" note at the top of this file. */
  backend: string;
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

// Only the `openai` backend needs a key — a missing key is the ONLY reason this whole suite
// skips (never fails). The CLI backends need no key at all; if `claude`/`codex` is not actually
// installed, that surfaces as a real, reported failure (see `cliChat`'s `CliUnavailableError`),
// not a silent skip.
const skipSuite = backendId === "openai" && !apiKey;

describe.skipIf(skipSuite)("single-shot extraction — spike-corpus acceptance gate", () => {
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

  test(
    "four hazards hold, spans verbatim, hallucination/miss rates checked against a schema-matched baseline",
    async () => {
      // Populated only by `cliChat` (see its `onShapeResult`); stays empty for `openai`, whose
      // strict `json_schema` mode enforces conformance server-side — there is no retry loop to
      // report on. Read after the extraction loop below to build the shape-conformance section of
      // the console report, kept deliberately separate from the content-accuracy numbers.
      const shapeResults: CliShapeResult[] = [];
      const chat: ChatClient =
        backendId === "openai"
          ? openAiChat({ apiKey, baseUrl })
          : cliChat({
              backend: backendId === "claude-cli" ? "claude" : "codex",
              onShapeResult: (result) => shapeResults.push(result),
            });
      const extractor = singleShotExtractor({
        target: snuggProAdapter,
        chat,
        model: backendLabel,
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
      // Narrowed to non-null exactly when it is trustworthy — the schema AND THE BACKEND it was
      // captured against are the schema and backend this run just used (see "BASELINE FRESHNESS"
      // above — a CLI's free-text-then-validate path and a strict-mode API path are never the same
      // measurement, even against the identical schema). Keeping this as one nullable binding
      // (rather than separate boolean flags alongside the original `baseline`) lets TypeScript
      // prove every read below is guarded, instead of relying on flags staying in sync by convention.
      const freshBaseline =
        baseline !== null &&
        baseline.schemaFingerprint === fingerprint &&
        baseline.backend === backendIdentity
          ? baseline
          : null;

      // Shape conformance vs. content accuracy — a DIFFERENT axis, reported separately (see the
      // BACKEND SELECTION note at the top of this file). `openai` enforces conformance server-side,
      // so there is nothing to tally; the CLI backends tally every `complete()` call's verdict.
      const shapeConformance =
        backendId === "openai"
          ? null
          : {
              firstTry: shapeResults.filter((r) => r.conforming && r.attempts === 1).length,
              retried: shapeResults.filter((r) => r.conforming && r.attempts > 1).length,
              never: shapeResults.filter((r) => !r.conforming).length,
              // A CLI that could not even be started (missing binary) never reaches
              // `onShapeResult` at all — if that happened for any transcript, the three buckets
              // above will not add up to `slugs.length`; this surfaces that gap instead of
              // silently absorbing it into one of the three real verdicts.
              harnessFailures: slugs.length - shapeResults.length,
            };

      // Human-readable verdict — surfacing the numbers is the point of a manual run.
      const ok = (b: boolean) => (b ? "PASS" : "FAIL");
      console.log(
        `\n[acceptance] backend=${backendIdentity} base=${backendId === "openai" ? baseUrl : "n/a (CLI, local process)"}`,
      );
      console.log(
        `[acceptance] coverage: ${scored}/${slugs.length} transcripts produced parseable output` +
          (unscored.length
            ? ` — UNSCORED: ${unscored.map((r) => `${r.slug} (${r.problem})`).join("; ")}`
            : ""),
      );
      console.log(`[acceptance] wrote per-transcript results to ${RESULTS_DIR}`);
      console.log(
        "[acceptance] ---- shape conformance (content accuracy is a SEPARATE axis, below) ----",
      );
      if (shapeConformance === null) {
        console.log(
          "  n/a — the API enforces conformance server-side (response_format.json_schema, strict:" +
            " true); shape cannot fail on this backend.",
        );
      } else {
        console.log(
          `  first-try conforming: ${shapeConformance.firstTry}/${slugs.length}` +
            `   retried-then-conforming: ${shapeConformance.retried}/${slugs.length}` +
            `   never conforming: ${shapeConformance.never}/${slugs.length}` +
            (shapeConformance.harnessFailures > 0
              ? `   harness failures (CLI would not even run): ${shapeConformance.harnessFailures}/${slugs.length}`
              : ""),
        );
      }
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
      console.log(`[acceptance] ---- baseline (${BASELINE_PATH}) ----`);
      if (freshBaseline) {
        console.log(
          `  schema fingerprint AND backend match the committed baseline (captured ${freshBaseline.capturedAt}, ` +
            `backend ${freshBaseline.backend}) — asserting the rate bands below.`,
        );
        console.log(
          `  hallucination band <= ${(freshBaseline.hallRate * 100).toFixed(1)}% + 0.5pp; ` +
            `miss band <= ${(freshBaseline.missRate * 100).toFixed(1)}% + 5pp`,
        );
      } else {
        console.log(
          baseline === null
            ? `  no baseline file yet at this path — this run's numbers ARE the first baseline for this schema+backend.`
            : `  the committed baseline was captured against a DIFFERENT schema and/or backend ` +
                `(schemaFingerprint ${baseline.schemaFingerprint} vs current ${fingerprint}; ` +
                `backend ${baseline.backend} vs current ${backendIdentity}) — untrustworthy, not asserted against.`,
        );
        console.log("  reporting rates only; a fresh baseline is being written for this run.");
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
          backend: backendIdentity,
          capturedAt: new Date().toISOString(),
          model: backendLabel,
          hallRate,
          missRate,
          totals,
        };
        writeFileSync(BASELINE_PATH, `${JSON.stringify(newBaseline, null, 2)}\n`);
        console.log(`[acceptance] wrote new baseline to ${BASELINE_PATH} — commit it.`);
      }
      // 10 minutes is generous for 14 sequential keyed HTTP calls but tight for the CLI backends:
      // each `complete()` call may itself be up to 3 CLI invocations (the shape-conformance retry
      // loop), and an agentic CLI's cold-start + reasoning time dwarfs a single HTTP round trip.
    },
    backendId === "openai" ? 600_000 : 1_800_000,
  );
});
