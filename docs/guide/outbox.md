# The Offline Outbox

Work is never lost to a dropped connection. A recording enters a durable RxDB outbox the moment it is
captured; a foreground relay drives it through transcription, extraction, and write-back when
connectivity allows, retrying with backoff.

::: info Content coming
This page will cover the outbox state machine and the relay. See the generated
[`Outbox`](/reference/ribo-core/src/classes/Outbox) and
[`Relay`](/reference/ribo-core/src/interfaces/Relay) reference in the meantime.
:::
