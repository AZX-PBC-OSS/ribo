/**
 * @file Hermetic unit tests for `/api/extract`'s backend resolution.
 *
 * These NEVER shell a real CLI, hit the network, or probe the real machine's PATH:
 * `resolveBackend` takes an injected `env` and an injected `onPath` predicate, and
 * `isOnPath` is exercised against a temp directory we create — not the developer's
 * actual tools. The precedence ladder is the whole point of this suite, so each
 * rung is pinned against the ones above and below it.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { isOnPath, resolveBackend } from "./vite-extract.js";

/** No CLI is ever "on PATH" unless a test says so — keeps auto-detect deterministic. */
const NONE_ON_PATH = () => false;
const onlyOnPath =
  (...present: string[]) =>
  (cmd: string) =>
    present.includes(cmd);

describe("resolveBackend precedence", () => {
  test("RIBO_EXTRACT_FAKE=1 wins over a key, a force, and every CLI", () => {
    const backend = resolveBackend(
      {
        RIBO_EXTRACT_FAKE: "1",
        RIBO_EXTRACT_BACKEND: "claude",
        OPENAI_API_KEY: "sk-test",
      },
      onlyOnPath("claude", "codex", "opencode"),
    );
    // Presents as codex (its keyless stand-in) — the e2e depends on this label.
    expect(backend).toMatchObject({ kind: "fake", report: "codex", model: "gpt-5.6" });
  });

  test("RIBO_EXTRACT_BACKEND forces a CLI even when it is NOT on PATH", () => {
    for (const name of ["claude", "codex", "opencode"] as const) {
      const backend = resolveBackend({ RIBO_EXTRACT_BACKEND: name }, NONE_ON_PATH);
      expect(backend).toMatchObject({ kind: "cli", descriptor: { name } });
    }
  });

  test("RIBO_EXTRACT_BACKEND=openai needs a key, else unavailable", () => {
    expect(resolveBackend({ RIBO_EXTRACT_BACKEND: "openai" }, NONE_ON_PATH)).toMatchObject({
      kind: "unavailable",
    });
    expect(
      resolveBackend({ RIBO_EXTRACT_BACKEND: "openai", OPENAI_API_KEY: "sk-x" }, NONE_ON_PATH),
    ).toMatchObject({ kind: "openai", apiKey: "sk-x" });
  });

  test("RIBO_EXTRACT_BACKEND with an unknown name is unavailable", () => {
    expect(resolveBackend({ RIBO_EXTRACT_BACKEND: "gpt5" }, NONE_ON_PATH)).toMatchObject({
      kind: "unavailable",
    });
  });

  test("OPENAI_API_KEY beats CLI auto-detection", () => {
    const backend = resolveBackend(
      { OPENAI_API_KEY: "sk-test" },
      onlyOnPath("claude", "codex", "opencode"),
    );
    expect(backend).toMatchObject({
      kind: "openai",
      apiKey: "sk-test",
      model: "gpt-4o-2024-08-06",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  test("OPENAI_MODEL / OPENAI_BASE_URL override the openai defaults", () => {
    const backend = resolveBackend(
      {
        OPENAI_API_KEY: "sk-test",
        OPENAI_MODEL: "some-model",
        OPENAI_BASE_URL: "https://proxy.example/v1",
      },
      NONE_ON_PATH,
    );
    expect(backend).toMatchObject({
      kind: "openai",
      model: "some-model",
      baseUrl: "https://proxy.example/v1",
    });
  });

  test("auto-detect prefers claude, then codex, then opencode", () => {
    expect(resolveBackend({}, onlyOnPath("claude", "codex", "opencode"))).toMatchObject({
      kind: "cli",
      descriptor: { name: "claude" },
    });
    expect(resolveBackend({}, onlyOnPath("codex", "opencode"))).toMatchObject({
      kind: "cli",
      descriptor: { name: "codex" },
    });
    expect(resolveBackend({}, onlyOnPath("opencode"))).toMatchObject({
      kind: "cli",
      descriptor: { name: "opencode" },
    });
  });

  test("no key and no CLI on PATH is a clear unavailable error", () => {
    const backend = resolveBackend({}, NONE_ON_PATH);
    expect(backend).toMatchObject({ kind: "unavailable" });
    if (backend.kind === "unavailable") {
      expect(backend.message).toMatch(/OPENAI_API_KEY/);
      expect(backend.message).toMatch(/claude, codex or opencode/);
    }
  });
});

describe("isOnPath", () => {
  let dir: string;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  test("finds an executable in a PATH directory and rejects a missing one", () => {
    dir = mkdtempSync(join(tmpdir(), "ribo-onpath-"));
    const exe = join(dir, "faketool");
    writeFileSync(exe, "#!/bin/sh\necho hi\n");
    chmodSync(exe, 0o755);

    const env = { PATH: `${dir}${delimiter}/nonexistent-dir` };
    expect(isOnPath("faketool", env)).toBe(true);
    expect(isOnPath("no-such-tool", env)).toBe(false);
  });

  test("empty PATH finds nothing", () => {
    expect(isOnPath("faketool", { PATH: "" })).toBe(false);
    expect(isOnPath("faketool", {})).toBe(false);
  });
});
