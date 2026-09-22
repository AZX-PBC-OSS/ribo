import { afterAll, expect, test } from "vitest";

import type { WriteMetadata } from "@azx/ribo-core";

import { createSnuggProAdapter, readExistingRecords } from "../src/index.js";
import type { SnuggWriteContext } from "../src/context.js";

/**
 * The real write-back gate: does `createSnuggProAdapter` produce a request Snugg Pro
 * actually accepts?
 *
 * Every other test of the write path runs against an injected fake `fetch`, which proves
 * the code does what we meant and nothing about whether we meant the right thing. This
 * one drives the production composition — `createSnuggProAdapter` → the HTTP writer →
 * `buildWriteBody` → the generated endpoint table — at a live vendor over the host's
 * gateway, and asserts on what the vendor stored.
 *
 * MANUAL, OPT-IN, and never in CI — same contract as every other file here. It needs a
 * gateway token and it WRITES to a real (staging) job, so it skips cleanly when the env
 * is absent rather than failing. Target it by name, or the extraction gate runs too:
 *
 *   SNUGG_WRITE_TOKEN=… SNUGG_WRITE_JOB_ID=588613 \
 *   pnpm exec vitest run --config packages/ribo-adapter-snuggpro/vitest.acceptance.config.ts write-real
 *
 * ## What it asserts, and why each one
 *
 *   1. A create returns the vendor's own uuid — the receipt the whole duplicate-protection
 *      mechanism rests on, since Snugg Pro ignores `Idempotency-Key`.
 *   2. Two write-time transforms survive the round trip: a `z.number()` leaf the vendor
 *      types `string` comes back as the number we sent, and a quote-free duct-insulation
 *      alias comes back as the vendor's quoted literal. Both are invisible to a fake
 *      `fetch` — it would happily accept a body the vendor rejects.
 *   3. **A partial update leaves untouched fields alone.** This is the no-overwrite
 *      guarantee, end to end, against the real vendor rather than against a measurement
 *      recorded in a design doc.
 *   4. `readExistingRecords` parses the vendor's own rows, which is what lets review show
 *      an auditor the record already on the job instead of creating a second one.
 *   5. **The two vendor facts the design rests on are still true** — the header is still
 *      ignored, and a singleton upsert still merges. Spike 0007 established both and doc 15
 *      §3.3 records them, but a finding a vendor can change silently needs a gate rather
 *      than a paragraph (ADR 0019). These two are that gate.
 *
 * ## Reversible by construction
 *
 * Most of it writes to a COLLECTION group, which the vendor lets us delete, and `afterAll`
 * removes every record created — verifying the collection is back to its baseline.
 *
 * The merge check is the exception and needs care, because a singleton upsert has no delete:
 * it asserts its two probe fields start null, refuses to run otherwise, and restores them to
 * null in a `finally`. That is why it probes `health` rather than `basedata` — a matrix whose
 * tests are usually unset gives a clean baseline, where basedata on a real job does not. The
 * one-off basedata probe (snapshot to disk, mutate, restore, verify byte-identical) lives in
 * `spikes/0007-snuggpro-write-semantics/` instead, because that shape is too heavy for a gate.
 */

const GATEWAY =
  process.env["SNUGG_WRITE_GATEWAY"] ??
  "https://dev-api.franklin.helix.azxlabs.io/franklin-field-app";
const BASE = process.env["SNUGG_WRITE_BASE"] ?? "https://api-staging.snuggpro.com";
const TOKEN = process.env["SNUGG_WRITE_TOKEN"];
const JOB_ID = process.env["SNUGG_WRITE_JOB_ID"];

const configured = TOKEN !== undefined && JOB_ID !== undefined;

/**
 * The host's transport, and the reason this gate is worth having: the adapter holds no
 * credential, so a host rewrites its absolute vendor URL onto the gateway's fetch-proxy
 * mount and the gateway signs the request and injects the stored Snugg Pro credential.
 * This is the same shape the field app uses in production.
 */
const gatewayFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : String(input);
  return fetch(`${GATEWAY}/_api/fetch/${url}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      authorization: `Bearer ${TOKEN ?? ""}`,
      accept: "application/json",
      origin: "http://localhost:5173",
    },
  });
};

const ctx = (): SnuggWriteContext => ({
  assessmentId: JOB_ID ?? "",
  companyId: process.env["SNUGG_WRITE_COMPANY_ID"] ?? "3565",
  apiBaseUrl: BASE,
});

const meta = (linkTarget?: string): WriteMetadata => ({
  idempotencyKey: `write-real-${Date.now()}`,
  ...(linkTarget !== undefined ? { linkTarget } : {}),
});

const PROBE_NAME = "RIBO ACCEPTANCE - delete me";
const created: string[] = [];

const listHvacs = async (): Promise<Array<Record<string, unknown>>> => {
  const res = await gatewayFetch(`${BASE}/jobs/${JOB_ID}/hvacs`);
  const body: unknown = await res.json();
  return Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
};

afterAll(async () => {
  if (!configured) return;
  for (const uuid of created) {
    const res = await gatewayFetch(`${BASE}/jobs/hvac/${uuid}`, { method: "DELETE" });
    // Report rather than assert: a failed cleanup must be loud, but it must not mask
    // the result of the test that created the record.
    console.log(`cleanup: DELETE /jobs/hvac/${uuid} -> ${res.status}`);
  }
});

test.runIf(configured)(
  "a create returns the vendor's uuid, and both write-time transforms survive the round trip",
  async () => {
    const adapter = createSnuggProAdapter({ fetchImpl: gatewayFetch });
    const before = await listHvacs();

    const { receipt } = await adapter.write(
      {
        hvac: [
          {
            hvacSystemEquipmentType: "Boiler",
            hvacUpgradeAction: "Keep an existing system as is",
            hvacSystemName: PROBE_NAME,
            // `z.number()` here, `string` on the wire — the stringify transform.
            hvacHeatingSystemModelYear: 2001,
            // Quote-free alias here, `Duct Board 1.5"` on the wire — the vendor-literal map.
            hvacDuctInsulation: "Duct Board 1.5 inch",
          },
        ],
      },
      ctx(),
      meta(),
    );

    // For a COLLECTION the receipt is the vendor's own uuid — the one case where the
    // two coincide. A singleton's receipt is a synthesised string, which is why the
    // contract calls it a receipt rather than a uuid.
    expect(receipt).toMatch(/[0-9a-f-]{16,}/);
    created.push(receipt);

    const stored = (await listHvacs()).find((record) => record["uuid"] === receipt);
    expect(stored, "the created record reads back").toBeDefined();
    expect(stored?.["hvacSystemName"]).toBe(PROBE_NAME);
    // Sent as the number 2001; the vendor's field is a string.
    expect(stored?.["hvacHeatingSystemModelYear"]).toBe("2001");
    // Sent as "Duct Board 1.5 inch"; the vendor stores its own quoted literal.
    expect(stored?.["hvacDuctInsulation"]).toBe('Duct Board 1.5"');
    expect(before.some((record) => record["uuid"] === receipt)).toBe(false);
  },
);

test.runIf(configured)(
  "a partial update changes only what it sends — the no-overwrite guarantee, live",
  async () => {
    const adapter = createSnuggProAdapter({ fetchImpl: gatewayFetch });
    const uuid = created[0];
    expect(uuid, "the create test ran first and left a record").toBeDefined();

    // One leaf. Everything else is ABSENT from the patch, which is what a rejected
    // field looks like after review — and absent must mean "leave it alone".
    await adapter.write(
      { hvac: [{ hvacSystemName: `${PROBE_NAME} (updated)` }] },
      ctx(),
      meta(uuid),
    );

    const stored = (await listHvacs()).find((record) => record["uuid"] === uuid);
    expect(stored?.["hvacSystemName"]).toBe(`${PROBE_NAME} (updated)`);
    // The fields the patch never mentioned are untouched. If Snugg Pro replaced rather
    // than merged, these would be null and a real auditor would have lost data.
    expect(stored?.["hvacHeatingSystemModelYear"]).toBe("2001");
    expect(stored?.["hvacDuctInsulation"]).toBe('Duct Board 1.5"');
    expect(stored?.["hvacSystemEquipmentType"]).toBe("Boiler");
    expect(stored?.["hvacUpgradeAction"]).toBe("Keep an existing system as is");
  },
);

test.runIf(configured)("readExistingRecords parses the vendor's own rows", async () => {
  const records = await readExistingRecords(ctx(), "hvac", { fetchImpl: gatewayFetch });
  expect(records.some((record) => record.uuid === created[0])).toBe(true);
});

/**
 * The two vendor facts the whole write design rests on, re-checkable.
 *
 * Both were established by spike 0007 and are recorded in doc 15 §3.3 and ADR 0017 — but a
 * finding a vendor can silently change is exactly the kind that needs a gate rather than a
 * paragraph (ADR 0019). If Snugg Pro ever starts honouring `Idempotency-Key`, or switches a
 * write from merge to replace, these are what say so. The second one failing means we are
 * blanking fields on real audits.
 *
 * Deliberately raw `fetch` rather than the adapter: the claim is about the VENDOR, and routing
 * it through our own writer would let a bug in the writer mask a change in the vendor.
 */
test.runIf(configured)(
  "the vendor still ignores Idempotency-Key — replay creates a SECOND record",
  async () => {
    const key = `write-real-idem-${Date.now()}`;
    const body = {
      hvacSystemEquipmentType: "Boiler",
      hvacUpgradeAction: "Keep an existing system as is",
      hvacSystemName: `${PROBE_NAME} (idempotency)`,
    };
    const post = async (): Promise<string> => {
      const res = await gatewayFetch(`${BASE}/jobs/${JOB_ID ?? ""}/hvac`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { uuid: string };
      created.push(json.uuid);
      return json.uuid;
    };

    const first = await post();
    const replay = await post();

    // If this ever fails, the vendor has ADDED idempotency support — good news, and it means the
    // receipt machinery could be simplified. Read ADR 0017 before acting on it.
    expect(replay, "a replayed create with the same key returned the same record").not.toBe(first);
  },
);

test.runIf(configured)(
  "a singleton upsert still MERGES — the health matrix is not blanked",
  async () => {
    // The worst case for replace semantics: sixteen discrete safety tests behind one endpoint, so
    // an auditor mentioning one would blank the other fifteen. Snapshot, probe, restore.
    const read = async (): Promise<Record<string, unknown>> => {
      const res = await gatewayFetch(`${BASE}/jobs/${JOB_ID ?? ""}/health`);
      return (await res.json()) as Record<string, unknown>;
    };
    const write = async (patch: Record<string, unknown>): Promise<void> => {
      await gatewayFetch(`${BASE}/jobs/${JOB_ID ?? ""}/health`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
    };

    const before = await read();
    expect(before["healthRadon"], "probe assumes healthRadon starts unset").toBeNull();
    expect(before["healthAsbestos"], "probe assumes healthAsbestos starts unset").toBeNull();

    try {
      await write({ healthRadon: "Passed" });
      await write({ healthAsbestos: "Failed" });
      const after = await read();
      // The field the SECOND write never mentioned must still be there.
      expect(after["healthRadon"]).toBe("Passed");
      expect(after["healthAsbestos"]).toBe("Failed");
    } finally {
      await write({ healthRadon: null, healthAsbestos: null });
      const restored = await read();
      expect(restored["healthRadon"], "restored").toBeNull();
      expect(restored["healthAsbestos"], "restored").toBeNull();
    }
  },
);
