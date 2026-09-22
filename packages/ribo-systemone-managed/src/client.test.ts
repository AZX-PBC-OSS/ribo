import { isTransientFailure, TerminalError } from "@azx/ribo-core";
import { afterEach, describe, expect, test, vi } from "vitest";

import { systemOneClient } from "./client.js";
import { SystemOneError } from "./errors.js";

/**
 * Client tests for the System One HTTP API — no network, no credential: `fetch`
 * is injected with doubles that record their calls and return canned responses.
 * The package has no capacity to authenticate, so there is nothing to double
 * beyond the transport.
 */

const ENDPOINT = "https://system-one.example.internal/ask";

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

/** A fetch double that answers every question it was sent with a per-id canned noul. */
function answeringFetch(noulFor: (id: string) => number): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const body = jsonStringBody(init ?? {}) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((id) => [id, { type: "noul", noul: noulFor(id) }] as const),
    );
    return Promise.resolve(
      Response.json({ answers, usage: { input_tokens: 1, output_tokens: 1 } }),
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * The recorded request body parsed — the client always sends a JSON string, so
 * a non-string body is a double bug, not a stringify default to paper over.
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
});

describe("SystemOneClient", () => {
  test("one request carries the state, the model and every question; the result maps each id to its noul", async () => {
    const { fetchImpl, calls } = fakeFetch(Response.json(OK_BODY));
    const client = systemOneClient({ endpoint: ENDPOINT, fetch: fetchImpl, model: "jev-latest" });

    const verdicts = await client.ask("The attic has R-19 batts.", {
      insulated: { instructions: "Is the attic insulated?" },
      vapourOpen: {
        instructions: "Is the insulation vapour open?",
        criteria: { true: "vapour open", false: "vapour closed" },
      },
    });

    expect(verdicts).toEqual({ insulated: 0.97, vapourOpen: 0.03 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ENDPOINT);
    expect(calls[0]!.init.method).toBe("POST");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    // The credential is the host transport's business — the package adds none.
    expect(headers.get("authorization")).toBeNull();
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

  test("more questions than batchSize are split across requests, and the merge holds every id exactly once", async () => {
    const { fetchImpl, calls } = answeringFetch((id) => (Number(id) + 1) / 10);
    const client = systemOneClient({ endpoint: ENDPOINT, fetch: fetchImpl, batchSize: 2 });
    const questions = Object.fromEntries(
      ["1", "2", "3", "4", "5"].map((id) => [id, { instructions: `Question ${id}?` }] as const),
    );

    const verdicts = await client.ask("state", questions);

    expect(verdicts).toEqual({ "1": 0.2, "2": 0.3, "3": 0.4, "4": 0.5, "5": 0.6 });
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

    const error = await client.ask("state", { q: { instructions: "Q?" } }).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(TerminalError);
    expect(isTransientFailure(error)).toBe(true);
    expect((error as { status?: number }).status).toBe(status);
  });

  test.each([401, 422])(
    "a %s rejects terminally — a SystemOneError, which is a TerminalError",
    async (status) => {
      const { fetchImpl } = fakeFetch(new Response("no", { status }));
      const client = systemOneClient({ endpoint: ENDPOINT, fetch: fetchImpl });

      const error = await client
        .ask("state", { q: { instructions: "Q?" } })
        .catch((e: unknown) => e);

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
      .ask("state", { q: { instructions: "Q?" } }, { signal: controller.signal })
      .catch((e: unknown) => e);

    expect(calls).toHaveLength(0);
    expect(error).toBeInstanceOf(TerminalError);
    expect((error as Error).message).toMatch(/abort/i);
  });

  test("the injected fetch is used and globalThis.fetch is never touched", async () => {
    const globalFetch = vi.fn(() => {
      throw new Error("globalThis.fetch must never be used");
    });
    vi.stubGlobal("fetch", globalFetch);
    const { fetchImpl } = fakeFetch(Response.json(OK_BODY));
    const client = systemOneClient({ endpoint: ENDPOINT, fetch: fetchImpl });

    await expect(
      client.ask("state", {
        insulated: { instructions: "Is the attic insulated?" },
        vapourOpen: { instructions: "Is the insulation vapour open?" },
      }),
    ).resolves.toEqual({ insulated: 0.97, vapourOpen: 0.03 });
    expect(globalFetch).not.toHaveBeenCalled();
  });

  test("defaults: model jev-latest and batchSize 30", async () => {
    const { fetchImpl, calls } = answeringFetch(() => 0.5);
    const client = systemOneClient({ endpoint: ENDPOINT, fetch: fetchImpl });
    const questions = Object.fromEntries(
      Array.from({ length: 31 }, (_, i) => [String(i), { instructions: "Q?" }] as const),
    );

    await client.ask("state", questions);

    const first = jsonStringBody(calls[0]!.init) as { model: string };
    expect(first.model).toBe("jev-latest");
    expect(calls).toHaveLength(2);
    expect(sentQuestions(calls[0]!)).toHaveLength(30);
    expect(sentQuestions(calls[1]!)).toHaveLength(1);
  });
});
