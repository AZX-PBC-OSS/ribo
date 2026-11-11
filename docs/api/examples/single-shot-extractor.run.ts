/**
 * The runnable example behind docs/api/single-shot-extractor.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: the transport is `scriptedChat`.
 */

import assert from "node:assert/strict";
import { z } from "zod";
import {
  enveloped,
  type Extractor,
  type ExtractionTarget,
  parseWithSchema,
  SchemaParseError,
  type ScriptedChatReply,
  scriptedChat,
  singleShotExtractor,
  TerminalError,
} from "@azx/ribo-core";

// The patch — the plain-values shape a host writes back. `enveloped()` derives
// the extraction schema from it: every leaf wrapped in the provenance envelope.
const patch = z.object({ name: z.string() });
const extractionSchema = enveloped(patch);
type Fields = z.infer<typeof extractionSchema>;

const target: ExtractionTarget<{ name: string }> = {
  name: "contact",
  extractionSchema,
  instructions: "Extract the caller's name.",
};

const transcript = { text: "Caller is Acme Heating", annotations: {} } as const;

const goodContent = (): object => ({
  name: { value: "Acme Heating", confidence: 0.9, sourceSpan: "Acme Heating" },
});

function goodReply(): ScriptedChatReply {
  return { content: goodContent() };
}

export async function oneStructuredCallTurnsATranscriptIntoEnvelopedFields(): Promise<void> {
  // #region usage
  const chat = scriptedChat(goodReply());
  const extractor: Extractor<Fields> = singleShotExtractor({
    target,
    chat,
    model: "fake-mini",
  });
  const result = await extractor.extract(transcript);
  // #endregion usage

  assert.equal(result.fields.name.value, "Acme Heating");
  assert.equal(result.fields.name.sourceSpan, "Acme Heating");
  // One call, counted — including retries on the strategies that retry.
  assert.equal(result.usage.calls, 1);
  // The raw model output travels with the result, for provenance and debugging.
  assert.deepEqual(result.raw, goodContent());
}

export async function theRequestPinsTheSchemaOnTheTransport(): Promise<void> {
  const chat = scriptedChat(goodReply());
  const extractor = singleShotExtractor({ target, chat, model: "fake-mini" });
  await extractor.extract(transcript);

  const request = chat.calls[0];
  assert.ok(request);
  assert.equal(request.model, "fake-mini");
  // Structured output, strict: the endpoint rejects a response that omits a key
  // or adds one. The target's name IS the json_schema name.
  assert.equal(request.responseFormat.type, "json_schema");
  assert.equal(request.responseFormat.json_schema.name, "contact");
  assert.equal(request.responseFormat.json_schema.strict, true);
}

export async function aTruncatedResponseIsTerminalNotAParseError(): Promise<void> {
  const chat = scriptedChat({
    content: { name: { value: "Acme Heating", confidence: 0.9, sourceSpan: "Acme" } },
    finishReason: "length",
  });
  const extractor = singleShotExtractor({ target, chat, model: "fake-mini" });

  // Checked BEFORE the parse: a truncated response would otherwise misreport as
  // invalid JSON. TerminalError is what the queue never retries.
  await assert.rejects(extractor.extract(transcript), (error: unknown) => {
    assert.ok(error instanceof TerminalError);
    assert.match(error.message, /finishReason "length"/);
    return true;
  });
}

export async function aSchemaViolationIsRetryableAndRecognisable(): Promise<void> {
  // Valid JSON that violates the schema — the model answered, wrongly.
  const chat = scriptedChat({ content: { wrong: "shape" } });
  const extractor = singleShotExtractor({ target, chat, model: "fake-mini" });

  await assert.rejects(extractor.extract(transcript), (error: unknown) => {
    assert.ok(error instanceof SchemaParseError);
    // Stays retryable, and a strategy ladder recognises it and falls through
    // to a different shape.
    return true;
  });
}

// #region defaults
export async function theDefaultsThePageStatesComeFromTheSource(): Promise<void> {
  // `normalize` defaults to identity — observable: the fields come back exactly
  // as the schema parsed them. `fieldDescriptions` defaults to `"schema"` (the
  // descriptions ride `responseFormat`, not the prompt) — read from
  // packages/ribo-core/src/extraction/field-guidance.ts, not retyped here.
  // `maxTokens` is capped only when the caller passes one.
  const chat = scriptedChat(goodReply());
  const extractor = singleShotExtractor({ target, chat, model: "fake-mini" });
  const result = await extractor.extract(transcript);

  const parsed = parseWithSchema(extractionSchema, goodContent(), "example");
  assert.deepEqual(result.fields, parsed);
  assert.equal(chat.calls[0]?.maxTokens, undefined);
}
// #endregion defaults
