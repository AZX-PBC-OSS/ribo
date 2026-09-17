import { addRxPlugin, createRxDatabase } from "rxdb";
import type { RxCollection, RxDatabase, RxJsonSchema } from "rxdb";
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { afterEach, expect, test } from "vitest";

import { PLUGIN_STORAGE_COLLECTION_NAME } from "@azx/ribo-core";

import { removeOutboxDatabase } from "./database.js";
import { openRxdbBackend } from "./open.js";

/**
 * @file The v0 → v1 migration of the key-value collection, against real IndexedDB.
 *
 * This is the one place in the storage work where a mistake takes the capture
 * store down with it. All three collections are added in a single
 * `addCollections` call on one database, so a schema failure on this one rejects
 * the whole open: an auditor's recordings and their audio become unreachable on
 * the device, with clearing the origin's IndexedDB as the only way back.
 *
 * So the assertions here are about what is **on disk**, not about whether the
 * strategy looks right. A collection is genuinely created at version 0 with a
 * genuinely old-shaped row, through RxDB's own API, and then opened with current
 * code. Reasoning cannot substitute for that: the schema question ("does RxDB
 * accept this declaration against the one the collection was created with?") is
 * separate from the data question ("does the row transform correctly?"), and
 * "the collection holds nothing anyone depends on" answers only the second.
 */

const V0_PLUGIN_STORAGE_SCHEMA: RxJsonSchema<{
  id: string;
  captureId: string;
  pluginId: string;
  key: string;
  value: string;
}> = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 512 },
    captureId: { type: "string", maxLength: 64 },
    pluginId: { type: "string", maxLength: 128 },
    key: { type: "string", maxLength: 256 },
    value: { type: "string" },
  },
  required: ["id", "captureId", "pluginId", "key", "value"],
  indexes: ["captureId", ["captureId", "pluginId"]],
  attachments: {},
};

const names: string[] = [];

function uniqueName(): string {
  const name = `ribo-kv-migration-${crypto.randomUUID()}`;
  names.push(name);
  return name;
}

afterEach(async () => {
  for (const name of names.splice(0)) await removeOutboxDatabase(name);
});

/**
 * Create the collection at version 0 and write one old-shaped entry into it,
 * through RxDB rather than raw IndexedDB — which is what makes this a genuine
 * migration fixture rather than a hand-built approximation of one.
 */
async function seedVersionZeroEntry(name: string): Promise<void> {
  addRxPlugin(RxDBMigrationSchemaPlugin);
  const database: RxDatabase<{
    pluginStorage: RxCollection<{
      id: string;
      captureId: string;
      pluginId: string;
      key: string;
      value: string;
    }>;
  }> = await createRxDatabase({
    name,
    storage: getRxStorageDexie(),
    multiInstance: true,
    eventReduce: true,
    cleanupPolicy: {},
  });
  await database.addCollections({
    [PLUGIN_STORAGE_COLLECTION_NAME]: { schema: V0_PLUGIN_STORAGE_SCHEMA },
  });
  await database.collections.pluginStorage.insert({
    // The v0 key composition, which v1 deliberately does not change.
    id: "pdfjs\x00cap-1\x00pages",
    captureId: "cap-1",
    pluginId: "pdfjs",
    key: "pages",
    value: JSON.stringify([1, 2, 3]),
  });
  await database.close();
}

test("a v0 key-value entry survives the v1 bump and reads back under the new scope fields", async () => {
  const name = uniqueName();
  await seedVersionZeroEntry(name);

  // Opening with current code runs the migration as a side effect of
  // `addCollections`. If the declared schema were changed without a version
  // bump, this line would throw DB6 and take the capture store with it.
  const backend = await openRxdbBackend({ name });
  try {
    const entries = await backend.find("entries", { scopeKind: "capture", scopeId: "cap-1" });

    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.scopeKind).toBe("capture");
    expect(entry.scopeId).toBe("cap-1");
    expect(entry.owner).toBe("pdfjs");
    expect(entry.key).toBe("pages");
    expect(JSON.parse(entry.value as string)).toEqual([1, 2, 3]);

    // The key composition is unchanged, which is the whole reason this migration
    // is a field-only rewrite rather than a primary-key rewrite.
    expect(entry.id).toBe("pdfjs\x00cap-1\x00pages");
  } finally {
    await backend.close();
  }
});

test("a migrated entry is still reachable through the plugin's own handle", async () => {
  const name = uniqueName();
  await seedVersionZeroEntry(name);

  const backend = await openRxdbBackend({ name });
  try {
    // The path a plugin actually uses, rather than the raw finder above: the
    // migration is only real if the handle that wrote the entry can still read it.
    const { openStorage } = await import("@azx/ribo-core");
    const storage = await openStorage({ backend });
    expect(await storage.store("pdfjs").capture("cap-1").get("pages")).toEqual([1, 2, 3]);

    // `keys()` reads by scope and owner rather than by primary key, so it
    // exercises fields `get` never looks at. A strategy that dropped `key` would
    // still satisfy the read above — the row would be findable by its id and
    // missing from its own listing.
    expect(await storage.store("pdfjs").capture("cap-1").keys()).toEqual(["pages"]);
  } finally {
    await backend.close();
  }
});

test("a session-scoped entry coexists with a migrated capture entry unless owner, scope id and key all collide", async () => {
  const name = uniqueName();
  await seedVersionZeroEntry(name);

  const backend = await openRxdbBackend({ name });
  try {
    // The capability the version bump exists for: v1 has a column for the scope
    // kind, so an entry can belong to a session. No session accessor ships yet —
    // `SessionStore` has no removal path, so there is nowhere for a session
    // sweep to hook — so the row is written through the raw port, which the
    // v1 schema accepts.
    await backend.upsert("entries", {
      id: "pdfjs\x00cap-1\x00draft",
      scopeKind: "session",
      scopeId: "cap-1",
      owner: "pdfjs",
      key: "draft",
      value: JSON.stringify(["session"]),
    });

    // The kind filter is what keeps the two scopes apart, because the primary
    // key carries no kind.
    const captures = await backend.find("entries", { scopeKind: "capture", scopeId: "cap-1" });
    expect(captures.map((entry) => entry.key)).toEqual(["pages"]);
    const sessions = await backend.find("entries", { scopeKind: "session", scopeId: "cap-1" });
    expect(sessions.map((entry) => entry.key)).toEqual(["draft"]);

    // The deliberate trade, stated on disk: owner, scope id and key all equal
    // means ONE row regardless of kind. A session-scoped write over the migrated
    // entry's exact key replaces it rather than adding a second row — which is
    // why the design leans on capture and session ids being drawn from disjoint
    // spaces rather than encoding the kind into the key (a primary-key rewrite
    // fails by making rows unreachable, not by erroring).
    await backend.upsert("entries", {
      id: "pdfjs\x00cap-1\x00pages",
      scopeKind: "session",
      scopeId: "cap-1",
      owner: "pdfjs",
      key: "pages",
      value: JSON.stringify(["replaced"]),
    });
    expect(await backend.get("entries", "pdfjs\x00cap-1\x00pages")).toMatchObject({
      scopeKind: "session",
    });
    expect(await backend.find("entries", { scopeKind: "capture", scopeId: "cap-1" })).toEqual([]);
  } finally {
    await backend.close();
  }
});
