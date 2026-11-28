/**
 * @file The corpus propose command's spend behaviour, over injected
 * dependencies — no real model, no network, no credential.
 *
 * Pinned here: the estimate is the sum of per-case bounds, each priced on its
 * own measured prompt; an over-ceiling run is refused before backend
 * preparation and names the backend's own cheaper fixes (the CLI refusals
 * never recommend `--response-cap`); a scripted worst case never exceeds the
 * estimate; the two-long-input per-case bound matches the same arithmetic
 * `operator/spend.ts` runs, and a chunk of two such cases fits under a
 * USD 5 ceiling; and the per-attempt growth term is bounded by the repair
 * request's problems cap, independent of `--response-cap`.
 */
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { ChatClient, ChatRequest } from "@azx/ribo-core";

import { priceFor, priceTokens } from "./eval/pricing.js";
import { prepareOperatorBackend } from "./operator/backend.js";
import { OperatorError } from "./operator/error.js";
import {
  CHARS_PER_TOKEN,
  DEFAULT_COMPLETION_TOKENS,
  estimateFixedCallSpend,
  sumFixedCallSpendEstimates,
} from "./operator/spend.js";
import type { FixedCallSpendInput } from "./operator/spend.js";
import { runCorpusProposeCommand } from "./corpus/propose-command.js";
import { PROPOSE_REPAIRS } from "./corpus/propose.js";
import {
  PROPOSE_REPAIR_PROBLEM_CHARS,
  PROPOSE_REPAIR_PROBLEMS_MAX,
} from "./corpus/propose-prompt.js";

const SCHEMA = {
  type: "object",
  properties: {
    frame: {
      type: "object",
      properties: {
        material: { type: "string", description: "The frame's material." },
        serial: { type: "string", description: "The frame's serial number." },
      },
      required: ["material", "serial"],
    },
    service: {
      type: "object",
      properties: {
        date: { type: "string", description: "The service date." },
        notes: { type: "string", description: "The service notes." },
      },
      required: ["date", "notes"],
    },
  },
  required: ["frame", "service"],
};

/** A reply the engine parses but that answers nothing — every asked leaf goes silent. */
const SILENT_REPLY = JSON.stringify({ items: [], collections: [] });

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ribo-corpus-propose-spend-"));
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
  readonly written: string[] = [];
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  end(): void {}
}

interface CorpusCaseSpec {
  readonly id: string;
  readonly files: readonly { readonly name: string; readonly text: string }[];
}

/** Write a text-only corpus of the given cases into the directory. */
async function writeCorpus(
  root: string,
  cases: readonly CorpusCaseSpec[],
  name = "spend-corpus",
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "schema.json"), `${JSON.stringify(SCHEMA, null, 2)}\n`);
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify(
      {
        name,
        schema: "schema.json",
        provenance: "synthetic",
        prompt: { instructions: "Extract." },
      },
      null,
      2,
    )}\n`,
  );
  for (const entry of cases) {
    const caseDir = join(root, entry.id);
    await mkdir(caseDir);
    for (const file of entry.files) {
      await writeFile(join(caseDir, file.name), file.text);
    }
    await writeFile(
      join(caseDir, "case.json"),
      `${JSON.stringify(
        {
          id: entry.id,
          inputs: entry.files.map((file) => ({ file: file.name, kind: "text" })),
          expected: {},
        },
        null,
        2,
      )}\n`,
    );
  }
}

function observedPromptChars(request: ChatRequest): number {
  const messages = request.messages.reduce(
    (total, message) => total + message.content.length + 8,
    0,
  );
  return messages + JSON.stringify(request.responseFormat.json_schema.schema).length;
}

/** A chat that answers every request with the silent reply, recording the requests. */
const silentChat = (): { readonly chat: ChatClient; readonly requests: ChatRequest[] } => {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: {
      async complete(request) {
        requests.push(request);
        return { content: SILENT_REPLY };
      },
    },
  };
};

interface Captured {
  readonly estimateInputs: FixedCallSpendInput[];
  readonly ceilingEstimates: { readonly usd: number }[];
  readonly prepareCalls: number;
  readonly stderrText: string;
  /** The requests the default silent chat saw (empty when a chat was supplied). */
  readonly requests: ChatRequest[];
}

/**
 * Run propose over the corpus with the spend seams captured. The chat answers
 * every request with the silent reply, so every asked leaf is proposed as an
 * absence and the run completes.
 */
async function runPropose(options: {
  readonly corpus: string;
  readonly backend: "openai-compatible" | "claude-cli" | "codex-cli";
  readonly model?: string;
  readonly maxSpend?: number;
  readonly responseCap?: number;
  readonly chat?: ChatClient;
}): Promise<Captured & { readonly runError: unknown }> {
  const estimateInputs: FixedCallSpendInput[] = [];
  const ceilingEstimates: { usd: number }[] = [];
  let prepareCalls = 0;
  const stdout = capturedStream();
  const stderr = capturedStream();
  const stubbed = silentChat();
  const chat = options.chat ?? stubbed.chat;
  let runError: unknown;
  try {
    await runCorpusProposeCommand(
      options.corpus,
      [],
      {
        backend: options.backend,
        model: options.model ?? "gpt-4o",
        ...(options.maxSpend === undefined ? {} : { maxSpend: options.maxSpend }),
        ...(options.responseCap === undefined ? {} : { responseCap: options.responseCap }),
      },
      {
        cwd: directory,
        env: {},
        stdout: stdout.stream,
        stderr: stderr.stream,
        confirmation: null,
        estimateSpend: (input) => {
          estimateInputs.push(input);
          return estimateFixedCallSpend(input);
        },
        prepareBackend: async () => {
          prepareCalls += 1;
          return chat;
        },
        enforceCeiling: async (input) => {
          ceilingEstimates.push({ usd: input.estimate.usd });
          // The real ceiling runs, so an over-ceiling refusal still throws.
          const { enforceOperatorSpendCeiling } = await import("./operator/spend.js");
          await enforceOperatorSpendCeiling(input);
        },
        retryDelay: async () => {},
      },
    );
  } catch (error) {
    runError = error;
  }
  return {
    estimateInputs,
    ceilingEstimates,
    prepareCalls,
    stderrText: stderr.text(),
    requests: stubbed.requests,
    runError,
  };
}

test("the estimate is the sum of per-case bounds, each priced on its own measured prompt", async () => {
  const corpus = join(directory, "corpus");
  await writeCorpus(corpus, [
    { id: "small", files: [{ name: "input.txt", text: "A short note.\n" }] },
    {
      id: "large",
      files: [{ name: "input.txt", text: `${"L".repeat(20_000)}\n` }],
    },
  ]);

  const captured = await runPropose({ corpus, backend: "openai-compatible" });

  expect(captured.runError).toBeUndefined();
  expect(captured.estimateInputs).toHaveLength(2);
  // Cases load sorted, so the capture order is deterministic; the two sizes
  // are materially different and each is measured on its own prompt.
  const sizes = captured.estimateInputs.map((input) => input.promptChars).sort((a, b) => a - b);
  expect(sizes[0]).toBeLessThan(10_000);
  expect(sizes[1]).toBeGreaterThan(20_000);
  const small = captured.estimateInputs.find((input) => input.promptChars < 10_000)!;
  const large = captured.estimateInputs.find((input) => input.promptChars > 20_000)!;
  expect(large.promptChars).toBeGreaterThan(small.promptChars);
  for (const input of captured.estimateInputs) {
    expect(input.budget).toEqual({
      initialCalls: 1,
      semanticRepairs: PROPOSE_REPAIRS,
      transportRetries: 2,
      cliShapeAttempts: 1,
    });
    expect(input.completionTokensPerCall).toBe(DEFAULT_COMPLETION_TOKENS);
  }
  // The ceiling received the sum of the per-case bounds.
  const summed = captured.estimateInputs.reduce(
    (total, input) => total + estimateFixedCallSpend(input).usd,
    0,
  );
  expect(captured.ceilingEstimates).toHaveLength(1);
  expect(captured.ceilingEstimates[0]!.usd).toBeCloseTo(summed, 12);
  expect(captured.prepareCalls).toBe(1);
  // The stderr display names the priced cases and the dated price basis.
  expect(captured.stderrText).toContain("ribo corpus propose:");
  expect(captured.stderrText).toContain("2 priced");
  expect(captured.stderrText).toContain("price:");
  expect(captured.stderrText).not.toContain("\x1b");
});

test("an over-ceiling HTTP run is refused before backend preparation, naming the HTTP fixes", async () => {
  const corpus = join(directory, "corpus");
  await writeCorpus(corpus, [{ id: "case-a", files: [{ name: "input.txt", text: "A note.\n" }] }]);

  const captured = await runPropose({ corpus, backend: "openai-compatible", maxSpend: 0.000001 });

  expect(captured.runError).toBeInstanceOf(OperatorError);
  expect(captured.runError).toHaveProperty("message", expect.stringContaining("above the ceiling"));
  expect(captured.prepareCalls).toBe(0);
  expect(captured.stderrText).toContain("spend estimate");
  // The HTTP refusal names every cheaper fix, `--response-cap` included.
  const message = (captured.runError as Error).message;
  expect(message).toContain("name fewer case ids");
  expect(message).toContain("--only");
  expect(message).toContain("--response-cap");
});

test.each(["claude-cli", "codex-cli"] as const)(
  "an over-ceiling %s refusal names fewer ids and --only, never --response-cap",
  async (backend) => {
    const corpus = join(directory, "corpus");
    await writeCorpus(corpus, [
      { id: "case-a", files: [{ name: "input.txt", text: "A note.\n" }] },
    ]);

    const captured = await runPropose({
      corpus,
      backend,
      model: "claude-haiku-5-5",
      maxSpend: 0.000001,
    });

    expect(captured.runError).toBeInstanceOf(OperatorError);
    expect(captured.prepareCalls).toBe(0);
    const message = (captured.runError as Error).message;
    expect(message).toContain("above the ceiling");
    expect(message).toContain("name fewer case ids");
    expect(message).toContain("--only");
    expect(message).not.toContain("--response-cap");
  },
);

test("the aggregate refuses a non-finite total and answers an empty run with zero", () => {
  const empty = sumFixedCallSpendEstimates([]);
  expect(empty.caseCount).toBe(0);
  expect(empty.usd).toBe(0);
  expect(empty.worstCaseCalls).toBe(0);

  const base = estimateFixedCallSpend({
    backend: "openai-compatible",
    model: "gpt-4o",
    budget: { initialCalls: 1 },
    promptChars: 100,
  });
  expect(() =>
    sumFixedCallSpendEstimates([base, { ...base, usd: Number.POSITIVE_INFINITY }]),
  ).toThrow(OperatorError);
});

test("every HTTP request carries the priced reply cap — initial, repair and retry alike", async () => {
  const corpus = join(directory, "corpus");
  await writeCorpus(corpus, [{ id: "case-a", files: [{ name: "input.txt", text: "A note.\n" }] }]);
  // The first reply is unparseable, so the engine's semantic repair round
  // runs; both rounds' requests must carry the same priced cap.
  let calls = 0;
  const requests: ChatRequest[] = [];
  const chat: ChatClient = {
    async complete(request) {
      calls += 1;
      requests.push(request);
      return { content: calls === 1 ? "not json" : SILENT_REPLY };
    },
  };
  const capped = await runPropose({ corpus, backend: "openai-compatible", responseCap: 512, chat });
  expect(capped.runError).toBeUndefined();
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.maxTokens).toBe(512);
  }

  // With no --response-cap, the default cap is what every request carries.
  const defaultCorpus = join(directory, "default");
  await writeCorpus(defaultCorpus, [
    { id: "case-a", files: [{ name: "input.txt", text: "A note.\n" }] },
  ]);
  const defaulted = await runPropose({ corpus: defaultCorpus, backend: "openai-compatible" });
  expect(defaulted.requests.length).toBeGreaterThanOrEqual(1);
  for (const request of defaulted.requests) {
    expect(request.maxTokens).toBe(DEFAULT_COMPLETION_TOKENS);
  }
});

/** Two transient failures precede each schema-nonconforming reply: the full six-attempt walk. */
function exhaustingSpawn(): {
  readonly spawnImpl: typeof spawn;
  readonly calls: () => number;
  readonly promptChars: () => number;
} {
  let calls = 0;
  let promptChars = 0;
  const spawnImpl = (() => {
    calls += 1;
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = new FakeStdin();
    Object.assign(child, { stdout, stderr, stdin, kill: vi.fn() });
    queueMicrotask(() => {
      promptChars += stdin.written.reduce((total, chunk) => total + chunk.length, 0);
      if (calls % 3 !== 0) {
        stderr.emit("data", Buffer.from("transient corpus-propose stub exit"));
        child.emit("close", 1);
        return;
      }
      // Conformable-looking JSON that is not a valid proposal: the
      // transport's own shape check (one CLI shape attempt) refuses nothing
      // here — the reply passes the wire schema — but the engine's parser
      // rejects the whitespace path, so one semantic repair round runs before
      // the case fails. Six spawns for one case, the priced worst case.
      stdout.emit(
        "data",
        Buffer.from(
          'stub banner\n{"items":[{"path":" ","value":null,"quote":null,"absent":true}],"collections":[]}\n',
        ),
      );
      child.emit("close", 0);
    });
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, calls: () => calls, promptChars: () => promptChars };
}

test("a scripted worst case never exceeds the estimate", async () => {
  const corpus = join(directory, "corpus");
  await writeCorpus(corpus, [
    { id: "case-a", files: [{ name: "input.txt", text: "A note for the worst case.\n" }] },
  ]);
  const processSpawn = exhaustingSpawn();
  const preflight = vi.fn(async () => {});
  const stdout = capturedStream();
  const stderr = capturedStream();
  const capturedInputs: FixedCallSpendInput[] = [];
  const requestedChars: number[] = [];

  const report = await runCorpusProposeCommand(
    corpus,
    [],
    { backend: "claude-cli", model: "claude-haiku-5-5" },
    {
      cwd: directory,
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      confirmation: null,
      retryDelay: async () => {},
      estimateSpend: (input) => {
        capturedInputs.push(input);
        return estimateFixedCallSpend(input);
      },
      prepareBackend: async (prepared) => {
        const client = await prepareOperatorBackend({
          ...prepared,
          preflightImpl: preflight,
          spawnImpl: processSpawn.spawnImpl,
        });
        if (client === undefined) throw new Error("the prepared backend is undefined");
        return {
          complete: async (request, callOptions) => {
            requestedChars.push(observedPromptChars(request));
            return client.complete(request, callOptions);
          },
        };
      },
    },
  );

  const caseReport = report.cases[0];
  expect(caseReport).toBeDefined();
  expect(caseReport!.outcome).toBe("failed");
  expect(caseReport!.proposed).toEqual([]);
  expect(caseReport!.unproposed).toHaveLength(4);
  // Every diagnostic names the command.
  expect(stderr.text()).toContain("ribo corpus propose: spend estimate");

  expect(capturedInputs).toHaveLength(1);
  const perCase = estimateFixedCallSpend(capturedInputs[0]!);
  // (1 initial + 1 semantic repair) × (1 + 2 transport retries) × 1 shape attempt.
  expect(perCase.worstCaseCalls).toBe(6);
  expect(perCase.budget.cliShapeAttempts).toBe(1);
  expect(processSpawn.calls()).toBe(perCase.worstCaseCalls);
  expect(preflight).toHaveBeenCalledTimes(1);
  // The requested prompts, tokenised the estimate's way, never exceed the bound.
  const observedPromptTokens = requestedChars.reduce(
    (total, chars) => total + Math.ceil(chars / CHARS_PER_TOKEN),
    0,
  );
  expect(observedPromptTokens).toBeLessThanOrEqual(perCase.worstCasePromptTokens);
  const observedUsd = priceTokens(perCase.price, observedPromptTokens, 0);
  expect(perCase.usd).toBeGreaterThanOrEqual(observedUsd);
});

/**
 * A corpus of `caseCount` cases, each with two text inputs of approximately
 * 60,000 characters.
 */
async function longCaseCorpus(name: string, caseCount: number): Promise<string> {
  const corpus = join(directory, name);
  const cases: CorpusCaseSpec[] = [];
  for (let index = 0; index < caseCount; index++) {
    cases.push({
      id: `long-case-${index}`,
      files: [
        { name: "first.txt", text: `${"A".repeat(60_000)} end of first.\n` },
        { name: "second.txt", text: `${"B".repeat(60_000)} end of second.\n` },
      ],
    });
  }
  await writeCorpus(corpus, cases);
  return corpus;
}

test("the two-long-input per-case bound matches the aggregate's own arithmetic and a chunk of two fits under USD 5", async () => {
  const corpus = await longCaseCorpus("long-one", 1);
  const estimateInputs: FixedCallSpendInput[] = [];
  let ceilingUsd: number | undefined;

  await runCorpusProposeCommand(
    corpus,
    [],
    { backend: "claude-cli", model: "claude-haiku-5-5" },
    {
      cwd: directory,
      env: {},
      stdout: capturedStream().stream,
      stderr: capturedStream().stream,
      confirmation: null,
      estimateSpend: (input) => {
        estimateInputs.push(input);
        return estimateFixedCallSpend(input);
      },
      enforceCeiling: async (input) => {
        ceilingUsd = input.estimate.usd;
      },
      prepareBackend: async () => silentChat().chat,
    },
  );

  expect(estimateInputs).toHaveLength(1);
  const input = estimateInputs[0]!;
  expect(input.promptChars).toBeGreaterThan(120_000);
  const price = priceFor("claude-cli", "claude-haiku-5-5");
  // The same arithmetic operator/spend.ts runs, recomputed independently:
  // base and growth tokens are separately ceiling-divided, six attempts make
  // fifteen growth steps, and the completion bound is six caps.
  const baseTokens = Math.ceil(input.promptChars / CHARS_PER_TOKEN);
  const growthTokens = Math.ceil((input.promptGrowthCharsPerAttempt ?? 0) / CHARS_PER_TOKEN);
  const attempts = 6;
  const expectedPromptTokens =
    attempts * baseTokens + ((attempts * (attempts - 1)) / 2) * growthTokens;
  const expectedCompletionTokens =
    attempts * (input.completionTokensPerCall ?? DEFAULT_COMPLETION_TOKENS);
  const expectedUsd = priceTokens(price, expectedPromptTokens, expectedCompletionTokens);
  const perCase = estimateFixedCallSpend(input);
  expect(perCase.worstCasePromptTokens).toBe(expectedPromptTokens);
  expect(perCase.worstCaseCompletionTokens).toBe(expectedCompletionTokens);
  expect(perCase.usd).toBeCloseTo(expectedUsd, 12);
  expect(ceilingUsd).toBeCloseTo(perCase.usd, 12);

  // A chunk of two such cases, in one invocation: the aggregate is the two
  // per-case bounds summed, and it fits under a USD 5 ceiling.
  const chunkCorpus = await longCaseCorpus("long-chunk", 2);
  const chunkInputs: FixedCallSpendInput[] = [];
  let chunkCeilingUsd: number | undefined;
  await runCorpusProposeCommand(
    chunkCorpus,
    [],
    { backend: "claude-cli", model: "claude-haiku-5-5" },
    {
      cwd: directory,
      env: {},
      stdout: capturedStream().stream,
      stderr: capturedStream().stream,
      confirmation: null,
      estimateSpend: (spendInput) => {
        chunkInputs.push(spendInput);
        return estimateFixedCallSpend(spendInput);
      },
      enforceCeiling: async (input) => {
        chunkCeilingUsd = input.estimate.usd;
      },
      prepareBackend: async () => silentChat().chat,
    },
  );
  expect(chunkInputs).toHaveLength(2);
  const chunkEstimates = chunkInputs.map((chunkInput) => estimateFixedCallSpend(chunkInput));
  const total = sumFixedCallSpendEstimates(chunkEstimates);
  expect(total.caseCount).toBe(2);
  expect(total.usd).toBeCloseTo(chunkEstimates[0]!.usd + chunkEstimates[1]!.usd, 12);
  expect(chunkCeilingUsd).toBeCloseTo(total.usd, 12);
  expect(total.usd).toBeLessThan(5);
});

test("the growth term is bounded by the repair problems cap and does not scale with --response-cap or the case text", async () => {
  // Three corpora, one per run: the first run writes its absences, so a
  // second run over the same corpus would have nothing left to price.
  const long = join(directory, "long");
  await writeCorpus(long, [
    { id: "case-a", files: [{ name: "input.txt", text: `${"R".repeat(9_000)}\n` }] },
  ]);
  const small = join(directory, "small");
  await writeCorpus(small, [
    { id: "case-a", files: [{ name: "input.txt", text: "A short note.\n" }] },
  ]);
  const low = await runPropose({ corpus: long, backend: "openai-compatible", responseCap: 128 });
  const longHigh = join(directory, "long-high");
  await writeCorpus(longHigh, [
    { id: "case-a", files: [{ name: "input.txt", text: `${"R".repeat(9_000)}\n` }] },
  ]);
  const high = await runPropose({
    corpus: longHigh,
    backend: "openai-compatible",
    responseCap: 8192,
  });
  const smallLow = join(directory, "small-low");
  await writeCorpus(smallLow, [
    { id: "case-a", files: [{ name: "input.txt", text: "A short note.\n" }] },
  ]);
  const short = await runPropose({
    corpus: smallLow,
    backend: "openai-compatible",
    responseCap: 128,
  });

  expect(low.estimateInputs).toHaveLength(1);
  expect(high.estimateInputs).toHaveLength(1);
  const lowInput = low.estimateInputs[0]!;
  const highInput = high.estimateInputs[0]!;
  const shortInput = short.estimateInputs[0]!;
  // The measured prompt and its per-attempt growth are identical across caps
  // and across case-text sizes: growth is the repair request's problems cap,
  // nothing else.
  expect(highInput.promptChars).toBe(lowInput.promptChars);
  expect(highInput.promptGrowthCharsPerAttempt).toBe(lowInput.promptGrowthCharsPerAttempt);
  expect(shortInput.promptGrowthCharsPerAttempt).toBe(lowInput.promptGrowthCharsPerAttempt);
  expect(lowInput.promptChars).toBeGreaterThan(shortInput.promptChars);
  expect(highInput.completionTokensPerCall).toBe(8192);
  expect(lowInput.completionTokensPerCall).toBe(128);
  // The growth itself is the real repair builder's, at the problems cap: at
  // least one truncated problem's worth of characters, and never more than
  // the maximal problems list the repair request can carry.
  expect(lowInput.promptGrowthCharsPerAttempt).toBeGreaterThan(
    PROPOSE_REPAIR_PROBLEMS_MAX * PROPOSE_REPAIR_PROBLEM_CHARS,
  );
  expect(lowInput.promptGrowthCharsPerAttempt).toBeLessThan(
    PROPOSE_REPAIR_PROBLEMS_MAX * (PROPOSE_REPAIR_PROBLEM_CHARS + 40),
  );
});
