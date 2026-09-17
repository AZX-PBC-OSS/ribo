# Storage & Eviction

Durable storage lives in IndexedDB (see
[Offline & Storage](/guide/offline-and-storage)) — free, broadly supported, and, like every
other origin's storage, reclaimable by the browser under disk pressure or an inactivity policy. iOS
Safari's ITP is the sharpest version of this: roughly seven days without the app being opened sweeps
every script-writable store the origin owns at once — IndexedDB, the Cache API, `localStorage`,
cookies, and the service-worker registration. This page covers two things: asking the browser not to
evict, and detecting it when eviction happens anyway.

## Asking for persistence

`navigator.storage.persist()` asks the browser to exempt this origin from routine, quota-pressure
eviction. It doesn't guarantee survival of the ITP-style inactivity sweep on every platform, but it's
the difference between "reclaimable like a cache" and "reclaimable only under real disk pressure"
everywhere it's honored. `@azx/ribo-ui-react`'s `useStoragePersistence` hook wraps the grant and the
quota estimate behind one shared, module-level snapshot. The snapshot is shared because the grant is
a property of the origin, not of whichever component happened to ask first: a second component
reading a stale local copy right after the first one requested (and got) persistence would tell
`workSafety` the device is unprotected when it has just become protected.

The hook's `StoragePersistence` vocabulary is four states, not two, because `persisted() === false`
is genuinely ambiguous on its own: it's equally true of an origin nobody has asked about yet, one that
was explicitly refused, and one that _was_ granted and has since been revoked from outside the app
(the person cleared site data through browser settings). Only a `persist()` call's own return value
can tell "never asked" apart from "asked and refused" — a plain re-read can't — so `denied` is set
only by an actual refusal, and everything short of an outright `granted` collapses into `not
persisted` for the one place that consumes it: [`workSafety`](/guide/offline-and-storage),
which drops on-device work to `at-risk` for anything other than a confirmed grant. The vocabulary
exists so the app never claims protection the browser hasn't given: `unknown` — a request still in
flight — is treated the same conservative way, never assumed safe.

## When eviction happens anyway

A swept IndexedDB and a fresh install look identical from inside the origin: storage is empty
either way, and nothing about that state says whether it used to hold recordings or never held any at
all. Telling them apart needs a witness outside IndexedDB — something in a different store that a
partial wipe is less likely to take with it. The playground's approach writes a small marker (a
version tag, a first-seen timestamp, and storage's item count) to both `localStorage` and a cookie
on every observed change to the queue, and compares that marker against the actual storage contents
once at boot, before anything else has a chance to overwrite it.

When the marker says the queue held recordings and storage is empty, that's eviction, and the app
raises a real notice for it. When there's no marker at all, that's read as a first run —
indistinguishable from the one case this approach cannot catch: the full iOS ITP sweep takes the
marker's cookie along with everything else, because WebKit caps JavaScript-set cookies at the same
handful of days it enforces the storage sweep on. This is the expected iOS outcome, not a detection
bug, and closing it needs something outside script-writable storage: a server-set cookie, or a synced
backend that remembers what a device had. Short of that, the marker still buys real coverage:
quota-pressure eviction on Chromium and Firefox, a corrupted or manually cleared database, and an
app-level bug that drops the collection are all cases where storage disappears and, without this,
nobody would be told.

## What's deliberately not tested by opening and closing a database

Proving any of this persists can't be done by closing an RxDB instance and reopening it — that
passes even against in-memory storage, which is exactly the storage storage's
[test seam](/guide/offline-and-storage) uses for everything
that isn't specifically testing durability. Persistence claims get tested against real IndexedDB in a
real browser. It costs more, and it's the only way to answer "does this survive" rather than "does
this storage class work."
