---
"@azx/ribo-core": patch
---

`fieldDescriptions: "prompt"` moves a schema's field descriptions out of `response_format` and
into the system message, for routes that cap the schema rather than the messages (ADR 0030).
It is one switch for both halves: the wire schema is stripped and the same text is rendered as
a field-guidance block, scoped to each call's own group or piece. The default is `"schema"`, so
existing prompts and schemas are unchanged.

Available on `singleShotExtractor`, `schemaRetryExtractor`, `perGroupPlan`, `buildMessages`,
`buildGroupMessages`, `scopedInstanceExtractor` and `prepareGroups`. `PreparedGroup` gains a
required `fieldDescriptions` member recording the mode its `jsonSchema` was rendered in, and
`fillPhase` reads it from there. New exports: `renderFieldGuidance`, `withFieldGuidance`,
`fieldDescriptionsMode`, `toJsonSchemaForWire` and `stripJsonSchemaDescriptions`, whose walk only
treats `description` as a keyword at schema positions, so a field named `description` survives.
