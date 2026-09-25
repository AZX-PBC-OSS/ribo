# @azx/ribo-chat-helix

The Helix platform LLM route transport for Ribo: `helixChat` implements `@azx/ribo-core`'s
`CapableChatClient` seam over the provider-neutral `/_api/llm/chat` route — which is **not**
OpenAI-compatible (a system message becomes a top-level `system` field, the response is a flat
JSON body, and the route defaults to SSE so `stream: false` is always sent).

It is a dialect package (ADR 0020): everything above the transport — `singleShotExtractor`,
`perGroupExtractor`, the schema split, the phases — lives in `@azx/ribo-core` and speaks the
seam, so this package exists to name the dialect and nothing else (ADR 0028). It stays apart
from `@azx/ribo-chat-openai` because the two are already separable and a merged package would
have no honest second segment — "chat" is the seam, not an implementation.

Everything is injected — the token, the base URL, the registered `Origin`, and (for tests)
the `fetch` implementation. No secret is hardcoded, and the package has no capacity to
authenticate on a consumer's behalf: the credential lives in the host's transport. Capability
can be derived from a live `ConnectivitySource` subscription, so a dead uplink is recognised
as soon as the model reports it.

## Composing it

```ts
import { singleShotExtractor } from "@azx/ribo-core";
import { helixChat } from "@azx/ribo-chat-helix";

const chat = helixChat({ token, baseUrl: "https://dev-api.azx.helix.azxlabs.io/my-app" });
const extractor = singleShotExtractor({ target, chat, model: "claude-haiku-4-5" });
```

## Learn more

- Guide: [Extraction](../../docs/guide/extraction.md)
- [Repo root](../../README.md)
