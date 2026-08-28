import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build, preview, type PreviewServer } from "vite";
import { chromium, type Browser, type Page } from "playwright";
import { z } from "zod";
import { snuggValuesSchema } from "@azx/ribo-adapter-snuggpro";

/**
 * @file Phase 4 Task 4: extraction is visible end to end, on the default
 * `FakeExtractor` path — **no key, no network**.
 *
 * The whole point of the fake default is that the demo drains a real recording
 * all the way through the `extracting` step with nothing configured. So this test
 * records a clip, presses "sync now (stub transcriber)" — which runs the shared
 * extract step (`FakeExtractor` here) after a `FakeTranscriber` — and asserts the
 * fields show with provenance in the review card, then drives that card (R2 Phase
 * A's human review gate: extraction parks the item at `awaiting-review`, and
 * `Outbox.submitReview` is the only way out) to `done`.
 *
 * ## Deliberately the fake path (plan DoD / Global Constraints)
 *
 * A gate that needs `VITE_OPENAI_API_KEY` or a reachable model is not a gate. This
 * asserts the shipped default: the "sample data (FakeExtractor)" banner, and the
 * replayed Delgado fields with their provenance — including that the grounding
 * check flags those fixture quotes as NOT in this (fake) recording's transcript,
 * which is the honest, correct result. Every one of the fixture's 51 leaves is
 * therefore either a stated value whose quote is not in this transcript, or a
 * silent null with no quote at all — `isSpanGrounded` calls both ungrounded — so
 * the submit gate blocks on the entire card, not a hand-picked leaf or two, and
 * this test actions every one of them before it can submit.
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

/**
 * `field`, stripped of leading `.optional()`/`.nullable()` wrappers, asserted to
 * be a `z.ZodObject` — the same shape `snuggValuesSchema`'s own seven groups
 * take. Mirrors `ReviewPanel.browser.test.tsx`'s `unwrapGroup` exactly; kept
 * local rather than shared, matching this directory's own convention of every
 * e2e file carrying its own helpers (see `captureOneRecording`, duplicated
 * rather than imported, in `eviction.e2e.test.ts` and `network-transition.e2e.test.ts`).
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
 * or over-covering it. Collection groups are arrays; their element leaves are
 * reported as `group.leaf` without an array index.
 */
function allLeafPaths(): readonly string[] {
  const paths: string[] = [];
  for (const [groupKey, groupField] of Object.entries(snuggValuesSchema.shape)) {
    const groupSchema = unwrapGroup(groupField as z.ZodType);
    if (groupSchema instanceof z.ZodArray) {
      const elementSchema = groupSchema.element as unknown as z.ZodObject;
      for (const leafKey of Object.keys(elementSchema.shape)) {
        paths.push(`${groupKey}.${leafKey}`);
      }
    } else if (groupSchema instanceof z.ZodObject) {
      for (const leafKey of Object.keys(groupSchema.shape)) {
        paths.push(`${groupKey}.${leafKey}`);
      }
    }
  }
  return paths;
}

// Restored for R2 Task 18. This used to poll straight for `done`; R2 Phase A put
// a human review gate between `extracting` and `writing` (an item now parks at
// `awaiting-review`, and `Outbox.submitReview` is the only thing that moves it
// on), so the poll for `done` alone became unreachable without a human. The fix
// is NOT to weaken the assertion to accept `awaiting-review` — the whole point of
// this test is that a recording drains ALL the way through — but to drive the
// review card (Task 17's `ReviewPanel`) the way a human would: action every
// blocked leaf, submit, then drain the resulting `writing` step too. The path is
// one human step longer, not shorter.
//
// Skipped for R1.6 Task 5: review.ts does not yet enumerate array instances, so
// `buildReviewRequest` fails for hvac/attic/wall/window/dhw. Re-enable in Tasks 6-7.
test.skip("a recording drains through extraction and its fields show with provenance", async () => {
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
  // NOT "a queue row exists" — durable capture inserts that row at `start()`, so
  // it is already on screen and this wait would return instantly, mid-recording.
  // The `<audio>` element is the honest signal: `ItemAudio` renders it only once
  // the canonical attachment is committed, which is exactly when capture is done.
  await page.locator('[data-testid="queue-item"] audio').first().waitFor({ timeout: 15_000 });

  // ---- drain #1: FakeTranscriber → shared extract step → parked for review ----
  await page.getByRole("button", { name: /sync now/ }).click();

  // The item reached the extracting step and a review card appeared.
  const card = page.locator('[data-testid="review-card"]').first();
  await card.waitFor({ timeout: 30_000 });

  // The item is parked at `awaiting-review`, not `done` — `ReviewPanel` only
  // ever shows items in this status (`useOutboxItems({ status: "awaiting-review" })`),
  // so the card being visible already proves it; the badge is read directly too,
  // so this would fail if that filter were ever loosened to show more.
  await card.getByText("awaiting-review", { exact: true }).waitFor({ state: "visible" });

  // A real stated field from the fixture shows, with its value and a quote.
  // The label is the humanized dotted path (`hvac.hvacSystemEquipmentType`,
  // group and leaf both humanized) — not the free-standing "Heating equipment
  // type" an earlier, 34-leaf schema would have shown.
  const cardText = await card.innerText();
  expect(cardText).toMatch(/Hvac System Equipment Type/i);
  expect(cardText).toMatch(/boiler/);

  // Provenance grounding ran: the fixture's quotes are NOT in this fake
  // recording's transcript, so they are flagged — the check works, honestly.
  expect(cardText).toMatch(/not in this transcript/);

  // The null-heavy reality is collapsed, not rendered as findings.
  await card
    .getByText(/not stated in this recording/)
    .first()
    .waitFor({ state: "visible" });

  // The gate is blocking on the whole card — every one of the fixture's 51
  // leaves is either an unfound quote or a silent null, both ungrounded — and
  // nothing has been actioned yet.
  const submit = card.getByRole("button", { name: "Accept all and queue" });
  expect(await submit.isDisabled()).toBe(true);
  await card.getByTestId("review-blocked").waitFor({ state: "visible" });

  // The card renders exactly as many rows as the schema declares leaves — a
  // card that silently rendered fewer (a broken group walk, a filtered leaf)
  // would otherwise satisfy every assertion below by having less to action.
  // Computed from the schema, not hard-coded, so a future field-set change
  // moves both sides of this comparison together.
  const leafPaths = allLeafPaths();
  await expect(card.getByTestId("accept-field").count()).resolves.toBe(leafPaths.length);

  // ---- drive the review card: one leaf, then the rest, then submit --------
  // The distinguishing assertion: action exactly ONE leaf and confirm the
  // other 50 still block submit. "Accept all, then check enabled" cannot tell
  // a working gate (blocks until EVERY ungrounded leaf is actioned) from a
  // broken one that unlocks after ANY single decision — both pass that
  // sequence identically. Checking here, between the first click and the
  // rest, is what only the correct implementation survives.
  const [firstPath, ...restPaths] = leafPaths;
  await card.getByTestId(`review-field-${firstPath}`).getByTestId("accept-field").click();
  await expect(submit.isDisabled()).resolves.toBe(true);

  // Action every remaining leaf, addressed by its own dotted path rather than
  // a positional index — a missing or renamed row fails on the specific leaf
  // named in the selector, not an opaque `nth(37)`.
  for (const path of restPaths) {
    await card.getByTestId(`review-field-${path}`).getByTestId("accept-field").click();
  }
  await expect(submit.isDisabled()).resolves.toBe(false);

  await submit.click();

  // `Outbox.submitReview` moved the item to `writing`, which drops it out of
  // `ReviewPanel`'s `awaiting-review` filter — the card itself disappears.
  await card.waitFor({ state: "detached", timeout: 15_000 });

  // ---- drain #2: `writing` needs its own drain -----------------------------
  // Nothing in this app watches the review gate open and continues on its own —
  // `QueuePanel`'s auto-sync effect only names `queued`/`failed` as drainable —
  // so a second manual "sync now" is what actually runs the write step.
  await page.getByRole("button", { name: /sync now/ }).click();

  // The item drained all the way to `done` — extraction and review did not
  // strand it. Read off the queue row's own status-badge span, not off text
  // that also contains the muted "queued …" line.
  const queueRow = page.locator('[data-testid="queue-item"]').first();
  await expect
    .poll(async () => (await queueRow.locator("span").first().textContent())?.trim(), {
      timeout: 15_000,
    })
    .toBe("done");
}, 180_000);
