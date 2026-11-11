# singleShotExtractor

`singleShotExtractor` builds one [`Extractor`](/api/extractor) that turns a transcript into
enveloped fields in a single structured-output chat call: assemble the prompt from the target,
pin the output to the target's `extractionSchema` with `strict: true`, then cross the trust
boundary — parse the response with that same schema — before it becomes field data. `SingleShotOptions`
lives here too.

## When to reach for it

Reach for it as the built default for a schema that fits one call. Reach for the
[Extraction guide](/guide/extraction) for the flow it sits in, and
[Schema at Scale](/guide/schema-at-scale) for when one call stops fitting and the schema has to be
partitioned across groups.

## Usage

Every example below runs on `scriptedChat` — no credentials, no network; the page's example file
shows the construction, and the chat transport underneath is swappable.

<<< @/api/examples/single-shot-extractor.run.ts#usage

The target is an `ExtractionTarget` — the same bundle a `ToolAdapter` supplies, so a real host
wires its adapter straight in rather than building a target literal. The schema the model is
pinned to is the **enveloped** shape (`Enveloped<V, P>`), not the plain values: provenance is part
of what the model emits, not a layer added after.

## Options

`singleShotExtractor(options)` takes `SingleShotOptions`. The defaults the page states are quoted
from the example file rather than retyped, and the same file's test run asserts them — so a source
change that moves one fails the `test` stage:

<<< @/api/examples/single-shot-extractor.run.ts#defaults

| Name                | Type                                           | Default      | What it does                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`            | `ExtractionTarget<V, P>`                       | **required** | The field knowledge: `name`, `extractionSchema`, `instructions`, and few-shot `examples`. The target's name IS the request's `json_schema.name` — guarded at construction, where the schema author is present.                                            |
| `chat`              | `ChatClient`                                   | **required** | The injected chat transport — a fake in tests, [`openAiChat`](/api/chat-transports) in production.                                                                                                                                                        |
| `model`             | `string`                                       | **required** | The model id passed through to the endpoint.                                                                                                                                                                                                              |
| `maxTokens`         | `number`                                       | —            | Cap on generated tokens, passed through to `ChatRequest.maxTokens` and validated there. Transport configuration lives on the extractor, not the adapter — a token budget is inference configuration.                                                      |
| `normalize`         | `(fields: Enveloped<V, P>) => Enveloped<V, P>` | identity     | The deterministic, model-free pass run AFTER the schema parse. Defaults to identity so the extractor stays generic (above); a real adapter whose normalization is only expressible on the enveloped shape must pass its own.                              |
| `fieldDescriptions` | `"schema" \| "prompt"`                         | `"schema"`   | Where the schema's field descriptions travel. `"schema"` keeps them in `responseFormat`; `"prompt"` strips them from the wire rendering and carries the same text in the system message, for a route whose cap is on the schema rather than the messages. |
| `onUnit`            | observer                                       | —            | One `extract()` emits exactly one `WholeUnit` — `start`, then `done` or `error`. There is no retry loop here, so `attempt` is always 1, and that is the honest report.                                                                                    |

Defaults are read from `packages/ribo-core/src/extraction/single-shot.ts` and
`packages/ribo-core/src/extraction/field-guidance.ts`.

## Return value

`singleShotExtractor` returns an `Extractor<Enveloped<V, P>>`. On each `extract`:

1. One chat call with `responseFormat: json_schema`, strict.
2. **Pre-parse check** — a `finishReason` that is not `"stop"` rejects immediately: a truncated or
   content-filtered response is not a complete result, and letting it reach the zod parse would
   misreport it as "invalid JSON". The `"length"` message names `maxTokens`, the knob that fixes it.
3. **Trust boundary** — parse the response with `target.extractionSchema`, then run `normalize`.

The result's `usage.calls` is 1 on success — there is no retry loop here — and `raw` carries the
model's parsed output for provenance.

## Errors

- A non-`stop` finish reason throws `TerminalError` — the queue never retries it, and no
  configuration change inside the request would help.
- A response that is not JSON throws a plain `Error` — transient, so the queue retries.
- A response that parses but violates the schema throws `SchemaParseError` — retryable and
  recognisable, so a strategy ladder can fall through to a different shape.
- A target name that cannot serve as a `json_schema.name` throws at construction, before any call
  is paid for.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every `test`
run, ending in assertions on exactly what this page claims — including the defaults quoted under
Options.

<<< @/api/examples/single-shot-extractor.run.ts

## Related APIs

- [`ChatClient` and chat transports](/api/chat-transports) — what `chat` speaks.
- [`Extractor`](/api/extractor) — the seam this implements, and the options bag `extract` takes.
- [Test doubles](/api/test-doubles) — the fakes; `scriptedChat` is the chat-side double.

## Guides that use it

- [Extraction](/guide/extraction) — the strategy the guide's flow uses once a real model is wired.
- [Quick Start](/guide/quick-start) — the same single-shot construction, worked end to end.

## Reference

- [`singleShotExtractor`](/reference/@azx/ribo-core/functions/singleShotExtractor.html)
- [`SingleShotOptions`](/reference/@azx/ribo-core/interfaces/SingleShotOptions.html)
- [`ExtractionTarget`](/reference/@azx/ribo-core/type-aliases/ExtractionTarget.html)
