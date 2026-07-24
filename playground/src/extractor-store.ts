import { FakeExtractor, toExtractStep, type ExtractStep } from "@azx/ribo-core";
import { openAiChat, singleShotExtractor } from "@azx/ribo-extractor-openai";
import { normalizeFields, snuggExamples, snuggProAdapter } from "@azx/ribo-adapter-snuggpro";

/**
 * @file The ONE extract step both relays share — constructed once, here.
 *
 * `QueuePanel` (the auto-sync relay over the stub transcriber) and
 * `TranscribePanel` (the on-device relay) drain the SAME outbox, so they must run
 * the SAME extraction. Two `singleShotExtractor(...)` calls would be two prompt
 * assemblies, two configs to drift apart, and — with a real key — two ways to bill.
 * So the step is built in this module and both panels import {@link extractStep};
 * neither constructs an extractor of its own. Same discipline as
 * `whisper-store.ts`'s one shared transcriber.
 *
 * ## Fake default, real configurable (the approved pattern)
 *
 * With no `VITE_OPENAI_API_KEY` the step is a {@link FakeExtractor} seeded with a
 * real full-shape `SnuggFields` fixture (`snuggExamples[0].fields`) — the demo runs
 * with no secret and no network. Set the key and it becomes the built-default
 * {@link singleShotExtractor} against an OpenAI-compatible endpoint. Which one is
 * live is published as {@link extractorStatus} and surfaced in the UI, so a
 * reviewer never mistakes replayed fixture fields for a real extraction.
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

/** Which extractor the shared step is, for the UI to display honestly. */
export type ExtractorStatus =
  | { readonly mode: "fake" }
  | { readonly mode: "live"; readonly model: string; readonly baseUrl: string };

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

const extractor = apiKey
  ? singleShotExtractor({
      target: snuggProAdapter,
      chat: openAiChat({ apiKey, baseUrl }),
      model,
      // The deterministic, model-free pass — the second half of the trust boundary.
      normalize: normalizeFields,
    })
  : new FakeExtractor(sampleFields);

/** The one extract step. Both relays pass this as `createRelay({ extract })`. */
export const extractStep: ExtractStep = toExtractStep(extractor);

/** Which extractor is live — read by the UI to label the active path. */
export const extractorStatus: ExtractorStatus = apiKey
  ? { mode: "live", model, baseUrl }
  : { mode: "fake" };
