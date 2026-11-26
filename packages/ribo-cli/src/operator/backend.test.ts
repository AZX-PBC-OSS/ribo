/**
 * @file Shared backend preparation, checked against eval's existing adapters.
 * Every transport is stubbed: no installed CLI, network, credential or spend.
 */
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { ChatRequest } from "@azx/ribo-core";

import {
  createCliBackendChat as createEvalCliBackendChat,
  createOpenAiCompatibleChat as createEvalOpenAiCompatibleChat,
} from "../eval/backend.js";
import { EvalError } from "../eval/error.js";
import { lookupSecret } from "../eval/secrets.js";
import {
  OPERATOR_BACKENDS,
  cliBackendNameFor,
  createCliBackendChat,
  createOpenAiCompatibleChat,
  prepareOperatorBackend,
} from "./backend.js";
import { OperatorError } from "./error.js";

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

interface RecordedCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly stdin: FakeStdin;
}

class FakeStdin extends EventEmitter {
  private readonly chunks: Buffer[] = [];
  write(chunk: string): boolean {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }
  end(): void {}
  get text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

interface ScriptedResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly spawnError?: Error;
  readonly hang?: boolean;
}

function fakeSpawn(script: (call: RecordedCall, callIndex: number) => ScriptedResult): {
  spawnImpl: typeof spawn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const spawnImpl = ((cmd: string, args: readonly string[]) => {
    const stdin = new FakeStdin();
    const call = { cmd, args, stdin };
    calls.push(call);
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(child, { stdout, stderr, stdin, kill: vi.fn() });
    const result = script(call, calls.length - 1);
    queueMicrotask(() => {
      if (result.spawnError !== undefined) {
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

interface WireRequest {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

const stubFetch = (received: WireRequest[]): typeof fetch => {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    received.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown,
    });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("shared operator backends", () => {
  test("every shared backend preserves eval transport, request, executable and argv parity through stub fetch/spawn", async () => {
    const sharedWire: WireRequest[] = [];
    const evalWire: WireRequest[] = [];
    const sharedHttp = createOpenAiCompatibleChat({
      baseUrl: "https://endpoint.invalid/v1",
      apiKey: "test-key",
      fetchImpl: stubFetch(sharedWire),
    });
    const evalHttp = createEvalOpenAiCompatibleChat({
      baseUrl: "https://endpoint.invalid/v1",
      apiKey: "test-key",
      fetchImpl: stubFetch(evalWire),
    });

    expect(await sharedHttp.complete(REQUEST)).toEqual(await evalHttp.complete(REQUEST));
    expect(sharedWire).toEqual(evalWire);
    expect(sharedWire[0]?.url).toBe("https://endpoint.invalid/v1/chat/completions");

    for (const backend of ["claude-cli", "codex-cli"] as const) {
      const sharedProcess = fakeSpawn(() => ({ stdout: '{"ok":true}' }));
      const evalProcess = fakeSpawn(() => ({ stdout: '{"ok":true}' }));
      const shared = createCliBackendChat(backend, {
        timeoutMs: 5_000,
        spawnImpl: sharedProcess.spawnImpl,
      });
      const legacy = createEvalCliBackendChat(backend, {
        timeoutMs: 5_000,
        spawnImpl: evalProcess.spawnImpl,
      });

      expect(await shared.complete(REQUEST)).toEqual(await legacy.complete(REQUEST));
      expect(
        sharedProcess.calls.map((call) => ({
          cmd: call.cmd,
          args: call.args,
          prompt: call.stdin.text,
        })),
      ).toEqual(
        evalProcess.calls.map((call) => ({
          cmd: call.cmd,
          args: call.args,
          prompt: call.stdin.text,
        })),
      );
      expect(sharedProcess.calls[0]?.cmd).toBe(cliBackendNameFor(backend));

      vi.useFakeTimers();
      const sharedTimeout = fakeSpawn(() => ({ hang: true }));
      const evalTimeout = fakeSpawn(() => ({ hang: true }));
      const sharedPending = createCliBackendChat(backend, {
        timeoutMs: 5_000,
        spawnImpl: sharedTimeout.spawnImpl,
      }).complete(REQUEST);
      const evalPending = createEvalCliBackendChat(backend, {
        timeoutMs: 5_000,
        spawnImpl: evalTimeout.spawnImpl,
      }).complete(REQUEST);
      const sharedRejection = expect(sharedPending).rejects.toThrow(/did not respond within 5s/u);
      const evalRejection = expect(evalPending).rejects.toThrow(/did not respond within 5s/u);
      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.all([sharedRejection, evalRejection]);
      vi.useRealTimers();
    }
  });

  test("CLI preflight refusal names the selected executable and is an OperatorError", async () => {
    for (const backend of ["claude-cli", "codex-cli"] as const) {
      const binary = cliBackendNameFor(backend);
      const process = fakeSpawn(() => ({
        spawnError: Object.assign(new Error(`spawn ${binary} ENOENT`), { code: "ENOENT" }),
      }));

      let error: unknown;
      try {
        await prepareOperatorBackend({ backend, requiredCalls: 1, spawnImpl: process.spawnImpl });
        throw new Error("expected preflight to refuse");
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperatorError);
      expect(error).not.toBeInstanceOf(EvalError);
      expect((error as Error).message).toContain(binary);
      expect((error as Error).message).toContain("not found on PATH");
      expect(process.calls).toHaveLength(1);
      expect(process.calls[0]?.cmd).toBe(binary);
      expect(process.calls[0]?.args).toEqual(["--version"]);
    }
  });

  test("backend setup reads only environment or cwd .env.local credentials, preserves environment precedence and exposes no credential flag", async () => {
    const readFileImpl = vi.fn((_file: string) => "OPENAI_API_KEY=file-test-key\n");
    const lookupSecretImpl = vi.fn<typeof lookupSecret>((key, options) =>
      lookupSecret(key, options),
    );
    const environmentWire: WireRequest[] = [];
    const environmentChat = await prepareOperatorBackend({
      backend: "openai-compatible",
      requiredCalls: 1,
      env: { OPENAI_API_KEY: "environment-test-key" },
      cwd: "/tmp/operator-backend",
      readFileImpl,
      lookupSecretImpl,
      fetchImpl: stubFetch(environmentWire),
    });

    expect(environmentChat).toBeDefined();
    await environmentChat?.complete(REQUEST);
    expect(lookupSecretImpl).toHaveBeenCalledWith(
      "OPENAI_API_KEY",
      expect.objectContaining({ cwd: "/tmp/operator-backend" }),
    );
    expect(readFileImpl).not.toHaveBeenCalled();
    expect(environmentWire[0]?.authorization).toBe("Bearer environment-test-key");

    const fileWire: WireRequest[] = [];
    const fileChat = await prepareOperatorBackend({
      backend: "openai-compatible",
      requiredCalls: 1,
      env: {},
      cwd: "/tmp/operator-backend",
      readFileImpl,
      fetchImpl: stubFetch(fileWire),
    });
    await fileChat?.complete(REQUEST);
    expect(readFileImpl).toHaveBeenCalledWith("/tmp/operator-backend/.env.local");
    expect(fileWire[0]?.authorization).toBe("Bearer file-test-key");

    const cliProcess = fakeSpawn(() => ({ stdout: '{"ok":true}' }));
    const cliLookup = vi.fn<typeof lookupSecret>();
    const cliChat = await prepareOperatorBackend({
      backend: "claude-cli",
      requiredCalls: 1,
      env: { OPENAI_API_KEY: "never-an-argv-value" },
      lookupSecretImpl: cliLookup,
      preflightImpl: vi.fn(async () => {}),
      spawnImpl: cliProcess.spawnImpl,
    });
    await cliChat?.complete(REQUEST);
    expect(cliLookup).not.toHaveBeenCalled();
    expect(cliProcess.calls[0]?.args.join(" ")).not.toContain("never-an-argv-value");
  });

  test("zero-required-call authoring returns no client and never invokes preflight or secret lookup", async () => {
    for (const backend of OPERATOR_BACKENDS) {
      const preflightImpl = vi.fn(async () => {});
      const lookupSecretImpl = vi.fn<typeof lookupSecret>();
      const readFileImpl = vi.fn((_file: string) => undefined);

      await expect(
        prepareOperatorBackend({
          backend,
          requiredCalls: 0,
          preflightImpl,
          lookupSecretImpl,
          readFileImpl,
          env: {},
        }),
      ).resolves.toBeUndefined();

      expect(preflightImpl).not.toHaveBeenCalled();
      expect(lookupSecretImpl).not.toHaveBeenCalled();
      expect(readFileImpl).not.toHaveBeenCalled();
    }
  });
});
