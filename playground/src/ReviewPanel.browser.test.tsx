import { createMemoryBackend, deriveExtractionShape, type ReviewPlan } from "@azx/ribo-core";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { openStorage, type Storage } from "@azx/ribo-core";
import { snuggValuesSchema } from "@azx/ribo-adapter-snuggpro";
import { RiboProvider } from "@azx/ribo-ui-react";
import { z } from "zod";

import { demoReviewPlan } from "./demo-review-plan.js";
import { ReviewPanel } from "./ReviewPanel.js";

/**
 * @file Interaction tests for the actual `ReviewPanel` component: the review
 * card is built by hand (`RiboProvider` + a real, IndexedDB-backed `Storage`,
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
 * smaller fake schema. So every fixture below has to account for all 209 leaves,
 * not just the one or two a test cares about: `fullExtraction()` walks the real
 * schema (two levels — group, then leaf; `schema.ts`'s own file header says the
 * eight groups are flat, so this walker does not need to recurse further) and
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

function unwrapGroup(field: z.ZodType): z.ZodType {
  let current = field;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    // Same cast `field-path.ts`'s `stripOptionalNullable` makes: `.unwrap()`'s
    // declared return type is the core (not classic) `$ZodType` once narrowed
    // only by `instanceof`, and every real wrapper here wraps a classic
    // `z.ZodType`.
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

/**
 * Every leaf of the real `snuggValuesSchema`, as an extraction envelope map —
 * `FILLER_ENVELOPE` (grounded, so it never blocks the submit gate) everywhere
 * except the dotted paths named in `overrides`. Collection groups are arrays,
 * and their overrides use keyed paths (`hvac[k1].hvacSystemEquipmentType`).
 *
 * `instances` overrides the default one-instance-per-collection count, which is
 * what lets the tests exercise two-instance groups and empty-but-present groups.
 */
function fullExtraction(
  overrides: Readonly<Record<string, Envelope>>,
  instances: Readonly<Record<string, number>> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [groupKey, groupField] of Object.entries(snuggValuesSchema.shape)) {
    const groupSchema = unwrapGroup(groupField as z.ZodType);
    if (groupSchema instanceof z.ZodArray) {
      const elementSchema = groupSchema.element as unknown as z.ZodObject;
      const count = instances[groupKey] ?? 1;
      if (count === 0) {
        result[groupKey] = [];
        continue;
      }
      const groupInstances: Record<string, unknown>[] = [];
      for (let i = 0; i < count; i++) {
        const instanceKey = `k${i + 1}`;
        const leaves: Record<string, unknown> = {};
        for (const leafKey of Object.keys(elementSchema.shape)) {
          const path = `${groupKey}[${instanceKey}].${leafKey}`;
          leaves[leafKey] = overrides[path] ?? FILLER_ENVELOPE;
        }
        groupInstances.push(leaves);
      }
      result[groupKey] = groupInstances;
    } else if (groupSchema instanceof z.ZodObject) {
      const leaves: Record<string, unknown> = {};
      for (const leafKey of Object.keys(groupSchema.shape)) {
        const path = `${groupKey}.${leafKey}`;
        leaves[leafKey] = overrides[path] ?? FILLER_ENVELOPE;
      }
      result[groupKey] = leaves;
    } else {
      throw new Error(`unexpected group schema for ${groupKey}`);
    }
  }
  return result;
}

const recording = () => ({
  id: crypto.randomUUID(),
  capturedAt: new Date().toISOString(),
  kind: "audio" as const,
  durationMs: 10,
  mimeType: "audio/webm",
  ctx: {},
});

async function openTestOutbox(): Promise<Storage> {
  // Default storage (Dexie/IndexedDB) — real Chromium via the `browser`
  // project provides it. The backend is the memory one rather than production's
  // RxDB: what this test exercises is the real `storage.captures.watch`/`submitReview`
  // path, and which backend is underneath it is the conformance kit's question,
  // not this file's.
  return openStorage({ backend: createMemoryBackend(`review-panel-${crypto.randomUUID()}`) });
}

async function parkedItem(
  storage: Storage,
  overrides: Readonly<Record<string, Envelope>>,
  instances: Readonly<Record<string, number>> = {},
  statedEmptyGroups?: Readonly<Record<string, string>>,
): Promise<string> {
  const session = await storage.sessions.open({ ctx: {}, ref: "job-7" });
  const item = await storage.captures.enqueue({
    recording: recording(),
    audio: new Blob(["x"], { type: "audio/webm" }),
    sessionId: session.id,
  });
  await storage.captures.patch(item.id, {
    status: "transcribed",
    transcript: {
      recordingId: item.recording.id,
      text: `${FILLER_SPAN}. ${FILLER_SPAN}. ${FILLER_SPAN}.`,
      engine: "fake",
    },
  });
  await storage.sessions.patch(session.id, {
    status: "awaiting-review",
    extracted: fullExtraction(overrides, instances),
    extractedFromRecordingIds: [item.id],
    ...(statedEmptyGroups ? { statedEmptyGroups } : {}),
  });
  return session.id;
}

async function renderReviewPanel(storage: Storage, reviewPlan?: ReviewPlan) {
  return render(
    <RiboProvider value={{ storage }}>
      <ReviewPanel reviewPlan={reviewPlan} />
    </RiboProvider>,
  );
}

test("the submit gate blocks while an ungrounded leaf is untouched, and releases once it is actioned", async () => {
  const storage = await openTestOutbox();
  const targetPath = "hvac[k1].hvacSystemEquipmentType";
  await parkedItem(storage, {
    [targetPath]: { value: "Boiler", confidence: 1, sourceSpan: "definitely not said aloud" },
  });

  const screen = await renderReviewPanel(storage);
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

  await storage.close();
});

test("a leaf named in requiredOnCreate renders the required marker, and an ordinary leaf does not", async () => {
  // `snuggProAdapter.requiredOnCreate` names exactly two leaves — the only ones
  // Snugg Pro refuses to CREATE an HVAC system without (adapter.ts's own doc
  // comment). This is the join `ReviewPanel` -> `useReview` -> `buildReviewRequest`
  // is responsible for keeping wired: if any link drops the option, every
  // `field.required` on the card is `false` and the marker below never renders.
  // With `requiredOnCreate` per group, the two HVAC leaves surface on every
  // instance as keyed paths. Task 15 owns the un-skip and the full assertions.
  const requiredPath = "hvac[k1].hvacSystemEquipmentType";
  const otherRequiredPath = "hvac[k1].hvacUpgradeAction";
  const ordinaryPath = "basedata.yearBuilt";

  const storage = await openTestOutbox();
  await parkedItem(storage, {});

  const screen = await renderReviewPanel(storage);

  await expect
    .element(
      screen.getByTestId(`review-field-${requiredPath}`).getByTitle("required by the host tool"),
    )
    .toBeInTheDocument();
  await expect
    .element(
      screen
        .getByTestId(`review-field-${otherRequiredPath}`)
        .getByTitle("required by the host tool"),
    )
    .toBeInTheDocument();
  await expect
    .element(
      screen.getByTestId(`review-field-${ordinaryPath}`).getByTitle("required by the host tool"),
    )
    .not.toBeInTheDocument();

  await storage.close();
});

test("Accept, Edit and Reject each record the decision they claim, and reach submitReview correctly", async () => {
  const storage = await openTestOutbox();

  const acceptPath = "hvac[k1].hvacSystemEquipmentType";
  const editPath = "basedata.yearBuilt";
  const rejectPath = "attic[k1].atticInsulationType";
  const acceptNullPath = "wall[k1].wallCavityInsulation";

  await parkedItem(storage, {
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

  const screen = await renderReviewPanel(storage);

  const submitReviewSpy = vi.spyOn(storage.sessions, "submitReview");

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
  const fields = outcome.fields;
  const hvac = fields.hvac as Record<string, unknown>[] | undefined;
  const attic = fields.attic as Record<string, unknown>[] | undefined;
  const wall = fields.wall as Record<string, unknown>[] | undefined;

  // Accept: the extracted value, unchanged, reached the first HVAC instance.
  expect(hvac?.[0]?.hvacSystemEquipmentType).toBe("Boiler");

  // Edit: the TYPED value, not the original extracted one, reached the write.
  expect(fields.basedata).toMatchObject({ yearBuilt: 1975 });

  // Reject: the leaf is ABSENT from its attic instance, not present as `null`
  // — the distinction `resolveReview` draws between "dropped" and "written
  // empty".
  expect(Object.hasOwn(attic?.[0] ?? {}, "atticInsulationType")).toBe(false);

  // Accepted null: the leaf IS present, with its value written as `null` — the
  // opposite of the rejected leaf just above, and the property a rejected/
  // accepted-null mix-up would erase.
  expect(Object.hasOwn(wall?.[0] ?? {}, "wallCavityInsulation")).toBe(true);
  expect(wall?.[0]?.wallCavityInsulation).toBeNull();

  await storage.close();
});

test("a two-instance group renders two labelled instance sections, and a leaf edit in the second lands on the second", async () => {
  const storage = await openTestOutbox();
  await parkedItem(
    storage,
    {
      "hvac[k2].hvacHeatingSystemModel": {
        value: "Furnace model",
        confidence: 1,
        sourceSpan: "not in the transcript",
      },
    },
    { hvac: 2 },
  );

  const screen = await renderReviewPanel(storage);
  const submitReviewSpy = vi.spyOn(storage.sessions, "submitReview");

  await expect.element(screen.getByTestId("review-instance-hvac[k1]")).toBeInTheDocument();
  await expect.element(screen.getByTestId("review-instance-hvac[k2]")).toBeInTheDocument();

  // Edit the second instance's model, leaving the first untouched.
  await screen
    .getByTestId("review-instance-hvac[k2]")
    .getByTestId("review-field-hvac[k2].hvacHeatingSystemModel")
    .getByTestId("field-editor")
    .fill("Heat Pump model");

  const submit = screen.getByRole("button", { name: "Accept all and queue" });
  await expect.element(submit).toBeEnabled();
  await submit.click();

  await vi.waitFor(() => expect(submitReviewSpy).toHaveBeenCalled());
  const [, outcome] = submitReviewSpy.mock.calls[0]!;
  if (outcome.status !== "edited") {
    throw new Error(`expected an "edited" outcome, got "${outcome.status}"`);
  }
  const hvac = outcome.fields.hvac as Record<string, unknown>[] | undefined;
  expect(hvac).toHaveLength(2);
  expect(hvac?.[0]?.hvacHeatingSystemModel).toBeNull();
  expect(hvac?.[1]?.hvacHeatingSystemModel).toBe("Heat Pump model");

  await storage.close();
});

test("a present-but-empty collection renders the group with an add affordance, not nothing", async () => {
  const storage = await openTestOutbox();
  await parkedItem(storage, {}, { hvac: 0 });

  const screen = await renderReviewPanel(storage);
  const group = screen.getByTestId("review-group-hvac");
  await expect.element(group).toBeInTheDocument();
  await expect.element(group.getByText("none described")).toBeInTheDocument();

  const add = screen.getByTestId("add-instance-hvac");
  await expect.element(add).toBeInTheDocument();
  await add.click();

  // Adding creates one reviewable instance with the usual sentinel leaves.
  await expect.element(screen.getByTestId("review-instance-hvac[k1]")).toBeInTheDocument();
  await expect
    .element(screen.getByTestId("review-field-hvac[k1].hvacSystemEquipmentType"))
    .toBeInTheDocument();

  await storage.close();
});

test("removing the first instance leaves the second instance's entered value intact", async () => {
  const storage = await openTestOutbox();
  await parkedItem(
    storage,
    {
      "hvac[k2].hvacHeatingSystemModel": {
        value: "Furnace model",
        confidence: 1,
        sourceSpan: "not in the transcript",
      },
    },
    { hvac: 2 },
  );

  const screen = await renderReviewPanel(storage);
  const submitReviewSpy = vi.spyOn(storage.sessions, "submitReview");

  // Edit the second instance before removing the first.
  await screen
    .getByTestId("review-instance-hvac[k2]")
    .getByTestId("review-field-hvac[k2].hvacHeatingSystemModel")
    .getByTestId("field-editor")
    .fill("Heat Pump model");

  await screen.getByTestId("remove-instance-hvac[k1]").click();

  // After removal, the second instance is re-keyed to k1 but keeps its edited value.
  await expect.element(screen.getByTestId("review-instance-hvac[k1]")).toBeInTheDocument();
  await expect.element(screen.getByTestId("review-instance-hvac[k2]")).not.toBeInTheDocument();

  const submit = screen.getByRole("button", { name: "Accept all and queue" });
  await expect.element(submit).toBeEnabled();
  await submit.click();

  await vi.waitFor(() => expect(submitReviewSpy).toHaveBeenCalled());
  const [, outcome] = submitReviewSpy.mock.calls[0]!;
  if (outcome.status !== "edited") {
    throw new Error(`expected an "edited" outcome, got "${outcome.status}"`);
  }
  const hvac = outcome.fields.hvac as Record<string, unknown>[] | undefined;
  expect(hvac).toHaveLength(1);
  expect(hvac?.[0]?.hvacHeatingSystemModel).toBe("Heat Pump model");

  await storage.close();
});

test("the submit gate blocks on an unactioned required leaf in the second instance", async () => {
  const storage = await openTestOutbox();
  await parkedItem(
    storage,
    {
      "hvac[k2].hvacUpgradeAction": { value: null, confidence: 0, sourceSpan: null },
    },
    { hvac: 2 },
  );

  const screen = await renderReviewPanel(storage);
  const submit = screen.getByRole("button", { name: "Accept all and queue" });
  await expect.element(submit).toBeDisabled();

  await screen
    .getByTestId("review-instance-hvac[k2]")
    .getByTestId("review-field-hvac[k2].hvacUpgradeAction")
    .getByTestId("accept-field")
    .click();

  await expect.element(submit).toBeEnabled();
  await storage.close();
});

test("the submit gate blocks on an ungrounded leaf in the second instance, not just the first", async () => {
  const storage = await openTestOutbox();
  await parkedItem(
    storage,
    {
      "hvac[k2].hvacDuctLocation": {
        value: "basement",
        confidence: 1,
        sourceSpan: "definitely not said aloud",
      },
    },
    { hvac: 2 },
  );

  const screen = await renderReviewPanel(storage);
  const submit = screen.getByRole("button", { name: "Accept all and queue" });
  await expect.element(submit).toBeDisabled();

  await screen
    .getByTestId("review-instance-hvac[k2]")
    .getByTestId("review-field-hvac[k2].hvacDuctLocation")
    .getByTestId("accept-field")
    .click();

  await expect.element(submit).toBeEnabled();
  await storage.close();
});

test("a stated-empty group renders the verbatim quote instead of 'none described'", async () => {
  const storage = await openTestOutbox();
  const quote = "there's no attic access at all";
  await parkedItem(storage, {}, { hvac: 0 }, { hvac: quote });

  const screen = await renderReviewPanel(storage);
  const group = screen.getByTestId("review-group-hvac");

  // The quote text should appear in the group's section.
  await expect.element(group.getByText(quote)).toBeInTheDocument();

  // The "Add one" button is still present — an auditor can still add an instance
  // if the stated-none turns out to be wrong.
  await expect.element(screen.getByTestId("add-instance-hvac")).toBeInTheDocument();

  await storage.close();
});

// ---- the review plan's sections on the rendered card -----------------------
//
// The demo plan (a partition of the hvac collection) gives the instance-level case; the other
// heading levels need plans the demo cannot produce, passed through the panel's prop. The
// top-level nest plan is hand-written because the Snugg schema has no top-level leaf to nest.

/** A partition of the singleton `basedata` group — sections inside a singleton group. */
const basedataPartitionPlan = deriveExtractionShape(snuggValuesSchema, {
  operations: [
    { op: "partition", group: "basedata", parts: { scope: ["yearBuilt", "conditionedArea"] } },
  ],
});

/** A regroup whose destination is two intermediates deep — a section inside a section. */
const nestedRegroupPlan = deriveExtractionShape(snuggValuesSchema, {
  operations: [
    { op: "regroup", group: "basedata", moves: { yearBuilt: "location.detail.yearBuilt" } },
  ],
});

/** A nest-shaped mapping: one moved leaf under a top-level section label. */
const topLevelNestPlan: ReviewPlan = {
  mapping: {
    leaves: { "renewables.yearBuilt": { source: "basedata.yearBuilt" } },
    provenance: {},
  },
  partitions: {},
};

const headingsOf = (container: { getByTestId: (id: string) => { elements: () => Element[] } }) =>
  container
    .getByTestId("review-section")
    .elements()
    .map((heading) => `${heading.tagName}:${heading.textContent}`);

test("the demo plan renders the hvac instance's sections as h5 headings in plan order, its fields in part order, each field once", async () => {
  const storage = await openTestOutbox();
  await parkedItem(storage, {});

  const screen = await renderReviewPanel(storage, demoReviewPlan);
  const instance = screen.getByTestId("review-instance-hvac[k1]");
  await expect.element(instance).toBeInTheDocument();

  // Sections in the plan's enumeration order, labels verbatim (never humanized —
  // these are the plan author's words, not schema keys), "Other" last.
  await vi.waitFor(() => {
    expect(headingsOf(instance)).toEqual(["H5:cooling", "H5:heating", "H5:Other"]);
  });

  // Fields in the part's declared order — which is deliberately NOT the schema's
  // declaration order (the schema puts cooling capacity before its manufacturer),
  // so this fails if the card ever renders schema order instead of plan order.
  const instanceElement = instance.element();
  if (!(instanceElement instanceof HTMLElement)) throw new Error("not an HTML element");
  const text = instanceElement.innerText;
  const manufacturerAt = text.indexOf("Hvac Cooling System Manufacturer");
  const capacityAt = text.indexOf("Hvac Cooling Capacity");
  expect(manufacturerAt).toBeGreaterThan(-1);
  expect(capacityAt).toBeGreaterThan(-1);
  expect(manufacturerAt).toBeLessThan(capacityAt);

  // Every hvac leaf rendered exactly once: no leaf dropped, none rendered twice.
  const hvacGroup = unwrapGroup(snuggValuesSchema.shape.hvac);
  if (!(hvacGroup instanceof z.ZodArray)) throw new Error("hvac is not an array schema");
  const hvacLeaves = hvacGroup.element as unknown as z.ZodObject;
  const rowPaths = instance
    .getByTestId(/^review-field-/)
    .elements()
    .map((row) => row.getAttribute("data-path"));
  expect(new Set(rowPaths).size).toBe(rowPaths.length);
  expect(rowPaths).toHaveLength(Object.keys(hvacLeaves.shape).length);

  await storage.close();
});

test("a section inside a singleton group renders one level under the group heading (h4)", async () => {
  const storage = await openTestOutbox();
  await parkedItem(storage, {});

  const screen = await renderReviewPanel(storage, basedataPartitionPlan);
  const instance = screen.getByTestId("review-instance-basedata");
  await expect.element(instance).toBeInTheDocument();

  await vi.waitFor(() => {
    expect(headingsOf(instance)).toEqual(["H4:scope", "H4:Other"]);
  });

  await storage.close();
});

test("a deeper intermediate section renders one level under its own section's heading", async () => {
  const storage = await openTestOutbox();
  await parkedItem(storage, {});

  const screen = await renderReviewPanel(storage, nestedRegroupPlan);
  const instance = screen.getByTestId("review-instance-basedata");
  await expect.element(instance).toBeInTheDocument();

  await vi.waitFor(() => {
    expect(headingsOf(instance)).toEqual(["H4:location", "H5:detail"]);
  });

  // The moved leaf sits beneath the deeper section, at its unchanged patch path.
  const detail = instance.getByTestId("review-section").elements()[1]!;
  const row = screen.getByTestId("review-field-basedata.yearBuilt").element();
  expect(detail.parentElement!.contains(row)).toBe(true);

  await storage.close();
});

test("a top-level section renders at group level (h3) after the schema's own groups", async () => {
  const storage = await openTestOutbox();
  await parkedItem(storage, {});

  const screen = await renderReviewPanel(storage, topLevelNestPlan);

  // Exactly one section: the plan's single moved entry, rendered as a top-level
  // section — no other group of the card is sectioned by this plan.
  await vi.waitFor(() => {
    expect(headingsOf(screen)).toEqual(["H3:renewables"]);
  });

  // The moved leaf renders beneath the section heading, at its unchanged path.
  const heading = screen.getByTestId("review-section").element();
  const row = screen.getByTestId("review-field-basedata.yearBuilt").element();
  expect(heading.parentElement!.contains(row)).toBe(true);

  await storage.close();
});

test("a section nested past h6 still renders a real heading — at h6, never an invalid h7", async () => {
  // Native heading elements end at h6, and the layout caps section nesting only
  // at the heading render, not in the tree: a plan is plain data, its chain of
  // intermediates can be arbitrarily deep, and every section below level 6 must
  // still take part in the document outline a screen reader navigates by. The
  // deepest level therefore repeats — an unclamped render would emit `h7`, an
  // element no browser treats as a heading.
  const deepNestPlan: ReviewPlan = {
    mapping: {
      leaves: {
        "shell.envelope.airsealing.results.summary.yearBuilt": { source: "basedata.yearBuilt" },
      },
      provenance: {},
    },
    partitions: {},
  };

  const storage = await openTestOutbox();
  await parkedItem(storage, {});

  const screen = await renderReviewPanel(storage, deepNestPlan);

  // Five intermediates: the first four nest normally (3, 4, 5, 6) and the fifth
  // repeats level 6. Nothing in the chain is dropped, and no level is skipped.
  await vi.waitFor(() => {
    expect(headingsOf(screen)).toEqual([
      "H3:shell",
      "H4:envelope",
      "H5:airsealing",
      "H6:results",
      "H6:summary",
    ]);
  });

  // The moved leaf still renders, beneath the deepest section.
  const deepest = screen.getByTestId("review-section").elements().at(-1)!;
  const row = screen.getByTestId("review-field-basedata.yearBuilt").element();
  expect(deepest.parentElement!.contains(row)).toBe(true);

  await storage.close();
});

test("the demo plan's sections render on every instance of the collection, not just the first", async () => {
  // The demo-plan pin above reads `hvac[k1]` only. The plan carries nothing
  // instance-specific — core re-sections every instance — so a render path that
  // branched on instance identity (or dropped children past the first) would
  // show a sectioned first system and a flat second one, and nothing so far
  // would have caught it.
  const storage = await openTestOutbox();
  await parkedItem(storage, {}, { hvac: 2 });

  const screen = await renderReviewPanel(storage, demoReviewPlan);
  const expected = ["H5:cooling", "H5:heating", "H5:Other"];
  await vi.waitFor(() => {
    expect(headingsOf(screen.getByTestId("review-instance-hvac[k1]"))).toEqual(expected);
    expect(headingsOf(screen.getByTestId("review-instance-hvac[k2]"))).toEqual(expected);
  });

  // Each instance still presents its own leaves exactly once — the sections
  // moved the outline, not the rows.
  const hvacGroup = unwrapGroup(snuggValuesSchema.shape.hvac);
  if (!(hvacGroup instanceof z.ZodArray)) throw new Error("hvac is not an array schema");
  const hvacLeaves = hvacGroup.element as unknown as z.ZodObject;
  for (const key of ["k1", "k2"]) {
    const rows = screen
      .getByTestId(`review-instance-hvac[${key}]`)
      .getByTestId(/^review-field-/)
      .elements()
      .map((row) => row.getAttribute("data-path"));
    expect(new Set(rows).size).toBe(rows.length);
    expect(rows).toHaveLength(Object.keys(hvacLeaves.shape).length);
  }

  await storage.close();
});

test("a plan partitioning two groups at once lays both outlines out on the same card", async () => {
  // Every existing render pin uses a plan that touches exactly one group; a
  // host's plan is not so constrained. Two partitions in one derived shape put
  // sections inside a collection instance AND inside a singleton group on one
  // card — each container sectioned by its own record, neither leaking into
  // the other.
  const bothGroupsPlan = deriveExtractionShape(snuggValuesSchema, {
    operations: [
      {
        op: "partition",
        group: "hvac",
        parts: { cooling: ["hvacCoolingSystemManufacturer"], heating: ["hvacHeatingEnergySource"] },
      },
      { op: "partition", group: "basedata", parts: { scope: ["yearBuilt", "conditionedArea"] } },
    ],
  });

  const storage = await openTestOutbox();
  await parkedItem(storage, {});

  const screen = await renderReviewPanel(storage, bothGroupsPlan);

  await vi.waitFor(() => {
    expect(headingsOf(screen.getByTestId("review-instance-hvac[k1]"))).toEqual([
      "H5:cooling",
      "H5:heating",
      "H5:Other",
    ]);
    expect(headingsOf(screen.getByTestId("review-instance-basedata"))).toEqual([
      "H4:scope",
      "H4:Other",
    ]);
  });

  await storage.close();
});

test("adding an instance to a partitioned collection presents the plan's sections on the added instance", async () => {
  // The add affordance mutates the extraction snapshot and rebuilds the request
  // — the one path where the tree is re-laid out from data the reviewer changed.
  // The instance it creates must come back sectioned like any other, not flat.
  const storage = await openTestOutbox();
  await parkedItem(storage, {}, { hvac: 0 });

  const screen = await renderReviewPanel(storage, demoReviewPlan);
  await screen.getByTestId("add-instance-hvac").click();

  const instance = screen.getByTestId("review-instance-hvac[k1]");
  await vi.waitFor(() => {
    expect(headingsOf(instance)).toEqual(["H5:cooling", "H5:heating", "H5:Other"]);
  });

  await storage.close();
});

test("a plan that places a bare leaf at the top level renders it as a row, with no add affordance to click", async () => {
  // A mapping entry whose extraction path has a single segment places its leaf
  // directly at the tree's top level — core pins the shape as deliberate
  // (placementChain's empty-chain boundary), and the layout reads a hand-written
  // plan as data, so this reaches the card through the panel's own prop. The
  // panel's card-entry walk treats a top-level leaf as a resource group, whose
  // rendered form carries an "Add another" affordance — but a leaf is not a
  // collection, can never gain an instance, and the hook refuses the call the
  // button would make. An affordance that throws on every click is not an
  // affordance; the card must not offer one for a leaf.
  const topLevelLeafPlan: ReviewPlan = {
    mapping: { leaves: { yearBuilt: { source: "basedata.yearBuilt" } }, provenance: {} },
    partitions: {},
  };

  const storage = await openTestOutbox();
  await parkedItem(storage, {});

  const screen = await renderReviewPanel(storage, topLevelLeafPlan);

  // The moved leaf renders exactly once, at its unchanged patch path.
  await vi.waitFor(() => {
    const rows = screen.getByTestId(/^review-field-basedata\.yearBuilt$/).elements();
    expect(rows).toHaveLength(1);
  });

  // …and the card renders no add-instance affordance for it.
  await expect.element(screen.getByTestId("add-instance-yearBuilt")).not.toBeInTheDocument();

  await storage.close();
});

test("a singleton group renders no add-instance affordance — only a collection can gain an instance", async () => {
  // The leaf case above is one site of the class; singleton OBJECT groups were
  // the other, older one: `basedata` rendered "Add another" whose click the
  // hook refuses (a plain object group cannot gain an instance). The affordance
  // is collection-gated now — pinned at this second site so the class cannot
  // quietly return for the groups every no-plan card renders.
  const storage = await openTestOutbox();
  await parkedItem(storage, {});

  const screen = await renderReviewPanel(storage, demoReviewPlan);

  await expect.element(screen.getByTestId("review-group-basedata")).toBeInTheDocument();
  await expect.element(screen.getByTestId("add-instance-basedata")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("add-instance-hvac")).toBeInTheDocument();

  await storage.close();
});

test("the affordance on a populated collection still adds a sectioned instance", async () => {
  // The other edge of the collection gate: the populated branch's "Add another"
  // is the only affordance no test had ever clicked — the empty-collection test
  // clicks "Add one", the pins above only assert presence. A gate or handler
  // broken on this branch would strand the auditor who wants a second system
  // on a card that already has one, with nothing anywhere going red.
  const storage = await openTestOutbox();
  await parkedItem(storage, {}, { hvac: 1 });

  const screen = await renderReviewPanel(storage, demoReviewPlan);
  await expect.element(screen.getByTestId("review-instance-hvac[k1]")).toBeInTheDocument();

  await screen.getByTestId("add-instance-hvac").click();

  const added = screen.getByTestId("review-instance-hvac[k2]");
  await vi.waitFor(() => {
    expect(added).toBeInTheDocument();
    // The instance the affordance created is sectioned like any other — the
    // plan re-lays out the tree the click rebuilt.
    expect(headingsOf(added)).toEqual(["H5:cooling", "H5:heating", "H5:Other"]);
  });

  await storage.close();
});
