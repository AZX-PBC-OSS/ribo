/**
 * The runnable example behind docs/api/grouped-extractor.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: every group runs on `scriptedChat`.
 */

import assert from "node:assert/strict";
import { z } from "zod";
import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  enveloped,
  type ExtractionTarget,
  groupedExtractor,
  PER_CALL_CEILING_MS,
  type ScriptedChatResponder,
  scriptedChat,
  singleShotExtractor,
  TerminalError,
  UNWRAPPED_KEY,
} from "@azx/ribo-core";

// The patch: two top-level keys, one group each.
const extractionSchema = enveloped(z.object({ name: z.string(), notes: z.string() }));
// Annotated so `V` is read off the patch type, not inferred against a mapped type.
const wholeTarget: ExtractionTarget<{ name: string; notes: string }> = {
  name: "contact",
  extractionSchema,
  instructions: "Extract the caller's details.",
};

const transcript = { text: "Caller is Acme Heating. Furnace noted.", annotations: {} } as const;

const envelope = (value: string, span: string) => ({
  value,
  confidence: 0.9,
  sourceSpan: span,
});

// A per-group target: the group's own key, enveloped, projected to that key.
const nameTarget: ExtractionTarget<{ name: string }> = {
  name: "contact-name",
  extractionSchema: enveloped(z.object({ name: z.string() })),
  instructions: "Extract the caller's name.",
};
const notesTarget: ExtractionTarget<{ notes: string }> = {
  name: "contact-notes",
  extractionSchema: enveloped(z.object({ notes: z.string() })),
  instructions: "Extract the notes.",
};

const nameGroup = (respond: ScriptedChatResponder) =>
  singleShotExtractor({ target: nameTarget, chat: scriptedChat(respond), model: "fake-mini" });
const notesGroup = (respond: ScriptedChatResponder) =>
  singleShotExtractor({ target: notesTarget, chat: scriptedChat(respond), model: "fake-mini" });

export async function groupsRunConcurrentlyAndMergeIntoOneResult(): Promise<void> {
  // #region usage
  const extractor = groupedExtractor({
    target: wholeTarget,
    groups: {
      name: nameGroup({ content: { name: envelope("Acme Heating", "Acme Heating") } }),
      notes: notesGroup({ content: { notes: envelope("Furnace noted", "Furnace noted") } }),
    },
    delay: async () => undefined,
  });
  const result = await extractor.extract(transcript);
  // #endregion usage

  // Merged by key, then parsed as a whole against the full extraction schema —
  // the second trust boundary.
  assert.equal(result.fields.name.value, "Acme Heating");
  assert.equal(result.fields.notes.value, "Furnace noted");
  // Usage sums what the entries reported — one call each.
  assert.equal(result.usage.calls, 2);
}

export async function aTransientGroupFailureIsRetriedWithinTheDefaultBudget(): Promise<void> {
  let nameCalls = 0;
  const extractor = groupedExtractor({
    target: wholeTarget,
    groups: {
      // The default maxRetries is 2 — total attempts per entry is 3 — so a
      // group that fails twice and succeeds on the third attempt succeeds.
      // Observed here against the default, not retyped.
      name: nameGroup((_request, context) => {
        nameCalls += 1;
        if (context.call < 2) throw new Error("transient blip");
        return { content: { name: envelope("Acme Heating", "Acme Heating") } };
      }),
      notes: notesGroup({ content: { notes: envelope("Furnace noted", "Furnace noted") } }),
    },
    delay: async () => undefined,
  });

  const result = await extractor.extract(transcript);
  assert.equal(result.fields.name.value, "Acme Heating");
  assert.equal(nameCalls, 3);
  // The combinator sums what the entries REPORT: the failed attempts threw, so
  // their calls were never reported — a failed attempt's calls are the entry's
  // own business, visible through its events, not in this total.
  assert.equal(result.usage.calls, 2);
}

export async function aTerminalGroupFailureIsNeverRetried(): Promise<void> {
  const extractor = groupedExtractor({
    target: wholeTarget,
    groups: {
      // finishReason "length" classifies terminal before anything else runs —
      // re-sending an identical request reproduces it.
      name: nameGroup({
        content: { name: envelope("Acme Heating", "Acme Heating") },
        finishReason: "length",
      }),
      notes: notesGroup({ content: { notes: envelope("Furnace noted", "Furnace noted") } }),
    },
    delay: async () => undefined,
  });

  await assert.rejects(extractor.extract(transcript), (error: unknown) => {
    assert.ok(error instanceof TerminalError);
    return true;
  });
}

export async function coverageIsCheckedAtConstruction(): Promise<void> {
  // A missing group is a compile error for a TS caller (the map is exhaustive
  // over the schema's keys) — and thrown with the key named for a JS caller.
  assert.throws(
    () =>
      groupedExtractor({
        target: {
          name: "contact",
          extractionSchema,
          instructions: "Extract the caller's details.",
        },
        groups: {
          name: nameGroup({ content: { name: envelope("Acme Heating", "Acme Heating") } }),
        },
        delay: async () => undefined,
      }),
    /missing top-level key/,
  );
}

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // Exported constants the page quotes — a source change that moved one of
  // these fails here.
  assert.equal(PER_CALL_CEILING_MS, 120_000);
  assert.equal(DEFAULT_BACKOFF_BASE_MS, 1_000);
  assert.equal(DEFAULT_BACKOFF_CAP_MS, 300_000);
  // The unwrapped portion's read-side key. It can never collide with a schema
  // property: the review leaf-path grammar refuses an empty key. Callers never
  // spell it — the portion is declared with the `unwrapped` option.
  assert.equal(UNWRAPPED_KEY, "");

  // concurrency (4), maxRetries (2) and stepTimeoutMs (900_000) are not
  // exported: the retry test above observes maxRetries against the default,
  // and the page cites packages/ribo-core/src/extraction/grouped-extractor.ts
  // for the rest.
}
// #endregion defaults
