/**
 * @file Schema-init spend bounds include the complete sample prompt and every
 * semantic, transport and CLI attempt, with refusal before backend work.
 */
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { ChatClient, ChatRequest, DocumentCapture, Transcriber } from "@azx/ribo-core";

import { priceTokens } from "./eval/pricing.js";
import { prepareOperatorBackend } from "./operator/backend.js";
import { OperatorError } from "./operator/error.js";
import {
  CHARS_PER_TOKEN,
  DEFAULT_COMPLETION_TOKENS,
  estimateFixedCallSpend,
} from "./operator/spend.js";
import type { FixedCallSpendEstimate } from "./operator/spend.js";
import { runSchemaInitCommand } from "./schema-init/command.js";
import { initialSchemaInitPrompt } from "./schema-init/prompt.js";
import { loadSchemaInitSamples } from "./schema-init/samples.js";
import type { SchemaInitSample } from "./schema-init/samples.js";

const DIRECT_TEXT = "Address: 1 Main Street\nYear built: 1984\nEvery direct byte is priced.\n";
const TRANSCRIBED_TEXT =
  "Chain replaced on the boiler.\nEvery transcribed word is present in the initial prompt.\n";
const invalidReply = JSON.stringify({
  root: {
    kind: "object",
    description: "An invalid but parseable proposal.",
    properties: [
      {
        name: "address",
        node: {
          kind: "string",
          description: "The address.",
          evidence: { source: "field-notes", quote: "this quote is absent" },
          // The strict wire form lists every member; an absent optional one arrives as null.
          optional: null,
          enum: null,
        },
      },
    ],
  },
});

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ribo-schema-init-spend-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function capturedStream(): { readonly stream: Writable; readonly text: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
}

class FakeStdin extends EventEmitter {
  write(_chunk: string): boolean {
    return true;
  }
  end(): void {}
}

/** Two transient exits precede each semantically invalid reply. */
function exhaustingSpawn(): { readonly spawnImpl: typeof spawn; readonly calls: () => number } {
  let calls = 0;
  const spawnImpl = (() => {
    calls += 1;
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(child, { stdout, stderr, stdin: new FakeStdin(), kill: vi.fn() });
    queueMicrotask(() => {
      if (calls % 3 !== 0) {
        stderr.emit("data", Buffer.from("transient schema-init stub exit"));
        child.emit("close", 1);
        return;
      }
      stdout.emit("data", Buffer.from(invalidReply));
      child.emit("close", 0);
    });
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, calls: () => calls };
}

function observedPromptChars(request: ChatRequest): number {
  const messages = request.messages.reduce(
    (total, message) => total + message.content.length + 8,
    0,
  );
  return messages + JSON.stringify(request.responseFormat.json_schema.schema).length;
}

async function sources(): Promise<readonly string[]> {
  const direct = join(directory, "field-notes.txt");
  await writeFile(direct, DIRECT_TEXT);
  const caseDirectory = join(directory, "document-case");
  await mkdir(caseDirectory);
  await writeFile(join(caseDirectory, "input.pdf"), new Uint8Array([1, 2, 3]));
  await writeFile(
    join(caseDirectory, "case.json"),
    JSON.stringify({
      id: "document-case",
      inputs: [
        {
          file: "input.pdf",
          kind: "document",
          capture: { capturedAt: "2026-02-11T08:15:00Z", pageCount: 1 },
        },
      ],
      expected: {},
    }),
  );
  return [direct, caseDirectory];
}

test("the estimate prices every complete sample and all repair, transport and CLI layers before chat", async () => {
  const inputs = await sources();
  const process = exhaustingSpawn();
  const preflight = vi.fn(async () => {});
  const transcribe = vi.fn((capture: DocumentCapture) =>
    Promise.resolve({
      recordingId: capture.id,
      text: TRANSCRIBED_TEXT,
      engine: "schema-init-stub",
    }),
  );
  const transcriber: Transcriber<DocumentCapture> = {
    engine: "schema-init-stub",
    capability: () => Promise.resolve({ status: "ready" }),
    transcribe,
  };
  let loaded: readonly SchemaInitSample[] = [];
  const loadSamples = async (paths: readonly string[]): Promise<readonly SchemaInitSample[]> => {
    loaded = await loadSchemaInitSamples(paths, { transcriber });
    return loaded;
  };
  const requests: ChatRequest[] = [];
  const actualUsage: { promptTokens: number; completionTokens: number }[] = [];
  const estimates: FixedCallSpendEstimate[] = [];
  const stdout = capturedStream();
  const stderr = capturedStream();

  const prepareBackend = async (
    options: Parameters<typeof prepareOperatorBackend>[0],
  ): Promise<ChatClient | undefined> => {
    const client = await prepareOperatorBackend({
      ...options,
      preflightImpl: preflight,
      spawnImpl: process.spawnImpl,
    });
    if (client === undefined) return undefined;
    return {
      async complete(request, callOptions) {
        requests.push(request);
        const completion = await client.complete(request, callOptions);
        const usage = {
          promptTokens: Math.ceil(observedPromptChars(request) / CHARS_PER_TOKEN),
          completionTokens: request.maxTokens ?? DEFAULT_COMPLETION_TOKENS,
        };
        actualUsage.push(usage);
        return { ...completion, usage };
      },
    };
  };

  await expect(
    runSchemaInitCommand(
      inputs,
      { backend: "claude-cli", model: "claude-haiku-5-5", maxSpend: 1000 },
      {
        cwd: directory,
        env: {},
        stdout: stdout.stream,
        stderr: stderr.stream,
        confirmation: null,
        loadSamples,
        prepareBackend,
        retryDelay: async () => {},
        estimateSpend: (input) => {
          const estimate = estimateFixedCallSpend(input);
          estimates.push(estimate);
          return estimate;
        },
      },
    ),
  ).rejects.toThrow(/exhausted its named repairs/u);

  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(estimates).toHaveLength(1);
  const estimate = estimates[0]!;
  expect(estimate.budget).toEqual({
    initialCalls: 1,
    semanticRepairs: 2,
    transportRetries: 2,
    cliShapeAttempts: 1,
  });
  expect(estimate.worstCaseCalls).toBe(9);
  expect(requests).toHaveLength(estimate.worstCaseCalls);
  expect(process.calls()).toBe(estimate.worstCaseCalls);
  expect(preflight).toHaveBeenCalledTimes(1);
  expect(stdout.text()).toBe("");

  const expectedInitial = initialSchemaInitPrompt(loaded, "claude-haiku-5-5");
  expect(requests[0]).toEqual(expectedInitial);
  expect(requests[0]?.messages.map((message) => message.content).join("\n")).toContain(DIRECT_TEXT);
  expect(requests[0]?.messages.map((message) => message.content).join("\n")).toContain(
    TRANSCRIBED_TEXT,
  );
  expect(requests[1]).toEqual(expectedInitial);
  expect(requests[2]).toEqual(expectedInitial);
  expect(requests[3]?.messages.at(-1)?.content).toContain("Repair 1:");
  expect(requests[6]?.messages.at(-1)?.content).toContain("Repair 2:");

  const actualPromptTokens = requests.reduce(
    (total, request) => total + Math.ceil(observedPromptChars(request) / CHARS_PER_TOKEN),
    0,
  );
  const actualCompletionTokens = actualUsage.reduce(
    (total, usage) => total + usage.completionTokens,
    0,
  );
  const actualUsd = priceTokens(estimate.price, actualPromptTokens, actualCompletionTokens);
  expect(estimate.worstCasePromptTokens).toBeGreaterThanOrEqual(actualPromptTokens);
  expect(estimate.worstCaseCompletionTokens).toBe(requests.length * DEFAULT_COMPLETION_TOKENS);
  expect(estimate.worstCaseCompletionTokens).toBeGreaterThanOrEqual(actualCompletionTokens);
  expect(estimate.usd).toBeGreaterThanOrEqual(actualUsd);
  expect(stderr.text()).toContain("semantic repairs +2");
  expect(stderr.text()).toContain("transport retries +2");
  expect(stderr.text()).toContain("CLI shape attempts ×1");
});

test("--max-spend refuses after transcription but before backend preparation, chat or either destination", async () => {
  const inputs = await sources();
  const transcribe = vi.fn((capture: DocumentCapture) =>
    Promise.resolve({ recordingId: capture.id, text: TRANSCRIBED_TEXT, engine: "stub" }),
  );
  const transcriber: Transcriber<DocumentCapture> = {
    engine: "stub",
    capability: () => Promise.resolve({ status: "ready" }),
    transcribe,
  };
  const chat: ChatClient = { complete: vi.fn(async () => ({ content: invalidReply })) };
  const prepareBackend = vi.fn(async () => chat);
  const stdout = capturedStream();
  const stderr = capturedStream();
  const out = join(directory, "refused.json");
  const corpus = join(directory, "refused-corpus");

  const pending = runSchemaInitCommand(
    inputs,
    {
      backend: "openai-compatible",
      model: "gpt-4o",
      responseCap: 128,
      maxSpend: 0.000001,
      out,
      corpus,
      corpusName: "Refused corpus",
      corpusProvenance: "synthetic",
    },
    {
      cwd: directory,
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      confirmation: null,
      loadSamples: (paths) => loadSchemaInitSamples(paths, { transcriber }),
      prepareBackend,
    },
  );
  await expect(pending).rejects.toBeInstanceOf(OperatorError);
  await expect(pending).rejects.toThrow("above the ceiling");

  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(prepareBackend).not.toHaveBeenCalled();
  expect(chat.complete).not.toHaveBeenCalled();
  expect(stdout.text()).toBe("");
  expect(stderr.text()).toContain("spend estimate");
  await expect(readFile(out)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(corpus)).rejects.toMatchObject({ code: "ENOENT" });
});
