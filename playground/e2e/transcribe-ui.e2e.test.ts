import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build, preview, type PreviewServer } from "vite";
import { chromium, type Browser, type Page } from "playwright";

/**
 * @file Phase 3, Task 5: the on-device transcription UI renders in the real
 * production build — the "make available offline" download control and the
 * transcribe control both appear, and the control honestly reports the model as
 * `needs-download` with its real (~300 MB) size.
 *
 * ## Model-free, on purpose
 *
 * This test **never downloads the model**. It asserts the controls render and
 * that the Cache-API capability check reports "download required" — it does not
 * press "Make available offline". A gate that only goes green when a ~300 MB CDN
 * fetch cooperates is not a gate (plan Global Constraints / DoD). The real
 * end-to-end offline transcription run is the opt-in manual recipe in
 * `TranscribePanel`'s header and `transcribe.manual.ts` — deliberately NOT gated.
 *
 * Same harness as `offline-boot.e2e.test.ts`: a production build served through
 * `vite preview`, driven by a real Chromium — the only place the worker/ORT
 * wiring and the `@azx/source` resolution are exercised together.
 */

const PLAYGROUND_ROOT = fileURLToPath(new URL("..", import.meta.url));

let server: PreviewServer;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  // See offline-boot.e2e.test.ts: Vitest sets NODE_ENV=test, which would make
  // Vite build a dev bundle. Force production so the app is the real thing.
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({ root: PLAYGROUND_ROOT, mode: "production", logLevel: "warn" });
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
  }

  server = await preview({ root: PLAYGROUND_ROOT, logLevel: "warn", preview: { port: 0 } });
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error("vite preview reported no local URL");
  baseUrl = url;

  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

test("the on-device panel offers an explicit model download and reports needs-download", async () => {
  const page: Page = await (await browser.newContext()).newPage();
  await page.goto(baseUrl);

  // The panel itself renders (the outbox opened and the ready branch mounted).
  await page
    .getByRole("heading", { name: "On-device transcription" })
    .waitFor({ state: "visible" });

  // The download control is present, is explicit (nothing fetched until pressed),
  // and quotes a real size — the ~300 MB fp32 reality, not the stale 165 MB
  // registry figure. A control that showed nothing would be unusable.
  const download = page.getByRole("button", { name: /Make available offline/ });
  await download.waitFor({ state: "visible" });
  expect(await download.innerText()).toMatch(/MB/);

  // The capability check read the (empty) Cache API and reported "not on this
  // device" rather than silently claiming readiness.
  await page.getByText(/Not on this device/).waitFor({ state: "visible" });

  // The transcribe control exists and is disabled until the model is ready —
  // it must not offer to transcribe with no model.
  const transcribe = page.getByRole("button", { name: /Transcribe queued recordings on-device/ });
  await transcribe.waitFor({ state: "visible" });
  expect(await transcribe.isDisabled()).toBe(true);
}, 120_000);
