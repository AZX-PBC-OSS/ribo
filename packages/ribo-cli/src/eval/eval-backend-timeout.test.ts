/**
 * @file The eval CLI backends' per-call timeout: `createCliBackendChat`
 * forwards a `timeoutMs` to `cliChat` unchanged, and without one defaults to
 * the eval command's own 600 s — five times the transport's 120 s default,
 * because a large-document corpus's prompt takes a CLI minutes to answer.
 *
 * The transport's timeout is only observable as a clock, so the suites pin
 * the VALUE it computes with instead: cliChat's failure message states the
 * timeout it was given ("did not respond within 5s"), over a fake `spawn`
 * whose child never answers. No real `claude`/`codex` process, no model
 * call; the timers are fake, so the suite asserts 600 s without waiting it.
 * The refusal of `--timeout` on the openai-compatible backend is the bin's,
 * and is pinned in `bin-eval-timeout.test.ts` against the built bin.
 *
 * Must-fail: before the flag existed the factory took no options, so the
 * 5000 ms below never reached the transport and the failure named 120 s; and
 * the default was the transport's 120 s, not the eval command's 600 s.
 */
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

import { afterEach, expect, test, vi } from "vitest";

import type { ChatRequest } from "@azx/ribo-core";

import { createCliBackendChat } from "./backend.js";

/** A minimal request carrying a small, real JSON Schema for ajv to compile. */
const REQUEST: ChatRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "TRANSCRIPT-TEXT-MARKER" }],
  responseFormat: {
    type: "json_schema",
    json_schema: {
      name: "t",
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
};

/**
 * A fake `spawn` whose child never answers: the only way one of its calls
 * ends is the transport's own timeout killing it, and the kill is recorded so
 * a test can prove the timeout — not a child exit — ended the call. Cast ONCE
 * to `typeof spawn`, the seam's real contract, rather than at every call.
 */
const neverAnswersSpawn = (): { spawnImpl: typeof spawn; killed: string[] } => {
  const killed: string[] = [];
  const spawnImpl = (() => {
    const child = new EventEmitter();
    Object.assign(child, {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), {
        write: () => true,
        end: () => {},
      }),
      kill: (signal: string) => {
        killed.push(signal);
        return true;
      },
    });
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, killed };
};

afterEach(() => {
  vi.useRealTimers();
});

test("the factory passes its timeoutMs through to cliChat unchanged — 5000 ms arrives as 5 s", async () => {
  vi.useFakeTimers();
  const { spawnImpl, killed } = neverAnswersSpawn();
  const chat = createCliBackendChat("claude-cli", { timeoutMs: 5000, spawnImpl });

  const completion = chat.complete(REQUEST);
  const rejection = expect(completion).rejects.toThrow(/did not respond within 5s/u);
  // Every attempt gets the same per-call timeout; the transport retries a
  // timed-out call, so advance through the whole attempt budget.
  await vi.advanceTimersByTimeAsync(3 * 5000);
  await rejection;

  // The message names the fix, and the kill — not a child exit — ended the call.
  await expect(completion).rejects.toThrow(/--timeout/u);
  expect(killed.length).toBeGreaterThan(0);
  expect(killed).toContain("SIGKILL");
});

test("without a timeoutMs the eval CLI-backend default is 600 s, not the transport's 120 s", async () => {
  vi.useFakeTimers();
  const { spawnImpl } = neverAnswersSpawn();
  const chat = createCliBackendChat("codex-cli", { spawnImpl });

  const completion = chat.complete(REQUEST);
  // The transport's own 120 s default would read "within 120s" here: the
  // message pins WHICH default the eval command's factory computed with.
  const rejection = expect(completion).rejects.toThrow(/did not respond within 600s/u);
  await vi.advanceTimersByTimeAsync(3 * 600_000);
  await rejection;
});
