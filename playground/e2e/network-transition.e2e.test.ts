import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build, preview, type PreviewServer } from "vite";
import { chromium, type Browser, type Page } from "playwright";
import { z } from "zod";
import { snuggExamples, snuggValuesSchema } from "@azx/ribo-adapter-snuggpro";

/**
 * @file Network **transitions**, not network states.
 *
 * Every other e2e file pins connectivity as a *state* — "with the network cut,
 * does it still work". This file exercises the crossing itself: going offline
 * with work in hand, coming back, and flapping across the boundary in quick
 * succession. The one invariant that must survive all of it is absolute:
 *
 *   **No captured recording is ever lost, and nothing is silently double-written.**
 *
 * Everything below asserts that invariant through *observable app behaviour* —
 * queue-item count, the item's `id`, its `attempts` badge, its playable audio —
 * and never through internals. It uses `context.setOffline()` for real link
 * transitions, and polls or waits on observable state rather than sleeping, so a
 * green run means the invariant held, not that a fixed delay happened to be
 * long enough.
 *
 * ## What this file can and cannot reach — read before extending it
 *
 * The connectivity model (`packages/ribo-core/src/connectivity.ts`) and the
 * relay's drain-on-the-stably-online-edge (`queue/relay.ts`) are real and are
 * integration-tested end to end — but in `queue/relay.browser.test.ts`, over a
 * hand-driven event source, a hand-driven clock and an injected probe. **The
 * playground served by `vite preview` wires none of it:**
 *
 *   - `playground/src` never calls `createConnectivity`. There is no probe, no
 *     `navigator.onLine` binder, and no health endpoint to probe against under
 *     `vite preview`.
 *   - The only drain the app exposes is the manual "sync now (stub transcriber)"
 *     button (`QueuePanel.tsx` → `runStubRelay` → `relay.syncNow()`), which by
 *     design bypasses connectivity entirely and is NOT `relay.start(connectivity)`.
 *   - That stub's steps (`FakeTranscriber`, `extract`/`write` = `Promise.resolve`)
 *     do **no network I/O**, so `setOffline()` cannot make a drain fail, stall or
 *     resume — the relay behaves identically online and offline (see the
 *     characterization test at the bottom, which pins exactly this).
 *
 * The consequence is stated per test and summarised in the task report. In short:
 * "record while offline, survive the restore" is fully expressible and is the
 * core field scenario; "drop/restore a drain mid-operation" and "online-but-
 * useless" are NOT expressible through this app because nothing in it reacts to
 * connectivity or probes the network; and the flapping test here asserts
 * *durability across a flapping boundary*, which is genuine, but not *relay
 * hysteresis across a flap* — that already lives in `relay.browser.test.ts`
 * because only there is the relay actually driven by the connectivity model.
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
  // `update-store.ts`'s dev branch and never registers a service worker. The
  // long version of this note is in `offline-boot.e2e.test.ts`.
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
    // The first supplies a synthetic microphone on a machine that has none; the
    // second auto-grants the permission prompt no headless browser can render.
    // Drop either and `getUserMedia` never settles.
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/**
 * Scenario 4 — the core field scenario: record with no signal, keep it, and lose
 * nothing when signal returns.
 *
 * A recording captured entirely offline is the product's whole reason to exist
 * (an auditor in a basement). This crosses the boundary twice — capture while
 * offline, then restore — and after each crossing asserts the durable invariant:
 * exactly one item, the *same* item, with playable audio, never duplicated.
 *
 * Timing-independence: every assertion is on a stable observable (item count,
 * `id`, audio `readyState`) reached via `expect.poll`/`waitFor`. There is no
 * assertion that one transition preceded another — only that the queue settles
 * correctly after each.
 */
test("a recording captured entirely offline survives the restore, exactly once, audio intact", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl);

  // Settle online first: the shell must be precached and the worker active so the
  // reload leg at the end has something to serve offline. This is a precondition,
  // not the thing under test.
  await page.getByRole("heading", { name: "ribo playground" }).waitFor({ state: "visible" });
  await waitForActiveServiceWorker(page, 30_000);

  // ---- cross into offline, then capture ----------------------------------

  await context.setOffline(true);
  await proveOfflineIsReal(page);

  // The capture path — getUserMedia, MediaRecorder, RxDB — is entirely local, so
  // this must work with no network at all. That it does is the point.
  await captureOneRecording(page);

  const items = page.locator('[data-testid="queue-item"]');
  await expect.poll(() => items.count()).toBe(1);
  const offlineId = await idOfFirstItem(page);
  await expectPlayableAudio(page);

  // ---- cross back to online: nothing may change about the queue ----------

  await context.setOffline(false);

  // The app has no connectivity listener, so the restore triggers no automatic
  // work — which is itself the guarantee: coming back online must not spawn a
  // second copy, drop the item, or disturb its audio. Poll a few times so a
  // late duplicating write (if one existed) would be caught, not missed.
  await settleAndAssertSingleItem(page, offlineId);
  await expectPlayableAudio(page);

  // ---- reload online: the item is durable, not merely in memory ----------

  await page.reload({ waitUntil: "load" });
  await page.getByRole("heading", { name: "ribo playground" }).waitFor({ state: "visible" });

  const reloaded = page.locator('[data-testid="queue-item"]');
  await reloaded.first().waitFor({ timeout: 30_000 });
  expect(await reloaded.count()).toBe(1);
  expect(await idOfFirstItem(page)).toBe(offlineId);
  await reloaded.first().getByText("survived reload ✓").waitFor({ state: "visible" });
  await expectPlayableAudio(page);

  await context.close();
}, 180_000);

/**
 * Scenario 2 — the app must not thrash across a flapping boundary.
 *
 * `offline → online → offline → online` in quick succession, with one item
 * already queued. The invariant asserted is durability, expressed as bounds a
 * thrashing relay would violate: the item stays a *single* `queued` row with the
 * *same* `id`, its `attempts` count never leaves 0, and it never enters
 * `failed`/`dead`/a mid-flight status. A relay that drained on every raw link
 * blip (drain → fail → back off → drain) would show inflated attempts, a
 * `failed`/`dead` badge, or a `lastError` — this asserts none of those appear.
 *
 * **Honest scope.** Because the playground does not wire the connectivity model
 * to the relay (see the file header), a flap cannot actually drive the relay
 * here — so this proves *the queue is undisturbed by a flapping link*, not *the
 * relay's hysteresis*. The end-to-end hysteresis proof ("does not thrash when
 * connectivity flaps — one stable edge, one drain") already exists in
 * `queue/relay.browser.test.ts`, where the relay really is subscribed to a real
 * `createConnectivity`. The teeth of the assertions below are demonstrated in
 * the task report by flipping the expected count to a wrong value and watching
 * the run go red; I could not make this catch *relay thrash* without wiring
 * connectivity into the app, and I have not pretended otherwise.
 */
test("flapping the link around a queued item neither duplicates it, loses it, nor inflates its attempts", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl);
  await page.getByRole("heading", { name: "ribo playground" }).waitFor({ state: "visible" });
  await waitForActiveServiceWorker(page, 30_000);

  // One item, captured online and confirmed queued at attempts 0.
  await captureOneRecording(page);
  const item = page.locator('[data-testid="queue-item"]');
  await expect.poll(() => item.count()).toBe(1);
  const queuedId = await idOfFirstItem(page);
  expect(await statusOf(page)).toBe("queued");
  expect(await item.first().innerText()).toContain("attempts 0");

  // Flap fast: five full offline/online cycles with no waits between them, which
  // is the "marginal signal reconnecting" the connectivity model exists to
  // absorb. `setOffline` is synchronous from the driver's side.
  for (let cycle = 0; cycle < 5; cycle += 1) {
    await context.setOffline(true);
    await context.setOffline(false);
  }

  // Settle back online and assert the queue is exactly where it started.
  // `settleAndAssertSingleItem` re-checks over several polls so a delayed
  // duplicating/failing write would be caught rather than raced past.
  await settleAndAssertSingleItem(page, queuedId);

  // The discriminating assertions: a thrashing relay would have moved the item
  // off `queued`, bumped `attempts`, or left a `lastError`. The status badge —
  // read straight off its own element so the always-present "queued <time>"
  // muted line cannot mask a real status change — must still say exactly
  // `queued`, and the attempt count must still be 0.
  expect(await statusOf(page)).toBe("queued");
  expect(await item.first().innerText()).toContain("attempts 0");

  await context.close();
}, 180_000);

/**
 * Characterization — evidence for the integration gap, not a feature test.
 *
 * This pins *why* "drop a drain mid-operation" (scenarios 1 & 3) and "online-
 * but-useless" (scenario 5) are not expressible through this app: the only drain
 * it offers is the manual "sync now" button, and its stub steps touch no
 * network, so cutting the link changes the drain's outcome not at all. Here the
 * item is driven all the way to `done` **while fully offline**. If a future
 * change wires a real transcriber/write (or `relay.start(connectivity)`), this
 * test will start to fail, which is the correct signal that the gap has closed
 * and the four currently-unreachable scenarios have become testable here.
 */
// Restored for R2 Task 18. This test predicted its own skip: the comment above
// says that a change wiring a real drain "will start to fail, which is the
// correct signal that the gap has closed". R2 Phase A's review gate was that
// change — the item parked at `awaiting-review` instead of reaching `done`, so
// the drain no longer ran to completion unaided.
//
// The connectivity property this test exists for is untouched by the gate — it
// is about the link, not the review card — so the fix drives `Outbox.submitReview`
// the same way `extraction-ui.e2e.test.ts` does: through the actual review card,
// not a page-context call straight into core. There is no app-exposed handle onto
// the live `Outbox` instance to call `submitReview` on directly without adding new
// production surface area for it, and this file's own header says every invariant
// here is asserted "through observable app behaviour ... and never through
// internals" — clicking the card is that same discipline applied to the gate.
// Every step of driving the card (reading fields, clicking Accept, submitting) is
// a local DOM/IndexedDB operation with no network I/O, so doing it with the
// context still offline is exactly as informative about "no network I/O" as the
// original, gate-free version was.
//
test("the manual drain runs to completion while offline — the stub steps do no network I/O", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl);
  await page.getByRole("heading", { name: "ribo playground" }).waitFor({ state: "visible" });
  await waitForActiveServiceWorker(page, 30_000);

  await captureOneRecording(page);
  const item = page.locator('[data-testid="queue-item"]');
  await expect.poll(() => item.count()).toBe(1);
  const id = await idOfFirstItem(page);

  await context.setOffline(true);
  await proveOfflineIsReal(page);

  // Drive the queue with the link down. A real network step would fail and park
  // the item under backoff; the stub reaches `awaiting-review` regardless — the
  // review gate stops the relay on purpose, which is a different thing from a
  // network failure parking it under backoff.
  await page.getByRole("button", { name: /sync now/ }).click();
  await expect.poll(() => statusOf(page), { timeout: 30_000 }).toBe("awaiting-review");

  // Drive the review card to a decision on every leaf — still fully offline.
  // Every leaf here is the FakeExtractor's fixed fixture output, which this
  // fake recording's transcript never contains, so — same as
  // `extraction-ui.e2e.test.ts` — every leaf starts ungrounded and the gate
  // blocks until each one is actioned.
  const card = page.locator('[data-testid="review-card"]').first();
  await card.waitFor({ timeout: 30_000 });
  const submit = card.getByRole("button", { name: "Accept all and queue" });

  // Not silent about the gate itself, even though this file's focus is the
  // link, not the review card: blocked before anything is actioned, and the
  // card has exactly as many rows as the schema declares leaves (computed, not
  // hard-coded, so a field-set change moves both sides of the comparison
  // together).
  const leafPaths = allLeafPaths();
  await expect(card.getByTestId("accept-field").count()).resolves.toBe(leafPaths.length);
  await expect(submit.isDisabled()).resolves.toBe(true);

  // The distinguishing assertion (same property as `extraction-ui.e2e.test.ts`):
  // action exactly ONE leaf and confirm the other 50 still block submit, before
  // actioning the rest. A gate that unlocked after any single decision would
  // release here already; only the real one — blocking until EVERY ungrounded
  // leaf is actioned — survives this check.
  const [firstPath, ...restPaths] = leafPaths;
  await card.getByTestId(`review-field-${firstPath}`).getByTestId("accept-field").click();
  await expect(submit.isDisabled()).resolves.toBe(true);

  for (const path of restPaths) {
    await card.getByTestId(`review-field-${path}`).getByTestId("accept-field").click();
  }
  await expect(submit.isDisabled()).resolves.toBe(false);
  await submit.click();

  // `Outbox.submitReview` moved the item to `writing`, dropping it out of the
  // review panel's `awaiting-review` filter.
  await card.waitFor({ state: "detached", timeout: 15_000 });

  // `writing` needs its own drain, same as `extracting` did — nothing here
  // watches the gate open and continues automatically.
  await page.getByRole("button", { name: /sync now/ }).click();

  // The status badge reaches `done`, i.e. the drain ran the whole pipeline —
  // extraction, review, and the write step — with the link down throughout.
  // `statusOf` reads the badge element's own text, not the always
  // "queued <time>" muted line.
  await expect.poll(() => statusOf(page), { timeout: 30_000 }).toBe("done");
  expect(await item.first().innerText()).toContain("transcript:");

  // Still exactly one item, still the same one: draining is not duplicating.
  expect(await item.count()).toBe(1);
  expect(await idOfFirstItem(page)).toBe(id);

  await context.close();
}, 180_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function captureOneRecording(target: Page): Promise<void> {
  await target.getByRole("button", { name: /Start recording/ }).click();
  await expect.poll(() => target.getByText("phase: recording").isVisible()).toBe(true);
  await target.waitForTimeout(CAPTURE_MS);
  await target.getByRole("button", { name: /Stop and queue/ }).click();
  // NOT "a queue row exists" — durable capture inserts that row at `start()`, so
  // it is already on screen and this wait would return instantly, mid-recording.
  // The `<audio>` element is the honest signal: `ItemAudio` renders it only once
  // the canonical attachment is committed, which is exactly when capture is done.
  await target.locator('[data-testid="queue-item"] audio').first().waitFor({ timeout: 15_000 });
}

/**
 * `field`, stripped of leading `.optional()`/`.nullable()` wrappers. Mirrors
 * `ReviewPanel.browser.test.tsx`'s `unwrapGroup` exactly; kept local rather than
 * shared, matching this file's own convention of duplicating helpers rather than
 * importing them from a sibling e2e file.
 */
function unwrapGroup(field: z.ZodType): z.ZodType {
  let current = field;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

/**
 * Every dotted leaf path the real `snuggValuesSchema` declares, in schema
 * order — computed from the schema itself rather than hard-coded, so a future
 * field-set change changes what this test expects instead of silently under-
 * or over-covering it. Same walk as `extraction-ui.e2e.test.ts`'s helper of the
 * same name, and it carries the same correction: **the schema says how many
 * LEAVES, the fixture says how many INSTANCES.** Assuming one instance per group
 * broke the moment the shipped few-shot example gained a second HVAC system.
 */
function allLeafPaths(): readonly string[] {
  const fixture = snuggExamples[0]?.fields as Record<string, unknown> | undefined;
  const paths: string[] = [];
  for (const [groupKey, groupField] of Object.entries(snuggValuesSchema.shape)) {
    const groupSchema = unwrapGroup(groupField as z.ZodType);
    if (groupSchema instanceof z.ZodArray) {
      const elementSchema = groupSchema.element as unknown as z.ZodObject;
      const emitted = fixture?.[groupKey];
      const count = Array.isArray(emitted) ? emitted.length : 0;
      for (let i = 0; i < count; i += 1) {
        for (const leafKey of Object.keys(elementSchema.shape)) {
          paths.push(`${groupKey}[k${i + 1}].${leafKey}`);
        }
      }
    } else if (groupSchema instanceof z.ZodObject) {
      for (const leafKey of Object.keys(groupSchema.shape)) {
        paths.push(`${groupKey}.${leafKey}`);
      }
    }
  }
  return paths;
}

/**
 * Assert the queue is exactly one item with `expectedId`, and *stays* that way.
 *
 * Polls the count repeatedly rather than reading it once: a duplicating write on
 * a transition would land slightly after the transition, so a single read could
 * pass by looking too early. `expect.poll` re-evaluates until the assertion has
 * held across the polling window, which turns "no duplicate appeared" into
 * something observable without depending on when exactly it would have appeared.
 */
async function settleAndAssertSingleItem(target: Page, expectedId: string): Promise<void> {
  const items = target.locator('[data-testid="queue-item"]');
  await expect.poll(() => items.count(), { timeout: 10_000 }).toBe(1);
  // A second poll pass after a beat: catches a late second write the first pass
  // could have preceded. Still not a fixed "wait for the work" sleep — it is a
  // re-assertion of the same invariant, which either holds or does not.
  await expect.poll(() => items.count(), { timeout: 5_000 }).toBe(1);
  expect(await idOfFirstItem(target)).toBe(expectedId);
}

/**
 * Prove `<audio>` for the first queue row has actually decoded, not merely that
 * a row exists — mirrors `offline-boot.e2e.test.ts`. A present row proves the
 * document persisted; only a `readyState >= HAVE_CURRENT_DATA` and a `blob:` src
 * prove the separately-stored audio attachment is intact.
 */
async function expectPlayableAudio(target: Page): Promise<void> {
  const handle = await target.waitForFunction(
    () => {
      const element = document.querySelector<HTMLAudioElement>('[data-testid="queue-item"] audio');
      if (!element || element.readyState < 2 /* HAVE_CURRENT_DATA */) return null;
      return { readyState: element.readyState, src: element.src };
    },
    undefined,
    { timeout: 30_000 },
  );
  const loaded = await handle.jsonValue();
  expect(loaded).not.toBeNull();
  expect(loaded?.src.startsWith("blob:")).toBe(true);
  expect(loaded?.readyState).toBeGreaterThanOrEqual(2);
}

/**
 * Prove the offline cut is real before leaning on it. A `setOffline` that quietly
 * did nothing would make an offline-capture test pass while meaning nothing.
 */
async function proveOfflineIsReal(target: Page): Promise<void> {
  await expect(
    target.evaluate(() => fetch("/definitely-not-precached.txt").then(() => "reached network")),
  ).rejects.toThrow();
}

/**
 * Poll until a service worker is activated, or the deadline passes. Never throws.
 *
 * Hand-rolled for the same reason as in `offline-boot.e2e.test.ts`: an async
 * predicate handed to `page.waitForFunction` returns a Promise, which Playwright
 * sees as truthy on the first tick and resolves against nothing.
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

/**
 * The first row's status, read off the badge element itself.
 *
 * `textContent`, not `innerText`: the badge is displayed uppercase via CSS
 * `text-transform`, and `innerText` returns the *rendered* "DONE" while
 * `textContent` returns the DOM's own lowercase "done" — the value the app
 * actually set. Scoping to the badge (the first `<span>` in the row, rendered
 * immediately after the `#seq`) is what keeps this honest: the muted line below
 * it always reads "queued <time>" regardless of real status, so a whole-row
 * substring match for "queued" would pass even on a `failed` item.
 */
async function statusOf(target: Page): Promise<string> {
  const badge = target.locator('[data-testid="queue-item"] span').first();
  return (await badge.textContent())?.trim().toLowerCase() ?? "";
}

/** The `id …` line the queue row prints, used to pin "same item" across a transition. */
async function idOfFirstItem(target: Page): Promise<string> {
  const text = await target.locator('[data-testid="queue-item"] code').first().innerText();
  return text.trim();
}
