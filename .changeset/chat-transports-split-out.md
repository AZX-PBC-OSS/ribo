---
"@azx/ribo-core": major
"@azx/ribo-chat-openai": minor
"@azx/ribo-chat-helix": minor
---

Delete `@azx/ribo-extractor-openai` and split its two transports into their own packages (ADR
0027).

The package was misnamed twice over: of its 28 source files only `openai-chat.ts` and
`helix-chat.ts` were vendor-bound, and one of those two is not OpenAI — every strategy above them
had already moved into `@azx/ribo-core` on the transport-agnostic moves, leaving a re-export
barrel wearing a vendor's name. A deprecated re-export shell was available and rejected: it
preserves the misnaming this exists to remove, and nothing would ever delete it.

`openAiChat` (the OpenAI-compatible `/chat/completions` dialect) is now `@azx/ribo-chat-openai`;
`helixChat` (the Helix platform's provider-neutral `/_api/llm/chat` route) is now
`@azx/ribo-chat-helix`. They stay apart because they are already separable and a merged package
would have no honest second segment — "chat" is the seam, not an implementation (ADR 0020). Both
remain fetch-injected with no capacity to authenticate.

This is breaking for every consumer importing `@azx/ribo-extractor-openai`. Almost everything
those consumers used — the strategies, presets, schema split, shape derivation, prompt helpers
and the chat-seam types — is already exported from `@azx/ribo-core`; only `openAiChat` and
`helixChat` come from the new packages. `@azx/ribo-core` takes the major because the absorbed
surface is now its compatibility promise and the compatibility barrel is gone.
`@azx/ribo-extractor-ondevice`'s dependency on the deleted package goes with it — the one
leaf-to-leaf edge this workspace ever carried, closed by repointing the one test import to core.
