import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

import { extractApiPlugin } from "./vite-extract.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Serve the ONNX Runtime `.wasm`/`.mjs` files **same-origin** at `/ort/`.
 *
 * `@azx/ribo-transcriber-ondevice` requires a `wasmPaths` pointing at a
 * same-origin directory — never the transformers.js jsDelivr default, which
 * breaks the offline guarantee this phase exists to make good and trips strict
 * host CSPs (see the package's `config.ts` and doc 01). transformers.js appends
 * the runtime filename to `wasmPaths`, so every `ort-wasm-simd-threaded*.{wasm,
 * mjs}` (the plain WASM build and the `.jsep` WebGPU build) must sit under it.
 *
 * The proven consumer pattern (the package's `vitest.manual.config.ts`) is to
 * copy `onnxruntime-web/dist/ort-wasm-simd-threaded*` into a static dir the app
 * serves. This plugin does that into `public/ort/` at `buildStart`, which fires
 * for both `vite` (served from `public/`) and `vite build` (`public/` copied
 * into `dist/`). `public/ort/` is a regenerable copy of a dependency and is
 * gitignored.
 */
function serveOrtRuntime(): Plugin {
  const pnpmDir = join(HERE, "..", "node_modules", ".pnpm");
  const ortEntry = readdirSync(pnpmDir).find((name) => name.startsWith("onnxruntime-web@"));
  if (!ortEntry) {
    throw new Error(
      "onnxruntime-web not found under node_modules/.pnpm — run `pnpm install` first.",
    );
  }
  const ortDist = join(pnpmDir, ortEntry, "node_modules", "onnxruntime-web", "dist");
  const runtimeFiles = readdirSync(ortDist).filter((name) =>
    /^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(name),
  );
  const dest = join(HERE, "public", "ort");

  return {
    name: "ribo-serve-ort-runtime",
    buildStart() {
      mkdirSync(dest, { recursive: true });
      for (const file of runtimeFiles) copyFileSync(join(ortDist, file), join(dest, file));
    },
  };
}

/**
 * Bytes above which a build output is deliberately left out of the precache.
 *
 * Phase 2.5 caches the *shell* — HTML, JS, CSS — and nothing else. The 40–150 MB
 * WASM Whisper model is Phase 3, is fetched into the Cache API from page context
 * (no service worker involved), and must never end up here: a precache is
 * all-or-nothing and blocks the service worker's `install` until every entry has
 * downloaded, so one large file turns "first load" into "first load on a good
 * connection, eventually". 2 MB is comfortably above the app shell today and far
 * below anything that would be a surprise.
 */
const PRECACHE_FILE_SIZE_LIMIT = 2 * 1024 * 1024;

export default defineConfig({
  plugins: [
    react(),
    serveOrtRuntime(),
    // DEV/PREVIEW ONLY. The `/api/extract` endpoint behind the dev-only "Try it"
    // extraction panel — runs inference server-side (keyless codex by default) so
    // no key ever reaches the browser. Not present in the built client bundle.
    extractApiPlugin(),
    VitePWA({
      // `generateSW`, not `injectManifest`: we have no service-worker logic of
      // our own beyond precaching, and hand-rolling the manifest gets the
      // content hashes wrong the first time a filename changes — which is every
      // build.
      strategies: "generateSW",

      // "prompt" is the whole of Task 2 in one word. It makes the generated
      // worker set `skipWaiting: false` / `clientsClaim: false` and wait for an
      // explicit SKIP_WAITING message, instead of Workbox's default
      // skipWaiting-and-reload. This app records audio; a self-initiated reload
      // mid-capture destroys a recording made in someone's attic that cannot be
      // recreated. See `src/update-store.ts` for the guard that decides when
      // that message is allowed to be sent.
      registerType: "prompt",

      // We register from `src/register-sw.ts` so registration is app code that
      // can be read, typed and reasoned about — not an opaque snippet injected
      // into index.html.
      injectRegister: false,

      // Service worker OFF in dev. Workbox plus HMR is the classic "why am I
      // seeing stale code" trap: a precached shell happily serves yesterday's
      // bundle over the dev server's fresh one. This is the default, restated
      // because it is load-bearing — and `UpdatePanel` renders a visible note in
      // dev saying the worker is not running, so "disabled" is never silent.
      devOptions: { enabled: false },

      // Task 3's Add-to-Home-Screen nudge is advice, and advice that does not
      // work is worse than none: without `display: standalone`, iOS's "Add to
      // Home Screen" produces a bookmark that opens in a Safari tab — same
      // storage, same seven-day eviction clock, no persistence grant. The
      // manifest is what makes the installed app a *web app*, which is the
      // whole mitigation. Icons are real files (`public/icon-*.png`), not
      // placeholders, so an installability checker finds what it is promised.
      manifest: {
        name: "ribo playground",
        short_name: "ribo",
        description: "Voice capture for field data collection. Works with no signal.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#1f883d",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          // `maskable` and `any` as separate entries rather than one
          // `purpose: "any maskable"`: a maskable icon is safe-zone-cropped, so
          // an icon declared as both is either padded wrong in the launcher or
          // shrunken wrong in the task switcher. This icon's glyph sits inside
          // the safe zone, so the same file can serve both roles honestly.
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },

      // iOS ignores manifest icons for the Home Screen and reads
      // `<link rel="apple-touch-icon">` from index.html instead — which is a
      // `public/` file the precache glob below would otherwise skip. Listed
      // here so the installed app has an icon offline as well.
      includeAssets: ["apple-touch-icon.png"],

      workbox: {
        // Generated from the real build output, hashes and all. `png` is here
        // for the manifest icons only; it is not an invitation to precache
        // media (see the size limit above, which still applies per file).
        globPatterns: ["**/*.{js,css,html,svg,png,woff,woff2}"],
        maximumFileSizeToCacheInBytes: PRECACHE_FILE_SIZE_LIMIT,
        // A cold offline start is a *navigation* to "/", which is not a
        // precached URL — it is `index.html` under a content hash. This is the
        // line that makes the offline boot work at all.
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
        // Restated rather than left to `registerType`, because these two are the
        // actual mechanism: a later edit to `registerType` must not be able to
        // silently re-arm the forced reload.
        skipWaiting: false,
        clientsClaim: false,
        runtimeCaching: [
          {
            // The ONNX Runtime loaders/binaries served same-origin at `/ort/`
            // are NOT precached: the glob excludes `.mjs`/`.wasm`, and eagerly
            // precaching all ~90 MB of ORT variants on install would violate
            // "nothing large in the precache". But without them cached, the
            // FIRST offline transcription dies at backend init —
            // `import("/ort/…asyncify.mjs")` has no network and throws
            // "no available backend found" (the exact failure we hit). CacheFirst
            // persists whichever single variant the browser actually loads
            // (~23 MB) on its first ONLINE fetch, so every later offline run —
            // including a cold offline reload — finds the runtime in cache.
            // Lazy, not eager: nothing is stored until the model is primed once
            // while online, which is the required step anyway.
            urlPattern: ({ url }) => url.pathname.startsWith("/ort/"),
            handler: "CacheFirst",
            options: {
              cacheName: "ort-runtime",
              expiration: { maxEntries: 8 },
              cacheableResponse: { statuses: [0, 200] },
              // The dev/preview server tags these responses `Vary: Origin`, and
              // the Cache API honors Vary when matching. A module `import()`
              // sends a different `Origin` request header than a plain `fetch()`,
              // so without this the cached entry matches an offline `fetch()`
              // but MISSES the offline `import()` ORT actually does at backend
              // init — which then hits the dead network and throws
              // "Failed to fetch dynamically imported module". Ignore Vary so the
              // one cached copy serves every request shape for the URL.
              matchOptions: { ignoreVary: true },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    // Resolve workspace packages to TS source: instant HMR, no build step.
    conditions: ["@azx/source"],
    // Prevent duplicate React across workspace-linked packages.
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
  ssr: {
    // The SSR twin of `resolve.conditions` above. The dev-only `/api/extract`
    // plugin (`vite-extract.ts`) loads the source-only `@azx/ribo-extractor-openai`
    // through the dev server's SSR module runner (`server.ssrLoadModule`), which
    // reads THIS condition list, not `resolve.conditions`. Without it the SSR
    // pipeline resolves the package to its missing `dist/` and the openai backend
    // fails to load. Mirrors the vitest `unit` project's `ssr.resolve.conditions`.
    resolve: {
      conditions: ["@azx/source"],
    },
  },
  // The on-device Whisper worker (`src/whisper.worker.ts`) dynamically imports
  // `@huggingface/transformers`, which forces the worker bundle to code-split.
  // A classic (iife) worker cannot carry dynamic imports, so it MUST be built as
  // an ES module worker — which also matches the `{ type: "module" }` the store
  // constructs it with.
  worker: { format: "es" },
  optimizeDeps: {
    // Pre-bundle transformers so a dev session does not re-optimize mid-run when
    // the worker first pulls it in (the same reason the package's manual Vitest
    // config includes it). Both the client and the worker resolve it.
    //
    // THIS is why `@huggingface/transformers` is a devDependency of `playground`
    // despite no source file here importing it. The specifier below is resolved
    // from the playground's own node_modules, not from
    // @azx/ribo-transcriber-ondevice's, and under pnpm's isolated layout the
    // playground cannot see its dependency's dependencies. Without the
    // declaration Vite logs "Failed to resolve dependency" and pre-bundling
    // silently no-ops — the app still runs, because module resolution falls back
    // to the importing package, so the only symptom is the mid-run re-optimize
    // this `include` exists to prevent. Exactly the `workbox-window` case; see
    // that entry in pnpm-workspace.yaml.
    //
    // The declaration carries no second copy: it is `catalog:`, so it resolves to
    // the same pin the transcriber uses. Two ONNX runtimes over one model cache
    // would be a real mismatch, not a duplication annoyance.
    include: ["@huggingface/transformers"],
  },
});
