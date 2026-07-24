import { fileURLToPath } from "node:url";
import process from "node:process";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build, preview, type PreviewServer } from "vite";
import { chromium, type Browser, type Page } from "playwright";

/**
 * @file Phase 4: the dev-only "Try it" extraction panel renders and runs against
 * a FAKE `/api/extract` backend — **no key, no network, no codex shell-out**.
 *
 * The whole point of this gate is that it exercises the panel + the real
 * `/api/extract` middleware end to end WITHOUT invoking a model. `RIBO_EXTRACT_FAKE`
 * is set before the preview server starts, so the middleware short-circuits to a
 * canned response (`playground/vite-extract.ts`) instead of shelling to `codex` or
 * hitting a network. CI never invokes codex and never leaves the machine.
 *
 * Same harness as `extraction-ui.e2e.test.ts`: a production build served through
 * `vite preview` (which is where the middleware's `configurePreviewServer` mount is
 * exercised), driven by a real Chromium.
 */

const PLAYGROUND_ROOT = fileURLToPath(new URL("..", import.meta.url));

let server: PreviewServer;
let browser: Browser;
let baseUrl: string;
let previousFake: string | undefined;

beforeAll(async () => {
  // The FAKE backend seam: canned `/api/extract` response, no codex, no network.
  previousFake = process.env.RIBO_EXTRACT_FAKE;
  process.env.RIBO_EXTRACT_FAKE = "1";

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
  // Do not leak the fake seam into other e2e files sharing this process.
  if (previousFake === undefined) delete process.env.RIBO_EXTRACT_FAKE;
  else process.env.RIBO_EXTRACT_FAKE = previousFake;
});

test("the panel renders its editors, examples and backend banner", async () => {
  const page: Page = await (await browser.newContext()).newPage();
  await page.goto(baseUrl);

  await page
    .getByRole("heading", { name: /Try it — extract into any schema/ })
    .waitFor({ state: "visible" });

  // Backend banner: the fake seam presents as the keyless codex default.
  const banner = page.getByTestId("try-it-backend");
  await banner.waitFor({ state: "visible" });
  await expect.poll(() => banner.innerText()).toMatch(/codex \(gpt-5\.6\), keyless/);
  expect(await banner.innerText()).toMatch(/Helix proxy/);

  // Both CodeMirror editors mounted, prefilled with the defaults.
  expect(await page.getByTestId("schema-editor").innerText()).toMatch(/heatingFuel/);
  expect(await page.getByTestId("text-editor").innerText()).toMatch(/Linden Street/);

  // Example buttons present.
  await page.getByRole("button", { name: "SnuggPro schema (larger)" }).waitFor();
  await page.getByRole("button", { name: "Attic R-value shell" }).waitFor();
  await page.getByRole("button", { name: "Full walkthrough" }).waitFor();
  await page.getByRole("button", { name: "Silent fuel drop" }).waitFor();
  await page.getByRole("button", { name: /Run extraction/ }).waitFor();
}, 60_000);

test("Run returns fields with provenance (fake backend, no model call)", async () => {
  const page: Page = await (await browser.newContext()).newPage();
  await page.goto(baseUrl);

  await page.getByRole("button", { name: /Run extraction/ }).click();

  const resultView = page.getByTestId("try-it-result");
  await resultView.waitFor({ timeout: 15_000 });

  const resultText = await resultView.innerText();
  // A stated field with its value and a grounded ✓ against the default text
  // (the fake's "gas furnace" span is verbatim in transcript 01).
  expect(resultText).toMatch(/Heating Fuel/);
  expect(resultText).toMatch(/natural_gas/);
  expect(resultText).toMatch(/✓ in the text/);
}, 60_000);
