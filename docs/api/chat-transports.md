# ChatClient and chat transports

`ChatClient` is the chat-transport seam — a thin, provider-agnostic interface an extractor calls to
reach a chat-completions model: one `complete()` method, no streaming, no tools, no temperature
knobs. The transports implement it (`openAiChat`, `helixChat`, `OnDeviceChat`); the extractors own
prompt assembly and the trust boundary and never touch the network directly. `ChatError`,
`ChatCapability`, `CapableChatClient`, the `Chat*` request/response types, and the `scriptedChat`
double live here too.

## When to reach for it

Reach for this page to pick a transport or to implement one; reach for
[`singleShotExtractor`](/api/single-shot-extractor) for what speaks the seam; reach for the
[Extraction guide](/guide/extraction) for where transports sit in the flow. No transport can
authenticate: every credential, base URL and `fetch` is injected by the host, so the packages have
no capacity to hold a secret.

## Usage

The example file drives everything credential-free: the double, and the real transports against
injected fake `fetch` implementations.

<<< @/api/examples/chat-transports.run.ts#usage

## Options

The two real transports take option objects of their own; the double takes `ScriptedChatOptions`.
The defaults this page states belong to `scriptedChat` and are quoted from the example file rather
than retyped — its test run observes them, so a source change that moves one fails the `test`
stage:

<<< @/api/examples/chat-transports.run.ts#defaults

| Name            | Transport      | Type                 | Default                             | What it does                                                                                                                                                                                                                    |
| --------------- | -------------- | -------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`        | `openAiChat`   | `string`             | **required**                        | Bearer token, injected by the host — never read from a bundled constant.                                                                                                                                                        |
| `baseUrl`       | `openAiChat`   | `string`             | **required**                        | Base URL of an OpenAI-compatible API, without the trailing `/chat/completions`.                                                                                                                                                 |
| `fetchImpl`     | `openAiChat`   | `typeof fetch`       | the global `fetch`                  | Override for tests — what makes this page's example credential-free.                                                                                                                                                            |
| `token`         | `helixChat`    | `string`             | —                                   | Optional bearer token: a deployed Helix app authenticates with its session cookie, and when this is absent no `authorization` header is sent at all (never a placeholder `Bearer`).                                             |
| `baseUrl`       | `helixChat`    | `string`             | **required**                        | Base URL of the Helix gateway, without the trailing `/_api/llm/chat`; `""` for same-origin in a deployed app.                                                                                                                   |
| `origin`        | `helixChat`    | `string`             | —                                   | The `Origin` header value the dev gateway checks against the token's registered origins.                                                                                                                                        |
| `connectivity`  | `helixChat`    | `ConnectivitySource` | —                                   | Live connectivity model. When present, capability is derived from its subscription — not a snapshot at construction — so a dead uplink is recognised as soon as the model does. When absent, the managed path is assumed ready. |
| `fetchImpl`     | `helixChat`    | `typeof fetch`       | the global `fetch`                  | Override for tests.                                                                                                                                                                                                             |
| `languageModel` | `OnDeviceChat` | `LanguageModel`      | **required**                        | The Chrome Prompt API `LanguageModel` object, usually `globalThis.ai.languageModel`.                                                                                                                                            |
| `deadlineMs`    | `OnDeviceChat` | `number`             | `DEFAULT_DEVICE_PROMPT_DEADLINE_MS` | Hard deadline for one `complete()` call, independent of the caller's signal. Read from `packages/ribo-extractor-ondevice/src/ondevice-chat.ts`; not asserted here — the on-device path has no node form.                        |
| `engine`        | `scriptedChat` | `string`             | `"scripted"` (above)                | The engine id the double reports — override it when the id ends up in extraction provenance.                                                                                                                                    |
| `capability`    | `scriptedChat` | `ChatCapability`     | `{ status: "ready" }` (above)       | What `capability()` reports until `setCapability` changes it.                                                                                                                                                                   |

Defaults are read from `packages/ribo-chat-openai/src/openai-chat.ts`,
`packages/ribo-chat-helix/src/helix-chat.ts`,
`packages/ribo-extractor-ondevice/src/ondevice-chat.ts` and
`packages/ribo-core/src/phases/scripted-chat.ts`.

## Return value

`complete(request, options?)` resolves to a `ChatCompletion`: the assistant message `content` (the
JSON string a structured-output call was constrained to emit), plus `finishReason` and `usage` when
the transport reports them. `finishReason` is optional on the type, but the real transports always
populate it — a response whose finish reason is missing or unknown is a `ChatError` of kind
`malformed-response`, never a completion with the field left off. `usage`'s cache counts keep the
absent/zero distinction: absent means "not reported", never "zero".

`ChatRequest` is the smallest slice that supports single-shot structured extraction: `model`, an
ordered list of role-tagged `messages`, `response_format` pinning output to a JSON Schema with
`strict: true`, and an optional `maxTokens` — camelCase deliberately, because the wire spelling
depends on the model and the implementation owns it.

`helixChat` and `OnDeviceChat` return a `CapableChatClient` — a `ChatClient` that also reports
`engine` and `capability()`, three states rather than a boolean because `needs-download` and
`unavailable` produce completely different screens.

## Errors

Every transport failure is a `ChatError` — one class with a `kind` discriminant rather than
subclasses, constructed through static factories so `status` is present exactly when
`kind === "http"`:

- `"transport"` — fetch rejected; no response arrived at all.
- `"http"` — a response arrived with a non-2xx `status`.
- `"aborted"` — the caller's signal fired. Branded as cancellation, so a combinator anywhere can
  recognise "the caller stopped this" without importing a transport's error type.
- `"malformed-response"` — a response arrived but is not a usable completion.
- `"refusal"` — the model declined; a well-formed response in which it refused.
- `"unsupported"` — this client cannot honour something the request asked for.

A thrown `ChatError` reaches arbitration unchanged — a scripted double that throws one behaves,
for arbitration's purposes, exactly like a real transport's failure.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every `test`
run, ending in assertions on exactly what this page claims — including the defaults quoted under
Options. The page states plainly: the real transports are shown for construction and error mapping
against fake `fetch` implementations, while the double is what the other pages' examples drive.

<<< @/api/examples/chat-transports.run.ts

The on-device transport's construction is **type-checked only**: `OnDeviceChat` wraps Chrome's
Prompt API, which exists only in a browser.

<<< @/api/examples/ondevice-chat.ts

## Related APIs

- [`singleShotExtractor`](/api/single-shot-extractor) — the built strategy over this seam.
- [Test doubles](/api/test-doubles) — `scriptedChat`'s siblings for the other seams.
- [`Transcriber`](/api/transcriber) — the sibling seam for audio; `ChatCapability` mirrors
  `TranscriberCapability` with one intentional difference: `needs-download` carries no byte count,
  because the on-device model API reports progress as a 0..1 fraction and inventing a number would
  make the consent screen dishonest.

## Guides that use it

- [Extraction](/guide/extraction) — where the transports sit under the extraction strategies.

## Reference

- [`ChatClient`](/reference/@azx/ribo-core/interfaces/ChatClient.html)
- [`CapableChatClient`](/reference/@azx/ribo-core/interfaces/CapableChatClient.html)
- [`ChatRequest`](/reference/@azx/ribo-core/interfaces/ChatRequest.html)
- [`ChatCompletion`](/reference/@azx/ribo-core/interfaces/ChatCompletion.html)
- [`ChatCapability`](/reference/@azx/ribo-core/type-aliases/ChatCapability.html)
- [`ChatError`](/reference/@azx/ribo-core/classes/ChatError.html)
- [`scriptedChat`](/reference/@azx/ribo-core/functions/scriptedChat.html)
- [`openAiChat`](/reference/@azx/ribo-chat-openai/functions/openAiChat.html)
- [`helixChat`](/reference/@azx/ribo-chat-helix/functions/helixChat.html)
- [`OnDeviceChat`](/reference/@azx/ribo-extractor-ondevice/classes/OnDeviceChat.html)
