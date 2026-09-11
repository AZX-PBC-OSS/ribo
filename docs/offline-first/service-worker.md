# The Service Worker

A returning auditor with no signal still needs the app to load. That's a service worker's job:
precache the shell — the built HTML, JS and CSS — so a cold, offline navigation to `/` is served from
cache rather than failing at the network. It's origin-global by nature, which is why it's
**app-owned**: no package under `packages/` registers, ships, or assumes one. `@azx/ribo-core` and
`@azx/ribo-ui-react` are headless and have no opinion about a service worker existing at all; the host
app — the playground, or a real field tool built on these packages — is the one that wires it up.

## Precaching the shell, not the model

The playground generates its worker with Workbox (`generateSW`, via `vite-plugin-pwa`) rather than
hand-authoring one, because there's no custom service-worker logic here beyond precaching, and a
hand-rolled cache-name-and-hash manifest gets the content hashes wrong the moment a filename changes
— which is every build. The precache glob covers JS, CSS, HTML, SVG and font files, with a file-size
ceiling well above the app shell's own size and well below anything that would surprise you. That
ceiling is load-bearing: a precache is all-or-nothing and blocks the worker's `install` step until
every listed entry has downloaded, so one large file turns "loads instantly offline" into "loads once
the model download finishes" — the opposite of the point. The on-device speech model and the ONNX
Runtime files it depends on are deliberately outside this precache; see
[Storage & Eviction](/offline-first/storage-eviction) and
[The ORT Runtime Cache](/offline-first/ort-runtime-cache) for where those actually live.

A cold offline start is a **navigation** to `/`, not a request for a specific precached URL — the
served file is `index.html` under a content hash the browser has no way to guess. `navigateFallback`
is the setting that makes an offline navigation resolve to the precached shell instead of failing
outright; without it, precaching everything else buys nothing the first time someone opens the app
with no signal.

## The update policy doesn't get to reload you

Workbox's default behavior for a new service-worker version is to take control immediately and
reload every open tab. Applied to this app, that means: a deploy happens, the new worker installs,
and a tab **currently recording** reloads out from under a live `MediaRecorder` — destroying a
capture that was made once, standing in someone's attic, and cannot be recreated. So the default is
turned off at the root: registration uses Workbox's "prompt" mode, which holds the new worker back
(`skipWaiting: false`, `clientsClaim: false`) until something explicitly tells it to take over.

That still leaves one path back to an unwanted reload: the moment a new worker _does_ take control —
because some tab asked it to — every other tab it controlled reloads by default too, on the
assumption that anyone still using the old shell wants the new one immediately. A second tab that
happens to be mid-recording when a first tab applies an update is exactly the case this whole policy
exists to prevent. The fix is to intercept that "a new worker just took control" signal and check,
right then, whether this tab is capturing — if it is, the reload is refused and the tab is left
running the old shell against the new worker until a person is free to act on it. That state is
visible rather than silent: nothing about it is treated as a background detail the user doesn't need
to know.

## The residual risk, stated rather than hidden

Refusing a reload leaves a tab running old JavaScript against IndexedDB a newer worker's shell would
otherwise be serving — the same situation two tabs left open across an ordinary deploy would already
create, service worker or not. What actually catches a real problem here is the outbox's own document
schema, which parses documents in both directions — reading a row back out of IndexedDB is a schema
check, not a cast, exactly the same way writing one in is. A newer version's added field looks like an
unrecognized key to older code and the read fails loudly; a narrowed or removed field fails the same
way. That leaves one narrow case no schema can catch — the same shape meaning something different
across versions — which is the trade this design accepts: the window is one capture long, it's closed
by a click the person was already going to be asked for, and the alternative is reloading out from
under them, which is the actual failure this exists to prevent.

## Development is a special case

The service worker is disabled entirely during local development. A precached shell serving
yesterday's bundle over a dev server's hot-reloaded one is a well-known trap, and it looks exactly
like a bug in whatever you just changed. Disabling it in dev, and saying so visibly rather than
leaving it a silent gap, keeps that confusion from ever coming up.
