# @azx/ribo-transcriber-managed

A managed transcription plasmid for Ribo: Azure AI Speech Fast Transcription,
proxied through the host's transport. It implements `@azx/ribo-core`'s `Transcriber`
seam with engine id `managed-azure-speech`, and is composed through `firstCapable`
or `hedged` alongside the on-device engine — no queue changes, no contract changes.

## The package has no capacity to authenticate

This is deliberate, and it is the whole design (design §5.2). The package takes the
Azure transcribe endpoint and an injected `fetch`, and knows nothing about how the
call is routed — whether the host sends it straight to Azure with a key attached, or
rewrites it onto `<gateway>/_api/fetch/<url>` so the platform injects the stored
`azure-stt` secret. There is **no token option, no API-key option, and no gateway
base URL** in this package. The credential lives in the transport the host supplies,
so the package cannot leak what it never holds.

Connectivity is injected too, as a predicate: the package does not call
`navigator.onLine` and does not duplicate `ribo-core`'s three-state connectivity model.

## Capability

Maps onto reasons that already exist in `ribo-core`'s `transcriber.ts`:

- A missing endpoint or transport yields `not-configured`.
- A connectivity predicate reporting down yields `offline`.
- Otherwise `ready`.

Neither failure is permanent — both are situations, not facts about the hardware —
so `isPermanentlyUnavailable()` is `false` for both.

## Installation

```bash
pnpm add @azx/ribo-transcriber-managed @azx/ribo-core
```

> Not yet published to a public registry — in this workspace it is consumed as a `workspace:` dependency.

## Public API at a glance

- **`ManagedTranscriber`** — the class implementing `Transcriber`. Constructed with
  `ManagedTranscriberOptions`.
- **`ManagedTranscriberOptions`** — `endpoint` (the Azure transcribe endpoint URL),
  `fetchImpl` (inject a `fetch` double for tests or a credential-attaching transport
  for production), `isOnline` (a connectivity predicate).
- **`MANAGED_AZURE_SPEECH_ENGINE`** — the stable engine id string `"managed-azure-speech"`.

## Minimal example

```ts
import { ManagedTranscriber } from "@azx/ribo-transcriber-managed";

// The host supplies the endpoint and the transport. The transport attaches
// whatever credential the host holds — this package never sees it.
const transcriber = new ManagedTranscriber({
  endpoint: "https://myresource.cognitiveservices.azure.com",
  isOnline: () => navigator.onLine,
});
```

## Headless

This package is **headless** (AGENTS §4): no React, no DOM rendering. `fetch` is
expressly allowed and used as the bare global. `@azx/ribo-core` is a `dependencies`
entry: the class implements `Transcriber` and returns `TranscriberCapability`, both
of which leak into this package's own public API, so a consumer's type-check needs
`@azx/ribo-core` resolvable too.

See the [API Reference](../../docs/reference/) (generated) for the full surface.
