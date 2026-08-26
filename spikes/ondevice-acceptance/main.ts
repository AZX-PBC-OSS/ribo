/**
 * @file Drive the annotated corpus through the real on-device model.
 *
 * This is Task 15's runner. It exists as a page rather than a test because the model
 * only exists in real Chrome: Playwright's Chromium implements the Prompt API as a
 * stub that answers with canned text (spec §10.6), so an automated run would produce
 * a green suite that measured nothing.
 *
 * It uses the **production** wiring — `perGroupExtractor` over `OnDeviceChat` at the
 * on-device timing constants — rather than a simplified copy, so what gets scored is
 * what would actually ship. Results are posted back and written where `score.mjs`
 * reads them; the scorer itself is reused verbatim and is not touched.
 *
 * A second button runs a two-phase extract-then-classify strategy to test the
 * hypothesis that the whitespace loop is a property of the grammar, not the model.
 * A third button runs a three-phase presence-first strategy to test the hypothesis
 * that a boolean presence question is easier to answer truthfully than a nullable span.
 */

import {
  snuggProAdapter,
  snuggGroupInstructions,
  normalizeFields,
} from "@azx/ribo-adapter-snuggpro";
import { perGroupExtractor } from "@azx/ribo-extractor-openai";
import { OnDeviceChat } from "@azx/ribo-extractor-ondevice";

import { extractTwoPhase, formatStats, mergeStats, newStats } from "./two-phase.js";
import * as threePhase from "./three-phase.js";

const out = document.getElementById("out") as HTMLPreElement;
const goPerGroup = document.getElementById("go-per-group") as HTMLButtonElement;
const goTwoPhase = document.getElementById("go-two-phase") as HTMLButtonElement;
const goThreePhase = document.getElementById("go-three-phase") as HTMLButtonElement;
const goGrounded = document.getElementById("go-grounded") as HTMLButtonElement;

/**
 * The on-device delegate's production timing (mirrors `ONDEVICE_PER_GROUP_TIMING` in
 * `playground/src/extractor-store.ts`; restated rather than imported, because a spike
 * must not depend on the app — keep the two in step).
 *
 * `concurrency: 1` because there is one model on one device. The rest is the second
 * configuration: the first (15s ceiling, four retries, default backoff) lost **7 of
 * 14 extractions** on this very corpus, every one by exhausting its retries on a
 * whitespace loop. Near-zero backoff is the key change — the failure is a sampling
 * accident inside one generation, so waiting between attempts buys nothing and costs
 * the budget that buys attempts.
 */
const ONDEVICE_TIMING = {
  concurrency: 1,
  maxRetries: 9,
  perCallCeilingMs: 8_000,
  stepTimeoutMs: 900_000,
  baseMs: 50,
  capMs: 500,
} as const;

interface LanguageModelLike {
  availability(): Promise<string>;
  create(options?: unknown): Promise<{ prompt?(input: string): Promise<string>; destroy?(): void }>;
}

function languageModel(): LanguageModelLike | undefined {
  return (globalThis as { LanguageModel?: LanguageModelLike }).LanguageModel;
}

/**
 * Refuse to run against Chromium's stub.
 *
 * The stub is present, reports `downloadable`, honours the gesture rule and resolves
 * `create()` — everything short of running a model. Detecting it by *behaviour* is the
 * only reliable check: it answers a trivial prompt with a fixed sentence saying it is
 * not a real model. Without this the run would produce 13 result files of nonsense and
 * a scorecard that looks like data.
 */
async function assertRealModel(log: (line: string) => void): Promise<void> {
  const model = languageModel();
  if (!model) throw new Error("No LanguageModel global. Open this page in Chrome.");

  const availability = await model.availability();
  log(`availability(): ${availability}`);
  if (availability !== "available") {
    throw new Error(
      `Model is "${availability}", not "available". Arm it first — this page will not download it, ` +
        `because the download needs a gesture and takes minutes.`,
    );
  }

  const session = await model.create();
  try {
    const answer = (await session.prompt?.("Reply with the single word: ok")) ?? "";
    if (/not available in chromium|just a stub/i.test(answer)) {
      throw new Error(
        `This browser's Prompt API is a STUB (it answered ${JSON.stringify(answer.slice(0, 80))}). ` +
          `Open this page in real Chrome, not Chromium.`,
      );
    }
    log(`stub check passed — model answered ${JSON.stringify(answer.slice(0, 60))}`);
  } finally {
    session.destroy?.();
  }
}

function makeLog(dir: string): (line: string) => void {
  const lines: string[] = [];
  return (line: string): void => {
    lines.push(line);
    out.textContent = lines.join("\n");
    out.scrollTop = out.scrollHeight;
    void fetch(`/api/log?dir=${encodeURIComponent(dir)}`, {
      method: "POST",
      body: lines.join("\n"),
    }).catch(() => undefined);
  };
}

async function runPerGroup(log: (line: string) => void): Promise<void> {
  log("strategy: per-group (production)");
  await assertRealModel(log);

  const { slugs } = (await (await fetch("/api/corpus")).json()) as { slugs: string[] };
  log(`corpus: ${slugs.length} annotated transcripts`);

  const chat = new OnDeviceChat({ languageModel: languageModel() as never });
  const extractor = perGroupExtractor({
    target: snuggProAdapter,
    chat,
    model: "gemini-nano",
    normalize: normalizeFields,
    groupInstructions: snuggGroupInstructions,
    ...ONDEVICE_TIMING,
  } as never);

  let ok = 0;
  let failed = 0;
  const started = performance.now();

  for (const [index, slug] of slugs.entries()) {
    const transcript = await (await fetch(`/api/transcript?slug=${slug}`)).text();
    const t0 = performance.now();
    try {
      const result = await extractor.extract(transcript);
      const ms = Math.round(performance.now() - t0);
      await fetch(`/api/result?slug=${slug}&dir=ondevice`, {
        method: "POST",
        body: JSON.stringify(result.fields, null, 2),
      });
      ok += 1;
      log(`[${index + 1}/${slugs.length}] ${slug} — OK in ${(ms / 1000).toFixed(1)}s`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      log(`[${index + 1}/${slugs.length}] ${slug} — FAILED: ${message.slice(0, 160)}`);
    }
  }

  log(
    `\ndone: ${ok} extracted, ${failed} failed, ` +
      `${((performance.now() - started) / 1000 / 60).toFixed(1)} min total`,
  );
  log(
    `\nNow run: node spikes/extraction-snuggpro/score.mjs spikes/extraction-snuggpro/results/ondevice`,
  );
}

async function runTwoPhase(log: (line: string) => void): Promise<void> {
  log("strategy: two-phase extract-then-classify");
  log("hypothesis: the whitespace loop is a property of the grammar, not the model");
  await assertRealModel(log);

  const { slugs } = (await (await fetch("/api/corpus")).json()) as { slugs: string[] };
  log(`corpus: ${slugs.length} annotated transcripts`);

  const chat = new OnDeviceChat({ languageModel: languageModel() as never });
  const stats = newStats();

  let ok = 0;
  let failed = 0;
  const started = performance.now();

  for (const [index, slug] of slugs.entries()) {
    const transcript = await (await fetch(`/api/transcript?slug=${slug}`)).text();
    const t0 = performance.now();
    try {
      const { fields, stats: runStats } = await extractTwoPhase(transcript, chat, log);
      mergeStats(stats, runStats);
      const ms = Math.round(performance.now() - t0);
      await fetch(`/api/result?slug=${slug}&dir=ondevice-two-phase`, {
        method: "POST",
        body: JSON.stringify(fields, null, 2),
      });
      ok += 1;
      log(
        `[${index + 1}/${slugs.length}] ${slug} — OK in ${(ms / 1000).toFixed(1)}s (${formatStats(runStats)})`,
      );
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      log(`[${index + 1}/${slugs.length}] ${slug} — FAILED: ${message.slice(0, 160)}`);
    }
  }

  log(
    `\ndone: ${ok} extracted, ${failed} failed, ` +
      `${((performance.now() - started) / 1000 / 60).toFixed(1)} min total`,
  );
  log(formatStats(stats));
  log(
    "\nNote: wrapped phase-2 calls weaken the grammar hypothesis because they re-introduce a single-key object root." +
      " If phase-2 bare roots were rejected, the run log already noted each fallback.",
  );
  log(
    `\nNow run: node spikes/extraction-snuggpro/score.mjs spikes/extraction-snuggpro/results/ondevice-two-phase`,
  );
}

async function runThreePhase(
  log: (line: string) => void,
  groundSpans = false,
  dir = "ondevice-three-phase",
): Promise<void> {
  log(
    `strategy: three-phase presence-first extract-then-classify${groundSpans ? " + span grounding" : ""}`,
  );
  if (groundSpans) {
    log(
      "span grounding ON: a sourceSpan that is not a verbatim substring of the transcript drops both the span and the value it justifies. Deterministic, no model call — isSpanGrounded from @azx/ribo-core.",
    );
  }
  log(
    "hypothesis: a boolean presence question is easier to answer truthfully than a nullable span, so the model declines cleanly where it currently fabricates",
  );
  log(
    "critical diagnostic: the presence-true rate in the stats below. If it is near 100%, the model is saying true to everything and the gate added a phase for no benefit.",
  );
  await assertRealModel(log);

  const { slugs } = (await (await fetch("/api/corpus")).json()) as { slugs: string[] };
  log(`corpus: ${slugs.length} annotated transcripts`);

  const chat = new OnDeviceChat({ languageModel: languageModel() as never });
  const stats = threePhase.newStats();

  let ok = 0;
  let failed = 0;
  const started = performance.now();

  for (const [index, slug] of slugs.entries()) {
    const transcript = await (await fetch(`/api/transcript?slug=${slug}`)).text();
    const t0 = performance.now();
    try {
      const { fields, stats: runStats } = await threePhase.extractThreePhase(
        transcript,
        chat,
        log,
        undefined,
        groundSpans,
      );
      threePhase.mergeStats(stats, runStats);
      const ms = Math.round(performance.now() - t0);
      await fetch(`/api/result?slug=${slug}&dir=${dir}`, {
        method: "POST",
        body: JSON.stringify(fields, null, 2),
      });
      ok += 1;
      log(
        `[${index + 1}/${slugs.length}] ${slug} — OK in ${(ms / 1000).toFixed(1)}s (${threePhase.formatStats(runStats)})`,
      );
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      log(`[${index + 1}/${slugs.length}] ${slug} — FAILED: ${message.slice(0, 160)}`);
    }
  }

  log(
    `\ndone: ${ok} extracted, ${failed} failed, ${stats.phase0Attempts + stats.phase1Attempts + stats.phase2Attempts + stats.phase2WrappedAttempts} calls, ` +
      `${((performance.now() - started) / 1000 / 60).toFixed(1)} min total`,
  );
  log(threePhase.formatStats(stats));
  log(
    "\nNote: wrapped phase-2 calls weaken the grammar hypothesis because they re-introduce a single-key object root." +
      " If phase-2 bare roots were rejected, the run log already noted each fallback.",
  );
  log(
    `\nNow run: node spikes/extraction-snuggpro/score.mjs spikes/extraction-snuggpro/results/${dir}`,
  );
}

function enable(): void {
  goPerGroup.disabled = false;
  goTwoPhase.disabled = false;
  goThreePhase.disabled = false;
  goGrounded.disabled = false;
}

function disable(): void {
  goPerGroup.disabled = true;
  goTwoPhase.disabled = true;
  goThreePhase.disabled = true;
  goGrounded.disabled = true;
}

goPerGroup.addEventListener("click", () => {
  disable();
  const log = makeLog("ondevice");
  runPerGroup(log)
    .catch((error: unknown) => {
      log(`\nRUN ABORTED: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(enable);
});

goTwoPhase.addEventListener("click", () => {
  disable();
  const log = makeLog("ondevice-two-phase");
  runTwoPhase(log)
    .catch((error: unknown) => {
      log(`\nRUN ABORTED: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(enable);
});

goGrounded.addEventListener("click", () => {
  disable();
  const log = makeLog("ondevice-grounded");
  runThreePhase(log, true, "ondevice-grounded")
    .catch((error: unknown) => {
      log(`\nRUN ABORTED: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(enable);
});

goThreePhase.addEventListener("click", () => {
  disable();
  const log = makeLog("ondevice-three-phase");
  runThreePhase(log)
    .catch((error: unknown) => {
      log(`\nRUN ABORTED: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(enable);
});
