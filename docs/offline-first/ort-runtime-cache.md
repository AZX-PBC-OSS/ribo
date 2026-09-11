# The ORT Runtime Cache

`@azx/ribo-transcriber-ondevice` runs its on-device speech model through the ONNX Runtime, compiled
to WASM. Getting that runtime to actually run offline — and to run at all under a strict host
Content-Security-Policy — takes two separate pieces of same-origin plumbing: where the runtime files
are served from, and where they're cached once fetched.

## Why `wasmPaths` is a required option, not a default

`OnDeviceTranscriberOptions.wasmPaths` has no default, and that's deliberate. transformers.js's own
default points the ONNX Runtime's `.wasm`/`.mjs` files at a jsDelivr CDN, which is exactly wrong for
this app twice over: a cross-origin fetch breaks the offline guarantee the whole package exists to
make good, and it trips any host's Content-Security-Policy that doesn't already allow-list jsDelivr. A
published library can't ship those runtime files into an arbitrary consumer's bundler output either —
it doesn't control the consumer's build — so the honest shape is to require the consumer to say where
they've put them, rather than silently falling back to a CDN that undermines the point.

In practice, a consumer copies `onnxruntime-web`'s `ort-wasm-simd-threaded*.{wasm,mjs}` files (both
the plain WASM build and the WebGPU-capable `.jsep` variant — transformers.js appends the runtime
filename to whatever `wasmPaths` names, so every variant it might pick has to be present) into a
static directory their own server serves, and points `wasmPaths` at that directory.

## Precached shell, lazily-cached runtime

The service worker's precache — see [The Service Worker](/offline-first/service-worker) — covers the
app shell only, deliberately excluding the ORT runtime files: eagerly precaching every runtime
variant would push a sizeable, rarely-all-needed set of binaries into the one cache whose entire
purpose is a fast, guaranteed-complete install. Instead, the runtime files are cached lazily, the
first time the browser actually fetches whichever variant it picked, using a cache-first runtime
caching rule scoped to the same-origin runtime path. That first fetch has to happen online — it's the
same "prime the model while you have signal" step a consumer already needs before offline
transcription can work at all — and after that, every later fetch of the same path, including a cold
offline reload, is served from the cache Workbox created rather than hitting the (absent) network.

One caching-header subtlety was worth catching directly: a dev or preview server that tags these
responses with a `Vary` header can make a runtime import miss its own cache entry, because a bare
`import()` and a plain `fetch()` for the same URL don't necessarily carry identical request headers,
and the Cache API honors `Vary` when matching. The runtime caching rule ignores `Vary` for this path
specifically, so the one cached response serves every request shape the runtime actually makes for
it.

## The model itself lives in a different cache

The speech model's own weights are a separate concern from the runtime that executes them, and they
live in a separate cache for it: `transformers.js` writes every fetched model file into a `CacheStorage`
bucket it manages itself (`transformers-cache`), keyed by the file's full request URL, entirely
independent of the service worker's precache or the ORT runtime cache above. That's what lets
`@azx/ribo-transcriber-ondevice` answer "is this model already usable offline" by reading that cache's
keys — checking for both an encoder and a decoder file for the exact model id and dtype in question,
since Whisper-family models split into separate encoder/decoder ONNX files and a cache holding only
one half of that pair (a download interrupted mid-way, exactly the flaky-connectivity case this app
exists for) has to report "not ready," not "ready" — rather than by attempting a network fetch and
seeing whether it succeeds. No inference has to run, and no network has to be reachable, to answer
that question.
