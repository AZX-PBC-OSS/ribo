/**
 * The resolution proof behind docs/api/index.html.
 *
 * One value import per publishable `@azx/*` package, resolved by package name
 * through each package's real `exports` map under the `@azx/source` condition —
 * the same path the playground and the package test suites use. The examples
 * tsconfig (docs/api/examples/tsconfig.json) type-checks this file inside the
 * `docs:build` chain, so a broken `exports` block, a renamed barrel export or a
 * lost source condition fails `docs:build` for every package at once.
 *
 * Type-checked only — never executed.
 */

import { snuggProAdapter } from "@azx/ribo-adapter-snuggpro";
import { openAiChat } from "@azx/ribo-chat-openai";
import { helixChat } from "@azx/ribo-chat-helix";
import { FakeTranscriber, type DocumentCapture, type Transcriber } from "@azx/ribo-core";
import { threePhaseExtractor } from "@azx/ribo-extractor-ondevice";
import { systemOnePresencePhase } from "@azx/ribo-extractor-systemone";
import { systemOneClient } from "@azx/ribo-systemone-managed";
import { openRxdbBackend } from "@azx/ribo-storage-rxdb";
import { ManagedTranscriber } from "@azx/ribo-transcriber-managed";
import { ManagedDocsTranscriber } from "@azx/ribo-transcriber-managed-docs";
import { OnDeviceTranscriber } from "@azx/ribo-transcriber-ondevice";
import { PdfjsTranscriber } from "@azx/ribo-transcriber-pdfjs";
import { useRecorder } from "@azx/ribo-ui-react";

// One referenced symbol per package: keeping every import live is the point, so
// `noUnusedLocals`-style pruning would defeat the proof.
export const oneSymbolPerPackage = {
  core: FakeTranscriber,
  uiReact: useRecorder,
  adapterSnuggpro: snuggProAdapter,
  chatOpenai: openAiChat,
  chatHelix: helixChat,
  extractorOndevice: threePhaseExtractor,
  extractorSystemone: systemOnePresencePhase,
  systemoneManaged: systemOneClient,
  storageRxdb: openRxdbBackend,
  transcriberManaged: ManagedTranscriber,
  transcriberManagedDocs: ManagedDocsTranscriber,
  transcriberOndevice: OnDeviceTranscriber,
  transcriberPdfjs: PdfjsTranscriber,
} satisfies Record<string, unknown>;

export type AnyTranscriber = Transcriber | Transcriber<DocumentCapture>;
