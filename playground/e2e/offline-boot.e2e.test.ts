import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build, preview, type PreviewServer } from "vite";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/**
 * @file Phase 2.5's acceptance criterion: **the app boots with no network.**
 *
 * A registered service worker is not evidence of that, and neither is a green
 * unit test. The only thing that settles it is a real browser, a real production
 * build, a real capture, `setOffline(true)`, and a reload — which is what this
 * file does, in that order.
 *
 * ## Why it lives here and not in the `browser` Vitest project
 *
 * The `browser` project (`packages/*` + Playwright) serves test files through a
 * *dev* server and runs them inside an iframe. There is no service worker in
 * dev by design (see `playground/vite.config.ts`), the precache manifest is a
 * build artifact that does not exist there, and a test that reloads the top
 * frame would take the test runner with it. So this is its own `e2e` project,
 * driving Playwright directly against `vite preview` over the real `dist/`.
 *
 * ## It builds its own dist
 *
 * `./check.sh` runs `pnpm build` before `pnpm test`, so `dist/` usually already
 * exists — but a test that silently passes against a stale or absent build is
 * worse than a slow one. The build here takes about a second and makes
 * `pnpm test` self-contained.
 *
 * ## Proving it can fail
 *
 * Add `disable: true` to the `VitePWA({ … })` options in
 * `playground/vite.config.ts` and run `pnpm vitest run --project e2e`. The
 * reload after `setOffline(true)` then fails outright with
 * `net::ERR_INTERNET_DISCONNECTED`. Observed, not assumed — and `disable`
 * rather than deleting the plugin because the app imports
 * `virtual:pwa-register`, which the plugin still provides (as a no-op) when
 * disabled; removing it outright fails the build instead, which proves nothing.
 */

const PLAYGROUND_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * How long to hold the microphone open.
 *
 * Long enough that the fake device produces bytes `MediaRecorder` will actually
 * flush — a sub-100 ms capture can end up as a zero-byte blob, which would make
 * the audio assertion below fail for a reason that has nothing to do with
 * offline boot.
 */
const CAPTURE_MS = 1_200;

let server: PreviewServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let baseUrl: string;

beforeAll(async () => {
  // `NODE_ENV`, not `mode`. Vite derives `import.meta.env.DEV` from
  // `process.env.NODE_ENV` and only falls back to `mode` when it is unset —
  // and Vitest sets `NODE_ENV=test`. Without this line the programmatic build
  // emits a bundle with `import.meta.env.DEV === true`, so `update-store.ts`
  // takes its "disabled in dev" branch, no service worker is ever registered,
  // and the test fails for a reason that has nothing to do with the app. Vite's
  // own CLI does exactly this before `build()`; here it has to be explicit
  // because Vitest got there first.
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({ root: PLAYGROUND_ROOT, mode: "production", logLevel: "warn" });
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
  }

  // Port 0 lets the OS pick, so a developer's own `vite preview` on 4173 does
  // not turn this into a confusing failure.
  server = await preview({ root: PLAYGROUND_ROOT, logLevel: "warn", preview: { port: 0 } });
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error("vite preview reported no local URL");
  baseUrl = url;

  browser = await chromium.launch({
    headless: true,
    // The same pair the `browser` Vitest project uses, and for the same reasons:
    // the first supplies a synthetic microphone on a machine that has none, the
    // second auto-grants the permission prompt no headless browser can render.
    // Drop either and `getUserMedia` never settles.
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

test("boots with the network cut, and the queue still has playable audio", async () => {
  context = await browser.newContext();
  page = await context.newPage();

  await page.goto(baseUrl);

  // ---- online: capture one recording -------------------------------------

  await page.getByRole("button", { name: /Start recording/ }).click();
  await expect.poll(() => page.getByText("phase: recording").isVisible()).toBe(true);
  await page.waitForTimeout(CAPTURE_MS);
  await page.getByRole("button", { name: /Stop and queue/ }).click();

  const items = page.locator('[data-testid="queue-item"]');
  // NOT `items.first()` — durable capture inserts the row at `start()`, so it is
  // already on screen and that wait would return instantly, mid-recording. This
  // test then reloads, which would interrupt the capture, and startup recovery
  // would turn one dictation into two rows: the recovered successor and the dead
  // original. The `<audio>` element appears only once the canonical attachment is
  // committed, which is exactly when capture is done.
  await page.locator('[data-testid="queue-item"] audio').first().waitFor({ timeout: 15_000 });
  expect(await items.count()).toBe(1);
  const capturedId = await idOfFirstItem(page);

  // Don't race the install. The precache is written during `install`, and
  // `active` is only reached once `install` resolved, so this is the honest
  // "the shell is cached" signal.
  //
  // It deliberately does NOT throw when no worker appears. The assertion that
  // settles this phase is the reload below, and the error worth reading when
  // the service worker is missing is `ERR_INTERNET_DISCONNECTED` on that
  // reload — not a timeout on a precondition, which says only that a
  // precondition timed out. The strict check that a worker really served the
  // page is `navigator.serviceWorker.controller` *after* the reload; that one
  // does throw.
  await waitForActiveServiceWorker(page, 30_000);

  // ---- cut the network ---------------------------------------------------

  await context.setOffline(true);

  // Prove the cut is real before leaning on it. Without this, a
  // `setOffline` that quietly did nothing would produce a green test that
  // means nothing at all.
  await expect(
    page.evaluate(() => fetch("/definitely-not-precached.txt").then(() => "reached network")),
  ).rejects.toThrow();

  // ---- reload: this is the whole phase -----------------------------------

  await page.reload({ waitUntil: "load" });

  // Served from the precache, by the service worker, with no network at all.
  // `waitFor`, not `expect(...).toBeVisible()`: the web-first matchers ship
  // with `@playwright/test`, and this project drives the `playwright` library
  // under Vitest's `expect`. A locator wait is the same assertion without a
  // second test runner.
  await page.getByRole("heading", { name: "ribo playground" }).waitFor({ state: "visible" });
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller !== null),
    "the reloaded page should be controlled by the service worker",
  ).toBe(true);

  // The queue came back out of IndexedDB, with the item captured *before*
  // this page load — the app's own badge says so.
  const reloaded = page.locator('[data-testid="queue-item"]');
  await reloaded.first().waitFor({ timeout: 30_000 });
  expect(await reloaded.count()).toBe(1);
  expect(await idOfFirstItem(page)).toBe(capturedId);
  // Scoped to the row: the VerifyPanel's instructions quote the same badge
  // text, and an unscoped match would happily pass against the how-to list.
  await reloaded.first().getByText("survived reload ✓").waitFor({ state: "visible" });

  // Playable, not merely present: a row proves the document persisted, the
  // audio is a separately-stored attachment and only decoding settles it.
  const audio = await page.waitForFunction(
    () => {
      const element = document.querySelector<HTMLAudioElement>('[data-testid="queue-item"] audio');
      if (!element || element.readyState < 2 /* HAVE_CURRENT_DATA */) return null;
      return { readyState: element.readyState, src: element.src };
    },
    undefined,
    { timeout: 30_000 },
  );
  // `waitForFunction` types its handle as the predicate's return type including
  // the falsy branch, even though it only ever resolves on a truthy value.
  const loaded = await audio.jsonValue();
  expect(loaded).not.toBeNull();
  expect(loaded?.src.startsWith("blob:")).toBe(true);
  expect(loaded?.readyState).toBeGreaterThanOrEqual(2);
}, 180_000);

/**
 * Poll until a service worker is activated, or the deadline passes. Never throws.
 *
 * Hand-rolled rather than `page.waitForFunction(async () => …)`: an async
 * predicate returns a Promise, Playwright's polling sees a truthy object and
 * resolves on the very first tick. That version of this wait was written first,
 * looked correct, and waited for nothing — which is precisely the failure this
 * whole file exists to make impossible.
 */
async function waitForActiveServiceWorker(target: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = await target.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration?.active?.state === "activated";
    });
    if (active) return true;
    await target.waitForTimeout(100);
  }
  return false;
}

/** The `id …` line the queue row prints, used to pin "same item" across reloads. */
async function idOfFirstItem(target: Page): Promise<string> {
  const text = await target.locator('[data-testid="queue-item"] code').first().innerText();
  return text.trim();
}
