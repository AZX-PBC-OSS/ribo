---
"@azx/ribo-core": minor
---

Remove internal names from the public barrel: `abstainedValue`, `addUsage`, `buildFieldPath`, `CapabilityCache` (with the `CapabilityCacheOptions` type), `capturePayloadSchema`, `createCaptureStorageScope`, `createPluginStorage`, `createPluginStorageScope`, `DEFAULT_FAKE_TRANSCRIBER_ENGINE`, `DEFAULT_MIME_TYPE_PREFERENCES`, `fieldDescriptionsMode`, `holdLock` (with the `HeldLock` type), `partitionLabelLine`, `projectFillExample`, `relayItemLock`, `retypeToPatchValue`, `TRANSCRIBER_UNAVAILABLE_REASONS`, and `writableGroupEntry`. None has an importer outside the package; each is either still used internally or kept where it is unused. If you relied on one, open an issue.
