import {
  compositeExtractor,
  FakeExtractor,
  toExtractStep,
  type CompositeExtractor,
  type CompositeExtractorEntry,
  type Connectivity,
  type ExtractStep,
} from "@azx/ribo-core";
import {
  OnDeviceChat,
  threePhaseExtractor,
  type LanguageModel,
} from "@azx/ribo-extractor-ondevice";
import {
  openAiChat,
  perGroupExtractor,
  singleShotExtractor,
  type CapableChatClient,
  type ChatClient,
} from "@azx/ribo-extractor-openai";
import {
  normalizeFields,
  snuggExamples,
  snuggGroupInstructions,
  snuggProAdapter,
  type SnuggExtraction,
} from "@azx/ribo-adapter-snuggpro";

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
 * with no secret and no network. Set the key and the live path becomes a
 * {@link compositeExtractor}: a managed per-group delegate over an
 * OpenAI-compatible endpoint first, and an on-device per-group delegate over
 * Chrome's Prompt API second. The two delegates are configured with different
 * concurrency/ceiling/retry timing because a two-minute managed call and a
 * ~5-second on-device call cannot share a budget. The {@link singleShotExtractor}
 * stays reachable as the alternative strategy and Task 6's corpus baseline; pass
 * `strategy: "single-shot"` to {@link buildExtractorStep} to select it. Which one
 * is live is published as {@link extractorStatus} and surfaced in the UI, so a
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

/** The seven-group Snugg Pro extraction shape the two delegates share. */
type ExtractedShape = SnuggExtraction;

/**
 * Timing for the **managed** per-group delegate. Only the managed path uses
 * `perGroupExtractor` now: the on-device path runs {@link threePhaseExtractor},
 * which asks smaller questions and never needed a retry budget at all
 * (`docs/implementation/19-ondevice-extraction-strategies.md`).
 */
export interface PerGroupTiming {
  readonly concurrency: number;
  readonly maxRetries: number;
  readonly perCallCeilingMs: number;
  readonly stepTimeoutMs: number;
  /** Backoff base between retries. Omitted means the queue's default (1s). */
  readonly baseMs?: number;
  /** Backoff ceiling between retries. Omitted means the queue's default (5min). */
  readonly capMs?: number;
}

/** The managed delegate: four concurrent calls, two-minute ceiling, two retries. */
export const MANAGED_PER_GROUP_TIMING: PerGroupTiming = {
  concurrency: 4,
  maxRetries: 2,
  perCallCeilingMs: 120_000,
  stepTimeoutMs: 900_000,
};

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

/** Options for {@link buildExtractorStep} and {@link buildExtractorWiring}. */
export interface BuildExtractorOptions {
  /** The OpenAI-compatible API key. When absent, the step is a `FakeExtractor`. */
  readonly apiKey?: string;
  /** Base URL of the OpenAI-compatible endpoint (without `/chat/completions`). */
  readonly baseUrl: string;
  /** The model id passed through to the endpoint. */
  readonly model: string;
  /** Which strategy to run on the live path. Defaults to `"per-group"`. */
  readonly strategy?: ExtractorStrategy;
  /**
   * Override the managed chat transport (tests). May be a plain {@link ChatClient}
   * or a {@link CapableChatClient}. When omitted, the live path constructs
   * {@link openAiChat} from the key and base URL. The extractors do no network
   * work at construction time, so a test can inject a fake chat and run the
   * extractor end to end without a real endpoint.
   */
  readonly chat?: ChatClient | CapableChatClient;
  /**
   * Override the on-device language model (tests). When omitted, the live path
   * reads `globalThis.LanguageModel` if present; otherwise the on-device
   * delegate reports `unavailable`.
   */
  readonly onDeviceLanguageModel?: LanguageModel;
  /**
   * Optional connectivity source. When provided, the composite's capability
   * cache is invalidated on every transition so a stale managed `ready` is not
   * reused after the uplink drops. See `docs/superpowers/specs/2026-08-17-ondevice-
   * extraction-design.md` §3.4.
   */
  readonly connectivity?: Connectivity;
}

/** The two delegates and the composite that selects between them. */
export interface ExtractorWiring {
  readonly managed: CompositeExtractorEntry<ExtractedShape>;
  readonly onDevice: CompositeExtractorEntry<ExtractedShape>;
  readonly entries: readonly CompositeExtractorEntry<ExtractedShape>[];
  readonly composite: CompositeExtractor<ExtractedShape>;
}

/**
 * Build the two per-group delegates and the composite that selects between them.
 *
 * Managed is first, on-device second. The preference order is **inverted** relative
 * to the transcriber on purpose: transcription is device-first because on-device is
 * private and fast enough; extraction is managed-first because the on-device model
 * is a ~3B parameter model that is accepted only when the managed path cannot run
 * (offline). See `docs/superpowers/specs/2026-08-17-ondevice-extraction-design.md`
 * §3.4 for the rationale — without the comment, the order reads like a bug.
 *
 * `openAiChat` is a plain {@link ChatClient} with no `capability()`, so it cannot be
 * a composite entry as-is. The managed path is wrapped to report `ready` because the
 * playground's live path already uses an OpenAI-compatible endpoint and its env vars;
 * switching to `helixChat` would require a Helix token/base URL and break the existing
 * dev setup. The wrapper is a deliberate, conservative choice.
 */
export function buildExtractorWiring(options: BuildExtractorOptions): ExtractorWiring {
  const managedChat = buildManagedChat(options);
  const onDeviceChat = buildOnDeviceChat(options);

  const managed = perGroupExtractor({
    target: snuggProAdapter,
    chat: managedChat,
    model: options.model,
    normalize: normalizeFields,
    groupInstructions: snuggGroupInstructions,
    ...MANAGED_PER_GROUP_TIMING,
  });

  // The on-device delegate does NOT use `perGroupExtractor`. One constrained call per
  // group loses 4 of 14 transcripts to a degenerate whitespace loop that retries do not
  // fix; asking three smaller questions — is this discussed, quote it, classify the quote
  // — completed 14/14 with zero degenerations, cut hallucination 3.8% -> 1.3% and took
  // span fidelity to 100%. `docs/implementation/19-ondevice-extraction-strategies.md` has
  // the numbers and the strategies that lost.
  const onDevice = threePhaseExtractor({
    target: snuggProAdapter,
    chat: onDeviceChat,
  });

  const entries: readonly CompositeExtractorEntry<ExtractedShape>[] = [
    { source: managedChat, extractor: managed },
    { source: onDeviceChat, extractor: onDevice },
  ];

  const composite = compositeExtractor(entries);

  // The relay's connectivity watch only triggers drains; it invalidates nothing.
  // A stale managed `ready` can survive a full TTL after the uplink drops, so any
  // connectivity transition must drop the composite's capability cache.
  if (options.connectivity) {
    options.connectivity.subscribe(() => {
      composite.invalidate();
    });
  }

  return {
    managed: entries[0]!,
    onDevice: entries[1]!,
    entries,
    composite,
  };
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
  ...rest
}: BuildExtractorOptions): {
  readonly extractStep: ExtractStep;
  readonly status: ExtractorStatus;
  readonly composite: CompositeExtractor<ExtractedShape> | undefined;
} {
  if (!apiKey) {
    return {
      extractStep: toExtractStep(new FakeExtractor(sampleFields)),
      status: { mode: "fake" },
      composite: undefined,
    };
  }

  if (strategy === "single-shot") {
    const chat = buildManagedChat({ apiKey, baseUrl, model, ...rest });
    const extractor = singleShotExtractor({
      target: snuggProAdapter,
      chat,
      model,
      normalize: normalizeFields,
    });
    return {
      extractStep: toExtractStep(extractor),
      status: { mode: "live", strategy, model, baseUrl },
      composite: undefined,
    };
  }

  const { composite } = buildExtractorWiring({ apiKey, baseUrl, model, ...rest });
  return {
    extractStep: toExtractStep(composite),
    status: { mode: "live", strategy, model, baseUrl },
    composite,
  };
}

// --- Helpers -----------------------------------------------------------------

/** Build or wrap the managed chat as a {@link CapableChatClient}. */
function buildManagedChat(options: BuildExtractorOptions): CapableChatClient {
  if (options.chat) {
    return isCapableChatClient(options.chat)
      ? options.chat
      : asCapableChatClient(options.chat, "openai");
  }
  if (!options.apiKey) {
    throw new Error("buildManagedChat requires an apiKey when no chat override is provided");
  }
  return asCapableChatClient(
    openAiChat({ apiKey: options.apiKey, baseUrl: options.baseUrl }),
    "openai",
  );
}

/** Build the on-device chat, falling back to a stub when the API is absent. */
function buildOnDeviceChat(options: BuildExtractorOptions): CapableChatClient {
  return new OnDeviceChat({
    languageModel: getOnDeviceLanguageModel(options.onDeviceLanguageModel),
  });
}

/** Read the Chrome Prompt API global or fall back to an unavailable stub. */
function getOnDeviceLanguageModel(override?: LanguageModel): LanguageModel {
  return override ?? getGlobalLanguageModel() ?? unavailableLanguageModel();
}

/**
 * The Prompt API entry point is **`globalThis.LanguageModel`**, measured directly
 * (`packages/ribo-extractor-ondevice/src/prompt-api-availability.browser.test.ts`, Chrome 149
 * and 151).
 *
 * It is emphatically **not** `globalThis.ai.languageModel`. That was the earlier experimental
 * shape and reading it finds nothing today — which is a silent failure rather than a loud one:
 * the on-device entry would simply report `unavailable` forever, the composite would fall back
 * to managed every time, and the offline path this whole feature exists for would never once
 * engage. No error, no log, just a feature that is never used.
 */
function getGlobalLanguageModel(): LanguageModel | undefined {
  // Not in the DOM types yet, so read it defensively — a missing API must return `undefined`
  // rather than throwing on the lookup.
  return (globalThis as unknown as { LanguageModel?: LanguageModel }).LanguageModel;
}

function unavailableLanguageModel(): LanguageModel {
  return {
    availability: async () => "unavailable",
    create: async () => {
      throw new Error("On-device language model is not available on this platform");
    },
  };
}

function isCapableChatClient(chat: ChatClient): chat is CapableChatClient {
  const candidate = chat as Partial<CapableChatClient>;
  return typeof candidate.engine === "string" && typeof candidate.capability === "function";
}

function asCapableChatClient(chat: ChatClient, engine: string): CapableChatClient {
  return {
    engine,
    complete: (request, options) => chat.complete(request, options),
    capability: async () => ({ status: "ready" }),
  };
}

/**
 * Subscribe a composite extractor to connectivity transitions.
 *
 * The relay's connectivity watch only drains the queue; it does not invalidate
 * cached capability answers. Without this, a stale managed `ready` survives the
 * TTL after the uplink drops and the composite wastes one extraction attempt on
 * a dead path. Called from the panel that renders extraction state, once on
 * mount.
 */
export function wireExtractorConnectivity(
  composite: CompositeExtractor<ExtractedShape>,
  connectivity: Connectivity,
): void {
  connectivity.subscribe(() => {
    composite.invalidate();
  });
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

/** The composite behind the per-group live extractor, for connectivity invalidation. */
export const extractorComposite: CompositeExtractor<ExtractedShape> | undefined = built.composite;
