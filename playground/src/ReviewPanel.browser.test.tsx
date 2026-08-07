import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { openOutbox, type Outbox } from "@azx/ribo-core";
import { snuggValuesSchema } from "@azx/ribo-adapter-snuggpro";
import { RiboProvider } from "@azx/ribo-ui-react";
import { z } from "zod";

import { ReviewPanel } from "./ReviewPanel.js";

/**
 * @file Interaction tests for the actual `ReviewPanel` component: the review
 * card is built by hand (`RiboProvider` + a real, IndexedDB-backed `Outbox`,
 * exactly what `App.tsx` wires), rendered, and driven by clicking the buttons
 * and typing into the editors it actually renders — not by calling `useReview`
 * directly, which every existing hook-level test already does.
 *
 * ## Why this file exists, and where it had to live to run at all
 *
 * `useReview`'s own browser tests (`use-review.browser.test.tsx`) prove
 * Accept/Edit/Reject and the rejected-absent/accepted-null-present distinction
 * at the HOOK layer, calling `accept()`/`edit()`/`reject()`/`submit()` as plain
 * functions. None of that exercises `ReviewPanel.tsx` itself, so nothing
 * anywhere caught: a disabled-state bug on the wrong condition, a handler wired
 * to the wrong action, an editor that loses the value on re-render, or —
 * pointedly — the submit gate (`disabled={blocked || submitting}`) being
 * deleted outright. `blocked` is computed entirely in this file from `useReview`'s
 * own `untouched`/`fields`, so no hook-level test could have caught its removal
 * either. This file is that missing layer.
 *
 * It could not simply be added next to the hook tests: `vitest.config.ts`'s
 * `browser` project was scoped to `packages/*\/src/**\/*.browser.test.{ts,tsx}`,
 * which does not reach `playground/src/` at all — a file here would have sat in
 * the tree looking like coverage while `vitest run` executed zero of its
 * assertions. `vitest.config.ts` now has a second `include` entry for
 * `playground/src/**\/*.browser.test.{ts,tsx}` (with the matching `unit`-project
 * exclude) specifically so this file runs; see that config's own comment.
 *
 * ## The 51-leaf reality, and how the fixtures cope with it
 *
 * `ReviewPanel` imports the real `snuggValuesSchema` at module scope — that is
 * the point of Task 17's design, and this file does not work around it with a
 * smaller fake schema. So every fixture below has to account for all 51 leaves,
 * not just the one or two a test cares about: `fullExtraction()` walks the real
 * schema (two levels — group, then leaf; `schema.ts`'s own file header says the
 * seven groups are flat, so this walker does not need to recurse further) and
 * fills every leaf with a GROUNDED filler envelope (a quote that really is in
 * the fixture transcript) except the specific paths a test overrides. That
 * keeps the gate-blocking test honest — only the leaves a test names are
 * ungrounded-and-untouched — without hand-writing 51 envelopes per test or
 * clicking through 50 irrelevant rows.
 */

/** A verbatim substring of every fixture transcript below, for grounded filler leaves. */
const FILLER_SPAN = "the crew walked the whole house today";

interface Envelope {
  readonly value: unknown;
  readonly confidence: number;
  readonly sourceSpan: string | null;
}

const FILLER_ENVELOPE: Envelope = { value: null, confidence: 1, sourceSpan: FILLER_SPAN };

function unwrapGroup(field: z.ZodType): z.ZodObject {
  let current = field;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    // Same cast `field-path.ts`'s `stripOptionalNullable` makes: `.unwrap()`'s
    // declared return type is the core (not classic) `$ZodType` once narrowed
    // only by `instanceof`, and every real wrapper here wraps a classic
    // `z.ZodType`.
    current = current.unwrap() as z.ZodType;
  }
  if (!(current instanceof z.ZodObject)) {
    throw new Error("snuggValuesSchema's own groups are expected to be z.ZodObject");
  }
  return current;
}

/**
 * Every leaf of the real `snuggValuesSchema`, as an extraction envelope map —
 * `FILLER_ENVELOPE` (grounded, so it never blocks the submit gate) everywhere
 * except the dotted paths named in `overrides`.
 */
function fullExtraction(overrides: Readonly<Record<string, Envelope>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [groupKey, groupField] of Object.entries(snuggValuesSchema.shape)) {
    const groupSchema = unwrapGroup(groupField as z.ZodType);
    const leaves: Record<string, unknown> = {};
    for (const leafKey of Object.keys(groupSchema.shape)) {
      const path = `${groupKey}.${leafKey}`;
      leaves[leafKey] = overrides[path] ?? FILLER_ENVELOPE;
    }
    result[groupKey] = leaves;
  }
  return result;
}

const recording = () => ({
  id: crypto.randomUUID(),
  capturedAt: new Date().toISOString(),
  durationMs: 10,
  mimeType: "audio/webm",
  ctx: {},
});

async function openTestOutbox(): Promise<Outbox> {
  // Default storage (Dexie/IndexedDB) — real Chromium via the `browser`
  // project provides it, and it is the same storage `outbox-handle.ts` uses in
  // production, so this exercises the actual `Outbox.watch`/`submitReview`
  // path rather than a stand-in.
  return openOutbox({ name: `review-panel-${crypto.randomUUID()}` });
}

async function parkedItem(
  outbox: Outbox,
  overrides: Readonly<Record<string, Envelope>>,
): Promise<string> {
  const item = await outbox.enqueue({
    recording: recording(),
    audio: new Blob(["x"], { type: "audio/webm" }),
  });
  await outbox.patch(item.id, {
    status: "awaiting-review",
    transcript: {
      recordingId: item.recording.id,
      text: `${FILLER_SPAN}. ${FILLER_SPAN}. ${FILLER_SPAN}.`,
      engine: "fake",
    },
    extracted: fullExtraction(overrides),
  });
  return item.id;
}

async function renderReviewPanel(outbox: Outbox) {
  return render(
    <RiboProvider value={{ outbox }}>
      <ReviewPanel />
    </RiboProvider>,
  );
}

test("the submit gate blocks while an ungrounded leaf is untouched, and releases once it is actioned", async () => {
  const outbox = await openTestOutbox();
  const targetPath = "hvac.hvacSystemEquipmentType";
  await parkedItem(outbox, {
    [targetPath]: { value: "Boiler", confidence: 1, sourceSpan: "definitely not said aloud" },
  });

  const screen = await renderReviewPanel(outbox);
  const submit = screen.getByRole("button", { name: "Accept all and queue" });

  // Blocked: the target leaf's quote is not a substring of the transcript, and
  // nobody has acted on it yet. Every other leaf is grounded filler, so the
  // target is the ONLY thing the gate can be reacting to.
  await expect.element(submit).toBeDisabled();

  const row = screen.getByTestId(`review-field-${targetPath}`);
  await row.getByTestId("accept-field").click();

  // Released: the target has now been explicitly acted on, and every other
  // leaf was already grounded.
  await expect.element(submit).toBeEnabled();

  await outbox.close();
});

test("Accept, Edit and Reject each record the decision they claim, and reach submitReview correctly", async () => {
  const outbox = await openTestOutbox();

  const acceptPath = "hvac.hvacSystemEquipmentType";
  const editPath = "basedata.yearBuilt";
  const rejectPath = "attic.atticInsulationType";
  const acceptNullPath = "wall.wallCavityInsulation";

  await parkedItem(outbox, {
    // Ungrounded, so each also participates in the gate test above's property
    // (blocked-until-actioned) — accepting the extracted value as-is.
    [acceptPath]: { value: "Boiler", confidence: 1, sourceSpan: "not in the transcript" },
    // A stated number, to be overwritten via the editor.
    [editPath]: { value: 1950, confidence: 1, sourceSpan: "not in the transcript" },
    // A stated enum value, to be dropped entirely.
    [rejectPath]: { value: "Cellulose", confidence: 1, sourceSpan: "not in the transcript" },
    // The model found nothing here at all — value AND span both null. Accepting
    // this must still WRITE null, not omit the leaf (that is what `reject`
    // does); this is the accepted-null case named in review.
    [acceptNullPath]: { value: null, confidence: 0, sourceSpan: null },
  });

  const screen = await renderReviewPanel(outbox);

  const submitReviewSpy = vi.spyOn(outbox, "submitReview");

  // Accept: take the extracted value as-is.
  await screen.getByTestId(`review-field-${acceptPath}`).getByTestId("accept-field").click();

  // Edit: type a new value into the leaf's own schema-driven editor (a numeric
  // input, since `basedata.yearBuilt` is `z.number()`).
  await screen.getByTestId(`review-field-${editPath}`).getByTestId("field-editor").fill("1975");

  // Reject: drop the leaf entirely.
  await screen.getByTestId(`review-field-${rejectPath}`).getByTestId("reject-field").click();

  // Accept a leaf whose extracted value is null — the accepted-null case.
  await screen.getByTestId(`review-field-${acceptNullPath}`).getByTestId("accept-field").click();

  const submit = screen.getByRole("button", { name: "Accept all and queue" });
  await expect.element(submit).toBeEnabled();
  await submit.click();

  await vi.waitFor(() => expect(submitReviewSpy).toHaveBeenCalled());
  const [, outcome] = submitReviewSpy.mock.calls[0]!;
  if (outcome.status !== "edited") {
    throw new Error(`expected an "edited" outcome (a leaf was rejected), got "${outcome.status}"`);
  }
  const fields = outcome.fields as Record<string, Record<string, unknown>>;

  // Accept: the extracted value, unchanged, reached the write.
  expect(fields.hvac?.hvacSystemEquipmentType).toBe("Boiler");

  // Edit: the TYPED value, not the original extracted one, reached the write.
  expect(fields.basedata?.yearBuilt).toBe(1975);

  // Reject: the leaf is ABSENT from its group entirely, not present as `null`
  // — the distinction `resolveReview` draws between "dropped" and "written
  // empty".
  expect(Object.hasOwn(fields.attic ?? {}, "atticInsulationType")).toBe(false);

  // Accepted null: the leaf IS present, with its value written as `null` — the
  // opposite of the rejected leaf just above, and the property a rejected/
  // accepted-null mix-up would erase.
  expect(Object.hasOwn(fields.wall ?? {}, "wallCavityInsulation")).toBe(true);
  expect(fields.wall?.wallCavityInsulation).toBeNull();

  await outbox.close();
});
