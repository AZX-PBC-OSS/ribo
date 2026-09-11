# Storage & Eviction

The durable outbox [Offline & the Outbox](/guide/offline-and-the-outbox) describes lives in IndexedDB
— free, broadly supported, and, like every other origin's storage, reclaimable by the browser under
disk pressure or an inactivity policy. iOS Safari's ITP is the sharpest version of this: roughly
seven days without the app being opened sweeps every script-writable store the origin owns —
IndexedDB, the Cache API, `localStorage`, cookies, and the service-worker registration — together,
all at once. That's the constraint this page is about: asking the browser not to do that, and being
honest with the person using the app when it does anyway.

## Asking for persistence

`navigator.storage.persist()` is the request that asks the browser to exempt this origin from
routine, quota-pressure eviction. It doesn't guarantee survival of the ITP-style inactivity sweep on
every platform, but it's the difference between "reclaimable like a cache" and "reclaimable only under
real disk pressure" everywhere it's honored. `@azx/ribo-ui-react`'s `useStoragePersistence` hook wraps
the grant and the quota estimate behind one shared, module-level snapshot — shared because the grant
is a property of the origin, not of whichever component happened to ask first, and a second component
reading a stale local copy after the first one just requested (and got) persistence would tell
`workSafety` a device is unprotected when it just stopped being.

The hook's `StoragePersistence` vocabulary is four states, not two, because `persisted() === false`
is genuinely ambiguous on its own: it's equally true of an origin nobody has asked about yet, one that
was explicitly refused, and one that _was_ granted and has since been revoked from outside the app
(the person cleared site data through browser settings). Only a `persist()` call's own return value
can tell "never asked" apart from "asked and refused" — a plain re-read can't — so `denied` is set
only by an actual refusal, and everything short of an outright `granted` collapses into `not
persisted` for the one place that consumes it: [`workSafety`](/guide/offline-and-the-outbox),
which drops on-device work to `at-risk` for anything other than a confirmed grant. Claiming
protection the browser hasn't actually given is the exact failure this vocabulary exists to prevent,
so `unknown` — a request still in flight — is treated the same conservative way, never assumed safe.

## Being honest when eviction happens anyway

A swept IndexedDB and a fresh install look identical from inside the origin: the outbox is empty
either way, and nothing about that state says whether it used to hold three recordings from an
auditor's attic or never held any at all. Telling those apart needs a witness that survives outside
IndexedDB — something written to a _different_ storage substrate that a partial wipe is less likely
to take along with it. The playground's approach writes a small marker (a version tag, a first-seen
timestamp, and the outbox's item count) to both `localStorage` and a cookie on every observed change
to the queue, and compares that marker against the actual outbox contents once at boot, before
anything else has a chance to overwrite it.

When the marker says the queue held recordings and the outbox is empty, that's eviction, surfaced as
a real notice rather than a quietly empty list. When there's no marker at all, that's read as a first
run — which is also, honestly, indistinguishable from the one case this approach cannot catch: the
full iOS ITP sweep takes the marker's cookie along with everything else, because WebKit caps
JavaScript-set cookies at the same handful of days it enforces the storage sweep on. That residual
case is stated rather than papered over — it's the _expected_ iOS outcome, not a bug in the
detection — and closing it needs something outside the browser's script-writable storage entirely: a
server-set cookie, or a synced backend that remembers what a device had. Short of that, the marker
still buys real coverage: quota-pressure eviction on Chromium and Firefox, a corrupted or manually
cleared database, and an app-level bug that drops the collection are all cases where the outbox
disappears and, without this, nobody would be told.

## What's deliberately not tested by opening and closing a database

Proving any of this actually persists can't be done by closing an RxDB instance and reopening it —
that passes even against in-memory storage, which is exactly the storage the outbox's
[test seam](/guide/offline-and-the-outbox) uses for everything
that isn't specifically testing durability. Real persistence claims get tested against real
IndexedDB, in a real browser, which is the more expensive and more honest thing to reach for whenever
the question is "does this survive," rather than "does this outbox class work."
