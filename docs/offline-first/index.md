# Offline-first

Ribo assumes the network is a sometimes-thing. A field auditor in a basement has no signal, and the app
must still boot, record, transcribe on-device, and hold the result until it can sync.

- **[The Service Worker](/offline-first/service-worker)** — caching the app shell so the app loads with
  no network.
- **[Storage & Eviction](/offline-first/storage-eviction)** — the RxDB outbox, `persist()`, and being
  honest when the browser reclaims space.
- **[The ORT Runtime Cache](/offline-first/ort-runtime-cache)** — the same-origin ONNX Runtime files and
  the `/ort/` cache story.

::: info Content coming
These pages repackage the offline-first findings for an external reader in the content pass.
:::
