/**
 * The runnable example behind docs/api/extractor.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: the extractor is a `FakeExtractor`.
 */

import assert from "node:assert/strict";
import {
  type AnnotatedTranscript,
  type Extractor,
  FakeExtractor,
  toSessionExtractStep,
} from "@azx/ribo-core";

// A type alias, not an interface: `Extractor<F>` requires F to carry an index
// signature, and only a type alias gets the implicit one.
type ContactFields = {
  name: { value: string; confidence: number; sourceSpan: string };
};

function transcript(): AnnotatedTranscript {
  return { text: "Caller is Acme Heating, spoke to Sam", annotations: {} };
}

export async function anExtractorTurnsATranscriptIntoParsedFields(): Promise<void> {
  // #region usage
  const extractor: Extractor<ContactFields> = new FakeExtractor<ContactFields>({
    name: { value: "Acme Heating", confidence: 0.9, sourceSpan: "Acme Heating" },
  });
  const result = await extractor.extract(transcript());
  // #endregion usage

  assert.equal(result.fields.name.value, "Acme Heating");
  assert.equal(result.fields.name.sourceSpan, "Acme Heating");
  // The usage a fake reports by default: no model calls, nothing else — every
  // other member is optional because an extractor that cannot report it must
  // not be forced to invent it.
  assert.deepEqual(result.usage, { calls: 0 });
}

export async function theFakeRecordsEveryCallAndForwardsTheOptionsBag(): Promise<void> {
  const extractor = new FakeExtractor<ContactFields>({
    name: { value: "Acme Heating", confidence: 0.9, sourceSpan: "Acme Heating" },
  });
  const controller = new AbortController();
  const options = { signal: controller.signal, deadline: Date.now() + 60_000 } as const;

  await extractor.extract(transcript(), options);
  await extractor.extract({ text: "second call", annotations: {} }, undefined);

  // `calls` and `callOptions` are positionally matched, so a combinator test can
  // assert the options bag actually reached the candidate — a dropped forward
  // would otherwise be invisible (the parameter is optional).
  assert.equal(extractor.calls.length, 2);
  assert.equal(extractor.calls[0]?.text, "Caller is Acme Heating, spoke to Sam");
  assert.equal(extractor.callOptions[0], options);
  assert.equal(extractor.callOptions[1], undefined);
}

export async function toSessionExtractStepWiresAnExtractorIntoTheRelay(): Promise<void> {
  const extractor = new FakeExtractor<ContactFields>({
    name: { value: "Acme Heating", confidence: 0.9, sourceSpan: "Acme Heating" },
  });

  // The relay speaks `SessionExtractStep`; the strategy speaks `Extractor`.
  // This one-line adapter is the whole wiring — no relay change.
  const step = toSessionExtractStep(extractor);
  const stepResult = await step({
    session: sessionRow(),
    transcript: transcript(),
    recordingIds: ["cap-1"],
  });

  // `raw` stays with the extractor (unbounded model output, not session data);
  // everything else reaches the session document.
  const typed = stepResult.fields as unknown as ContactFields;
  assert.equal(typed.name.value, "Acme Heating");
  assert.equal(stepResult.engine, undefined);
  assert.deepEqual(stepResult.usage, { calls: 0 });
}

function sessionRow(): Parameters<ReturnType<typeof toSessionExtractStep>>[0]["session"] {
  return {
    id: "sess-1",
    status: "extracting",
    openedAt: new Date().toISOString(),
    closedAt: undefined,
    ctx: {},
    ref: "audit-42",
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
    idempotencyKey: "idem-1",
  } as never;
}

// #region defaults
export async function theDefaultsThePageStatesComeFromTheSource(): Promise<void> {
  // The default usage of a FakeExtractor with no options, read from
  // packages/ribo-core/src/extraction/extractor.ts. The page quotes this value
  // in prose next to this region; a source change that moved it fails here.
  const extractor = new FakeExtractor({
    name: { value: "Acme", confidence: 0.9, sourceSpan: "Acme" },
  });
  const result = await extractor.extract(transcript());
  assert.deepEqual(result.usage, { calls: 0 });
}
// #endregion defaults
