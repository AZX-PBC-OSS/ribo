import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Two projects, two module-resolution pipelines. See the long comments below —
// the `unit`/`browser` asymmetry is the single most confusing thing in this
// file, and it is deliberate rather than an oversight.
//
// Test-file naming is the discovery contract:
//   *.e2e.test.ts      → e2e project (Playwright driving `vite preview` over dist/)
//   *.browser.test.ts  → browser project (real Chromium via Playwright)
//   *.test.ts          → unit project (node)
// The `unit` project explicitly EXCLUDES `*.browser.test.ts`, which otherwise
// matches its include glob too. The `e2e` project is scoped to `playground/e2e`,
// which neither of the other two globs reaches.
export default defineConfig({
  test: {
    // `summary: false` is not about noise — it is what makes ./check.sh's `test`
    // stage prove BOTH projects ran. The default reporter's live summary is
    // suppressed in a non-TTY (CI, and any agent capturing output), leaving only
    // "Test Files 13 passed" with no hint that a browser ever launched. Turning
    // the summary off makes it print one `✓ |unit|` / `✓ |browser (chromium)|`
    // line per file instead, so a silently-skipped project is visible rather
    // than merely absent. Any project added later is covered automatically.
    reporters: [["default", { summary: false }]],
    projects: [
      {
        // Resolve workspace packages to TypeScript source, matching the
        // playground's Vite config. Tests then exercise `src/`, not a stale
        // `dist/`.
        //
        // This MUST be `ssr.resolve.conditions`, and it MUST live inside the
        // project. Two independent facts make every other spelling inert:
        //
        //   1. `environment: "node"` tests are loaded through Vite's SSR
        //      pipeline, which reads `ssr.resolve.conditions`. Plain
        //      `resolve.conditions` only feeds the client/web pipeline.
        //   2. Vitest 4 projects do not inherit the root `resolve`/`ssr`
        //      config, so a root-level entry never reaches this project.
        //
        // Verified empirically against Vitest 4.1.10: root `resolve`, project
        // `resolve`, both together, and root `ssr.resolve` all FAIL with
        // "Failed to resolve entry for package `@azx/ribo-core`"; only the form
        // below passes. The plain `resolve.conditions` entries that used to sit
        // here and at the root are deliberately NOT kept: they resolved nothing,
        // and config that looks load-bearing but is dead is exactly what hid
        // this bug for as long as it did. The `browser` project below runs
        // through the client pipeline and needs the *other* spelling — see
        // there.
        //
        // This block is gated by `pnpm check:resolve`
        // (scripts/assert-source-condition.mjs), which loads this file through
        // Vitest's own `createVitest` and asserts the "unit" project's resolved
        // `ssr.resolve.conditions` directly. That gate has been verified to FAIL
        // with this block deleted and to pass with it restored — a gate that has
        // never failed is not known to work.
        //
        // packages/ribo-adapter-snuggpro/src/workspace-resolution.test.ts imports
        // a workspace package by name too, but does NOT guard this block: every
        // publishable package's `exports` has a `default` fallback to `dist/`,
        // and `./check.sh` builds before it tests, so that import keeps
        // succeeding off `dist/` even with this block gone. R2 found that hole;
        // treat that test as a cross-package-import smoke check only.
        ssr: {
          resolve: {
            conditions: ["@azx/source"],
          },
        },
        test: {
          name: "unit",
          // Pure logic only: zod schemas, state machine, transcript post-processing,
          // and the playground's dev-only `/api/extract` backend resolution (a pure
          // function fed injected env/PATH — it never probes the real machine).
          // Nothing here touches the DOM yet, so `node` is the honest environment.
          environment: "node",
          include: [
            "packages/*/src/**/*.test.{ts,tsx}",
            // The playground is not a `packages/*` workspace, so its node-side
            // unit tests (e.g. vite-extract.test.ts) need their own glob. The
            // `playground/e2e/**` exclude below keeps the Playwright `*.e2e.test.ts`
            // files out of this node project.
            "playground/**/*.test.{ts,tsx}",
            // `ribo-adapter-snuggpro/acceptance/` is outside that package's `src/`, so the
            // first glob above does not reach it — deliberately: its sibling
            // `gate.manual.ts` is MANUAL (needs a backend, never runs here; see its own
            // file header and `vitest.acceptance.config.ts`). `cli-chat.test.ts` is
            // different: it is a key-free, hermetic unit test for a Node-only developer
            // test harness (fake `spawn`, no real CLI, no network — same shape as
            // `openai-chat.test.ts` in `@azx/ribo-extractor-openai`), and belongs in CI.
            // The naming convention (`*.test.ts` vs `*.manual.ts`) is what keeps the two
            // apart without needing a narrower, hand-maintained glob.
            "packages/ribo-adapter-snuggpro/acceptance/*.test.{ts,tsx}",
          ],
          // `*.browser.test.ts` and `*.e2e.test.ts` both end in `.test.ts`, so they
          // match the includes above. Without these excludes every browser test
          // would ALSO run under node — where MediaRecorder and IndexedDB do not
          // exist — and every e2e would try to build+preview under the unit project.
          // Vitest's own defaults are restated because setting `exclude` replaces
          // them wholesale.
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "packages/*/src/**/*.browser.test.{ts,tsx}",
            // The playground's own browser-mode tests (R2 Task 17's ReviewPanel
            // interaction tests) — same reasoning, same `playground/**/*.test.{ts,tsx}`
            // include above would otherwise also pick these up under `node`.
            "playground/src/**/*.browser.test.{ts,tsx}",
            "playground/e2e/**",
          ],
        },
      },
      {
        // The client-pipeline twin of the `unit` project's `ssr.resolve`.
        //
        // Browser-mode test files are served to a real Chromium through Vite's
        // CLIENT pipeline, which reads plain `resolve.conditions` and ignores
        // `ssr.resolve.conditions` entirely. So the two projects need opposite
        // spellings of the same idea, and each looks wrong from the other's
        // point of view. Copying `ssr.resolve` down here (or hoisting this block
        // up there) produces a config that reads as correct and resolves
        // nothing — precisely the failure mode that went unnoticed in Phase 0.
        //
        // This block is gated by `pnpm check:resolve`
        // (scripts/assert-source-condition.mjs), which loads this file through
        // Vitest's own `createVitest` and asserts the "browser" project's
        // resolved `resolve.conditions` directly. That gate has been verified to
        // FAIL with this block deleted and to pass with it restored — a gate
        // that has never failed is not known to work.
        //
        // packages/ribo-core/src/workspace-resolution.browser.test.ts (and its
        // ribo-ui-react counterpart) import a workspace package by name too, but
        // do NOT guard this block: every publishable package's `exports` has a
        // `default` fallback to `dist/`, and `./check.sh` builds before it
        // tests, so those imports keep succeeding off `dist/` even with this
        // block gone. R2 found that hole; treat those tests as cross-package-
        // import smoke checks only.
        resolve: {
          conditions: ["@azx/source"],
        },
        test: {
          name: "browser",
          // Anything touching MediaRecorder, IndexedDB, Workers or WASM belongs
          // here (docs/implementation/10-build-and-packaging.md §7). jsdom has
          // no MediaRecorder, a shimmed IndexedDB and does not faithfully
          // simulate workers; mocking through it produces tests that pass while
          // production is broken.
          //
          // The second entry is the playground's own component-interaction tests
          // (R2 Task 17's `ReviewPanel.browser.test.tsx` is the first) — a
          // DIFFERENT glob prefix from the first, deliberately: `packages/*/src`
          // is every publishable package, `playground/src` is the one app that
          // is not a `packages/*` workspace member and so is not reached by that
          // glob at all. Before this line existed, a `playground/src/*.browser
          // .test.tsx` file matched no project's `include` — not even the `unit`
          // project's `playground/**/*.test.{ts,tsx}` glob, which the exclude
          // just above this keeps off browser-suffixed files — so it would sit
          // in the tree looking like coverage while `vitest run` executed zero
          // of its assertions. That is a worse failure than an absent test: a
          // reviewer scanning file names sees a "ReviewPanel test" and stops
          // looking, unaware ./check.sh never ran it. `pnpm --filter playground
          // typecheck` still catches the file failing to *compile*, but nothing
          // caught it failing to *run* before this glob reached it.
          include: [
            "packages/*/src/**/*.browser.test.{ts,tsx}",
            "playground/src/**/*.browser.test.{ts,tsx}",
          ],
          // Deliberately generous. The FIRST `getUserMedia` call in a cold
          // Chromium takes seconds (measured: ~9.9s cold, ~74ms warm) while the
          // fake-device audio subsystem spins up. CI is cold every run, so the
          // node default would flake on the first capture test only — the worst
          // possible flake to diagnose.
          testTimeout: 30_000,
          browser: {
            enabled: true,
            headless: true,
            // Vitest 4 takes a provider *factory*, not the string "playwright"
            // — the string throws at startup. Launch options belong to the
            // provider, not to the instance.
            provider: playwright({
              launchOptions: {
                // These two Chromium flags look arbitrary. They are not.
                //
                //   --use-fake-device-for-media-stream
                //       Swaps real capture hardware for a synthetic source, so
                //       `getUserMedia({ audio: true })` resolves to a generated
                //       tone. CI runners have no microphone at all, so without
                //       this every Recorder test rejects with NotFoundError.
                //
                //   --use-fake-ui-for-media-stream
                //       Auto-grants the microphone permission prompt. Headless
                //       Chromium cannot render that prompt and no human is
                //       there to click it, so the getUserMedia promise would
                //       never settle and the test would hang until timeout.
                //
                // Both are required: the first supplies a device, the second
                // grants access to it. Drop either and Phase 2's capture tests
                // fail in CI while passing on a developer laptop that has a
                // real mic and a real human to click "Allow".
                args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
              },
            }),
            instances: [{ browser: "chromium" }],
          },
        },
      },
      {
        // Phase 2.5's offline-boot acceptance test.
        //
        // Deliberately NOT `browser` mode. Browser-mode files are served by a
        // *dev* server and run inside an iframe, and this test needs three
        // things dev mode cannot give it: a production `dist/`, the precache
        // manifest that only `vite build` produces, and a top-level
        // `page.reload()` that would otherwise reload the test runner itself.
        // So it runs in node and drives Playwright directly against
        // `vite preview`. No `resolve`/`ssr` conditions are needed here: the
        // test imports only `vite` and `playwright`, and the app it loads is
        // resolved by the playground's own Vite config during the build.
        test: {
          name: "e2e",
          environment: "node",
          include: ["playground/e2e/**/*.e2e.test.ts"],
          // Building the playground, launching Chromium, capturing real audio
          // and reloading offline. Measured well under this; the margin is for
          // a cold CI runner, where the first `getUserMedia` alone costs ~10s.
          testTimeout: 180_000,
          hookTimeout: 180_000,
          // One browser, one preview server, one dist. Parallel files would
          // race over `playground/dist`.
          fileParallelism: false,
        },
      },
    ],
  },
});
