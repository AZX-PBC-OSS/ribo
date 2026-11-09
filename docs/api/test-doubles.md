# Test doubles

Three shipped doubles make the whole pipeline drivable with no credentials and no network:
`FakeExtractor` returns fixed fields instead of calling a model, `FakeTranscriber` simulates an
engine's capability states and all three failure kinds, and
[`scriptedChat`](/api/chat-transports) stands in for the chat transport underneath the chat-based
strategies. They are shipped, documented API — not test scaffolding.

## When to reach for it

Reach for this page when writing consumer tests or examples: substitute a double into the queue
and nothing above it changes. Reach for the [Extraction guide](/guide/extraction) for the flow the
fakes slot into, and [Captures & Sources](/guide/captures-and-sources) for the transcription side.

## Usage

<<< @/api/examples/test-doubles.run.ts#usage

## Options

`FakeExtractor(fields, options?)` takes `FakeExtractorOptions`; `FakeTranscriber(options?)` takes
`FakeTranscriberOptions`. The defaults the page states are quoted from the example file rather
than retyped, and the same file's test run asserts them — `FakeTranscriber`'s text default against
the exported constant, so a source change that moves it fails the `test` stage:

<<< @/api/examples/test-doubles.run.ts#defaults

| Name     | Double            | Type              | Default                                | What it does                                                                                                                    |
| -------- | ----------------- | ----------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `raw`    | `FakeExtractor`   | `unknown`         | —                                      | Raw payload echoed back on the result. Omitted from the result when unset.                                                      |
| `usage`  | `FakeExtractor`   | `ExtractionUsage` | `{ calls: 0 }` (above)                 | What the fake reports — a fake makes no model calls.                                                                            |
| `engine` | `FakeTranscriber` | `string`          | `"fake"`                               | The engine id stamped on transcripts. Override it when the double stands in for a real engine and the id ends up in provenance. |
| `text`   | `FakeTranscriber` | `string`          | `DEFAULT_FAKE_TRANSCRIPT_TEXT` (above) | The transcript text every `transcribe()` returns until `setResponse` changes it.                                                |

Defaults are read from `packages/ribo-core/src/extraction/extractor.ts` and
`packages/ribo-core/src/transcription/fake-transcriber.ts`.

## Return value

`FakeExtractor.extract()` resolves to an `ExtractionResult` carrying the fixed fields and the
configured usage. It records every `extract()` call and its options bag, positionally matched
(`calls`, `callOptions`), so a combinator test can assert the signal actually reached the
candidate — the parameter is optional, so a dropped forward would otherwise be invisible.

`FakeTranscriber.transcribe()` resolves to a `Transcript` stamped with the configured engine and
text; `capability()` reports what `setCapability` last set. The inspection surface mirrors the
extractor's: `calls` and `callOptions` record every attempt.

## Errors

The doubles model the real seams' failure vocabulary, not their own:

- `FakeTranscriber.failWith(error)` — an ordinary **attempt** failure: thrown as-is, so the queue
  owns retry and backoff.
- `FakeTranscriber.failWithUnavailable(reason, detail)` — a **capability** failure: throws
  `TranscriberUnavailableError`, deliberately not terminal, the way a real engine's failed runtime
  init behaves.
- `FakeTranscriber.failWithUnsupported(reason, detail)` — an **item unsuitability**: throws
  `UnsupportedItemError`, terminal for the queue but not for the item.
- `scriptedChat`'s responder throws to fail a call — a thrown `ChatError` reaches arbitration
  unchanged, exactly as a real transport's would.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every `test`
run, ending in assertions on exactly what this page claims — including the defaults quoted under
Options.

<<< @/api/examples/test-doubles.run.ts

## Related APIs

- [`ChatClient` and chat transports](/api/chat-transports) — `scriptedChat`, the chat-side double
  this page cross-links for the chat-based strategies.
- [`Transcriber`](/api/transcriber) — the seam `FakeTranscriber` implements, and the three failure
  kinds it simulates.
- [`Extractor`](/api/extractor) — the seam `FakeExtractor` implements.

## Guides that use it

- [Extraction](/guide/extraction) — the fake that drives the guide's flow with no model.
- [Quick Start](/guide/quick-start) — runs end to end on these doubles.

## Reference

- [`FakeExtractor`](/reference/@azx/ribo-core/classes/FakeExtractor.html)
- [`FakeExtractorOptions`](/reference/@azx/ribo-core/interfaces/FakeExtractorOptions.html)
- [`FakeTranscriber`](/reference/@azx/ribo-core/classes/FakeTranscriber.html)
- [`FakeTranscriberOptions`](/reference/@azx/ribo-core/interfaces/FakeTranscriberOptions.html)
- [`DEFAULT_FAKE_TRANSCRIPT_TEXT`](/reference/@azx/ribo-core/variables/DEFAULT_FAKE_TRANSCRIPT_TEXT.html)
- [`scriptedChat`](/reference/@azx/ribo-core/functions/scriptedChat.html)
