# 0015. The library carries no provider byte cap

Status: Accepted
Date: 2026-09-20

## Context

The serialized-character ceiling a structured-output route enforces (`schema must serialize to
<= 32768 characters and nest <= 12 levels`) is named by ONE route's own error text. The splitter
needed to pack against it, and the tempting moves were both wrong in known ways: import the
constant the Snugg Pro adapter already defines (`SCHEMA_SERIALIZED_CHAR_CAP`) — a layering
violation, extractor packages cannot depend on adapters — or bake the number into the library as
the default.

The nullable-union cap went the other way first: it IS a library constant
(`MAX_NULLABLE_UNIONS_PER_CALL`), and its doc block spends its length admitting exactly what it
cannot establish — whether the number is the vendor's own limit or one route's translation of it.

## Decision

The byte cap is an OPTION (`maxSerializedCharsPerGroup`) with no library default: absent, size is
not measured and nothing packs against it. The caller supplies their route's number, because the
caller chose the chat client that knows the route. The guide passes a real route's number in its
example, so the newcomer copies a working value without the library claiming it is universal.

The union cap keeps its library default. The difference is honest, not inconsistent: the union
number was MEASURED here and can be labelled as ours; the byte number is the route's OWN claim,
and a default would dress one route's error text up as the library's knowledge.

## Consequences

A caller who omits the byte cap and hands over a schema with few unions and many bytes still
meets the route's `400` — the failure the byte cap exists to prevent — unless they follow the
guide, which supplies the number. The failure mode is documented at the option, in the guide, and
in the route's own error text, which names the limit in its first clause. The cost of this choice
is that correctness for large schemas is guide-load-bearing; the alternative — a baked default —
was rejected because the library would then assert a provider's number it cannot know, and the
caps differ by route.
