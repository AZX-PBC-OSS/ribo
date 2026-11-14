# @azx/ribo-core

## 0.2.0

### Minor Changes

- 85e3505: Rename four public names to read better next to the rest of the API. The packages are 0.x, so this ships as a minor with no deprecation alias.

  - `Recording` is now `AudioCapture` (it pairs with `DocumentCapture`); `recordingSchema` is now `audioCaptureSchema` and `baseRecordingSchema` is now `baseAudioCaptureSchema`. Persisted data is unchanged — the `kind: "audio"` literal and every storage field name stay as they were.
  - `hedged` is now `hedgedTranscriber`, matching `hedgedExtractor`; its option type `HedgedOptions` is now `HedgedTranscriberOptions`.
  - `ChatRequest.response_format` is now `ChatRequest.responseFormat`, matching `maxTokens`. Only the TypeScript member changed: each transport still sends its current wire body, so OpenAI's chat surface keeps the `response_format` wire field.
  - `createSequentialExtractor` and `createConcurrentExtractor` are no longer exported from the barrel. They stay as the internal engines behind `fallbackExtractor` and `raceExtractor` — use those instead.

- e76e1db: Remove internal names from the public barrel: `abstainedValue`, `addUsage`, `buildFieldPath`, `CapabilityCache` (with the `CapabilityCacheOptions` type), `capturePayloadSchema`, `createCaptureStorageScope`, `createPluginStorage`, `createPluginStorageScope`, `DEFAULT_FAKE_TRANSCRIBER_ENGINE`, `DEFAULT_MIME_TYPE_PREFERENCES`, `fieldDescriptionsMode`, `holdLock` (with the `HeldLock` type), `partitionLabelLine`, `projectFillExample`, `relayItemLock`, `retypeToPatchValue`, `TRANSCRIBER_UNAVAILABLE_REASONS`, and `writableGroupEntry`. None has an importer outside the package; each is either still used internally or kept where it is unused. If you relied on one, open an issue.

### Patch Changes

- a39efc5: `presenceNarrowedExtractor`'s fill phase now honours the same split caps the per-group strategy honours. It previously sent exactly one value-extraction call per group with present leaves, however large the group's narrowed schema — so under a byte-capped route (the Helix vendor cap of 32,768 serialized characters on the real Snugg Pro schema) it could send an over-cap call the per-group path would have partitioned, and the route refused it. The fill now narrows first and then splits each group's narrowed schema through the same `splitExtractionSchema` the per-group plan partitions with: `presenceFillPhase` (and the preset, which forwards it) takes `maxNullableUnionsPerGroup` (same default, `MAX_NULLABLE_UNIONS_PER_CALL`) and `maxSerializedCharsPerGroup` (same pass-through, off when absent). One fill item per piece, so a failed piece nulls only its own leaves under `onItemFailure: "skip"`, and a collection group's pieces zip back by instance index — presence still decides which leaves, never how many instances. Narrowing runs before the split, so a group with few present leaves still costs one call.

  `ribo schema inspect`'s `presenceNarrowedAtMost` moves with the fix: it is now the group count (presence, one call per group always) plus the split's own grouped-piece count under the reported caps — the all-present worst case the agreement test pins, partition included — instead of the old `2 × groupCount`. The JSON contract's shape is unchanged, so `contractVersion` stays at 3.

  The adapter's entry covers its new presence-narrowed cap test against the real schema and vendor cap — no runtime change.

## 0.1.0

### Minor Changes

- 7fba323: First release.
- c6e52d8: Add `scriptedChat(respond, options?)` — a public scripted chat client, the `ChatClient`
  counterpart to `FakeExtractor` and `FakeTranscriber`. It drives the chat-based extractors
  (`singleShotExtractor`, `perGroupExtractor`, the phased strategies) deterministically with no
  model: a fixed reply or a per-call callback, every request recorded on `calls` in order (failed
  and aborted calls included), thrown `ChatError`s passed through unchanged so arbitration and
  retry see what a real transport would throw, an abortable per-call `delay`, and a
  runtime-controllable `capability()` with `setCapability` and `reset()`.

### Patch Changes

- 48c0647: `helixChat`'s `token` option is now optional. A deployed Helix app authenticates to its same-origin
  gateway with the session cookie and has no token, so it no longer has to pass a placeholder and cast
  around the type. When `token` is absent no `authorization` header is sent at all; behaviour with a
  token is unchanged (`Bearer <token>`).

  Also fixes stale API names in `@azx/ribo-core`'s and `@azx/ribo-ui-react`'s README code samples
  (`openOutbox` → `openStorage`; `useOutboxItems`/`useHostOutbox` → `useCaptures` and the
  provider's `storage` instance).
