import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build, preview, type PreviewServer } from "vite";
import { chromium, type Browser, type Page } from "playwright";

/**
 * @file Phase 4 Task 4: extraction is visible end to end, on the default
 * `FakeExtractor` path — **no key, no network**.
 *
 * The whole point of the fake default is that the demo drains a real recording
 * all the way through the `extracting` step with nothing configured. So this test
 * records a clip, presses "sync now (stub transcriber)" — which runs the shared
 * extract step (`FakeExtractor` here) after a `FakeTranscriber` — and asserts the
 * item reaches `done` with structured fields showing in the review panel.
 *
 * ## Deliberately the fake path (plan DoD / Global Constraints)
 *
 * A gate that needs `VITE_OPENAI_API_KEY` or a reachable model is not a gate. This
 * asserts the shipped default: the "sample data (FakeExtractor)" banner, and the
 * replayed Delgado fields with their provenance — including that the grounding
 * check flags those fixture quotes as NOT in this (fake) recording's transcript,
 * which is the honest, correct result.
 *
 * Same harness as `transcribe-ui.e2e.test.ts` / `offline-boot.e2e.test.ts`: a
 * production build served through `vite preview`, driven by a real Chromium with a
 * synthetic microphone.
 */

const PLAYGROUND_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Long enough that the fake device flushes real bytes (see offline-boot). */
const CAPTURE_MS = 1_200;

let server: PreviewServer;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  // Force production (Vitest sets NODE_ENV=test, which would build a dev bundle).
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

  browser = await chromium.launch({
    headless: true,
    // A synthetic mic on a machine with none, and auto-granted permission — the
    // pair every capture test uses. Drop either and `getUserMedia` never settles.
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

test("a recording drains through extraction and its fields show with provenance", async () => {
  const page: Page = await (await browser.newContext()).newPage();
  await page.goto(baseUrl);

  // The review panel and its honest active-extractor banner render. No key was
  // built in, so it must be the sample-data (FakeExtractor) path.
  await page
    .getByRole("heading", { name: "Review extracted fields" })
    .waitFor({ state: "visible" });
  const banner = page.getByTestId("extractor-status");
  await banner.waitFor({ state: "visible" });
  expect(await banner.innerText()).toMatch(/sample data \(FakeExtractor\)/);

  // Nothing extracted yet.
  await page.getByTestId("review-empty").waitFor({ state: "visible" });

  // ---- capture one recording ---------------------------------------------
  await page.getByRole("button", { name: /Start recording/ }).click();
  await expect.poll(() => page.getByText("phase: recording").isVisible()).toBe(true);
  await page.waitForTimeout(CAPTURE_MS);
  await page.getByRole("button", { name: /Stop and queue/ }).click();
  await page.locator('[data-testid="queue-item"]').first().waitFor({ timeout: 15_000 });

  // ---- drain: FakeTranscriber → shared extract step → stub write ----------
  await page.getByRole("button", { name: /sync now/ }).click();

  // The item reached the extracting step and a review card appeared.
  const card = page.locator('[data-testid="review-card"]').first();
  await card.waitFor({ timeout: 30_000 });

  // The item drained all the way to `done` (extraction did not strand it).
  await expect
    .poll(() => card.locator("text=done").first().isVisible(), { timeout: 15_000 })
    .toBe(true);

  // A real stated field from the fixture shows, with its value and a quote.
  const cardText = await card.innerText();
  expect(cardText).toMatch(/Heating equipment type/i);
  expect(cardText).toMatch(/boiler/);

  // Provenance grounding ran: the fixture's quotes are NOT in this fake
  // recording's transcript, so they are flagged — the check works, honestly.
  expect(cardText).toMatch(/not in this transcript/);

  // The null-heavy reality is collapsed, not rendered as findings.
  await card
    .getByText(/not stated in this recording/)
    .first()
    .waitFor({ state: "visible" });
}, 120_000);
