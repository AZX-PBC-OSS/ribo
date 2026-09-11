# The ORT Runtime Cache

`@azx/ribo-transcriber-ondevice` runs its on-device speech model through the ONNX Runtime, compiled
to WASM. Getting that runtime to run offline — and to run at all under a strict host
Content-Security-Policy — takes two separate pieces of same-origin plumbing: where the runtime files
are served from, and where they're cached once fetched.

## Why `wasmPaths` is a required option, not a default

`OnDeviceTranscriberOptions.wasmPaths` has no default, and that's deliberate. transformers.js's own
default points the ONNX Runtime's `.wasm`/`.mjs` files at a jsDelivr CDN, which is wrong for this app
twice over: a cross-origin fetch breaks the offline guarantee the package exists to keep, and it trips
any host's Content-Security-Policy that doesn't already allow-list jsDelivr. A published library can't
ship those runtime files into an arbitrary consumer's bundler output either — it doesn't control the
consumer's build — so the consumer has to say where they've put them. A silent CDN fallback would
undermine the offline guarantee.

In practice, a consumer copies `onnxruntime-web`'s `ort-wasm-simd-threaded*.{wasm,mjs}` files — the
plain WASM build and the WebGPU-capable `.jsep` variant — into a static directory their own server
serves, and points `wasmPaths` at that directory. transformers.js appends the runtime filename to
whatever `wasmPaths` names, so every variant it might pick has to be present.

## Precached shell, lazily-cached runtime

The service worker's precache — see [The Service Worker](/offline-first/service-worker) — covers the
app shell only, deliberately excluding the ORT runtime files: eagerly precaching every variant would
push a large set of binaries — most of them never used — into the one cache that has to install fast
and complete. Instead, the runtime files are cached lazily, the first time the browser fetches
whichever variant it picked, using a cache-first runtime
caching rule scoped to the same-origin runtime path. That first fetch has to happen online — it's the
same "prime the model while you have signal" step a consumer already needs before offline
transcription can work at all — and after that, every later fetch of the same path, including a cold
offline reload, is served from the cache Workbox created rather than hitting the (absent) network.

There's one caching-header trap here: a dev or preview server that tags these responses with a
`Vary` header can make a runtime import miss its own cache entry, because a bare `import()` and a
plain `fetch()` for the same URL don't necessarily carry identical request headers, and the Cache API
honors `Vary` when matching. The runtime caching rule ignores `Vary` for this path specifically, so
the one cached response serves every request shape the runtime makes for it.

## The model itself lives in a different cache

The model weights are a separate concern from the runtime that executes them, and they get their own
cache: `transformers.js` writes every fetched model file into a `CacheStorage` bucket it manages
itself (`transformers-cache`), keyed by the file's full request URL, entirely independent of the
service worker's precache or the ORT runtime cache above. To answer "is this model already usable
offline," the package reads that cache's keys instead of attempting a network fetch. It checks for
both an encoder and a decoder file for the exact model id and dtype in question: Whisper-family
models split into separate encoder/decoder ONNX files, and a cache holding only one half of that pair
— a download interrupted mid-way — has to report "not ready," not "ready." No inference has to run,
and no network has to be reachable, to answer that question.
