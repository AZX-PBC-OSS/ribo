/**
 * @file Key-free CI tests for the CLI-backed transport. `spawn` is INJECTED with a fake — no
 * real `claude`/`codex` process, no network, no key — so these run in `./check.sh` exactly like
 * `openai-chat.test.ts` runs key-free against a fake `fetch`. They pin: the prompt carries the
 * schema and the conversation, a conforming first reply needs no retry, a non-conforming reply
 * is retried with the validation error fed back in, exhausting every attempt throws a clear
 * error (and still reports the shape verdict), a CLI that cannot even be started fails fast
 * WITHOUT burning the retry budget or reporting a shape verdict, and a non-zero exit is treated
 * as a retryable attempt rather than a fatal one.
 */

import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

import { describe, expect, test, vi } from "vitest";

import type { ChatRequest } from "@azx/ribo-extractor-openai";

import { cliChat, extractLastJsonObject } from "./cli-chat.js";
import type { CliShapeResult } from "./cli-chat.js";

/** A minimal request carrying a small, real JSON Schema — enough for ajv to actually validate
 *  a reply against, which is the whole point of this transport. */
const sampleRequest: ChatRequest = {
  model: "n/a — the CLI ignores this",
  messages: [
    { role: "system", content: "SYSTEM-INSTRUCTIONS-MARKER" },
    { role: "user", content: "TRANSCRIPT-TEXT-MARKER" },
  ],
  response_format: {
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

interface ScriptedResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly spawnError?: Error;
}

interface RecordedCall {
  readonly cmd: string;
  readonly args: readonly string[];
}

/** A fake `child_process.spawn` that scripts each successive call by index and records the
 *  argv it was given, so a test can both assert on the prompt sent and control the reply. Cast
 *  ONCE to `typeof spawn` here — cliChat's real contract — rather than at every call site, so no
 *  test below needs its own `any`. */
function fakeSpawn(script: (call: RecordedCall, callIndex: number) => ScriptedResult): {
  spawnImpl: typeof spawn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const spawnImpl = ((cmd: string, args: readonly string[]) => {
    const callIndex = calls.length;
    const call: RecordedCall = { cmd, args };
    calls.push(call);

    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(child, { stdout, stderr, kill: vi.fn() });

    const result = script(call, callIndex);
    queueMicrotask(() => {
      if (result.spawnError) {
        child.emit("error", result.spawnError);
        return;
      }
      if (result.stdout !== undefined) stdout.emit("data", Buffer.from(result.stdout));
      if (result.stderr !== undefined) stderr.emit("data", Buffer.from(result.stderr));
      child.emit("close", result.exitCode ?? 0);
    });
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, calls };
}

describe("cliChat — prompt carries the schema and the conversation", () => {
  test("the prompt sent to the CLI includes every message and the JSON Schema, and states the reply must conform", async () => {
    const { spawnImpl, calls } = fakeSpawn(() => ({ stdout: '{"ok":true}' }));
    const chat = cliChat({ backend: "claude", spawnImpl });

    await chat.complete(sampleRequest);

    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.args[1]!; // claude's argv is ["-p", prompt, ...]
    expect(prompt).toContain("SYSTEM-INSTRUCTIONS-MARKER");
    expect(prompt).toContain("TRANSCRIPT-TEXT-MARKER");
    expect(prompt).toContain(
      JSON.stringify(sampleRequest.response_format.json_schema.schema, null, 2),
    );
    expect(prompt).toMatch(/conforms EXACTLY|MUST be a single JSON object/);
  });

  test("claude's argv denies tool use and closes stdin via a manual permission mode", async () => {
    const { spawnImpl, calls } = fakeSpawn(() => ({ stdout: '{"ok":true}' }));
    const chat = cliChat({ backend: "claude", spawnImpl });
    await chat.complete(sampleRequest);
    expect(calls[0]!.cmd).toBe("claude");
    expect(calls[0]!.args).toContain("--permission-mode");
    expect(calls[0]!.args).toContain("--disallowed-tools");
  });

  test("codex's argv runs the keyless read-only sandbox", async () => {
    const { spawnImpl, calls } = fakeSpawn(() => ({ stdout: '{"ok":true}' }));
    const chat = cliChat({ backend: "codex", spawnImpl });
    await chat.complete(sampleRequest);
    expect(calls[0]!.cmd).toBe("codex");
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining(["exec", "--skip-git-repo-check", "--sandbox", "read-only"]),
    );
  });
});

describe("cliChat — shape conformance is a first-class, separately-reported result", () => {
  test("a conforming first reply needs no retry: one call, attempts=1", async () => {
    const { spawnImpl, calls } = fakeSpawn(() => ({ stdout: 'banner text\n{"ok":true}\ntrailer' }));
    const shapeResults: CliShapeResult[] = [];
    const chat = cliChat({
      backend: "codex",
      spawnImpl,
      onShapeResult: (r) => shapeResults.push(r),
    });

    const completion = await chat.complete(sampleRequest);

    expect(completion).toEqual({ content: '{"ok":true}' });
    expect(calls).toHaveLength(1);
    expect(shapeResults).toEqual([{ backend: "codex", attempts: 1, conforming: true }]);
  });

  test("a non-conforming reply is retried, with the validation error fed back in, until it conforms", async () => {
    const { spawnImpl, calls } = fakeSpawn((_call, i) =>
      i === 0 ? { stdout: '{"ok":"not-a-boolean"}' } : { stdout: '{"ok":true}' },
    );
    const shapeResults: CliShapeResult[] = [];
    const chat = cliChat({
      backend: "codex",
      spawnImpl,
      onShapeResult: (r) => shapeResults.push(r),
    });

    const completion = await chat.complete(sampleRequest);

    expect(completion).toEqual({ content: '{"ok":true}' });
    expect(calls).toHaveLength(2);
    // The retry prompt repeats the schema AND shows what went wrong with the first reply.
    const retryPrompt = calls[1]!.args.at(-1)!; // codex's argv is [..., prompt]
    expect(retryPrompt).toContain("did NOT conform");
    expect(retryPrompt).toContain("not-a-boolean");
    expect(shapeResults).toEqual([{ backend: "codex", attempts: 2, conforming: true }]);
  });

  test("exhausting every attempt without conforming throws, and still reports conforming: false", async () => {
    const { spawnImpl, calls } = fakeSpawn(() => ({ stdout: "no JSON here at all, just prose" }));
    const shapeResults: CliShapeResult[] = [];
    const chat = cliChat({
      backend: "codex",
      spawnImpl,
      maxAttempts: 2,
      onShapeResult: (r) => shapeResults.push(r),
    });

    await expect(chat.complete(sampleRequest)).rejects.toThrow(
      /no schema-conforming JSON after 2 attempt/,
    );
    expect(calls).toHaveLength(2);
    expect(shapeResults).toEqual([{ backend: "codex", attempts: 2, conforming: false }]);
  });

  test("a CLI that cannot be started fails immediately — no retry burned, no shape verdict reported", async () => {
    const { spawnImpl, calls } = fakeSpawn(() => ({
      spawnError: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
    }));
    const shapeResults: CliShapeResult[] = [];
    const chat = cliChat({
      backend: "codex",
      spawnImpl,
      maxAttempts: 3,
      onShapeResult: (r) => shapeResults.push(r),
    });

    await expect(chat.complete(sampleRequest)).rejects.toThrow(
      /could not run codex.*installed and on PATH/,
    );
    expect(calls).toHaveLength(1); // no retry — a missing binary will not appear on attempt 2
    expect(shapeResults).toEqual([]); // a harness failure is not a shape verdict
  });

  test("a non-zero exit is a retryable attempt, not an immediate failure", async () => {
    const { spawnImpl, calls } = fakeSpawn((_call, i) =>
      i === 0 ? { stdout: "", stderr: "transient crash", exitCode: 1 } : { stdout: '{"ok":true}' },
    );
    const shapeResults: CliShapeResult[] = [];
    const chat = cliChat({
      backend: "claude",
      spawnImpl,
      onShapeResult: (r) => shapeResults.push(r),
    });

    const completion = await chat.complete(sampleRequest);

    expect(completion).toEqual({ content: '{"ok":true}' });
    expect(calls).toHaveLength(2);
    expect(shapeResults).toEqual([{ backend: "claude", attempts: 2, conforming: true }]);
  });
});

describe("extractLastJsonObject", () => {
  test("pulls the LAST balanced top-level object out of surrounding text", () => {
    expect(extractLastJsonObject('banner\n{"a":1}\nmore text {"b":2} trailer')).toBe('{"b":2}');
  });

  test("respects nesting and quoted braces (a `}` inside a string never closes early)", () => {
    const text = '{"outer":{"inner":1},"note":"a } inside a string"}';
    expect(extractLastJsonObject(`chatter before ${text}`)).toBe(text);
  });

  test("returns null when there is no JSON object at all", () => {
    expect(extractLastJsonObject("just prose, no braces here")).toBeNull();
  });
});
