/**
 * @file The CLI backend preflight's own tests: the probe resolves when the
 * binary answers, and refuses — with the cause and the fix — when it does not.
 *
 * `spawn` is INJECTED with a fake, exactly as the CLI transport's own tests
 * inject it: no real `claude`/`codex` process, no network, no key, no spend.
 * The timeout case needs no fake timers either, because the timeout itself is
 * injectable.
 */
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

import { describe, expect, test, vi } from "vitest";

import { EvalError } from "./eval/error.js";
import { preflightCliBackend } from "./cli-preflight.js";
import type { CliBackendName } from "./cli-chat.js";

interface ScriptedResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly spawnError?: Error;
  /** Never emit `close` — a child that stays open. */
  readonly hang?: boolean;
}

interface RecordedCall {
  readonly cmd: string;
  readonly args: readonly string[];
}

/**
 * A fake `child_process.spawn` that scripts the one call it receives and
 * records the argv it was given.
 */
function fakeSpawn(script: (call: RecordedCall) => ScriptedResult): {
  spawnImpl: typeof spawn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const spawnImpl = ((cmd: string, args: readonly string[]) => {
    const call: RecordedCall = { cmd, args };
    calls.push(call);

    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(child, { stdout, stderr, kill: vi.fn() });

    const result = script(call);
    queueMicrotask(() => {
      if (result.spawnError) {
        child.emit("error", result.spawnError);
        return;
      }
      if (result.stdout !== undefined) stdout.emit("data", Buffer.from(result.stdout));
      if (result.stderr !== undefined) stderr.emit("data", Buffer.from(result.stderr));
      if (result.hang === true) return;
      child.emit("close", result.exitCode ?? 0);
    });
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, calls };
}

describe("preflightCliBackend — a binary that answers", () => {
  test.each(["claude", "codex"] as const)(
    "%s: one spawn of `--version`, and the probe resolves",
    async (backend: CliBackendName) => {
      const { spawnImpl, calls } = fakeSpawn(() => ({ stdout: "1.0.0" }));

      await expect(preflightCliBackend(backend, { spawnImpl })).resolves.toBeUndefined();

      expect(calls).toHaveLength(1);
      expect(calls[0]!.cmd).toBe(backend);
      expect(calls[0]!.args).toEqual(["--version"]);
    },
  );
});

describe("preflightCliBackend — a binary that does not answer", () => {
  test("a missing binary refuses with the not-found-on-PATH diagnostic and a fix", async () => {
    const { spawnImpl, calls } = fakeSpawn(() => ({
      spawnError: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
    }));

    let error: unknown;
    try {
      await preflightCliBackend("claude", { spawnImpl });
      throw new Error("expected the preflight to reject");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EvalError);
    const message = (error as Error).message;
    expect(message).toContain("claude");
    expect(message).toMatch(/not found on PATH/);
    expect(message).toContain("(fix:");
    // The refusal is up front: one probe, no second attempt.
    expect(calls).toHaveLength(1);
  });

  test("a non-zero `--version` exit refuses, naming the binary and the exit code", async () => {
    const { spawnImpl } = fakeSpawn(() => ({ stderr: "not signed in", exitCode: 3 }));

    let error: unknown;
    try {
      await preflightCliBackend("codex", { spawnImpl });
      throw new Error("expected the preflight to reject");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EvalError);
    const message = (error as Error).message;
    expect(message).toContain("codex");
    expect(message).toContain("--version");
    expect(message).toContain("3");
    expect(message).toContain("(fix:");
  });

  test("a binary that never answers refuses when the timeout elapses", async () => {
    const { spawnImpl, calls } = fakeSpawn(() => ({ hang: true }));

    let error: unknown;
    try {
      await preflightCliBackend("claude", { spawnImpl, timeoutMs: 10 });
      throw new Error("expected the preflight to reject");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EvalError);
    const message = (error as Error).message;
    expect(message).toContain("claude");
    expect(message).toContain("--version");
    expect(message).toContain("(fix:");
    expect(calls).toHaveLength(1);
  });
});
