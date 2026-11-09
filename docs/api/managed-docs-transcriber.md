# ManagedDocsTranscriber

Managed document transcription: a hosted document-understanding API behind the **host's
transport**, with engine id `"managed-docs"`. Implements the [`Transcriber`](/api/transcriber)
seam as `Transcriber<DocumentCapture>`, so it composes through `fallbackTranscriber` alongside
[`PdfjsTranscriber`](/api/pdfjs-transcriber) with no core changes. **The package has no capacity
to authenticate** — the credential lives in the transport the host supplies through `fetchImpl`.

## When to reach for it

Reach for it as the managed rung of a document ladder — the engine that reads what pdf.js cannot
(scans, no text layer). Reach for the [Captures & Sources guide](/guide/captures-and-sources) for
where the ladder is wired and why a 413 here routes to the next rung instead of failing the item.

## Usage

Everything below runs with no credentials and no network: the endpoint is never real, and the
transport is an injected `fetch` double. With no endpoint, `capability()` reports
`not-configured`:

<<< @/api/examples/managed-docs-transcriber.run.ts#usage

## Options

`new ManagedDocsTranscriber(options?)` takes `ManagedDocsTranscriberOptions` — every member is
optional.

The defaults the page states are quoted from the example file rather than retyped, and the same
file's test run asserts the engine id against its exported constant:

<<< @/api/examples/managed-docs-transcriber.run.ts#defaults

| Name        | Type            | Default                   | What it does                                                                                                                                             |
| ----------- | --------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`  | `string`        | —                         | The document analysis endpoint URL. Injected by the host; the package never constructs or discovers it. Absent, `capability()` reports `not-configured`. |
| `fetchImpl` | `typeof fetch`  | the bare global `fetch`   | Override `fetch` — inject a double for tests, or a credential-attaching transport for production. The package adds no credential to the request.         |
| `isOnline`  | `() => boolean` | `() => true` (optimistic) | Connectivity predicate. `false`, `capability()` reports `offline`. The package never calls `navigator.onLine`.                                           |

Options are read from `packages/ribo-transcriber-managed-docs/src/config.ts` (the options
interface) and `src/index.ts` (the class). There is no per-page progress hook: the managed call
is one HTTP request returning every page at once, so there is no per-page loop to observe.

## Return value

- `capability()` — `ready`, or `unavailable` with `not-configured` or `offline`; both situations,
  neither permanent.
- `transcribe(item, bytes, options?)` — POSTs the document bytes with the capture's MIME type as
  `Content-Type`, and maps the response onto a `Transcript` whose `engine` is `managed-docs`.
  The response is flattened into text with page markers (`\n===== PAGE n =====\n`) and
  `" | "`-joined table cells — the same conventions pdf.js uses, so a downstream prompt cannot
  tell which engine produced the text. The caller's `signal` is forwarded into the fetch init.

## Errors

- **Item unsuitability** — `UnsupportedItemError`, and the ladder routes to the next rung: 415
  and 413 (`unsupported-format` — the service is rejecting a property of this document), an
  error body whose code names encryption (`encrypted`), and a 200 with no extractable text
  (`no-text-layer`, mirroring pdf.js's guard). Contrast the managed audio transcriber, where 413
  is terminal: a document too large for this service may be within pdf.js's limits.
- **Capability failure** — 401/403: `TranscriberUnavailableError` with `not-configured`.
- **Attempt failure** — everything else (5xx, network error, malformed body, ambiguous 4xx),
  thrown plainly with the HTTP `status` attached.
- **Cancellation** — the caller's abort rejects with `TerminalError`.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims — including the defaults quoted
under Options.

<<< @/api/examples/managed-docs-transcriber.run.ts

## Related APIs

- [`Transcriber`](/api/transcriber) — the seam this class implements.
- [`PdfjsTranscriber`](/api/pdfjs-transcriber) — the on-device rung it falls back from, with
  matching output conventions.
- [`fallbackTranscriber`](/api/composing-transcribers) — the combinator that routes item
  unsuitability to the next rung.

## Guides that use it

- [Captures & Sources](/guide/captures-and-sources) — the document ladder and what egress does
  with the request.

## Reference

- [`ManagedDocsTranscriber`](/reference/@azx/ribo-transcriber-managed-docs/classes/ManagedDocsTranscriber.html)
- [`ManagedDocsTranscriberOptions`](/reference/@azx/ribo-transcriber-managed-docs/interfaces/ManagedDocsTranscriberOptions.html)
- [`MANAGED_DOCS_ENGINE`](/reference/@azx/ribo-transcriber-managed-docs/variables/MANAGED_DOCS_ENGINE.html)
