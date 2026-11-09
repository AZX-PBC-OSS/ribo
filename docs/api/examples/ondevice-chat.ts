/**
 * The on-device transport construction example behind
 * docs/api/chat-transports.html.
 *
 * Type-checked only — never executed. `OnDeviceChat` wraps Chrome's Prompt API
 * (`LanguageModel`, `promptStreaming`), which exists only in a browser; there
 * is no credential-free node form of the real thing. The page says
 * "type-checked only" for this file.
 */

import { OnDeviceChat, type LanguageModel } from "@azx/ribo-extractor-ondevice";

// #region usage
// The model object is the platform's `globalThis.ai.languageModel`, probed and
// primed with the package's own `probeLanguageModel` / `primeLanguageModel`.
declare const languageModel: LanguageModel;
const chat = new OnDeviceChat({ languageModel });
// #endregion usage

// A `CapableChatClient` — same seam `openAiChat` and `helixChat` speak, so the
// extraction strategies above it cannot tell which transport is underneath.
void chat;
