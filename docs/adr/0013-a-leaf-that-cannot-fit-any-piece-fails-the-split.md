# 0013. A leaf that cannot fit any piece fails the split at construction

Status: Accepted
Date: 2026-09-20

## Context

`splitExtractionSchema` packs a group's properties into pieces under the caps the caller supplies.
When a SINGLE property is itself over a cap — a nested group worth 17 unions against a 16-union
cap, or one leaf whose serialized size exceeds the byte cap — no partition can serve the schema.
The greedy packer's predecessor emitted such a property as a one-property piece anyway, over the
cap, and the request died at the provider with a `400` whose text reads identically to every other
schema rejection — the exact failure that costs an afternoon to diagnose, because nothing in the
error says which cap or which layer misjudged what.

The alternative was keeping emit-over-cap, for the reason any behaviour change earns scrutiny:
existing consumers might depend on the split never throwing.

## Decision

Throw at construction, naming the group, the property, the measured size (unions and/or
serialized characters), the cap and the option that carries it. Only paths where the caller
SUPPLIED the corresponding cap can throw — the no-option one-entry-per-group path does not pack
and cannot fail this way, so every caller written before the byte cap existed keeps its behaviour
unchanged.

Pre-flighted against the whole unit suite and the adapter's cap tests before committing: nothing
in the shipped schemas hits it (every enveloped leaf is two unions, half the default cap, and no
caller supplied a byte cap yet).

## Consequences

A schema that cannot be served fails where the schema author is present, with the fix (narrow the
schema or raise the cap) stated in the error. The cost is that a construction which used to
"succeed" and fail later now throws eagerly — which is the point, but it is a behaviour change a
consumer tolerating silent over-cap pieces would feel. Those pieces never extracted successfully;
the failure only moved to a place where it can be read.
