import { expect, test } from "vitest";

// The browser project's counterpart to
// packages/ribo-adapter-snuggpro/src/workspace-resolution.test.ts.
//
// Imported by *package name*, not by relative path — a smoke test that this
// tier can resolve a workspace package at all, the same way that file smoke-
// tests the `unit` project.
//
// This does NOT prove the `browser` project's `resolve.conditions` block in
// vitest.config.ts is intact, despite what an earlier version of this comment
// claimed ("verified by deleting that block and watching this file fail").
// That was true only while no package had a built `dist/`. `@azx/ribo-core`'s
// `exports` has a `default` fallback to `dist/index.js`, and `./check.sh`
// always runs `build:packages` before `test`, so by the time this test runs
// `dist/` exists and this import succeeds identically whether or not the
// `@azx/source` condition is applied. R2 found that deleting the block left
// this test green. The condition itself is guarded by `pnpm check:resolve`
// (`scripts/assert-source-condition.mjs`), which loads vitest.config.ts
// through Vitest's own `createVitest` and asserts the resolved
// `resolve.conditions` directly — that is the gate that actually fails when
// the block is lost, and the one to read for how this is really proven.
//
// The imported symbol is incidental — swap it for any other real
// `@azx/ribo-core` export as the package evolves. The *import style* is the
// load-bearing part: keep it a bare package-name import, never a relative path.
import { isSpanGrounded } from "@azx/ribo-core";

test("resolves a workspace dependency by package name via the @azx/source condition", () => {
  expect(isSpanGrounded("R-19", "The attic is R-19")).toBe(true);
});

// A cheap sanity check that this really is a browser and not jsdom or node: a
// live `MediaRecorder` constructor is exactly what the unit tier cannot offer,
// and it is the reason Phase 2 needed this project at all.
test("runs in a real browser with the capture APIs Phase 2 depends on", () => {
  expect(typeof MediaRecorder).toBe("function");
  expect(MediaRecorder.isTypeSupported("audio/webm;codecs=opus")).toBe(true);
  expect(typeof navigator.mediaDevices?.getUserMedia).toBe("function");
  expect(typeof indexedDB).toBe("object");
});

// Proves the two `--use-fake-*-for-media-stream` launch flags in
// vitest.config.ts are actually applied. Without them this call either rejects
// with NotFoundError (no capture hardware on a CI runner) or hangs forever
// waiting on a permission prompt nobody can click. Task 2's Recorder is built
// entirely on top of this working unattended, so it is worth one assertion
// here rather than an inscrutable timeout there.
test("getUserMedia resolves unattended to a synthetic audio track", async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    const tracks = stream.getAudioTracks();
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.readyState).toBe("live");
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
});
