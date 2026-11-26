import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { SCHEMA_PLAN_CONTRACT_VERSION } from "@azx/ribo-core";
import type { ChatClient, ChatRequest, SchemaPlan } from "@azx/ribo-core";

import { priceTokens } from "./eval/pricing.js";
import { schemaFingerprint } from "./inspect/fingerprint.js";
import { convertDocument } from "./inspect/convert.js";
import { walkFieldInventory } from "./inspect/field-inventory.js";
import { prepareOperatorBackend } from "./operator/backend.js";
import { OperatorError } from "./operator/error.js";
import {
  CHARS_PER_TOKEN,
  DEFAULT_COMPLETION_TOKENS,
  estimateFixedCallSpend,
} from "./operator/spend.js";
import type { FixedCallSpendEstimate } from "./operator/spend.js";
import { runSchemaPlanCommand } from "./schema-plan/command.js";
import { initialSchemaPlanPrompt } from "./schema-plan/prompt.js";

const document = {
  type: "object",
  properties: {
    home: {
      type: "object",
      description: "The home being audited.",
      properties: {
        address: { type: "string", description: "Street address." },
        yearBuilt: { type: "number", description: "Year of construction." },
      },
      required: ["address", "yearBuilt"],
    },
  },
  required: ["home"],
};

const incompleteReply = {
  pieces: [
    {
      name: "Address only",
      description: "An incomplete proposal that is valid against the wire schema.",
      key: "home",
      paths: ["home.address"],
    },
  ],
};

const existingPlan: SchemaPlan = {
  version: SCHEMA_PLAN_CONTRACT_VERSION,
  schemaFingerprint: schemaFingerprint(document),
  fieldPaths: ["home.address", "home.yearBuilt"],
  pieces: [
    {
      name: "Home identity",
      description: "Where the home is and when it was built.",
      key: "home",
      paths: ["home.address", "home.yearBuilt"],
    },
  ],
  provenance: {
    model: "earlier-stub",
    backend: "claude-cli",
    createdAt: "2026-10-01T02:03:04.000Z",
  },
};

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ribo-schema-plan-spend-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function input(
  documentValue: unknown,
  plan?: unknown,
): Promise<{
  readonly schema: string;
  readonly update?: string;
}> {
  const schema = join(directory, "schema.json");
  await writeFile(schema, JSON.stringify(documentValue));
  if (plan === undefined) return { schema };
  const update = join(directory, "plan.json");
  await writeFile(update, JSON.stringify(plan));
  return { schema, update };
}

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

/** Transient exits precede every schema-valid but semantically incomplete reply. */
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
        stderr.emit("data", Buffer.from("transient stub exit"));
        child.emit("close", 1);
        return;
      }
      stdout.emit("data", Buffer.from(JSON.stringify(incompleteReply)));
      child.emit("close", 0);
    });
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, calls: () => calls };
}

/** The same full request measurement the command prices, applied to observed calls. */
function observedPromptChars(request: ChatRequest): number {
  const messages = request.messages.reduce(
    (total, message) => total + message.content.length + 8,
    0,
  );
  return messages + JSON.stringify(request.responseFormat.json_schema.schema).length;
}

test("the estimate covers every semantic repair, network retry and authoring CLI attempt using the actual prompts", async () => {
  const paths = await input(document);
  const process = exhaustingSpawn();
  const preflight = vi.fn(async () => {});
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
    runSchemaPlanCommand(
      paths.schema,
      {
        backend: "claude-cli",
        model: "claude-haiku-5-5",
        maxSpend: 1000,
      },
      {
        cwd: directory,
        env: {},
        stdout: stdout.stream,
        stderr: stderr.stream,
        confirmation: null,
        prepareBackend,
        retryDelay: async () => {},
        estimateSpend: (input) => {
          const estimate = estimateFixedCallSpend(input);
          estimates.push(estimate);
          return estimate;
        },
      },
    ),
  ).rejects.toThrow(/exhausted its validation repairs/u);

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

  const expectedInitial = initialSchemaPlanPrompt({
    document,
    inventory: walkFieldInventory(convertDocument(document)),
    model: "claude-haiku-5-5",
  });
  expect(requests[0]).toEqual(expectedInitial);
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

test("an over-ceiling creation is refused before backend preparation or the chat stub", async () => {
  const paths = await input(document);
  const chat: ChatClient = {
    complete: vi.fn(async () => ({ content: JSON.stringify(incompleteReply) })),
  };
  const prepareBackend = vi.fn(async () => chat);
  const stdout = capturedStream();
  const stderr = capturedStream();
  const out = join(directory, "refused.json");

  const pending = runSchemaPlanCommand(
    paths.schema,
    {
      backend: "openai-compatible",
      model: "gpt-4o",
      responseCap: 128,
      maxSpend: 0.000001,
      out,
    },
    {
      cwd: directory,
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      confirmation: null,
      prepareBackend,
    },
  );
  await expect(pending).rejects.toBeInstanceOf(OperatorError);
  await expect(pending).rejects.toThrow("above the ceiling");

  expect(prepareBackend).not.toHaveBeenCalled();
  expect(chat.complete).not.toHaveBeenCalled();
  expect(stdout.text()).toBe("");
  expect(stderr.text()).toContain("spend estimate");
  await expect(readFile(out)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a removal-only update prices zero and never prepares a backend, preflights or reads a credential", async () => {
  const reduced = structuredClone(document);
  delete (reduced.properties.home.properties as Record<string, unknown>).yearBuilt;
  reduced.properties.home.required = ["address"];
  const paths = await input(reduced, existingPlan);
  const originalBytes = await readFile(paths.update!);
  const prepareBackend = vi.fn(async () => {
    throw new Error("zero-call update prepared a backend");
  });
  const stdout = capturedStream();
  const stderr = capturedStream();

  const result = await runSchemaPlanCommand(
    paths.schema,
    {
      backend: "openai-compatible",
      model: "unused-model",
      update: paths.update,
      maxSpend: 0,
    },
    {
      cwd: directory,
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      confirmation: null,
      prepareBackend,
    },
  );

  expect(result.estimate.usd).toBe(0);
  expect(result.estimate.worstCaseCalls).toBe(0);
  expect(result.plan.fieldPaths).toEqual(["home.address"]);
  expect(result.plan.provenance).toEqual(existingPlan.provenance);
  expect(prepareBackend).not.toHaveBeenCalled();
  expect(JSON.parse(stdout.text())).toEqual(result.plan);
  expect(stderr.text()).toContain("calls: at most 0");
  expect(stderr.text()).toContain("USD 0");
  expect(stderr.text()).toContain(
    "schema field membership drift: added [none]; removed [home.yearBuilt]",
  );
  expect(await readFile(paths.update!)).toEqual(originalBytes);
});
