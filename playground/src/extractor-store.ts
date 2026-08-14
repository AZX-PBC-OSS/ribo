import { FakeExtractor, toExtractStep, type ExtractStep } from "@azx/ribo-core";
import { openAiChat, perGroupExtractor, singleShotExtractor } from "@azx/ribo-extractor-openai";
import { normalizeFields, snuggExamples, snuggGroupInstructions, snuggProAdapter } from "@azx/ribo-adapter-snuggpro";

/**
 * @file The ONE extract step both relays share — constructed once, here.
 *
 * `QueuePanel` (the auto-sync relay over the stub transcriber) and
 * `TranscribePanel` (the on-device relay) drain the SAME outbox, so they must run
 * the SAME extraction. Two extractor calls would be two prompt assemblies, two
 * configs to drift apart, and — with a real key — two ways to bill. So the step
 * is built in this module and both panels import {@link extractStep}; neither
 * constructs an extractor of its own. Same discipline as `whisper-store.ts`'s one
 * shared transcriber.
 *
 * ## Fake default, real configurable (the approved pattern)
 *
 * With no `VITE_OPENAI_API_KEY` the step is a {@link FakeExtractor} seeded with a
 * real full-shape `SnuggFields` fixture (`snuggExamples[0].fields`) — the demo runs
 * with no secret and no network. Set the key and it becomes the
 * {@link perGroupExtractor} — one chat call per top-level field group, each with
 * its own instructions (R3 Task 5) — against an OpenAI-compatible endpoint. The
 * {@link singleShotExtractor} stays reachable as the alternative strategy and
 * Task 6's corpus baseline; pass `strategy: "single-shot"` to
 * {@link buildExtractorStep} to select it. Which one is live is published as
 * {@link extractorStatus} and surfaced in the UI, so a reviewer never mistakes
 * replayed fixture fields for a real extraction.
 *
 * ## ⚠ The live path is dev-only and needs a CORS-OK endpoint
 *
 * `VITE_OPENAI_API_KEY` is inlined into the browser bundle at build time, and a raw
 * browser→`api.openai.com` request is **CORS-blocked**. So the live path is a dev
 * convenience that expects a CORS-OK base URL — the Helix proxy in production, or a
 * local proxy — via `VITE_OPENAI_BASE_URL`. A raw browser→OpenAI call will not work,
 * and the UI says so wherever the live path is enabled (`ReviewPanel`).
 */

/**
 * Default base URL when a key is set but `VITE_OPENAI_BASE_URL` is not. This is the
 * canonical OpenAI base, and it is **CORS-blocked from a browser** — it is the value
 * the UI caveat warns must be overridden with a CORS-OK proxy. It is a documented
 * default, not a working one.
 */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Default model — the strict-JSON-Schema-capable model the spike measured against. */
const DEFAULT_MODEL = "gpt-4o-2024-08-06";

const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
const baseUrl = import.meta.env.VITE_OPENAI_BASE_URL ?? DEFAULT_BASE_URL;
const model = import.meta.env.VITE_OPENAI_MODEL ?? DEFAULT_MODEL;

/**
 * Which extraction strategy the live path runs.
 *
 * - `"per-group"` — one chat call per top-level field group (R3). The default; each
 *   call gets its own instructions via {@link snuggGroupInstructions} and a
 *   projected example, so the vendor field descriptions come back and every group
 *   fits under the platform route's schema-size cap.
 * - `"single-shot"` — one call carrying the whole schema. The alternative and
 *   Task 6's corpus baseline; kept reachable so the comparison is possible.
 */
export type ExtractorStrategy = "per-group" | "single-shot";

/** Which extractor the shared step is, for the UI to display honestly. */
export type ExtractorStatus =
  | { readonly mode: "fake" }
  | {
      readonly mode: "live";
      readonly strategy: ExtractorStrategy;
      readonly model: string;
      readonly baseUrl: string;
    };

/**
 * A real, full-shape `SnuggFields` object (the Delgado oil-boiler fixture) as the
 * fake's fixed output — zero setup, and it exercises every review-card branch
 * (stated values, addressed-but-null, and silent nulls). Guarded rather than
 * indexed blind: `snuggExamples` is a public export, and an empty one should fail
 * loudly here, not surface as an `undefined` fields object downstream.
 */
const sampleFields = snuggExamples[0]?.fields;
if (sampleFields === undefined) {
  throw new Error("snuggExamples is empty — no fixture fields for the FakeExtractor default");
}

/** Options for {@link buildExtractorStep}. */
export interface BuildExtractorOptions {
  /** The OpenAI-compatible API key. When absent, the step is a `FakeExtractor`. */
  readonly apiKey?: string;
  /** Base URL of the OpenAI-compatible endpoint (without `/chat/completions`). */
  readonly baseUrl: string;
  /** The model id passed through to the endpoint. */
  readonly model: string;
  /** Which strategy to run on the live path. Defaults to `"per-group"`. */
  readonly strategy?: ExtractorStrategy;
}

/**
 * Build the shared extract step and its status from the given options.
 *
 * Extracted from the module singleton so the wiring is testable: a test calls this
 * with a fake key and asserts the status identifies the per-group strategy,
 * without needing to stub `import.meta.env` or drive a real chat call. The module
 * singleton below calls this with the real env values — the singleton pattern
 * (both panels share ONE step) is preserved; only the construction is factored out.
 *
 * `openAiChat` and the extractors do no network work at construction time — they
 * pre-compute schemas and capture the transport — so calling this with a fake key
 * in a test is safe.
 */
export function buildExtractorStep({
  apiKey,
  baseUrl,
  model,
  strategy = "per-group",
}: BuildExtractorOptions): { extractStep: ExtractStep; status: ExtractorStatus } {
  if (!apiKey) {
    return {
      extractStep: toExtractStep(new FakeExtractor(sampleFields)),
      status: { mode: "fake" },
    };
  }

  const chat = openAiChat({ apiKey, baseUrl });
  const extractor =
    strategy === "per-group"
      ? perGroupExtractor({
          target: snuggProAdapter,
          chat,
          model,
          // The deterministic, model-free pass — the second half of the trust boundary.
          normalize: normalizeFields,
          // Per-group instructions: universal rules plus only this group's rules,
          // with an output section that asserts the single top-level key (R3 Task 4).
          groupInstructions: snuggGroupInstructions,
        })
      : singleShotExtractor({
          target: snuggProAdapter,
          chat,
          model,
          normalize: normalizeFields,
        });

  return {
    extractStep: toExtractStep(extractor),
    status: { mode: "live", strategy, model, baseUrl },
  };
}

// --- The module singleton ----------------------------------------------------
// Both panels import `extractStep` — ONE shared step, so the two relays drain the
// same outbox with the same extraction. See the file header for why this is a
// singleton and not two calls.

const built = buildExtractorStep({ apiKey, baseUrl, model });

/** The one extract step. Both relays pass this as `createRelay({ extract })`. */
export const extractStep: ExtractStep = built.extractStep;

/** Which extractor is live — read by the UI to label the active path. */
export const extractorStatus: ExtractorStatus = built.status;
