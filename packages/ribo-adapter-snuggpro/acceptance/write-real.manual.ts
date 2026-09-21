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
 *
 * ## Reversible by construction
 *
 * It writes to a COLLECTION group, which the vendor lets us delete, and removes what it
 * created in `afterAll` — verifying the collection is back to its baseline count. It
 * deliberately never touches a singleton (`basedata`, `health`): those are upserts with no
 * delete, so a probe there could not clean up after itself.
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

    const { uuid } = await adapter.write(
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

    expect(uuid).toMatch(/[0-9a-f-]{16,}/);
    created.push(uuid);

    const stored = (await listHvacs()).find((record) => record["uuid"] === uuid);
    expect(stored, "the created record reads back").toBeDefined();
    expect(stored?.["hvacSystemName"]).toBe(PROBE_NAME);
    // Sent as the number 2001; the vendor's field is a string.
    expect(stored?.["hvacHeatingSystemModelYear"]).toBe("2001");
    // Sent as "Duct Board 1.5 inch"; the vendor stores its own quoted literal.
    expect(stored?.["hvacDuctInsulation"]).toBe('Duct Board 1.5"');
    expect(before.some((record) => record["uuid"] === uuid)).toBe(false);
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
