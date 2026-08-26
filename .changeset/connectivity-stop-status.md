---
"@azx/ribo-core": patch
---

Fix a permanent wedge in the connectivity model when a stopped instance is started again.

`stop()` cancelled the in-flight probe but left `#status` at `"probing"`. `#evaluate()` — the single
entry point for start and every raw event — reads `"probing"` as "a probe is already running" and
returns early, so a restarted model never began a new probe cycle: no probe in flight, no probe ever
started, and a status that stayed `"probing"` forever. `#goOffline()` performs the identical
cancel-and-clear sequence and _does_ reset the status; `stop()` was the only path that cancelled a
probe while still advertising one.

`stop()` now sets the status to `offline`, which is both the honest answer — a stopped model is not
measuring, and consumers gate work on `online` — and the value `#status` is constructed with, making
stop/start symmetric. Subscribers receive one final `offline` at teardown.

Any host that ties the model to a component lifecycle hit this; React StrictMode performs exactly the
start → stop → start cycle on every mount in development, so `useConnectivity` was wedged for the
whole session in dev.
