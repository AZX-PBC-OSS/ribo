import { isTransientFailure, TerminalError } from "@azx/ribo-core";
import { choice, noul } from "@typesafe-ai/sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { systemOneClient } from "./client.js";
import { SystemOneError } from "./errors.js";

/**
 * Client tests for the System One API over the official `@typesafe-ai/sdk` — no
 * network, no credential: `fetch` is injected with doubles that record their
 * calls and return canned responses. The package has no capacity to
 * authenticate, so there is nothing to double beyond the transport.
 */

const ENDPOINT = "https://system-one.example.internal";
// The SDK posts to the `/v1/systemone` path under the API root it is given.
const ASK_URL = `${ENDPOINT}/v1/systemone`;

const OK_BODY = {
  answers: {
    insulated: { type: "noul", noul: 0.97 },
    vapourOpen: { type: "noul", noul: 0.03 },
  },
  usage: { input_tokens: 12, output_tokens: 3 },
};

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch double that records every call and answers with one canned Response. */
function fakeFetch(response: Response): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** The answer shape the double synthesises — discriminated the way the wire does. */
type FakeAnswer =
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    };

/**
 * A fetch double that answers every question it was sent with the answer its
 * type implies: a canned noul per id, and for a choice question the first
 * label with probability 1 and the rest 0.
 */
function answeringFetch(noulFor: (id: string) => number): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const body = jsonStringBody(init ?? {}) as {
      questions: Record<string, { type: string; criteria?: Record<string, unknown> }>;
    };
    const answers: Record<string, FakeAnswer> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      if (question.type === "choice") {
        const labels = Object.keys(question.criteria ?? {});
        answers[id] = {
          type: "choice",
          choice: labels[0] ?? "",
          confidence: 0.8,
          probabilities: Object.fromEntries(labels.map((label, i) => [label, i === 0 ? 1 : 0])),
        };
      } else {
        answers[id] = { type: "noul", noul: noulFor(id) };
      }
    }
    return Promise.resolve(
      Response.json({ answers, usage: { input_tokens: 1, output_tokens: 1 } }),
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * The recorded request body parsed — the SDK always sends a JSON string, so a
 * non-string body is a double bug, not a stringify default to paper over.
 */
function jsonStringBody(init: RequestInit): unknown {
  if (typeof init.body !== "string") {
    throw new Error(`expected a string request body, got ${typeof init.body}`);
  }
  return JSON.parse(init.body) as unknown;
}

/** The question ids a recorded request carried. */
function sentQuestions(call: RecordedCall): string[] {
  const body = jsonStringBody(call.init) as { questions: Record<string, unknown> };
  return Object.keys(body.questions);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("SystemOneClient", () => {
  test("one request carries the state, the model and every question; the result maps each id to its noul", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(OK_BODY));
    const client = systemOneClient({ endpoint: ENDPOINT, fetch: fetchImpl, model: "jev-latest" });

    const verdicts = await client.ask("The attic has R-19 batts.", {
      insulated: noul("Is the attic insulated?"),
      vapourOpen: noul("Is the insulation vapour open?", {
        true: "vapour open",
        false: "vapour closed",
      }),
    });

    expect(verdicts).toEqual({
      insulated: { type: "noul", noul: 0.97 },
      vapourOpen: { type: "noul", noul: 0.03 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ASK_URL);
    expect(calls[0]!.init.method).toBe("POST");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    // The only credential on the wire is the SDK's documented placeholder —
    // the package has no apiKey option, so a real one cannot ride the request.
    expect(headers.get("authorization")).toMatch(/^Bearer /);
    expect(jsonStringBody(calls[0]!.init)).toEqual({
      state: "The attic has R-19 batts.",
      model: "jev-latest",
      questions: {
        insulated: { type: "noul", instructions: "Is the attic insulated?" },
        vapourOpen: {
          type: "noul",
          instructions: "Is the insulation vapour open?",
          criteria: { true: "vapour open", false: "vapour closed" },
        },
      },
    });
  });

  test("a choice question round-trips: choice, probabilities and confidence all arrive", async () => {
    const { fetchImpl, calls } = answeringFetch(() => 0.5);
    const client = systemOneClient({ endpoint: ENDPOINT, fetch: fetchImpl });

    const answers = await client.ask("The boiler is a combi.", {
      fuel: choice("What fuel does the boiler burn?", {
        gas: "natural gas",
        oil: "kerosene",
      }),
    });

    expect(answers.fuel).toEqual({
      type: "choice",
      choice: "gas",
      confidence: 0.8,
      probabilities: { gas: 1, oil: 0 },
    });
    expect(calls).toHaveLength(1);
    const body = jsonStringBody(calls[0]!.init) as {
      questions: Record<string, { type: string; criteria: Record<string, unknown> }>;
    };
    expect(body.questions.fuel).toEqual({
      type: "choice",
      instructions: "What fuel does the boiler burn?",
      criteria: { gas: "natural gas", oil: "kerosene" },
    });
  });

  test("a mixed batch of noul and choice questions in one call returns both answer kinds, correctly keyed", async () => {
    const { fetchImpl, calls } = answeringFetch(() => 0.2);
    const client = systemOneClient({ endpoint: ENDPOINT, fetch: fetchImpl });

    const answers = await client.ask("state", {
      insulated: noul("Is the attic insulated?"),
      fuel: choice("What fuel?", { gas: "natural gas", oil: "kerosene" }),
    });

    expect(calls).toHaveLength(1);
    expect(sentQuestions(calls[0]!).sort()).toEqual(["fuel", "insulated"]);
    expect(answers.insulated).toEqual({ type: "noul", noul: 0.2 });
    expect(answers.fuel).toEqual({
      type: "choice",
      choice: "gas",
      confidence: 0.8,
      probabilities: { gas: 1, oil: 0 },
    });
  });

  test("more questions than batchSize are split across requests, and the merge holds every id exactly once", async () => {
    const { fetchImpl, calls } = answeringFetch((id) => (Number(id) + 1) / 10);
    const client = systemOneClient({ endpoint: ENDPOINT, fetch: fetchImpl, batchSize: 2 });
    const questions = Object.fromEntries(
      ["1", "2", "3", "4", "5"].map((id) => [id, noul(`Question ${id}?`)] as const),
    );

    const verdicts = await client.ask("state", questions);

    expect(verdicts).toEqual({
      "1": { type: "noul", noul: 0.2 },
      "2": { type: "noul", noul: 0.3 },
      "3": { type: "noul", noul: 0.4 },
      "4": { type: "noul", noul: 0.5 },
      "5": { type: "noul", noul: 0.6 },
    });
    expect(calls).toHaveLength(3);
    // Every id sent exactly once across the batches, no batch over the size cap.
    expect(calls.flatMap(sentQuestions).sort()).toEqual(["1", "2", "3", "4", "5"]);
    for (const call of calls) {
      expect(sentQuestions(call).length).toBeLessThanOrEqual(2);
    }
  });

  test.each([429, 529])("a %s rejects transiently — not a TerminalError", async (status) => {
    const { fetchImpl } = fakeFetch(new Response("slow down", { status }));
    const client = systemOneClient({ endpoint: ENDPOINT, fetch: fetchImpl });

    const error = await client.ask("state", { q: noul("Q?") }).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(TerminalError);
    expect(isTransientFailure(error)).toBe(true);
    expect((error as { status?: number }).status).toBe(status);
  });

  test("a 429 makes exactly one fetch call — the SDK's own retries are disabled", async () => {
    // Ribo's relay and its arbitration ladders own retry and backoff; the SDK's
    // default (maxRetries: 2) would triple the cost of every failing call. If
    // this test fails, someone removed `maxRetries: 0` from the client config.
    const { fetchImpl, calls } = fakeFetch(new Response("slow down", { status: 429 }));
    const client = systemOneClient({ endpoint: ENDPOINT, fetch: fetchImpl });

    await client.ask("state", { q: noul("Q?") }).catch(() => undefined);

    expect(calls).toHaveLength(1);
  });

  test.each([400, 401, 403, 404, 422])(
    "a %s rejects terminally — a SystemOneError, which is a TerminalError",
    async (status) => {
      const { fetchImpl } = fakeFetch(new Response("no", { status }));
      const client = systemOneClient({ endpoint: ENDPOINT, fetch: fetchImpl });

      const error = await client.ask("state", { q: noul("Q?") }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SystemOneError);
      expect(error).toBeInstanceOf(TerminalError);
      expect(isTransientFailure(error)).toBe(false);
      expect((error as SystemOneError).status).toBe(status);
    },
  );

  test("an already-aborted signal rejects without sending a request", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(OK_BODY));
    const client = systemOneClient({ endpoint: ENDPOINT, fetch: fetchImpl });
    const controller = new AbortController();
    controller.abort();

    const error = await client
      .ask("state", { q: noul("Q?") }, { signal: controller.signal })
      .catch((e: unknown) => e);

    expect(calls).toHaveLength(0);
    expect(error).toBeInstanceOf(TerminalError);
    expect((error as Error).message).toMatch(/abort/i);
  });

  test("the injected fetch is used, globalThis.fetch is never touched, and no env key leaks", async () => {
    // The package has no capacity to authenticate: even a planted
    // TYPESAFE_API_KEY must not reach the wire — the only credential-shaped
    // thing the SDK sends is the documented placeholder.
    vi.stubEnv("TYPESAFE_API_KEY", "leaked-env-key");
    const globalFetch = vi.fn(() => {
      throw new Error("globalThis.fetch must never be used");
    });
    vi.stubGlobal("fetch", globalFetch);
    const { fetchImpl, calls } = fakeFetch(Response.json(OK_BODY));
    const client = systemOneClient({ endpoint: ENDPOINT, fetch: fetchImpl });

    await expect(
      client.ask("state", {
        insulated: noul("Is the attic insulated?"),
        vapourOpen: noul("Is the insulation vapour open?"),
      }),
    ).resolves.toEqual({
      insulated: { type: "noul", noul: 0.97 },
      vapourOpen: { type: "noul", noul: 0.03 },
    });
    expect(globalFetch).not.toHaveBeenCalled();
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer no-secret-the-host-fetch-authenticates");
  });

  test("defaults: model jev-latest and batchSize 30", async () => {
    const { fetchImpl, calls } = answeringFetch(() => 0.5);
    const client = systemOneClient({ endpoint: ENDPOINT, fetch: fetchImpl });
    const questions = Object.fromEntries(
      Array.from({ length: 31 }, (_, i) => [String(i), noul("Q?")] as const),
    );

    await client.ask("state", questions);

    const first = jsonStringBody(calls[0]!.init) as { model: string };
    expect(first.model).toBe("jev-latest");
    expect(calls).toHaveLength(2);
    expect(sentQuestions(calls[0]!)).toHaveLength(30);
    expect(sentQuestions(calls[1]!)).toHaveLength(1);
  });
});
