import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build, preview, type PreviewServer } from "vite";
import { chromium, type Browser } from "playwright";

/**
 * @file Phase 2.5, Task 3 — the persistence report is a *report*.
 *
 * The failure this guards against is not a crash. It is a panel that renders
 * "Asking the browser…" forever, or one that renders a reassuring string
 * regardless of what `navigator.storage.persist()` returned. Both look fine in
 * a screenshot, and both tell a field auditor their recordings are safe when
 * they are not.
 *
 * So the assertions here are deliberately about *agreement*: whatever the panel
 * says has to match what the browser actually answered, read independently from
 * page context. A hard-coded expectation of "granted" or "denied" would be
 * wrong — headless Chromium's answer depends on site engagement, and the point
 * is that the app repeats the answer rather than that the answer is any
 * particular value.
 *
 * `estimate()` is asserted the same way: the numbers on screen have to be the
 * numbers the API returned.
 */

const PLAYGROUND_ROOT = fileURLToPath(new URL("..", import.meta.url));

let server: PreviewServer;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  // See `offline-boot.e2e.test.ts`: Vitest sets NODE_ENV=test, and Vite reads
  // `import.meta.env.DEV` from NODE_ENV rather than from `mode`.
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
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

test("the panel reports the persistence answer the browser actually gave", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl);

  const panel = page.locator("section", { hasText: "Storage durability" }).first();
  await panel.waitFor({ state: "visible", timeout: 30_000 });

  // Resolved, not stuck. The "checking" copy must not survive first paint.
  await expect
    .poll(async () => (await panel.innerText()).includes("Asking the browser"), {
      timeout: 15_000,
    })
    .toBe(false);

  // What the browser says, asked independently of the app.
  const persisted = await page.evaluate(() => navigator.storage.persisted());
  const text = await panel.innerText();

  if (persisted) {
    expect(text).toContain("Persistent ✓");
  } else {
    // The whole point of Task 3: a refused request must read as refused. Any
    // wording that lets "NOT persistent" be mistaken for safety fails here.
    expect(text).toContain("NOT persistent");
    expect(text).toContain("removed by the browser at any time");
  }
}, 120_000);

test("the headroom line shows the numbers estimate() returned", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl);

  const panel = page.locator("section", { hasText: "Storage durability" }).first();
  await panel.waitFor({ state: "visible", timeout: 30_000 });
  await expect
    .poll(async () => (await panel.innerText()).includes("Measuring available storage"), {
      timeout: 15_000,
    })
    .toBe(false);

  const estimate = await page.evaluate(() => navigator.storage.estimate());
  const text = await panel.innerText();

  if (estimate.quota === undefined) {
    expect(text).toContain("does not report a storage estimate");
    return;
  }

  // The quota the panel printed, read back out of the sentence and compared
  // against the API numerically. Not a string match: Chromium derives quota
  // from free disk and it drifts by a few kB between two calls a second apart,
  // so an exact match would flake. A 1% band is far tighter than the "usage
  // where it meant quota" mix-up this is here to catch.
  const printed = /of ([\d.]+) (B|kB|MB|GB)/.exec(text);
  expect(printed, `no quota found in: ${text}`).not.toBeNull();
  const scale = { B: 1, kB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[printed?.[2] ?? "B"];
  const shown = Number(printed?.[1]) * (scale ?? 1);
  expect(Math.abs(shown - estimate.quota) / estimate.quota).toBeLessThan(0.01);

  // Phase 3's headroom verdict is stated either way; silence is the failure.
  expect(/Enough for Phase 3|NOT enough for Phase 3/.test(text)).toBe(true);
}, 120_000);

test("the iOS Add-to-Home-Screen nudge is not shown on a non-iOS device", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl);

  const panel = page.locator("section", { hasText: "Storage durability" }).first();
  await panel.waitFor({ state: "visible", timeout: 30_000 });

  // Chromium on Linux/macOS is `not-applicable`. Showing an install prompt to a
  // device whose eviction rules are not iOS's is exactly the engagement-bait
  // failure the nudge is written to avoid.
  expect(await panel.innerText()).not.toContain("Add this app to your Home Screen");
}, 120_000);

test("an iPhone user agent does see the nudge, and can dismiss it for good", async () => {
  // The nudge's only trigger is the device, so the only way to see it fire is
  // to be that device. A test that never renders it is a test of nothing.
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();
  await page.goto(baseUrl);

  const nudge = page.getByText("Add this app to your Home Screen");
  await nudge.waitFor({ state: "visible", timeout: 30_000 });

  await page.getByRole("button", { name: "Not now" }).click();
  await nudge.waitFor({ state: "detached" });

  // Non-nagging means it stays dismissed across launches.
  await page.reload({ waitUntil: "load" });
  await page.locator("section", { hasText: "Storage durability" }).first().waitFor();
  expect(await page.getByText("Add this app to your Home Screen").count()).toBe(0);

  await context.close();
}, 120_000);
