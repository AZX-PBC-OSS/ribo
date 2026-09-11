# Offline-first

[Offline & the Outbox](/guide/offline-and-the-outbox) covers the model: the durable outbox, the two
state machines, and the relay that drains them when connectivity allows. This section covers the
browser platform underneath that model — the three browser mechanisms that boot the device, keep its
data, and run inference with no network:

- **[The Service Worker](/offline-first/service-worker)** — precaches the app shell (HTML, JS, CSS)
  so a cold, offline load still boots, and how the update policy refuses to reload a tab out from
  under a live recording.
- **[Storage & Eviction](/offline-first/storage-eviction)** — the `navigator.storage.persist()` grant
  that asks the browser not to reclaim the outbox's IndexedDB, and what happens when it does anyway:
  the app detects the wipe and says so.
- **[The ORT Runtime Cache](/offline-first/ort-runtime-cache)** — why the ONNX Runtime files the
  on-device speech model runs on have to be served same-origin, and how the Cache API keeps them
  around for the next offline session.

Each of these is a distinct browser API doing a distinct job: a service worker owns the app shell,
`navigator.storage` owns eviction, the Cache API owns large runtime and model files. None of the three
substitutes for another. No service worker: no cold offline boot at all. No persistence grant: the
outbox can be swept the same as any other reclaimable data. No runtime cache: the first offline
transcription after a reload has nothing to run the model on.
