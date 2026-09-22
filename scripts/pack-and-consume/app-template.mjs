/**
 * @file The scratch app R3 builds and consumes — every file it needs, as plain strings, written
 * fresh into a temp directory by `run.mjs`.
 *
 * Deliberately plain JavaScript (no TypeScript): the property under test is packaging and
 * bundling, not typechecking, and a consumer of these packages is not required to use TypeScript
 * either. `whisper.worker.js` mirrors `playground/src/whisper.worker.ts` byte-for-byte in spirit
 * (AGENTS.md §5.2 / doc 10 §4): the published `@azx/ribo-transcriber-ondevice/worker` entry is
 * never constructed by library code, only by the consumer, in the consumer's own bundler context
 * — which this scratch app genuinely is, one level more genuine than the playground itself, since
 * it resolves through `dist/`, not the `@azx/source` condition.
 */

/** `package.json` for the scratch app. `tarballPaths` maps each `@azx/*` package name to the
 * absolute path of its freshly packed tarball — these become `file:` dependencies, which pnpm
 * installs as real tarball extractions (not symlinks), exactly like a consumer running
 * `npm install ./some-package-1.2.3.tgz` would get. */
export function scratchPackageJson(tarballPaths) {
  const fileSpec = (name) => `file:${tarballPaths[name]}`;
  return {
    name: "ribo-pack-and-consume-scratch-app",
    private: true,
    version: "0.0.0",
    type: "module",
    scripts: { build: "vite build" },
    dependencies: {
      "@azx/ribo-core": fileSpec("@azx/ribo-core"),
      "@azx/ribo-adapter-snuggpro": fileSpec("@azx/ribo-adapter-snuggpro"),
      "@azx/ribo-extractor-openai": fileSpec("@azx/ribo-extractor-openai"),
      "@azx/ribo-extractor-systemone": fileSpec("@azx/ribo-extractor-systemone"),
      "@azx/ribo-extractor-ondevice": fileSpec("@azx/ribo-extractor-ondevice"),
      "@azx/ribo-transcriber-ondevice": fileSpec("@azx/ribo-transcriber-ondevice"),
      "@azx/ribo-transcriber-managed": fileSpec("@azx/ribo-transcriber-managed"),
      "@azx/ribo-transcriber-managed-docs": fileSpec("@azx/ribo-transcriber-managed-docs"),
      "@azx/ribo-transcriber-pdfjs": fileSpec("@azx/ribo-transcriber-pdfjs"),
      "@azx/ribo-storage-rxdb": fileSpec("@azx/ribo-storage-rxdb"),
      "@azx/ribo-systemone-managed": fileSpec("@azx/ribo-systemone-managed"),
      "@azx/ribo-ui-react": fileSpec("@azx/ribo-ui-react"),
      // Exact versions, matching the workspace catalog (pnpm-workspace.yaml) — this app is NOT a
      // workspace member, so it cannot write `catalog:`; these are hand-pinned to the same values.
      react: "19.2.8",
      "react-dom": "19.2.8",
      zod: "4.4.3", // peer of @azx/ribo-ui-react; ribo-core also depends on it directly.
    },
    devDependencies: {
      vite: "8.1.5",
    },
    // None of these packages is published yet (doc 10 §10), so a nested reference — e.g.
    // ribo-adapter-snuggpro's own `"@azx/ribo-core": "^0.0.0"`, rewritten from `workspace:^` at
    // pack time — has nothing to resolve against on the real registry (ERR_PNPM_FETCH_404
    // without this). The override forces every nested occurrence of each of these names,
    // at any depth, to resolve to the SAME local tarball the root dependency above uses — which
    // is what keeps this a single coherent install (one @azx/ribo-core, not "whatever the
    // registry has"), the same property a real registry's own semver resolution would give for
    // free once these are actually published (doc 10 §5's canary snapshots).
    pnpm: {
      overrides: {
        "@azx/ribo-core": fileSpec("@azx/ribo-core"),
        "@azx/ribo-adapter-snuggpro": fileSpec("@azx/ribo-adapter-snuggpro"),
        "@azx/ribo-extractor-openai": fileSpec("@azx/ribo-extractor-openai"),
        "@azx/ribo-extractor-systemone": fileSpec("@azx/ribo-extractor-systemone"),
        "@azx/ribo-extractor-ondevice": fileSpec("@azx/ribo-extractor-ondevice"),
        "@azx/ribo-transcriber-ondevice": fileSpec("@azx/ribo-transcriber-ondevice"),
        "@azx/ribo-transcriber-managed": fileSpec("@azx/ribo-transcriber-managed"),
        "@azx/ribo-transcriber-managed-docs": fileSpec("@azx/ribo-transcriber-managed-docs"),
        "@azx/ribo-transcriber-pdfjs": fileSpec("@azx/ribo-transcriber-pdfjs"),
        "@azx/ribo-storage-rxdb": fileSpec("@azx/ribo-storage-rxdb"),
        "@azx/ribo-systemone-managed": fileSpec("@azx/ribo-systemone-managed"),
        "@azx/ribo-ui-react": fileSpec("@azx/ribo-ui-react"),
      },
    },
  };
}

export const INDEX_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>ribo-pack-and-consume</title></head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`;

/**
 * The consumer-owned worker entry (AGENTS.md §5.2). Library code never constructs a `Worker`
 * directly; the consumer builds one in their own module, importing the package's exported
 * `handleMessage` and wiring it to the message loop themselves. Identical in shape to
 * `playground/src/whisper.worker.ts`.
 */
export const WHISPER_WORKER_JS = `import { handleMessage } from "@azx/ribo-transcriber-ondevice/worker";

self.addEventListener("message", (event) => {
  void handleMessage(event.data, (message) => self.postMessage(message));
});
`;

/**
 * A tiny (~4 MB total, fp32/unquantized) HF Hub test fixture — the same kind of randomly-
 * initialized, real-shaped ONNX model transformers.js's own test suite downloads for CI. It is
 * Whisper-shaped (encoder + decoder, same graph topology as the real whisper-tiny.en/base.en this
 * package ships for production), so priming it exercises the exact code path production priming
 * does — worker spawn, dynamic `import("@huggingface/transformers")` inside the worker bundle, and
 * ONNX Runtime WASM session creation — without the real models' 175–970 MB fp32 download (fp32
 * because q4/q8 do not load on this pinned ORT build on wasm — see the package's own
 * `prime.manual.ts`).
 */
export const TEST_MODEL_ID = "Xenova/tiny-random-WhisperForConditionalGeneration";

/**
 * A specific commit on `TEST_MODEL_ID`'s repo, not the moving `main` branch tip. Two reasons, both
 * load-bearing:
 *
 * 1. **Determinism.** An upstream push to this HF Hub repo — a re-export, a README edit that still
 *    bumps `main`, an account takeover, anything — must not be able to change what this tier
 *    downloads and runs on the NEXT push to THIS repo, for a change unrelated to Ribo at all. That
 *    is the same property `pnpm-workspace.yaml`'s exact (no-caret) catalog pins buy for this
 *    workspace's npm dependencies, applied to a model repo instead.
 * 2. **The failure this guards against is structurally the "network fetch masquerading as a
 *    check" trap `vitest.manual.config.ts`'s header already rejects for a slower, heavier case**
 *    (a real Whisper model) — pinning a revision does not remove the network dependency, but it
 *    does remove the "the model repo changed" axis, leaving only "the Hub is unreachable" as a
 *    possible non-Ribo cause of a red run. Combined with CI-side caching of the fetched bytes,
 *    keyed on this exact value (see `.github/workflows/ci.yml`), the ordinary path does not hit
 *    the network at all — this pin only fires cold, and only ever fires the SAME cold fetch.
 *
 * Refresh by re-running the same lookup this constant was pinned from:
 *   `curl -s https://huggingface.co/api/models/${TEST_MODEL_ID}` → `.sha`
 */
export const TEST_MODEL_REVISION = "e1a9e01a339a6c8ba2aadb92a271624e46f86d05";

/**
 * The scratch app's entry point. Touches every published package from their real tarball
 * installs and records what happened onto \`globalThis.__RIBO_PACK_CONSUME_RESULT__\` — a plain,
 * JSON-serializable object Playwright reads back with \`page.evaluate\`.
 *
 * Split into two independently-caught phases so a failure's `category` tells a human reading a red
 * CI run which of three unrelated things broke, without opening this script:
 *
 *   - `"setup-before-worker"` — one of ribo-core / ribo-adapter-snuggpro / ribo-extractor-openai /
 *     ribo-extractor-systemone / ribo-extractor-ondevice / ribo-transcriber-managed /
 *     ribo-transcriber-managed-docs / ribo-transcriber-pdfjs / ribo-ui-react threw.
 *     None of this touches the network, so a Hub outage can never explain it —
 *     this is a real packaging regression in one of those packages.
 *   - `"worker-spawn-or-import"` — `prime()` threw and the worker never reported even an `initiate`
 *     progress event. A worker that never started can never have posted one, so this is very
 *     likely a real regression in `@azx/ribo-transcriber-ondevice`'s published `./worker` entry
 *     itself (a broken export map — see the header of `index.mjs` for the `MISSING_EXPORT` case
 *     this class of mutation was actually caught with — a dropped dependency, or a worker that
 *     cannot spawn in a real production bundle at all).
 *   - `"network-fetch-after-spawn"` — `prime()` threw, but the worker DID report at least one
 *     progress event first. The worker spawned, imported transformers.js, and started fetching —
 *     so the failure is most likely the pinned model fixture's fetch itself (an HF Hub outage or
 *     rate limit), not a packaging defect. Not a certainty — a heuristic — but the cheapest real
 *     signal available.
 */
export const MAIN_JS = `import { isSpanGrounded, TerminalError } from "@azx/ribo-core";
import {
  normalizeFields,
  snuggExtractionSchema,
  snuggProAdapter,
} from "@azx/ribo-adapter-snuggpro";
import { openAiChat, singleShotExtractor } from "@azx/ribo-extractor-openai";
import { enumMembersAt } from "@azx/ribo-extractor-systemone";
import { OnDeviceChat, threePhaseExtractor, ONDEVICE_CHAT_ENGINE } from "@azx/ribo-extractor-ondevice";
import { OnDeviceTranscriber } from "@azx/ribo-transcriber-ondevice";
import { ManagedTranscriber } from "@azx/ribo-transcriber-managed";
import { ManagedDocsTranscriber, MANAGED_DOCS_ENGINE } from "@azx/ribo-transcriber-managed-docs";
import { PdfjsTranscriber, PDFJS_ENGINE } from "@azx/ribo-transcriber-pdfjs";
import { openRxdbBackend, createRxdbBackend } from "@azx/ribo-storage-rxdb";
import { systemOneClient, SystemOneError, noul } from "@azx/ribo-systemone-managed";
import { RiboProvider } from "@azx/ribo-ui-react";
import React from "react";
import { createRoot } from "react-dom/client";

const TEST_MODEL_ID = "${TEST_MODEL_ID}";
const TEST_MODEL_REVISION = "${TEST_MODEL_REVISION}";

function errorMessage(error) {
  return error instanceof Error ? \`\${error.message}\\n\${error.stack ?? ""}\` : String(error);
}

function report(ok, extra) {
  globalThis.__RIBO_PACK_CONSUME_RESULT__ = { ok, ...extra };
}

async function run() {
  const checks = {};

  // ---- setup: ribo-core, ribo-adapter-snuggpro, ribo-extractor-openai, ribo-ui-react ------------
  try {
    // ribo-core: a real zod-backed call, not just a bundled-and-unused import.
    checks.riboCoreGroundedSpanTrue = isSpanGrounded("R-49", "The attic insulation is R-49 today.");
    checks.riboCoreGroundedSpanFalse = isSpanGrounded("R-99", "The attic insulation is R-49 today.");

    // ribo-adapter-snuggpro: the schema resolved and has real shape.
    checks.adapterSchemaKeyCount = Object.keys(snuggProAdapter.schema.shape).length;

    // ribo-extractor-openai composed with the adapter across a tarball boundary. Constructed only,
    // never called: openAiChat needs a baseUrl to build its request URL eagerly (not lazily inside
    // complete()), but nothing here ever calls .extract(), so no network happens.
    const extractor = singleShotExtractor({
      target: snuggProAdapter,
      chat: openAiChat({ apiKey: "unused-not-called", baseUrl: "https://api.openai.com/v1" }),
      model: "gpt-4o-2024-08-06",
      normalize: normalizeFields,
    });
    checks.extractorHasExtractFn = typeof extractor.extract === "function";

    // ribo-extractor-systemone: the schema walk answers a KNOWN enum leaf of a REAL derived
    // extraction schema, across the tarball boundary — members in declaration order. hvac is a
    // COLLECTION group, so the index segment is required: it addresses a position in data, and
    // the walk steps into the array's element schema rather than indexing the schema itself.
    checks.systemOneExtractorEnumMembers =
      JSON.stringify(enumMembersAt(snuggExtractionSchema, ["hvac", 0, "hvacDuctLeakage"])) ===
      JSON.stringify([
        "30% - Very leaky",
        "15% - Somewhat leaky",
        "6% - Well sealed",
        "3% - Very tight",
        "Measured (CFM25)",
      ]);

    // ribo-extractor-ondevice: constructed across the tarball boundary, no model touched.
    // \`capability()\` reads globalThis.LanguageModel and never downloads, so this is safe in a
    // headless build; the point is that the package RESOLVES and its zod dependency came along.
    // threePhaseExtractor calls z.toJSONSchema() on the target at construction time, so a
    // dropped \`zod\` dependency or a broken exports path fails right here rather than in a
    // consumer's app months later — the exact defect class this tier exists for.
    const onDeviceChat = new OnDeviceChat({});
    checks.onDeviceEngineId = onDeviceChat.engine === ONDEVICE_CHAT_ENGINE;
    const onDeviceCapability = await onDeviceChat.capability();
    checks.onDeviceCapabilityShape = typeof onDeviceCapability.status === "string";
    const onDeviceExtractor = threePhaseExtractor({
      target: snuggProAdapter,
      chat: onDeviceChat,
    });
    checks.onDeviceExtractorHasExtractFn = typeof onDeviceExtractor.extract === "function";

    // ribo-transcriber-managed: real capability logic across the tarball boundary, and no
    // network — capability() never fetches. Both directions, because the interesting bug
    // would be an engine that claims \`ready\` with nothing configured, which would outrank
    // a working on-device engine in \`firstCapable\` and fail every drain.
    const unconfigured = await new ManagedTranscriber({}).capability();
    checks.managedUnconfigured = unconfigured.status === "unavailable" && unconfigured.reason === "not-configured";
    const configured = await new ManagedTranscriber({
      endpoint: "https://example.invalid/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
      fetchImpl: () => Promise.reject(new Error("never called")),
      isOnline: () => true,
    }).capability();
    checks.managedReady = configured.status === "ready";

    // ribo-transcriber-pdfjs: real capability logic across the tarball boundary, and no
    // pdf.js load — capability() checks only the environment. Both directions: unconfigured
    // yields not-configured (not permanent), configured yields ready.
    const pdfjsUnconfigured = await new PdfjsTranscriber({}).capability();
    checks.pdfjsUnconfigured = pdfjsUnconfigured.status === "unavailable" && pdfjsUnconfigured.reason === "not-configured";
    const pdfjsConfigured = await new PdfjsTranscriber({
      workerSrc: "/assets/pdf.worker.min.mjs",
    }).capability();
    checks.pdfjsReady = pdfjsConfigured.status === "ready";
    checks.pdfjsEngineId = PDFJS_ENGINE === "pdfjs";

    // ribo-systemone-managed: real request shaping and error classing across the tarball
    // boundary, with an injected fetch so nothing leaves the process. The instanceof is the
    // point — a duplicated ribo-core in the install would give this package its own
    // TerminalError class and the arbitration ladders would silently stop falling through.
    const soClient = systemOneClient({
      endpoint: "https://example.invalid/v1/systemone",
      fetch: async () =>
        new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.75 } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const soAnswers = await soClient.ask("some state", { q: noul("is it?") });
    // The answer is discriminated on \`type\`, the way the wire is — not a bare number.
    checks.systemOneAnswers = soAnswers.q.type === "noul" && soAnswers.q.noul === 0.75;
    checks.systemOneTerminalIdentity = new SystemOneError(401, "x") instanceof TerminalError;

    // ribo-transcriber-managed-docs: real capability logic across the tarball
    // boundary, and no network — capability() never fetches. Both directions:
    // unconfigured yields not-configured (not permanent), configured yields ready.
    const docsUnconfigured = await new ManagedDocsTranscriber({}).capability();
    checks.docsUnconfigured = docsUnconfigured.status === "unavailable" && docsUnconfigured.reason === "not-configured";
    const docsConfigured = await new ManagedDocsTranscriber({
      endpoint: "https://example.invalid/documentintelligence",
      fetchImpl: () => Promise.reject(new Error("never called")),
      isOnline: () => true,
    }).capability();
    checks.docsReady = docsConfigured.status === "ready";
    checks.docsEngineId = MANAGED_DOCS_ENGINE === "managed-docs";

    // ribo-ui-react: a REAL React render through RiboProvider, proving one React instance.
    const mountNode = document.getElementById("app");
    const root = createRoot(mountNode);
    await new Promise((resolve) => {
      root.render(
        React.createElement(
          RiboProvider,
          { value: {} },
          React.createElement("div", { id: "provider-rendered" }, "ok"),
        ),
      );
      // Flush after paint so the check below sees the committed DOM.
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    checks.uiReactRendered = document.getElementById("provider-rendered")?.textContent === "ok";
    root.unmount();
  } catch (error) {
    report(false, { stage: "setup", category: "setup-before-worker", message: errorMessage(error) });
    return;
  }

  // ---- ribo-transcriber-ondevice: the one this tier exists for -----------------------------------
  // Worker spawns from the PUBLISHED "./worker" entry (the consumer's own bundler context, per
  // AGENTS.md §5.2) and primes a tiny real, REVISION-PINNED ONNX model — proving the worker
  // actually starts AND the ONNX Runtime WASM backend actually initializes a session, in a real
  // production bundle.
  const progressStages = [];
  const transcriber = new OnDeviceTranscriber({
    modelId: TEST_MODEL_ID,
    revision: TEST_MODEL_REVISION,
    device: "wasm",
    dtype: "fp32",
    wasmPaths: "/ort/",
    createWorker: () => new Worker(new URL("./whisper.worker.js", import.meta.url), { type: "module" }),
  });
  try {
    await transcriber.prime((progress) => progressStages.push(progress.stage));
  } catch (error) {
    transcriber.dispose();
    report(false, {
      stage: "prime",
      category: progressStages.length > 0 ? "network-fetch-after-spawn" : "worker-spawn-or-import",
      progressStagesSeen: progressStages,
      message: errorMessage(error),
    });
    return;
  }
  transcriber.dispose();
  // ribo-storage-rxdb: the tarball resolves, bundles and imports, and both entry
  // points survive the boundary. Deliberately NOT opening a database here --
  // proving the backend behaves is the conformance kit's job, in a browser test
  // that can await it; this tier's question is whether the package is consumable.
  checks.storageRxdbExports =
    typeof openRxdbBackend === "function" && typeof createRxdbBackend === "function";

  checks.workerPrimedWithoutThrowing = true;
  checks.workerReportedProgress = progressStages.length > 0;

  report(true, { checks });
}

run().catch((error) => {
  report(false, { stage: "unexpected", category: "unexpected", message: errorMessage(error) });
});
`;

/**
 * Copies the ONNX Runtime WASM/MJS runtime files into \`public/ort/\` before build, exactly the
 * pattern \`playground/vite.config.ts\`'s \`serveOrtRuntime\` uses — same-origin, never the
 * jsDelivr default (doc 10 §4). Written as a small standalone module (not a Vite plugin) because
 * this scratch app's \`vite.config.js\` is itself scratch content generated by \`run.mjs\`; the
 * actual copy happens from Node before \`vite build\` runs, which is simpler than teaching the
 * generated config file to find `onnxruntime-web` inside a directory it has no other reason to
 * know about.
 */
export const VITE_CONFIG_JS = `import { defineConfig } from "vite";

export default defineConfig({
  // No workspace resolution here — deliberately absent. This app resolves every "@azx/*" import
  // through its own node_modules (real tarball installs), exactly what a real consumer's default
  // Vite config does. Adding "@azx/source" here would defeat the entire point of this tier.
  worker: { format: "es" }, // the worker dynamically imports @huggingface/transformers -> code-split
});
`;
