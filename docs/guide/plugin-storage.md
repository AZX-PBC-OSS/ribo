# Plugin Storage

A document transcriber learns things at transcribe time that an extractor needs at extraction time:
which pages carried a table, what a provider's own structured response said, a per-capture
normalization it computed. The obvious channels all fail. Module variables and class fields die with
the tab — and the two halves of a plugin may run in **different tabs, minutes apart**, since
transcription and extraction are separate relay steps. Annotations on the transcript don't survive
combination: a `TranscriptCombiner` returns one transcript with its own bag, and per-part
annotations are an input to combination, not a channel through it (see [Sessions](/guide/sessions)).

So storage carries a third thing beside the capture and its transcript: a durable, namespaced
key-value store, plus the two handles plugins use to read and write it.

## What a handle promises

`PluginStorage` is the narrowest possible KV surface — `get`, `set`, `delete`, and `keys()` — and
every handle over it is scoped to one `(captureId, pluginId)` pair. A plugin cannot accidentally
read or overwrite another plugin's keys, or its own keys from a different capture. Values are
JSON-serialisable; any shape — a document id, an array of page annotations, a nested object —
survives without core learning what it is.

Three properties hold for every handle, and they are the reason to reach for this instead of
anything else:

- **Durable, not in-memory.** Entries live in the same storage backend as captures and sessions, so
  they survive a close-and-reopen and are visible to a different tab.
- **Live reads.** Every call queries storage; nothing is cached in the handle. A capture whose
  entries core has swept drops out of `captures()` and reads `undefined` — a reader never holds a
  stale view of swept state.
- **Swept, never swept by you.** Core deletes every entry for a capture when the capture is dropped
  or discarded. A plugin never cleans up after itself, and the lifecycle is the **sweep**, not the
  session: entries live exactly as long as their capture does.

One boundary to know up front: **the `Storage` itself is never handed to a plugin.** These handles
are the only storage a plugin ever sees.

## Writing: the transcriber side

A transcriber receives a capture-scoped `CaptureStorageScope` on every `transcribe` call, in
`TranscribeOptions.storage`:

```ts
import type { DocumentCapture, TranscribeOptions, Transcriber } from "@azx/ribo-core";

export class MyDocumentTranscriber implements Transcriber<DocumentCapture> {
  readonly engine = "my-docs";

  async capability() {
    return { status: "ready" } as const;
  }

  async transcribe(item: DocumentCapture, bytes: Blob, options?: TranscribeOptions) {
    const store = options?.storage?.forPlugin(this.engine);
    await store?.set("page-notes", {/* the pages' own structure */});
    // ...transcribe `bytes`, and return the Transcript...
  }
}
```

The capture is baked in by the relay — it knows which capture it's draining — but the relay cannot
know which engine a selection combinator (`firstCapable`, `fallbackTranscriber`, `hedged`) will
pick, so the plugin names itself: `forPlugin(pluginId)` mints the actual handle, and the convention
is to pass the transcriber's own `engine` id. Two engines picked for the same capture land in
separate namespaces and cannot read or clobber each other's keys.

The member is optional because a host driving a transcriber by hand has no storage to mint one from.
An engine that needs storage must handle its absence rather than assume it.

## Reading: the extractor side

An extractor receives a plugin-scoped `PluginStorageScope` at **construction**, from
`Storage.pluginStorageScope(pluginId)`. The timing is forced by the contract's shape: the `Extractor`
seam has no engine id on it — `engine` appears on the result, after the call — so the relay cannot
scope a handle for the plugin it invokes. The host building the extractor knows which plugin it is
building, so the pluginId is baked in there, and the capture dimension is addressed per call:

```ts
import type { Extractor } from "@azx/ribo-core";

const scope = storage.store("my-docs");

const myExtractor: Extractor<MyFields> = {
  extract: async (transcript) => {
    for (const captureId of await scope.captures()) {
      const pageNotes = await scope.capture(captureId).get("page-notes");
      // ...fold that capture's notes into the prompt you are about to send...
    }
    // ...run the model over `transcript` as usual, then:
    return { fields, usage: { calls: 1 } };
  },
};
```

An extraction runs over a session joined from several captures, so the writes a sibling transcriber
made are reached one capture at a time — `scope.capture(captureId)` for a known id,
`scope.captures()` to discover them. Both are live: entries added between two extractions appear,
and swept ones
disappear.

## The limitation: not session-bounded

The scope is **not scoped to a session**. `captures()` enumerates every capture this plugin has
unswept entries for, **across sessions**, and there is no handle for "this session's captures" —
an extraction sees only the joined transcript, so core cannot bound the enumeration to it either.
A plugin whose writes are session-relevant must encode the correlation in its own keys or values
(a session id inside the value, say), because the handle will not do it.

That is the deal in one sentence: **the lifecycle is the sweep, not the session.** What you get in
exchange is durability without a cleanup story — nothing to invalidate, nothing to garbage-collect,
and nothing stale to read.

## Next

[Captures & Sources](/guide/captures-and-sources) covers the transcriber contract `storage` arrives
on, and [Extraction](/guide/extraction) covers the extractor seam that reads it back.
[Offline & Storage](/guide/offline-and-storage) covers the storage backend these entries live
in.
