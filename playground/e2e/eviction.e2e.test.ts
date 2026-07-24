import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build, preview, type PreviewServer } from "vite";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/**
 * @file Proof that eviction detection actually fires — Phase 2.5, Task 4.
 *
 * A detector that has never fired is not known to work, and this one is the
 * kind that can look correct forever while doing nothing: its job is to notice
 * an event that by construction leaves no trace. So this test manufactures the
 * event, then checks the user is told.
 *
 * ## What is wiped, and what is deliberately left alone
 *
 * **IndexedDB and Cache Storage, together, and nothing else.** That pairing is
 * not incidental — `docs/implementation/09-offline-first.md` §"iOS Safari
 * constraints" says eviction takes exactly those two at once, which is why
 * `eviction-marker.ts` puts its marker in `localStorage` and a cookie instead.
 *
 * Cookies and `localStorage` are **not** cleared here. Clearing them would
 * simulate the *full* iOS seven-day sweep, which `eviction-marker.ts` states
 * plainly it cannot detect; expecting the notice after that would be asserting
 * a capability the app explicitly does not claim.
 *
 * ## Why CDP rather than `indexedDB.deleteDatabase()`
 *
 * RxDB holds its connections open for the life of the page, and
 * `deleteDatabase` against an open connection fires `blocked` and waits — it
 * does not reject, so an in-page wipe silently does nothing until the page
 * unloads. Worse, the reload needed to unblock it *is* the reload under test,
 * so the detector would run against a database that had not been wiped yet.
 * `Storage.clearDataForOrigin` forces the delete, and naming the two storage
 * types explicitly (rather than `"all"`) keeps the blast radius equal to a real
 * eviction's.
 *
 * ## The negative control
 *
 * The second test is not padding. A detector that fires on *every* empty queue
 * would pass the first test while being worse than no detector at all — it
 * would tell a user their recordings were deleted every time they cleared the
 * queue themselves.
 */

const PLAYGROUND_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** See `offline-boot.e2e.test.ts` — sub-100ms captures can flush as zero bytes. */
const CAPTURE_MS = 1_200;

let server: PreviewServer;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  // `NODE_ENV`, not `mode`: Vitest sets NODE_ENV=test and Vite derives
  // `import.meta.env.DEV` from it, so without this the bundle takes
  // `update-store.ts`'s dev branch. The long version of this note is in
  // `offline-boot.e2e.test.ts`.
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
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

test("a wiped IndexedDB and Cache is reported as eviction, not as an empty queue", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl);

  await captureOneRecording(page);

  // Polled, not assumed: the marker is written from the `items$` subscription,
  // so wiping before that write lands would make this test pass only by
  // winning a race.
  await expect.poll(() => readMarkerItems(page), { timeout: 15_000 }).toBe(1);

  // ---- wipe the pair a real eviction takes -------------------------------

  await clearIndexedDbAndCaches(context, page);

  // Both really gone, and the marker really still there. Without these the test
  // could fail (or pass) for reasons that have nothing to do with the detector.
  expect(await remainingStores(page)).toEqual({ databases: 0, caches: 0 });
  expect(await readMarkerItems(page)).toBe(1);

  // The wiped page is closed rather than reloaded. Its RxDB handle is still
  // live, and letting it emit once more would run `writeMarker(0)` and destroy
  // the very evidence the detector is about to read.
  await page.close();

  // ---- relaunch: the detector's only chance to speak ---------------------

  const relaunched = await context.newPage();
  await relaunched.goto(baseUrl);

  const notice = relaunched.locator('[data-testid="eviction-notice"]');
  await notice.waitFor({ state: "visible", timeout: 30_000 });
  await notice.getByText("Your queued recordings were removed by the browser").waitFor();
  await notice.getByText("1 recording was waiting to sync").waitFor();

  // The point of the whole task: the queue is empty, and the user is NOT left
  // reading the fresh-install line under a notice that says otherwise.
  expect(await relaunched.locator('[data-testid="queue-item"]').count()).toBe(0);
  const empty = await relaunched.locator('[data-testid="queue-empty"]').innerText();
  expect(empty).toContain("removed by the browser");
  expect(empty).not.toContain("Nothing queued yet");

  // Acknowledged once, and it does not return: the watch has already rewritten
  // the marker to zero items, so the next launch sees an honestly empty queue.
  await relaunched.getByRole("button", { name: "Got it" }).click();
  await notice.waitFor({ state: "detached" });

  await relaunched.reload({ waitUntil: "load" });
  await relaunched.getByText("Nothing queued yet").waitFor({ state: "visible", timeout: 30_000 });
  expect(await relaunched.locator('[data-testid="eviction-notice"]').count()).toBe(0);

  await context.close();
}, 180_000);

test("a queue the user emptied themselves is not reported as eviction", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl);

  await captureOneRecording(page);
  await expect.poll(() => readMarkerItems(page), { timeout: 15_000 }).toBe(1);

  await page.getByRole("button", { name: "clear queue" }).click();
  await expect.poll(() => readMarkerItems(page), { timeout: 15_000 }).toBe(0);

  await page.reload({ waitUntil: "load" });
  await page.getByText("Nothing queued yet").waitFor({ state: "visible", timeout: 30_000 });
  expect(await page.locator('[data-testid="eviction-notice"]').count()).toBe(0);

  await context.close();
}, 180_000);

/**
 * The documented blind spot, pinned rather than described.
 *
 * `eviction-marker.ts` and the storage panel both state that a **full** iOS
 * sweep — which takes `localStorage` and script-set cookies along with
 * IndexedDB and Cache — leaves a device indistinguishable from a fresh install.
 * This asserts that claim is accurate rather than a guess, and it is the
 * strongest available evidence that the marker is what makes the first test
 * pass: remove the marker and the notice does not appear.
 *
 * It asserts an absence on purpose. Deleting it, or "fixing" the app so it
 * passes with the notice shown, would mean the app is claiming to detect
 * something it cannot.
 */
test("a full sweep that also takes the marker is NOT detected — the documented residual case", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl);

  await captureOneRecording(page);
  await expect.poll(() => readMarkerItems(page), { timeout: 15_000 }).toBe(1);

  await clearIndexedDbAndCaches(context, page);
  // The extra step that makes this the iOS sweep rather than a partial clear.
  await page.evaluate(() => {
    localStorage.clear();
  });
  await context.clearCookies();
  expect(await readMarkerItems(page)).toBeUndefined();

  await page.close();

  const relaunched = await context.newPage();
  await relaunched.goto(baseUrl);
  await relaunched.getByText("Nothing queued yet").waitFor({ state: "visible", timeout: 30_000 });
  expect(await relaunched.locator('[data-testid="eviction-notice"]').count()).toBe(0);

  await context.close();
}, 180_000);

async function captureOneRecording(target: Page): Promise<void> {
  await target.getByRole("button", { name: /Start recording/ }).click();
  await expect.poll(() => target.getByText("phase: recording").isVisible()).toBe(true);
  await target.waitForTimeout(CAPTURE_MS);
  await target.getByRole("button", { name: /Stop and queue/ }).click();
  await target.locator('[data-testid="queue-item"]').first().waitFor({ timeout: 15_000 });
}

/**
 * How many items the marker currently claims.
 *
 * Reads the `localStorage` copy because it is the easier of the two to inspect;
 * the app writes a cookie as well, and the wipe below leaves both untouched.
 * `undefined` means no marker — which would itself be a bug worth failing on.
 */
async function readMarkerItems(target: Page): Promise<number | undefined> {
  return target.evaluate(() => {
    const raw = localStorage.getItem("ribo.storage-marker");
    if (raw === null) return undefined;
    return (JSON.parse(raw) as { items: number }).items;
  });
}

/** Force-delete IndexedDB and Cache Storage for this origin, and nothing else. */
async function clearIndexedDbAndCaches(context: BrowserContext, target: Page): Promise<void> {
  const cdp = await context.newCDPSession(target);
  await cdp.send("Storage.clearDataForOrigin", {
    origin: new URL(target.url()).origin,
    storageTypes: "indexeddb,cache_storage",
  });
  await cdp.detach();
}

async function remainingStores(target: Page): Promise<{ databases: number; caches: number }> {
  return target.evaluate(async () => ({
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
  }));
}
