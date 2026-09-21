import { describe, expect, test } from "vitest";
import { TerminalError, isTransientFailure, type WriteMetadata } from "@azx/ribo-core";
import { snuggCtxSchema, type SnuggWriteContext } from "../context.js";
import { createSnuggHttpWriter } from "./writer.js";

/**
 * Every request below goes to an INJECTED FAKE `fetch` — never a network. The
 * fake records the URL and init it was handed, so the assertions are about what
 * the writer would send, not what a server would do with it.
 */

const ctx: SnuggWriteContext = snuggCtxSchema.parse({
  assessmentId: "123",
  companyId: "co-1",
  apiBaseUrl: "https://gateway.example/snugg",
});

const meta = (overrides: Partial<WriteMetadata> = {}): WriteMetadata => ({
  idempotencyKey: "key-1",
  ...overrides,
});

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
  /** The request body as text — the writer always sends a JSON string. */
  readonly bodyText: string;
}

const fetchRecording = (
  respond: () => Response,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = init?.body;
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init: init ?? {},
      bodyText: typeof body === "string" ? body : "",
    });
    return respond();
  };
  return { fetchImpl, calls };
};

const failureOf = async (write: Promise<{ readonly uuid: string }>): Promise<unknown> => {
  try {
    await write;
  } catch (error) {
    return error;
  }
  throw new Error("expected the write to reject");
};

const hvacValues = {
  hvacSystemEquipmentType: "Boiler",
  hvacUpgradeAction: "Keep an existing system as is",
  hvacHeatingSystemModelYear: 2011,
};

describe("createSnuggHttpWriter", () => {
  test("a collection create POSTs /jobs/{jobId}/<group>, sends the built body, and returns the record's uuid", async () => {
    const { fetchImpl, calls } = fetchRecording(() =>
      jsonResponse(201, { uuid: "new-uuid", hvacSystemName: "Furnace" }),
    );
    const write = createSnuggHttpWriter({ fetchImpl });

    await expect(write("hvac", hvacValues, ctx, meta())).resolves.toEqual({ uuid: "new-uuid" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gateway.example/snugg/jobs/123/hvac");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({
      "content-type": "application/json",
      "Idempotency-Key": "key-1",
    });
    // The stringified model year proves the body came from buildWriteBody,
    // not from a transform re-implemented here.
    expect(JSON.parse(calls[0]!.bodyText)).toEqual({
      hvacSystemEquipmentType: "Boiler",
      hvacUpgradeAction: "Keep an existing system as is",
      hvacHeatingSystemModelYear: "2011",
    });
  });

  test("a collection update interpolates {uuid} with the link target and drops create-only keys", async () => {
    const { fetchImpl, calls } = fetchRecording(() => jsonResponse(200, { uuid: "furnace-uuid" }));
    const write = createSnuggHttpWriter({ fetchImpl });

    await write("hvac", hvacValues, ctx, meta({ linkTarget: "furnace-uuid" }));

    expect(calls[0]!.url).toBe("https://gateway.example/snugg/jobs/hvac/furnace-uuid");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.bodyText)).toEqual({
      hvacUpgradeAction: "Keep an existing system as is",
      hvacHeatingSystemModelYear: "2011",
    });
  });

  test("an incentive update interpolates BOTH {jobId} and {uuid}", async () => {
    const { fetchImpl, calls } = fetchRecording(() => jsonResponse(200, { uuid: "inv-uuid" }));
    const write = createSnuggHttpWriter({ fetchImpl });

    await write(
      "incentive",
      { amount: 1500, fromTemplateUuid: "the Duke rebate" },
      ctx,
      meta({ linkTarget: "inv-uuid" }),
    );

    expect(calls[0]!.url).toBe("https://gateway.example/snugg/jobs/123/incentives/inv-uuid");
    expect(calls[0]!.init.method).toBe("PUT");
    // fromTemplateUuid is create-only, so it is dropped by the body builder's
    // create-only filter before the unresolved-reference refusal could fire.
    expect(JSON.parse(calls[0]!.bodyText)).toEqual({ amount: 1500 });
  });

  test("a singleton upserts at /jobs/{jobId}/<group> with no linkTarget and returns the fabricated singleton receipt", async () => {
    const { fetchImpl, calls } = fetchRecording(() => jsonResponse(200, {}));
    const write = createSnuggHttpWriter({ fetchImpl });

    await expect(write("basedata", { yearBuilt: 1987 }, ctx, meta())).resolves.toEqual({
      uuid: "singleton:basedata:123",
    });
    await expect(write("health", {}, ctx, meta())).resolves.toEqual({
      uuid: "singleton:health:123",
    });

    // The vendor's singleton responses carry no uuid or id; the write reads
    // nothing off the body. It still builds it from buildWriteBody — the
    // numeric stringification below is that builder's, not this file's.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://gateway.example/snugg/jobs/123/basedata");
    expect(JSON.parse(calls[0]!.bodyText)).toEqual({ yearBuilt: "1987" });
  });

  test("a singleton succeeds without parsing the body — nothing on it is read", async () => {
    const { fetchImpl } = fetchRecording(
      () => new Response("<html>gateway noise</html>", { status: 200 }),
    );
    const write = createSnuggHttpWriter({ fetchImpl });

    await expect(write("basedata", { yearBuilt: 1987 }, ctx, meta())).resolves.toEqual({
      uuid: "singleton:basedata:123",
    });
  });

  test("a singleton stays upsert even when a linkTarget is present — a retry carries the fabricated receipt", async () => {
    const { fetchImpl, calls } = fetchRecording(() => jsonResponse(200, {}));
    const write = createSnuggHttpWriter({ fetchImpl });

    await write(
      "basedata",
      { yearBuilt: 1987 },
      ctx,
      meta({ linkTarget: "singleton:basedata:123" }),
    );

    expect(calls[0]!.url).toBe("https://gateway.example/snugg/jobs/123/basedata");
    expect(calls[0]!.init.method).toBe("POST");
  });

  test("job PUTs /jobs/{jobId} — update only, with or without a linkTarget", async () => {
    const { fetchImpl, calls } = fetchRecording(() => jsonResponse(200, {}));
    const write = createSnuggHttpWriter({ fetchImpl });

    await expect(write("job", { note: "Bring the blower door" }, ctx, meta())).resolves.toEqual({
      uuid: "job:123",
    });
    await write("job", { note: "Bring the blower door" }, ctx, meta({ linkTarget: "job:123" }));

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init.method).toBe("PUT");
      expect(call.url).toBe("https://gateway.example/snugg/jobs/123");
    }
  });

  test("linkTarget presence alone selects a collection's update — the same values go either way", async () => {
    const withoutTarget = fetchRecording(() => jsonResponse(201, { uuid: "new-uuid" }));
    await createSnuggHttpWriter({ fetchImpl: withoutTarget.fetchImpl })(
      "hvac",
      hvacValues,
      ctx,
      meta(),
    );
    expect(withoutTarget.calls[0]!.url).toBe("https://gateway.example/snugg/jobs/123/hvac");

    const withTarget = fetchRecording(() => jsonResponse(200, { uuid: "furnace-uuid" }));
    await createSnuggHttpWriter({ fetchImpl: withTarget.fetchImpl })(
      "hvac",
      hvacValues,
      ctx,
      meta({ linkTarget: "furnace-uuid" }),
    );
    expect(withTarget.calls[0]!.url).toBe("https://gateway.example/snugg/jobs/hvac/furnace-uuid");
  });

  test("a retry carrying the recorded receipt UPDATEs that record — it never creates a second one", async () => {
    // THE regression the receipt mechanism exists to prevent: an interrupted
    // first write left a real HVAC system on a real customer's audit, and the
    // relay's retry comes back with that receipt as meta.linkTarget. The write
    // must amend THAT record, not POST a duplicate onto the audit.
    const { fetchImpl, calls } = fetchRecording(() => jsonResponse(200, { uuid: "furnace-uuid" }));
    const write = createSnuggHttpWriter({ fetchImpl });

    await write(
      "hvac",
      hvacValues,
      ctx,
      meta({ idempotencyKey: "key-2", linkTarget: "furnace-uuid" }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gateway.example/snugg/jobs/hvac/furnace-uuid");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.bodyText)).toEqual({
      hvacUpgradeAction: "Keep an existing system as is",
      hvacHeatingSystemModelYear: "2011",
    });
  });

  test("an unknown group refuses before any request", async () => {
    const { fetchImpl, calls } = fetchRecording(() => jsonResponse(200, {}));
    const write = createSnuggHttpWriter({ fetchImpl });

    await expect(write("notAGroup", {}, ctx, meta())).rejects.toThrow(/notAGroup/);
    expect(calls).toHaveLength(0);
  });

  test.each([408, 429, 500, 503])(
    "HTTP %i leaves the failure to the relay's backoff — not terminal",
    async (status) => {
      const { fetchImpl } = fetchRecording(() => jsonResponse(status, { message: "try later" }));
      const write = createSnuggHttpWriter({ fetchImpl });

      const error = await failureOf(write("hvac", hvacValues, ctx, meta()));

      expect(error).not.toBeInstanceOf(TerminalError);
      expect(isTransientFailure(error)).toBe(true);
    },
  );

  test("a network error propagates untouched — the relay's backoff owns the retry", async () => {
    const boom = new TypeError("fetch failed");
    const fetchImpl: typeof fetch = async () => {
      throw boom;
    };
    const write = createSnuggHttpWriter({ fetchImpl });

    await expect(write("hvac", hvacValues, ctx, meta())).rejects.toBe(boom);
  });

  test("a 401 whose body is the Helix envelope means the platform session lapsed — reload, not terminal", async () => {
    const { fetchImpl } = fetchRecording(() =>
      jsonResponse(401, { error: { code: "session_expired" } }),
    );
    const write = createSnuggHttpWriter({ fetchImpl });

    const error = await failureOf(write("hvac", hvacValues, ctx, meta()));

    expect(error).not.toBeInstanceOf(TerminalError);
    expect(String(error)).toMatch(/reload/i);
    // Retryable: the reload remedy only works if the relay picks the write
    // back up, so this must not be classified terminal.
    expect(isTransientFailure(error)).toBe(true);
  });

  test("a 401 with any other body means the vendor rejected the credential — terminal", async () => {
    for (const body of ["", "Unauthorized", JSON.stringify({ message: "bad key" })]) {
      const { fetchImpl } = fetchRecording(() => new Response(body, { status: 401 }));
      const write = createSnuggHttpWriter({ fetchImpl });

      const error = await failureOf(write("hvac", hvacValues, ctx, meta()));

      expect(error, `401 body ${JSON.stringify(body)}`).toBeInstanceOf(TerminalError);
      expect(String(error)).toMatch(/credential/i);
    }
  });

  test("a 404 on an update is terminal and its message names the stale target and the reopenForReview recovery", async () => {
    const { fetchImpl } = fetchRecording(() => jsonResponse(404, {}));
    const write = createSnuggHttpWriter({ fetchImpl });

    const error = await failureOf(
      write("hvac", hvacValues, ctx, meta({ linkTarget: "furnace-uuid" })),
    );

    expect(error).toBeInstanceOf(TerminalError);
    // The message is the only thing a human gets — it must carry both the
    // stale link target and the recovery.
    expect(String(error)).toContain("furnace-uuid");
    expect(String(error)).toContain("reopenForReview");
  });

  test("a 404 on a create is terminal, but is not the stale-link case", async () => {
    const { fetchImpl } = fetchRecording(() => jsonResponse(404, {}));
    const write = createSnuggHttpWriter({ fetchImpl });

    const error = await failureOf(write("hvac", hvacValues, ctx, meta()));

    expect(error).toBeInstanceOf(TerminalError);
    expect(String(error)).not.toContain("reopenForReview");
  });

  test.each([400, 403, 422])(
    "HTTP %i is terminal — the inputs are persisted, so a retry fails identically",
    async (status) => {
      const { fetchImpl } = fetchRecording(() => jsonResponse(status, { message: "nope" }));
      const write = createSnuggHttpWriter({ fetchImpl });

      const error = await failureOf(write("hvac", hvacValues, ctx, meta()));

      expect(error).toBeInstanceOf(TerminalError);
    },
  );
});
