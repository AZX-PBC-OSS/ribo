# The Service Worker

A returning auditor with no signal still needs the app to load. That's a service worker's job:
precache the shell — the built HTML, JS and CSS — so a cold, offline navigation to `/` is served from
cache rather than failing at the network. It's origin-global, so it's
**app-owned**: no package under `packages/` registers, ships, or assumes one. `@azx/ribo-core` and
`@azx/ribo-ui-react` are headless and have no opinion about a service worker existing at all; the host
app — the playground, or a real field tool built on these packages — is the one that wires it up.

## Precaching the shell, not the model

The playground generates its worker with Workbox (`generateSW`, via `vite-plugin-pwa`) rather than
hand-authoring one: there's no custom service-worker logic here beyond precaching, and a hand-rolled
cache-name-and-hash manifest gets the content hashes wrong the moment a filename changes, which is
every build. The precache glob covers JS, CSS, HTML, SVG and font files, with a 2 MB file-size
ceiling that keeps the shell's assets in and larger files — like the model — out. That ceiling
matters because a precache is all-or-nothing: `install` blocks until every listed entry has
downloaded, so one large file turns "loads instantly offline" into "loads once the model download
finishes." The on-device speech model and the ONNX Runtime files it depends on stay outside this
precache; see [Storage & Eviction](/offline-first/storage-eviction) and
[The ORT Runtime Cache](/offline-first/ort-runtime-cache) for where those live.

A cold offline start is a **navigation** to `/`, not a request for a specific precached URL — the
served file is `index.html` under a content hash the browser has no way to guess. `navigateFallback`
is the setting that makes an offline navigation resolve to the precached shell instead of failing
outright; without it, precaching everything else buys nothing the first time someone opens the app
with no signal.

## The update policy doesn't get to reload you

Workbox's default behavior for a new service-worker version is to take control immediately and
reload every open tab. In this app that default is destructive: a deploy lands, the new worker
installs, and a tab **currently recording** reloads out from under a live `MediaRecorder`, destroying
a capture that was made once, in someone's attic, and cannot be recreated. So the default is turned
off at the root: registration uses Workbox's "prompt" mode, which holds the new worker back
(`skipWaiting: false`, `clientsClaim: false`) until something explicitly tells it to take over.

One path remains. When a new worker takes control — because some tab asked it to — every other tab
it controls reloads by default too, on the assumption that anyone still on the old shell wants the
new one immediately. A second tab that happens to be mid-recording must not reload for the same
reason a fresh deploy must not reload it. The fix intercepts that "a new worker just took control"
signal and checks whether this tab is capturing; if it is, the reload is refused and the tab keeps
running the old shell until a person is free to act. The tab shows exactly that: "A new version took
over while you were recording. This page is still running the old code, on purpose," with a Reload
button that unlocks once capture stops.

## The residual risk

Refusing a reload leaves a tab running old JavaScript against data a newer version wrote — the same
risk two tabs left open across an ordinary deploy would already create, service worker or not. What
catches a real problem here is storage's own document schema, which parses documents in both
directions: reading a row back out of IndexedDB is a schema check, not a cast, exactly the same way
writing one in is. A newer version's added field looks like an unrecognized key to older code and the
read fails loudly; a narrowed or removed field fails the same way. One case no schema can catch: the
same shape meaning something different across versions. That's the trade this design accepts — the
window is one capture long, it closes with a click the person was already going to be asked for, and
the alternative, reloading a live recording, is worse.

## Development is a special case

The service worker is disabled entirely during local development: a precached shell serving
yesterday's bundle over a dev server's hot-reloaded one looks exactly like a bug in whatever you just
changed. The playground's status line says so directly — "Service worker DISABLED in dev — a
precached shell would serve stale bundles over HMR" — so that confusion doesn't get a chance to come
up.
